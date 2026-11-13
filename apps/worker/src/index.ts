// src/index.ts — AFR.IM Worker API (Hono on Cloudflare Workers).
// Endpoints: public JSON API (sites / leaderboard / stats / categories / ads /
// submissions); the AFR method schema per spec §14-D; the SVG badge rendered
// inline. D1 is wrapped by src/db.ts so tests can inject a node:sqlite
// database through createApp({ db }).

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { Context } from 'hono';
import type { D1Database, ExecutionContext, KVNamespace, ScheduledController } from '@cloudflare/workers-types';
import { GRADE_THRESHOLDS, LAYER_MAX } from '../../../packages/shared/src/index.ts';
import { AFR_LAYERS, AFR_VERSION } from './method-checks.ts';
import { GRADE_COLORS } from './grade-colors.ts';
import { badgeSvg } from './badge.ts';
import { githubAuthedFetch, runDailySync } from './cron.ts';
import { createD1Db, type Db, type Row, type SqlParam } from './db.ts';
import { normalizeDomain } from './domain.ts';
import { handleMcpRequest, MCP_RATE_LIMIT, MCP_RATE_WINDOW_MS } from './mcp.ts';
import { DAY_MS, HOUR_MS, RateLimiter, kvStore, memoryStore } from './rate-limit.ts';
import {
  createVerifyToken,
  ownerVerifyMethod,
  probeAll,
  VERIFY_TOKEN_TTL_MS,
} from './verification.ts';

/** Cloudflare bindings (wrangler.toml) */
export interface WorkerEnv {
  DB: D1Database;
  /** Optional: when missing the rate limiter falls back to an in-memory counter */
  KV?: KVNamespace;
  /** Worker secret: token used to dispatch scan.yml (search-then-collect).
   * Missing → scan requests still queue; the dispatch is deferred to the
   * daily cron, which drains the queue's data side anyway. */
  GITHUB_DISPATCH_TOKEN?: string;
  /** Worker secret: shared token required by POST /api/v1/queue/:domain/done */
  QUEUE_TOKEN?: string;
}

type AppEnv = { Bindings: WorkerEnv };

export interface AppOverrides {
  /** Injected database (tests use node:sqlite; production uses c.env.DB) */
  db?: Db;
  /** Injected rate limiter (tests use an isolated in-memory store) */
  rateLimiter?: RateLimiter;
  /** Injected scan-rate limiters (tests use isolated in-memory stores) */
  scanLimits?: ScanRateLimits;
  /** Injected verification/claim rate limiters (tests use isolated in-memory stores) */
  verifyLimits?: VerifyRateLimits;
  claimLimits?: ClaimRateLimits;
  /** Injected MCP rate limiter (default: 60 requests/IP/minute) */
  mcpLimit?: RateLimiter;
  /** Injected fetch for the GitHub dispatch (tests pass a fake) */
  fetchImpl?: typeof fetch;
}

/** 5 submissions per IP per day */
export const SUBMISSION_LIMIT = 5;

// On-demand scan request limits (search-then-collect flow)
export const SCAN_IP_LIMIT = 10; // per IP per UTC day (search-triggered scans)
export const SCAN_DOMAIN_LIMIT = 1; // per domain per 30-minute window
/** Owner re-scan anti-abuse: one DEVICE may trigger one re-scan (any domain)
 * per 30-minute window — a per-domain-only rule would let a single device
 * hammer unlimited distinct sites. */
export const SCAN_GLOBAL_LIMIT = 50; // all callers per UTC day
/** Manual re-scan / search-triggered scan: one per domain per 30-minute window.
 * The daily cron keeps its own once-per-day cadence (spec politeness applies to
 * unattended crawling; an owner-triggered rescan of their own site is bounded
 * by this window plus the IP/day and global/day tiers above). */
export const SCAN_DOMAIN_WINDOW_MS = 30 * 60 * 1000;
export const SCAN_ETA_SECONDS = 180; // advertised queue time before the cron/CI picks it up
export const QUEUE_LIST_LIMIT = 50;

// Verification flow limits
export const VERIFY_START_DOMAIN_LIMIT = 3; // verify/start per domain per UTC day
export const VERIFY_IP_LIMIT = 10; // verify/start + verify/check per IP per hour (shared)
export const CLAIMS_DOMAIN_LIMIT = 5; // claims per domain per UTC day

// PV pixel: daily D1 write budget, enforced inside the count upsert
export const PV_DAILY_WRITE_CAP = 20_000; // leave headroom for scans + sync inside the 100k/day free tier

const SCAN_DISPATCH_URL =
  'https://api.github.com/repos/AFR-IM/AFR-web/actions/workflows/scan.yml/dispatches';

const PER_PAGE = 20;
const LEADERBOARD_SIZE = 10;

// Domain validation lives in src/domain.ts (shared with the MCP tools in
// src/mcp.ts) and is re-exported here so `import { normalizeDomain } from
// './index.ts'` keeps working.
export { normalizeDomain };

function clientIp(c: Context<AppEnv>): string {
  const forwarded = c.req.header('x-forwarded-for');
  if (forwarded) return forwarded.split(',')[0]?.trim() || 'unknown';
  return c.req.header('x-real-ip') ?? 'unknown';
}

// ---------------------------------------------------------------------------
// Row → JSON mapping (API is snake_case, mirroring the D1 columns)
// ---------------------------------------------------------------------------

interface SiteRow extends Row {
  domain: string;
  title: string | null;
  lang: string | null;
  strategy_tag: string | null;
  grade: string | null;
  score_total: number | null;
  score_l1: number | null;
  score_l2: number | null;
  score_l3: number | null;
  rank_source: string | null;
  rank: number | null;
  status: string | null;
  verified: number | null;
  created_at: string | null;
  updated_at: string | null;
  scanned_at: string | null;
  category_slug?: string | null;
}

interface ScanRow extends Row {
  id: number;
  domain: string;
  engine_version: string | null;
  score_total: number | null;
  score_l1: number | null;
  score_l2: number | null;
  score_l3: number | null;
  grade: string | null;
  snapshot_path: string | null;
  started_at: string | null;
  finished_at: string | null;
}

interface EvidenceRow extends Row {
  check_id: string | null;
  status: string | null;
  points: number | null;
  max_points: number | null;
  evidence_type: string | null;
  evidence_ref: string | null;
}

interface AdRow extends Row {
  id: number;
  domain: string | null;
  slot: string | null;
  slot_key: string | null;
  headline: string | null;
  body: string | null;
  starts_at: string | null;
  ends_at: string | null;
  status: string | null;
  impressions: number | null;
  clicks: number | null;
}

interface CategoryRow extends Row {
  id: number;
  slug: string | null;
  name_en: string | null;
  name_zh: string | null;
  parent: number | null;
  count: number;
}

interface SubmissionRow extends Row {
  domain: string;
  submitter_note: string | null;
  source: string | null;
  status: string | null;
  created_at: string | null;
}

