// test/pv.test.ts — view counter: the 1×1 pixel (204, counted only for listed
// sites, daily write cap inside the upsert) and the read endpoints
// (GET /api/v1/sites/:domain/views + the views field on the detail response).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { DatabaseSync } from 'node:sqlite';
import { createApp, PV_DAILY_WRITE_CAP } from '../src/index.ts';
import { openSeededDb } from './helpers.ts';

function freshApp() {
  const { db, raw } = openSeededDb();
  const app = createApp({ db });
  return { app, raw };
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function seedCounter(
  raw: DatabaseSync,
  domain: string,
  views: number,
  todayViews: number,
  countedOn: string,
): void {
  raw
    .prepare(
      'INSERT INTO page_views (domain, views, today_views, counted_on) VALUES (?, ?, ?, ?)',
    )
    .run(domain, views, todayViews, countedOn);
}

function readCounter(raw: DatabaseSync, domain: string) {
  return raw.prepare('SELECT views, today_views, counted_on FROM page_views WHERE domain = ?').get(
    domain,
  ) as { views: number; today_views: number; counted_on: string } | undefined;
}

describe('GET /api/v1/pv', () => {
  it('counts views for listed sites and answers 204 with image/gif', async () => {
    const { app, raw } = freshApp();

    const first = await app.request('/api/v1/pv?site=example.com');
    assert.equal(first.status, 204, 'the pixel never fails visibly');
    assert.equal(first.headers.get('content-type'), 'image/gif');
    assert.equal(first.body, null, '204 carries no body (Fetch standard)');

    let row = readCounter(raw, 'example.com');
    assert.ok(row, 'counter row created');
    assert.equal(row.views, 1);
    assert.equal(row.today_views, 1);
    assert.equal(row.counted_on, today(), 'counted_on is the UTC date');

    await app.request('/api/v1/pv?site=Example.COM');
    row = readCounter(raw, 'example.com');
    assert.equal(row!.views, 2, 'domain is normalized before counting');
    assert.equal(row!.today_views, 2);
  });

  it('answers 204 without writing for unknown or invalid sites', async () => {
    const { app, raw } = freshApp();

    const unknown = await app.request('/api/v1/pv?site=ghost.example');
    assert.equal(unknown.status, 204);
    assert.equal(unknown.headers.get('content-type'), 'image/gif');

    const invalid = await app.request('/api/v1/pv?site=not_a_domain');
    assert.equal(invalid.status, 204);

    const missing = await app.request('/api/v1/pv');
    assert.equal(missing.status, 204);

    assert.equal(
      (raw.prepare('SELECT COUNT(*) AS n FROM page_views').get() as { n: number }).n,
      0,
      'no rows written for uncounted requests',
    );
  });

  it('stops writing at the daily cap (70000 per UTC day)', async () => {
    const { app, raw } = freshApp();
    seedCounter(raw, 'example.com', PV_DAILY_WRITE_CAP - 1, PV_DAILY_WRITE_CAP - 1, today());

    const atCap = await app.request('/api/v1/pv?site=example.com');
    assert.equal(atCap.status, 204, 'the last allowed view still answers 204');
    let row = readCounter(raw, 'example.com');
    assert.equal(row!.views, PV_DAILY_WRITE_CAP);
    assert.equal(row!.today_views, PV_DAILY_WRITE_CAP);

    const capped = await app.request('/api/v1/pv?site=example.com');
    assert.equal(capped.status, 204, 'capped views still answer 204');
    row = readCounter(raw, 'example.com');
    assert.equal(row!.views, PV_DAILY_WRITE_CAP, 'no row written once capped');
    assert.equal(row!.today_views, PV_DAILY_WRITE_CAP);
  });

  it('resets the daily counter on a new UTC day (even after a capped day)', async () => {
    const { app, raw } = freshApp();
    seedCounter(raw, 'example.com', PV_DAILY_WRITE_CAP, PV_DAILY_WRITE_CAP, '2026-11-10');

    const res = await app.request('/api/v1/pv?site=example.com');
    assert.equal(res.status, 204);
    const row = readCounter(raw, 'example.com');
    assert.equal(row!.views, PV_DAILY_WRITE_CAP + 1, 'lifetime views keep counting');
    assert.equal(row!.today_views, 1, 'today counter restarts');
    assert.equal(row!.counted_on, today(), 'counted_on rolls forward');
  });
});

describe('GET /api/v1/sites/:domain/views', () => {
  it('returns {domain, views, today}, zeros when nothing was counted', async () => {
    const { app, raw } = freshApp();

    const empty = await app.request('/api/v1/sites/example.com/views');
    assert.equal(empty.status, 200);
    assert.deepEqual(await empty.json(), { domain: 'example.com', views: 0, today: 0 });

    const unknown = await app.request('/api/v1/sites/ghost.example/views');
    assert.equal(unknown.status, 200);
    assert.deepEqual(await unknown.json(), { domain: 'ghost.example', views: 0, today: 0 });

    const invalid = await app.request('/api/v1/sites/not_a_domain/views');
    assert.equal(invalid.status, 400);
    assert.equal((await invalid.json()).error, 'invalid_domain');

    await app.request('/api/v1/pv?site=example.com');
    await app.request('/api/v1/pv?site=example.com');
    const counted = await app.request('/api/v1/sites/example.com/views');
    assert.deepEqual(await counted.json(), { domain: 'example.com', views: 2, today: 2 });
    void raw;
  });

  it('includes views in the site detail response', async () => {
    const { app } = freshApp();

    const before = await app.request('/api/v1/sites/example.com');
    assert.equal(before.status, 200);
    assert.equal((await before.json()).views, 0, 'missing counter row → views: 0');

    await app.request('/api/v1/pv?site=example.com');
    await app.request('/api/v1/pv?site=example.com');

    const after = await app.request('/api/v1/sites/example.com');
    const body = await after.json();
    assert.equal(body.views, 2, 'detail reads the counter');
    assert.equal(body.site.domain, 'example.com', 'existing payload untouched');
  });
});
