import assert from 'node:assert/strict';
import { it } from 'node:test';
import type { DatabaseSync } from 'node:sqlite';
import {
  readMonitorBoard,
  recordBadgeReferrer,
  recordCronRun,
  renderMonitorBoard,
} from '../src/admin-monitor.ts';
import { openSeededDb } from './helpers.ts';

/** The clock every expectation below is written against. */
const NOW = new Date('2026-11-25T12:00:00.000Z');

function addSite(
  raw: DatabaseSync,
  domain: string,
  status: string,
  createdAt: string | null,
  verified = 0,
): void {
  raw.prepare(`INSERT INTO sites (domain, title, lang, status, verified, created_at, updated_at)
               VALUES (?, ?, 'en', ?, ?, ?, ?)`)
    .run(domain, domain, status, verified, createdAt, createdAt);
}

function addSubmission(
  raw: DatabaseSync,
  status: string,
  createdAt: string | null,
  doneAt: string | null = null,
): void {
  raw.prepare(`INSERT INTO submissions (domain, submitter_note, source, status, created_at, done_at)
               VALUES (?, 'private note', 'public', ?, ?, ?)`)
    .run(`${status}-${createdAt}.test`, status, createdAt, doneAt);
}

it('counts the listed sites by status and by the 7/30 day windows', async () => {
  const { db, raw } = openSeededDb();
  addSite(raw, 'recent-a.test', 'active', '2026-11-22T00:00:00.000Z');
  addSite(raw, 'recent-b.test', 'pending', '2026-11-15T00:00:00.000Z');
  addSite(raw, 'old.test', 'declined', '2025-01-01T00:00:00.000Z');
  addSite(raw, 'gone.test', 'delisted', '2025-01-01T00:00:00.000Z');
  addSite(raw, 'nodate.test', 'active', null);

  const board = await readMonitorBoard(db, NOW);
  assert.equal(board.listed.total, 10);
  assert.equal(board.listed.active, 7);
  assert.equal(board.listed.pending, 1);
  assert.equal(board.listed.declined, 1);
  assert.equal(board.listed.delisted, 1);
  assert.equal(board.listed.new7, 1);
  assert.equal(board.listed.new30, 7);
});

it('measures the submission backlog, its ratio, its age and the daily completions', async () => {
  const { db, raw } = openSeededDb();
  addSubmission(raw, 'queued', '2026-11-24T00:00:00.000Z');
  addSubmission(raw, 'pending', '2026-11-20T00:00:00.000Z');
  addSubmission(raw, 'scanning', '2026-11-23T12:00:00.000Z');
  addSubmission(raw, 'scanned', '2026-11-24T00:00:00.000Z', '2026-11-24T05:00:00.000Z');
  addSubmission(raw, 'done', '2026-11-25T00:00:00.000Z', '2026-11-25T01:00:00.000Z');
  addSubmission(raw, 'rejected', '2026-11-25T00:00:00.000Z', '2026-11-25T02:00:00.000Z');

  const board = await readMonitorBoard(db, NOW);
  assert.equal(board.backlog.count, 3);
  assert.equal(board.backlog.ratio, 0.5);
  assert.equal(board.backlog.oldestHours, 132);
  assert.deepEqual(board.backlog.donePerDay, [
    { day: '2026-11-19', done: 0 },
    { day: '2026-11-20', done: 0 },
    { day: '2026-11-21', done: 0 },
    { day: '2026-11-22', done: 0 },
    { day: '2026-11-23', done: 0 },
    { day: '2026-11-24', done: 1 },
    { day: '2026-11-25', done: 1 },
  ]);
});

it('reports no backlog and no completion when the queue is empty', async () => {
  const { db } = openSeededDb();
  const board = await readMonitorBoard(db, NOW);
  assert.equal(board.backlog.count, 0);
  assert.equal(board.backlog.ratio, 0);
  assert.equal(board.backlog.oldestHours, null);
  assert.equal(board.backlog.donePerDay.length, 7);
  assert.ok(board.backlog.donePerDay.every(entry => entry.done === 0));
});

