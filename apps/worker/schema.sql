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
  done_at TEXT                           -- set by POST /api/v1/queue/:domain/done
);

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
  tier TEXT DEFAULT 'free',              -- free/pro
  created_at TEXT,
  revoked_at TEXT
);

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
