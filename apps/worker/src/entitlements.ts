// src/entitlements.ts — Pro subscription term, renewal and explicit revocation.
//
// Source of truth: the append-only `pro_entitlement_events` table. There is no
// mutable "current entitlement" row: the state of a subject is *derived* by
// replaying its events in id order, so every state change stays auditable and
// the history can always be re-explained.
//
// Granting rule (deliberately narrow, unchanged): the only way to write a
// `grant`/`renew` event is a *confirmed* Pro order in the local AIPAY ledger
// (`billing_orders`). Webhooks and the reconcile cron never grant Pro, and the
// subject is always derived from the order row — never from a caller.
//
// Revocation rule: only an explicit revoke event ends a term. A ledger
// rollback, a subject reassignment or a deleted order does NOT take Pro back —
// the paid term is a fact of the event log, not of the mutable ledger.
//
// The legacy `pro_entitlements` table is kept for schema stability but is NO
// LONGER WRITTEN and is NOT a source of truth (it cannot express a term, a
// renewal or a revocation). Production holds no rows in it.

import type { Db } from './db.ts';

/** Default length of one paid Pro term, in days.
 *
 * The product sells one term per order: $12 buys 30 days of Pro. The length
 * of a term is a property of the *order* (`billing_orders.term_days`), so a
 * future price change can sell a different term without touching this
 * fallback. This constant is only the fallback for an order that carries no
 * term (an older row, or a row written before the column existed). */
export const DEFAULT_PRO_TERM_DAYS = 30;

const DAY_MS = 86_400_000;

/** Event kinds of the append-only log. */
export type ProEntitlementEventKind = 'grant' | 'renew' | 'revoke';

/** Derived state of one subject at a given point in time. */
export interface ProEntitlementState {
  /** Pro is usable now: a live term that neither expired nor was revoked. */
  active: boolean;
  /** Start of the current term (ISO 8601, UTC). */
  grantedAt: string | null;
  /** End of the current term (ISO 8601, UTC). */
  expiresAt: string | null;
  /** When the current term was explicitly revoked (ISO 8601, UTC). */
  revokedAt: string | null;
  /** Order id (or admin reference) that produced the current state. */
  sourceOrderId: string | null;
  /** Kind of the last event applied while replaying. */
  kind: ProEntitlementEventKind | null;
  /** Length of the current term, in days (the term of the last grant/renew). */
  termDays: number | null;
}

interface EntitlementEventRow {
  id: number;
  source_merchant_order_id: string;
  subject_id: string;
  kind: ProEntitlementEventKind;
  term_days: number | null;
  occurred_at: string;
}

/** Order ids used by the billing ledger (see aipay.ts). */
const ORDER_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
/** Admin-issued revocation reference: `admin:<uuid>`. */
const ADMIN_REF_RE = /^admin:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function toMillis(value: number | string): number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : Date.now();
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Date.now();
}

function toIso(millis: number | null): string | null {
  return millis === null ? null : new Date(millis).toISOString();
}

/** Days of the event term; a missing/garbage value falls back to the default. */
function termDaysOf(event: EntitlementEventRow): number {
  const days = Number(event.term_days);
  return Number.isFinite(days) && days > 0 ? Math.floor(days) : DEFAULT_PRO_TERM_DAYS;
}

interface ReplayedTerm {
  grantedAt: number | null;
  expiresAt: number | null;
  revokedAt: number | null;
  sourceOrderId: string | null;
  kind: ProEntitlementEventKind | null;
  termDays: number | null;
}

/**
 * Replay one subject's events (ordered by id) into the current term.
 *
 * - grant/renew: with a live term the new term starts at max(expiresAt,
 *   occurredAt) so paid time is never wasted; without a live term (none yet,
 *   expired, or revoked) a fresh term starts at occurredAt.
 * - revoke: the term ends immediately (expiresAt = occurredAt) and revokedAt is
 *   recorded. A later grant/renew starts a new term (the subject is restored).
 */
