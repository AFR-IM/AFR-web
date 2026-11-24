-- M9 private queue store. Requires the existing submissions.done_at column.
CREATE INDEX IF NOT EXISTS idx_submissions_admin_recent ON submissions(created_at, id);
CREATE INDEX IF NOT EXISTS idx_submissions_admin_backlog ON submissions(created_at, id)
  WHERE status IN ('queued', 'pending', 'scanning');
CREATE INDEX IF NOT EXISTS idx_submissions_admin_domain_latest ON submissions(domain, id);
CREATE INDEX IF NOT EXISTS idx_submissions_admin_active_domain ON submissions(domain)
  WHERE status IN ('queued', 'pending', 'scanning');

CREATE TABLE IF NOT EXISTS admin_queue_audit (
  request_id TEXT PRIMARY KEY NOT NULL,
  action TEXT NOT NULL CHECK (action = 'retry'),
  submission_id INTEGER NOT NULL,
  subject TEXT NOT NULL,
  created_at TEXT NOT NULL,
  before_json TEXT NOT NULL,
  after_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_admin_queue_audit_recent ON admin_queue_audit(created_at, request_id);

CREATE TRIGGER IF NOT EXISTS admin_queue_audit_no_update
BEFORE UPDATE ON admin_queue_audit BEGIN
  SELECT RAISE(ABORT, 'admin queue audit is append-only');
END;

CREATE TRIGGER IF NOT EXISTS admin_queue_audit_no_delete
BEFORE DELETE ON admin_queue_audit BEGIN
  SELECT RAISE(ABORT, 'admin queue audit is append-only');
END;

-- REPLACE can bypass delete triggers when recursive triggers are disabled.
CREATE TRIGGER IF NOT EXISTS admin_queue_audit_no_replace
BEFORE INSERT ON admin_queue_audit
WHEN EXISTS (SELECT 1 FROM admin_queue_audit WHERE request_id = NEW.request_id) BEGIN
  SELECT RAISE(ABORT, 'admin queue audit is append-only');
END;

-- Write-only view: one INSERT either does both writes or neither.
CREATE VIEW IF NOT EXISTS admin_queue_retry (request_id, submission_id, subject) AS
  SELECT request_id, submission_id, subject FROM admin_queue_audit WHERE 0;

CREATE TRIGGER IF NOT EXISTS admin_queue_retry_insert
INSTEAD OF INSERT ON admin_queue_retry BEGIN
  SELECT RAISE(IGNORE) WHERE EXISTS (
    SELECT 1 FROM admin_queue_audit WHERE request_id = NEW.request_id
  );

  INSERT INTO submissions (domain, source, status, created_at)
  SELECT original.domain, 'on_demand', 'queued', strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  FROM submissions original
  WHERE original.id = NEW.submission_id
    AND original.status IN ('scanned', 'done', 'rejected')
    AND trim(original.domain) <> ''
    AND NOT EXISTS (
      SELECT 1 FROM submissions newer WHERE newer.domain = original.domain AND newer.id > original.id
    )
    AND NOT EXISTS (
      SELECT 1 FROM submissions active WHERE active.domain = original.domain
        AND active.status IN ('queued', 'pending', 'scanning')
    );
  SELECT RAISE(IGNORE) WHERE changes() = 0;

  INSERT INTO admin_queue_audit (request_id, action, submission_id, subject, created_at, before_json, after_json)
  SELECT NEW.request_id, 'retry', original.id, NEW.subject, queued.created_at,
         json_object('id', original.id, 'domain', original.domain, 'status', original.status,
                     'source', original.source, 'created_at', original.created_at, 'done_at', original.done_at),
         json_object('id', queued.id, 'domain', queued.domain, 'status', queued.status,
                     'source', queued.source, 'created_at', queued.created_at, 'done_at', queued.done_at)
  FROM submissions original JOIN submissions queued ON queued.id = last_insert_rowid()
  WHERE original.id = NEW.submission_id;
  SELECT RAISE(ABORT, 'admin queue audit insert required') WHERE changes() <> 1;
END;
