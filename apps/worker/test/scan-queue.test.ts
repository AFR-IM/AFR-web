// test/scan-queue.test.ts — on-demand scan requests (search-then-collect):
// POST /api/v1/search-scan validation, existence/queue dedup, the three rate
// limit tiers, soft GitHub dispatch; GET /api/v1/queue ordering; the
// X-Queue-Token done callback; and the daily sync cron module.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import worker, {
  createApp,
  QUEUE_LIST_LIMIT,
  SCAN_GLOBAL_LIMIT,
  SCAN_IP_LIMIT,
  SCAN_ETA_SECONDS,
  type ScanRateLimits,
  type WorkerEnv,
} from '../src/index.ts';
import { RateLimiter, DAY_MS, memoryStore } from '../src/rate-limit.ts';
import { latestSnapshotDate, runDailySync } from '../src/cron.ts';
import { DATA_REPO_RAW, DATA_REPO_API } from '../src/d1-sync.ts';
import { createSqliteDb } from '../src/db.ts';
import { openSeededDb, SCHEMA_SQL } from './helpers.ts';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function freshScanLimits(): ScanRateLimits {
  return {
    ip: new RateLimiter(memoryStore(), SCAN_IP_LIMIT, DAY_MS, 'scan-ip'),
    domain: new RateLimiter(memoryStore(), 1, DAY_MS, 'scan-domain'),
    global: new RateLimiter(memoryStore(), SCAN_GLOBAL_LIMIT, DAY_MS, 'scan-global'),
  };
}

interface DispatchCall {
  url: string;
  init?: RequestInit;
}

function fakeFetch(options: { fail?: boolean; status?: number } = {}) {
  const calls: DispatchCall[] = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    if (options.fail) throw new Error('network down');
    return new Response(null, { status: options.status ?? 204 });
  }) as unknown as typeof fetch;
  return { calls, impl };
}

function freshApp(fetchImpl?: typeof fetch) {
  const { db, raw } = openSeededDb();
  const scanLimits = freshScanLimits();
  const app = createApp({ db, scanLimits, fetchImpl });
  return { app, raw, scanLimits };
}

function envWith(overrides: Partial<WorkerEnv> = {}): WorkerEnv {
  return { DB: undefined as unknown as WorkerEnv['DB'], ...overrides };
}

function post(
  app: ReturnType<typeof createApp>,
  path: string,
  body: unknown,
  ip = '203.0.113.10',
  env?: WorkerEnv,
): Promise<Response> {
  return app.request(
    path,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
      body: JSON.stringify(body),
    },
    env,
  );
}

const DISPATCH_PATH = '/actions/workflows/scan.yml/dispatches';

// ---------------------------------------------------------------------------
// POST /api/v1/search-scan
// ---------------------------------------------------------------------------