function replay(events: EntitlementEventRow[]): ReplayedTerm {
  let grantedAt: number | null = null;
  let expiresAt: number | null = null;
  let revokedAt: number | null = null;
  let sourceOrderId: string | null = null;
  let kind: ProEntitlementEventKind | null = null;
  let termDays: number | null = null;

  for (const event of events) {
    const at = Date.parse(event.occurred_at);
    if (!Number.isFinite(at)) continue;
    if (event.kind === 'revoke') {
      // Explicit revocation: the paid term stops here, whatever the ledger says.
      expiresAt = at;
      revokedAt = at;
      sourceOrderId = event.source_merchant_order_id;
      kind = 'revoke';
      continue;
    }
    const days = termDaysOf(event);
    const span = days * DAY_MS;
    termDays = days;
    if (revokedAt !== null || expiresAt === null || expiresAt <= at) {
      // No live term: start a new one at the event time.
      grantedAt = at;
      expiresAt = at + span;
      revokedAt = null;
    } else {
      // Renewal of a live term: extend from the current expiry.
      expiresAt = expiresAt + span;
    }
    sourceOrderId = event.source_merchant_order_id;
    kind = event.kind;
  }

  return { grantedAt, expiresAt, revokedAt, sourceOrderId, kind, termDays };
}

/**
 * Derive the Pro state of a subject by replaying its event log.
 * `now` defaults to the current time; pass it explicitly in tests.
 */
export async function computeProEntitlement(db: Db, subjectId: string,
  now: number | string = Date.now()): Promise<ProEntitlementState> {
  const subject = String(subjectId ?? '').trim();
  if (!subject) {
    return { active: false, grantedAt: null, expiresAt: null, revokedAt: null, sourceOrderId: null, kind: null, termDays: null };
  }
  const events = await db.prepare(`SELECT id, source_merchant_order_id, subject_id, kind, term_days, occurred_at
      FROM pro_entitlement_events WHERE subject_id = ? ORDER BY id ASC`).all<EntitlementEventRow>(subject);
  const term = replay(events);
  const at = toMillis(now);
  return {
    // Revoked is inactive even before its timestamp; expired is inactive too.
    active: term.revokedAt === null && term.expiresAt !== null && term.expiresAt > at,
    grantedAt: toIso(term.grantedAt),
    expiresAt: toIso(term.expiresAt),
    revokedAt: toIso(term.revokedAt),
    sourceOrderId: term.sourceOrderId,
    kind: term.kind,
    termDays: term.termDays,
  };
}

/** One subject's derived Pro state, as the boards show it. */
export interface ProTermSummary {
  subjectId: string;
  active: boolean;
  grantedAt: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
  sourceOrderId: string | null;
  kind: ProEntitlementEventKind | null;
  termDays: number | null;
}

/**
 * The derived Pro state of every subject that ever held a term.
 *
 * The event log stays the only source of truth: the rows are grouped by
 * subject and replayed with the very same rules as `computeProEntitlement`,
 * so the board cannot show a term the API would not honour.
 *
 * `limit` bounds the number of subjects (the most recently touched ones).
 */
export async function listProEntitlements(db: Db, limit = 50,
  now: number | string = Date.now()): Promise<ProTermSummary[]> {
  const rows = await db.prepare(`SELECT id, source_merchant_order_id, subject_id, kind, term_days, occurred_at
      FROM pro_entitlement_events ORDER BY id ASC LIMIT 10000`).all<EntitlementEventRow>();
  const grouped = new Map<string, EntitlementEventRow[]>();
  for (const row of rows) {
    const list = grouped.get(row.subject_id);
    if (list) list.push(row);
    else grouped.set(row.subject_id, [row]);
  }
  const at = toMillis(now);
  const summaries: ProTermSummary[] = [];
  for (const [subjectId, events] of grouped) {
    const term = replay(events);
    summaries.push({
      subjectId,
      active: term.revokedAt === null && term.expiresAt !== null && term.expiresAt > at,
      grantedAt: toIso(term.grantedAt),
      expiresAt: toIso(term.expiresAt),
      revokedAt: toIso(term.revokedAt),
      sourceOrderId: term.sourceOrderId,
      kind: term.kind,
      termDays: term.termDays,
    });
  }
  summaries.sort((a, b) => (b.grantedAt ?? '').localeCompare(a.grantedAt ?? ''));
  return summaries.slice(0, Math.max(1, limit));
}

/** Pro access check: true only while the term is live (expired ⇒ false). */
export async function hasProEntitlement(db: Db, subjectId: string,
  now: number | string = Date.now()): Promise<boolean> {
  return (await computeProEntitlement(db, subjectId, now)).active;
}

/**
 * The confirmed Pro order of a merchant order id.
 *
 * The term column is read when the database has it (the commercial
 * migration was applied); a database without the column still answers — the
 * term then falls back to the default length.
 */
