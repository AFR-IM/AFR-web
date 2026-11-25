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
// Every key also carries a daily quota (方案书 §11.4): a free key may call
// the API 100 times a day, a Pro key 10 000 times. The counter lives in the
// Worker's KV namespace (one key per key-hash per UTC day) so that many
// isolates share one budget.

import type { Db } from './db.ts';
import type { KvLike } from './rate-limit.ts';

export { type KvLike };

/** Header carrying the key. Dedicated (rather than `Authorization`) so it
 * cannot collide with the bearer token used by the owner mailbox routes. */
export const API_KEY_HEADER = 'x-afr-agent-key';

/** Daily request budget per key, by tier. */
export const API_KEY_QUOTA_LIMITS = { free: 100, pro: 10_000 } as const;

/** The tiers a key can have. */
export type ApiKeyTier = keyof typeof API_KEY_QUOTA_LIMITS;

/** How long a daily counter is kept (seconds). Two days: the counter of
 * yesterday must still be readable a little after midnight. */
export const API_KEY_QUOTA_TTL_SECONDS = 2 * 24 * 60 * 60;

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
  /** SHA-256 of the key — the identifier in the database and in the quota key. */
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

/** The environment the quota counter needs (the KV namespace). */
export interface ApiKeyQuotaEnv {
  /** The KV namespace holding the daily counters. Missing → no counter. */
  KV?: KvLike;
}

/** The outcome of one quota check. */
export interface ApiKeyQuotaDecision {
  /** Whether the request may proceed. */
  allowed: boolean;
  /** The daily budget of the key's tier (0 when no key was presented). */
  limit: number;
  /** The number of counted calls today, including this one. */
  used: number;
  /** The tier the budget was taken from. */
  tier: ApiKeyTier | null;
  /** The hash of the counted key. */
  keyHash: string | null;
}

/** The KV key of one key's counter of one UTC day. */
export function apiKeyQuotaKey(keyHash: string, now: number | string = Date.now()): string {
  const day = new Date(typeof now === 'number' ? now : Date.parse(now)).toISOString().slice(0, 10);
  return `afr-apikey-quota:${keyHash}:${day}`;
}

/**
 * Count one call of a presented key against its daily budget.
 *
 * The counter is a KV read-modify-write: it can lose a call in a rare race
 * between two isolates, which is acceptable for a usage budget (it is not a
 * security boundary). Without a KV namespace nothing is counted and the
 * request is allowed — the budget is a fairness mechanism, not an access
 * control.
 *
 * An unknown or revoked key is not counted: the endpoint's own authorisation
 * decides about it, the quota never opens a door.
 */
export async function enforceApiKeyQuota(db: Db, env: ApiKeyQuotaEnv | undefined,
  key: string | null | undefined, now: number | string = Date.now()): Promise<ApiKeyQuotaDecision> {
  const record = await resolveApiKey(db, key);
  if (!record) return { allowed: true, limit: 0, used: 0, tier: null, keyHash: null };
  const tier: ApiKeyTier = record.tier === 'pro' ? 'pro' : 'free';
  const limit = API_KEY_QUOTA_LIMITS[tier];
  const kv = env?.KV;
  if (!kv) return { allowed: true, limit, used: 0, tier, keyHash: record.keyHash };
  const counterKey = apiKeyQuotaKey(record.keyHash, now);
  const raw = await kv.get(counterKey);
  const used = raw ? Number.parseInt(raw, 10) || 0 : 0;
  const next = used + 1;
  await kv.put(counterKey, String(next), { expirationTtl: API_KEY_QUOTA_TTL_SECONDS });
  return { allowed: next <= limit, limit, used: next, tier, keyHash: record.keyHash };
}

/** Remember that a key was used (the status page shows the last call). */
export async function touchApiKeyUsage(db: Db, keyHash: string, now: number | string = Date.now()): Promise<void> {
  const stamp = new Date(typeof now === 'number' ? now : Date.parse(now)).toISOString();
  try {
    await db.prepare('UPDATE api_keys SET last_used_at = ? WHERE key_hash = ?').run(stamp, keyHash);
  } catch {
    // The metadata column is optional: a missing one must not fail the call.
  }
}
