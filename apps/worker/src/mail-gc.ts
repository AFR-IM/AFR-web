// src/mail-gc.ts — housekeeping for the mail tables.
//
// The mail subsystem writes to D1, and D1's daily row-write budget is the
// scarce resource on the free tier (a single scan round already costs tens of
// thousands of writes). Rows that are no longer useful must therefore not
// accumulate: expired challenges, delivered notifications, read inbox mail and
// cooldown records.
//
// Every delete is bounded. A cleanup that removes rows in bulk would itself
// spend the budget it is trying to protect.

import type { Db } from './db.ts';

/** How many rows one statement may remove. */
const DELETE_BATCH = 200;

export interface PruneOptions {
  now?: () => Date;
  /** Inbound mail is kept this long (days). */
  inboundRetentionDays?: number;
  /** Delivered/failed notifications are kept this long (days). */
  outboxRetentionDays?: number;
  /** Cooldown records are kept this long (days). */
  cooldownRetentionDays?: number;
}

export interface PruneResult {
  challenges: number;
  inboundMail: number;
  inboundActions: number;
  outbox: number;
  cooldown: number;
}

function daysAgo(now: Date, days: number): string {
  return new Date(now.getTime() - days * 24 * 60 * 60 * 1000).toISOString();
}

/**
 * Remove the rows that are no longer needed.
 *
 * The deletes are ordered cheapest-first and each one is capped, so a table
 * with a backlog is cleaned over several runs instead of in one expensive
 * statement.
 */
export async function pruneMailArtifacts(
  db: Db,
  opts: PruneOptions = {},
): Promise<PruneResult> {
  const now = opts.now?.() ?? new Date();
  const inboundCutoff = daysAgo(now, opts.inboundRetentionDays ?? 30);
  const outboxCutoff = daysAgo(now, opts.outboxRetentionDays ?? 30);
  const cooldownCutoff = daysAgo(now, opts.cooldownRetentionDays ?? 7);
  const result: PruneResult = {
    challenges: 0,
    inboundMail: 0,
    inboundActions: 0,
    outbox: 0,
    cooldown: 0,
  };

  const run = async (sql: string, ...params: (string | number | null)[]): Promise<number> => {
    try {
      const res = await db.prepare(sql).run(...params);
      return res.changes ?? 0;
    } catch (err) {
      // Housekeeping must never break the job that called it.
      console.warn(
        `mail gc: ${err instanceof Error ? err.message : String(err)}`,
      );
      return 0;
    }
  };

  result.challenges = await run(
    `DELETE FROM email_challenges WHERE id IN (
       SELECT id FROM email_challenges WHERE expires_at < ? LIMIT ${DELETE_BATCH}
     )`,
    now.toISOString(),
  );
  result.inboundActions = await run(
    `DELETE FROM inbound_actions WHERE id IN (
       SELECT id FROM inbound_actions WHERE created_at < ? LIMIT ${DELETE_BATCH}
     )`,
    inboundCutoff,
  );
  result.inboundMail = await run(
    `DELETE FROM inbound_mail WHERE id IN (
       SELECT id FROM inbound_mail WHERE received_at < ? LIMIT ${DELETE_BATCH}
     )`,
    inboundCutoff,
  );
  result.outbox = await run(
    `DELETE FROM notify_outbox WHERE id IN (
       SELECT id FROM notify_outbox
       WHERE status IN ('sent', 'failed') AND created_at < ? LIMIT ${DELETE_BATCH}
     )`,
    outboxCutoff,
  );
  result.cooldown = await run(
    // mail_cooldown is keyed by recipient_hash, so the rowid is used here.
    `DELETE FROM mail_cooldown WHERE rowid IN (
       SELECT rowid FROM mail_cooldown WHERE last_sent_at < ? LIMIT ${DELETE_BATCH}
     )`,
    cooldownCutoff,
  );

  return result;
}
