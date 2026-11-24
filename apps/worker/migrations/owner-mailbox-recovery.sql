-- Management-token recovery store (owner lost the management token).
--
-- Safe to run repeatedly: every statement is CREATE ... IF NOT EXISTS.
-- Apply once to an existing D1 database:
--   wrangler d1 execute aiapp --file apps/worker/migrations/owner-mailbox-recovery.sql --remote
-- New databases created from schema.sql already include the table.
--
-- Only hashes are stored: the address as a keyed HMAC, the recovery token as
-- a SHA-256. The plaintext token exists once — in the mail that carries the
-- recovery link.
CREATE TABLE IF NOT EXISTS owner_mailbox_recoveries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  domain TEXT NOT NULL,
  email_hash TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_owner_mailbox_recoveries_domain ON owner_mailbox_recoveries(domain);
