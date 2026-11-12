// test/api.test.ts — directory endpoints against a seeded node:sqlite database
// (sites / detail / history / stats / categories / leaderboard).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createApp } from '../src/index.ts';
import { openSeededDb } from './helpers.ts';

function app() {
  return createApp({ db: openSeededDb().db });
}

describe('GET /api/v1/sites', () => {
  it('defaults to AFR score desc (product invariant)', async () => {
    const res = await app().request('/api/v1/sites');
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.total, 4); // pending.dev (grade Pending) excluded from listings
    assert.deepEqual(
      body.items.map((i: { domain: string }) => i.domain),
      ['example.com', 'coolsite.io', 'neutral.net', 'closed.org'],
    );
    assert.equal(body.items[0].grade, 'A');
    assert.equal(body.items[0].category, 'dev-tools');
    assert.equal(body.items[0].verified, true);
    assert.equal(body.page, 1);
    assert.equal(body.per_page, 20);
  });

  it('filters by category, grade and free-text q', async () => {
    const byCategory = await (await app().request('/api/v1/sites?category=news')).json();
    assert.deepEqual(
      byCategory.items.map((i: { domain: string }) => i.domain),
      ['neutral.net', 'closed.org'],
    );

    const byGrade = await (await app().request('/api/v1/sites?grade=B')).json();
    assert.deepEqual(
      byGrade.items.map((i: { domain: string }) => i.domain),
      ['coolsite.io'],
    );

    const byQuery = await (await app().request('/api/v1/sites?q=exam')).json();
    assert.deepEqual(
      byQuery.items.map((i: { domain: string }) => i.domain),
      ['example.com'],
    );
    assert.equal(byQuery.total, 1);
  });

  it('sorts by rank (nulls last) and by recency', async () => {
    const byRank = await (await app().request('/api/v1/sites?sort=rank')).json();
    assert.deepEqual(
      byRank.items.map((i: { domain: string }) => i.domain),
      ['example.com', 'coolsite.io', 'neutral.net', 'closed.org'],
    );

    const byNew = await (await app().request('/api/v1/sites?sort=new')).json();
    assert.deepEqual(
      byNew.items.map((i: { domain: string }) => i.domain),
      ['closed.org', 'neutral.net', 'coolsite.io', 'example.com'],
    );
  });

  it('paginates and rejects unknown sort values', async () => {
    const page2 = await (await app().request('/api/v1/sites?page=2')).json();
    assert.equal(page2.items.length, 0);
    assert.equal(page2.total, 4);
    assert.equal(page2.page, 2);

    const bad = await app().request('/api/v1/sites?sort=ads');
    assert.equal(bad.status, 400);
    const body = await bad.json();
    assert.equal(body.error, 'invalid_sort');
  });

  it('honors per_page with a 1..100 clamp (default stays 20)', async () => {
    const dflt = await (await app().request('/api/v1/sites')).json();
    assert.equal(dflt.per_page, 20);

    const custom = await (await app().request('/api/v1/sites?per_page=50')).json();
    assert.equal(custom.per_page, 50);
    assert.equal(custom.items.length, 4);

    const over = await (await app().request('/api/v1/sites?per_page=500')).json();
    assert.equal(over.per_page, 100);

    const under = await (await app().request('/api/v1/sites?per_page=0')).json();
    assert.equal(under.per_page, 1);

    const bogus = await (await app().request('/api/v1/sites?per_page=abc')).json();
    assert.equal(bogus.per_page, 20);
  });

  it('serves open CORS headers on the API surface', async () => {
    const res = await app().request('/api/v1/sites');
    assert.equal(res.headers.get('access-control-allow-origin'), '*');
  });
});

