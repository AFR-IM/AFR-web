-- owner-live-alerts.sql — the Pro owner tools that need columns:
--   · submissions.priority     — a Pro owner's rescan jumps the on-demand
--                                 queue (GET /api/v1/queue orders by it);
--   · notify_outbox.event_type — additions/removals of the directory are
--                                 their own event kind next to the free
--                                 score-change mail.
-- Both are additive. Apply BEFORE deploying the code that reads them:
--   wrangler d1 execute aiapp --file migrations/owner-live-alerts.sql --remote

ALTER TABLE submissions ADD COLUMN priority INTEGER NOT NULL DEFAULT 0;

ALTER TABLE notify_outbox ADD COLUMN event_type TEXT NOT NULL DEFAULT 'score_change';