it('counts verified sites, owners and confirmed mailboxes', async () => {
  const { db, raw } = openSeededDb();
  raw.prepare(`INSERT INTO owners (domain, verify_method, verified_at, email_hash, display_name, notify)
               VALUES ('conv.test', 'dns-txt', '2026-11-01T00:00:00.000Z', 'hash-1', 'Conv', 1)`).run();
  raw.prepare(`INSERT INTO owner_emails (domain, email_cipher, email_hash, verified_at)
               VALUES ('conv.test', 'cipher-1', 'hash-1', '2026-11-02T00:00:00.000Z')`).run();
  raw.prepare(`INSERT INTO owner_emails (domain, email_cipher, email_hash, verified_at)
               VALUES ('conv2.test', 'cipher-2', 'hash-2', NULL)`).run();

  const board = await readMonitorBoard(db, NOW);
  assert.equal(board.conversion.verifiedSites, 1);
  assert.equal(board.conversion.owners, 1);
  assert.equal(board.conversion.mailboxes, 1);
  assert.equal(board.conversion.ratio, 0.2);
});

it('accumulates badge referrers per host and day and ignores empty hosts', async () => {
  const { db, raw } = openSeededDb();
  await recordBadgeReferrer(db, 'Example.COM', '2026-11-24');
  await recordBadgeReferrer(db, 'example.com', '2026-11-24');
  await recordBadgeReferrer(db, 'other.test', '2026-11-23');
  await recordBadgeReferrer(db, ' .example.com. ', '2026-11-24');
  await recordBadgeReferrer(db, '   ');
  await recordBadgeReferrer(db, '');

  const rows = raw.prepare('SELECT day, host, hits FROM badge_referrers ORDER BY day, host').all()
    .map(row => ({ ...row }));
  assert.equal(rows.length, 2);
  assert.deepEqual(rows, [
    { day: '2026-11-23', host: 'other.test', hits: 1 },
    { day: '2026-11-24', host: 'example.com', hits: 3 },
  ]);

  const board = await readMonitorBoard(db, NOW);
  assert.deepEqual(board.referrers, [
    { day: '2026-11-24', host: 'example.com', hits: 3 },
    { day: '2026-11-23', host: 'other.test', hits: 1 },
  ]);
});

it('counts a badge referrer on the current UTC day when no day is given', async () => {
  const { db, raw } = openSeededDb();
  await recordBadgeReferrer(db, 'daily.test');
  const today = new Date().toISOString().slice(0, 10);
  const row = raw.prepare('SELECT day, host, hits FROM badge_referrers WHERE host = ?').get('daily.test');
  assert.deepEqual(row ? { ...row } : null, { day: today, host: 'daily.test', hits: 1 });
});

it('appends cron runs and keeps only the last run of every job', async () => {
  const { db, raw } = openSeededDb();
  await recordCronRun(db, {
    job: 'scan',
    status: 'ok',
    runId: 'run-0',
    detail: 'first',
    startedAt: '2026-11-25T09:00:00.000Z',
    finishedAt: '2026-11-25T09:05:00.000Z',
  });
  await recordCronRun(db, {
    job: 'scan',
    status: 'failed',
    runId: 'run-1',
    detail: 'boom',
    startedAt: '2026-11-25T10:00:00.000Z',
    finishedAt: '2026-11-25T10:05:00.000Z',
  });

  assert.equal(raw.prepare('SELECT COUNT(*) AS n FROM ops_cron_runs').get()?.n, 2);
  const board = await readMonitorBoard(db, NOW);
  assert.equal(board.cron.length, 1);
  assert.deepEqual(board.cron[0], {
    job: 'scan',
    status: 'failed',
    run_id: 'run-1',
    detail: 'boom',
    started_at: '2026-11-25T10:00:00.000Z',
    finished_at: '2026-11-25T10:05:00.000Z',
  });
});

it('raises an error for a failed job, a warning for a silent one and a warning for a stale one', async () => {
  const { db } = openSeededDb();
  await recordCronRun(db, {
    job: 'scan',
    status: 'failed',
    runId: 'run-1',
    detail: 'boom',
    startedAt: '2026-11-25T10:00:00.000Z',
    finishedAt: '2026-11-25T10:05:00.000Z',
  });
  // The weekly job ran ten days ago: silent for longer than its own
  // schedule allows (a weekly job must not be warned about after 30 hours).
  await recordCronRun(db, {
    job: 'weekly-scan',
    status: 'ok',
    startedAt: '2026-11-15T20:00:00.000Z',
    finishedAt: '2026-11-15T20:10:00.000Z',
  });
  await recordCronRun(db, {
    job: 'worker.daily',
    status: 'ok',
    startedAt: '2026-11-25T11:00:00.000Z',
    finishedAt: '2026-11-25T11:05:00.000Z',
  });

  const board = await readMonitorBoard(db, NOW);
  assert.deepEqual(board.alerts, [
    { job: 'scan', level: 'error', reason: '最近一次运行失败' },
    { job: 'sync-site', level: 'warn', reason: '从未上报运行结果' },
    { job: 'weekly-scan', level: 'warn', reason: '超过 192 小时没有成功记录' },
  ]);
  assert.deepEqual(board.cron.map(run => run.job), ['scan', 'weekly-scan', 'worker.daily']);
});

