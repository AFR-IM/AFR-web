// src/directory-alerts.ts — the "additions and removals" half of the live
// alerts: when a site leaves or re-enters the directory, its Pro owner is
// told the same day.
//
// The signal is the published retirement list — `public/data/delisted.json`,
// the curated file the site pages already read for their retirement notes.
// Curated beats inferred: absence-from-a-catalog could be a half-finished
// build, while this file only changes when an operator retires or re-lists
// an entry. The worker fetches the published copy (the same bytes the
// public site serves), so the mail and the retirement note can never
// disagree about WHY a site disappeared.
//
// Two rules hold here:
//   1. The directory state (`sites.status`) is global and ungated — the
//      transition always lands. The MAIL is the Pro benefit: score-change
//      mails stay free, additions/removals go to active Pro mailboxes only.
//   2. A failed or missing signal must never change anything: no map, a
//      malformed map, or a fetch error all end the run with zero writes.

import { computeProEntitlement } from './entitlements.ts';
import type { Db } from './db.ts';

/** Safety valve: one run may never flip more domains than this, in either
 * direction. A runaway signal must degrade to "slow", never to "mass". */
export const MAX_TRANSITIONS_PER_RUN = 100;

export interface ReconcileResult {
  ok: boolean;
  reason?: 'no_signal' | 'malformed_signal';
  delisted: number;
  relisted: number;
  enqueued: number;
}

/**
 * Fetch the published retirement map (`domain → retirement note`).
 * Returns null when the file is missing, unreadable or not an object —
 * the caller then treats the run as "no signal" and writes nothing.
 */
export async function fetchRetirementMap(
  baseUrl: string,
  fetchImpl: typeof fetch,
): Promise<Record<string, unknown> | null> {
  const base = (baseUrl || 'https://afr.im').replace(/\/+$/, '');
  try {
    const res = await fetchImpl(`${base}/data/delisted.json`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    const data: unknown = await res.json();
    if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
    // Every value must be the retirement note object ({noteEn, noteZh}) the
    // site pages render. A response in any other shape is some other JSON —
    // GitHub listings, error payloads — and must never retire anything.
    const entries = Object.values(data as Record<string, unknown>);
    const isNote = (value: unknown): boolean =>
      value !== null &&
      typeof value === 'object' &&
      ('noteEn' in (value as object) || 'noteZh' in (value as object));
    if (!entries.every(isNote)) return null;
    return data as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Enqueue one directory event for a Pro owner. Returns true when a row
 * landed. Non-Pro mailboxes and opted-out mailboxes get the transition
 * but no mail — the gates are independent on purpose. */
async function enqueueDirectoryEvent(
  db: Db,
  domain: string,
  kind: 'added' | 'removed',
  at: string,
): Promise<boolean> {
  try {
    const pro = await computeProEntitlement(db, domain);
    if (!pro.active) return false;
    const mailbox = await db
      .prepare(
        `SELECT 1 AS seen FROM owner_emails
         WHERE domain = ? AND verified_at IS NOT NULL AND notify = 1
         LIMIT 1`,
      )
      .get(domain);
    if (!mailbox) return false;
    // The event key carries the transition time: a domain that is retired,
    // re-listed and retired again produces a fresh event each time, while
    // a replayed run in the same state inserts nothing (UNIQUE).
    const result = await db
      .prepare(
        `INSERT OR IGNORE INTO notify_outbox
           (domain, event_key, event_type, status, attempts, created_at)
         VALUES (?, ?, ?, 'pending', 0, ?)`,
      )
      .run(domain, `${domain}|${kind}|${at}`, kind, at);
    return result.changes > 0;
  } catch (err) {
    // The mail layer must never block the directory state: log and go on.
    console.warn(
      `directory alerts: enqueue failed for ${domain} (${kind}): ${err instanceof Error ? err.message : String(err)})`,
    );
    return false;
  }
}

/**
 * Reconcile `sites.status` with the published retirement list.
 *
 *  · a listed domain present in the map  → status 'delisted' + `removed`
 *  · a retired domain absent from the map → status 'active'  + `added`
 *
 * Each flip is one guarded UPDATE (`WHERE status = …`), so a concurrent
 * run cannot double-transition, and the mail is enqueued only when that
 * UPDATE actually changed the row. Transitions are capped per direction.
 * The caller runs this before the outbox drain so the same invocation can
 * deliver what it just recorded.
 */
export async function reconcileDirectoryPresence(
  db: Db,
  retirementMap: Record<string, unknown> | null | undefined,
  opts: { now?: () => Date } = {},
): Promise<ReconcileResult> {
  const empty = { ok: false, delisted: 0, relisted: 0, enqueued: 0 };
  if (retirementMap === null || retirementMap === undefined) {
    return { ...empty, reason: 'no_signal' };
  }
  if (typeof retirementMap !== 'object' || Array.isArray(retirementMap)) {
    return { ...empty, reason: 'malformed_signal' };
  }
  const retired = new Set(Object.keys(retirementMap).map((key) => key.trim().toLowerCase()).filter(Boolean));

  const now = opts.now?.() ?? new Date();
  const at = now.toISOString();
  const result: ReconcileResult = { ok: true, delisted: 0, relisted: 0, enqueued: 0 };

  const active = await db
    .prepare(`SELECT domain FROM sites WHERE status = 'active'`)
    .all<{ domain: string }>();
  let flips = 0;
  for (const row of active) {
    if (flips >= MAX_TRANSITIONS_PER_RUN) break;
    const domain = row.domain.trim().toLowerCase();
    if (!retired.has(domain)) continue;
    const update = await db
      .prepare(
        `UPDATE sites SET status = 'delisted', updated_at = ?
         WHERE domain = ? AND status = 'active'`,
      )
      .run(at, row.domain);
    if (update.changes !== 1) continue;
    flips += 1;
    result.delisted += 1;
    if (await enqueueDirectoryEvent(db, row.domain, 'removed', at)) result.enqueued += 1;
  }

  const delisted = await db
    .prepare(`SELECT domain FROM sites WHERE status = 'delisted'`)
    .all<{ domain: string }>();
  for (const row of delisted) {
    if (flips >= MAX_TRANSITIONS_PER_RUN) break;
    const domain = row.domain.trim().toLowerCase();
    if (retired.has(domain)) continue;
    const update = await db
      .prepare(
        `UPDATE sites SET status = 'active', updated_at = ?
         WHERE domain = ? AND status = 'delisted'`,
      )
      .run(at, row.domain);
    if (update.changes !== 1) continue;
    flips += 1;
    result.relisted += 1;
    if (await enqueueDirectoryEvent(db, row.domain, 'added', at)) result.enqueued += 1;
  }

  return result;
}
