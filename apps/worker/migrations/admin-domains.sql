-- M9 domains B (content & community), D (monitoring) and F (settings).
-- Additive: safe to apply to an existing database, idempotent on re-apply.
-- Everything here is additive — no column of an existing table is dropped or
-- rewritten, so a failed apply can simply be re-run.

-- ---------------------------------------------------------------------------
-- Shared append-only admin audit (SSOT item 18 domain E).
-- One row per (request, action, target): the audit trail is the record of who
-- changed what and when. It is never updated and never deleted.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS admin_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id TEXT NOT NULL,
  action TEXT NOT NULL,
  subject TEXT NOT NULL,
  target TEXT NOT NULL,
  before_json TEXT,
  after_json TEXT,
  created_at TEXT NOT NULL
);
-- The replay key: a request id may claim an (action, target) only once.
CREATE UNIQUE INDEX IF NOT EXISTS idx_admin_audit_request_target
  ON admin_audit(request_id, action, target);
CREATE INDEX IF NOT EXISTS idx_admin_audit_recent ON admin_audit(created_at, id);
CREATE INDEX IF NOT EXISTS idx_admin_audit_target ON admin_audit(target, id);

CREATE TRIGGER IF NOT EXISTS admin_audit_no_update
BEFORE UPDATE ON admin_audit BEGIN
  SELECT RAISE(ABORT, 'admin audit is append-only');
END;

CREATE TRIGGER IF NOT EXISTS admin_audit_no_delete
BEFORE DELETE ON admin_audit BEGIN
  SELECT RAISE(ABORT, 'admin audit is append-only');
END;

-- REPLACE can bypass delete triggers when recursive triggers are disabled.
-- The guard covers the logical replay tuple *and* a primary-key replacement.
CREATE TRIGGER IF NOT EXISTS admin_audit_no_replace
BEFORE INSERT ON admin_audit
WHEN EXISTS (SELECT 1 FROM admin_audit WHERE request_id = NEW.request_id
            AND action = NEW.action AND target = NEW.target) BEGIN
  SELECT RAISE(ABORT, 'admin audit is append-only');
END;

CREATE TRIGGER IF NOT EXISTS admin_audit_no_replace_pk
BEFORE INSERT ON admin_audit
WHEN EXISTS (SELECT 1 FROM admin_audit WHERE id = NEW.id) BEGIN
  SELECT RAISE(ABORT, 'admin audit is append-only');
END;

-- ---------------------------------------------------------------------------
-- Request reservations.
--
-- Every administrator action claims its request id here, in the same
-- transaction as the change itself. The claim is what makes a replay
-- detectable: a second request with the same id cannot write anything, and
-- a request that changed nothing still leaves a receipt, so an old retry
-- cannot slip in after a later edit.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS admin_requests (
  request_id TEXT PRIMARY KEY,
  action TEXT NOT NULL,
  subject TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- ---------------------------------------------------------------------------
-- Domain B — content & community.
-- ---------------------------------------------------------------------------

-- Owner statements (site claims) waiting for moderation. The claims table
-- already exists; this index keeps the moderation queue bounded.
CREATE INDEX IF NOT EXISTS idx_claims_status ON claims(status, id);

-- Correction tickets (纠错工单): a tracked request to fix a site's category,
-- title, score or state. Public submission is not part of this milestone;
-- the table is the operator-side workflow.
CREATE TABLE IF NOT EXISTS admin_correction_tickets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  domain TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('category', 'title', 'score', 'status', 'other')),
  detail TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved', 'dismissed')),
  subject TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  closed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_admin_correction_tickets_status
  ON admin_correction_tickets(status, id);
CREATE INDEX IF NOT EXISTS idx_admin_correction_tickets_domain
  ON admin_correction_tickets(domain, id);

-- The three write paths of domain B. Each is a write-only view whose trigger
-- performs the business write and its audit row in ONE statement, so the
-- audit row exists exactly when — and exactly because — the change landed.
-- The state the audit row describes is read inside the transaction, so two
-- concurrent operators cannot both claim the same transition.
CREATE VIEW IF NOT EXISTS admin_site_reclassify
  (request_id, subject, domain, category_id, category_slug) AS
  SELECT request_id, subject, '' AS domain, 0 AS category_id, '' AS category_slug
  FROM admin_audit WHERE 0;