describe('POST /api/v1/search-scan', () => {
  it('rejects malformed JSON and invalid domains with 400', async () => {
    const { app } = freshApp();

    const badJson = await app.request('/api/v1/search-scan', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{nope',
    });
    assert.equal(badJson.status, 400);
    assert.equal((await badJson.json()).error, 'invalid_json');

    for (const domain of ['http://example.com', 'not a domain', 'foo']) {
      const res = await post(app, '/api/v1/search-scan', { domain });
      assert.equal(res.status, 400, `expected 400 for ${domain}`);
      assert.equal((await res.json()).error, 'invalid_domain');
    }

    assert.equal((await post(app, '/api/v1/search-scan', {})).status, 400);
    assert.equal((await post(app, '/api/v1/search-scan', { domain: 42 })).status, 400);
  });

  it('returns exists for an already listed domain without queueing', async () => {
    const { app, raw } = freshApp(fakeFetch().impl);

    const res = await post(app, '/api/v1/search-scan', { domain: ' Example.COM ' });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { status: 'exists', domain: 'example.com' });
    assert.equal(
      (raw.prepare('SELECT COUNT(*) AS n FROM submissions').get() as { n: number }).n,
      0,
      'no submission row for an already listed site',
    );
  });

  it('returns queued for a domain already waiting in the queue (idempotent)', async () => {
    const { app, raw, scanLimits } = freshApp(fakeFetch().impl);
    raw
      .prepare(
        `INSERT INTO submissions (domain, submitter_note, source, status, created_at)
         VALUES ('already.io', NULL, 'public', 'queued', '2026-11-10T00:00:00.000Z')`,
      )
      .run();

    const res = await post(app, '/api/v1/search-scan', { domain: 'already.io' }, '198.51.100.7');
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), {
      status: 'queued',
      domain: 'already.io',
      etaSeconds: SCAN_ETA_SECONDS,
    });
    assert.equal(
      (raw.prepare('SELECT COUNT(*) AS n FROM submissions').get() as { n: number }).n,
      1,
      'no duplicate row inserted',
    );
    const ipDecision = await scanLimits.ip.check('198.51.100.7');
    assert.equal(ipDecision.remaining, SCAN_IP_LIMIT, 'dedup hit burns no quota');
  });

  it('queues a new request, inserts an on_demand row and dispatches scan.yml', async () => {
    const { calls, impl } = fakeFetch();
    const { app, raw } = freshApp(impl);
    const env = envWith({ GITHUB_DISPATCH_TOKEN: 'test-token' });

    const res = await post(app, '/api/v1/search-scan', { domain: 'Fresh.IO' }, '192.0.2.1', env);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.status, 'queued');
    assert.equal(body.domain, 'fresh.io');
    assert.equal(body.etaSeconds, SCAN_ETA_SECONDS);
    assert.equal(body.dispatch, 'ok');

    const row = raw
      .prepare('SELECT domain, submitter_note, source, status, created_at FROM submissions')
      .get() as { domain: string; submitter_note: string | null; source: string; status: string; created_at: string };
    assert.equal(row.domain, 'fresh.io');
    assert.equal(row.submitter_note, null);
    assert.equal(row.source, 'on_demand');
    assert.equal(row.status, 'queued');
    assert.ok(row.created_at, 'created_at is set');

    assert.equal(calls.length, 1, 'exactly one dispatch attempt');
    assert.ok(calls[0]!.url.endsWith(DISPATCH_PATH), `dispatched to ${calls[0]!.url}`);
    const headers = (calls[0]!.init?.headers ?? {}) as Record<string, string>;
    assert.equal(headers.authorization, 'Bearer test-token');
    assert.deepEqual(JSON.parse(String(calls[0]!.init?.body)), {
      ref: 'main',
      inputs: { mode: 'queue' },
    });
  });

  it('still queues with dispatch deferred when the token is missing', async () => {
    const { calls, impl } = fakeFetch();
    const { app, raw } = freshApp(impl);

    const res = await post(app, '/api/v1/search-scan', { domain: 'notoken.dev' });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.status, 'queued');
    assert.equal(body.domain, 'notoken.dev');
    assert.equal(body.etaSeconds, SCAN_ETA_SECONDS);
    assert.equal(body.dispatch, 'deferred');
    assert.equal(calls.length, 0, 'no dispatch attempt without a token');
    assert.equal(
      (raw.prepare('SELECT COUNT(*) AS n FROM submissions').get() as { n: number }).n,
      1,
      'request is still queued for the daily cron',
    );
  });

  it('defers the dispatch when the GitHub call fails (soft fail)', async () => {
    const failing = fakeFetch({ fail: true });
    const { app: appThrow } = freshApp(failing.impl);
    const throwRes = await post(
      appThrow,
      '/api/v1/search-scan',
      { domain: 'throw.example' },
      '203.0.113.1',
      envWith({ GITHUB_DISPATCH_TOKEN: 'test-token' }),
    );
    assert.equal(throwRes.status, 200);
    assert.equal((await throwRes.json()).dispatch, 'deferred');

    const serverError = fakeFetch({ status: 500 });
    const { app: app500 } = freshApp(serverError.impl);
    const errRes = await post(
      app500,
      '/api/v1/search-scan',
      { domain: 'error.example' },
      '203.0.113.2',
      envWith({ GITHUB_DISPATCH_TOKEN: 'test-token' }),
    );
    assert.equal(errRes.status, 200);
    const body = await errRes.json();
    assert.equal(body.status, 'queued');
    assert.equal(body.dispatch, 'deferred');
  });

  it('enforces 10 scan requests per IP per day', async () => {
    const { app } = freshApp();
    for (let i = 0; i < SCAN_IP_LIMIT; i++) {
      const res = await post(app, '/api/v1/search-scan', { domain: `ip${i}.example` }, '203.0.113.50');
      assert.equal(res.status, 200, `request ${i + 1} should pass`);
    }
    const blocked = await post(
      app,
      '/api/v1/search-scan',
      { domain: 'ip-too-many.example' },
      '203.0.113.50',
    );
    assert.equal(blocked.status, 429);
    const body = await blocked.json();
    assert.equal(body.error, 'rate_limited');
    assert.ok(body.retryAfter > 0 && body.retryAfter <= 86400, 'retryAfter is seconds');
    assert.ok(
      Number(blocked.headers.get('retry-after')) > 0,
      'Retry-After header present on 429',
    );
    // another IP is unaffected
    const other = await post(
      app,
      '/api/v1/search-scan',
      { domain: 'ip-other.example' },
      '203.0.113.51',
    );
    assert.equal(other.status, 200);
  });

  it('allows only one scan request per domain per day', async () => {
    const { app, raw } = freshApp();
    const first = await post(app, '/api/v1/search-scan', { domain: 'daily.example' });
    assert.equal(first.status, 200);

    // simulate the scan finishing — the queue no longer dedups this domain
    raw.prepare(`UPDATE submissions SET status = 'scanned' WHERE domain = 'daily.example'`).run();

    const second = await post(app, '/api/v1/search-scan', { domain: 'daily.example' });
    assert.equal(second.status, 429);
    const body = await second.json();
    assert.equal(body.error, 'rate_limited');
    assert.ok(body.retryAfter > 0);
    assert.equal(
      (raw.prepare(`SELECT COUNT(*) AS n FROM submissions WHERE domain = 'daily.example'`).get() as { n: number }).n,
      1,
      'no second row while the domain is rate limited',
    );
  });

  it('enforces a global cap of 50 scan requests per day', async () => {
    const { app } = freshApp();
    for (let i = 0; i < SCAN_GLOBAL_LIMIT; i++) {
      const res = await post(
        app,
        '/api/v1/search-scan',
        { domain: `g${i}.example` },
        `ip-${i}`,
      );
      assert.equal(res.status, 200, `request ${i + 1} should pass`);
    }
    const blocked = await post(
      app,
      '/api/v1/search-scan',
      { domain: 'after-cap.example' },
      'ip-after-cap',
    );
    assert.equal(blocked.status, 429);
    const body = await blocked.json();
    assert.equal(body.error, 'rate_limited');
    assert.ok(body.retryAfter > 0);
    assert.ok(blocked.headers.get('retry-after'));
  });
});

