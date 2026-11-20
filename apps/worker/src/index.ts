// src/index.ts — AFR.IM Worker API (Hono on Cloudflare Workers).
// Endpoints: public JSON API (sites / leaderboard / stats / categories / ads /
// submissions); the AFR method schema per spec §14-D; the SVG badge rendered
// inline. D1 is wrapped by src/db.ts so tests can inject a node:sqlite
// database through createApp({ db }).

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { Context, MiddlewareHandler } from 'hono';
import type { D1Database, ExecutionContext, KVNamespace, ScheduledController } from '@cloudflare/workers-types';
import { GRADE_THRESHOLDS, LAYER_MAX } from '../../../packages/shared/src/index.ts';
import { AFR_LAYERS, AFR_VERSION } from './method-checks.ts';
import { GRADE_COLORS } from './grade-colors.ts';
import { badgeSvg } from './badge.ts';
import { githubAuthedFetch, runDailySync } from './cron.ts';
import { createD1Db, type Db, type Row, type SqlParam } from './db.ts';
import { normalizeDomain, registrableDomain } from './domain.ts';
import { handleMcpRequest, MCP_RATE_LIMIT, MCP_RATE_WINDOW_MS } from './mcp.ts';
import { DAY_MS, HOUR_MS, RateLimiter, kvStore, memoryStore } from './rate-limit.ts';
import {
  createVerifyToken,
  ownerVerifyMethod,
  probeAll,
  VERIFY_TOKEN_TTL_MS,
} from './verification.ts';
import {
  API_KEY_HEADER,
  isValidApiKey,
} from './api-key.ts';
import { pruneMailArtifacts } from './mail-gc.ts';
import {
  buildMagicToken,
  buildMailChallenge,
  buildManageToken,
  decryptEmail,
  drainNotifyOutbox,
  emailHash,
  enqueueScoreChangeNotifications,
  encryptEmail,
  hashToken,
  magicLinkUrl,
  maskEmail,
  normalizeEmail,
  probeMailChallengeAll,
  renderVerificationEmail,
  sendEmailViaResend,
  DEFAULT_BASE_URL,
  DEFAULT_FROM,
  EMAIL_CHALLENGE_TTL_MS,
  EMAIL_VERIFY_TTL_MS,
} from './email.ts';
import {
  describeSmtpProblem,
  parseSmtpConfig,
  sendViaSmtp,
  type SmtpConfig,
} from './mail-smtp.ts';
import {
  consumeMailQuota,
  DEFAULT_MAIL_QUOTA_LIMITS,
  mailQuotaDay,
  readMailQuotaStatus,
  type MailQuotaLimits,
  type QuotaDecision,
} from './mail-quota.ts';
import {
  TURNSTILE_ACTIONS,
  verifyTurnstile,
  type TurnstileCheck,
} from './turnstile.ts';

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
  /** Worker secret: base64 secret (32 bytes in production) used to derive the
   * AES-GCM / HMAC keys of the owner mailbox store. Missing → the owner
   * email endpoints answer 503 (email_not_configured). */
  EMAIL_ENC_KEY?: string;
  /** Worker secret: Resend API key for outbound owner mail. Missing → the
   * mailbox is still stored, only no mail is sent. */
  RESEND_API_KEY?: string;
  /** Sender address of owner mail (defaults to notifications@afr.im) */
  EMAIL_FROM?: string;
  /** Generic SMTP channel — host of the submission server (e.g. "smtp.mail.io").
   * Missing → the SMTP channel reports itself as not configured. */
  SMTP_HOST?: string;
  /** Port of the SMTP server (default 587; 465 = implicit TLS, 2525 = common
   * alternative). Port 25 is blocked by the platform and is refused. */
  SMTP_PORT?: string;
  /** Transport security: "starttls" (default), "ssl" (implicit TLS) or "none". */
  SMTP_SECURITY?: string;
  /** SMTP user name (optional — a server may accept mail without auth). */
  SMTP_USERNAME?: string;
  /** SMTP password (optional). Never echoed back by any endpoint. */
  SMTP_PASSWORD?: string;
  /** Sender address of the SMTP channel (required — a mail without an
   * identity is never sent). */
  SMTP_FROM?: string;
  /** Reply-To address of the SMTP channel (optional). */
  SMTP_REPLY_TO?: string;
  /** Public site base URL used in magic links and report links */
  PUBLIC_SITE_URL?: string;
  /** Worker secret: Cloudflare Turnstile siteverify secret (the sitekey is
   * public and lives in the front-end build). Missing → the human check is
   * skipped (fail-open) so local dev keeps working; PRODUCTION MUST set it
   * (`wrangler secret put TURNSTILE_SECRET`). */
  TURNSTILE_SECRET?: string;
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
  /** Injected owner-email rate limiters (tests use isolated in-memory stores) */
  emailLimits?: EmailRateLimits;
  /** Injected fetch for the GitHub dispatch (tests pass a fake) */
  fetchImpl?: typeof fetch;
  /** Injected fetch for the Turnstile siteverify call (tests pass a fake);
   * keeps the siteverify traffic out of the real network. */
  turnstileFetch?: typeof fetch;
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
/** Submission → searchable wall-clock estimate: ~3 min scan + ~5-8 min rebuild
 * and publish. Returned by POST /api/v1/submissions so the submit page can
 * state a real number instead of the old scan-only 180 s. */
export const SUBMIT_ETA_SECONDS = 600;
export const QUEUE_LIST_LIMIT = 50;

// Verification flow limits
export const VERIFY_START_DOMAIN_LIMIT = 3; // verify/start per domain per UTC day
export const VERIFY_IP_LIMIT = 10; // verify/start + verify/check per IP per hour (shared)
export const CLAIMS_DOMAIN_LIMIT = 5; // claims per domain per UTC day

// Owner email subsystem limits
export const EMAIL_DOMAIN_LIMIT = 3; // mailbox registrations per domain per UTC day
export const EMAIL_IP_LIMIT = 5; // mailbox registrations per IP per hour
export const EMAIL_VERIFY_IP_LIMIT = 20; // magic-link verifications per IP per hour
export const EMAIL_START_DOMAIN_LIMIT = 3; // domain-control challenges per domain per UTC day
export const EMAIL_START_IP_LIMIT = 5; // domain-control challenges per IP per hour

// PV pixel: daily D1 write budget, enforced inside the count upsert
export const PV_DAILY_WRITE_CAP = 20_000; // leave headroom for scans + sync inside the 100k/day free tier

const SCAN_DISPATCH_URL =
  'https://api.github.com/repos/AFR-IM/AFR-web/actions/workflows/scan.yml/dispatches';

const PER_PAGE = 20;
const LEADERBOARD_SIZE = 10;

// Domain validation lives in src/domain.ts (shared with the MCP tools in
// src/mcp.ts) and is re-exported here so `import { normalizeDomain } from
// './index.ts'` keeps working.
export { normalizeDomain, registrableDomain };

function clientIp(c: Context<AppEnv>): string {
  const forwarded = c.req.header('x-forwarded-for');
  if (forwarded) return forwarded.split(',')[0]?.trim() || 'unknown';
  return c.req.header('x-real-ip') ?? 'unknown';
}

/**
 * Human-verification gate for the public POST endpoints.
 *
 * The token is read from the request body field `turnstile_token` and checked
 * against Cloudflare's siteverify API. When the worker has no Turnstile
 * secret the check is skipped (fail-open, see TURNSTILE_FAIL_OPEN) so that
 * local development and preview deployments keep working; the deployment
 * itself never learns whether the gate was active.
 *
 * `action` binds a token to one endpoint: a token minted for the search form
 * cannot unlock the submit endpoint.
 *
 * Usage inside a route:
 *   const check = await requireTurnstile(c, { action: TURNSTILE_ACTIONS.submit });
 *   if (!check.ok) return c.json({ error: 'turnstile_failed', reason: check.reason }, 400);
 */
