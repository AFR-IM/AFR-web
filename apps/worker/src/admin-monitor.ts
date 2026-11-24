// src/admin-monitor.ts — the monitoring board of the administrator console
// (SSOT item 18, domain D). One read-only snapshot of the numbers an operator
// needs to see at a glance:
//
//   - listed      how many sites are listed and how many arrived recently
//   - backlog     how deep the submission queue is and how fast it drains
//   - conversion  how many sites are owner-verified
//   - referrers   which hosts embed our badge
//   - cron        whether the scheduled jobs still report, and what they said
//
// The board is derived, never authoritative: every number is a COUNT over the
// production tables. Nothing here mutates a site, a submission or a job.
//
// Time handling: every window is computed in UTC. "Recent" means calendar days
// that include today, so the 7-day window is [today-6, today] and the 30-day
// window is [today-29, today]. Rows with a NULL timestamp are never counted.

import { html } from 'hono/html';
import type { HtmlEscapedString } from 'hono/utils/html';
import { adminAlert, adminNav, adminPanel, adminStat, adminTable } from './admin-ui.ts';
import type { Db } from './db.ts';

/** hono's `h` is typed as possibly async; the board never nests async
 * components, so the sync result is asserted once here. */
const h = (strings: TemplateStringsArray, ...values: unknown[]): HtmlEscapedString =>
  html(strings, ...values) as HtmlEscapedString;

/** The scheduled jobs the board expects to hear from: the three GitHub
 * Actions workflows and the worker's own daily cron. */
export const EXPECTED_CRON_JOBS = ['scan', 'sync-site', 'weekly-scan', 'worker.daily'] as const;

/** A job whose last successful run is older than this raises a warning. */
export const STALE_CRON_HOURS = 30;
/**
 * How long a job may stay silent before the board warns. A daily job is
 * expected every day; the weekly job runs once a week, so the same 30 hours
 * would warn about a perfectly healthy schedule.
 */
export const STALE_CRON_HOURS_BY_JOB: Record<string, number> = {
  'weekly-scan': 8 * 24,
};

/** The queue states that count as backlog. */
const BACKLOG_STATUSES = ['queued', 'pending', 'scanning'];

/** The queue states that count as finished work. */
const DONE_STATUSES = ['scanned', 'done'];

/** The badge referrer rows of the last N days, capped. */
const REFERRER_DAYS = 7;
const REFERRER_LIMIT = 20;

/** The daily completion series covers this many days. */
const DONE_SERIES_DAYS = 7;

const DAY_MS = 86400000;
const HOUR_MS = 3600000;

export interface MonitorBoard {
  listed: {
    total: number;
    active: number;
    pending: number;
    declined: number;
    delisted: number;
    new7: number;
    new30: number;
  };
  backlog: {
    count: number;
    ratio: number;
    oldestHours: number | null;
    donePerDay: { day: string; done: number }[];
  };
  conversion: {
    verifiedSites: number;
    owners: number;
    mailboxes: number;
    ratio: number;
  };
  referrers: { day: string; host: string; hits: number }[];
  cron: {
    job: string;
    status: string;
    run_id: string | null;
    detail: string | null;
    started_at: string;
    finished_at: string;
  }[];
  alerts: { job: string; level: 'error' | 'warn'; reason: string }[];
}

// ---------------------------------------------------------------------------
// Time helpers
// ---------------------------------------------------------------------------

/** The UTC calendar day of an instant, as `YYYY-MM-DD`. */
function utcDay(at: Date): string {
  return at.toISOString().slice(0, 10);
}

/** Shift a `YYYY-MM-DD` day by a number of days (negative moves back). */
function shiftDay(day: string, deltaDays: number): string {
  const base = Date.parse(`${day}T00:00:00.000Z`);
  if (!Number.isFinite(base)) return day;
  return new Date(base + deltaDays * DAY_MS).toISOString().slice(0, 10);
}

/** The last N calendar days (including today), oldest first. */
function dayWindow(today: string, days: number): string[] {
  const out: string[] = [];
  for (let i = days - 1; i >= 0; i--) out.push(shiftDay(today, -i));
  return out;
}

/** A ratio rounded to four decimals; an empty denominator yields 0. */
function ratio(numerator: number, denominator: number): number {
  if (!denominator) return 0;
  return Math.round((numerator / denominator) * 10000) / 10000;
}

