-- Pro subscription terms: append-only entitlement event log.
-- Safe to run repeatedly (CREATE ... IF NOT EXISTS only).
--
-- The current state of a subject is *derived* by replaying its events in id
-- order; no mutable "current entitlement" row exists. Granting stays limited to
-- confirmed Pro orders in the local AIPAY ledger (billing_orders), and only an
-- explicit revoke event ends a term — a ledger rollback never takes Pro back.
--
-- NOTE: the older `pro_entitlements` table stays in the schema for stability
-- but is no longer written and is not a source of truth.
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
