// src/mail-quota.ts — outbound mail quota (D1 counters).
//
// Why this file exists: every endpoint that can trigger an outbound mail is
// reachable by anyone on the internet, so the sender needs a hard bound.
// Three tiers are checked, in this order:
//   1. the global daily budget — protects the provider quota (and the money
//      behind it) from a flood of requests across all domains,
//   2. the per-domain daily budget — one noisy site owner must not be able
//      to consume the whole global budget,
//   3. a per-recipient cooldown — one mailbox must not be spammed.
//
// Counting uses a natural-day key (the UTC date), so no reset job is needed:
// a new day simply starts a new row and the old one becomes history.
//
// Privacy: a mailbox address is personal data. Only its SHA-256 hash is
// stored, which is enough to recognise a repeat recipient and useless for
// reading the address back.

import type { Db, Row } from './db.ts';

/** Why a mail was not sent. */
export type QuotaReason = 'per_domain_daily' | 'global_daily' | 'recipient_cooldown';

/** Outcome of a quota check. */
export interface QuotaDecision {
  allowed: boolean;
  reason?: QuotaReason;
  /** Seconds until the mail may be tried again (hint for a 429). */
  retryAfterSeconds?: number;
}

/** Limits of the outbound mail budget. */
export interface MailQuotaLimits {
  /** Mails per domain per UTC day. */
  perDomainDaily: number;
  /** Mails per UTC day across all domains. */
  globalDaily: number;
  /** Minimum distance between two mails to the same recipient. */
  recipientCooldownMs: number;
}

/** Defaults: half of a typical provider free tier (100/day) is left as
 * headroom, and one mailbox is contacted at most every 10 minutes. */
export const DEFAULT_MAIL_QUOTA_LIMITS: MailQuotaLimits = {
  perDomainDaily: 3,
  globalDaily: 50,
  recipientCooldownMs: 10 * 60 * 1000,
};

/** Scope of a counter row. */
const SCOPE_GLOBAL = 'global';
/** Scope of a counter row. */
const SCOPE_DOMAIN = 'domain';
/** Key of the global counter row. */
const KEY_ALL = 'all';

const textEncoder = new TextEncoder();
const webCrypto: Crypto = (globalThis as unknown as { crypto: Crypto }).crypto;