CREATE TRIGGER IF NOT EXISTS admin_site_reclassify_insert
INSTEAD OF INSERT ON admin_site_reclassify BEGIN
  INSERT INTO admin_audit (request_id, action, subject, target, before_json, after_json, created_at)
  SELECT NEW.request_id, 'reclassify', NEW.subject, 'site:' || s.domain,
         json_object('category_id', s.category_id, 'category_slug', c.slug),
         json_object('category_id', NEW.category_id, 'category_slug', NEW.category_slug),
         strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  FROM sites s LEFT JOIN categories c ON c.id = s.category_id
  WHERE s.domain = NEW.domain AND s.category_id IS NOT NEW.category_id;
  SELECT RAISE(IGNORE) WHERE changes() = 0;

  UPDATE sites SET category_id = NEW.category_id,
                   updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  WHERE domain = NEW.domain;
END;

CREATE VIEW IF NOT EXISTS admin_claim_decide
  (request_id, subject, claim_id, decision) AS
  SELECT request_id, subject, 0 AS claim_id, '' AS decision FROM admin_audit WHERE 0;

CREATE TRIGGER IF NOT EXISTS admin_claim_decide_insert
INSTEAD OF INSERT ON admin_claim_decide BEGIN
  INSERT INTO admin_audit (request_id, action, subject, target, before_json, after_json, created_at)
  SELECT NEW.request_id, 'claims.' || NEW.decision, NEW.subject, 'claim:' || c.id,
         json_object('status', c.status),
         json_object('status', CASE WHEN NEW.decision = 'publish' THEN 'published' ELSE 'rejected' END),
         strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  FROM claims c
  WHERE c.id = NEW.claim_id AND c.status = 'pending';
  SELECT RAISE(IGNORE) WHERE changes() = 0;

  UPDATE claims
     SET status = CASE WHEN NEW.decision = 'publish' THEN 'published' ELSE 'rejected' END
   WHERE id = NEW.claim_id AND status = 'pending';
END;

CREATE VIEW IF NOT EXISTS admin_ticket_create
  (request_id, subject, domain, kind, detail) AS
  SELECT request_id, subject, '' AS domain, '' AS kind, '' AS detail FROM admin_audit WHERE 0;

CREATE TRIGGER IF NOT EXISTS admin_ticket_create_insert
INSTEAD OF INSERT ON admin_ticket_create BEGIN
  INSERT INTO admin_correction_tickets (domain, kind, detail, status, subject, created_at, updated_at)
  VALUES (NEW.domain, NEW.kind, NEW.detail, 'open', NEW.subject,
          strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

  INSERT INTO admin_audit (request_id, action, subject, target, before_json, after_json, created_at)
  VALUES (NEW.request_id, 'ticket.create', NEW.subject, 'ticket:' || last_insert_rowid(),
          NULL, json_object('domain', NEW.domain, 'kind', NEW.kind, 'detail', NEW.detail),
          strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

CREATE VIEW IF NOT EXISTS admin_ticket_close
  (request_id, subject, ticket_id, status) AS
  SELECT request_id, subject, 0 AS ticket_id, '' AS status FROM admin_audit WHERE 0;

CREATE TRIGGER IF NOT EXISTS admin_ticket_close_insert
INSTEAD OF INSERT ON admin_ticket_close BEGIN
  INSERT INTO admin_audit (request_id, action, subject, target, before_json, after_json, created_at)
  SELECT NEW.request_id, 'ticket.close', NEW.subject, 'ticket:' || t.id,
         json_object('status', t.status), json_object('status', NEW.status),
         strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  FROM admin_correction_tickets t
  WHERE t.id = NEW.ticket_id AND t.status = 'open';
  SELECT RAISE(IGNORE) WHERE changes() = 0;

  UPDATE admin_correction_tickets
     SET status = NEW.status,
         closed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
         updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
   WHERE id = NEW.ticket_id AND status = 'open';
END;

-- ---------------------------------------------------------------------------
-- Domain D — monitoring.
-- ---------------------------------------------------------------------------

-- Outcome of every scheduled job (the worker's own cron and the GitHub
-- Actions pipelines that report in). The board flags a job whose last run
-- failed, or that has not reported a success for more than a day.
CREATE TABLE IF NOT EXISTS ops_cron_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('ok', 'failed', 'skipped')),
  run_id TEXT,
  detail TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ops_cron_runs_job ON ops_cron_runs(job, id);

-- Badge embeds per referring host and UTC day — the referrer column of the
-- monitoring board (SSOT item 18 domain D).
CREATE TABLE IF NOT EXISTS badge_referrers (
  day TEXT NOT NULL,
  host TEXT NOT NULL,
  hits INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, host)
);

