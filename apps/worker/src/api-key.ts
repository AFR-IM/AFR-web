// src/api-key.ts — API keys for machine clients.
//
// A human-verification gate in front of a public POST endpoint is hostile to
// the legitimate caller: an AI agent or a script cannot run a browser widget.
// The `api_keys` table exists for exactly that case — a key proves the caller
// is an authorised machine client, so the gate can step aside.
//
// The key itself never touches the database: only its SHA-256 hash is stored,
// so a database leak does not hand over usable credentials.
//
// Quota has two UTC budgets: daily and monthly. Site keys share both across
// rotations. Keys without a site have their own budgets.
//
// Which budget applies is derived from the *live* Pro entitlement of the
// key's site, not from the tier stored on the key row: a key issued while
// the site had Pro drops back to the free budget as soon as the Pro term
// ends. The stored tier only records what the key was issued with.
//
// The counters live in D1 (`api_key_usage`), not in KV: the free KV plan
// allows 1,000 writes a day, while a Pro key alone may call the API 10,000
// times a day — the counter would have stopped working long before the
// budget did. An allowed call writes two rows (the day counter and the month
// counter). The database checks both limits in the same statement, so rejected
// calls write nothing. Five Pro keys at their full daily budgets can consume
// the free D1 daily write allowance.

import type { Db } from './db.ts';
import { computeProEntitlement } from './entitlements.ts';
import type { KvLike } from './rate-limit.ts';

export { type KvLike };

/** Header carrying the key. Dedicated (rather than `Authorization`) so it
 * cannot collide with the bearer token used by the owner mailbox routes. */
export const API_KEY_HEADER = 'x-afr-agent-key';

/** Daily request budget by effective tier. */
export const API_KEY_QUOTA_LIMITS = { free: 100, pro: 10_000 } as const;

/** Monthly request budget by effective tier, including in 31-day months. */
export const API_KEY_MONTHLY_QUOTA_LIMITS = { free: 3_000, pro: 300_000 } as const;

/** The tiers a key can have. */
export type ApiKeyTier = keyof typeof API_KEY_QUOTA_LIMITS;

/** SHA-256 of the key, hex encoded — the value stored in `api_keys.key_hash`.
 * WebCrypto only: the module is bundled into the Worker, where node:crypto
 * does not exist. */
export async function hashApiKey(key: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(key),
  );
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

/** The stored facts of a key. The plaintext key is never part of it. */
export interface ApiKeyRecord {
  /** SHA-256 of the key, the identifier in api_keys. */
  keyHash: string;
  /** The site the key belongs to (null for a key without an owner). */
  domain: string | null;
  /** The tier the key was issued with. */
  tier: string;
  createdAt: string | null;
  revokedAt: string | null;
  lastUsedAt: string | null;
}

interface ApiKeyRow {
  key_hash: string;
  domain?: string | null;
  tier?: string | null;
  created_at?: string | null;
  revoked_at?: string | null;
  last_used_at?: string | null;
}

/**
 * The live key a client presented, or null.
 *
 * A revoked key and an unknown key are indistinguishable from the outside.
 * A database that does not know the new metadata columns yet (the migration
 * was not applied) still resolves the key itself — the columns are read in a
 * second, tolerant query.
 */
export async function resolveApiKey(db: Db, key: string | null | undefined): Promise<ApiKeyRecord | null> {
  if (!key) return null;
  const trimmed = key.trim();
  if (!trimmed) return null;
  const keyHash = await hashApiKey(trimmed);
  try {
    const row = await db
      .prepare(
        `SELECT key_hash, domain, tier, created_at, revoked_at, last_used_at
         FROM api_keys WHERE key_hash = ? AND revoked_at IS NULL LIMIT 1`,
      )
      .get<ApiKeyRow>(keyHash);
    if (!row) return null;
    return {
      keyHash: row.key_hash,
      domain: row.domain ?? null,
      tier: row.tier ?? 'free',
      createdAt: row.created_at ?? null,
      revokedAt: row.revoked_at ?? null,
      lastUsedAt: row.last_used_at ?? null,
    };
  } catch {
    // The metadata columns are missing (migration not applied yet): fall back
    // to the columns the table has had from the start.
    try {
      const row = await db
        .prepare('SELECT key_hash, tier, created_at, revoked_at FROM api_keys WHERE key_hash = ? AND revoked_at IS NULL LIMIT 1')
        .get<ApiKeyRow>(keyHash);
      if (!row) return null;
      return {
        keyHash: row.key_hash,
        domain: null,
        tier: row.tier ?? 'free',
        createdAt: row.created_at ?? null,
        revokedAt: row.revoked_at ?? null,
        lastUsedAt: null,
      };
    } catch {
      return null;
    }
  }
}

/** Whether the presented key is a live key of this account.
 *
 * A revoked key (`revoked_at` set) and an unknown key are indistinguishable
 * from the outside — both answer false. */
