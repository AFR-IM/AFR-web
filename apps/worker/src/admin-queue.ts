import type { Db } from './db.ts';

type SubmissionSnapshot = {
  id: number;
  domain: string | null;
  status: string | null;
  source: string | null;
  created_at: string | null;
  done_at: string | null;
};

type QueueRow = SubmissionSnapshot & { site_status: string | null };

type AuditRow = {
  request_id: string;
  action: 'retry';
  subject: string;
  created_at: string;
  before_json: string;
  after_json: string;
};

const BOARD_LIMIT = 50;
const SELECT_QUEUE = `
  SELECT q.id, q.domain, q.status, q.source, q.created_at, q.done_at, s.status AS site_status
  FROM submissions q LEFT JOIN sites s ON s.domain = q.domain`;

/** Private board data. Call only after verifying admin access. */
export async function readAdminQueue(db: Db) {
  const [recent, backlog, auditRows] = await Promise.all([
    db.prepare(`${SELECT_QUEUE} ORDER BY q.created_at DESC, q.id DESC LIMIT ?`)
      .all<QueueRow>(BOARD_LIMIT),
    db.prepare(`${SELECT_QUEUE} WHERE q.status IN ('queued', 'pending', 'scanning')
                ORDER BY q.created_at ASC, q.id ASC LIMIT ?`)
      .all<QueueRow>(BOARD_LIMIT),
    db.prepare(`SELECT request_id, action, subject, created_at, before_json, after_json
                FROM admin_queue_audit ORDER BY created_at DESC, request_id DESC LIMIT ?`)
      .all<AuditRow>(BOARD_LIMIT),
  ]);
  const audit = auditRows.map(({ before_json, after_json, ...row }) => ({
    ...row,
    before: JSON.parse(before_json) as SubmissionSnapshot,
    after: JSON.parse(after_json) as SubmissionSnapshot,
  }));
  return { recent, backlog, audit };
}

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

/** The caller supplies an authenticated Access subject, never one from request JSON. */
export async function retryAdminSubmission(
  db: Db,
  { id, requestId, subject }: { id: number; requestId: string; subject: string },
): Promise<'queued' | 'replayed' | 'conflict'> {
  if (!Number.isSafeInteger(id) || id < 1 || !UUID.test(requestId) || !subject.trim()) return 'conflict';
  const key = requestId.toLowerCase();

  // The INSTEAD OF INSERT trigger returns no row when its guard rejects the
  // attempt. A successful statement commits both the submission and its audit.
  const inserted = await db.prepare(`
    INSERT INTO admin_queue_retry (request_id, submission_id, subject) VALUES (?, ?, ?)
    RETURNING request_id
  `).get(key, id, subject);
  if (inserted) return 'queued';

  // Only a committed action claims the UUID. A replay must match its operator
  // and original submission even if the queue has changed in the meantime.
  const prior = await db.prepare(`
    SELECT 1 FROM admin_queue_audit
    WHERE request_id = ? AND submission_id = ? AND subject = ? AND action = 'retry'
  `).get(key, id, subject);
  return prior ? 'replayed' : 'conflict';
}
