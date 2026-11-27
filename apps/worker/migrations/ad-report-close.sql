-- Close an advertising report from the console (resolve / dismiss): a
-- write-only view plus its INSTEAD OF INSERT trigger, in the same shape as
-- admin_ad_moderate (ads.sql) and admin_ticket_close (admin-domains.sql).
--
-- The trigger only acts for a request id already claimed in admin_requests
-- with the matching action (`ads.report_<decision>`) and subject; the claim,
-- the status change and the audit row land in one transaction. A report that
-- does not exist or is no longer open aborts with ad_report_state_conflict,
-- so two operators cannot both close the same report.
--
-- Additive and safe to re-apply. apps/worker/schema.sql carries the same
-- objects for a fresh database (both must stay identical).

CREATE VIEW IF NOT EXISTS admin_ad_report_close
  (request_id, subject, report_id, decision, note, now) AS
  SELECT '', '', 0, '', '', '' WHERE 0;

CREATE TRIGGER IF NOT EXISTS admin_ad_report_close_insert
INSTEAD OF INSERT ON admin_ad_report_close BEGIN
  SELECT RAISE(ABORT, 'ad_report_decision_invalid') WHERE NEW.decision NOT IN ('resolve', 'dismiss');
  SELECT RAISE(ABORT, 'ad_admin_request_required') WHERE NOT EXISTS (
    SELECT 1 FROM admin_requests
    WHERE request_id = NEW.request_id AND action = 'ads.report_' || NEW.decision AND subject = NEW.subject
  );
  SELECT RAISE(ABORT, 'ad_report_state_conflict') WHERE NOT EXISTS (
    SELECT 1 FROM ad_reports WHERE id = NEW.report_id AND status = 'open'
  );

  INSERT INTO admin_audit (request_id, action, subject, target, before_json, after_json, created_at)
  SELECT NEW.request_id, 'ads.report_' || NEW.decision, NEW.subject, 'ad_report:' || r.id,
         json_object('status', r.status),
         json_object('status', CASE NEW.decision WHEN 'resolve' THEN 'resolved' ELSE 'dismissed' END,
                     'domain', r.domain, 'reason', r.reason, 'note', NEW.note),
         NEW.now
  FROM ad_reports r WHERE r.id = NEW.report_id;

  UPDATE ad_reports SET status = CASE NEW.decision WHEN 'resolve' THEN 'resolved' ELSE 'dismissed' END
  WHERE id = NEW.report_id AND status = 'open';
END;