function mapSite(row: SiteRow) {
  return {
    domain: row.domain,
    title: row.title ?? null,
    lang: row.lang ?? null,
    category: row.category_slug ?? null,
    strategy_tag: row.strategy_tag ?? null,
    grade: row.grade ?? null,
    score_total: row.score_total ?? null,
    score_l1: row.score_l1 ?? null,
    score_l2: row.score_l2 ?? null,
    score_l3: row.score_l3 ?? null,
    rank_source: row.rank_source ?? null,
    rank: row.rank ?? null,
    status: row.status ?? null,
    verified: row.verified === 1,
    created_at: row.created_at ?? null,
    updated_at: row.updated_at ?? null,
    scanned_at: row.scanned_at ?? null,
  };
}

function mapScan(row: ScanRow) {
  return {
    id: row.id,
    domain: row.domain,
    engine_version: row.engine_version ?? null,
    score_total: row.score_total ?? null,
    score_l1: row.score_l1 ?? null,
    score_l2: row.score_l2 ?? null,
    score_l3: row.score_l3 ?? null,
    grade: row.grade ?? null,
    snapshot_path: row.snapshot_path ?? null,
    started_at: row.started_at ?? null,
    finished_at: row.finished_at ?? null,
  };
}

function mapEvidence(row: EvidenceRow) {
  return {
    check_id: row.check_id ?? null,
    status: row.status ?? null,
    points: row.points ?? null,
    max_points: row.max_points ?? null,
    evidence_type: row.evidence_type ?? null,
    evidence_ref: row.evidence_ref ?? null,
  };
}

function mapAd(row: AdRow) {
  return {
    id: row.id,
    domain: row.domain ?? null,
    slot: row.slot ?? null,
    slot_key: row.slot_key ?? null,
    headline: row.headline ?? null,
    body: row.body ?? null,
    starts_at: row.starts_at ?? null,
    ends_at: row.ends_at ?? null,
    status: row.status ?? null,
    impressions: row.impressions ?? 0,
    clicks: row.clicks ?? 0,
  };
}

// ---------------------------------------------------------------------------
// App factory
// ---------------------------------------------------------------------------

/** Shared fallback limiter (used only when neither an override nor KV is present) */
const fallbackLimiter = new RateLimiter(memoryStore(), SUBMISSION_LIMIT, DAY_MS, 'subs');

/** The three on-demand scan request tiers */
export interface ScanRateLimits {
  ip: RateLimiter;
  domain: RateLimiter;
  global: RateLimiter;
  /** device-level gate for POST /rescan: 1 per 30 minutes */
  rescanIp: RateLimiter;
}

/** Verification tiers: starts per domain per day + probes per IP per hour */
export interface VerifyRateLimits {
  dailyDomain: RateLimiter;
  hourlyIp: RateLimiter;
}

/** Claim submission tier: per domain per day */
export interface ClaimRateLimits {
  domain: RateLimiter;
}

/** Fallback scan limiters (per-isolate memory — degraded but serviceable) */
const fallbackScanLimits: ScanRateLimits = {
  ip: new RateLimiter(memoryStore(), SCAN_IP_LIMIT, DAY_MS, 'scan-ip'),
      rescanIp: new RateLimiter(memoryStore(), 1, SCAN_DOMAIN_WINDOW_MS, 'rescan-ip'),
  domain: new RateLimiter(memoryStore(), SCAN_DOMAIN_LIMIT, SCAN_DOMAIN_WINDOW_MS, 'scan-domain'),
  global: new RateLimiter(memoryStore(), SCAN_GLOBAL_LIMIT, DAY_MS, 'scan-global'),
};

function dbOf(c: Context<AppEnv>, overrides: AppOverrides): Db {
  return overrides.db ?? createD1Db(c.env.DB);
}

function limiterOf(c: Context<AppEnv>, overrides: AppOverrides): RateLimiter {
  if (overrides.rateLimiter) return overrides.rateLimiter;
  if (c.env?.KV) return new RateLimiter(kvStore(c.env.KV), SUBMISSION_LIMIT, DAY_MS, 'subs');
  return fallbackLimiter;
}

function scanLimitsOf(c: Context<AppEnv>, overrides: AppOverrides): ScanRateLimits {
  if (overrides.scanLimits) return overrides.scanLimits;
  if (c.env?.KV) {
    const store = kvStore(c.env.KV);
    return {
      ip: new RateLimiter(store, SCAN_IP_LIMIT, DAY_MS, 'scan-ip'),
      rescanIp: new RateLimiter(store, 1, SCAN_DOMAIN_WINDOW_MS, 'rescan-ip'),
      domain: new RateLimiter(store, SCAN_DOMAIN_LIMIT, SCAN_DOMAIN_WINDOW_MS, 'scan-domain'),
      global: new RateLimiter(store, SCAN_GLOBAL_LIMIT, DAY_MS, 'scan-global'),
    };
  }
  return fallbackScanLimits;
}

/** Fallback verification/claim limiters (per-isolate memory — degraded but serviceable) */
const fallbackVerifyLimits: VerifyRateLimits = {
  dailyDomain: new RateLimiter(memoryStore(), VERIFY_START_DOMAIN_LIMIT, DAY_MS, 'verify-domain'),
  hourlyIp: new RateLimiter(memoryStore(), VERIFY_IP_LIMIT, HOUR_MS, 'verify-ip'),
};

const fallbackClaimLimits: ClaimRateLimits = {
  domain: new RateLimiter(memoryStore(), CLAIMS_DOMAIN_LIMIT, DAY_MS, 'claim-domain'),
};

function verifyLimitsOf(c: Context<AppEnv>, overrides: AppOverrides): VerifyRateLimits {
  if (overrides.verifyLimits) return overrides.verifyLimits;
  if (c.env?.KV) {
    const store = kvStore(c.env.KV);
    return {
      dailyDomain: new RateLimiter(store, VERIFY_START_DOMAIN_LIMIT, DAY_MS, 'verify-domain'),
      hourlyIp: new RateLimiter(store, VERIFY_IP_LIMIT, HOUR_MS, 'verify-ip'),
    };
  }
  return fallbackVerifyLimits;
}

function claimLimitsOf(c: Context<AppEnv>, overrides: AppOverrides): ClaimRateLimits {
  if (overrides.claimLimits) return overrides.claimLimits;
  if (c.env?.KV) {
    return { domain: new RateLimiter(kvStore(c.env.KV), CLAIMS_DOMAIN_LIMIT, DAY_MS, 'claim-domain') };
  }
  return fallbackClaimLimits;
}

/** Fallback MCP limiter (per-isolate memory — degraded but serviceable) */
const fallbackMcpLimiter = new RateLimiter(memoryStore(), MCP_RATE_LIMIT, MCP_RATE_WINDOW_MS, 'mcp');