describe('GET /api/v1/sites/:domain', () => {
  it('returns the site with its latest scan and that scan evidence', async () => {
    const res = await app().request('/api/v1/sites/example.com');
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.site.domain, 'example.com');
    assert.equal(body.site.score_total, 92);
    assert.equal(body.scan.started_at, '2026-11-10T10:00:00.000Z');
    assert.equal(body.evidence.length, 2);
    assert.equal(body.evidence[0].check_id, 'A1.gptbot');
    assert.equal(body.evidence[0].points, 3);
  });

  it('404s unknown domains and 400s malformed ones', async () => {
    const missing = await app().request('/api/v1/sites/ghost.example');
    assert.equal(missing.status, 404);
    assert.equal((await missing.json()).error, 'not_found');

    const malformed = await app().request('/api/v1/sites/not_a_domain');
    assert.equal(malformed.status, 400);
    assert.equal((await malformed.json()).error, 'invalid_domain');
  });
});

describe('GET /api/v1/sites/:domain/history', () => {
  it('returns scans ordered by started_at desc', async () => {
    const res = await app().request('/api/v1/sites/example.com/history');
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.domain, 'example.com');
    assert.equal(body.scans.length, 2);
    assert.equal(body.scans[0].started_at, '2026-11-10T10:00:00.000Z');
    assert.equal(body.scans[1].started_at, '2026-11-09T10:00:00.000Z');
    assert.equal(body.scans[0].score_total, 92);
    assert.equal(body.scans[1].score_total, 88);
  });

  it('404s history for unknown domains', async () => {
    const res = await app().request('/api/v1/sites/ghost.example/history');
    assert.equal(res.status, 404);
  });
});

describe('GET /api/v1/stats', () => {
  it('reports totals, grade distribution and average score', async () => {
    const res = await app().request('/api/v1/stats');
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.total, 5);
    assert.equal(body.verified, 1);
    assert.equal(body.pending, 1); // unratable site counted separately
    // (92 + 78 + 55 + 10) / 4 = 58.75 → 58.8 (Pending has no score)
    assert.equal(body.avg_score, 58.8);
    assert.deepEqual(body.grades, { A: 1, B: 1, C: 1, D: 0, F: 1 });
  });
});

describe('GET /api/v1/categories', () => {
  it('returns the category tree with active-site counts', async () => {
    const res = await app().request('/api/v1/categories');
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.categories.length, 1);
    const tech = body.categories[0];
    assert.equal(tech.slug, 'tech');
    assert.equal(tech.count, 0); // no site is directly categorized as "tech"
    assert.equal(tech.children.length, 2);
    const devTools = tech.children.find((c: { slug: string }) => c.slug === 'dev-tools');
    const news = tech.children.find((c: { slug: string }) => c.slug === 'news');
    assert.equal(devTools.count, 2); // example.com + coolsite.io (Pending excluded)
    assert.equal(news.count, 2);
    assert.equal(devTools.name_en, 'Developer Tools');
    assert.equal(typeof devTools.name_zh, 'string');
  });
});

describe('GET /api/v1/leaderboard', () => {
  it('ranks top sites by pure score desc, excluding unscored sites', async () => {
    const res = await app().request('/api/v1/leaderboard');
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.category, null);
    assert.deepEqual(
      body.items.map((i: { domain: string }) => i.domain),
      ['example.com', 'coolsite.io', 'neutral.net', 'closed.org'],
    );
    assert.equal(body.items[0].rank, 1);
    assert.equal(body.items[0].score, 92);
    // strictly descending scores — ads never influence this ordering
    const scores = body.items.map((i: { score: number }) => i.score);
    assert.deepEqual(scores, [...scores].sort((a, b) => b - a));
  });

  it('filters by category and honors a limit', async () => {
    const news = await (await app().request('/api/v1/leaderboard?category=news')).json();
    assert.deepEqual(
      news.items.map((i: { domain: string }) => i.domain),
      ['neutral.net', 'closed.org'],
    );
    assert.equal(news.items[0].rank, 1);

    const top2 = await (await app().request('/api/v1/leaderboard?limit=2')).json();
    assert.equal(top2.items.length, 2);
  });
});