/** The age of an ISO timestamp in hours, or null when it cannot be parsed. */
function ageHours(at: Date, timestamp: string | null | undefined): number | null {
  if (!timestamp) return null;
  const parsed = Date.parse(timestamp);
  if (!Number.isFinite(parsed)) return null;
  return Math.round((at.getTime() - parsed) / HOUR_MS) * 100 / 100;
}

// ---------------------------------------------------------------------------
// Reading the board
// ---------------------------------------------------------------------------

type CountRow = { n: number };
type StatusRow = { status: string | null; n: number };
type DayRow = { day: string; done: number };
type CreatedRow = { created_at: string | null };
type ReferrerRow = { day: string; host: string; hits: number };
type CronRow = {
  job: string;
  status: string;
  run_id: string | null;
  detail: string | null;
  started_at: string;
  finished_at: string;
};

/**
 * Read the whole board. `now` is injectable for tests only; production
 * callers use the wall clock.
 */
export async function readMonitorBoard(db: Db, now?: Date): Promise<MonitorBoard> {
  const at = now ?? new Date();
  const today = utcDay(at);

  const window7 = { start: shiftDay(today, -(7 - 1)), end: shiftDay(today, 1) };
  const window30 = { start: shiftDay(today, -(30 - 1)), end: shiftDay(today, 1) };
  const series = dayWindow(today, DONE_SERIES_DAYS);
  const referrerSince = shiftDay(today, -(REFERRER_DAYS - 1));

  const [
    totalRow,
    statusRows,
    new7Row,
    new30Row,
    backlogRow,
    submissionsRow,
    backlogCreatedRows,
    doneRows,
    verifiedRow,
    ownersRow,
    mailboxesRow,
    referrerRows,
    cronRows,
    cronSuccessRows,
  ] = await Promise.all([
    db.prepare('SELECT COUNT(*) AS n FROM sites').get<CountRow>(),
    db.prepare('SELECT status, COUNT(*) AS n FROM sites GROUP BY status').all<StatusRow>(),
    db.prepare('SELECT COUNT(*) AS n FROM sites WHERE created_at IS NOT NULL AND created_at >= ? AND created_at < ?')
      .get<CountRow>(window7.start, window7.end),
    db.prepare('SELECT COUNT(*) AS n FROM sites WHERE created_at IS NOT NULL AND created_at >= ? AND created_at < ?')
      .get<CountRow>(window30.start, window30.end),
    db.prepare(`SELECT COUNT(*) AS n FROM submissions WHERE status IN ('${BACKLOG_STATUSES.join("', '")}')`)
      .get<CountRow>(),
    db.prepare('SELECT COUNT(*) AS n FROM submissions').get<CountRow>(),
    db.prepare(`SELECT created_at FROM submissions WHERE status IN ('${BACKLOG_STATUSES.join("', '")}')`)
      .all<CreatedRow>(),
    db.prepare(`SELECT substr(done_at, 1, 10) AS day, COUNT(*) AS done FROM submissions
                WHERE status IN ('${DONE_STATUSES.join("', '")}') AND done_at IS NOT NULL
                  AND substr(done_at, 1, 10) >= ? AND substr(done_at, 1, 10) <= ?
                GROUP BY day`)
      .all<DayRow>(series[0] ?? today, series[series.length - 1] ?? today),
    db.prepare('SELECT COUNT(*) AS n FROM sites WHERE verified = 1').get<CountRow>(),
    db.prepare('SELECT COUNT(*) AS n FROM owners').get<CountRow>(),
    db.prepare('SELECT COUNT(*) AS n FROM owner_emails WHERE verified_at IS NOT NULL').get<CountRow>(),
    db.prepare('SELECT day, host, hits FROM badge_referrers WHERE day >= ? ORDER BY hits DESC, day DESC, host ASC LIMIT ?')
      .all<ReferrerRow>(referrerSince, REFERRER_LIMIT),
    // The newest run per job by event time, not by insertion order: a report
    // that arrives late must not replace a newer result on the board.
    db.prepare(`SELECT r.job, r.status, r.run_id, r.detail, r.started_at, r.finished_at
                FROM ops_cron_runs r
                WHERE r.id = (SELECT r2.id FROM ops_cron_runs r2
                              WHERE r2.job = r.job
                              ORDER BY r2.finished_at DESC, r2.id DESC LIMIT 1)
                ORDER BY r.job ASC`)
      .all<CronRow>(),
    db.prepare(`SELECT job, MAX(finished_at) AS finished_at FROM ops_cron_runs
                WHERE status = 'ok' GROUP BY job`)
      .all<{ job: string; finished_at: string }>(),
  ]);

  const total = Number(totalRow?.n ?? 0);
  const byStatus = new Map<string, number>();
  for (const row of statusRows) {
    const key = row.status === null ? '' : row.status.trim().toLowerCase();
    byStatus.set(key, (byStatus.get(key) ?? 0) + Number(row.n));
  }

  const backlogCount = Number(backlogRow?.n ?? 0);
  const submissionTotal = Number(submissionsRow?.n ?? 0);

  // The oldest backlog entry: the earliest parsable creation timestamp.
  let oldest: number | null = null;
  for (const row of backlogCreatedRows) {
    const parsed = row.created_at ? Date.parse(row.created_at) : Number.NaN;
    if (!Number.isFinite(parsed)) continue;
    if (oldest === null || parsed < oldest) oldest = parsed;
  }
  const oldestHours = oldest === null
    ? null
    : Math.round(Math.max(0, (at.getTime() - oldest) / HOUR_MS) * 100) / 100;

  // The daily completion series: every day of the window, missing days as 0.
  const doneByDay = new Map(doneRows.map(row => [row.day, Number(row.done)]));
  const donePerDay = series.map(day => ({ day, done: doneByDay.get(day) ?? 0 }));

  const verifiedSites = Number(verifiedRow?.n ?? 0);
  const owners = Number(ownersRow?.n ?? 0);
  const mailboxes = Number(mailboxesRow?.n ?? 0);

  const cron = cronRows.map(row => ({
    job: row.job,
    status: row.status,
    run_id: row.run_id ?? null,
    detail: row.detail ?? null,
    started_at: row.started_at,
    finished_at: row.finished_at,
  }));

  return {
    listed: {
      total,
      active: byStatus.get('active') ?? 0,
      pending: byStatus.get('pending') ?? 0,
      declined: byStatus.get('declined') ?? 0,
      delisted: byStatus.get('delisted') ?? 0,
      new7: Number(new7Row?.n ?? 0),
      new30: Number(new30Row?.n ?? 0),
    },
    backlog: {
      count: backlogCount,
      ratio: ratio(backlogCount, submissionTotal),
      oldestHours,
      donePerDay,
    },
    conversion: {
      verifiedSites,
      owners,
      mailboxes,
      ratio: ratio(verifiedSites, total),
    },
    referrers: referrerRows.map(row => ({
      day: row.day,
      host: row.host,
      hits: Number(row.hits),
    })),
    cron,
    alerts: buildAlerts(cron, at, new Map(cronSuccessRows.map(row => [row.job, row.finished_at]))),
  };
}

