-- aiapp.im D1 schema (SQLite dialect)
-- Source: spec v1.0 §6.1 (sites/scans/evidence/owners/submissions/claims/
-- categories/api_keys) + spec v1.2 §6.1 (ads table + idx_ads_slot).
-- Apply: wrangler d1 execute aiapp --file schema.sql --remote

-- Categories (spec §7: 14 top-level categories + free-form second-level tags)
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

-- Ad slots (spec v1.2 §6.1)
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
