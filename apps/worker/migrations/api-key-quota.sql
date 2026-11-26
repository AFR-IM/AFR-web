-- UTC usage counters for machine API keys. Apply before publishing the worker:
--   wrangler d1 execute aiapp --file apps/worker/migrations/api-key-quota.sql --remote
-- Requires the owner-domain column from commercial.sql.
--
-- The historical key_hash column stores either 'domain:<domain>' for owner
-- keys, or the raw hash for keys without an owner. Each accepted request
-- writes two rows. An exhausted quota writes none.
--
-- The pre-existing KV counter is not imported. If the earlier D1 counter
-- was already used, carry its quota forward across all keys for each domain,
-- including revoked keys. Keep the source rows so reruns can use the same
-- sum and raise the destination to that total without double-counting.

CREATE TABLE IF NOT EXISTS api_key_usage (
  key_hash   TEXT NOT NULL,
  period     TEXT NOT NULL,  -- 'd:YYYY-MM-DD' (UTC day) or 'm:YYYY-MM' (UTC month)
  used       INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (key_hash, period)
);

INSERT INTO api_key_usage (key_hash, period, used, updated_at)
SELECT 'domain:' || LOWER(TRIM(keys.domain)), usage.period, SUM(usage.used), MAX(usage.updated_at)
FROM api_key_usage AS usage
JOIN api_keys AS keys ON keys.key_hash = usage.key_hash
WHERE TRIM(keys.domain) <> ''
GROUP BY LOWER(TRIM(keys.domain)), usage.period
ON CONFLICT (key_hash, period) DO UPDATE SET
  used = excluded.used,
  updated_at = MAX(api_key_usage.updated_at, excluded.updated_at)
WHERE excluded.used > api_key_usage.used;
