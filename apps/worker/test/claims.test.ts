// test/claims.test.ts — owner claims: POST /api/v1/claims validation, the
// 404/403 verification gates, the 5/day/domain rate limit, and the public
// GET /api/v1/claims read of the published statement.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  CLAIMS_DOMAIN_LIMIT,
  createApp,
  type ClaimRateLimits,
} from '../src/index.ts';
import { RateLimiter, DAY_MS, memoryStore } from '../src/rate-limit.ts';
import { openSeededDb } from './helpers.ts';

function freshApp() {
  const { db, raw } = openSeededDb();
  const claimLimits: ClaimRateLimits = {
    domain: new RateLimiter(memoryStore(), CLAIMS_DOMAIN_LIMIT, DAY_MS, 'claim-domain'),
  };
  const app = createApp({ db, claimLimits });
  return { app, raw };
}

function post(
  app: ReturnType<typeof createApp>,
  body: unknown,
  ip = '203.0.113.80',
): Promise<Response> {
  return app.request('/api/v1/claims', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
    body: JSON.stringify(body),
  });
}

describe('POST /api/v1/claims', () => {
  it('accepts a trimmed statement from a verified site with 201', async () => {
    const { app, raw } = freshApp();
    const res = await post(app, {
      domain: 'Example.COM',
      statement: '  We publish our AI crawler policy.  ',
    });
    assert.equal(res.status, 201);
    assert.deepEqual(await res.json(), { status: 'pending' });

    const row = raw
      .prepare('SELECT domain, statement, status, created_at FROM claims')
      .get() as {
      domain: string;
      statement: string;
      status: string;
      created_at: string | null;
    };
    assert.equal(row.domain, 'example.com');
    assert.equal(row.statement, 'We publish our AI crawler policy.', 'statement is trimmed');
    assert.equal(row.status, 'pending', 'statements are published after editorial review');
    assert.ok(row.created_at);
  });

  it('validates the statement length (1-200 after trim) with 400', async () => {
    const { app, raw } = freshApp();

    const cases: [string, unknown][] = [
      ['missing', { domain: 'example.com' }],
      ['non-string', { domain: 'example.com', statement: 42 }],
      ['empty', { domain: 'example.com', statement: '' }],
      ['whitespace only', { domain: 'example.com', statement: '   ' }],
      ['201 chars', { domain: 'example.com', statement: 'x'.repeat(201) }],
      ['invalid domain', { domain: 'http://example.com', statement: 'ok statement' }],
    ];
    for (const [label, body] of cases) {
      const res = await post(app, body);
      assert.equal(res.status, 400, `expected 400 for ${label}`);
      const parsed = await res.json();
      assert.ok(
        parsed.error === 'invalid_domain' || parsed.error === 'invalid_statement',
        `unexpected error for ${label}: ${parsed.error}`,
      );
      if (parsed.error === 'invalid_statement') {
        assert.equal(typeof parsed.message, 'string', '400s carry a human message');
      }
    }

    // exactly 200 chars passes validation (and burns no quota on the 400s above)
    const ok = await post(app, { domain: 'example.com', statement: 'x'.repeat(200) });
    assert.equal(ok.status, 201);
    assert.equal(
      (raw.prepare('SELECT COUNT(*) AS n FROM claims').get() as { n: number }).n,
      1,
      'only the valid statement was stored',
    );
  });

  it('404s unknown domains and 403s unverified sites', async () => {
    const { app } = freshApp();

    const unknown = await post(app, { domain: 'ghost.example', statement: 'hello' });
    assert.equal(unknown.status, 404);
    assert.equal((await unknown.json()).error, 'unknown_domain');

    // coolsite.io is listed but verified = 0
    const unverified = await post(app, { domain: 'coolsite.io', statement: 'hello' });
    assert.equal(unverified.status, 403);
    assert.equal((await unverified.json()).error, 'not_verified');
  });

  it('accepts a recorded owner row as verification (either signal)', async () => {
    const { app, raw } = freshApp();
    raw
      .prepare(
        `INSERT INTO owners (domain, verify_method, verified_at)
         VALUES ('owned.dev', 'file', '2026-11-11T00:00:00.000Z')`,
      )
      .run();

    const res = await post(app, { domain: 'owned.dev', statement: 'Owner statement here' });
    assert.equal(res.status, 201);
    assert.deepEqual(await res.json(), { status: 'pending' });
  });

  it('limits claims to 5 per domain per day', async () => {
    const { app, raw } = freshApp();
    for (let i = 0; i < CLAIMS_DOMAIN_LIMIT; i++) {
      const res = await post(app, { domain: 'example.com', statement: `statement ${i}` });
      assert.equal(res.status, 201, `claim ${i + 1} should pass`);
    }
    const blocked = await post(app, { domain: 'example.com', statement: 'one too many' });
    assert.equal(blocked.status, 429);
    const body = await blocked.json();
    assert.equal(body.error, 'rate_limited');
    assert.ok(body.retryAfter > 0);
    assert.ok(Number(blocked.headers.get('retry-after')) > 0, 'Retry-After header present');
    assert.equal(
      (raw.prepare(`SELECT COUNT(*) AS n FROM claims WHERE domain = 'example.com'`).get() as {
        n: number;
      }).n,
      CLAIMS_DOMAIN_LIMIT,
      'no row inserted on the rejected request',
    );

    // another domain is unaffected
    raw
      .prepare(
        `INSERT INTO owners (domain, verify_method, verified_at)
         VALUES ('other.dev', 'file', '2026-11-11T00:00:00.000Z')`,
      )
      .run();
    const other = await post(app, { domain: 'other.dev', statement: 'Different domain' });
    assert.equal(other.status, 201);
  });
});

describe('GET /api/v1/claims', () => {
  it('returns only the published claim (or {statement:null})', async () => {
    const { app, raw } = freshApp();

    // no rows yet
    const empty = await app.request('/api/v1/claims?domain=example.com');
    assert.equal(empty.status, 200);
    assert.deepEqual(await empty.json(), { statement: null });

    // pending rows never surface
    raw
      .prepare(
        `INSERT INTO claims (domain, statement, status, created_at)
         VALUES ('example.com', 'Pending text', 'pending', '2026-11-11T00:00:00.000Z')`,
      )
      .run();
    const pending = await app.request('/api/v1/claims?domain=example.com');
    assert.deepEqual(await pending.json(), { statement: null });

    // the published row does, with its timestamp
    raw
      .prepare(
        `INSERT INTO claims (domain, statement, status, created_at)
         VALUES ('example.com', 'Published text', 'published', '2026-11-10T12:00:00.000Z')`,
      )
      .run();
    const published = await app.request('/api/v1/claims?domain=example.com');
    assert.equal(published.status, 200);
    assert.deepEqual(await published.json(), {
      statement: 'Published text',
      publishedAt: '2026-11-10T12:00:00.000Z',
    });

    // unknown or malformed domains answer the same empty shape
    const unknown = await app.request('/api/v1/claims?domain=ghost.example');
    assert.deepEqual(await unknown.json(), { statement: null });
    const malformed = await app.request('/api/v1/claims?domain=not_a_domain');
    assert.deepEqual(await malformed.json(), { statement: null });
    const missing = await app.request('/api/v1/claims');
    assert.deepEqual(await missing.json(), { statement: null });
  });
});
