-- afr.im D1 schema (SQLite dialect)
-- Source: core tables (sites/scans/evidence/owners/submissions/claims/
-- categories/api_keys) + ads table + idx_ads_slot.
-- Apply: wrangler d1 execute aiapp --file schema.sql --remote

-- Categories (14 top-level categories + free-form second-level tags)
CREATE TABLE IF NOT EXISTS categories (
  id INTEGER PRIMARY KEY,
  slug TEXT UNIQUE,
  name_en TEXT,
  name_zh TEXT,
  parent INTEGER
);

-- Site master table
CREATE TABLE IF NOT EXISTS sites (
  domain        TEXT PRIMARY KEY,        -- lowercase bare domain, e.g. "example.com"
  title         TEXT,
  lang          TEXT,                    -- primary language zh/en/...
  category_id   INTEGER REFERENCES categories(id),
  category_override INTEGER REFERENCES categories(id), -- a manual category (admin console); it wins over category_id
  strategy_tag  TEXT,                    -- AI-Open / Middle-Path / ...
  grade         TEXT,                    -- A/B/C/D/F/Pending/Declined
  score_total   INTEGER,
  score_l1      INTEGER,
  score_l2      INTEGER,
  score_l3      INTEGER,
  rank_source   TEXT,                    -- rank source list, e.g. "tranco"
  rank          INTEGER,                 -- Tranco rank
  status        TEXT DEFAULT 'active',   -- active/pending/declined/delisted
  verified      INTEGER DEFAULT 0,       -- owner-verified 0/1
  created_at    TEXT,
  updated_at    TEXT,
  scanned_at    TEXT
);
CREATE INDEX IF NOT EXISTS idx_sites_category ON sites(category_id);
CREATE INDEX IF NOT EXISTS idx_sites_grade ON sites(grade);

-- Scan records (history bound to an engine version)
CREATE TABLE IF NOT EXISTS scans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  domain TEXT REFERENCES sites(domain),
  engine_version TEXT,
  score_total INTEGER,
  score_l1 INTEGER,
  score_l2 INTEGER,
  score_l3 INTEGER,
  grade TEXT,
  snapshot_path TEXT,                    -- data-repo JSON path
  snapshot_sha TEXT,                    -- git blob sha from the trees listing (sync skip key;
                                        -- existing DBs: ALTER TABLE scans ADD COLUMN snapshot_sha TEXT)
  evidence_prev INTEGER,                -- when set, this scan's evidence is byte-identical to
                                        -- that scan's evidence (cross-round diff: unchanged
                                        -- rounds write 0 evidence rows — see d1-sync.ts).
                                        -- NULL = this scan owns a full evidence set.
                                        -- existing DBs: ALTER TABLE scans ADD COLUMN evidence_prev INTEGER
  started_at TEXT,
  finished_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_scans_domain ON scans(domain, started_at DESC);

-- Evidence rows (one row per check item)
CREATE TABLE IF NOT EXISTS evidence (
  scan_id INTEGER REFERENCES scans(id),
  check_id TEXT,                         -- e.g. "A1.gptbot" / "B1.llms-txt"
  status TEXT,                           -- pass/fail/partial/declined/unknown
  points INTEGER,
  max_points INTEGER,
  evidence_type TEXT,                    -- robots-snippet/http-head/jsonld/...
  evidence_ref TEXT                      -- path inside the snapshot or excerpt hash
);

-- Site owners (after ownership verification)
CREATE TABLE IF NOT EXISTS owners (
  domain TEXT PRIMARY KEY,
  verify_method TEXT,                    -- dns-txt / meta / file
  verified_at TEXT,
  email_hash TEXT,                       -- never store plaintext
  display_name TEXT,
  notify INTEGER DEFAULT 1
);

-- Submission queue
-- (one-time for DBs created before done_at existed:
--  wrangler d1 execute aiapp --command "ALTER TABLE submissions ADD COLUMN done_at TEXT" --remote)
CREATE TABLE IF NOT EXISTS submissions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  domain TEXT,
  submitter_note TEXT,
  source TEXT,                           -- tranco/public/owner/on_demand
  status TEXT,                           -- queued/scanning/scanned/done/rejected
  created_at TEXT,
  done_at TEXT,                          -- set by POST /api/v1/queue/:domain/done
  priority INTEGER NOT NULL DEFAULT 0    -- 1 = an active-Pro owner's rescan: the
                                         -- queue endpoint drains higher first
);
-- existing DBs (column added later):
--   wrangler d1 execute aiapp --command "ALTER TABLE submissions ADD COLUMN priority INTEGER NOT NULL DEFAULT 0" --remote

-- Site statements (appeal / context note)
CREATE TABLE IF NOT EXISTS claims (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  domain TEXT,
  statement TEXT,
  status TEXT,                           -- pending/published/rejected
  created_at TEXT
);