-- ---------------------------------------------------------------------------
-- Domain F — settings.
-- ---------------------------------------------------------------------------

-- Operator-editable settings (OD9 beneficiary list, the two receiving
-- addresses). The values are read by the public charity endpoint; the
-- history of every change lives in admin_audit.
CREATE TABLE IF NOT EXISTS admin_settings (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  updated_by TEXT NOT NULL
);

-- Append-only publication trail of the charity pool address. The current
-- address is the latest row; older rows stay so a published fingerprint can
-- always be traced back to the change that produced it.
CREATE TABLE IF NOT EXISTS charity_publications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  address TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  request_id TEXT NOT NULL,
  subject TEXT NOT NULL,
  published_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_charity_publications_recent
  ON charity_publications(published_at, id);

CREATE TRIGGER IF NOT EXISTS charity_publications_no_update
BEFORE UPDATE ON charity_publications BEGIN
  SELECT RAISE(ABORT, 'charity publications are append-only');
END;

CREATE TRIGGER IF NOT EXISTS charity_publications_no_delete
BEFORE DELETE ON charity_publications BEGIN
  SELECT RAISE(ABORT, 'charity publications are append-only');
END;

CREATE TRIGGER IF NOT EXISTS charity_publications_no_replace_pk
BEFORE INSERT ON charity_publications
WHEN EXISTS (SELECT 1 FROM charity_publications WHERE id = NEW.id) BEGIN
  SELECT RAISE(ABORT, 'charity publications are append-only');
END;

-- The write path of domain F: the audit row (with the state before the
-- change, read inside the transaction), the value itself and — for the
-- charity pool — the public address fingerprint, all in one statement.
CREATE VIEW IF NOT EXISTS admin_setting_save
  (request_id, subject, key, value_json, fingerprint) AS
  SELECT request_id, subject, '' AS key, '' AS value_json, '' AS fingerprint FROM admin_audit WHERE 0;

CREATE TRIGGER IF NOT EXISTS admin_setting_save_insert
INSTEAD OF INSERT ON admin_setting_save BEGIN
  -- The audit row: written when the value is new or really different. The
  -- state before the change is read here, inside the transaction, so two
  -- concurrent writes cannot both claim the same "before" value.
  INSERT INTO admin_audit (request_id, action, subject, target, before_json, after_json, created_at)
  SELECT NEW.request_id, 'settings.update', NEW.subject, 'settings:' || NEW.key,
         CASE WHEN s.key IS NULL THEN NULL
              ELSE json_object('value', json_extract(s.value_json, '$')) END,
         json_object('value', json_extract(NEW.value_json, '$')),
         strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  FROM (SELECT 1) AS one
  LEFT JOIN admin_settings s ON s.key = NEW.key
  WHERE s.key IS NULL OR s.value_json IS NOT NEW.value_json;

  -- The pool address is published only when it was really set or changed;
  -- the audit row above exists exactly in that case.
  INSERT INTO charity_publications (address, fingerprint, request_id, subject, published_at)
  SELECT json_extract(NEW.value_json, '$'), NEW.fingerprint, NEW.request_id, NEW.subject,
         strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  WHERE NEW.key = 'charity_pool'
    AND NEW.fingerprint IS NOT NULL
    AND EXISTS (SELECT 1 FROM admin_audit
                WHERE request_id = NEW.request_id AND action = 'settings.update'
                  AND target = 'settings:charity_pool');

  INSERT INTO admin_settings (key, value_json, updated_at, updated_by)
  VALUES (NEW.key, NEW.value_json, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), NEW.subject)
  ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json,
    updated_at = excluded.updated_at, updated_by = excluded.updated_by;
END;