async function requireTurnstile(
  c: Context<AppEnv>,
  opts: { action: string; payload?: unknown; fetchImpl?: typeof fetch; db: Db },
): Promise<TurnstileCheck> {
  // A machine client (AI agent, script) cannot run a browser widget, so it
  // presents an API key instead. The key is the authorisation, the captcha is
  // only there for humans.
  const apiKey = c.req.header(API_KEY_HEADER) ?? null;
  if (apiKey && (await isValidApiKey(opts.db, apiKey))) {
    return { ok: true };
  }
  let payload = opts.payload;
  if (payload === undefined) {
    try {
      payload = await c.req.json();
    } catch {
      // An unreadable body simply carries no token.
      payload = undefined;
    }
  }
  const raw =
    payload && typeof payload === 'object'
      ? (payload as { turnstile_token?: unknown }).turnstile_token
      : undefined;
  const token = typeof raw === 'string' ? raw : null;
  const ip = clientIp(c);
  return verifyTurnstile({
    token,
    secret: c.env?.TURNSTILE_SECRET,
    // 'unknown' is clientIp()'s placeholder when no proxy header is present;
    // sending it would make Cloudflare reject an honest token.
    remoteIp: ip && ip !== 'unknown' ? ip : null,
    expectedAction: opts.action,
    fetchImpl: opts.fetchImpl,
  });
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
  evidence_prev: number | null;
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

/** Owner email tiers: registrations per domain/day + per IP/hour, plus the
 * magic-link verification budget per IP/hour.
 *
 * The challenge tier (start) is metered separately from the registration
 * tier: publishing a challenge and registering the mailbox are two different
 * steps, and one must not exhaust the budget of the other. The two start
 * limiters are optional — without them the registration tiers are reused. */
export interface EmailRateLimits {
  dailyDomain: RateLimiter;
  hourlyIp: RateLimiter;
  verifyIp: RateLimiter;
  /** domain-control challenges per domain per day */
  startDomain?: RateLimiter;
  /** domain-control challenges per IP per hour */
  startIp?: RateLimiter;
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

/** Fallback owner-email limiters (per-isolate memory — degraded but serviceable) */
const fallbackEmailLimits: EmailRateLimits = {
  dailyDomain: new RateLimiter(memoryStore(), EMAIL_DOMAIN_LIMIT, DAY_MS, 'email-domain'),
  hourlyIp: new RateLimiter(memoryStore(), EMAIL_IP_LIMIT, HOUR_MS, 'email-ip'),
  verifyIp: new RateLimiter(memoryStore(), EMAIL_VERIFY_IP_LIMIT, HOUR_MS, 'email-verify-ip'),
  startDomain: new RateLimiter(memoryStore(), EMAIL_START_DOMAIN_LIMIT, DAY_MS, 'email-start-domain'),
  startIp: new RateLimiter(memoryStore(), EMAIL_START_IP_LIMIT, HOUR_MS, 'email-start-ip'),
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

function emailLimitsOf(c: Context<AppEnv>, overrides: AppOverrides): EmailRateLimits {
  if (overrides.emailLimits) return overrides.emailLimits;
  if (c.env?.KV) {
    const store = kvStore(c.env.KV);
    return {
      dailyDomain: new RateLimiter(store, EMAIL_DOMAIN_LIMIT, DAY_MS, 'email-domain'),
      hourlyIp: new RateLimiter(store, EMAIL_IP_LIMIT, HOUR_MS, 'email-ip'),
      verifyIp: new RateLimiter(store, EMAIL_VERIFY_IP_LIMIT, HOUR_MS, 'email-verify-ip'),
      startDomain: new RateLimiter(store, EMAIL_START_DOMAIN_LIMIT, DAY_MS, 'email-start-domain'),
      startIp: new RateLimiter(store, EMAIL_START_IP_LIMIT, HOUR_MS, 'email-start-ip'),
    };
  }
  return fallbackEmailLimits;
}

/** Public base URL used in magic links and report links */
function baseUrlOf(c: Context<AppEnv>): string {
  return (c.env?.PUBLIC_SITE_URL ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
}

/** Sender address of owner mail */
function fromOf(c: Context<AppEnv>): string {
  return c.env?.EMAIL_FROM ?? DEFAULT_FROM;
}

// ---------------------------------------------------------------------------
// Outbound mail channels (Resend → SMTP)
// ---------------------------------------------------------------------------

/** The environment values the mail channels read. */
export type MailEnv = Record<string, string | undefined>;

/** Arguments of one outbound mail. */
export interface DeliverOwnerMailArgs {
  /** Domain that triggers the mail (used for the per-domain quota). */
  domain: string;
  /** Recipient address. */
  to: string;
  subject: string;
  text: string;
  html?: string;
  /** Idempotency key — a retry must not produce a second mail. */
  idempotencyKey?: string;
  /** Injectable clock (tests). */
  now?: () => Date;
  /** Injectable fetch (tests). */
  fetchImpl?: typeof fetch;
  /** Injectable SMTP connect step (tests). */
  connect?: (opts: unknown) => Promise<unknown>;
  /** Override of the quota limits (tests). */
  limits?: Partial<MailQuotaLimits>;
}

/** Outcome of one delivery attempt. */
export interface DeliverOwnerMailResult {
  ok: boolean;
  /** The channel that accepted the mail. */
  channel?: 'resend' | 'smtp';
  /** Provider id (Resend) or Message-ID (SMTP). */
  id?: string;
  /** Generic error text — never states why a mail was refused. */
  error?: string;
  /** Failure class of the last attempt (safe to log). */
  category?: string;
}

/** Deliver one mail through the Resend HTTP API.
 *
 * The request carries an Idempotency-Key, so a retry after a crashed drain
 * replays the original answer instead of sending a second mail. The API key
 * never appears in the returned error and the recipient is not echoed back
 * either — the caller only learns the status class. */
async function deliverViaResend(
  args: {
    apiKey: string;
    from: string;
    to: string;
    subject: string;
    text: string;
    html: string;
    idempotencyKey: string;
  },
  fetchImpl: typeof fetch,
): Promise<{ ok: boolean; id?: string; error?: string; status?: number }> {
  const { apiKey, from, to, subject, text, html, idempotencyKey } = args;
  try {
    const res = await fetchImpl('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
        'idempotency-key': idempotencyKey,
      },
      body: JSON.stringify({ from, to, subject, text, html }),
      signal: AbortSignal.timeout(10_000),
    });

    if (res.ok) {
      let id: string | undefined;
      try {
        const payload = (await res.json()) as { id?: unknown };
        if (typeof payload?.id === 'string') id = payload.id;
      } catch {
        // A 2xx without a parsable body still means the mail was accepted.
      }
      return id ? { ok: true, id } : { ok: true };
    }
    // Only the status class is reported — the provider body may quote the
    // request (and therefore the address).
    return { ok: false, status: res.status, error: `http_${res.status}` };
  } catch {
    return { ok: false, status: 0, error: 'network_error' };
  }
}

/** Deliver one outbound mail, respecting the quota and the channel order.
 *
 * The quota is checked *before* the first byte leaves the worker: a request
 * that is refused must not burn the provider budget. The channels are tried
 * in a fixed order — Resend first (HTTP, cheapest), then SMTP — and the
 * first success wins.
 *
 * A refused mail is reported as a plain failure: the reason (quota, auth,
 * recipient) stays inside the worker, because the endpoints that trigger a
 * mail are public and must not tell a caller how to get past the limit. */
export async function deliverOwnerMail(
  db: Db,
  env: MailEnv,
  args: DeliverOwnerMailArgs,
): Promise<DeliverOwnerMailResult> {
  const now = args.now ?? (() => new Date());
  const fetchImpl = args.fetchImpl ?? fetch;

  const apiKey = env.RESEND_API_KEY;
  const smtpConfig: SmtpConfig | null = parseSmtpConfig(env);
  if (!apiKey && !smtpConfig) {
    // Nothing can be sent — do not consume a quota unit for a mail that
    // cannot leave the worker anyway.
    console.warn('mail: no channel configured');
    return { ok: false, error: 'mail_not_configured' };
  }

  let quota: QuotaDecision;
  try {
    quota = await consumeMailQuota(db, {
      domain: args.domain,
      recipient: args.to,
      now,
      limits: args.limits,
    });
  } catch (err) {
    // Without a working quota check no mail may go out (fail closed).
    console.warn(
      `mail: quota check failed (${err instanceof Error ? err.message : String(err)})`,
    );
    return { ok: false, error: 'mail_not_sent' };
  }
  if (!quota.allowed) {
    console.warn(`mail: refused by quota (${quota.reason ?? 'unknown'})`);
    return { ok: false, error: 'mail_not_sent' };
  }

  if (apiKey) {
    const sent = await deliverViaResend(
      {
        apiKey,
        from: env.EMAIL_FROM ?? DEFAULT_FROM,
        to: args.to,
        subject: args.subject,
        text: args.text,
        html: args.html ?? '',
        idempotencyKey:
          args.idempotencyKey ?? `mail:${args.domain}:${args.to}:${now().toISOString()}`,
      },
      fetchImpl,
    );
    if (sent.ok) return { ok: true, channel: 'resend', id: sent.id };
    console.warn(
      `mail: delivery failed (channel=resend status=${sent.status ?? 'unknown'})`,
    );
  }

  if (smtpConfig) {
    const sent = await sendViaSmtp({
      config: smtpConfig,
      to: args.to,
      subject: args.subject,
      text: args.text,
      html: args.html,
      now,
      connect: args.connect,
    });
    if (sent.ok) return { ok: true, channel: 'smtp', id: sent.id };
    console.warn(
      `mail: delivery failed (channel=smtp category=${sent.category ?? 'unknown'})`,
    );
  }

  return { ok: false, error: 'mail_not_sent' };
}

/** Detect a Cloudflare Email Routing send binding.
 *
 * The binding name is free, so the binding itself is detected: it carries a
 * `send` function. Only the availability is reported, never the target. */
function cfEmailAvailable(env: unknown): boolean {
  if (!env || typeof env !== 'object') return false;
  for (const value of Object.values(env as Record<string, unknown>)) {
    if (value && typeof (value as { send?: unknown }).send === 'function') return true;
  }
  return false;
}

/** Canonical key of a domain inside the directory: the registered domain when
 * the input is a subdomain of one, the domain itself otherwise.
 *
 * The challenge and the mailbox must always be keyed by the same value, so
 * both routes resolve the input through this helper — an owner who types
 * "www.example.com" in one request and "example.com" in the next still hits
 * the same row. */
function directoryDomain(domain: string): string {
  return registrableDomain(domain) ?? domain;
}

/** Bearer token from the Authorization header. The scheme name is
 * case-insensitive (RFC 7235); a missing or malformed header yields null and
 * the caller answers 401 without telling why. */
function bearerToken(c: Context<AppEnv>): string | null {
  const header = c.req.header('authorization') ?? '';
  const match = /^bearer\s+(.+)$/i.exec(header.trim());
  const token = match?.[1]?.trim();
  return token ? token : null;
}

/** The mailbox row a management token is allowed to act on.
 *
 * The token is compared by hash (only the hash is stored) and the mailbox has
 * to be confirmed. A missing token, a wrong token and the token of another
 * domain are indistinguishable from the outside: all of them return null. */
async function managedMailbox(
  db: Db,
  domain: string,
  token: string | null,
): Promise<{ email_cipher: string; verified_at: string | null; notify: number | null } | null> {
  if (!token) return null;
  const row = await db
    .prepare(
      `SELECT email_cipher, verified_at, notify FROM owner_emails
       WHERE domain = ? AND manage_token_hash = ? AND verified_at IS NOT NULL`,
    )
    .get<{ email_cipher: string; verified_at: string | null; notify: number | null }>(
      domain,
      await hashToken(token),
    );
  return row ?? null;
}

/** The confirmed mailbox a management token is allowed to act on — plus the
 * lookup hash of its address.
 *
 * Same lock as managedMailbox(); the extra column is what the mailbox-change
 * route needs to tell "same address" from "new address" without decrypting
 * the stored ciphertext. */
async function managedMailboxWithHash(
  db: Db,
  domain: string,
  token: string | null,
): Promise<{
  email_cipher: string;
  email_hash: string;
  verified_at: string | null;
  notify: number | null;
} | null> {
  if (!token) return null;
  const row = await db
    .prepare(
      `SELECT email_cipher, email_hash, verified_at, notify FROM owner_emails
       WHERE domain = ? AND manage_token_hash = ? AND verified_at IS NOT NULL`,
    )
    .get<{
      email_cipher: string;
      email_hash: string;
      verified_at: string | null;
      notify: number | null;
    }>(domain, await hashToken(token));
  return row ?? null;
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

/** Schedule the queue dispatch off the request's critical path.
 *
 * The dispatch is a cross-origin call to api.github.com with a 5s timeout.
 * Awaiting it inline made every submit/search-scan response wait for GitHub:
 * on a slow mobile connection the browser gave up first and surfaced a
 * "network error" even though the row was already queued (2026-11-17
 * reported as `aiboss.im` never collected). Production therefore runs it in
 * `waitUntil` and answers immediately; tests / any context without an
 * ExecutionContext fall back to awaiting so the outcome stays observable.
 *
 * Returns 'scheduled' when handed to the runtime, otherwise the dispatch
 * outcome ('ok' | 'deferred'). */
async function scheduleScanDispatch(
  c: Context<AppEnv>,
  token: string | undefined,
  fetchImpl: typeof fetch,
): Promise<'scheduled' | 'ok' | 'deferred'> {
  if (!token) {
    console.warn('scan dispatch: GITHUB_DISPATCH_TOKEN not set, dispatch deferred');
    return 'deferred';
  }
  try {
    c.executionCtx.waitUntil(dispatchScanQueue(token, fetchImpl));
    return 'scheduled';
  } catch {
    // No ExecutionContext (unit tests, or a runtime that does not expose it):
    // await so the caller still learns whether GitHub accepted the dispatch.
    return dispatchScanQueue(token, fetchImpl);
  }
}
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

/** Owner-notification pipeline: enqueue the score-change events of verified
 * mailboxes, then drain the outbox through Resend.
 *
 * Never throws — a mail failure must not break the sync or the cron. The
 * helper also stays quiet when the mail subsystem is not configured: a
 * deployment without an encryption key simply skips the whole pipeline. */
async function runOwnerNotifications(
  db: Db,
  env: WorkerEnv,
  fetchImpl: typeof fetch,
): Promise<{ enqueued: number; sent: number; failed: number; skipped: number } | null> {
  const secret = env?.EMAIL_ENC_KEY;
  if (!secret) return null;
  try {
    const enqueued = await enqueueScoreChangeNotifications(db, {});
    const drained = await drainNotifyOutbox(
      db,
      {
        secretB64: secret,
        resendApiKey: env.RESEND_API_KEY,
        from: env.EMAIL_FROM,
        baseUrl: env.PUBLIC_SITE_URL,
      },
      fetchImpl,
    );
    return { enqueued, ...drained };
  } catch (err) {
    console.warn(
      `owner notifications failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}

/** Enqueue the score-change events without sending anything.
 *
 * The enqueue is a few small D1 statements, so it stays on the request path:
 * the event is recorded the moment the sync that changed the score finished.
 * The delivery itself (network calls to the mail provider) is deferred — see
 * `scheduleOwnerNotificationDrain`. */
async function enqueueOwnerNotifications(
  db: Db,
  env: WorkerEnv,
): Promise<number | null> {
  if (!env?.EMAIL_ENC_KEY) return null;
  try {
    return await enqueueScoreChangeNotifications(db, {});
  } catch (err) {
    console.warn(
      `owner notification enqueue failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}

/** Deliver the queued owner mails off the request path.
 *
 * The sync endpoint runs once per page of the data set, so a rebuild fires
 * dozens of requests in a row. Awaiting the delivery inline would keep each
 * of them open for the length of the provider round-trips (and the CI caller
 * gives up after 240 s). The delivery therefore runs in `waitUntil`: the
 * response returns immediately and the mail is still sent. */
function scheduleOwnerNotificationDrain(
  c: Context<AppEnv>,
  db: Db,
  env: WorkerEnv,
  fetchImpl: typeof fetch,
): void {
  const secret = env?.EMAIL_ENC_KEY;
  if (!secret) return;
  const task = (async () => {
    try {
      const drained = await drainNotifyOutbox(
        db,
        {
          secretB64: secret,
          resendApiKey: env.RESEND_API_KEY,
          from: env.EMAIL_FROM,
          baseUrl: env.PUBLIC_SITE_URL,
        },
        fetchImpl,
      );
      if (drained.sent || drained.failed) {
        console.log(
          `owner notifications: ${drained.sent} sent, ${drained.failed} failed, ${drained.skipped} skipped`,
        );
      }
    } catch (err) {
      console.warn(
        `owner notification drain failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  })();
  try {
    c.executionCtx.waitUntil(task);
  } catch {
    // No ExecutionContext (unit tests, or a runtime that does not expose
    // it): await so the outcome stays observable.
    void task;
  }
}

/** Edge-cacheable read endpoints and their TTL in seconds (T4).
 * Only responses that are safe to serve slightly stale for a few minutes:
 * aggregates and per-site lookups. Anything with a write side effect, a
 * rate-limit response, or a counter that must be fresh is deliberately absent. */
const EDGE_CACHE_RULES: readonly [RegExp, number][] = [
  [/^\/api\/v1\/stats$/, 60],
  [/^\/api\/v1\/categories$/, 300],
  [/^\/api\/v1\/leaderboard$/, 120],
  [/^\/api\/v1\/method$/, 3600],
  [/^\/api\/v1\/sites$/, 60],
  [/^\/api\/v1\/sites\/[^/]+$/, 120],
  [/^\/api\/v1\/sites\/[^/]+\/history$/, 300],
  [/^\/badge\/[^/]+$/, 3600],
];

function edgeCacheTtl(path: string): number {
  for (const [pattern, ttl] of EDGE_CACHE_RULES) if (pattern.test(path)) return ttl;
  return 0;
}

/** Cache API handle, or undefined where the platform does not provide one
 * (unit tests run in Node, which has no `caches` global). */
function edgeCacheStore(): Cache | undefined {
  const store = (globalThis as { caches?: { default?: Cache } }).caches;
  return store?.default;
}

/** T4: put the read-heavy GET endpoints in front of D1 via the edge Cache API.
 *
 * D1 reads are the scarce free-tier resource (5M rows/day) and every origin hit
 * costs a Worker invocation out of the shared 100k/day account budget. Caching
 * the final response for a few minutes removes both for repeat traffic.
 * A request carrying `Cache-Control: no-cache` always bypasses the cache, which
 * is how the E2E checklist verifies freshness after a deploy. */
const edgeCache: MiddlewareHandler<AppEnv> = async (c, next) => {
  const ttl = edgeCacheTtl(c.req.path);
  const store = ttl && c.req.method === 'GET' ? edgeCacheStore() : undefined;
  if (!store) return next();
  if ((c.req.header('cache-control') ?? '').includes('no-cache')) return next();

  const key = new Request(c.req.url, { method: 'GET' });
  try {
    const hit = await store.match(key);
    if (hit) {
      // The cached copy already carries CORS + cache-control from its first run.
      c.res = hit;
      return;
    }
  } catch {
    // A cache read failure must never fail the request.
  }

  await next();
  const res = c.res;
  if (!res || res.status !== 200) return;

  const headers = new Headers(res.headers);
  // The Cache API copy is what saves D1 reads; the HTTP header is a separate
  // decision. Zone-level Browser Cache TTL rewrites our max-age to 4 h, and a
  // four-hour-old score in a returning visitor's browser is wrong for a
  // "current rating" product, so JSON API responses are no-store (the Worker
  // and its Cache API still answer fast). Badges are exempt: they are embedded
  // on third-party pages and must be cacheable by their CDNs.
  const isBadge = c.req.path.startsWith('/badge/');
  headers.set(
    'cache-control',
    isBadge ? `public, max-age=${ttl}` : 'no-store',
  );
  // Two independent copies: assigning `c.res` makes Hono rebuild the Response
  // from the same body stream, so the cache copy must own its own buffer.
  const buf = await res.clone().arrayBuffer();
  c.res = new Response(buf.slice(0), { status: 200, headers });
  try {
    const warm = store.put(key, new Response(buf, { status: 200, headers })).catch(() => undefined);
    c.executionCtx.waitUntil(warm);
  } catch {
    // No ExecutionContext (tests) or a storage failure: the response is already
    // produced, so the only cost is a cold cache.
  }
};

export function createApp(overrides: AppOverrides = {}): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  // T4 read path: edge cache in front of D1, registered before CORS so a hit
  // can short-circuit without running any handler.
  app.use('*', edgeCache);

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
    // Evidence for this scan. An unchanged cross-round re-scan stores no rows
    // of its own and points at the round that owns the identical set
    // (scans.evidence_prev, set by the d1-sync cross-round diff). Follow the
    // pointer until a non-empty set appears; `seen` guards against a dangling
    // pointer (e.g. the owner removed by the scans dedup in schema.sql).
    let evidence: EvidenceRow[] = [];
    if (scan) {
      evidence = await db
        .prepare('SELECT * FROM evidence WHERE scan_id = ? ORDER BY rowid')
        .all<EvidenceRow>(scan.id);
      let pointer = scan.evidence_prev ?? null;
      const seen = new Set<number>([scan.id]);
      while (evidence.length === 0 && pointer !== null && !seen.has(pointer)) {
        seen.add(pointer);
        const rows = await db
          .prepare('SELECT * FROM evidence WHERE scan_id = ? ORDER BY rowid')
          .all<EvidenceRow>(pointer);
        if (rows.length > 0) {
          evidence = rows;
          break;
        }
        const next = await db
          .prepare('SELECT evidence_prev FROM scans WHERE id = ?')
          .get<{ evidence_prev: number | null }>(pointer);
        pointer = next?.evidence_prev ?? null;
      }
    }

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
    const views = await db
      .prepare('SELECT COALESCE(SUM(views), 0) AS total_views FROM page_views')
      .get<{ total_views: number }>();

    // Grade distribution covers the five real grades only; Pending is reported
    // as its own counter (it is a scan state, not a grade — spec §3.5).
    const grades: Record<string, number> = { A: 0, B: 0, C: 0, D: 0, F: 0 };
    for (const row of gradeRows) if (row.grade in grades) grades[row.grade] = row.n;

    const avg = totals?.avg_score;
    return c.json({
      total: totals?.total ?? 0,
      verified: totals?.verified ?? 0,
      pending: totals?.pending ?? 0,
      total_views: views?.total_views ?? 0,
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
  // Fully automatic inclusion: registered domains only (subdomains are
  // rejected — the directory lists one site per registered domain), already
  // listed → 'exists', already queued → idempotent 'queued', and every new
  // entry soft-dispatches the scan queue so listing does not wait for the
  // daily 02:00 UTC cron. etaSeconds covers scan + rebuild/publish.
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
    const normalized = normalizeDomain(payload.domain);
    if (!normalized) {
      return c.json({ error: 'invalid_domain', message: 'expected a bare domain like example.com' }, 400);
    }
    const domain = registrableDomain(normalized);
    if (!domain) {
      return c.json(
        {
          error: 'subdomain_not_allowed',
          message: 'only registered domains are accepted (example.com), not subdomains',
        },
        400,
      );
    }
    if (payload.note !== undefined && payload.note !== null && typeof payload.note !== 'string') {
      return c.json({ error: 'invalid_note', message: 'note must be a string' }, 400);
    }

    // Human check (Turnstile). It runs after the payload validation (a
    // malformed request must not spend a siteverify call) and before any
    // write, quota consumption or dispatch — a request without a valid
    // human-verification token changes nothing.
    const turnstile = await requireTurnstile(c, {
      action: TURNSTILE_ACTIONS.submit,
      payload,
      fetchImpl: overrides.turnstileFetch,
      db: dbOf(c, overrides),
    });
    if (!turnstile.ok) {
      return c.json({ error: 'turnstile_failed', reason: turnstile.reason }, 400);
    }

    const db = dbOf(c, overrides);

    // Already listed → the submit page sends the visitor to the detail page
    // (the copy has always promised this; the endpoint now actually does it).
    const listed = await db
      .prepare('SELECT domain FROM sites WHERE domain = ?')
      .get<{ domain: string }>(domain);
    if (listed) return c.json({ ok: true, status: 'exists', domain });

    // Already waiting in the queue → idempotent no-op: no quota burned, no
    // duplicate row, no second dispatch.
    const queued = await db
      .prepare(
        `SELECT status FROM submissions WHERE domain = ? AND status IN ('queued', 'pending', 'scanning')
         ORDER BY id DESC LIMIT 1`,
      )
      .get<{ status: string }>(domain);
    if (queued) {
      return c.json({ ok: true, status: 'queued', domain, etaSeconds: SUBMIT_ETA_SECONDS });
    }

    // Rate limit: 5/IP/day via KV counter (in-memory fallback when KV is absent)
    const limiter = limiterOf(c, overrides);
    const decision = await limiter.consume(clientIp(c));
    if (!decision.allowed) {
      return c.json({ error: 'rate_limited', limit: SUBMISSION_LIMIT, remaining: 0 }, 429);
    }

    const note = typeof payload.note === 'string' ? payload.note.slice(0, 500) : null;
    const inserted = await db
      .prepare(
        `INSERT INTO submissions (domain, submitter_note, source, status, created_at)
         VALUES (?, ?, 'public', 'queued', ?)`,
      )
      .run(domain, note, new Date().toISOString());

    // Soft dispatch (same helper as search-scan/rescan): a missing or failed
    // token never fails the request — the daily cron drains the queue anyway.
    const dispatch = await scheduleScanDispatch(
      c,
      c.env?.GITHUB_DISPATCH_TOKEN,
      overrides.fetchImpl ?? fetch,
    );

    return c.json(
      {
        ok: true,
        id: inserted.lastInsertRowid,
        domain,
        status: 'queued',
        etaSeconds: SUBMIT_ETA_SECONDS,
        dispatch,
      },
      201,
    );
  });

  // -------------------------------------------------------------------------
  // On-demand scan requests — search-then-collect flow
  // -------------------------------------------------------------------------

  // POST /api/v1/search-scan {domain} — request an on-demand scan.
  // Order: registered-domain check → already-listed → already-queued → rate limits → insert → dispatch.
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
    const normalized = normalizeDomain(payload.domain);
    if (!normalized) {
      return c.json({ error: 'invalid_domain', message: 'expected a bare domain like example.com' }, 400);
    }
    // Same rule as the submit endpoint: one listing per registered domain.
    const domain = registrableDomain(normalized);
    if (!domain) {
      return c.json(
        {
          error: 'subdomain_not_allowed',
          message: 'only registered domains are accepted (example.com), not subdomains',
        },
        400,
      );
    }

    // Human check (Turnstile) — an on-demand scan is the most expensive
    // public action, so it is gated before any quota is consumed.
    const turnstile = await requireTurnstile(c, {
      action: TURNSTILE_ACTIONS.searchScan,
      payload,
      fetchImpl: overrides.turnstileFetch,
      db: dbOf(c, overrides),
    });
    if (!turnstile.ok) {
      return c.json({ error: 'turnstile_failed', reason: turnstile.reason }, 400);
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
    const dispatch = await scheduleScanDispatch(
      c,
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

  // POST /api/v1/_internal/sync — run one page of the D1 sync immediately.
  // Called by the site-rebuild workflow right after it publishes new static
  // data, so the static build and D1 always carry the same snapshot set
  // (the 04:30 UTC cron remains as a fallback). Body: { date?, offset?, limit? }
  // — one invocation may only fetch ~44 snapshots (free-plan subrequest cap),
  // so the caller pages with {offset} until nextOffset is null.
  app.post('/api/v1/_internal/sync', async (c) => {
    const token = c.env?.QUEUE_TOKEN;
    if (!token || c.req.header('x-queue-token') !== token) {
      return c.json({ error: 'unauthorized' }, 401);
    }
    let body: { date?: string; offset?: number; limit?: number } = {};
    try {
      const parsed = await c.req.json<{ date?: string; offset?: number; limit?: number }>();
      if (parsed && typeof parsed === 'object') body = parsed;
    } catch {
      // no/invalid body → defaults (latest date, first page)
    }
    if (body.date !== undefined && !/^\d{4}\/\d{2}\/\d{2}$/.test(body.date)) {
      return c.json({ error: 'invalid_date', message: 'date must be YYYY/MM/DD' }, 400);
    }
    try {
      const result = await runDailySync(
        {
          db: createD1Db(c.env.DB),
          fetchImpl: githubAuthedFetch(c.env.GITHUB_DISPATCH_TOKEN, fetch),
        },
        { date: body.date, offset: body.offset, limit: body.limit },
      );
      if (!result) return c.json({ ok: true, date: null, nextOffset: null, note: 'no_snapshot_date' });
      // Owner notifications run after a successful sync: the sync may have
      // moved the grade of a site and the owner wants to know. The event is
      // recorded here (cheap, local); the mail itself is delivered off the
      // request path so a rebuild's paging calls stay fast.
      const db = dbOf(c, overrides);
      await enqueueOwnerNotifications(db, c.env);
      scheduleOwnerNotificationDrain(c, db, c.env, overrides.fetchImpl ?? fetch);
      return c.json({
        ok: true,
        date: result.date,
        listed: result.listed,
        skipped: result.skipped,
        sites: result.sitesUpserted,
        scans: result.scansUpserted,
        evidenceWrites: result.evidenceRows,
        nextOffset: result.nextOffset,
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
    await scheduleScanDispatch(c, c.env?.GITHUB_DISPATCH_TOKEN, overrides.fetchImpl ?? fetch);

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

  // -------------------------------------------------------------------------
  // Owner mailbox + score-change notifications
  //
  // Three locks guard the owner mailbox:
  //   1. domain control — the requester publishes a challenge on the domain
  //      itself (DNS TXT / well-known file / homepage meta) and the platform
  //      has to observe it there,
  //   2. mailbox control — the owner confirms the magic link sent to the
  //      mailbox,
  //   3. the management token handed out by that confirmation, which every
  //      later read/toggle of the mailbox must present.
  // Without them anybody could take over a stranger's mailbox (and use AFR
  // as a spam relay), read other owners' addresses or mute their mails.
  // -------------------------------------------------------------------------

  // POST /api/v1/owners/email/start {domain, email} — issue a domain-control
  // challenge. The requester publishes the challenge on the domain; the
  // registration endpoint only accepts the mailbox once the platform sees
  // the challenge there. The challenge is bound to the mailbox, so it cannot
  // be used later to register a different address.
  app.post('/api/v1/owners/email/start', async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'invalid_json' }, 400);
    }
    const payload = (body ?? {}) as { domain?: unknown; email?: unknown };
    if (typeof payload.domain !== 'string') {
      return c.json({ error: 'invalid_domain', message: 'domain must be a string' }, 400);
    }
    const normalized = normalizeDomain(payload.domain);
    if (!normalized) {
      return c.json({ error: 'invalid_domain', message: 'expected a bare domain like example.com' }, 400);
    }
    const email = normalizeEmail(payload.email);
    if (!email) {
      return c.json({ error: 'invalid_email', message: 'expected an email address like owner@example.com' }, 400);
    }

    // Human check (Turnstile). It runs before every read of the directory
    // and before the challenge is minted, so a request without a valid
    // human-verification token neither stores a challenge nor burns the
    // domain/IP budget. A machine client (AI agent, script) presents an
    // API key instead — requireTurnstile() honours that exemption.
    const turnstile = await requireTurnstile(c, {
      action: TURNSTILE_ACTIONS.ownerEmail,
      payload,
      fetchImpl: overrides.turnstileFetch,
      db: dbOf(c, overrides),
    });
    if (!turnstile.ok) {
      return c.json({ error: 'turnstile_failed', reason: turnstile.reason }, 400);
    }

    const db = dbOf(c, overrides);
    // Owners often type the www form; the directory stores the registered
    // domain, so fall back to it before answering "unknown domain".
    const registrable = directoryDomain(normalized);
    const site = await db
      .prepare('SELECT domain FROM sites WHERE domain = ?')
      .get<{ domain: string }>(registrable);
    // Only a domain AFR lists can be claimed — otherwise anybody could mint
    // challenges for domains AFR has never seen.
    if (!site) return c.json({ error: 'unknown_domain' }, 404);
    const domain = site.domain;

    // The challenge row stores the mailbox encrypted (it is bound to the
    // challenge), so the encryption secret is required already here.
    const secret = c.env?.EMAIL_ENC_KEY;
    if (!secret) return c.json({ error: 'email_not_configured' }, 503);

    // Limits: 3 challenges per domain per day + 5 per IP per hour. The
    // challenge tier is its own bucket, independent of the registration
    // tier — publishing a challenge and registering the mailbox are two
    // steps and must not share one budget.
    const limits = emailLimitsOf(c, overrides);
    const tiers: [string, RateLimiter][] = [
      [domain, limits.startDomain ?? limits.dailyDomain],
      [clientIp(c), limits.startIp ?? limits.hourlyIp],
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

    const challenge = buildMailChallenge();
    const { cipher, hash } = await encryptEmail(email, secret);
    const now = new Date();
    const expiresAt = new Date(now.getTime() + EMAIL_CHALLENGE_TTL_MS).toISOString();
    await db
      .prepare(
        `INSERT INTO email_challenges
           (domain, challenge_hash, email_cipher, email_hash, expires_at, used_at, created_at)
         VALUES (?, ?, ?, ?, ?, NULL, ?)`,
      )
      .run(domain, await hashToken(challenge), cipher, hash, expiresAt, now.toISOString());

    // The quota is spent only by a stored challenge: a rejected request (or a
    // failed insert) must not burn the budget of the domain or the IP.
    for (const [key, limiter] of tiers) await limiter.consume(key);

    return c.json({
      challenge,
      methods: {
        dns: { type: 'TXT', name: domain, value: `afr-mail=${challenge}` },
        file: { url: `https://${domain}/.well-known/afr-mail.txt`, content: challenge },
        meta: { name: 'afr-mail-verification', content: challenge },
      },
      expiresAt,
    });
  });

  // POST /api/v1/owners/email {domain, email, challenge} — register the
  // contact mailbox of a site owner. The address is stored encrypted
  // (AES-256-GCM); the challenge proves that the requester controls the
  // domain, the magic link proves that the requester controls the mailbox.
  //
  // Order matters: validation → configuration → challenge → domain proof →
  // existing mailbox → rate limit → write. Every check that can fail runs
  // before the limiter is consumed, so a rejected request never burns the
  // domain or IP budget.
  app.post('/api/v1/owners/email', async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'invalid_json' }, 400);
    }
    const payload = (body ?? {}) as { domain?: unknown; email?: unknown; challenge?: unknown };
    if (typeof payload.domain !== 'string') {
      return c.json({ error: 'invalid_domain', message: 'domain must be a string' }, 400);
    }
    const domain = normalizeDomain(payload.domain);
    if (!domain) {
      return c.json({ error: 'invalid_domain', message: 'expected a bare domain like example.com' }, 400);
    }
    const email = normalizeEmail(payload.email);
    if (!email) {
      return c.json({ error: 'invalid_email', message: 'expected an email address like owner@example.com' }, 400);
    }
    if (typeof payload.challenge !== 'string' || !payload.challenge.trim()) {
      return c.json({ error: 'invalid_challenge', message: 'challenge is required' }, 400);
    }
    const challenge = payload.challenge.trim();
    // The challenge was issued for the directory key of the domain — the
    // lookup below uses the very same value.
    const canonical = directoryDomain(domain);

    // Human check (Turnstile) — same gate as the challenge endpoint, same
    // API-key exemption for machine clients. It runs before the challenge
    // is looked up and before the domain is probed, so a request without a
    // valid token neither reads the challenge store nor sends a probe and
    // never reaches the rate limiter.
    const turnstile = await requireTurnstile(c, {
      action: TURNSTILE_ACTIONS.ownerEmail,
      payload,
      fetchImpl: overrides.turnstileFetch,
      db: dbOf(c, overrides),
    });
    if (!turnstile.ok) {
      return c.json({ error: 'turnstile_failed', reason: turnstile.reason }, 400);
    }

    const db = dbOf(c, overrides);
    // Without the encryption secret the mailbox cannot be stored at all.
    const secret = c.env?.EMAIL_ENC_KEY;
    if (!secret) return c.json({ error: 'email_not_configured' }, 503);

    const now = new Date();
    // The challenge must exist for this domain, be unused and still valid.
    const pending = await db
      .prepare(
        `SELECT id, email_hash FROM email_challenges
         WHERE domain = ? AND challenge_hash = ? AND used_at IS NULL AND expires_at > ?
         ORDER BY id DESC LIMIT 1`,
      )
      .get<{ id: number; email_hash: string }>(
        canonical,
        await hashToken(challenge),
        now.toISOString(),
      );
    if (!pending) return c.json({ error: 'challenge_not_found' }, 403);

    // The challenge is bound to one mailbox: a challenge issued for another
    // address cannot be spent on this one.
    if ((await emailHash(email, secret)) !== pending.email_hash) {
      return c.json({ error: 'challenge_email_mismatch' }, 403);
    }

    // The proof of domain control: the platform has to observe the challenge
    // on the domain itself. A network error counts as "not observed" — the
    // requester simply publishes the challenge and tries again.
    const checks = await probeMailChallengeAll(canonical, challenge, overrides.fetchImpl ?? fetch);
    const passed = checks.find((check) => check.ok);
    if (!passed) {
      return c.json(
        {
          error: 'domain_control_failed',
          checks: checks.map((check) => ({ method: check.method, detail: check.detail })),
        },
        403,
      );
    }

    // A confirmed mailbox is never overwritten by a stranger: the confirmed
    // address owns the management token, and replacing it would hand the
    // notification channel to whoever published a challenge last.
    //
    // The holder of that token may re-confirm the mailbox (the "re-confirm"
    // path): the write below resets the mailbox to the unconfirmed state,
    // voids the old token and mails a fresh confirmation link. The token is
    // compared by hash — only the hash is stored.
    const existing = await db
      .prepare('SELECT verified_at, manage_token_hash FROM owner_emails WHERE domain = ?')
      .get<{ verified_at: string | null; manage_token_hash: string | null }>(canonical);
    if (existing?.verified_at) {
      const token = bearerToken(c);
      const ownsMailbox = Boolean(
        token &&
          existing.manage_token_hash &&
          existing.manage_token_hash === (await hashToken(token)),
      );
      if (!ownsMailbox) {
        return c.json({ error: 'mailbox_already_verified' }, 409);
      }
    }

    // 3 registrations per domain per day + 5 per IP per hour (a bucket of its
    // own, independent of the challenge tier). Both tiers are pre-checked
    // before either is consumed, so a rejected request never burns the other
    // tier's budget.
    const limits = emailLimitsOf(c, overrides);
    const tiers: [string, RateLimiter][] = [
      [canonical, limits.dailyDomain],
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

    // Fresh token per registration: a new address must be confirmed again.
    const token = buildMagicToken();
    const expiresAt = new Date(now.getTime() + EMAIL_VERIFY_TTL_MS).toISOString();
    const { cipher, hash } = await encryptEmail(email, secret);

    // The challenge is single-use: it is consumed together with the mailbox
    // write, so it cannot be replayed for a second registration.
    await db
      .prepare('UPDATE email_challenges SET used_at = ? WHERE id = ?')
      .run(now.toISOString(), pending.id);
    await db
      .prepare(
        `INSERT INTO owner_emails
           (domain, email_cipher, email_hash, verified_at, verify_token_hash, verify_expires_at, manage_token_hash, notify, created_at, updated_at)
         VALUES (?, ?, ?, NULL, ?, ?, NULL, 1, ?, ?)
         ON CONFLICT(domain) DO UPDATE SET
           email_cipher = excluded.email_cipher,
           email_hash = excluded.email_hash,
           verified_at = NULL,
           verify_token_hash = excluded.verify_token_hash,
           verify_expires_at = excluded.verify_expires_at,
           manage_token_hash = NULL,
           updated_at = excluded.updated_at`,
      )
      .run(
        canonical,
        cipher,
        hash,
        await hashToken(token),
        expiresAt,
        now.toISOString(),
        now.toISOString(),
      );

    for (const [key, limiter] of tiers) await limiter.consume(key);

    // The magic link is the second lock: only the holder of the mailbox can
    // confirm it and receive the management token.
    const verifyUrl = magicLinkUrl(baseUrlOf(c), token);
    const resendKey = c.env?.RESEND_API_KEY;
    if (!resendKey) {
      // Without a mail provider the mailbox is still stored — the link is
      // handed back to the caller so the flow can still be completed (same
      // convention as the domain-verification token).
      return c.json({ status: 'stored', emailed: false, verifyUrl });
    }

    const mail = renderVerificationEmail({ domain: canonical, verifyUrl });
    const sent = await sendEmailViaResend(
      {
        apiKey: resendKey,
        from: fromOf(c),
        to: email,
        subject: mail.subject,
        text: mail.text,
        html: mail.html,
        // The token is part of the key: a retried registration mails a new
        // link, the same registration never mails twice.
        idempotencyKey: `email-verify:${canonical}:${token}`,
      },
      overrides.fetchImpl ?? fetch,
    );
    if (!sent.ok) {
      // The mailbox is stored; the confirmation mail did not go out. The error
      // is redacted by sendEmailViaResend (no key, no full address).
      console.warn(`owner email: confirmation mail failed (${sent.error ?? 'unknown error'})`);
      return c.json({ status: 'stored', emailed: false, verifyUrl });
    }
    return c.json({ status: 'sent', emailed: true });
  });

  // POST /api/v1/owners/email/change {domain, email} — replace the mailbox
  // of an already confirmed domain.
  //
  // The lock here is the management token of the confirmed mailbox: it proves
  // that the requester is the owner who confirmed the current address. The
  // domain-control challenge is not needed again — the domain was proven
  // when the mailbox was registered — but the new address has to prove
  // mailbox control once more, through the confirmation mail.
  //
  // What the change does to the old address:
  //   - its management token dies immediately (manage_token_hash = NULL), so
  //     nobody can read or toggle the mailbox with it any more,
  //   - the mailbox goes back to the unconfirmed state (verified_at = NULL),
  //     and the score-change notifications stop for it: both the enqueue and
  //     the drain require a confirmed mailbox, so the old address receives
  //     nothing from now on,
  //   - the notification preference (notify) is kept, so the new address
  //     starts with the same setting once it is confirmed.
  //
  // Order matters: validation → configuration → human check → lock →
  // same address → rate limit → write. Every check that can fail runs
  // before the limiter is consumed, so a refused request never burns the
  // domain or IP budget.
  app.post('/api/v1/owners/email/change', async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'invalid_json' }, 400);
    }
    const payload = (body ?? {}) as { domain?: unknown; email?: unknown };
    if (typeof payload.domain !== 'string') {
      return c.json({ error: 'invalid_domain', message: 'domain must be a string' }, 400);
    }
    const domain = normalizeDomain(payload.domain);
    if (!domain) {
      return c.json({ error: 'invalid_domain', message: 'expected a bare domain like example.com' }, 400);
    }
    const email = normalizeEmail(payload.email);
    if (!email) {
      return c.json({ error: 'invalid_email', message: 'expected an email address like owner@example.com' }, 400);
    }
    // The mailbox row is keyed by the registered domain — the same key the
    // registration used.
    const canonical = directoryDomain(domain);

    // Human check (Turnstile) — the same action and the same API-key
    // exemption as the other owner-mail writes. It runs before the mailbox
    // is read, so an unverified request never touches the token store and
    // never reaches the rate limiter.
    const turnstile = await requireTurnstile(c, {
      action: TURNSTILE_ACTIONS.ownerEmail,
      payload,
      fetchImpl: overrides.turnstileFetch,
      db: dbOf(c, overrides),
    });
    if (!turnstile.ok) {
      return c.json({ error: 'turnstile_failed', reason: turnstile.reason }, 400);
    }

    const db = dbOf(c, overrides);
    // Without the encryption secret the mailbox cannot be stored at all.
    const secret = c.env?.EMAIL_ENC_KEY;
    if (!secret) return c.json({ error: 'email_not_configured' }, 503);

    // The lock: the management token of the confirmed mailbox. A missing
    // token, a wrong token and the token of another domain are
    // indistinguishable from the outside — all of them are 401.
    const current = await managedMailboxWithHash(db, canonical, bearerToken(c));
    if (!current) return c.json({ error: 'unauthorized' }, 401);

    // Replacing the address with itself would burn the old token and the
    // confirmation mail for nothing.
    if (current.email_hash === (await emailHash(email, secret))) {
      return c.json({ error: 'same_email' }, 409);
    }

    // 3 mailbox writes per domain per day + 5 per IP per hour — the same
    // bucket as a registration (a change is a mailbox write). Both tiers
    // are pre-checked before either is consumed, so a refused request never
    // burns the other tier's budget.
    const limits = emailLimitsOf(c, overrides);
    const tiers: [string, RateLimiter][] = [
      [canonical, limits.dailyDomain],
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

    const now = new Date();
    // A fresh confirmation token for the new address; the old management
    // token dies with the write.
    const token = buildMagicToken();
    const expiresAt = new Date(now.getTime() + EMAIL_VERIFY_TTL_MS).toISOString();
    const { cipher, hash } = await encryptEmail(email, secret);

    await db
      .prepare(
        `UPDATE owner_emails
         SET email_cipher = ?, email_hash = ?, verified_at = NULL,
             verify_token_hash = ?, verify_expires_at = ?, manage_token_hash = NULL,
             updated_at = ?
         WHERE domain = ?`,
      )
      .run(cipher, hash, await hashToken(token), expiresAt, now.toISOString(), canonical);

    for (const [key, limiter] of tiers) await limiter.consume(key);

    // The magic link is the second lock again: only the holder of the NEW
    // mailbox can confirm it and receive the new management token.
    const verifyUrl = magicLinkUrl(baseUrlOf(c), token);
    const resendKey = c.env?.RESEND_API_KEY;
    if (!resendKey) {
      // Without a mail provider the mailbox is still stored — the link is
      // handed back to the caller so the flow can still be completed (same
      // convention as the domain-verification token).
      return c.json({ status: 'stored', emailed: false, verifyUrl });
    }

    const mail = renderVerificationEmail({ domain: canonical, verifyUrl });
    const sent = await sendEmailViaResend(
      {
        apiKey: resendKey,
        from: fromOf(c),
        to: email,
        subject: mail.subject,
        text: mail.text,
        html: mail.html,
        // The token is part of the key: a retried change mails a new link,
        // the same change never mails twice.
        idempotencyKey: `email-verify:${canonical}:${token}`,
      },
      overrides.fetchImpl ?? fetch,
    );
    if (!sent.ok) {
      // The mailbox is stored; the confirmation mail did not go out. The error
      // is redacted by sendEmailViaResend (no key, no full address).
      console.warn(`owner email: change confirmation mail failed (${sent.error ?? 'unknown error'})`);
      return c.json({ status: 'stored', emailed: false, verifyUrl });
    }
    return c.json({ status: 'sent', emailed: true });
  });

  // GET /api/v1/owners/email/verify?token= — consume the magic link.
  // The token is single-use: a successful verification clears the stored
  // hash, so replaying the link fails. The confirmation also hands out the
  // management token, which every later read/toggle of this mailbox needs.
  app.get('/api/v1/owners/email/verify', async (c) => {
    // 20 verifications per IP per hour. The quota is spent on every attempt
    // (like verify/check): a free token-guessing oracle is worth more than
    // the missed quota.
    const limits = emailLimitsOf(c, overrides);
    const decision = await limits.verifyIp.check(clientIp(c));
    if (!decision.allowed) {
      const { retryAfter, nextAllowedAt } = retryPayload(limits.verifyIp);
      return c.json(
        { error: 'rate_limited', retryAfter, nextAllowedAt },
        429,
        { 'Retry-After': String(retryAfter) },
      );
    }
    await limits.verifyIp.consume(clientIp(c));

    const token = c.req.query('token') ?? '';
    if (!token) return c.json({ error: 'invalid_or_expired_token' }, 400);

    const db = dbOf(c, overrides);
    const now = new Date();
    const row = await db
      .prepare(
        `SELECT domain FROM owner_emails
         WHERE verify_token_hash = ? AND verify_expires_at IS NOT NULL AND verify_expires_at > ?
         LIMIT 1`,
      )
      .get<{ domain: string }>(await hashToken(token), now.toISOString());
    if (!row) return c.json({ error: 'invalid_or_expired_token' }, 400);

    // The management token is shown exactly once — only its hash is kept.
    const manageToken = buildManageToken();
    await db
      .prepare(
        `UPDATE owner_emails
         SET verified_at = ?, verify_token_hash = NULL, verify_expires_at = NULL,
             manage_token_hash = ?, updated_at = ?
         WHERE domain = ?`,
      )
      .run(now.toISOString(), await hashToken(manageToken), now.toISOString(), row.domain);
    return c.json({ verified: true, domain: row.domain, manageToken });
  });

  // GET /api/v1/owners/email?domain= — mailbox status of a domain. The
  // address is only ever reported masked: the plaintext never leaves D1.
  // The management token is required — without it nobody learns even the
  // masked address of another owner's mailbox.
  app.get('/api/v1/owners/email', async (c) => {
    const domain = normalizeDomain(c.req.query('domain') ?? '');
    if (!domain) {
      return c.json({ error: 'invalid_domain', message: 'expected a bare domain like example.com' }, 400);
    }
    const db = dbOf(c, overrides);
    const row = await managedMailbox(db, domain, bearerToken(c));
    if (!row) return c.json({ error: 'unauthorized' }, 401);

    const secret = c.env?.EMAIL_ENC_KEY;
    if (!secret) return c.json({ error: 'email_not_configured' }, 503);

    let masked = '***';
    try {
      masked = maskEmail(await decryptEmail(row.email_cipher, secret));
    } catch (err) {
      // A wrong key or a damaged row must not expose anything — report an
      // opaque mask instead.
      console.warn(
        `owner email: cannot decrypt mailbox for ${domain} (${err instanceof Error ? err.message : String(err)})`,
      );
    }
    return c.json({
      domain,
      email_masked: masked,
      verified: Boolean(row.verified_at),
      notify: row.notify !== 0,
    });
  });

  // POST /api/v1/owners/notify {domain, notify} — owner toggles the
  // score-change mails. The management token of the confirmed mailbox is
  // required; the token stays valid across the toggle.
  app.post('/api/v1/owners/notify', async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'invalid_json' }, 400);
    }
    const payload = (body ?? {}) as { domain?: unknown; notify?: unknown };
    if (typeof payload.domain !== 'string') {
      return c.json({ error: 'invalid_domain', message: 'domain must be a string' }, 400);
    }
    const domain = normalizeDomain(payload.domain);
    if (!domain) {
      return c.json({ error: 'invalid_domain', message: 'expected a bare domain like example.com' }, 400);
    }
    if (typeof payload.notify !== 'boolean') {
      return c.json({ error: 'invalid_notify', message: 'notify must be a boolean' }, 400);
    }

    const db = dbOf(c, overrides);
    // Only the holder of the management token of a confirmed mailbox may
    // change the notification flag.
    const row = await managedMailbox(db, domain, bearerToken(c));
    if (!row) return c.json({ error: 'unauthorized' }, 401);

    await db
      .prepare('UPDATE owner_emails SET notify = ?, updated_at = ? WHERE domain = ?')
      .run(payload.notify ? 1 : 0, new Date().toISOString(), domain);
    return c.json({ domain, notify: payload.notify });
  });

  // GET /api/v1/mail/status — which outbound mail channels are configured.
  //
  // Only *whether* a variable is set is reported: no key, no host, no
  // address is echoed back. The endpoint is public (it has to work as a
  // health check), so the answer lists variable names at most.
  app.get('/api/v1/mail/status', async (c) => {
    const env = (c.env ?? {}) as unknown as MailEnv;
    const resendConfigured = Boolean(env.RESEND_API_KEY);
    const smtpProblem = describeSmtpProblem(env);
    const smtpStatus =
      smtpProblem === 'ok'
        ? 'configured'
        : smtpProblem === 'not_configured'
          ? 'missing'
          : 'invalid';

    const missing: string[] = [];
    if (!resendConfigured) missing.push('RESEND_API_KEY');
    if (smtpProblem === 'not_configured') missing.push('SMTP_HOST');
    else if (smtpProblem === 'missing_from') missing.push('SMTP_FROM');
    else if (smtpProblem === 'port_25_blocked') missing.push('SMTP_PORT');

    let quota = {
      day: mailQuotaDay(),
      globalUsed: 0,
      globalLimit: DEFAULT_MAIL_QUOTA_LIMITS.globalDaily,
    };
    try {
      quota = await readMailQuotaStatus(dbOf(c, overrides));
    } catch {
      // An older D1 without the quota tables must not break the endpoint.
    }

    return c.json({
      ok: true,
      channels: {
        resend: resendConfigured ? 'configured' : 'missing',
        smtp: smtpStatus,
        cf_email: cfEmailAvailable(c.env) ? 'available' : 'unavailable',
      },
      quota,
      missing,
    });
  });

  // GET/POST /api/v1/pv?site=<domain> — counts a detail-page view. Always
  // answers 204 (the pixel must never fail visibly); only domains listed in
  // sites are counted, and the daily write budget is enforced inside the upsert — once
  // today's count reaches PV_DAILY_WRITE_CAP the guarded statement matches no
  // row, so a capped view costs zero rows written (a 0-row statement changes
  // nothing — assumed not to be billed as a row write).
  // POST exists for navigator.sendBeacon: the page-side beacon dedups per
  // domain per UTC day in localStorage (T3), so one browser writes at most
  // one row per site per day instead of one per view.
  const pvHandler = async (c: Context) => {
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
  };
  app.on(['GET', 'POST'], '/api/v1/pv', pvHandler);

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
      (async () => {
        const db = createD1Db(env.DB);
        await runDailySync({ db, fetchImpl: githubAuthedFetch(env.GITHUB_DISPATCH_TOKEN, fetch) });
        // Score-change mails for the owners who asked for them (no-op when
        // the mail subsystem is not configured).
        await runOwnerNotifications(db, env, fetch);
        // Housekeeping: expired challenges, read inbox mail, delivered
        // notifications and stale cooldown rows would otherwise pile up and
        // eat the daily row-write budget.
        const pruned = await pruneMailArtifacts(db);
        const removed =
          pruned.challenges + pruned.inboundMail + pruned.inboundActions + pruned.outbox + pruned.cooldown;
        if (removed > 0) {
          console.log(
            `mail gc: ${pruned.challenges} challenges, ${pruned.inboundMail} inbound, ` +
              `${pruned.inboundActions} actions, ${pruned.outbox} notifications, ${pruned.cooldown} cooldowns`,
          );
        }
      })(),
    );
  },
};
