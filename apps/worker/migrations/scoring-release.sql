-- Scoring-engine release notes. Apply after admin-domains.sql and before deployment.
-- Additive and safe to re-apply. The Worker validates the version against the
-- bundled engine; this ledger only stores notes and does not affect scoring.

CREATE TABLE IF NOT EXISTS scoring_releases (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  engine_version TEXT NOT NULL,
  notes TEXT NOT NULL,
  published_at TEXT NOT NULL,
  published_by TEXT NOT NULL,
  request_id TEXT NOT NULL UNIQUE REFERENCES admin_requests(request_id)
);
CREATE INDEX IF NOT EXISTS idx_scoring_releases_engine ON scoring_releases(engine_version, id);

CREATE TRIGGER IF NOT EXISTS scoring_releases_no_update
BEFORE UPDATE ON scoring_releases BEGIN
  SELECT RAISE(ABORT, 'scoring releases are append-only');
END;

CREATE TRIGGER IF NOT EXISTS scoring_releases_no_delete
BEFORE DELETE ON scoring_releases BEGIN
  SELECT RAISE(ABORT, 'scoring releases are append-only');
END;

-- REPLACE can bypass delete triggers when recursive triggers are disabled.
CREATE TRIGGER IF NOT EXISTS scoring_releases_no_replace
BEFORE INSERT ON scoring_releases
WHEN EXISTS (SELECT 1 FROM scoring_releases WHERE id = NEW.id OR request_id = NEW.request_id)
BEGIN
  SELECT RAISE(ABORT, 'scoring releases are append-only');
END;

CREATE VIEW IF NOT EXISTS admin_scoring_publish (request_id, subject, engine_version, notes) AS
  SELECT request_id, subject, '' AS engine_version, '' AS notes FROM admin_audit WHERE 0;

CREATE TRIGGER IF NOT EXISTS admin_scoring_publish_insert
INSTEAD OF INSERT ON admin_scoring_publish BEGIN
  -- The Worker reserves the id in the same batch as the view insert.
  SELECT RAISE(ABORT, 'scoring publication requires its admin request')
  WHERE NOT EXISTS (
    SELECT 1 FROM admin_requests
    WHERE request_id = NEW.request_id AND action = 'scoring.publish' AND subject = NEW.subject
  );

  -- Read the prior release for this engine inside the same statement as the
  -- new release, so the audit history stays correct for concurrent writes.
  INSERT INTO admin_audit (request_id, action, subject, target, before_json, after_json, created_at)
  VALUES (
    NEW.request_id, 'scoring.publish', NEW.subject, 'scoring:' || NEW.engine_version,
    (SELECT json_object('engine_version', r.engine_version, 'notes', r.notes, 'published_at', r.published_at)
     FROM scoring_releases r WHERE r.engine_version = NEW.engine_version ORDER BY r.id DESC LIMIT 1),
    json_object('engine_version', NEW.engine_version, 'notes', NEW.notes,
                'published_at', strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  );

  INSERT INTO scoring_releases (engine_version, notes, published_at, published_by, request_id)
  VALUES (NEW.engine_version, NEW.notes, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), NEW.subject, NEW.request_id);
END;