function mcpLimiterOf(c: Context<AppEnv>, overrides: AppOverrides): RateLimiter {
  if (overrides.mcpLimit) return overrides.mcpLimit;
  if (c.env?.KV) {
    return new RateLimiter(kvStore(c.env.KV), MCP_RATE_LIMIT, MCP_RATE_WINDOW_MS, 'mcp');
  }
  return fallbackMcpLimiter;
}

/** Shared 429 payload: seconds until the window resets + the absolute time */
function retryPayload(limiter: RateLimiter): { retryAfter: number; nextAllowedAt: string } {
  const retryAfter = limiter.retryAfter();
  return { retryAfter, nextAllowedAt: new Date(Date.now() + retryAfter * 1000).toISOString() };
}

/** Single-statement PV counter with an in-place daily write cap.
 * The guard `counted_on <> excluded.counted_on OR today_views < cap` lets a new
 * UTC day always reset the daily counter (a yesterday-at-cap row must not
 * freeze the counter forever); within the same day the cap refuses the upsert.
 * A refused upsert changes no rows — D1 bills rows actually written, so a
 * capped view is assumed to cost zero writes (0-row statements are not billed
 * as changed rows). */
const PV_COUNT_SQL = `
  INSERT INTO page_views (domain, views, today_views, counted_on)
  VALUES (?, 1, 1, ?)
  ON CONFLICT(domain) DO UPDATE SET
    views = views + 1,
    today_views = CASE WHEN counted_on <> excluded.counted_on THEN 1 ELSE today_views + 1 END,
    counted_on = CASE WHEN counted_on <> excluded.counted_on THEN excluded.counted_on ELSE counted_on END
  WHERE counted_on <> excluded.counted_on OR today_views < ?
`;

/** Ask GitHub Actions (scan.yml, inputs {mode:'queue'}) to drain the scan
 * queue. Soft-fail contract: a missing token or a failed call never fails
 * the request — the daily cron picks the queue up anyway — so we log a
 * warning and report `deferred`. */
async function dispatchScanQueue(
  token: string | undefined,
  fetchImpl: typeof fetch,
): Promise<'ok' | 'deferred'> {
  if (!token) {
    console.warn('search-scan: GITHUB_DISPATCH_TOKEN not set, dispatch deferred');
    return 'deferred';
  }
  try {
    const res = await fetchImpl(SCAN_DISPATCH_URL, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/vnd.github+json',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ ref: 'main', inputs: { mode: 'queue' } }),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) {
      console.warn(`search-scan: dispatch failed (HTTP ${res.status}), deferred`);
      return 'deferred';
    }
    return 'ok';
  } catch (err) {
    console.warn(
      `search-scan: dispatch error (${err instanceof Error ? err.message : String(err)}), deferred`,
    );
    return 'deferred';
  }
}