it('does not warn about a weekly job that ran within its own schedule', async () => {
  const { db } = openSeededDb();
  await recordCronRun(db, {
    job: 'weekly-scan',
    status: 'ok',
    startedAt: '2026-11-23T20:00:00.000Z',
    finishedAt: '2026-11-23T20:10:00.000Z',
  });
  const board = await readMonitorBoard(db, NOW);
  assert.deepEqual(board.alerts.filter(alert => alert.job === 'weekly-scan'), []);
});

it('treats a skipped run as neither a failure nor a stale success', async () => {
  const { db } = openSeededDb();
  await recordCronRun(db, {
    job: 'worker.daily',
    status: 'skipped',
    startedAt: '2026-11-23T20:00:00.000Z',
    finishedAt: '2026-11-23T20:10:00.000Z',
  });

  const board = await readMonitorBoard(db, NOW);
  assert.deepEqual(board.alerts, [
    { job: 'scan', level: 'warn', reason: '从未上报运行结果' },
    { job: 'sync-site', level: 'warn', reason: '从未上报运行结果' },
    { job: 'weekly-scan', level: 'warn', reason: '从未上报运行结果' },
  ]);
  assert.equal(board.cron[0]?.status, 'skipped');
});

it('stays silent when every expected job reported a fresh success', async () => {
  const { db } = openSeededDb();
  for (const job of ['scan', 'sync-site', 'weekly-scan', 'worker.daily']) {
    await recordCronRun(db, {
      job,
      status: 'ok',
      startedAt: '2026-11-25T11:00:00.000Z',
      finishedAt: '2026-11-25T11:05:00.000Z',
    });
  }
  const board = await readMonitorBoard(db, NOW);
  assert.deepEqual(board.alerts, []);
  assert.equal(board.cron.length, 4);
});

it('renders the board sections, the numbers and the alerts in Chinese', async () => {
  const { db, raw } = openSeededDb();
  addSubmission(raw, 'queued', '2026-11-25T00:00:00.000Z');
  await recordBadgeReferrer(db, 'blog.example', '2026-11-25');
  await recordCronRun(db, {
    job: 'scan',
    status: 'failed',
    runId: 'run-1',
    detail: 'boom',
    startedAt: '2026-11-25T10:00:00.000Z',
    finishedAt: '2026-11-25T10:05:00.000Z',
  });

  const board = await readMonitorBoard(db, NOW);
  const page = renderMonitorBoard(board).toString();

  assert.ok(page.includes('/admin/monitor'));
  assert.ok(page.includes('D 监控看板'));
  assert.ok(page.includes('告警'));
  assert.ok(page.includes('最近一次运行失败'));
  assert.ok(page.includes('scan'));
  assert.ok(page.includes('关键指标'));
  assert.ok(page.includes('收录总数'));
  assert.ok(page.includes('7 日新增'));
  assert.ok(page.includes('积压条数'));
  assert.ok(page.includes('积压率'));
  assert.ok(page.includes('最老积压'));
  assert.ok(page.includes('verified 站数'));
  assert.ok(page.includes('转化率'));
  assert.ok(page.includes('owner 邮箱数'));
  assert.ok(page.includes('定时任务状态'));
  assert.ok(page.includes('积压每日完成量'));
  assert.ok(page.includes('徽章来源'));
  assert.ok(page.includes('blog.example'));
  assert.ok(page.includes('2026-11-25'));
  assert.ok(page.includes('100.00%'));
  assert.ok(page.includes('20.00%'));
  assert.ok(page.includes('12 小时'));
});

it('renders a green note when there is nothing to report', async () => {
  const { db } = openSeededDb();
  for (const job of ['scan', 'sync-site', 'weekly-scan', 'worker.daily']) {
    await recordCronRun(db, {
      job,
      status: 'ok',
      startedAt: '2026-11-25T11:00:00.000Z',
      finishedAt: '2026-11-25T11:05:00.000Z',
    });
  }
  const board = await readMonitorBoard(db, NOW);
  assert.deepEqual(board.alerts, []);
  const page = renderMonitorBoard(board).toString();
  assert.ok(page.includes('没有告警'));
});
