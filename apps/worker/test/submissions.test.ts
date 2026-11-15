// test/submissions.test.ts — validation + registered-domain rule + idempotent
// dedup (exists/queued) + 5/IP/day rate limit.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { RateLimiter, DAY_MS, memoryStore } from '../src/rate-limit.ts';
import { createApp, normalizeDomain, registrableDomain, SUBMISSION_LIMIT, SUBMIT_ETA_SECONDS } from '../src/index.ts';
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

describe('registrableDomain', () => {
  it('accepts registered domains, canonicalizes www, rejects subdomains', () => {
    assert.equal(registrableDomain('example.com'), 'example.com');
    assert.equal(registrableDomain('www.example.com'), 'example.com');
    assert.equal(registrableDomain('WWW.Example.COM.'), 'example.com');
    assert.equal(registrableDomain('example.co.uk'), 'example.co.uk');
    assert.equal(registrableDomain('www.example.co.uk'), 'example.co.uk');
    assert.equal(registrableDomain('example.com.cn'), 'example.com.cn');
    assert.equal(registrableDomain('xn--bcher-kva.example'), 'xn--bcher-kva.example');
    // subdomains are not listings of their own
    assert.equal(registrableDomain('blog.example.com'), null);
    assert.equal(registrableDomain('sub.example.co.uk'), null); // 4 labels
    assert.equal(registrableDomain('a.b.example.com'), null);
    assert.equal(registrableDomain('foo.bar.de'), null); // open 2nd level → bar.de is the domain
    // bare public suffixes are not listings either
    assert.equal(registrableDomain('co.uk'), null);
    assert.equal(registrableDomain('www.co.uk'), null);
    assert.equal(registrableDomain('not a domain'), null);
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

  it('queues a valid submission (normalized, status=queued, real ETA)', async () => {
    const { app, raw } = freshApp();
    const res = await post(app, { domain: ' Newsite.NET ', note: 'please index us' });
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.domain, 'newsite.net');
    assert.equal(body.status, 'queued');
    assert.equal(body.etaSeconds, SUBMIT_ETA_SECONDS);
    // no token in tests → soft dispatch reports deferred, never fails
    assert.equal(body.dispatch, 'deferred');
    assert.equal(typeof body.id, 'number');

    const row = raw
      .prepare('SELECT domain, submitter_note, source, status FROM submissions WHERE id = ?')
      .get(body.id) as { domain: string; submitter_note: string; source: string; status: string };
    assert.equal(row.domain, 'newsite.net');
    assert.equal(row.submitter_note, 'please index us');
    assert.equal(row.source, 'public');
    assert.equal(row.status, 'queued');
  });

  it('rejects subdomains with subdomain_not_allowed', async () => {
    const { app, raw } = freshApp();
    for (const domain of ['blog.example.com', 'a.b.example.com', 'sub.example.co.uk']) {
      const res = await post(app, { domain });
      assert.equal(res.status, 400, `expected 400 for ${domain}`);
      assert.equal((await res.json()).error, 'subdomain_not_allowed');
    }
    const n = raw.prepare('SELECT COUNT(*) AS n FROM submissions').get() as { n: number };
    assert.equal(n.n, 0, 'rejected submissions must not insert rows');
  });

  it('returns exists for listed domains and burns no quota', async () => {
    const { app, raw } = freshApp();
    // example.com is a seeded site
    for (let i = 0; i < SUBMISSION_LIMIT + 2; i++) {
      const res = await post(app, { domain: 'example.com' });
      assert.equal(res.status, 200, `attempt ${i}`);
      assert.equal((await res.json()).status, 'exists');
    }
    const rows = raw.prepare('SELECT COUNT(*) AS n FROM submissions').get() as { n: number };
    assert.equal(rows.n, 0, 'exists must not insert rows');
    // the 5/day quota was never consumed → a fresh domain still goes through
    const fresh = await post(app, { domain: 'still-works.example' });
    assert.equal(fresh.status, 201);
  });

  it('is idempotent for an already-queued domain', async () => {
    const { app, raw } = freshApp();
    const first = await post(app, { domain: 'twice.example' });
    assert.equal(first.status, 201);
    const second = await post(app, { domain: 'twice.example' });
    assert.equal(second.status, 200);
    const body = await second.json();
    assert.equal(body.status, 'queued');
    assert.equal(body.etaSeconds, SUBMIT_ETA_SECONDS);
    const rows = raw
      .prepare("SELECT COUNT(*) AS n FROM submissions WHERE domain = 'twice.example'")
      .get() as { n: number };
    assert.equal(rows.n, 1, 'duplicate submission must not insert a second row');
  });

  it('strips www before queueing', async () => {
    const { app } = freshApp();
    const res = await post(app, { domain: 'www.fresh-site.example' });
    assert.equal(res.status, 201);
    assert.equal((await res.json()).domain, 'fresh-site.example');
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
