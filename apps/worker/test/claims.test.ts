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
import { hashToken } from '../src/email.ts';

async function freshApp() {
  const { db, raw } = openSeededDb();
  const claimLimits: ClaimRateLimits = {
    domain: new RateLimiter(memoryStore(), CLAIMS_DOMAIN_LIMIT, DAY_MS, 'claim-domain'),
  };
  const app = createApp({ db, claimLimits });
  async function mailbox(domain: string, verified = true) {
    const token = `fixture-for-${domain}`;
    raw.prepare(`INSERT INTO owner_emails
      (domain, email_cipher, email_hash, manage_token_hash, verified_at, created_at, updated_at)
      VALUES (?, 'fixture-cipher', 'fixture-hash', ?, ?, '2026-11-11', '2026-11-11')`)
      .run(domain, await hashToken(token), verified ? '2026-11-11' : null);
    return token;
  }
  await mailbox('example.com');
  return { app, raw, mailbox, claimLimits };
}

function post(
  app: ReturnType<typeof createApp>,
  body: unknown,
  token: string | null = 'fixture-for-example.com',
): Promise<Response> {
  return app.request('/api/v1/claims', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
}

describe('POST /api/v1/claims', () => {
  it('accepts a trimmed statement from a verified site with 201', async () => {
    const { app, raw } = await freshApp();
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
    const { app, raw } = await freshApp();

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
    const { app, mailbox } = await freshApp();

    const unknown = await post(app, { domain: 'ghost.example', statement: 'hello' }, await mailbox('ghost.example'));
    assert.equal(unknown.status, 404);
    assert.equal((await unknown.json()).error, 'unknown_domain');

    // coolsite.io is listed but verified = 0
    const unverified = await post(app, { domain: 'coolsite.io', statement: 'hello' }, await mailbox('coolsite.io'));
    assert.equal(unverified.status, 403);
    assert.equal((await unverified.json()).error, 'not_verified');
  });

  it('accepts a recorded owner row as verification (either signal)', async () => {
    const { app, raw, mailbox } = await freshApp();
    raw
      .prepare(
        `INSERT INTO owners (domain, verify_method, verified_at)
         VALUES ('owned.dev', 'file', '2026-11-11T00:00:00.000Z')`,
      )
      .run();

    const res = await post(app, { domain: 'owned.dev', statement: 'Owner statement here' }, await mailbox('owned.dev'));
    assert.equal(res.status, 201);
    assert.deepEqual(await res.json(), { status: 'pending' });
  });

  it('rejects missing, foreign, stale and unconfirmed credentials without writing or charging quota', async () => {
    const { app, raw, mailbox, claimLimits } = await freshApp();
    const claim = { domain: 'example.com', statement: 'hello' };
    const foreign = await mailbox('other.dev');
    const unconfirmed = await mailbox('coolsite.io', false);
    raw.prepare("UPDATE sites SET verified = 1 WHERE domain = 'coolsite.io'").run();
    for (const [domain, token] of [['example.com', null], ['example.com', foreign], ['example.com', 'stale'], ['coolsite.io', unconfirmed]] as const) {
      const res = await post(app, { ...claim, domain }, token);
      assert.equal(res.status, 401);
      assert.deepEqual(await res.json(), { error: 'unauthorized' });
      assert.equal((await claimLimits.domain.check(domain)).remaining, CLAIMS_DOMAIN_LIMIT);
    }
    assert.equal(raw.prepare('SELECT COUNT(*) AS n FROM claims').get()?.n, 0);
    assert.equal((await post(app, claim)).status, 201);
  });

  it('does not write or charge quota if the token rotates before insertion', async () => {
    const { app, raw, claimLimits } = await freshApp();
    const check = claimLimits.domain.check.bind(claimLimits.domain);
    const rotated = await hashToken('rotated');
    claimLimits.domain.check = async (domain) => {
      raw.prepare('UPDATE owner_emails SET manage_token_hash = ? WHERE domain = ?').run(rotated, domain);
      return check(domain);
    };
    const claim = { domain: 'example.com', statement: 'hello' };
    assert.equal((await post(app, claim)).status, 401);
    assert.equal(raw.prepare('SELECT COUNT(*) AS n FROM claims').get()?.n, 0);
    assert.equal((await check(claim.domain)).remaining, CLAIMS_DOMAIN_LIMIT);
    assert.equal((await post(app, claim, 'rotated')).status, 201);
  });

  it('limits claims to 5 per domain per day', async () => {
    const { app, raw, mailbox } = await freshApp();
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
    const other = await post(app, { domain: 'other.dev', statement: 'Different domain' }, await mailbox('other.dev'));
    assert.equal(other.status, 201);
  });

  it('raises the statement ceiling to 600 for an active Pro term', async () => {
    const { app, raw } = await freshApp();
    const at = new Date().toISOString();
    raw
      .prepare(
        `INSERT INTO pro_entitlement_events
           (source_merchant_order_id, subject_id, kind, term_days, occurred_at, created_at)
         VALUES ('ap_pro_claims_fixture', 'example.com', 'grant', 30, ?, ?)`,
      )
      .run(at, at);

    // past the free ceiling, inside the Pro ceiling
    const long = await post(app, { domain: 'example.com', statement: 'x'.repeat(600) });
    assert.equal(long.status, 201);
    assert.deepEqual(await long.json(), { status: 'pending' }, 'the answer shape never changed');

    const over = await post(app, { domain: 'example.com', statement: 'x'.repeat(601) });
    assert.equal(over.status, 400);
    const parsed = await over.json();
    assert.equal(parsed.error, 'invalid_statement');
    assert.match(parsed.message, /1-600/);
    assert.equal(
      (raw.prepare(`SELECT COUNT(*) AS n FROM claims`).get() as { n: number }).n,
      1,
      'only the accepted statement was stored',
    );
  });
});

describe('GET /api/v1/claims', () => {
  it('returns only the published claim (or {statement:null})', async () => {
    const { app, raw } = await freshApp();

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
