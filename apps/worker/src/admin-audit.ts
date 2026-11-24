// src/admin-audit.ts — the shared append-only admin audit trail (SSOT item 18,
// domain E). Every administrator action writes one row per touched object:
// who (subject), when (created_at), what (action/target) and the before/after
// snapshots. Rows are never updated and never deleted.
//
// The audit write is never issued on its own: callers put the business write
// and the audit write into one `db.batch(...)`, which D1 executes inside a
// single transaction. Either both land or neither does — a site is never
// changed without its audit row.

import type { Db, SqlParam } from './db.ts';

export interface AdminAuditEntry {
  /** Client-supplied request id (a UUID). The replay key of the action. */
  requestId: string;
  /** Verb, e.g. `reclassify`, `claims.publish`, `settings.update`. */
  action: string;
  /** The authenticated operator. Never taken from request JSON. */
  subject: string;
  /** The object the action touched, e.g. `site:example.com`. */
  target: string;
  /** State before the action (JSON-serializable). */
  before?: unknown;
  /** State after the action (JSON-serializable). */
  after?: unknown;
  /** ISO timestamp; defaults to now. */
  createdAt?: string;
}

export interface AdminAuditRow {
  id: number;
  request_id: string;
  action: string;
  subject: string;
  target: string;
  before_json: string | null;
  after_json: string | null;
  created_at: string;
}

export interface AdminAuditEntryView {
  id: number;
  request_id: string;
  action: string;
  subject: string;
  target: string;
  before: unknown;
  after: unknown;
  created_at: string;
}

export const AUDIT_INSERT_SQL = `
  INSERT INTO admin_audit (request_id, action, subject, target, before_json, after_json, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?)`;

/** The INSERT statement of one audit row, for use inside a `db.batch`. */
export function auditStatement(entry: AdminAuditEntry): { sql: string; params: SqlParam[] } {
  return {
    sql: AUDIT_INSERT_SQL,
    params: [
      entry.requestId,
      entry.action,
      entry.subject,
      entry.target,
      entry.before === undefined ? null : JSON.stringify(entry.before),
      entry.after === undefined ? null : JSON.stringify(entry.after),
      entry.createdAt ?? new Date().toISOString(),
    ],
  };
}

/** True when this request already claimed the (action, target) pair. */
export async function auditHasRequest(db: Db, requestId: string, action: string): Promise<boolean> {
  const row = await db
    .prepare('SELECT 1 AS seen FROM admin_audit WHERE request_id = ? AND action = ? LIMIT 1')
    .get<{ seen: number }>(requestId, action);
  return row !== undefined;
}

export const REQUEST_RESERVE_SQL = `
  INSERT INTO admin_requests (request_id, action, subject, created_at) VALUES (?, ?, ?, ?)`;

/**
 * The statement that claims a request id. It belongs in the same batch as
 * the change it authorises: the claim is what makes a replay detectable, and
 * it is a receipt even when the action turned out to change nothing.
 */
export function reserveRequestStatement(entry: {
  requestId: string;
  action: string;
  subject: string;
  createdAt?: string;
}): { sql: string; params: SqlParam[] } {
  return {
    sql: REQUEST_RESERVE_SQL,
    params: [entry.requestId, entry.action, entry.subject, entry.createdAt ?? new Date().toISOString()],
  };
}

/** True when the request id was already claimed by an earlier action. */
export async function requestReserved(db: Db, requestId: string): Promise<boolean> {
  const row = await db
    .prepare('SELECT 1 AS seen FROM admin_requests WHERE request_id = ? LIMIT 1')
    .get<{ seen: number }>(requestId);
  return row !== undefined;
}

/** The most recent audit rows, newest first. */
export async function readAdminAudit(db: Db, limit = 50): Promise<AdminAuditEntryView[]> {
  const rows = await db
    .prepare(`SELECT id, request_id, action, subject, target, before_json, after_json, created_at
              FROM admin_audit ORDER BY id DESC LIMIT ?`)
    .all<AdminAuditRow>(limit);
  return rows.map(({ before_json, after_json, ...row }) => ({
    ...row,
    before: before_json === null ? null : JSON.parse(before_json),
    after: after_json === null ? null : JSON.parse(after_json),
  }));
}
