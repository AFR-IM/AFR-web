// src/index.ts — aiapp.im Worker API (Hono on Cloudflare Workers).
// Endpoints per spec v1.0 §6.2 + v1.2 §6.2; the AFR method schema per §14-D;
// the SVG badge per §8.4. D1 is wrapped by src/db.ts so tests can inject a
// node:sqlite database through createApp({ db }).

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { Context } from 'hono';
import type { D1Database, ExecutionContext, KVNamespace } from '@cloudflare/workers-types';
import { GRADE_THRESHOLDS, LAYER_MAX } from '../../../packages/shared/src/index.ts';
import { AFR_LAYERS, AFR_VERSION } from './method-checks.ts';
import { GRADE_COLORS } from './grade-colors.ts';
import { badgeSvg } from './badge.ts';
import { createD1Db, type Db, type Row, type SqlParam } from './db.ts';
import { DAY_MS, RateLimiter, kvStore, memoryStore } from './rate-limit.ts';

/** Cloudflare bindings (wrangler.toml) */
export interface WorkerEnv {
  DB: D1Database;
  /** Optional: when missing the rate limiter falls back to an in-memory counter */
  KV?: KVNamespace;
}

type AppEnv = { Bindings: WorkerEnv };

export interface AppOverrides {
  /** Injected database (tests use node:sqlite; production uses c.env.DB) */
  db?: Db;
  /** Injected rate limiter (tests use an isolated in-memory store) */
  rateLimiter?: RateLimiter;
}

/** 5 submissions per IP per day (spec §6.2) */
export const SUBMISSION_LIMIT = 5;
const PER_PAGE = 20;
const LEADERBOARD_SIZE = 10;

// ---------------------------------------------------------------------------
// Domain validation (bare lowercase domains only, spec §6.1 sites.domain)
// ---------------------------------------------------------------------------

const LABEL_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/** Normalize a submitted/requested domain to a bare lowercase FQDN,
 * or null when the syntax is invalid (scheme/path/port/IP literals rejected). */
export function normalizeDomain(raw: string): string | null {
  const domain = raw.trim().toLowerCase().replace(/\.$/, '');
  if (domain.length < 4 || domain.length > 253) return null;
  const labels = domain.split('.');
  if (labels.length < 2) return null;
  if (!labels.every((label) => LABEL_RE.test(label))) return null;
  const tld = labels.at(-1);
  if (!tld || tld.length < 2 || !/^[a-z]/.test(tld)) return null;
  return domain;
}

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

function dbOf(c: Context<AppEnv>, overrides: AppOverrides): Db {
  return overrides.db ?? createD1Db(c.env.DB);
}

function limiterOf(c: Context<AppEnv>, overrides: AppOverrides): RateLimiter {
  if (overrides.rateLimiter) return overrides.rateLimiter;
  if (c.env.KV) return new RateLimiter(kvStore(c.env.KV), SUBMISSION_LIMIT, DAY_MS, 'subs');
  return fallbackLimiter;
}

