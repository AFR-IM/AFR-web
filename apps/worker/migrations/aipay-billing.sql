-- Additive AIPAY billing ledger migration. Safe to run repeatedly.
-- Entitlements must be derived from this local ledger, never directly from a
-- browser return URL or an unverified webhook.
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