/** UTC date (YYYY-MM-DD) of a moment — the natural-day key of the counters. */
export function mailQuotaDay(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/** Normalize a domain into a counter key (lower case, no scheme, no path). */
export function normalizeQuotaDomain(value: string): string {
  return (value ?? '')
    .trim()
    .toLowerCase()
    .replace(/^[a-z]+:\/\//, '')
    .split('/')[0] ?? '';
}

/** Normalize a recipient address for hashing (case insensitive domain part). */
export function normalizeQuotaRecipient(value: string): string {
  return (value ?? '').trim().toLowerCase();
}

/** Hex SHA-256 of a string — the recipient is never stored in plaintext. */
export async function hashRecipient(recipient: string): Promise<string> {
  const digest = await webCrypto.subtle.digest('SHA-256', textEncoder.encode(recipient));
  const bytes = new Uint8Array(digest);
  let out = '';
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0');
  return out;
}

/** Seconds until the next UTC midnight (hint for a daily limit). */
function secondsUntilNextDay(now: Date): number {
  const next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
  return Math.max(1, Math.ceil((next - now.getTime()) / 1000));
}

interface CountRow extends Row {
  count: number;
}

interface CooldownRow extends Row {
  last_sent_at: string;
}

/** Read one counter row. */
async function readCounter(
  db: Db,
  day: string,
  scope: string,
  key: string,
): Promise<number> {
  const row = await db
    .prepare('SELECT count FROM mail_quota WHERE day = ? AND scope = ? AND key = ?')
    .get<CountRow>(day, scope, key);
  return Number(row?.count ?? 0);
}

/** Atomically increment one counter row.
 *
 * The upsert is the only write path, so a concurrent request cannot lose a
 * count (both read-modify-write cycles would overwrite each other). */
async function bumpCounter(
  db: Db,
  day: string,
  scope: string,
  key: string,
  now: Date,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO mail_quota (day, scope, key, count, updated_at)
       VALUES (?, ?, ?, 1, ?)
       ON CONFLICT(day, scope, key) DO UPDATE SET count = count + 1, updated_at = excluded.updated_at`,
    )
    .run(day, scope, key, now.toISOString());
}

/** Check the quota and — only when every tier passes — consume one mail.
 *
 * A rejected request never consumes quota: the counters are read first and
 * written last, so a caller that is blocked by the cooldown does not burn the
 * daily budget of its domain. */
export async function consumeMailQuota(
  db: Db,
  args: {
    domain: string;
    recipient: string;
    now?: () => Date;
    limits?: Partial<MailQuotaLimits>;
  },
): Promise<QuotaDecision> {
  const now = args.now?.() ?? new Date();
  const limits: MailQuotaLimits = { ...DEFAULT_MAIL_QUOTA_LIMITS, ...(args.limits ?? {}) };
  const day = mailQuotaDay(now);
  const domain = normalizeQuotaDomain(args.domain);
  const recipientHash = await hashRecipient(normalizeQuotaRecipient(args.recipient));

  // 1. Global daily budget.
  const globalUsed = await readCounter(db, day, SCOPE_GLOBAL, KEY_ALL);
  if (globalUsed >= limits.globalDaily) {
    return { allowed: false, reason: 'global_daily', retryAfterSeconds: secondsUntilNextDay(now) };
  }

  // 2. Per-domain daily budget.
  const domainUsed = await readCounter(db, day, SCOPE_DOMAIN, domain);
  if (domainUsed >= limits.perDomainDaily) {
    return {
      allowed: false,
      reason: 'per_domain_daily',
      retryAfterSeconds: secondsUntilNextDay(now),
    };
  }

  // 3. Per-recipient cooldown.
  const cooldown = await db
    .prepare('SELECT last_sent_at FROM mail_cooldown WHERE recipient_hash = ?')
    .get<CooldownRow>(recipientHash);
  if (cooldown?.last_sent_at) {
    const lastMs = Date.parse(cooldown.last_sent_at);
    if (Number.isFinite(lastMs)) {
      const elapsed = now.getTime() - lastMs;
      if (elapsed >= 0 && elapsed < limits.recipientCooldownMs) {
        return {
          allowed: false,
          reason: 'recipient_cooldown',
          retryAfterSeconds: Math.max(
            1,
            Math.ceil((limits.recipientCooldownMs - elapsed) / 1000),
          ),
        };
      }
    }
  }

  // Every tier passed — count the mail.
  await bumpCounter(db, day, SCOPE_GLOBAL, KEY_ALL, now);
  await bumpCounter(db, day, SCOPE_DOMAIN, domain, now);
  await db
    .prepare(
      `INSERT INTO mail_cooldown (recipient_hash, last_sent_at)
       VALUES (?, ?)
       ON CONFLICT(recipient_hash) DO UPDATE SET last_sent_at = excluded.last_sent_at`,
    )
    .run(recipientHash, now.toISOString());

  return { allowed: true };
}

/** Current usage of the global daily budget. */
export async function readMailQuotaStatus(
  db: Db,
  now: () => Date = () => new Date(),
  limits?: Partial<MailQuotaLimits>,
): Promise<{ day: string; globalUsed: number; globalLimit: number }> {
  const moment = now();
  const day = mailQuotaDay(moment);
  const globalLimit = limits?.globalDaily ?? DEFAULT_MAIL_QUOTA_LIMITS.globalDaily;
  const globalUsed = await readCounter(db, day, SCOPE_GLOBAL, KEY_ALL);
  return { day, globalUsed, globalLimit };
}
