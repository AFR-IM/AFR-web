// test/edge-cache.test.ts — T4 edge caching: read endpoints are served from
// the Cache API when one exists, a hit skips the handler (proved by mutating
// the database between two identical requests), and Cache-Control: no-cache
// always bypasses the cache.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { createApp } from '../src/index.ts';
import { openSeededDb } from './helpers.ts';

/** Minimal stand-in for the Workers Cache API. */
class FakeCache {
  readonly entries = new Map<string, Response>();
  async match(req: Request): Promise<Response | undefined> {
    const hit = this.entries.get(req.url);
    return hit ? hit.clone() : undefined;
  }
  async put(req: Request, res: Response): Promise<void> {
    this.entries.set(req.url, res.clone());
  }
}

const store = new FakeCache();
const globals = globalThis as { caches?: unknown };

before(() => {
  globals.caches = { default: store };
});
after(() => {
  delete globals.caches;
});

/** Seeded app plus its raw sqlite handle, so a test can change the data. */
function appWithData() {
  const { db, raw } = openSeededDb();
  return { app: createApp({ db }), raw };
}

describe('edge cache (T4)', () => {
  it('serves a repeat GET from cache and skips the handler', async () => {
    const { app, raw } = appWithData();
    const first = await app.request('http://localhost/api/v1/categories?probe=1');
    assert.equal(first.status, 200);
    assert.equal(
      first.headers.get('cache-control'),
      'no-store',
      'JSON API responses must not linger in browser or zone caches',
    );
    const before = await first.json();

    // Change the underlying data: a live handler would now return more rows.
    raw.prepare("INSERT INTO categories (slug, name_en, name_zh) VALUES ('z-probe', 'Z', 'Z')").run();

    const second = await app.request('http://localhost/api/v1/categories?probe=1');
    assert.deepEqual(await second.json(), before, 'cached body is returned unchanged');
  });

  it('honours Cache-Control: no-cache by bypassing the cache', async () => {
    const { app, raw } = appWithData();
    const url = 'http://localhost/api/v1/categories?probe=2';
    await app.request(url);

    raw.prepare("INSERT INTO categories (slug, name_en, name_zh) VALUES ('z-bypass', 'Z', 'Z')").run();

    const fresh = await app.request(url, { headers: { 'cache-control': 'no-cache' } });
    const body = await fresh.json();
    assert.ok(
      body.categories.some((c: { slug: string }) => c.slug === 'z-bypass'),
      'no-cache reaches the database',
    );
  });

  it('never caches the per-site view counter (must stay fresh)', async () => {
    const { app } = appWithData();
    const res = await app.request('http://localhost/api/v1/sites/example.com/views');
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('cache-control'), null, 'not an edge-cacheable path');
  });

  it('stamps a long TTL on badges', async () => {
    const { app } = appWithData();
    const res = await app.request('http://localhost/badge/example.com.svg');
    assert.equal(res.status, 200);
    assert.match(String(res.headers.get('cache-control')), /max-age=3600/);
  });
});