export async function isValidApiKey(db: Db, key: string | null | undefined): Promise<boolean> {
  if (!key) return false;
  const trimmed = key.trim();
  if (!trimmed) return false;
  try {
    const row = await db
      .prepare(
        'SELECT key_hash FROM api_keys WHERE key_hash = ? AND revoked_at IS NULL LIMIT 1',
      )
      .get<{ key_hash: string }>(await hashApiKey(trimmed));
    return Boolean(row);
  } catch {
    // A missing table or a failing read must not open the gate.
    return false;
  }
}

/** The environment the quota check runs in.
 *
 * The counters live in the database, so nothing of the environment is read
 * any more. The type is kept so that existing call sites keep compiling.
 */
export interface ApiKeyQuotaEnv {
  /** @deprecated Unused: the usage counters live in D1, not in KV. */
  KV?: KvLike;
}

/** Which budget was exhausted by a rejected call. */
export type ApiKeyQuotaExhausted = 'daily' | 'monthly';

/** The outcome of one quota check. */
export interface ApiKeyQuotaDecision {
  /** Whether quota permits proceeding. Endpoint authorization is separate. */
  allowed: boolean;
  /** The daily budget of the key's effective tier (0 when no key was presented). */
  limit: number;
  /** Recorded UTC daily usage, including this call if counted. */
  used: number;
  /** The tier the budget was taken from — the *effective* tier, not the tier
   * the key was issued with. */
  tier: ApiKeyTier | null;
  /** Hash of the live key, when one was resolved. */
  keyHash: string | null;
  /** The monthly budget of the key's effective tier (0 when no key was presented). */
  monthLimit: number;
  /** Recorded UTC monthly usage, including this call if counted. */
  monthUsed: number;
  /** Whether both counters were incremented. False on rejection or store failure. */
  counted: boolean;
  /** Domain usage is shared by keys for the same owner; key usage is isolated
   * to one key when it has no owner domain. */
  quotaScope: 'domain' | 'key' | null;
  /** The tier stored on the key row: what the key was issued with. It does not
   * change when the Pro term of the site ends. */
  issuedTier: string | null;
  /** Which budget blocked the call (null when the call was allowed). */
  exhausted: ApiKeyQuotaExhausted | null;
}

/** The two usage periods one call belongs to. */
export interface ApiKeyUsagePeriods {
  /** The UTC day bucket: 'd:YYYY-MM-DD'. */
  day: string;
  /** The UTC month bucket: 'm:YYYY-MM'. */
  month: string;
}

/** The UTC day and month buckets a call belongs to. */
export function apiKeyUsagePeriods(now: number | string = Date.now()): ApiKeyUsagePeriods {
  const millis = typeof now === 'number' ? now : Date.parse(now);
  const iso = new Date(Number.isFinite(millis) ? millis : Date.now()).toISOString();
  return { day: `d:${iso.slice(0, 10)}`, month: `m:${iso.slice(0, 7)}` };
}

/**
 * The tier a key is entitled to *right now*.
 *
 * The tier stored on the key row is what the key was issued with; the budget
 * follows the live Pro entitlement of the key's site instead. A key issued
 * while the site had Pro therefore drops back to the free budget the moment
 * the Pro term ends or is revoked, and a key of a site that gains Pro gets
 * the Pro budget without being re-issued.
 *
 * A missing entitlement table (the migration was not applied) or a failing
 * read yields the free budget: the budget is a fairness mechanism and
 * failing open keeps the API usable.
 */
export async function effectiveApiKeyTier(db: Db, record: ApiKeyRecord,
  now: number | string = Date.now()): Promise<ApiKeyTier> {
  const subject = ownerDomain(record.domain);
  if (!subject) return 'free';
  try {
    const state = await computeProEntitlement(db, subject, now);
    return state.active ? 'pro' : 'free';
  } catch {
    return 'free';
  }
}

interface UsageRow {
  period: string;
  used: number;
}

function ownerDomain(domain: string | null): string {
  return (domain ?? '').trim().toLowerCase();
}

function domainQuotaBucket(domain: string): string {
  return `domain:${domain}`;
}

/** UTC usage shared by current and previous keys of this domain. Null means
 * the counters are unavailable. Read-only, including when the key rotates. */
export async function readDomainApiKeyUsage(db: Db, domain: string,
  now: number | string = Date.now()): Promise<{ day: number; month: number } | null> {
  return readUsage(db, domainQuotaBucket(ownerDomain(domain)), apiKeyUsagePeriods(now));
}

/** Read the counters for one period pair, returning null on store failure. */
async function readUsage(db: Db, bucketKey: string, periods: ApiKeyUsagePeriods): Promise<{ day: number; month: number } | null> {
  let rows: UsageRow[];
  try {
    rows = await db
      .prepare('SELECT period, used FROM api_key_usage WHERE key_hash = ? AND period IN (?, ?)')
      .all<UsageRow>(bucketKey, periods.day, periods.month);
  } catch {
    return null;
  }
  let day = 0;
  let month = 0;
  for (const row of rows) {
    const used = Number(row.used);
    const count = Number.isFinite(used) && used > 0 ? used : 0;
    if (row.period === periods.day) day = count;
    else if (row.period === periods.month) month = count;
  }
  return { day, month };
}