/**
 * The alert rules, applied to the last run of every job:
 *   - the last run failed          → error
 *   - the last run succeeded long ago → warning (nothing successful for 30h)
 *   - the job never reported       → warning
 * A `skipped` run is neither a failure nor a success: it raises nothing.
 */
function buildAlerts(
  cron: { job: string; status: string; started_at: string; finished_at: string }[],
  at: Date,
  lastSuccess?: Map<string, string>,
): { job: string; level: 'error' | 'warn'; reason: string }[] {
  const lastByJob = new Map(cron.map(run => [run.job, run]));
  const jobs = new Set<string>([...EXPECTED_CRON_JOBS, ...lastByJob.keys()]);
  const alerts: { job: string; level: 'error' | 'warn'; reason: string }[] = [];

  for (const job of jobs) {
    const run = lastByJob.get(job);
    if (!run) {
      alerts.push({ job, level: 'warn', reason: '从未上报运行结果' });
      continue;
    }
    if (run.status === 'failed') {
      alerts.push({ job, level: 'error', reason: '最近一次运行失败' });
      continue;
    }
    // The silence is measured from the last SUCCESS, not from the last run:
    // a skipped run is not a success and must not reset the clock.
    const successAt = lastSuccess?.get(job);
    if (!successAt) {
      // Only skipped runs so far: nothing failed, nothing succeeded either.
      continue;
    }
    const hours = STALE_CRON_HOURS_BY_JOB[job] ?? STALE_CRON_HOURS;
    const age = ageHours(at, successAt);
    if (age !== null && age > hours) {
      alerts.push({ job, level: 'warn', reason: `超过 ${hours} 小时没有成功记录` });
    }
  }

  const rank = (level: 'error' | 'warn') => (level === 'error' ? 0 : 1);
  return alerts.sort((a, b) => rank(a.level) - rank(b.level) || a.job.localeCompare(b.job));
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

/**
 * Count one badge embed for the referring host. The host is normalized
 * (lowercase, no surrounding dots, at most 200 characters); an empty host is
 * ignored rather than stored as an empty bucket.
 */
export async function recordBadgeReferrer(db: Db, host: string, day?: string): Promise<void> {
  const normalized = host.trim().toLowerCase().replace(/^\.+|\.+$/g, '').slice(0, 200);
  if (!normalized) return;
  const candidate = (day ?? '').trim().slice(0, 10);
  const dayKey = /^\d{4}-\d{2}-\d{2}$/.test(candidate) ? candidate : utcDay(new Date());
  await db.prepare(`INSERT INTO badge_referrers (day, host, hits) VALUES (?, ?, 1)
                    ON CONFLICT(day, host) DO UPDATE SET hits = hits + 1`)
    .run(dayKey, normalized);
}

/**
 * Append one run of a scheduled job. The table is append-only: a run is never
 * updated and never removed, so the history of a job stays auditable.
 */
export async function recordCronRun(db: Db, run: {
  job: string;
  status: 'ok' | 'failed' | 'skipped';
  runId?: string | null;
  detail?: string | null;
  startedAt?: string;
  finishedAt?: string;
}): Promise<void> {
  const job = run.job.trim();
  if (!job) throw new Error('cron job name is required');
  const stamp = new Date().toISOString();
  await db.prepare(`INSERT INTO ops_cron_runs (job, status, run_id, detail, started_at, finished_at)
                    VALUES (?, ?, ?, ?, ?, ?)`)
    .run(job, run.status, run.runId ?? null, run.detail ?? null, run.startedAt ?? stamp, run.finishedAt ?? stamp);
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/** The percentage of a 0..1 ratio, e.g. 0.5 → "50.00%". */
function percent(value: number): string {
  return `${(value * 100).toFixed(2)}%`;
}

/** The monitoring board page. */
export function renderMonitorBoard(board: MonitorBoard): HtmlEscapedString {
  const alerts = board.alerts.length
    ? board.alerts.map(alert => adminAlert(alert.level, `${alert.reason}（${alert.job}）`))
    : [adminAlert('ok', '没有告警')];

  const cronRows = board.cron.map(run => h`<tr>
    <td>${run.job}</td><td>${run.status}</td><td>${run.started_at}</td><td>${run.finished_at}</td>
    <td>${run.run_id ?? ''}</td><td>${run.detail ?? ''}</td></tr>`);

  const doneRows = board.backlog.donePerDay.map(entry => h`<tr><td>${entry.day}</td><td>${entry.done}</td></tr>`);

  const referrerRows = board.referrers.map(entry => h`<tr>
    <td>${entry.day}</td><td>${entry.host}</td><td>${entry.hits}</td></tr>`);

  const stats = h`<div class="stats">
    ${adminStat('收录总数', String(board.listed.total), `30 日新增 ${board.listed.new30}`)}
    ${adminStat('7 日新增', String(board.listed.new7))}
    ${adminStat('积压条数', String(board.backlog.count))}
    ${adminStat('积压率', percent(board.backlog.ratio))}
    ${adminStat('最老积压', board.backlog.oldestHours === null ? '无' : `${board.backlog.oldestHours} 小时`)}
    ${adminStat('verified 站数', String(board.conversion.verifiedSites))}
    ${adminStat('转化率', percent(board.conversion.ratio))}
    ${adminStat('owner 邮箱数', String(board.conversion.mailboxes), `owners ${board.conversion.owners}`)}
  </div>`;

  return h`${adminNav('/admin/monitor')}
    ${adminPanel('告警', h`<div>${alerts}</div>`)}
    ${adminPanel('关键指标', stats)}
    ${adminPanel('定时任务状态', adminTable(['任务', '状态', '开始时间', '结束时间', '运行 ID', '详情'], cronRows))}
    ${adminPanel('积压每日完成量', adminTable(['日期', '完成数'], doneRows))}
    ${adminPanel('徽章来源', adminTable(['日期', '来源主机', '次数'], referrerRows))}`;
}
