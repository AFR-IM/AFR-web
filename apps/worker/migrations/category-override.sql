-- category_override — a manual category that survives the rule-driven
-- backfill (SSOT item 18, known gap ①).
--
-- Two columns, two owners:
--   sites.category_id        the rule-derived category. scripts/categorize-backfill.mjs
--                            rewrites it from the keyword rules, so it always
--                            reflects what the rules say today.
--   sites.category_override the category a human decided in the admin console.
--                            NULL means "no manual decision".
--
-- The effective category is COALESCE(category_override, category_id) — every
-- read path in the worker uses it, and the reclassification trigger writes
-- the override column (never category_id), so the backfill can no longer
-- silently undo an operator's decision.
--
-- The public site pages (search index, category pages, detail pages) still
-- follow the rules: they are built from the data repo's snapshots, not from
-- D1. A manual label is therefore visible in the API, the badge and MCP;
-- publishing it on the site pages means putting the decision into the rule
-- table (the batch-review path) as well.

ALTER TABLE sites ADD COLUMN category_override INTEGER REFERENCES categories(id);

-- The reclassification trigger changes: it reads the effective category for
-- the audit row and writes the override column instead of category_id.
DROP TRIGGER IF EXISTS admin_site_reclassify_insert;

CREATE TRIGGER admin_site_reclassify_insert
INSTEAD OF INSERT ON admin_site_reclassify BEGIN
  INSERT INTO admin_audit (request_id, action, subject, target, before_json, after_json, created_at)
  SELECT NEW.request_id, 'reclassify', NEW.subject, 'site:' || s.domain,
         json_object('category_id', COALESCE(s.category_override, s.category_id), 'category_slug', c.slug),
         json_object('category_id', NEW.category_id, 'category_slug', NEW.category_slug),
         strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  FROM sites s LEFT JOIN categories c ON c.id = COALESCE(s.category_override, s.category_id)
  WHERE s.domain = NEW.domain AND COALESCE(s.category_override, s.category_id) IS NOT NEW.category_id;
  SELECT RAISE(IGNORE) WHERE changes() = 0;

  UPDATE sites SET category_override = NEW.category_id,
                   updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  WHERE domain = NEW.domain;
END;
