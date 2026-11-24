-- One grant per source order. No cascading link to mutable billing state.
CREATE TABLE IF NOT EXISTS pro_entitlements (
  source_merchant_order_id TEXT NOT NULL PRIMARY KEY,
  subject_id TEXT NOT NULL CHECK (trim(subject_id) <> ''),
  granted_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pro_entitlements_subject ON pro_entitlements(subject_id);
