// test/rescan.test.ts — POST /api/v1/rescan: input validation, unknown
// domains, the per-domain quota shared with search-scan, and the soft
// GitHub scan dispatch.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  createApp,
  SCAN_ETA_SECONDS,
  type ScanRateLimits,
  type WorkerEnv
} from '../src/index.ts';
import { RateLimiter, DAY_MS, memoryStore } from '../src/rate-limit.ts';
import { SCAN_DOMAIN_WINDOW_MS } from '../src/index.ts';
import { openSeededDb } from './helpers.ts';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function freshScanLimits(): ScanRateLimits {
  return {
    ip: new RateLimiter(memoryStore(), 10, DAY_MS, 'scan-ip'),
    rescanIp: new RateLimiter(memoryStore(), 1, SCAN_DOMAIN_WINDOW_MS, 'rescan-ip'),
    domain: new RateLimiter(memoryStore(), 1, SCAN_DOMAIN_WINDOW_MS, 'scan-domain'),
    global: new RateLimiter(memoryStore(), 50, DAY_MS, 'scan-global'),
  };
}

interface DispatchCall {
  url: string;
  init?: RequestInit;
}

function fakeFetch(): { calls: DispatchCall[]; impl: typeof fetch } {
  const calls: DispatchCall[] = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return new Response(null, { status: 204 });
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

function postTo(
  app: ReturnType<typeof createApp>,
  path: string,
  body: unknown,
  ip = '203.0.113.10',
  env?: WorkerEnv,
): Promise<Response> {
  return app.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
    body: JSON.stringify(body),
  }, env);
}

const DISPATCH_PATH = '/actions/workflows/scan.yml/dispatches';

function rescanRows(raw: ReturnType<typeof openSeededDb>['raw']): number {
  return (raw.prepare(`SELECT COUNT(*) AS n FROM submissions WHERE source = 'rescan'`).get() as {
    n: number;
  }).n;
}

// ---------------------------------------------------------------------------
// POST /api/v1/rescan
// ---------------------------------------------------------------------------

describe('POST /api/v1/rescan', () => {
  it('validates input: bad JSON / bad domain → 400, unknown domain → 404', async () => {
    const { app } = freshApp();

    const badJson = await app.request('/api/v1/rescan', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{nope',
    });
    assert.equal(badJson.status, 400);
    assert.equal((await badJson.json()).error, 'invalid_json');

    const invalid = await postTo(app, '/api/v1/rescan', { domain: 'http://example.com' });
    assert.equal(invalid.status, 400);
    assert.equal((await invalid.json()).error, 'invalid_domain');

    const unknown = await postTo(app, '/api/v1/rescan', { domain: 'ghost.example' });
    assert.equal(unknown.status, 404);
    assert.equal((await unknown.json()).error, 'unknown_domain');

    assert.equal((await postTo(app, '/api/v1/rescan', {})).status, 400);
  });

  it('queues a rescan for a listed site and soft-dispatches scan.yml', async () => {
    const { calls, impl } = fakeFetch();
    const { app, raw } = freshApp(impl);
    const env = envWith({ GITHUB_DISPATCH_TOKEN: 'test-token' });

    const res = await postTo(app, '/api/v1/rescan', { domain: ' Example.COM ' }, '203.0.113.20', env);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.status, 'queued');
    assert.equal(body.etaSeconds, SCAN_ETA_SECONDS);
    const next = Date.parse(body.nextAllowedAt);
    assert.ok(
      Math.abs(next - (Date.now() + 30 * 60 * 1000)) < 5000,
      'nextAllowedAt ≈ now + 30min',
    );

    const row = raw
      .prepare('SELECT domain, source, status, submitter_note, created_at FROM submissions')
      .get() as {
      domain: string;
      source: string;
      status: string;
      submitter_note: string | null;
      created_at: string | null;
    };
    assert.equal(row.domain, 'example.com');
    assert.equal(row.source, 'rescan');
    assert.equal(row.status, 'queued');
    assert.equal(row.submitter_note, null);
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

  it('still queues when the dispatch token is missing (soft fail)', async () => {
    const { calls, impl } = fakeFetch();
    const { app, raw } = freshApp(impl);

    const res = await postTo(app, '/api/v1/rescan', { domain: 'coolsite.io' }, '203.0.113.21');
    assert.equal(res.status, 200);
    assert.equal((await res.json()).status, 'queued');
    assert.equal(calls.length, 0, 'no dispatch attempt without a token');
    assert.equal(rescanRows(raw), 1, 'the request is still queued for the daily cron');
  });

  it('allows only one rescan per domain per window', async () => {
    const { app, raw } = freshApp();

    const first = await postTo(app, '/api/v1/rescan', { domain: 'example.com' });
    assert.equal(first.status, 200);

    const second = await postTo(app, '/api/v1/rescan', { domain: 'example.com' });
    assert.equal(second.status, 429);
    const body = await second.json();
    assert.equal(body.error, 'rate_limited');
    assert.ok(body.retryAfter > 0 && body.retryAfter <= 86400, 'retryAfter is seconds');
    assert.ok(Date.parse(body.nextAllowedAt) > Date.now(), 'nextAllowedAt is in the future');
    assert.ok(Number(second.headers.get('retry-after')) > 0, 'Retry-After header present');
    assert.equal(rescanRows(raw), 1, 'no second row while the domain is rate limited');
  });

  it('limits a device to one re-scan per 30 minutes across DIFFERENT domains', async () => {
    const { app } = freshApp();
    const first = await app.request('/api/v1/rescan', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ domain: 'example.com' }),
    });
    assert.equal(first.status, 200);
    const second = await app.request('/api/v1/rescan', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ domain: 'coolsite.io' }),
    });
    assert.equal(second.status, 429, 'a second device-level rescan must be blocked');
    const body = await second.json();
    assert.equal(body.scope, 'device');
    assert.ok(Number(body.retryAfter) > 0, 'retryAfter is positive');
    const next = Date.parse(body.nextAllowedAt);
    const now = Date.now();
    assert.ok(next > now, 'nextAllowedAt is in the future');
    assert.ok(next <= now + 30 * 60 * 1000 + 5000, 'nextAllowedAt within the 30-minute window');
  });

  it('shares the per-domain quota with search-scan', async () => {
    const { app, raw } = freshApp();

    // A search trigger for a not-yet-listed domain consumes the shared tier.
    const search = await postTo(
      app,
      '/api/v1/search-scan',
      { domain: 'shared.example' },
      '203.0.113.30',
    );
    assert.equal(search.status, 200);

    // The site gets listed afterwards (e.g. by the daily sync).
    raw
      .prepare(
        `INSERT INTO sites (domain, title, status, verified, created_at)
         VALUES ('shared.example', 'Shared', 'active', 0, '2026-11-11T00:00:00.000Z')`,
      )
      .run();

    const rescan = await postTo(
      app,
      '/api/v1/rescan',
      { domain: 'shared.example' },
      '203.0.113.31',
    );
    assert.equal(rescan.status, 429, 'a search trigger and a rescan cannot exceed one per day');
    const body = await rescan.json();
    assert.equal(body.error, 'rate_limited');
    assert.ok(body.retryAfter > 0);
    assert.ok(Number(rescan.headers.get('retry-after')) > 0);
    assert.equal(rescanRows(raw), 0, 'no rescan row inserted on the rejected request');
  });
});
