-- Apply after the billing and admin audit migrations. Safe to re-apply.
-- Existing advertising rows are retained and have no checkout or approval.
CREATE VIEW IF NOT EXISTS ad_offers (slot, amount, term_days, capacity, available) AS
  SELECT 'category-top', 49, 30, 3, 1 UNION ALL
  SELECT 'search-top', 99, 30, 1, 1 UNION ALL
  SELECT 'home-supporter', 199, 30, 8, 1 UNION ALL
  SELECT 'report-sponsor', 999, 360, 1, 0;

CREATE TABLE IF NOT EXISTS ad_checkouts (
  ad_id INTEGER PRIMARY KEY REFERENCES ads(id),
  merchant_order_id TEXT NOT NULL UNIQUE,
  amount TEXT NOT NULL,
  asset TEXT NOT NULL CHECK (asset = 'USDC'),
  chain_key TEXT NOT NULL CHECK (chain_key = 'base'),
  term_days INTEGER NOT NULL CHECK (term_days BETWEEN 30 AND 360 AND term_days % 30 = 0),
  approval_request_id TEXT UNIQUE REFERENCES admin_requests(request_id),
  reviewed_at TEXT,
  review_note TEXT
);
CREATE INDEX IF NOT EXISTS idx_ads_ends ON ads(ends_at, id) WHERE status IN ('active', 'paused');

CREATE VIEW IF NOT EXISTS ad_checkout_state AS
  SELECT a.id, a.domain, a.slot, a.slot_key, a.headline, a.body, a.starts_at, a.ends_at,
         a.status, a.impressions, a.clicks, a.created_at,
         c.merchant_order_id, c.amount, c.asset, c.chain_key, c.term_days,
         c.approval_request_id, c.reviewed_at, c.review_note,
         b.status AS billing_status, b.aipay_reference, b.checkout_url, b.expires_at AS checkout_expires_at,
         CASE WHEN b.aipay_reference IS NOT NULL AND b.status = 'confirmed'
                   AND b.aipay_confirmed_at IS NOT NULL AND b.tx_hash IS NOT NULL
                   AND EXISTS (
                     SELECT 1 FROM billing_events e
                     WHERE e.merchant_order_id = b.merchant_order_id
                       AND e.source IN ('webhook', 'reconcile')
                       AND e.event_type = 'order.confirmed' AND e.after_status = 'confirmed'
                   ) THEN 1 ELSE 0 END AS paid,
         CASE WHEN b.status IN ('cancelled', 'expired') AND EXISTS (
                     SELECT 1 FROM billing_events e
                     WHERE e.merchant_order_id = b.merchant_order_id
                       AND e.source IN ('webhook', 'reconcile')
                       AND e.event_type = 'order.' || b.status AND e.after_status = b.status
                   ) THEN 1 ELSE 0 END AS checkout_closed,
         CASE WHEN EXISTS (
                     SELECT 1 FROM admin_audit au
                     WHERE au.request_id = c.approval_request_id
                       AND au.action = 'ads.approve' AND au.target = 'ad:' || a.id
                       AND json_extract(au.after_json, '$.starts_at') = a.starts_at
                       AND json_extract(au.after_json, '$.ends_at') = a.ends_at
                       AND json_extract(au.after_json, '$.domain') = a.domain
                       AND json_extract(au.after_json, '$.slot') = a.slot
                       AND json_extract(au.after_json, '$.slot_key') IS a.slot_key
                       AND json_extract(au.after_json, '$.headline') = a.headline
                       AND json_extract(au.after_json, '$.body') = a.body
                   ) THEN 1 ELSE 0 END AS approved,
         o.capacity,
         s.grade, s.score_total AS score,
         CASE WHEN s.status = 'active' AND s.grade IN ('A', 'B', 'C', 'D', 'E', 'F')
                   AND typeof(s.score_total) IN ('real', 'integer') AND s.score_total BETWEEN 0 AND 100
                   AND o.available = 1
                   AND ((a.slot = 'home-supporter' AND a.slot_key IS NULL)
                     OR (a.slot = 'search-top' AND length(a.slot_key) BETWEEN 1 AND 80)
                     OR (a.slot = 'category-top' AND EXISTS (SELECT 1 FROM categories WHERE slug = a.slot_key)))
              THEN 1 ELSE 0 END AS eligible_site
    FROM ads a JOIN ad_checkouts c ON c.ad_id = a.id
    JOIN ad_offers o ON o.slot = a.slot
    LEFT JOIN sites s ON s.domain = a.domain
    LEFT JOIN billing_orders b ON b.merchant_order_id = c.merchant_order_id
      AND b.purpose = 'ad' AND b.subject_id = a.domain AND b.amount = c.amount
      AND b.asset = c.asset AND b.chain_key = c.chain_key AND b.term_days = c.term_days
   WHERE c.amount = CAST(o.amount * (c.term_days / o.term_days) AS TEXT)
     AND c.term_days % o.term_days = 0;

