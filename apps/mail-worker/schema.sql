-- Inbound mail for afr.im (Cloudflare Email Routing -> this Worker).
CREATE TABLE IF NOT EXISTS inbound_mail (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sender TEXT NOT NULL,
  recipient TEXT NOT NULL,
  subject TEXT,
  body TEXT,                  -- plain-text body, truncated to 8000 chars
  links TEXT,                 -- JSON array string of links (max 20)
  headers TEXT,               -- JSON string of selected headers
  message_id TEXT,
  received_at TEXT NOT NULL,
  processed_at TEXT,
  processed_note TEXT
);
CREATE INDEX IF NOT EXISTS idx_inbound_mail_received ON inbound_mail(received_at DESC);
CREATE INDEX IF NOT EXISTS idx_inbound_mail_sender ON inbound_mail(sender);

-- Automatic actions taken on inbound mail (audit trail).
CREATE TABLE IF NOT EXISTS inbound_actions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  mail_id INTEGER NOT NULL,
  action TEXT NOT NULL,        -- e.g. 'visit_link'
  target_url TEXT,
  result TEXT,                 -- short summary (max 200 chars)
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_inbound_actions_mail ON inbound_actions(mail_id);