export function createApp(overrides: AppOverrides = {}): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  // CORS open for the whole API surface (spec §6.2: all JSON endpoints, open CORS).
  // The /badge/* route is an <img> asset and does not need CORS.
  app.use('/api/v1/*', cors({ origin: '*' }));

  // -------------------------------------------------------------------------
  // Directory (spec §6.2)
  // -------------------------------------------------------------------------

  // GET /api/v1/sites?category=&grade=&q=&sort=&page=
  // sort: score (default, AFR score DESC — product invariant, spec §7) | rank | new
  app.get('/api/v1/sites', async (c) => {
    const db = dbOf(c, overrides);
    const category = c.req.query('category') ?? '';
    const grade = c.req.query('grade') ?? '';
    const q = (c.req.query('q') ?? '').trim();
    const sortRaw = c.req.query('sort');
    const sort = (sortRaw && sortRaw.toLowerCase()) || 'score';
    const page = Math.max(1, Number.parseInt(c.req.query('page') ?? '1', 10) || 1);

    if (!['score', 'rank', 'new'].includes(sort)) {
      return c.json({ error: 'invalid_sort', allowed: ['score', 'rank', 'new'] }, 400);
    }

    const where: string[] = ["s.status = 'active'"];
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
      .all<SiteRow>(...params, PER_PAGE, (page - 1) * PER_PAGE);

    return c.json({
      items: rows.map(mapSite),
      page,
      per_page: PER_PAGE,
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

    return c.json({
      site: mapSite(site),
      scan: scan ? mapScan(scan) : null,
      evidence: evidence.map(mapEvidence),
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
                AVG(score_total) AS avg_score
         FROM sites WHERE status = 'active'`,
      )
      .get<{ total: number; verified: number | null; avg_score: number | null }>();
    const gradeRows = await db
      .prepare(
        `SELECT grade, COUNT(*) AS n FROM sites
         WHERE status = 'active' AND grade IS NOT NULL GROUP BY grade`,
      )
      .all<{ grade: string; n: number }>();

    const grades: Record<string, number> = { A: 0, B: 0, C: 0, D: 0, F: 0 };
    for (const row of gradeRows) grades[row.grade] = row.n;

    const avg = totals?.avg_score;
    return c.json({
      total: totals?.total ?? 0,
      verified: totals?.verified ?? 0,
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
                  WHERE s.category_id = c.id AND s.status = 'active') AS count
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
  // Natural ranking must never mix in ads (spec §7: any commercial factor may
  // not change the ordering); paid placements live only in /api/v1/ads.
  app.get('/api/v1/leaderboard', async (c) => {
    const db = dbOf(c, overrides);
    const category = c.req.query('category') ?? '';
    const requested = Number.parseInt(c.req.query('limit') ?? '', 10);
    const limit = Number.isFinite(requested) && requested > 0 ? Math.min(requested, 50) : LEADERBOARD_SIZE;

    const where: string[] = ["s.status = 'active'", 's.score_total IS NOT NULL'];
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
  // Badge (spec §8.4)
  // -------------------------------------------------------------------------

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
  // Submissions (spec §6.2: POST /api/v1/submissions {domain, note?}, 5/IP/day)
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
  // Ads (spec v1.2 §6.2)
  // -------------------------------------------------------------------------

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
  // Route skeletons — 501 until their milestones ship (spec §12)
  // -------------------------------------------------------------------------

  // M3 (W6) verification & badges: three-method domain verification, owner
  // claims, rescan requests, badge abuse reports (spec §6.2, §8.2–8.4).
  app.post('/api/v1/verify/start', (c) =>
    c.json({ error: 'not_implemented', milestone: 'M3' }, 501),
  ); // {domain, email} → magic link (DNS TXT / meta / file token, 7d validity)
  app.get('/api/v1/verify/check', (c) =>
    c.json({ error: 'not_implemented', milestone: 'M3' }, 501),
  ); // ?domain= → probes aiapp-verify token via DoH/HTTP
  app.post('/api/v1/claims', (c) =>
    c.json({ error: 'not_implemented', milestone: 'M3' }, 501),
  ); // {domain, statement} → requires verified owner
  app.post('/api/v1/rescan', (c) =>
    c.json({ error: 'not_implemented', milestone: 'M3' }, 501),
  ); // {domain} → 1/24h per site
  app.post('/api/v1/badge/report', (c) =>
    c.json({ error: 'not_implemented', milestone: 'M3' }, 501),
  ); // {domain} → forged/tampered badge report

  // M7 ads domain (spec v1.2 §6.2): application → Stripe Checkout, abuse
  // reports, and the internal Stripe webhook feeding the review queue.
  app.post('/api/v1/ads/apply', (c) =>
    c.json({ error: 'not_implemented', milestone: 'M7' }, 501),
  ); // {domain, slot, headline, body} → Stripe Checkout link
  app.post('/api/v1/ads/report', (c) =>
    c.json({ error: 'not_implemented', milestone: 'M7' }, 501),
  ); // ad abuse report
  app.post('/api/v1/_ads/webhook', (c) =>
    c.json({ error: 'not_implemented', milestone: 'M7' }, 501),
  ); // Stripe callback → review queue → cron expires ads daily

  return app;
}

// Cloudflare Workers entry: one shared app instance, bindings per request.
const app = createApp();

export default {
  fetch(request: Request, env: WorkerEnv, ctx: ExecutionContext): Response | Promise<Response> {
    return app.fetch(request, env, ctx);
  },
};