// ---------------------------------------------------------------------------
// GET /api/v1/queue
// ---------------------------------------------------------------------------

describe('GET /api/v1/queue', () => {
  it('lists queued submissions oldest first, capped at 50, active statuses only', async () => {
    const { db, raw } = openSeededDb();
    const app = createApp({ db, scanLimits: freshScanLimits() });
    const insert = raw.prepare(
      `INSERT INTO submissions (domain, submitter_note, source, status, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    );
    const base = Date.parse('2026-11-01T00:00:00.000Z');

    // 55 queued rows, inserted newest-first so id order != created_at order
    for (let i = QUEUE_LIST_LIMIT + 4; i >= 0; i--) {
      insert.run(
        `q${i}.example`,
        i === 0 ? 'please scan first' : null,
        i % 2 === 0 ? 'on_demand' : 'public',
        'queued',
        new Date(base + i * 60_000).toISOString(),
      );
    }
    // non-active rows must never appear
    insert.run('done.example', null, 'public', 'scanned', new Date(base - 1000).toISOString());
    insert.run('rejected.example', null, 'public', 'rejected', new Date(base - 2000).toISOString());

    const res = await app.request('/api/v1/queue');
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.items.length, QUEUE_LIST_LIMIT);

    const stamps = body.items.map((i: { createdAt: string }) => Date.parse(i.createdAt));
    for (let i = 1; i < stamps.length; i++) {
      assert.ok(stamps[i]! >= stamps[i - 1]!, 'items are oldest first');
    }
    assert.equal(body.items[0].domain, 'q0.example', 'oldest queued item comes first');
    assert.equal(body.items[0].note, 'please scan first');
    assert.equal(body.items[0].source, 'on_demand');
    assert.equal(typeof body.items[0].createdAt, 'string');
    const domains = body.items.map((i: { domain: string }) => i.domain);
    assert.ok(!domains.includes('done.example'));
    assert.ok(!domains.includes('rejected.example'));
  });
});

// ---------------------------------------------------------------------------
// POST /api/v1/queue/:domain/done
// ---------------------------------------------------------------------------

describe('POST /api/v1/queue/:domain/done', () => {
  it('returns 501 when QUEUE_TOKEN is not configured', async () => {
    const { app, raw } = freshApp();
    const res = await post(app, '/api/v1/queue/any.example/done', {}, '203.0.113.9', envWith());
    assert.equal(res.status, 501);
    assert.equal((await res.json()).error, 'not_configured');
    assert.equal(
      (raw.prepare('SELECT COUNT(*) AS n FROM submissions').get() as { n: number }).n,
      0,
    );
  });

  it('rejects a missing or wrong X-Queue-Token with 401', async () => {
    const { app, raw } = freshApp();
    raw
      .prepare(
        `INSERT INTO submissions (domain, submitter_note, source, status, created_at)
         VALUES ('guarded.io', NULL, 'on_demand', 'queued', '2026-11-10T00:00:00.000Z')`,
      )
      .run();
    const env = envWith({ QUEUE_TOKEN: 'sekret' });

    const missing = await app.request(
      '/api/v1/queue/guarded.io/done',
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' },
      env,
    );
    assert.equal(missing.status, 401);
    assert.equal((await missing.json()).error, 'unauthorized');

    const wrong = await app.request(
      '/api/v1/queue/guarded.io/done',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-queue-token': 'nope' },
        body: '{}',
      },
      env,
    );
    assert.equal(wrong.status, 401);

    const row = raw.prepare(`SELECT status FROM submissions WHERE domain = 'guarded.io'`).get() as {
      status: string;
    };
    assert.equal(row.status, 'queued', 'row untouched after failed auth');
  });

  it('marks the queued submission scanned with done_at on a valid token', async () => {
    const { app, raw } = freshApp();
    raw
      .prepare(
        `INSERT INTO submissions (domain, submitter_note, source, status, created_at)
         VALUES ('finish.dev', NULL, 'on_demand', 'queued', '2026-11-10T00:00:00.000Z')`,
      )
      .run();
    const env = envWith({ QUEUE_TOKEN: 'sekret' });

    const res = await app.request(
      '/api/v1/queue/finish.dev/done',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-queue-token': 'sekret' },
        body: '{}',
      },
      env,
    );
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, domain: 'finish.dev', status: 'scanned' });

    const row = raw
      .prepare(`SELECT status, done_at FROM submissions WHERE domain = 'finish.dev'`)
      .get() as { status: string; done_at: string | null };
    assert.equal(row.status, 'scanned');
    assert.ok(row.done_at && !Number.isNaN(Date.parse(row.done_at)), 'done_at is a timestamp');
  });

  it('returns 404 when the domain has nothing queued', async () => {
    const { app } = freshApp();
    const env = envWith({ QUEUE_TOKEN: 'sekret' });
    const init = {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-queue-token': 'sekret' },
      body: '{}',
    };

    const unknown = await app.request('/api/v1/queue/ghost.example/done', init, env);
    assert.equal(unknown.status, 404);
    assert.equal((await unknown.json()).error, 'not_queued');

    const invalid = await app.request('/api/v1/queue/not-a-domain/done', init, env);
    assert.equal(invalid.status, 400);
    assert.equal((await invalid.json()).error, 'invalid_domain');
  });

  it('still marks scanned when the deployed table lacks done_at', async () => {
    const raw = new DatabaseSync(':memory:');
    // pre-done_at schema (the deployed D1 predates the column)
    raw.exec(SCHEMA_SQL.replace(/,\s*done_at TEXT[^\n]*/, ''));
    raw
      .prepare(
        `INSERT INTO submissions (domain, submitter_note, source, status, created_at)
         VALUES ('legacy.dev', NULL, 'on_demand', 'queued', '2026-11-10T00:00:00.000Z')`,
      )
      .run();

    const app = createApp({ db: createSqliteDb(raw), scanLimits: freshScanLimits() });
    const res = await app.request(
      '/api/v1/queue/legacy.dev/done',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-queue-token': 'sekret' },
        body: '{}',
      },
      envWith({ QUEUE_TOKEN: 'sekret' }),
    );
    assert.equal(res.status, 200);
    const row = raw.prepare(`SELECT status FROM submissions WHERE domain = 'legacy.dev'`).get() as {
      status: string;
    };
    assert.equal(row.status, 'scanned');
  });
});

// ---------------------------------------------------------------------------
// Daily cron (D1 sync only — the Worker never scans)
// ---------------------------------------------------------------------------

describe('daily cron sync', () => {
  it('resolves the newest snapshot date from the data repo listings', async () => {
    const impl = (async (input: RequestInfo | URL) => {
      const url = String(input);
      const dirs: Record<string, string[]> = {
        [`${DATA_REPO_API}/scans`]: ['2025', '2026'],
        [`${DATA_REPO_API}/scans/2026`]: ['01', '11'],
        [`${DATA_REPO_API}/scans/2026/11`]: ['01', '10'],
      };
      const names = dirs[url];
      if (!names) return new Response('not found', { status: 404 });
      return Response.json(names.map((name) => ({ name, type: 'dir', path: `scans/${name}` })));
    }) as unknown as typeof fetch;

    assert.equal(await latestSnapshotDate(impl), '2026/11/10');
  });

  it('syncs the latest date into D1', async () => {
    const date = '2026/11/10';
    const snapshotPath = `scans/${date}/acme.dev.json`;
    const impl = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === `${DATA_REPO_API}/scans`) {
        return Response.json([{ name: '2026', type: 'dir' }]);
      }
      if (url === `${DATA_REPO_API}/scans/2026`) {
        return Response.json([{ name: '11', type: 'dir' }]);
      }
      if (url === `${DATA_REPO_API}/scans/2026/11`) {
        return Response.json([{ name: '10', type: 'dir' }]);
      }
      if (url === `${DATA_REPO_API}/scans/${date}`) {
        return Response.json([{ name: 'acme.dev.json', type: 'file', path: snapshotPath }]);
      }
      if (url === `${DATA_REPO_RAW}/${snapshotPath}`) {
        return Response.json({
          signals: { domain: 'acme.dev', fetchedAt: '2026-11-10T10:00:00.000Z' },
          afr: {
            domain: 'acme.dev',
            engineVersion: 'afr-1.0.0',
            scannerVersion: 'scanner-0.1.0',
            scannedAt: '2026-11-10T10:00:00.000Z',
            score: 84,
            grade: 'B',
            strategyTag: 'Middle-Path',
            layers: [
              { layer: 'L1', name: 'Reachable', awarded: 30, max: 35, checks: [] },
              { layer: 'L2', name: 'Legible', awarded: 30, max: 40, checks: [] },
              { layer: 'L3', name: 'Actionable', awarded: 24, max: 25, checks: [] },
            ],
            breakdown: {},
          },
        });
      }
      return new Response('not found', { status: 404 });
    }) as unknown as typeof fetch;

    const { db, raw } = openSeededDb();
    const logs: string[] = [];
    const result = await runDailySync({ db, fetchImpl: impl, log: (m) => logs.push(m) });

    assert.ok(result);
    assert.equal(result.date, date);
    assert.equal(result.sitesUpserted, 1);
    assert.equal(result.errors.length, 0);
    const site = raw.prepare(`SELECT grade FROM sites WHERE domain = 'acme.dev'`).get() as {
      grade: string;
    };
    assert.equal(site.grade, 'B');
    assert.ok(logs.some((m) => m.includes(date)));
  });

  it('skips cleanly when the data repo has no snapshots', async () => {
    const impl = (async () => new Response('not found', { status: 404 })) as unknown as typeof fetch;
    const { db } = openSeededDb();
    const result = await runDailySync({ db, fetchImpl: impl, log: () => {} });
    assert.equal(result, null);
  });

  it('exposes a scheduled handler on the Worker entry', () => {
    assert.equal(typeof worker.scheduled, 'function');
  });
});