async function readConfirmedOrder(db: Db, merchantOrderId: string): Promise<{ subject_id: string; term_days: number | null } | undefined> {
  try {
    return await db.prepare(`SELECT subject_id, term_days FROM billing_orders
        WHERE merchant_order_id = ? AND status = 'confirmed' AND purpose = 'pro'`)
      .get<{ subject_id: string; term_days: number | null }>(merchantOrderId);
  } catch {
    try {
      const row = await db.prepare(`SELECT subject_id FROM billing_orders
          WHERE merchant_order_id = ? AND status = 'confirmed' AND purpose = 'pro'`)
        .get<{ subject_id: string }>(merchantOrderId);
      return row ? { subject_id: row.subject_id, term_days: null } : undefined;
    } catch {
      return undefined;
    }
  }
}

/**
 * Turn a confirmed local Pro order into a grant/renew event.
 *
 * Returns true when the order is (or already was) granted to the subject it
 * was paid for; false when the order is missing, not confirmed, not a Pro
 * order, carries no subject, or was reassigned to another subject.
 *
 * The subject is read from the order row, never from the caller, and the
 * insert is guarded by "no event exists for this order" so a replayed call can
 * never extend the term twice.
 */
export async function syncEntitlementFromBilling(db: Db, merchantOrderId: string): Promise<boolean> {
  const order = await readConfirmedOrder(db, merchantOrderId);
  if (!order) return false;
  const subjectId = String(order.subject_id ?? '').trim();
  if (!subjectId) return false;

  // The length of the term belongs to the order: $12 buys 30 days today, and
  // a different price may buy a different term later.
  const ordered = Number(order.term_days);
  const termDays = Number.isFinite(ordered) && ordered > 0 ? Math.floor(ordered) : DEFAULT_PRO_TERM_DAYS;

  const stamp = new Date().toISOString();
  await db.prepare(`INSERT INTO pro_entitlement_events
      (source_merchant_order_id, subject_id, kind, term_days, occurred_at, created_at)
      SELECT ?, ?,
        CASE WHEN EXISTS (SELECT 1 FROM pro_entitlement_events e
                          WHERE e.subject_id = ? AND e.kind IN ('grant', 'renew'))
             THEN 'renew' ELSE 'grant' END,
        ?, ?, ?
      WHERE NOT EXISTS (SELECT 1 FROM pro_entitlement_events e2
                        WHERE e2.source_merchant_order_id = ?)
      ON CONFLICT(source_merchant_order_id) WHERE kind IN ('grant', 'renew') DO NOTHING`)
    .run(merchantOrderId, subjectId, subjectId, termDays, stamp, stamp, merchantOrderId);

  // The order only counts for the subject it was actually paid for.
  const event = await db.prepare(`SELECT subject_id FROM pro_entitlement_events
      WHERE source_merchant_order_id = ? ORDER BY id ASC LIMIT 1`).get<{ subject_id: string }>(merchantOrderId);
  return event !== undefined && event.subject_id === subjectId;
}

/**
 * Explicitly revoke Pro for a subject.
 *
 * `reference` identifies the decision: an order id or an admin reference
 * (`admin:<uuid>`). Revoking a subject that was never granted writes nothing
 * and returns false. A repeated call with the same reference is idempotent and
 * returns true (the revocation is on record).
 */
export async function revokeProEntitlement(db: Db, subjectId: string, reference: string,
  now: number | string = Date.now()): Promise<boolean> {
  const subject = String(subjectId ?? '').trim();
  if (!subject) return false;
  const ref = String(reference ?? '').trim();
  if (!ORDER_ID_RE.test(ref) && !ADMIN_REF_RE.test(ref)) throw new Error('invalid_pro_revoke_reference');

  // Only a subject that actually holds Pro can be revoked.
  const granted = await db.prepare(`SELECT 1 FROM pro_entitlement_events
      WHERE subject_id = ? AND kind IN ('grant', 'renew') LIMIT 1`).get(subject);
  if (!granted) return false;

  const stamp = new Date(toMillis(now)).toISOString();
  await db.prepare(`INSERT INTO pro_entitlement_events
      (source_merchant_order_id, subject_id, kind, term_days, occurred_at, created_at)
      VALUES (?, ?, 'revoke', NULL, ?, ?)
      ON CONFLICT(source_merchant_order_id) WHERE kind = 'revoke' DO NOTHING`)
    .run(ref, subject, stamp, stamp);

  const recorded = await db.prepare(`SELECT 1 FROM pro_entitlement_events
      WHERE source_merchant_order_id = ? AND subject_id = ? AND kind = 'revoke' LIMIT 1`).get(ref, subject);
  return recorded !== undefined;
}
