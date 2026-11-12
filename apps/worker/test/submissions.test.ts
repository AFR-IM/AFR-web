// test/submissions.test.ts — validation + 5/IP/day rate limit.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { RateLimiter, DAY_MS, memoryStore } from '../src/rate-limit.ts';
import { createApp, normalizeDomain, SUBMISSION_LIMIT } from '../src/index.ts';
import { openSeededDb } from './helpers.ts';

function post(app: ReturnType<typeof createApp>, body: unknown, ip = '10.0.0.1') {
  return app.request('/api/v1/submissions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
    body: JSON.stringify(body),
  });
}

function freshApp() {
  const { db, raw } = openSeededDb();
  const limiter = new RateLimiter(memoryStore(), SUBMISSION_LIMIT, DAY_MS, 'subs');
  return { app: createApp({ db, rateLimiter: limiter }), raw };
}

describe('normalizeDomain', () => {
  it('accepts bare FQDNs and rejects schemes/paths/IPs/junk', () => {
    assert.equal(normalizeDomain('Example.COM'), 'example.com');
    assert.equal(normalizeDomain('  sub.example.co.uk  '), 'sub.example.co.uk');
    assert.equal(normalizeDomain('xn--bcher-kva.example'), 'xn--bcher-kva.example');
    assert.equal(normalizeDomain('http://example.com'), null);
    assert.equal(normalizeDomain('example.com/path'), null);
    assert.equal(normalizeDomain('example.com:8080'), null);
    assert.equal(normalizeDomain('192.168.0.1'), null);
    assert.equal(normalizeDomain('foo'), null);
    assert.equal(normalizeDomain('-bad.example'), null);
    assert.equal(normalizeDomain('under_score.example'), null);
    assert.equal(normalizeDomain(''), null);
  });
});

describe('POST /api/v1/submissions', () => {
  it('rejects malformed JSON and invalid domains with 400', async () => {
    const { app } = freshApp();

    const badJson = await app.request('/api/v1/submissions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{nope',
    });
    assert.equal(badJson.status, 400);
    assert.equal((await badJson.json()).error, 'invalid_json');

    for (const domain of ['http://example.com', 'not a domain', 'foo']) {
      const res = await post(app, { domain });
      assert.equal(res.status, 400, `expected 400 for ${domain}`);
      assert.equal((await res.json()).error, 'invalid_domain');
    }

    const wrongType = await post(app, { domain: 42 });
    assert.equal(wrongType.status, 400);
  });

  it('queues a valid submission (normalized, status=queued)', async () => {
    const { app, raw } = freshApp();
    const res = await post(app, { domain: ' Example.COM ', note: 'please index us' });
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.domain, 'example.com');
    assert.equal(body.status, 'queued');
    assert.equal(typeof body.id, 'number');

    const row = raw
      .prepare('SELECT domain, submitter_note, source, status FROM submissions WHERE id = ?')
      .get(body.id) as { domain: string; submitter_note: string; source: string; status: string };
    assert.equal(row.domain, 'example.com');
    assert.equal(row.submitter_note, 'please index us');
    assert.equal(row.source, 'public');
    assert.equal(row.status, 'queued');
  });

  it('enforces 5 submissions per IP per day', async () => {
    const { app } = freshApp();
    for (let i = 0; i < SUBMISSION_LIMIT; i++) {
      const res = await post(app, { domain: `site${i}.example` }, '203.0.113.7');
      assert.equal(res.status, 201, `request ${i + 1} should pass`);
    }
    const blocked = await post(app, { domain: 'one-too-many.example' }, '203.0.113.7');
    assert.equal(blocked.status, 429);
    assert.equal((await blocked.json()).error, 'rate_limited');
  });

  it('keeps per-IP counters independent', async () => {
    const { app } = freshApp();
    for (let i = 0; i < SUBMISSION_LIMIT; i++) {
      assert.equal((await post(app, { domain: `a${i}.example` }, '198.51.100.1')).status, 201);
    }
    assert.equal((await post(app, { domain: 'b0.example' }, '198.51.100.1')).status, 429);
    assert.equal((await post(app, { domain: 'b0.example' }, '198.51.100.2')).status, 201);
  });
});