export function createApp(overrides: AppOverrides = {}): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  // CORS open for the whole API surface (all JSON endpoints, open CORS).
  // The /badge/* route is an <img> asset and does not need CORS.
  app.use('/api/v1/*', cors({ origin: '*' }));

  // -------------------------------------------------------------------------
  // Directory
  // -------------------------------------------------------------------------

  // GET /api/v1/sites?category=&grade=&q=&sort=&page=&per_page=
  // sort: score (default, AFR score DESC — product invariant) | rank | new
  // per_page: optional page size for incremental list loads, clamped 1..100
  // (invalid or absent → the default, 20); echoed back in the response.
  app.get('/api/v1/sites', async (c) => {
    const db = dbOf(c, overrides);
    const category = c.req.query('category') ?? '';
    const grade = c.req.query('grade') ?? '';
    const q = (c.req.query('q') ?? '').trim();
    const sortRaw = c.req.query('sort');
    const sort = (sortRaw && sortRaw.toLowerCase()) || 'score';
    const page = Math.max(1, Number.parseInt(c.req.query('page') ?? '1', 10) || 1);
    const perPageRaw = Number.parseInt(c.req.query('per_page') ?? '', 10);
    const perPage = Number.isFinite(perPageRaw) ? Math.min(100, Math.max(1, perPageRaw)) : PER_PAGE;

    if (!['score', 'rank', 'new'].includes(sort)) {
      return c.json({ error: 'invalid_sort', allowed: ['score', 'rank', 'new'] }, 400);
    }

    // Pending = unratable (neither homepage nor robots readable, calibration 2026-11-10):
    // listed nowhere in natural results; still reachable via GET /sites/:domain.
    const where: string[] = ["s.status = 'active'", "s.grade != 'Pending'"];
    const params: SqlParam[] = [];
    if (category) {
      where.push('c.slug = ?');
      params.push(category);
    }
    if (grade) {
      where.push('s.grade = ?');
      params.push(grade);
    }
    if (q) {
      const like = `%${q.replace(/[\\%_]/g, '\\$&')}%`;
      where.push("(s.domain LIKE ? ESCAPE '\\' OR s.title LIKE ? ESCAPE '\\')");
      params.push(like, like);
    }
    const joinSql = 'LEFT JOIN categories c ON c.id = s.category_id';
    const whereSql = `WHERE ${where.join(' AND ')}`;
    const orderSql =
      sort === 'rank'
        ? 'ORDER BY (s.rank IS NULL), s.rank ASC, (s.score_total IS NULL), s.score_total DESC, s.domain ASC'
        : sort === 'new'
          ? 'ORDER BY (s.created_at IS NULL), s.created_at DESC, s.domain ASC'
          : 'ORDER BY (s.score_total IS NULL), s.score_total DESC, s.domain ASC';

    const totalRow = await db
      .prepare(`SELECT COUNT(*) AS n FROM sites s ${joinSql} ${whereSql}`)
      .get<{ n: number }>(...params);
    const rows = await db
      .prepare(
        `SELECT s.*, c.slug AS category_slug FROM sites s ${joinSql} ${whereSql} ${orderSql} LIMIT ? OFFSET ?`,
      )
      .all<SiteRow>(...params, perPage, (page - 1) * perPage);

    return c.json({
      items: rows.map(mapSite),
      page,
      per_page: perPage,
      total: totalRow?.n ?? 0,
      sort,
    });
  });

  // GET /api/v1/sites/:domain — detail incl. latest scan + its evidence rows
  app.get('/api/v1/sites/:domain', async (c) => {
    const domain = normalizeDomain(c.req.param('domain'));
    if (!domain) return c.json({ error: 'invalid_domain' }, 400);
    const db = dbOf(c, overrides);

    const site = await db
      .prepare(
        `SELECT s.*, c.slug AS category_slug FROM sites s
         LEFT JOIN categories c ON c.id = s.category_id WHERE s.domain = ?`,
      )
      .get<SiteRow>(domain);
    if (!site) return c.json({ error: 'not_found', domain }, 404);

    const scan = await db
      .prepare('SELECT * FROM scans WHERE domain = ? ORDER BY started_at DESC, id DESC LIMIT 1')
      .get<ScanRow>(domain);
    const evidence = scan
      ? await db.prepare('SELECT * FROM evidence WHERE scan_id = ? ORDER BY rowid').all<EvidenceRow>(scan.id)
      : [];

    // Runtime view counter (best-effort: a database without the counter table
    // still serves the detail page, with views reported as 0)
    let views = 0;
    try {
      const pv = await db
        .prepare('SELECT views FROM page_views WHERE domain = ?')
        .get<{ views: number }>(domain);
      views = pv?.views ?? 0;
    } catch {
      views = 0;
    }

    return c.json({
      site: mapSite(site),
      scan: scan ? mapScan(scan) : null,
      evidence: evidence.map(mapEvidence),
      views,
    });
  });

  // GET /api/v1/sites/:domain/history — scan rows, newest first
  app.get('/api/v1/sites/:domain/history', async (c) => {
    const domain = normalizeDomain(c.req.param('domain'));
    if (!domain) return c.json({ error: 'invalid_domain' }, 400);
    const db = dbOf(c, overrides);
    const site = await db.prepare('SELECT domain FROM sites WHERE domain = ?').get<{ domain: string }>(domain);
    if (!site) return c.json({ error: 'not_found', domain }, 404);
    const scans = await db
      .prepare('SELECT * FROM scans WHERE domain = ? ORDER BY started_at DESC, id DESC')
      .all<ScanRow>(domain);
    return c.json({ domain, scans: scans.map(mapScan) });
  });

  // GET /api/v1/stats — totals + grade distribution + avg score
  app.get('/api/v1/stats', async (c) => {
    const db = dbOf(c, overrides);
    const totals = await db
      .prepare(
        `SELECT COUNT(*) AS total,
                SUM(CASE WHEN verified = 1 THEN 1 ELSE 0 END) AS verified,
                SUM(CASE WHEN grade = 'Pending' THEN 1 ELSE 0 END) AS pending,
                AVG(CASE WHEN grade != 'Pending' THEN score_total END) AS avg_score
         FROM sites WHERE status = 'active'`,
      )
      .get<{ total: number; verified: number | null; pending: number | null; avg_score: number | null }>();
    const gradeRows = await db
      .prepare(
        `SELECT grade, COUNT(*) AS n FROM sites
         WHERE status = 'active' AND grade IS NOT NULL GROUP BY grade`,
      )
      .all<{ grade: string; n: number }>();

    // Grade distribution covers the five real grades only; Pending is reported
    // as its own counter (it is a scan state, not a grade — spec §3.5).
    const grades: Record<string, number> = { A: 0, B: 0, C: 0, D: 0, F: 0 };
    for (const row of gradeRows) if (row.grade in grades) grades[row.grade] = row.n;

    const avg = totals?.avg_score;
    return c.json({
      total: totals?.total ?? 0,
      verified: totals?.verified ?? 0,
      pending: totals?.pending ?? 0,
      avg_score: avg === null || avg === undefined ? null : Math.round(avg * 10) / 10,
      grades,
    });
  });

  // GET /api/v1/categories — category tree with per-category site counts
  app.get('/api/v1/categories', async (c) => {
    const db = dbOf(c, overrides);
    const rows = await db
      .prepare(
        `SELECT c.id, c.slug, c.name_en, c.name_zh, c.parent,
                (SELECT COUNT(*) FROM sites s
                  WHERE s.category_id = c.id AND s.status = 'active'
                    AND s.grade != 'Pending') AS count
         FROM categories c ORDER BY c.id`,
      )
      .all<CategoryRow>();

    interface CategoryNode {
      slug: string | null;
      name_en: string | null;
      name_zh: string | null;
      count: number;
      children: CategoryNode[];
    }
    const byId = new Map<number, CategoryNode>();
    const roots: CategoryNode[] = [];
    for (const row of rows) {
      byId.set(row.id, {
        slug: row.slug,
        name_en: row.name_en,
        name_zh: row.name_zh,
        count: row.count,
        children: [],
      });
    }
    for (const row of rows) {
      const node = byId.get(row.id);
      if (!node) continue;
      const parent = row.parent !== null ? byId.get(row.parent) : undefined;
      (parent ?? { children: roots }).children.push(node);
    }
    return c.json({ categories: roots });
  });

  // GET /api/v1/leaderboard?category= — top N by pure AFR score DESC.
  // Natural ranking must never mix in ads (any commercial factor may
  // not change the ordering); paid placements live only in /api/v1/ads.
  app.get('/api/v1/leaderboard', async (c) => {
    const db = dbOf(c, overrides);
    const category = c.req.query('category') ?? '';
    const requested = Number.parseInt(c.req.query('limit') ?? '', 10);
    const limit = Number.isFinite(requested) && requested > 0 ? Math.min(requested, 50) : LEADERBOARD_SIZE;

    // Natural ranking: pure AFR score DESC over RATABLE sites only (Pending
    // carries no comparable score) — ads never mix in.
    const where: string[] = ["s.status = 'active'", "s.grade != 'Pending'", 's.score_total IS NOT NULL'];
    const params: SqlParam[] = [];
    if (category) {
      where.push('c.slug = ?');
      params.push(category);
    }
    const rows = await db
      .prepare(
        `SELECT s.*, c.slug AS category_slug FROM sites s
         LEFT JOIN categories c ON c.id = s.category_id
         WHERE ${where.join(' AND ')}
         ORDER BY s.score_total DESC, s.domain ASC LIMIT ?`,
      )
      .all<SiteRow>(...params, limit);

    return c.json({
      category: category || null,
      items: rows.map((row, index) => ({
        rank: index + 1,
        domain: row.domain,
        title: row.title ?? null,
        grade: row.grade ?? null,
        score: row.score_total ?? null,
        category: row.category_slug ?? null,
        strategy_tag: row.strategy_tag ?? null,
      })),
    });
  });

  // GET /api/v1/method — machine-readable AFR schema (spec §14-D shape).
  // Weights come from LAYER_MAX and thresholds from GRADE_THRESHOLDS
  // (packages/shared) so the API can never drift from the scoring engine.
  app.get('/api/v1/method', (c) => {
    const layers = AFR_LAYERS.map((layer) => ({
      id: layer.id,
      name: layer.name,
      weight: LAYER_MAX[layer.id],
      checks: layer.checks,
    }));
    const grades = GRADE_THRESHOLDS.map((t) => ({
      min: t.min,
      grade: t.grade,
      color: GRADE_COLORS[t.grade],
    }));
    return c.json({ standard: 'AFR', version: AFR_VERSION, layers, grades });
  });

  // -------------------------------------------------------------------------
  // MCP — Model Context Protocol endpoint (stateless JSON-RPC 2.0 over HTTP)
  // -------------------------------------------------------------------------

  // Open CORS for the MCP endpoint too (browser-based assistants and MCP
  // playgrounds preflight POST /mcp), same policy as /api/v1/*.
  app.use('/mcp', cors({ origin: '*' }));

  // POST /mcp — one JSON-RPC 2.0 message per request. No SSE streams and no
  // session state; the transport is documented in the initialize instructions.
  app.post('/mcp', async (c) => {
    // 60 requests per IP per minute (KV-backed when bound, in-memory otherwise)
    const limiter = mcpLimiterOf(c, overrides);
    const decision = await limiter.consume(clientIp(c));
    if (!decision.allowed) {
      const retryAfter = limiter.retryAfter();
      return c.json(
        { error: 'rate_limited', retryAfter },
        429,
        { 'Retry-After': String(retryAfter), 'Cache-Control': 'no-store' },
      );
    }
    const outcome = await handleMcpRequest({
      db: dbOf(c, overrides),
      rawBody: await c.req.text(),
    });
    if (outcome.status === 202) {
      return new Response(null, { status: 202, headers: { 'cache-control': 'no-store' } });
    }
    return c.json(outcome.body, outcome.status, { 'cache-control': 'no-store' });
  });

  // Every other method on /mcp → 405. MCP clients probe GET /mcp; this server
  // offers no SSE stream, so GET cannot carry a session either.
  app.on(['GET', 'HEAD', 'PUT', 'DELETE', 'PATCH'], '/mcp', (c) =>
    c.json(
      {
        error: 'method_not_allowed',
        allow: 'POST',
        message: 'MCP transport is stateless JSON-RPC 2.0 over HTTP: POST a JSON-RPC message to /mcp.',
      },
      405,
      { Allow: 'POST', 'Cache-Control': 'no-store' },
    ),
  );

  // -------------------------------------------------------------------------
  // Badge
  // -------------------------------------------------------------------------

  // Legacy landing paths: the static badge guide now lives at /badges/ (the
  // badge/* route pattern only allows wildcards at the path end, so /badge/
  // cannot be routed to the site worker). Forward permanently (308) instead
  // of the previous 404.
  app.get('/badge', (c) => c.redirect('/badges/', 308));
  app.get('/badge/', (c) => c.redirect('/badges/', 308));

  // GET /badge/:domain.svg — ring + grade letter + score + label; 1h HTTP cache.
  // Unknown domains get a neutral gray "—" badge (not a 404): the badge itself
  // is the anti-forgery surface, click-through to the detail page verifies it.
  app.get('/badge/:domain', async (c) => {
    let param = c.req.param('domain');
    try {
      param = decodeURIComponent(param);
    } catch {
      // keep raw param when it is not valid percent-encoding
    }
    if (!param.toLowerCase().endsWith('.svg')) return c.notFound();
    const bare = param.slice(0, -4);
    const domain = normalizeDomain(bare);

    let svg: string;
    if (!domain) {
      svg = badgeSvg({ domain: bare, grade: null, score: null });
    } else {
      const db = dbOf(c, overrides);
      const site = await db
        .prepare('SELECT grade, score_total FROM sites WHERE domain = ?')
        .get<{ grade: string | null; score_total: number | null }>(domain);
      svg = badgeSvg({ domain, grade: site?.grade ?? null, score: site?.score_total ?? null });
    }
    return new Response(svg, {
      headers: {
        'content-type': 'image/svg+xml; charset=utf-8',
        'cache-control': 'public, max-age=3600',
      },
    });
  });

  // -------------------------------------------------------------------------
  // Submissions (POST /api/v1/submissions {domain, note?}, 5/IP/day)
  // -------------------------------------------------------------------------

  app.post('/api/v1/submissions', async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'invalid_json' }, 400);
    }
    const payload = (body ?? {}) as { domain?: unknown; note?: unknown };
    if (typeof payload.domain !== 'string') {
      return c.json({ error: 'invalid_domain', message: 'domain must be a string' }, 400);
    }
    const domain = normalizeDomain(payload.domain);
    if (!domain) {
      return c.json({ error: 'invalid_domain', message: 'expected a bare domain like example.com' }, 400);
    }
    if (payload.note !== undefined && payload.note !== null && typeof payload.note !== 'string') {
      return c.json({ error: 'invalid_note', message: 'note must be a string' }, 400);
    }

    // Rate limit: 5/IP/day via KV counter (in-memory fallback when KV is absent)
    const limiter = limiterOf(c, overrides);
    const decision = await limiter.consume(clientIp(c));
    if (!decision.allowed) {
      return c.json({ error: 'rate_limited', limit: SUBMISSION_LIMIT, remaining: 0 }, 429);
    }

    const db = dbOf(c, overrides);
    const note = typeof payload.note === 'string' ? payload.note.slice(0, 500) : null;
    const inserted = await db
      .prepare(
        `INSERT INTO submissions (domain, submitter_note, source, status, created_at)
         VALUES (?, ?, 'public', 'queued', ?)`,
      )
      .run(domain, note, new Date().toISOString());

    return c.json({ ok: true, id: inserted.lastInsertRowid, domain, status: 'queued' }, 201);
  });

  // -------------------------------------------------------------------------
  // On-demand scan requests — search-then-collect flow
  // -------------------------------------------------------------------------

  // POST /api/v1/search-scan {domain} — request an on-demand scan.
  // Order: already-listed → already-queued → rate limits → insert → dispatch.
  app.post('/api/v1/search-scan', async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'invalid_json' }, 400);
    }
    const payload = (body ?? {}) as { domain?: unknown };
    if (typeof payload.domain !== 'string') {
      return c.json({ error: 'invalid_domain', message: 'domain must be a string' }, 400);
    }
    const domain = normalizeDomain(payload.domain);
    if (!domain) {
      return c.json({ error: 'invalid_domain', message: 'expected a bare domain like example.com' }, 400);
    }

    const db = dbOf(c, overrides);

    // Already listed → nothing to scan (and no quota burned).
    const site = await db.prepare('SELECT domain FROM sites WHERE domain = ?').get<{ domain: string }>(domain);
    if (site) return c.json({ status: 'exists', domain });

    // Already waiting in the queue from any source → idempotent no-op.
    const queued = await db
      .prepare(
        `SELECT status FROM submissions WHERE domain = ? AND status IN ('queued', 'pending', 'scanning')
         ORDER BY id DESC LIMIT 1`,
      )
      .get<{ status: string }>(domain);
    if (queued) return c.json({ status: 'queued', domain, etaSeconds: SCAN_ETA_SECONDS });

    // Rate limits: per-IP 10/day, per-domain 1/day, global 50/day. All three
    // tiers are pre-checked before any is consumed, so a rejected request
    // never burns quota on another tier.
    const limits = scanLimitsOf(c, overrides);
    const tiers: [string, RateLimiter][] = [
      [clientIp(c), limits.ip],
      [domain, limits.domain],
      ['global', limits.global],
    ];
    for (const [key, limiter] of tiers) {
      const decision = await limiter.check(key);
      if (!decision.allowed) {
        const retryAfter = limiter.retryAfter();
        return c.json(
          { error: 'rate_limited', retryAfter },
          429,
          { 'Retry-After': String(retryAfter) },
        );
      }
    }
    for (const [key, limiter] of tiers) await limiter.consume(key);

    await db
      .prepare(
        `INSERT INTO submissions (domain, submitter_note, source, status, created_at)
         VALUES (?, NULL, 'on_demand', 'queued', ?)`,
      )
      .run(domain, new Date().toISOString());

    // Soft dispatch: missing/failed token → 200 with dispatch:'deferred'.
    const dispatch = await dispatchScanQueue(
      c.env?.GITHUB_DISPATCH_TOKEN,
      overrides.fetchImpl ?? fetch,
    );
    return c.json({ status: 'queued', domain, etaSeconds: SCAN_ETA_SECONDS, dispatch });
  });

  // GET /api/v1/queue — oldest queued submissions first (up to 50), public read.
  app.get('/api/v1/queue', async (c) => {
    const db = dbOf(c, overrides);
    const rows = await db
      .prepare(
        `SELECT domain, submitter_note, source, created_at FROM submissions
         WHERE status IN ('queued', 'pending', 'scanning')
         ORDER BY created_at ASC, id ASC LIMIT ?`,
      )
      .all<SubmissionRow>(QUEUE_LIST_LIMIT);
    return c.json({
      items: rows.map((row) => ({
        domain: row.domain,
        source: row.source,
        note: row.submitter_note ?? null,
        createdAt: row.created_at,
      })),
    });
  });

  // POST /api/v1/queue/:domain/done — GitHub Actions reports a finished scan.
  // Auth: X-Queue-Token must equal the QUEUE_TOKEN secret (501 when unset).
  app.post('/api/v1/queue/:domain/done', async (c) => {
    const queueToken = c.env?.QUEUE_TOKEN;
    if (!queueToken) {
      return c.json({ error: 'not_configured', message: 'QUEUE_TOKEN secret is not set' }, 501);
    }
    if (c.req.header('x-queue-token') !== queueToken) {
      return c.json({ error: 'unauthorized' }, 401);
    }
    const domain = normalizeDomain(c.req.param('domain'));
    if (!domain) return c.json({ error: 'invalid_domain' }, 400);

    const db = dbOf(c, overrides);
    const now = new Date().toISOString();
    let changes = 0;
    try {
      ({ changes } = await db
        .prepare(
          `UPDATE submissions SET status = 'scanned', done_at = ?
           WHERE domain = ? AND status IN ('queued', 'pending', 'scanning')`,
        )
        .run(now, domain));
    } catch {
      // Deployed D1 may predate the done_at column (schema.sql only creates
      // missing tables) — fall back to marking the status alone.
      ({ changes } = await db
        .prepare(
          `UPDATE submissions SET status = 'scanned'
           WHERE domain = ? AND status IN ('queued', 'pending', 'scanning')`,
        )
        .run(domain));
    }
    if (changes === 0) {
      // Double-check by read-back: the update may have applied even when the
      // driver reports 0 changes (D1 meta shape differences).
      const row = await db
        .prepare('SELECT status FROM submissions WHERE domain = ?')
        .get<{ status: string }>(domain);
      if (!row || row.status !== 'scanned') {
        return c.json({ error: 'not_queued', domain }, 404);
      }
    }
    return c.json({ ok: true, domain, status: 'scanned' });
  });

  // -------------------------------------------------------------------------
  // Ads
  // -------------------------------------------------------------------------

  // POST /api/v1/_internal/sync — run the daily D1 sync immediately.
  // Called by the site-rebuild workflow right after it publishes new static
  // data, so the static build and D1 always carry the same snapshot set
  // (the 04:30 UTC cron remains as a fallback).
  app.post('/api/v1/_internal/sync', async (c) => {
    const token = c.env?.QUEUE_TOKEN;
    if (!token || c.req.header('x-queue-token') !== token) {
      return c.json({ error: 'unauthorized' }, 401);
    }
    try {
      const result = await runDailySync({
        db: createD1Db(c.env.DB),
        fetchImpl: githubAuthedFetch(c.env.GITHUB_DISPATCH_TOKEN, fetch),
      });
      return c.json({
        ok: true,
        date: result.date,
        listed: result.listed,
        sites: result.sitesUpserted,
        scans: result.scansUpserted,
        evidenceWrites: result.evidenceRows,
        errors: result.errors.length,
        firstError: result.errors[0] ?? null,
      });
    } catch (err) {
      console.error('internal sync failed:', err);
      return c.json(
        { error: 'sync_failed', message: err instanceof Error ? err.message : String(err) },
        500,
      );
    }
  });

  // GET /api/v1/ads?slot=&key= — currently active ads for a slot.
  // SSOT note: ad delivery SSOT is the data repo /ads/active.json, pulled into
  // D1 by the d1-sync pipeline; this endpoint serves the synced D1 copy (the
  // Worker may also read a KV cache of the same file at higher traffic).
  app.get('/api/v1/ads', async (c) => {
    const db = dbOf(c, overrides);
    const slot = c.req.query('slot') ?? '';
    const key = c.req.query('key') ?? '';
    const now = new Date().toISOString();

    const where: string[] = ['status = ?', '(starts_at IS NULL OR starts_at <= ?)', '(ends_at IS NULL OR ends_at >= ?)'];
    const params: SqlParam[] = ['active', now, now];
    if (slot) {
      where.push('slot = ?');
      params.push(slot);
    }
    if (key) {
      where.push('(slot_key IS NULL OR slot_key = ?)');
      params.push(key);
    }
    const rows = await db
      .prepare(`SELECT * FROM ads WHERE ${where.join(' AND ')} ORDER BY id LIMIT 20`)
      .all<AdRow>(...params);
    return c.json({ items: rows.map(mapAd) });
  });

  // -------------------------------------------------------------------------
  // Rescan requests, domain verification, owner claims, view counter
  // -------------------------------------------------------------------------

  // POST /api/v1/rescan {domain} — ask for a fresh scan of a listed site.
  // The per-domain tier is the same limiter search-scan consumes, so a search
  // trigger and a rescan together can never exceed one request per domain per
  // UTC day. Order: validate → known site → rate limit → queue → dispatch.
  app.post('/api/v1/rescan', async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'invalid_json' }, 400);
    }
    const payload = (body ?? {}) as { domain?: unknown };
    if (typeof payload.domain !== 'string') {
      return c.json({ error: 'invalid_domain', message: 'domain must be a string' }, 400);
    }
    const domain = normalizeDomain(payload.domain);
    if (!domain) {
      return c.json({ error: 'invalid_domain', message: 'expected a bare domain like example.com' }, 400);
    }

    const db = dbOf(c, overrides);
    const site = await db
      .prepare('SELECT domain FROM sites WHERE domain = ?')
      .get<{ domain: string }>(domain);
    if (!site) return c.json({ error: 'unknown_domain' }, 404);

    const limits = scanLimitsOf(c, overrides);
    // Device gate first: one re-scan per device per 30 minutes (anti-abuse —
    // a per-domain rule alone would allow hammering unlimited distinct sites).
    const ipDecision = await limits.rescanIp.check('global');
    if (!ipDecision.allowed) {
      const { retryAfter, nextAllowedAt } = retryPayload(limits.rescanIp);
      return c.json(
        { error: 'rate_limited', scope: 'device', retryAfter, nextAllowedAt },
        429,
        { 'Retry-After': String(retryAfter) },
      );
    }
    const decision = await limits.domain.check(domain);
    if (!decision.allowed) {
      const { retryAfter, nextAllowedAt } = retryPayload(limits.domain);
      return c.json(
        { error: 'rate_limited', scope: 'domain', retryAfter, nextAllowedAt },
        429,
        { 'Retry-After': String(retryAfter) },
      );
    }
    await limits.rescanIp.consume('global');
    await limits.domain.consume(domain);

    await db
      .prepare(
        `INSERT INTO submissions (domain, submitter_note, source, status, created_at)
         VALUES (?, NULL, 'rescan', 'queued', ?)`,
      )
      .run(domain, new Date().toISOString());

    // Soft dispatch (same helper as search-scan): a missing or failed token
    // never fails the request — the daily cron drains the queue anyway.
    await dispatchScanQueue(c.env?.GITHUB_DISPATCH_TOKEN, overrides.fetchImpl ?? fetch);

    // Advertised cooldown for the requester; the limiter itself enforces the
    // shared per-UTC-day bucket.
    return c.json({
      status: 'queued',
      etaSeconds: SCAN_ETA_SECONDS,
      nextAllowedAt: new Date(Date.now() + SCAN_DOMAIN_WINDOW_MS).toISOString(),
    });
  });

  // Diagnostic error shield: an uncaught handler error must surface its message
  // while we root-cause the rescan 500s (tightened to a generic body afterwards).
  app.onError((err, c) => {
    console.error('unhandled route error:', err);
    const msg = err instanceof Error ? err.message : String(err);
    if (/daily row write limit/i.test(msg)) {
      // Free-tier D1 write quota exhausted: a real, dated condition — surface
      // it as service-unavailable with a localized-friendly English notice
      // (the UI shows its own bilingual copy for this status).
      return c.json(
        { error: 'write_limit', message: 'Daily database write quota exhausted; it resets at 00:00 UTC.' },
        503,
      );
    }
    return c.json({ error: 'internal' }, 500);
  });

  // POST /api/v1/verify/start {domain} — mint an opaque verification token.
  // The token is returned directly in the response; sending it by email is
  // not wired up here. The requester publishes the token via one of the three
  // methods, then GET /api/v1/verify/check probes them.
  app.post('/api/v1/verify/start', async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'invalid_json' }, 400);
    }
    const payload = (body ?? {}) as { domain?: unknown };
    if (typeof payload.domain !== 'string') {
      return c.json({ error: 'invalid_domain', message: 'domain must be a string' }, 400);
    }
    const domain = normalizeDomain(payload.domain);
    if (!domain) {
      return c.json({ error: 'invalid_domain', message: 'expected a bare domain like example.com' }, 400);
    }

    // Limits: 3 starts per domain per day + 10 per IP per hour (the hourly IP
    // budget is shared with verify/check). Both tiers are pre-checked before
    // either is consumed, so a rejected request never burns the other tier.
    const limits = verifyLimitsOf(c, overrides);
    const tiers: [string, RateLimiter][] = [
      [domain, limits.dailyDomain],
      [clientIp(c), limits.hourlyIp],
    ];
    for (const [key, limiter] of tiers) {
      const decision = await limiter.check(key);
      if (!decision.allowed) {
        const { retryAfter, nextAllowedAt } = retryPayload(limiter);
        return c.json(
          { error: 'rate_limited', retryAfter, nextAllowedAt },
          429,
          { 'Retry-After': String(retryAfter) },
        );
      }
    }
    for (const [key, limiter] of tiers) await limiter.consume(key);

    const token = createVerifyToken();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + VERIFY_TOKEN_TTL_MS).toISOString();
    const db = dbOf(c, overrides);
    await db
      .prepare(
        'INSERT INTO verify_tokens (domain, token, created_at, expires_at, used_at) VALUES (?, ?, ?, ?, NULL)',
      )
      .run(domain, token, now.toISOString(), expiresAt);

    return c.json({
      token,
      expiresAt,
      checkUrl: `/api/v1/verify/check?domain=${encodeURIComponent(domain)}`,
      methods: {
        file: { url: `https://${domain}/.well-known/afr-verify.txt`, content: token },
        dns: { type: 'TXT', name: domain, value: `afr-verify=${token}` },
        meta: { name: 'afr-verification', content: token },
      },
    });
  });

  // GET /api/v1/verify/check?domain= — probe file / DNS TXT / homepage meta in
  // parallel and verify on the first pass. Unreachable sites surface as failed
  // checks (verified:false), never as a 500.
  app.get('/api/v1/verify/check', async (c) => {
    const domain = normalizeDomain(c.req.query('domain') ?? '');
    if (!domain) {
      return c.json({ error: 'invalid_domain', message: 'expected a bare domain like example.com' }, 400);
    }

    // 10 probes per IP per hour, shared with verify/start. Quota is spent even
    // when no token is pending, so the endpoint cannot be used for free spam.
    const limits = verifyLimitsOf(c, overrides);
    const ipDecision = await limits.hourlyIp.check(clientIp(c));
    if (!ipDecision.allowed) {
      const { retryAfter, nextAllowedAt } = retryPayload(limits.hourlyIp);
      return c.json(
        { error: 'rate_limited', retryAfter, nextAllowedAt },
        429,
        { 'Retry-After': String(retryAfter) },
      );
    }
    await limits.hourlyIp.consume(clientIp(c));

    const db = dbOf(c, overrides);
    const now = new Date().toISOString();
    const pending = await db
      .prepare(
        `SELECT token FROM verify_tokens
         WHERE domain = ? AND used_at IS NULL AND expires_at > ?
         ORDER BY created_at DESC, rowid DESC LIMIT 1`,
      )
      .get<{ token: string }>(domain, now);
    if (!pending) return c.json({ error: 'no_pending_verification' }, 400);

    const results = await probeAll(domain, pending.token, overrides.fetchImpl ?? fetch);
    const passed = results.find((result) => result.ok);
    if (passed) {
      const verifiedAt = new Date().toISOString();
      // One write per table: consume the token, record/refresh the owner,
      // flip sites.verified (a no-op for domains without a sites row).
      await db
        .prepare('UPDATE verify_tokens SET used_at = ? WHERE token = ?')
        .run(verifiedAt, pending.token);
      await db
        .prepare(
          `INSERT INTO owners (domain, verify_method, verified_at) VALUES (?, ?, ?)
           ON CONFLICT(domain) DO UPDATE SET
             verify_method = excluded.verify_method, verified_at = excluded.verified_at`,
        )
        .run(domain, ownerVerifyMethod(passed.method), verifiedAt);
      await db.prepare('UPDATE sites SET verified = 1 WHERE domain = ?').run(domain);
      return c.json({ verified: true, method: passed.method });
    }
    return c.json({ verified: false, checks: results });
  });

  // POST /api/v1/claims {domain, statement} — statement from a verified owner.
  // Rows land as pending; statements are published after editorial review.
  app.post('/api/v1/claims', async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'invalid_json' }, 400);
    }
    const payload = (body ?? {}) as { domain?: unknown; statement?: unknown };
    if (typeof payload.domain !== 'string') {
      return c.json({ error: 'invalid_domain', message: 'domain must be a string' }, 400);
    }
    const domain = normalizeDomain(payload.domain);
    if (!domain) {
      return c.json({ error: 'invalid_domain', message: 'expected a bare domain like example.com' }, 400);
    }
    if (typeof payload.statement !== 'string') {
      return c.json({ error: 'invalid_statement', message: 'statement must be a string' }, 400);
    }
    const statement = payload.statement.trim();
    if (statement.length < 1 || statement.length > 200) {
      return c.json({ error: 'invalid_statement', message: 'statement must be 1-200 characters' }, 400);
    }

    const db = dbOf(c, overrides);
    const site = await db
      .prepare('SELECT verified FROM sites WHERE domain = ?')
      .get<{ verified: number | null }>(domain);
    const owner = await db
      .prepare('SELECT domain FROM owners WHERE domain = ?')
      .get<{ domain: string }>(domain);
    // Unknown to both tables → 404; listed but unverified → 403. A recorded
    // owner row also counts as verified (either signal is enough).
    if (!site && !owner) return c.json({ error: 'unknown_domain' }, 404);
    if (!(site?.verified === 1 || owner)) return c.json({ error: 'not_verified' }, 403);

    const limits = claimLimitsOf(c, overrides);
    const decision = await limits.domain.check(domain);
    if (!decision.allowed) {
      const { retryAfter, nextAllowedAt } = retryPayload(limits.domain);
      return c.json(
        { error: 'rate_limited', retryAfter, nextAllowedAt },
        429,
        { 'Retry-After': String(retryAfter) },
      );
    }
    await limits.domain.consume(domain);

    await db
      .prepare(`INSERT INTO claims (domain, statement, status, created_at) VALUES (?, ?, 'pending', ?)`)
      .run(domain, statement, new Date().toISOString());
    return c.json({ status: 'pending' }, 201);
  });

  // GET /api/v1/claims?domain= — public read of the published claim, if any.
  app.get('/api/v1/claims', async (c) => {
    const domain = normalizeDomain(c.req.query('domain') ?? '');
    if (!domain) return c.json({ statement: null });
    const db = dbOf(c, overrides);
    const row = await db
      .prepare(
        `SELECT statement, created_at FROM claims
         WHERE domain = ? AND status = 'published' ORDER BY id DESC LIMIT 1`,
      )
      .get<{ statement: string | null; created_at: string | null }>(domain);
    if (!row) return c.json({ statement: null });
    return c.json({ statement: row.statement, publishedAt: row.created_at });
  });

  // GET /api/v1/pv?site=<domain> — counts a detail-page view. Always answers
  // 204 (the pixel must never fail visibly); only domains listed in sites are
  // counted, and the daily write budget is enforced inside the upsert — once
  // today's count reaches PV_DAILY_WRITE_CAP the guarded statement matches no
  // row, so a capped view costs zero rows written (a 0-row statement changes
  // nothing — assumed not to be billed as a row write).
  app.get('/api/v1/pv', async (c) => {
    const domain = normalizeDomain(c.req.query('site') ?? '');
    if (domain) {
      try {
        const db = dbOf(c, overrides);
        const site = await db
          .prepare('SELECT domain FROM sites WHERE domain = ?')
          .get<{ domain: string }>(domain);
        if (site) {
          const today = new Date().toISOString().slice(0, 10);
          await db.prepare(PV_COUNT_SQL).run(domain, today, PV_DAILY_WRITE_CAP);
        }
      } catch (err) {
        // Counting is best-effort — the pixel itself must never fail visibly.
        console.warn(`pv: count failed (${err instanceof Error ? err.message : String(err)})`);
      }
    }
    // The Fetch standard forbids a body on 204 (the Response constructor throws
    // in both Node and workerd), so the beacon ships with the image/gif content
    // type and an empty body — the request itself is what gets counted.
    return new Response(null, { status: 204, headers: { 'content-type': 'image/gif' } });
  });

  // GET /api/v1/sites/:domain/views — read-only counter {domain, views, today}.
  // Unknown-but-valid domains report zeros (the pixel simply never counted them).
  app.get('/api/v1/sites/:domain/views', async (c) => {
    const domain = normalizeDomain(c.req.param('domain'));
    if (!domain) return c.json({ error: 'invalid_domain' }, 400);
    const db = dbOf(c, overrides);
    let views = 0;
    let today = 0;
    try {
      const row = await db
        .prepare('SELECT views, today_views FROM page_views WHERE domain = ?')
        .get<{ views: number; today_views: number }>(domain);
      views = row?.views ?? 0;
      today = row?.today_views ?? 0;
    } catch {
      // Counter table not present yet — report zeros rather than failing
    }
    return c.json({ domain, views, today });
  });

  // ----------------------------------------------------------------------
  // Route skeletons — 501 until each feature ships
  // ----------------------------------------------------------------------

  // Badge abuse reports: forged/tampered badge submissions.
  app.post('/api/v1/badge/report', (c) =>
    c.json({ error: 'not_implemented', feature: 'verification' }, 501),
  ); // {domain} → forged/tampered badge report

  // Ads domain: application → Stripe Checkout, abuse
  // reports, and the internal Stripe webhook feeding the review queue.
  app.post('/api/v1/ads/apply', (c) =>
    c.json({ error: 'not_implemented', feature: 'ads' }, 501),
  ); // {domain, slot, headline, body} → Stripe Checkout link
  app.post('/api/v1/ads/report', (c) =>
    c.json({ error: 'not_implemented', feature: 'ads' }, 501),
  ); // ad abuse report
  app.post('/api/v1/_ads/webhook', (c) =>
    c.json({ error: 'not_implemented', feature: 'ads' }, 501),
  ); // Stripe callback → review queue → cron expires ads daily

  return app;
}

// Cloudflare Workers entry: one shared app instance, bindings per request.
const app = createApp();

export default {
  fetch(request: Request, env: WorkerEnv, ctx: ExecutionContext): Response | Promise<Response> {
    return app.fetch(request, env, ctx);
  },

  /** Daily cron (wrangler.toml [triggers] crons): sync the newest snapshot
   * from the data repo into D1. The Worker never scans — scanners run in
   * GitHub Actions (scan.yml), which reports back via /api/v1/queue/:domain/done. */
  async scheduled(_controller: ScheduledController, env: WorkerEnv, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      runDailySync({ db: createD1Db(env.DB), fetchImpl: githubAuthedFetch(env.GITHUB_DISPATCH_TOKEN, fetch) }),
    );
  },
};