-- API keys (reserved for future tiers)
CREATE TABLE IF NOT EXISTS api_keys (
  key_hash TEXT PRIMARY KEY,
  domain_contact TEXT,
  domain TEXT,                         -- the site the key belongs to (one machine client per site)
  tier TEXT DEFAULT 'free',              -- free/pro
  created_at TEXT,
  last_used_at TEXT,                   -- the last call that presented the key
  revoked_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_api_keys_domain ON api_keys(domain, created_at DESC);

-- AIPAY integration remains separate from entitlements: receipt/order facts are
-- evidence only; the local billing ledger owns state transitions and access.
CREATE TABLE IF NOT EXISTS billing_orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  merchant_order_id TEXT NOT NULL UNIQUE,
  purpose TEXT NOT NULL CHECK (purpose IN ('pro', 'api', 'ad', 'torch', 'promo')),
  subject_id TEXT NOT NULL,
  amount TEXT NOT NULL,
  asset TEXT NOT NULL,
  chain_key TEXT NOT NULL,
  term_days INTEGER,                    -- the length of the paid term this order buys (30 days = $12)
  status TEXT NOT NULL CHECK (status IN ('creating', 'pending', 'confirmed', 'expired', 'cancelled', 'review')),
  aipay_reference TEXT UNIQUE,
  checkout_url TEXT,
  expires_at TEXT,
  aipay_confirmed_at TEXT,
  tx_hash TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_billing_orders_subject ON billing_orders(purpose, subject_id, created_at DESC);
CREATE TABLE IF NOT EXISTS billing_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  merchant_order_id TEXT NOT NULL,
  event_key TEXT NOT NULL UNIQUE,
  source TEXT NOT NULL CHECK (source IN ('local', 'webhook', 'reconcile')),
  event_type TEXT NOT NULL,
  payload_sha256 TEXT NOT NULL,
  before_status TEXT NOT NULL,
  after_status TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_billing_events_order ON billing_events(merchant_order_id, id);
CREATE TABLE IF NOT EXISTS billing_reconcile_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  cursor TEXT,
  filter_status TEXT,
  updated_at TEXT NOT NULL
);