CREATE VIEW IF NOT EXISTS approved_ad_placements AS
  SELECT id, domain, slot, slot_key, headline, body, starts_at, ends_at, status,
         impressions, clicks, grade, score
    FROM ad_checkout_state
   WHERE paid = 1 AND approved = 1 AND eligible_site = 1 AND status = 'active'
     AND starts_at = strftime('%Y-%m-%dT%H:%M:%fZ', starts_at)
     AND ends_at = strftime('%Y-%m-%dT%H:%M:%fZ', starts_at, '+' || term_days || ' days');

-- Paid applications and uncertain provider responses keep their seats, as do
-- future or paused placements until their terms end. Only verified provider
-- terminal states may release unpaid checkouts.
CREATE VIEW IF NOT EXISTS ad_slot_holds AS
  SELECT id, domain, slot, slot_key, NULL AS hold_until FROM ad_checkout_state
   WHERE status = 'pending' AND checkout_closed = 0
  UNION ALL
  SELECT id, domain, slot, slot_key, ends_at AS hold_until FROM ad_checkout_state
   WHERE status IN ('active', 'paused') AND approved = 1;

CREATE VIEW IF NOT EXISTS ad_checkout_apply
  (merchant_order_id, domain, slot, slot_key, headline, body, amount, asset, chain_key, term_days, created_at) AS
  SELECT '', '', '', NULL, '', '', '', '', '', 0, '' WHERE 0;

CREATE TRIGGER IF NOT EXISTS ad_checkout_apply_insert
INSTEAD OF INSERT ON ad_checkout_apply BEGIN
  -- Duplicate requests are resolved by the Worker against the original input.
  SELECT RAISE(IGNORE) WHERE EXISTS (
    SELECT 1 FROM ad_checkouts WHERE merchant_order_id = NEW.merchant_order_id
  );
  SELECT RAISE(ABORT, 'ad_request_conflict') WHERE EXISTS (
    SELECT 1 FROM billing_orders WHERE merchant_order_id = NEW.merchant_order_id
  );
  SELECT RAISE(ABORT, 'ad_checkout_ineligible') WHERE NOT EXISTS (
    SELECT 1 FROM sites s, ad_offers o
    WHERE s.domain = NEW.domain AND s.status = 'active' AND s.grade IN ('A', 'B', 'C', 'D', 'E', 'F')
      AND typeof(s.score_total) IN ('real', 'integer') AND s.score_total BETWEEN 0 AND 100
      AND o.slot = NEW.slot AND o.available = 1 AND NEW.term_days % o.term_days = 0
      AND NEW.amount = CAST(o.amount * (CAST(NEW.term_days AS INTEGER) / o.term_days) AS TEXT)
      AND ((NEW.slot = 'home-supporter' AND NEW.slot_key IS NULL)
        OR (NEW.slot = 'search-top' AND length(NEW.slot_key) BETWEEN 1 AND 80)
        OR (NEW.slot = 'category-top' AND EXISTS (SELECT 1 FROM categories WHERE slug = NEW.slot_key)))
  );
  SELECT RAISE(ABORT, 'ad_order_pending') WHERE EXISTS (
    SELECT 1 FROM ad_slot_holds
    WHERE domain = NEW.domain AND slot = NEW.slot AND slot_key IS NEW.slot_key
      AND (hold_until IS NULL OR hold_until > NEW.created_at)
  );
  SELECT RAISE(ABORT, 'ad_slot_full') WHERE (
    SELECT count(*) FROM ad_slot_holds
    WHERE slot = NEW.slot AND slot_key IS NEW.slot_key AND (hold_until IS NULL OR hold_until > NEW.created_at)
  ) >= (SELECT capacity FROM ad_offers WHERE slot = NEW.slot);

  INSERT INTO ads (domain, slot, slot_key, headline, body, status, created_at)
  VALUES (NEW.domain, NEW.slot, NEW.slot_key, NEW.headline, NEW.body, 'pending', NEW.created_at);
  INSERT INTO ad_checkouts (ad_id, merchant_order_id, amount, asset, chain_key, term_days)
  VALUES (last_insert_rowid(), NEW.merchant_order_id, NEW.amount, NEW.asset, NEW.chain_key, NEW.term_days);
END;

CREATE VIEW IF NOT EXISTS admin_ad_moderate (request_id, subject, ad_id, decision, starts_at, note, now) AS
  SELECT '', '', 0, '', '', '', '' WHERE 0;

