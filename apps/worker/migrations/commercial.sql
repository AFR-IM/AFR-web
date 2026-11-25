-- M9 domain C — commerce: the Pro ledger's term column, the metadata of the
-- machine keys and the administrator's two commercial write paths.
--
-- Apply ONCE to an existing D1 database:
--   wrangler d1 execute aiapp --file apps/worker/migrations/commercial.sql --remote
-- A new database created from schema.sql already has the columns and the
-- views, and the statements below are the same ones schema.sql carries.
--
-- The three ALTER statements cannot be repeated (SQLite has no
-- "ADD COLUMN IF NOT EXISTS"); the CREATE statements below are idempotent.
-- Everything is additive: no column of an existing table is dropped or
-- rewritten, so a failed apply can simply be re-run after the ALTERs.

-- The length of the paid term belongs to the order: $12 buys 30 days of Pro.
-- A row without the column falls back to the default term.
ALTER TABLE billing_orders ADD COLUMN term_days INTEGER;

-- The site a machine key belongs to, and the last call that presented it.
ALTER TABLE api_keys ADD COLUMN domain TEXT;
ALTER TABLE api_keys ADD COLUMN last_used_at TEXT;

CREATE INDEX IF NOT EXISTS idx_api_keys_domain ON api_keys(domain, created_at DESC);

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