-- One grant per source order. No cascading link to mutable billing state.
-- LEGACY: kept for schema stability only. It is NOT written any more and NOT a
-- source of truth — see pro_entitlement_events below.
CREATE TABLE IF NOT EXISTS pro_entitlements (
  source_merchant_order_id TEXT NOT NULL PRIMARY KEY,
  subject_id TEXT NOT NULL CHECK (trim(subject_id) <> ''),
  granted_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pro_entitlements_subject ON pro_entitlements(subject_id);

-- Append-only Pro subscription event log (term / renewal / explicit revoke).
-- The current state of a subject is derived by replaying its events in id
-- order; there is no mutable "current entitlement" row.
CREATE TABLE IF NOT EXISTS pro_entitlement_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_merchant_order_id TEXT NOT NULL,
  subject_id TEXT NOT NULL CHECK (trim(subject_id) <> ''),
  kind TEXT NOT NULL CHECK (kind IN ('grant', 'renew', 'revoke')),
  term_days INTEGER,
  occurred_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
-- One grant/renew event per source order: a replayed order cannot extend a
-- term twice. Partial, because the kind is decided at insert time and two
-- concurrent inserts could pick 'grant' and 'renew' for the same order.
CREATE UNIQUE INDEX IF NOT EXISTS idx_pro_entitlement_events_order_term
  ON pro_entitlement_events(source_merchant_order_id) WHERE kind IN ('grant', 'renew');
-- One revoke per reference (an order id or an admin:<uuid>).
CREATE UNIQUE INDEX IF NOT EXISTS idx_pro_entitlement_events_order_revoke
  ON pro_entitlement_events(source_merchant_order_id) WHERE kind = 'revoke';
CREATE INDEX IF NOT EXISTS idx_pro_entitlement_events_subject
  ON pro_entitlement_events(subject_id, id);

-- Ad slots
CREATE TABLE IF NOT EXISTS ads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  domain TEXT REFERENCES sites(domain),  -- must already be listed
  slot TEXT,                             -- category-top / home-supporter /
                                         -- search-top / report-sponsor
  slot_key TEXT,                         -- category slug or keyword, NULL = generic
  headline TEXT,                         -- <= 40 chars
  body TEXT,                             -- <= 90 chars
  starts_at TEXT,                        -- monthly period
  ends_at TEXT,
  status TEXT,                           -- pending/active/expired/rejected/paused
  stripe_session TEXT,                   -- payment reference
  impressions INTEGER DEFAULT 0,
  clicks INTEGER DEFAULT 0,
  created_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_ads_slot ON ads(slot, slot_key, status, ends_at);

-- ---------------------------------------------------------------------------
-- NEW statements for the post-reset apply run (all idempotent: IF NOT EXISTS).
-- Apply together with the statements above via:
--   wrangler d1 execute aiapp --file schema.sql --remote
-- ---------------------------------------------------------------------------

-- Verification tokens issued by POST /api/v1/verify/start
-- (opaque, single-use, 7-day validity; consumed by a successful
--  GET /api/v1/verify/check)
CREATE TABLE IF NOT EXISTS verify_tokens (
  domain TEXT,
  token TEXT,                           -- 'av-' + 32 lowercase hex chars
  created_at TEXT,
  expires_at TEXT,                      -- created_at + 7 days
  used_at TEXT                          -- set by a successful check
);

-- Page-view counter per site (one upsert per counted view; the count statement
-- refuses to write beyond the daily cap of 70000 per UTC day)
CREATE TABLE IF NOT EXISTS page_views (
  domain TEXT PRIMARY KEY,
  views INTEGER DEFAULT 0,              -- lifetime views
  today_views INTEGER DEFAULT 0,        -- views counted on counted_on
  counted_on TEXT                       -- UTC date (YYYY-MM-DD) of today_views
);

-- Idempotent evidence inserts: at most one row per (scan, check)
CREATE UNIQUE INDEX IF NOT EXISTS idx_evidence_scan_check ON evidence(scan_id, check_id);

-- One scan row per snapshot path: this is the conflict key the loaders upsert on
-- (scripts/d1-load.mjs `ON CONFLICT(snapshot_path)`, worker d1-sync keyed on
-- `SELECT id FROM scans WHERE snapshot_path = ?`).
--
-- Dedupe first. The legacy d1-load wrote `INSERT OR IGNORE INTO scans` with NO
-- unique key on scans, so IGNORE never matched and every re-run inserted another
-- row for the same snapshot_path (verified locally with node:sqlite: 3 legacy
-- runs over one snapshot → 3 rows). Duplicates may therefore exist in this DB.
-- Keep the most recent row (MAX(id)) per snapshot_path; its evidence survives,
-- evidence attached to the dropped duplicates goes with them. Both DELETEs are
-- idempotent (no-ops once deduped), so re-applying schema.sql is safe.
DELETE FROM evidence
WHERE scan_id IN (
  SELECT id FROM scans
  WHERE snapshot_path IS NOT NULL
    AND id NOT IN (SELECT MAX(id) FROM scans
                   WHERE snapshot_path IS NOT NULL
                   GROUP BY snapshot_path)
);
DELETE FROM scans
WHERE snapshot_path IS NOT NULL
  AND id NOT IN (SELECT MAX(id) FROM scans
                 WHERE snapshot_path IS NOT NULL
                 GROUP BY snapshot_path);

CREATE UNIQUE INDEX IF NOT EXISTS idx_scans_snapshot ON scans(snapshot_path);

-- ---------------------------------------------------------------------------
-- Owner contact mailbox (added with the owner-email subsystem).
-- Apply together with the statements above via:
--   wrangler d1 execute aiapp --file schema.sql --remote
-- ---------------------------------------------------------------------------

-- Owner contact mailbox (encrypted at rest; plaintext never stored)
CREATE TABLE IF NOT EXISTS owner_emails (
  domain TEXT PRIMARY KEY,
  email_cipher TEXT NOT NULL,        -- base64 AES-256-GCM ciphertext
  email_hash TEXT NOT NULL,          -- hex HMAC-SHA256 of the normalized address (lookup/dedupe only)
  verified_at TEXT,                  -- set when the emailed magic link is clicked
  verify_token_hash TEXT,            -- hex SHA-256 of the pending magic token
  verify_expires_at TEXT,
  pending_email_cipher TEXT,
  pending_email_hash TEXT,
  manage_token_hash TEXT,            -- hex SHA-256 of the management token handed out by the
                                      -- confirmation; required by every later read/toggle
  notify INTEGER DEFAULT 1,          -- 0 = owner opted out of score-change mail
  created_at TEXT,
  updated_at TEXT
);
-- existing DBs (table already created):
--   wrangler d1 execute aiapp --command "ALTER TABLE owner_emails ADD COLUMN manage_token_hash TEXT" --remote

-- Pending owner-mailbox registration: the challenge proves domain control,
-- the magic link proves mailbox control. Only hashes are stored.
-- Expired rows can be pruned (a cron statement):
--   DELETE FROM email_challenges WHERE expires_at < '2026-01-01T00:00:00.000Z';
CREATE TABLE IF NOT EXISTS email_challenges (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  domain TEXT NOT NULL,
  challenge_hash TEXT NOT NULL,      -- hex SHA-256 of the published challenge value
  email_cipher TEXT NOT NULL,        -- base64 AES-256-GCM ciphertext of the mailbox
  email_hash TEXT NOT NULL,          -- keyed HMAC of the normalized address
  expires_at TEXT NOT NULL,
  used_at TEXT,
  created_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_email_challenges_domain ON email_challenges(domain);

-- Pending management-token recovery (the owner lost the token).
-- The recovery re-proves domain control (a fresh challenge) and mailbox
-- control (the reset mail goes to the confirmed address); the link rotates
-- the management token. Only hashes are stored — the token itself exists
-- once, in the mail that carries the link.
-- Expired rows can be pruned (a cron statement):
--   DELETE FROM owner_mailbox_recoveries WHERE expires_at < '2026-01-01T00:00:00.000Z';
CREATE TABLE IF NOT EXISTS owner_mailbox_recoveries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  domain TEXT NOT NULL,
  email_hash TEXT NOT NULL,          -- keyed HMAC of the confirmed address
  token_hash TEXT NOT NULL UNIQUE,   -- hex SHA-256 of the recovery token
  expires_at TEXT NOT NULL,
  used_at TEXT,                      -- set when the link was spent
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_owner_mailbox_recoveries_domain ON owner_mailbox_recoveries(domain);

-- Score-change notification outbox (one row per event; UNIQUE key makes retries idempotent)
CREATE TABLE IF NOT EXISTS notify_outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  domain TEXT NOT NULL,
  event_key TEXT NOT NULL UNIQUE,    -- idempotency key: domain|snapshot_path|grade|score
  event_type TEXT NOT NULL DEFAULT 'score_change', -- score_change | added | removed
  grade TEXT,
  score_total INTEGER,
  prev_grade TEXT,
  prev_score INTEGER,
  status TEXT DEFAULT 'pending',      -- pending | sent | failed
  attempts INTEGER DEFAULT 0,
  last_error TEXT,
  next_attempt_at TEXT,              -- cooldown until the next delivery attempt
  created_at TEXT,
  sent_at TEXT
);
-- existing DBs (table already created):
--   wrangler d1 execute aiapp --command "ALTER TABLE notify_outbox ADD COLUMN next_attempt_at TEXT" --remote
--   wrangler d1 execute aiapp --command "ALTER TABLE notify_outbox ADD COLUMN event_type TEXT NOT NULL DEFAULT 'score_change'" --remote
CREATE INDEX IF NOT EXISTS idx_notify_outbox_status ON notify_outbox(status, id);

-- ---------------------------------------------------------------------------
-- Outbound mail quota (added with the generic SMTP channel).
-- Apply together with the statements above via:
--   wrangler d1 execute aiapp --file schema.sql --remote
-- ---------------------------------------------------------------------------

-- Outbound mail quota: natural-day counters, no daily reset job needed.
CREATE TABLE IF NOT EXISTS mail_quota (
  day TEXT NOT NULL,            -- UTC date (YYYY-MM-DD)
  scope TEXT NOT NULL,          -- 'global' | 'domain'
  key TEXT NOT NULL,            -- 'all' | domain
  count INTEGER DEFAULT 0,
  updated_at TEXT,
  PRIMARY KEY (day, scope, key)
);

-- Per-recipient cooldown for outbound mail.
CREATE TABLE IF NOT EXISTS mail_cooldown (
  recipient_hash TEXT PRIMARY KEY,   -- hex SHA-256 of the normalized address
  last_sent_at TEXT NOT NULL
);

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
         json_object('category_id', COALESCE(s.category_override, s.category_id), 'category_slug', c.slug),
         json_object('category_id', NEW.category_id, 'category_slug', NEW.category_slug),
         strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  FROM sites s LEFT JOIN categories c ON c.id = COALESCE(s.category_override, s.category_id)
  WHERE s.domain = NEW.domain AND COALESCE(s.category_override, s.category_id) IS NOT NEW.category_id;
  SELECT RAISE(IGNORE) WHERE changes() = 0;

  -- The manual decision goes into category_override, not into category_id:
  -- category_id is the rule-derived value (categorize-backfill.mjs rewrites
  -- it from the keyword rules), and a manual label must survive that.
  UPDATE sites SET category_override = NEW.category_id,
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

-- ---------------------------------------------------------------------------
-- Domain C — commerce (Pro subscriptions and machine keys).
--
-- The two write paths of the commercial board. Both are write-only views
-- whose trigger performs the business write and its audit row in ONE
-- statement, so a Pro term is never revoked without its receipt and a key is
-- never revoked without its receipt either. The state the audit row
-- describes is read inside the transaction, so two concurrent operators
-- cannot both claim the same transition.
-- ---------------------------------------------------------------------------

-- Revoke the Pro term of a site. The reference of the revocation is the
-- admin request id (`admin:<uuid>`) — the form the entitlement log accepts.
CREATE VIEW IF NOT EXISTS admin_pro_revoke
  (request_id, subject, domain, reference) AS
  SELECT request_id, subject, '' AS domain, '' AS reference FROM admin_audit WHERE 0;

CREATE TRIGGER IF NOT EXISTS admin_pro_revoke_insert
INSTEAD OF INSERT ON admin_pro_revoke BEGIN
  -- The audit row is written first and reads the state before the change:
  -- a revocation always leaves exactly one receipt of the term it ended.
  INSERT INTO admin_audit (request_id, action, subject, target, before_json, after_json, created_at)
  SELECT NEW.request_id, 'pro.revoke', NEW.subject, 'pro:' || NEW.domain,
         json_object('kind', g.kind, 'occurred_at', g.occurred_at, 'term_days', g.term_days),
         json_object('revoked_at', strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
         strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  FROM (SELECT 1) AS one
  LEFT JOIN pro_entitlement_events g ON g.id = (
    SELECT e.id FROM pro_entitlement_events e
    WHERE e.subject_id = NEW.domain AND e.kind IN ('grant', 'renew')
    ORDER BY e.id DESC LIMIT 1)
  WHERE NEW.reference = 'admin:' || NEW.request_id
    AND EXISTS (SELECT 1 FROM pro_entitlement_events e2
                WHERE e2.subject_id = NEW.domain AND e2.kind IN ('grant', 'renew'));
  SELECT RAISE(IGNORE) WHERE changes() = 0;

  INSERT INTO pro_entitlement_events
    (source_merchant_order_id, subject_id, kind, term_days, occurred_at, created_at)
  SELECT NEW.reference, NEW.domain, 'revoke', NULL,
         strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now');
END;

-- Revoke one machine key of a site.
CREATE VIEW IF NOT EXISTS admin_api_key_revoke
  (request_id, subject, domain, key_hash) AS
  SELECT request_id, subject, '' AS domain, '' AS key_hash FROM admin_audit WHERE 0;

CREATE TRIGGER IF NOT EXISTS admin_api_key_revoke_insert
INSTEAD OF INSERT ON admin_api_key_revoke BEGIN
  INSERT INTO admin_audit (request_id, action, subject, target, before_json, after_json, created_at)
  SELECT NEW.request_id, 'apikey.revoke', NEW.subject, 'apikey:' || k.key_hash,
         json_object('tier', k.tier, 'domain', k.domain, 'revoked_at', k.revoked_at),
         json_object('revoked_at', strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
         strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  FROM api_keys k
  WHERE k.key_hash = NEW.key_hash AND k.revoked_at IS NULL
    AND (NEW.domain IS NULL OR NEW.domain = '' OR k.domain = NEW.domain);
  SELECT RAISE(IGNORE) WHERE changes() = 0;

  UPDATE api_keys SET revoked_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  WHERE key_hash = NEW.key_hash AND revoked_at IS NULL;
END;

-- ---------------------------------------------------------------------------
-- Statements carried by the additive migrations after the commercial launch.
-- schema.sql is what a NEW database is created from, so it must already hold
-- them; an existing database applies the matching migration file instead.
-- ---------------------------------------------------------------------------

-- UTC usage counters for machine API keys (migrations/api-key-quota.sql).
-- One row per owner domain and period, or per key hash for keys without an
-- owner: 'd:YYYY-MM-DD' for the day, 'm:YYYY-MM' for the month.
CREATE TABLE IF NOT EXISTS api_key_usage (
  key_hash   TEXT NOT NULL,
  period     TEXT NOT NULL,
  used       INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (key_hash, period)
);

-- Scoring-engine release notes (migrations/scoring-release.sql).
CREATE TABLE IF NOT EXISTS scoring_releases (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  engine_version TEXT NOT NULL,
  notes TEXT NOT NULL,
  published_at TEXT NOT NULL,
  published_by TEXT NOT NULL,
  request_id TEXT NOT NULL UNIQUE REFERENCES admin_requests(request_id)
);
CREATE INDEX IF NOT EXISTS idx_scoring_releases_engine ON scoring_releases(engine_version, id);

-- The advertising ledger, its moderation view and its event budget
-- (migrations/ads.sql — identical statements, safe to re-apply).
CREATE VIEW IF NOT EXISTS ad_offers (slot, amount, term_days, capacity, available) AS
  SELECT 'category-top', 49, 30, 3, 1 UNION ALL
  SELECT 'search-top', 99, 30, 1, 1 UNION ALL
  SELECT 'home-supporter', 199, 30, 8, 1 UNION ALL
  SELECT 'report-sponsor', 999, 360, 1, 0;

CREATE TABLE IF NOT EXISTS ad_checkouts (
  ad_id INTEGER PRIMARY KEY REFERENCES ads(id),
  merchant_order_id TEXT NOT NULL UNIQUE,
  amount TEXT NOT NULL,
  asset TEXT NOT NULL CHECK (asset = 'USDC'),
  chain_key TEXT NOT NULL CHECK (chain_key = 'base'),
  term_days INTEGER NOT NULL CHECK (term_days BETWEEN 30 AND 360 AND term_days % 30 = 0),
  approval_request_id TEXT UNIQUE REFERENCES admin_requests(request_id),
  reviewed_at TEXT,
  review_note TEXT
);
CREATE INDEX IF NOT EXISTS idx_ads_ends ON ads(ends_at, id) WHERE status IN ('active', 'paused');

CREATE VIEW IF NOT EXISTS ad_checkout_state AS
  SELECT a.id, a.domain, a.slot, a.slot_key, a.headline, a.body, a.starts_at, a.ends_at,
         a.status, a.impressions, a.clicks, a.created_at,
         c.merchant_order_id, c.amount, c.asset, c.chain_key, c.term_days,
         c.approval_request_id, c.reviewed_at, c.review_note,
         b.status AS billing_status, b.aipay_reference, b.checkout_url, b.expires_at AS checkout_expires_at,
         CASE WHEN b.aipay_reference IS NOT NULL AND b.status = 'confirmed'
                   AND b.aipay_confirmed_at IS NOT NULL AND b.tx_hash IS NOT NULL
                   AND EXISTS (
                     SELECT 1 FROM billing_events e
                     WHERE e.merchant_order_id = b.merchant_order_id
                       AND e.source IN ('webhook', 'reconcile')
                       AND e.event_type = 'order.confirmed' AND e.after_status = 'confirmed'
                   ) THEN 1 ELSE 0 END AS paid,
         CASE WHEN b.status IN ('cancelled', 'expired') AND EXISTS (
                     SELECT 1 FROM billing_events e
                     WHERE e.merchant_order_id = b.merchant_order_id
                       AND e.source IN ('webhook', 'reconcile')
                       AND e.event_type = 'order.' || b.status AND e.after_status = b.status
                   ) THEN 1 ELSE 0 END AS checkout_closed,
         CASE WHEN EXISTS (
                     SELECT 1 FROM admin_audit au
                     WHERE au.request_id = c.approval_request_id
                       AND au.action = 'ads.approve' AND au.target = 'ad:' || a.id
                       AND json_extract(au.after_json, '$.starts_at') = a.starts_at
                       AND json_extract(au.after_json, '$.ends_at') = a.ends_at
                       AND json_extract(au.after_json, '$.domain') = a.domain
                       AND json_extract(au.after_json, '$.slot') = a.slot
                       AND json_extract(au.after_json, '$.slot_key') IS a.slot_key
                       AND json_extract(au.after_json, '$.headline') = a.headline
                       AND json_extract(au.after_json, '$.body') = a.body
                   ) THEN 1 ELSE 0 END AS approved,
         o.capacity,
         s.grade, s.score_total AS score,
         CASE WHEN s.status = 'active' AND s.grade IN ('A', 'B', 'C', 'D', 'E', 'F')
                   AND typeof(s.score_total) IN ('real', 'integer') AND s.score_total BETWEEN 0 AND 100
                   AND o.available = 1
                   AND ((a.slot = 'home-supporter' AND a.slot_key IS NULL)
                     OR (a.slot = 'search-top' AND length(a.slot_key) BETWEEN 1 AND 80)
                     OR (a.slot = 'category-top' AND EXISTS (SELECT 1 FROM categories WHERE slug = a.slot_key)))
              THEN 1 ELSE 0 END AS eligible_site
    FROM ads a JOIN ad_checkouts c ON c.ad_id = a.id
    JOIN ad_offers o ON o.slot = a.slot
    LEFT JOIN sites s ON s.domain = a.domain
    LEFT JOIN billing_orders b ON b.merchant_order_id = c.merchant_order_id
      AND b.purpose = 'ad' AND b.subject_id = a.domain AND b.amount = c.amount
      AND b.asset = c.asset AND b.chain_key = c.chain_key AND b.term_days = c.term_days
   WHERE c.amount = CAST(o.amount * (c.term_days / o.term_days) AS TEXT)
     AND c.term_days % o.term_days = 0;

CREATE VIEW IF NOT EXISTS approved_ad_placements AS
  SELECT id, domain, slot, slot_key, headline, body, starts_at, ends_at, status,
         impressions, clicks, grade, score
    FROM ad_checkout_state
   WHERE paid = 1 AND approved = 1 AND eligible_site = 1 AND status = 'active'
     AND starts_at = strftime('%Y-%m-%dT%H:%M:%fZ', starts_at)
     AND ends_at = strftime('%Y-%m-%dT%H:%M:%fZ', starts_at, '+' || term_days || ' days');

-- Paid applications and uncertain provider responses keep their seats, as do
-- future or paused placements until their terms end. Only verified provider
-- terminal states may release unpaid checkouts.
CREATE VIEW IF NOT EXISTS ad_slot_holds AS
  SELECT id, domain, slot, slot_key, NULL AS hold_until FROM ad_checkout_state
   WHERE status = 'pending' AND checkout_closed = 0
  UNION ALL
  SELECT id, domain, slot, slot_key, ends_at AS hold_until FROM ad_checkout_state
   WHERE status IN ('active', 'paused') AND approved = 1;

CREATE VIEW IF NOT EXISTS ad_checkout_apply
  (merchant_order_id, domain, slot, slot_key, headline, body, amount, asset, chain_key, term_days, created_at) AS
  SELECT '', '', '', NULL, '', '', '', '', '', 0, '' WHERE 0;

CREATE TRIGGER IF NOT EXISTS ad_checkout_apply_insert
INSTEAD OF INSERT ON ad_checkout_apply BEGIN
  -- Duplicate requests are resolved by the Worker against the original input.
  SELECT RAISE(IGNORE) WHERE EXISTS (
    SELECT 1 FROM ad_checkouts WHERE merchant_order_id = NEW.merchant_order_id
  );
  SELECT RAISE(ABORT, 'ad_request_conflict') WHERE EXISTS (
    SELECT 1 FROM billing_orders WHERE merchant_order_id = NEW.merchant_order_id
  );
  SELECT RAISE(ABORT, 'ad_checkout_ineligible') WHERE NOT EXISTS (
    SELECT 1 FROM sites s, ad_offers o
    WHERE s.domain = NEW.domain AND s.status = 'active' AND s.grade IN ('A', 'B', 'C', 'D', 'E', 'F')
      AND typeof(s.score_total) IN ('real', 'integer') AND s.score_total BETWEEN 0 AND 100
      AND o.slot = NEW.slot AND o.available = 1 AND NEW.term_days % o.term_days = 0
      AND NEW.amount = CAST(o.amount * (CAST(NEW.term_days AS INTEGER) / o.term_days) AS TEXT)
      AND ((NEW.slot = 'home-supporter' AND NEW.slot_key IS NULL)
        OR (NEW.slot = 'search-top' AND length(NEW.slot_key) BETWEEN 1 AND 80)
        OR (NEW.slot = 'category-top' AND EXISTS (SELECT 1 FROM categories WHERE slug = NEW.slot_key)))
  );
  SELECT RAISE(ABORT, 'ad_order_pending') WHERE EXISTS (
    SELECT 1 FROM ad_slot_holds
    WHERE domain = NEW.domain AND slot = NEW.slot AND slot_key IS NEW.slot_key
      AND (hold_until IS NULL OR hold_until > NEW.created_at)
  );
  SELECT RAISE(ABORT, 'ad_slot_full') WHERE (
    SELECT count(*) FROM ad_slot_holds
    WHERE slot = NEW.slot AND slot_key IS NEW.slot_key AND (hold_until IS NULL OR hold_until > NEW.created_at)
  ) >= (SELECT capacity FROM ad_offers WHERE slot = NEW.slot);

  INSERT INTO ads (domain, slot, slot_key, headline, body, status, created_at)
  VALUES (NEW.domain, NEW.slot, NEW.slot_key, NEW.headline, NEW.body, 'pending', NEW.created_at);
  INSERT INTO ad_checkouts (ad_id, merchant_order_id, amount, asset, chain_key, term_days)
  VALUES (last_insert_rowid(), NEW.merchant_order_id, NEW.amount, NEW.asset, NEW.chain_key, NEW.term_days);
END;

CREATE VIEW IF NOT EXISTS admin_ad_moderate (request_id, subject, ad_id, decision, starts_at, note, now) AS
  SELECT '', '', 0, '', '', '', '' WHERE 0;

CREATE TRIGGER IF NOT EXISTS admin_ad_moderate_insert
INSTEAD OF INSERT ON admin_ad_moderate BEGIN
  SELECT RAISE(ABORT, 'ad_admin_request_required') WHERE NOT EXISTS (
    SELECT 1 FROM admin_requests
    WHERE request_id = NEW.request_id AND action = 'ads.' || NEW.decision AND subject = NEW.subject
  );
  SELECT RAISE(ABORT, 'ad_state_conflict') WHERE NOT EXISTS (
    SELECT 1 FROM ad_checkout_state c
    WHERE c.id = NEW.ad_id AND (
      (NEW.decision = 'approve' AND c.status = 'pending' AND c.paid = 1 AND c.eligible_site = 1
        AND NEW.starts_at >= NEW.now AND NEW.starts_at = strftime('%Y-%m-%dT%H:%M:%fZ', NEW.starts_at)
        AND strftime('%Y-%m-%dT%H:%M:%fZ', NEW.starts_at, '+' || c.term_days || ' days') IS NOT NULL)
      OR (NEW.decision = 'reject' AND c.status = 'pending' AND c.paid = 1)
      OR (NEW.decision = 'pause' AND c.status = 'active' AND c.approved = 1 AND c.ends_at > NEW.now)
      OR (NEW.decision = 'resume' AND c.status = 'paused' AND c.approved = 1
        AND c.paid = 1 AND c.eligible_site = 1 AND c.ends_at > NEW.now)
    )
  );
  SELECT RAISE(ABORT, 'ad_slot_full') WHERE NEW.decision IN ('approve', 'resume') AND EXISTS (
    SELECT 1 FROM ad_checkout_state c WHERE c.id = NEW.ad_id AND (
      SELECT count(*) FROM ad_slot_holds h
      WHERE h.id != c.id AND h.slot = c.slot AND h.slot_key IS c.slot_key
        AND (h.hold_until IS NULL OR h.hold_until > NEW.now)
    ) >= c.capacity
  );

  INSERT INTO admin_audit (request_id, action, subject, target, before_json, after_json, created_at)
  SELECT NEW.request_id, 'ads.' || NEW.decision, NEW.subject, 'ad:' || c.id,
         json_object('status', c.status, 'starts_at', c.starts_at, 'ends_at', c.ends_at),
         json_object('status', CASE NEW.decision WHEN 'approve' THEN 'active' WHEN 'pause' THEN 'paused'
                         WHEN 'resume' THEN 'active' WHEN 'reject' THEN 'rejected' END,
                     'starts_at', CASE WHEN NEW.decision = 'approve' THEN NEW.starts_at ELSE c.starts_at END,
                     'ends_at', CASE WHEN NEW.decision = 'approve'
                         THEN strftime('%Y-%m-%dT%H:%M:%fZ', NEW.starts_at, '+' || c.term_days || ' days') ELSE c.ends_at END,
                     'domain', c.domain, 'slot', c.slot, 'slot_key', c.slot_key,
                     'headline', c.headline, 'body', c.body, 'note', NEW.note), NEW.now
    FROM ad_checkout_state c WHERE c.id = NEW.ad_id;

  UPDATE ads SET status = CASE NEW.decision WHEN 'approve' THEN 'active' WHEN 'pause' THEN 'paused'
                     WHEN 'resume' THEN 'active' WHEN 'reject' THEN 'rejected' END,
    starts_at = CASE WHEN NEW.decision = 'approve' THEN NEW.starts_at ELSE starts_at END,
    ends_at = CASE WHEN NEW.decision = 'approve' THEN strftime('%Y-%m-%dT%H:%M:%fZ', NEW.starts_at,
      '+' || (SELECT term_days FROM ad_checkouts WHERE ad_id = NEW.ad_id) || ' days') ELSE ends_at END
  WHERE id = NEW.ad_id;
  UPDATE ad_checkouts SET approval_request_id = CASE WHEN NEW.decision = 'approve'
      THEN NEW.request_id ELSE approval_request_id END, reviewed_at = NEW.now, review_note = NEW.note
  WHERE ad_id = NEW.ad_id;
END;

-- Each accepted event spends a unit of this shared UTC-day budget atomically
-- with the ad update. A refused event writes neither row.
CREATE TABLE IF NOT EXISTS ad_event_days (
  day TEXT PRIMARY KEY,
  events INTEGER NOT NULL CHECK (events BETWEEN 1 AND 2000)
);
CREATE VIEW IF NOT EXISTS ad_track_event (ad_id, kind, now) AS SELECT 0, '', '' WHERE 0;
CREATE TRIGGER IF NOT EXISTS ad_track_event_insert
INSTEAD OF INSERT ON ad_track_event BEGIN
  SELECT RAISE(IGNORE) WHERE NEW.kind NOT IN ('impression', 'click') OR NOT EXISTS (
    SELECT 1 FROM approved_ad_placements a WHERE a.id = NEW.ad_id
      AND a.starts_at <= NEW.now AND a.ends_at > NEW.now
  );
  INSERT INTO ad_event_days (day, events) VALUES (substr(NEW.now, 1, 10), 1)
    ON CONFLICT(day) DO UPDATE SET events = events + 1 WHERE events < 2000;
  SELECT RAISE(IGNORE) WHERE changes() = 0;
  UPDATE ads SET impressions = COALESCE(impressions, 0) + (NEW.kind = 'impression'),
                 clicks = COALESCE(clicks, 0) + (NEW.kind = 'click') WHERE id = NEW.ad_id;
END;

CREATE TABLE IF NOT EXISTS ad_reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ad_id INTEGER NOT NULL REFERENCES ads(id),
  domain TEXT NOT NULL,
  reason TEXT NOT NULL CHECK (reason IN ('misleading', 'spam', 'inappropriate', 'other')),
  detail TEXT NOT NULL CHECK (length(detail) <= 500),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved', 'dismissed')),
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ad_reports_day ON ad_reports(created_at);

-- Scoring release ledger, its append-only guard and its write view
-- (migrations/scoring-release.sql — identical statements, safe to re-apply).
-- Additive and safe to re-apply. The Worker validates the version against the
-- bundled engine; this ledger only stores notes and does not affect scoring.

CREATE TABLE IF NOT EXISTS scoring_releases (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  engine_version TEXT NOT NULL,
  notes TEXT NOT NULL,
  published_at TEXT NOT NULL,
  published_by TEXT NOT NULL,
  request_id TEXT NOT NULL UNIQUE REFERENCES admin_requests(request_id)
);
CREATE INDEX IF NOT EXISTS idx_scoring_releases_engine ON scoring_releases(engine_version, id);

CREATE TRIGGER IF NOT EXISTS scoring_releases_no_update
BEFORE UPDATE ON scoring_releases BEGIN
  SELECT RAISE(ABORT, 'scoring releases are append-only');
END;

CREATE TRIGGER IF NOT EXISTS scoring_releases_no_delete
BEFORE DELETE ON scoring_releases BEGIN
  SELECT RAISE(ABORT, 'scoring releases are append-only');
END;

-- REPLACE can bypass delete triggers when recursive triggers are disabled.
CREATE TRIGGER IF NOT EXISTS scoring_releases_no_replace
BEFORE INSERT ON scoring_releases
WHEN EXISTS (SELECT 1 FROM scoring_releases WHERE id = NEW.id OR request_id = NEW.request_id)
BEGIN
  SELECT RAISE(ABORT, 'scoring releases are append-only');
END;

CREATE VIEW IF NOT EXISTS admin_scoring_publish (request_id, subject, engine_version, notes) AS
  SELECT request_id, subject, '' AS engine_version, '' AS notes FROM admin_audit WHERE 0;

CREATE TRIGGER IF NOT EXISTS admin_scoring_publish_insert
INSTEAD OF INSERT ON admin_scoring_publish BEGIN
  -- The Worker reserves the id in the same batch as the view insert.
  SELECT RAISE(ABORT, 'scoring publication requires its admin request')
  WHERE NOT EXISTS (
    SELECT 1 FROM admin_requests
    WHERE request_id = NEW.request_id AND action = 'scoring.publish' AND subject = NEW.subject
  );

  -- Read the prior release for this engine inside the same statement as the
  -- new release, so the audit history stays correct for concurrent writes.
  INSERT INTO admin_audit (request_id, action, subject, target, before_json, after_json, created_at)
  VALUES (
    NEW.request_id, 'scoring.publish', NEW.subject, 'scoring:' || NEW.engine_version,
    (SELECT json_object('engine_version', r.engine_version, 'notes', r.notes, 'published_at', r.published_at)
     FROM scoring_releases r WHERE r.engine_version = NEW.engine_version ORDER BY r.id DESC LIMIT 1),
    json_object('engine_version', NEW.engine_version, 'notes', NEW.notes,
                'published_at', strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  );

  INSERT INTO scoring_releases (engine_version, notes, published_at, published_by, request_id)
  VALUES (NEW.engine_version, NEW.notes, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), NEW.subject, NEW.request_id);
END;
