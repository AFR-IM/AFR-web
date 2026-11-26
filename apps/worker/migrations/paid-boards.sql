-- Apply after the billing, admin audit, ads and settings migrations. Safe to re-apply.
--
-- The two paid boards. Torch Boost (public donations that boost a
-- listed site) and the owner promo cards share the AIPAY billing ledger
-- (`billing_orders.purpose IN ('torch','promo')`) — this file only adds the
-- board-local rows, the moderation write paths and the donation registry.

-- ── Torch Boost ──────────────────────────────────────────────────────────────

-- One row per boost attempt. The binding code (8 chars, charset 32, no
-- 0/O/1/I) is the claim token of the order: status reads require it, and a
-- pending row stops answering for it after 15 minutes. `tx_hash` is UNIQUE
-- across the table so one on-chain transaction can never credit two boosts.
CREATE TABLE IF NOT EXISTS torch_purchases (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  domain TEXT NOT NULL,
  binding_code TEXT NOT NULL UNIQUE,
  merchant_order_id TEXT NOT NULL UNIQUE,
  amount TEXT NOT NULL,
  asset TEXT NOT NULL CHECK (asset = 'USDC'),
  chain_key TEXT NOT NULL CHECK (chain_key = 'base'),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'paid', 'review', 'cancelled')),
  tx_hash TEXT UNIQUE,
  paid_at TEXT,
  source TEXT CHECK (source IN ('webhook', 'scan', 'reconcile')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_torch_time ON torch_purchases(created_at, id);
CREATE INDEX IF NOT EXISTS idx_torch_domain ON torch_purchases(domain, created_at);
CREATE INDEX IF NOT EXISTS idx_torch_paid ON torch_purchases(paid_at, id);

-- All-time per-site aggregates for the badge and the leaderboard detail.
-- Rewritten from torch_purchases by the side-effect sweep (idempotent), so
-- it can never disagree with the purchase rows.
CREATE TABLE IF NOT EXISTS torch_totals (
  domain TEXT PRIMARY KEY,
  total_amount REAL NOT NULL,
  total_count INTEGER NOT NULL,
  first_at TEXT NOT NULL,
  last_at TEXT NOT NULL
);

-- ── Owner promo cards ────────────────────────────────────────────────────────

-- One live promo per domain (partial unique index below); a rebuy after
-- expiry is a new lifecycle on the same row family. `amount` is what the
-- buyer paid — half of `tier` while their site holds Pro.
CREATE TABLE IF NOT EXISTS detail_promos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  domain TEXT NOT NULL,
  tier INTEGER NOT NULL CHECK (tier IN (19, 49, 149)),
  term_days INTEGER NOT NULL CHECK (term_days IN (30, 90, 365)),
  amount TEXT NOT NULL,
  pro_half INTEGER NOT NULL DEFAULT 0 CHECK (pro_half IN (0, 1)),
  headline TEXT NOT NULL,
  body TEXT NOT NULL,
  status TEXT NOT NULL
    CHECK (status IN ('pending', 'paid', 'active', 'paused', 'expired', 'rejected', 'cancelled')),
  merchant_order_id TEXT NOT NULL UNIQUE,
  approval_request_id TEXT UNIQUE REFERENCES admin_requests(request_id),
  starts_at TEXT,
  ends_at TEXT,
  reviewed_at TEXT,
  review_note TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
-- At most one orderable/live promo per domain; terminal rows do not block a rebuy.
CREATE UNIQUE INDEX IF NOT EXISTS idx_promo_live ON detail_promos(domain)
  WHERE status IN ('pending', 'paid', 'active', 'paused');
CREATE INDEX IF NOT EXISTS idx_promo_status ON detail_promos(status, id);

-- ── Charity donation registry (append-only) ──────────────────────────────────

-- The outbound leg of the public ledger: every executed donation, its
-- on-chain transaction and the boost transactions it was funded by
-- (`funded_in_tx`, a JSON array of tx hashes) — the two directions of the
-- ledger point at each other. Rows are never updated and never deleted.
CREATE TABLE IF NOT EXISTS charity_donations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  amount TEXT NOT NULL,
  asset TEXT NOT NULL CHECK (asset = 'USDC'),
  chain_key TEXT NOT NULL CHECK (chain_key = 'base'),
  tx_hash TEXT NOT NULL UNIQUE,
  beneficiary TEXT NOT NULL,
  funded_in_tx TEXT NOT NULL DEFAULT '[]',
  note TEXT NOT NULL DEFAULT '',
  approval_request_id TEXT UNIQUE REFERENCES admin_requests(request_id),
  executed_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TRIGGER IF NOT EXISTS charity_donations_no_update
BEFORE UPDATE ON charity_donations BEGIN
  SELECT RAISE(ABORT, 'charity donations are append-only');
END;

CREATE TRIGGER IF NOT EXISTS charity_donations_no_delete
BEFORE DELETE ON charity_donations BEGIN
  SELECT RAISE(ABORT, 'charity donations are append-only');
END;

CREATE TRIGGER IF NOT EXISTS charity_donations_no_replace_pk
BEFORE INSERT ON charity_donations
WHEN EXISTS (SELECT 1 FROM charity_donations WHERE id = NEW.id) BEGIN
  SELECT RAISE(ABORT, 'charity donations are append-only');
END;

-- ── Write paths (business write + audit row in one statement) ────────────────

-- Moderate a paid promo: approve starts the term now, reject closes it. The
-- request must already claim ('promo.' || decision, subject) in
-- admin_requests; the audit row is written from the state read inside this
-- transaction, so a replay can never describe a second transition.
CREATE VIEW IF NOT EXISTS admin_promo_moderate
  (request_id, subject, promo_id, decision, note, now) AS
  SELECT '', '', 0, '', '', '' WHERE 0;

CREATE TRIGGER IF NOT EXISTS admin_promo_moderate_insert
INSTEAD OF INSERT ON admin_promo_moderate BEGIN
  SELECT RAISE(ABORT, 'promo_admin_request_required') WHERE NOT EXISTS (
    SELECT 1 FROM admin_requests
    WHERE request_id = NEW.request_id AND action = 'promo.' || NEW.decision AND subject = NEW.subject
  );
  SELECT RAISE(ABORT, 'promo_state_conflict') WHERE NOT EXISTS (
    SELECT 1 FROM detail_promos p
    WHERE p.id = NEW.promo_id AND (
      (NEW.decision = 'approve' AND p.status = 'paid' AND EXISTS (
        SELECT 1 FROM billing_orders b
        WHERE b.merchant_order_id = p.merchant_order_id
          AND b.purpose = 'promo' AND b.status = 'confirmed'
          AND b.aipay_confirmed_at IS NOT NULL AND b.tx_hash IS NOT NULL))
      OR (NEW.decision = 'reject' AND p.status = 'paid')
    )
  );

  INSERT INTO admin_audit (request_id, action, subject, target, before_json, after_json, created_at)
  SELECT NEW.request_id, 'promo.' || NEW.decision, NEW.subject, 'promo:' || p.id,
         json_object('status', p.status, 'starts_at', p.starts_at, 'ends_at', p.ends_at),
         json_object('status', CASE NEW.decision WHEN 'approve' THEN 'active' ELSE 'rejected' END,
                     'starts_at', CASE WHEN NEW.decision = 'approve' THEN NEW.now ELSE p.starts_at END,
                     'ends_at', CASE WHEN NEW.decision = 'approve'
                       THEN strftime('%Y-%m-%dT%H:%M:%fZ', NEW.now, '+' || p.term_days || ' days')
                       ELSE p.ends_at END,
                     'domain', p.domain, 'tier', p.tier, 'headline', p.headline,
                     'body', p.body, 'note', NEW.note), NEW.now
    FROM detail_promos p WHERE p.id = NEW.promo_id;

  UPDATE detail_promos SET
    status = CASE WHEN NEW.decision = 'approve' THEN 'active' ELSE 'rejected' END,
    starts_at = CASE WHEN NEW.decision = 'approve' THEN NEW.now ELSE starts_at END,
    ends_at = CASE WHEN NEW.decision = 'approve'
      THEN strftime('%Y-%m-%dT%H:%M:%fZ', NEW.now, '+' || term_days || ' days') ELSE ends_at END,
    approval_request_id = CASE WHEN NEW.decision = 'approve' THEN NEW.request_id ELSE approval_request_id END,
    reviewed_at = NEW.now,
    review_note = NEW.note,
    updated_at = NEW.now
  WHERE id = NEW.promo_id;
END;

-- Register one executed donation. The beneficiary must be a member of the
-- pre-vetted beneficiary list stored in admin_settings (fail-closed: no list, no
-- record), the transaction hash is unique and the row is append-only.
CREATE VIEW IF NOT EXISTS admin_charity_record
  (request_id, subject, amount, tx_hash, beneficiary, funded_in_tx, note, now) AS
  SELECT '', '', '', '', '', '', '', '' WHERE 0;

CREATE TRIGGER IF NOT EXISTS admin_charity_record_insert
INSTEAD OF INSERT ON admin_charity_record BEGIN
  SELECT RAISE(ABORT, 'charity_admin_request_required') WHERE NOT EXISTS (
    SELECT 1 FROM admin_requests
    WHERE request_id = NEW.request_id AND action = 'charity.record' AND subject = NEW.subject
  );
  SELECT RAISE(ABORT, 'charity_amount_invalid') WHERE NOT (
    length(NEW.amount) BETWEEN 1 AND 16
    AND NEW.amount GLOB '[0-9]*' AND NEW.amount NOT GLOB '*[^0-9.]*'
    AND NEW.amount NOT GLOB '*.*.*' AND CAST(NEW.amount AS REAL) > 0
  );
  SELECT RAISE(ABORT, 'charity_tx_invalid') WHERE NOT (
    length(NEW.tx_hash) BETWEEN 32 AND 128
    AND NEW.tx_hash = trim(NEW.tx_hash) AND NEW.tx_hash NOT GLOB '*[^A-Za-z0-9]*'
  );
  SELECT RAISE(ABORT, 'charity_tx_duplicate')
    WHERE EXISTS (SELECT 1 FROM charity_donations WHERE tx_hash = NEW.tx_hash);
  SELECT RAISE(ABORT, 'charity_funded_invalid') WHERE NOT json_valid(NEW.funded_in_tx);
  SELECT RAISE(ABORT, 'charity_beneficiary_unknown') WHERE NOT EXISTS (
    SELECT 1 FROM json_each(COALESCE(
      (SELECT value_json FROM admin_settings WHERE key = 'beneficiaries'), '[]'))
    WHERE json_extract(value, '$.name') = NEW.beneficiary
  );

  INSERT INTO admin_audit (request_id, action, subject, target, before_json, after_json, created_at)
  VALUES (NEW.request_id, 'charity.record', NEW.subject, 'charity:donation', NULL,
          json_object('amount', NEW.amount, 'tx_hash', NEW.tx_hash,
                      'beneficiary', NEW.beneficiary, 'funded_in_tx', json(NEW.funded_in_tx),
                      'note', NEW.note), NEW.now);

  INSERT INTO charity_donations
    (amount, asset, chain_key, tx_hash, beneficiary, funded_in_tx, note, approval_request_id, executed_at, created_at)
  VALUES (NEW.amount, 'USDC', 'base', NEW.tx_hash, NEW.beneficiary, NEW.funded_in_tx,
          NEW.note, NEW.request_id, NEW.now, NEW.now);
END;