CREATE TRIGGER IF NOT EXISTS admin_ad_moderate_insert
INSTEAD OF INSERT ON admin_ad_moderate BEGIN
  SELECT RAISE(ABORT, 'ad_admin_request_required') WHERE NOT EXISTS (
    SELECT 1 FROM admin_requests
    WHERE request_id = NEW.request_id AND action = 'ads.' || NEW.decision AND subject = NEW.subject
  );
  SELECT RAISE(ABORT, 'ad_state_conflict') WHERE NOT EXISTS (
    SELECT 1 FROM ad_checkout_state c
    WHERE c.id = NEW.ad_id AND (
      (NEW.decision = 'approve' AND c.status = 'pending' AND c.paid = 1 AND c.eligible_site = 1
        AND NEW.starts_at >= NEW.now AND NEW.starts_at = strftime('%Y-%m-%dT%H:%M:%fZ', NEW.starts_at)
        AND strftime('%Y-%m-%dT%H:%M:%fZ', NEW.starts_at, '+' || c.term_days || ' days') IS NOT NULL)
      OR (NEW.decision = 'reject' AND c.status = 'pending' AND c.paid = 1)
      OR (NEW.decision = 'pause' AND c.status = 'active' AND c.approved = 1 AND c.ends_at > NEW.now)
      OR (NEW.decision = 'resume' AND c.status = 'paused' AND c.approved = 1
        AND c.paid = 1 AND c.eligible_site = 1 AND c.ends_at > NEW.now)
    )
  );
  SELECT RAISE(ABORT, 'ad_slot_full') WHERE NEW.decision IN ('approve', 'resume') AND EXISTS (
    SELECT 1 FROM ad_checkout_state c WHERE c.id = NEW.ad_id AND (
      SELECT count(*) FROM ad_slot_holds h
      WHERE h.id != c.id AND h.slot = c.slot AND h.slot_key IS c.slot_key
        AND (h.hold_until IS NULL OR h.hold_until > NEW.now)
    ) >= c.capacity
  );

  INSERT INTO admin_audit (request_id, action, subject, target, before_json, after_json, created_at)
  SELECT NEW.request_id, 'ads.' || NEW.decision, NEW.subject, 'ad:' || c.id,
         json_object('status', c.status, 'starts_at', c.starts_at, 'ends_at', c.ends_at),
         json_object('status', CASE NEW.decision WHEN 'approve' THEN 'active' WHEN 'pause' THEN 'paused'
                         WHEN 'resume' THEN 'active' WHEN 'reject' THEN 'rejected' END,
                     'starts_at', CASE WHEN NEW.decision = 'approve' THEN NEW.starts_at ELSE c.starts_at END,
                     'ends_at', CASE WHEN NEW.decision = 'approve'
                         THEN strftime('%Y-%m-%dT%H:%M:%fZ', NEW.starts_at, '+' || c.term_days || ' days') ELSE c.ends_at END,
                     'domain', c.domain, 'slot', c.slot, 'slot_key', c.slot_key,
                     'headline', c.headline, 'body', c.body, 'note', NEW.note), NEW.now
    FROM ad_checkout_state c WHERE c.id = NEW.ad_id;

  UPDATE ads SET status = CASE NEW.decision WHEN 'approve' THEN 'active' WHEN 'pause' THEN 'paused'
                     WHEN 'resume' THEN 'active' WHEN 'reject' THEN 'rejected' END,
    starts_at = CASE WHEN NEW.decision = 'approve' THEN NEW.starts_at ELSE starts_at END,
    ends_at = CASE WHEN NEW.decision = 'approve' THEN strftime('%Y-%m-%dT%H:%M:%fZ', NEW.starts_at,
      '+' || (SELECT term_days FROM ad_checkouts WHERE ad_id = NEW.ad_id) || ' days') ELSE ends_at END
  WHERE id = NEW.ad_id;
  UPDATE ad_checkouts SET approval_request_id = CASE WHEN NEW.decision = 'approve'
      THEN NEW.request_id ELSE approval_request_id END, reviewed_at = NEW.now, review_note = NEW.note
  WHERE ad_id = NEW.ad_id;
END;

-- Each accepted event spends a unit of this shared UTC-day budget atomically
-- with the ad update. A refused event writes neither row.
CREATE TABLE IF NOT EXISTS ad_event_days (
  day TEXT PRIMARY KEY,
  events INTEGER NOT NULL CHECK (events BETWEEN 1 AND 2000)
);
CREATE VIEW IF NOT EXISTS ad_track_event (ad_id, kind, now) AS SELECT 0, '', '' WHERE 0;
CREATE TRIGGER IF NOT EXISTS ad_track_event_insert
INSTEAD OF INSERT ON ad_track_event BEGIN
  SELECT RAISE(IGNORE) WHERE NEW.kind NOT IN ('impression', 'click') OR NOT EXISTS (
    SELECT 1 FROM approved_ad_placements a WHERE a.id = NEW.ad_id
      AND a.starts_at <= NEW.now AND a.ends_at > NEW.now
  );
  INSERT INTO ad_event_days (day, events) VALUES (substr(NEW.now, 1, 10), 1)
    ON CONFLICT(day) DO UPDATE SET events = events + 1 WHERE events < 2000;
  SELECT RAISE(IGNORE) WHERE changes() = 0;
  UPDATE ads SET impressions = COALESCE(impressions, 0) + (NEW.kind = 'impression'),
                 clicks = COALESCE(clicks, 0) + (NEW.kind = 'click') WHERE id = NEW.ad_id;
END;

CREATE TABLE IF NOT EXISTS ad_reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ad_id INTEGER NOT NULL REFERENCES ads(id),
  domain TEXT NOT NULL,
  reason TEXT NOT NULL CHECK (reason IN ('misleading', 'spam', 'inappropriate', 'other')),
  detail TEXT NOT NULL CHECK (length(detail) <= 500),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved', 'dismissed')),
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ad_reports_day ON ad_reports(created_at);