/**
 * Atomically check and increment both counters. The materialized snapshot
 * ensures both period rows are inserted together or neither is inserted.
 */
const COUNT_USAGE_SQL = `
  WITH current_usage AS MATERIALIZED (
    SELECT
      COALESCE((SELECT used FROM api_key_usage WHERE key_hash = ? AND period = ?), 0) AS day_used,
      COALESCE((SELECT used FROM api_key_usage WHERE key_hash = ? AND period = ?), 0) AS month_used
  ),
  periods(period) AS MATERIALIZED (VALUES (?), (?))
  INSERT INTO api_key_usage (key_hash, period, used, updated_at)
  SELECT ?, period, 1, ? FROM current_usage CROSS JOIN periods
  WHERE current_usage.day_used < ? AND current_usage.month_used < ?
  ON CONFLICT(key_hash, period) DO UPDATE
    SET used = api_key_usage.used + 1, updated_at = excluded.updated_at
  RETURNING period, used
`;

/**
 * Count a call only when both the day and month budgets have room. Domain
 * keys share one bucket across rotations; keys without an owner stay per-hash.
 * A rejected call writes zero rows, and the SQL snapshot makes the boundary
 * safe under concurrent requests.
 */
export async function enforceApiKeyQuota(db: Db, env: ApiKeyQuotaEnv | undefined,
  key: string | null | undefined, now: number | string = Date.now()): Promise<ApiKeyQuotaDecision> {
  void env;
  const record = await resolveApiKey(db, key);
  if (!record) {
    return {
      allowed: true,
      limit: 0,
      used: 0,
      tier: null,
      keyHash: null,
      monthLimit: 0,
      monthUsed: 0,
      counted: false,
      quotaScope: null,
      issuedTier: null,
      exhausted: null,
    };
  }

  const tier = await effectiveApiKeyTier(db, record, now);
  const limit = API_KEY_QUOTA_LIMITS[tier];
  const monthLimit = API_KEY_MONTHLY_QUOTA_LIMITS[tier];
  const periods = apiKeyUsagePeriods(now);
  const domain = ownerDomain(record.domain);
  const bucketKey = domain ? domainQuotaBucket(domain) : record.keyHash;
  const millis = typeof now === 'number' ? now : Date.parse(now);
  const stamp = new Date(Number.isFinite(millis) ? millis : Date.now()).toISOString();
  const base = {
    tier,
    limit,
    keyHash: record.keyHash,
    monthLimit,
    quotaScope: domain ? 'domain' : 'key',
    issuedTier: record.tier,
  } as const;

  let countedRows: UsageRow[];
  try {
    countedRows = await db.prepare(COUNT_USAGE_SQL).all<UsageRow>(
      bucketKey, periods.day, bucketKey, periods.month,
      periods.day, periods.month,
      bucketKey, stamp,
      limit, monthLimit,
    );
  } catch {
    return { ...base, allowed: true, used: 0, monthUsed: 0, counted: false, exhausted: null };
  }

  if (countedRows.length === 2) {
    let used = 0;
    let monthUsed = 0;
    for (const row of countedRows) {
      if (row.period === periods.day) used = Number(row.used);
      else if (row.period === periods.month) monthUsed = Number(row.used);
    }
    return { ...base, allowed: true, used, monthUsed, counted: true, exhausted: null };
  }

  const usage = await readUsage(db, bucketKey, periods);
  if (!usage) {
    return { ...base, allowed: true, used: 0, monthUsed: 0, counted: false, exhausted: null };
  }
  const dailyExceeded = usage.day >= limit;
  if (!dailyExceeded && usage.month < monthLimit) {
    return { ...base, allowed: true, used: usage.day, monthUsed: usage.month, counted: false, exhausted: null };
  }
  return {
    ...base,
    allowed: false,
    used: usage.day,
    monthUsed: usage.month,
    counted: false,
    exhausted: dailyExceeded ? 'daily' : 'monthly',
  };
}

/** Record approximate key activity with at most one write per 15 minutes. */
export async function touchApiKeyUsage(db: Db, keyHash: string, now: number | string = Date.now()): Promise<void> {
  const parsed = typeof now === 'number' ? now : Date.parse(now);
  const millis = Number.isFinite(parsed) ? parsed : Date.now();
  const stamp = new Date(millis).toISOString();
  const cutoff = new Date(millis - 15 * 60_000).toISOString();
  try {
    await db.prepare(`UPDATE api_keys SET last_used_at = ?
      WHERE key_hash = ? AND revoked_at IS NULL
        AND (last_used_at IS NULL OR last_used_at <= ?)`)
      .run(stamp, keyHash, cutoff);
  } catch {
    // The metadata column is optional: a missing one must not fail the call.
  }
}
