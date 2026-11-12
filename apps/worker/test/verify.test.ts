// test/verify.test.ts — verification flow: POST /api/v1/verify/start (response
// shape, token storage, the 3/day/domain + 10/hour/IP limits) and
// GET /api/v1/verify/check (injected probes: file pass, DNS pass over a fake
// DoH, meta pass, all-fail, network failure) plus owner/site writes on success.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { DatabaseSync } from 'node:sqlite';
import {
  createApp,
  VERIFY_IP_LIMIT,
  VERIFY_START_DOMAIN_LIMIT,
  type VerifyRateLimits,
} from '../src/index.ts';
import { RateLimiter, DAY_MS, HOUR_MS, memoryStore } from '../src/rate-limit.ts';
import { VERIFY_TOKEN_TTL_MS } from '../src/verification.ts';
import { openSeededDb } from './helpers.ts';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function freshVerifyLimits(): VerifyRateLimits {
  return {
    dailyDomain: new RateLimiter(memoryStore(), VERIFY_START_DOMAIN_LIMIT, DAY_MS, 'verify-domain'),
    hourlyIp: new RateLimiter(memoryStore(), VERIFY_IP_LIMIT, HOUR_MS, 'verify-ip'),
  };
}

interface ProbeRoutes {
  file?: () => Response | Promise<Response>;
  home?: () => Response | Promise<Response>;
  doh?: () => Response | Promise<Response>;
}

/** One fake fetch for all probe targets; unconfigured targets fail politely. */
function probeFetch(routes: ProbeRoutes): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('cloudflare-dns.com')) {
      return routes.doh ? await routes.doh() : Response.json({ Status: 0, Answer: [] });
    }
    if (url.includes('/.well-known/afr-verify.txt')) {
      return routes.file ? await routes.file() : new Response('nope', { status: 404 });
    }
    return routes.home ? await routes.home() : new Response('not found', { status: 404 });
  }) as unknown as typeof fetch;
}

function freshApp(fetchImpl?: typeof fetch) {
  const { db, raw } = openSeededDb();
  const app = createApp({ db, verifyLimits: freshVerifyLimits(), fetchImpl });
  return { app, raw };
}

function start(app: ReturnType<typeof createApp>, domain: string, ip = '203.0.113.40') {
  return app.request('/api/v1/verify/start', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
    body: JSON.stringify({ domain }),
  });
}

function check(app: ReturnType<typeof createApp>, domain: string, ip = '203.0.113.40') {
  return app.request(`/api/v1/verify/check?domain=${encodeURIComponent(domain)}`, {
    headers: { 'x-forwarded-for': ip },
  });
}

/** Plant a pending token directly (probe tests only need the row, not the start flow) */
function seedToken(raw: DatabaseSync, domain: string, token: string): void {
  raw
    .prepare(
      `INSERT INTO verify_tokens (domain, token, created_at, expires_at, used_at)
       VALUES (?, ?, ?, ?, NULL)`,
    )
    .run(
      domain,
      token,
      new Date().toISOString(),
      new Date(Date.now() + VERIFY_TOKEN_TTL_MS).toISOString(),
    );
}

// ---------------------------------------------------------------------------
// POST /api/v1/verify/start
// ---------------------------------------------------------------------------

describe('POST /api/v1/verify/start', () => {
  it('returns a 7-day token with the three method snippets and stores it', async () => {
    const { app, raw } = freshApp();
    const before = Date.now();

    const res = await start(app, 'Example.COM');
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.match(body.token, /^av-[0-9a-f]{32}$/, 'opaque av- + 32 hex token');
    const expires = Date.parse(body.expiresAt);
    assert.ok(expires >= before + VERIFY_TOKEN_TTL_MS - 5000, 'expiresAt ≈ now + 7 days');
    assert.ok(expires <= Date.now() + VERIFY_TOKEN_TTL_MS + 5000);
    assert.equal(body.checkUrl, '/api/v1/verify/check?domain=example.com');
    assert.deepEqual(body.methods.file, {
      url: 'https://example.com/.well-known/afr-verify.txt',
      content: body.token,
    });
    assert.deepEqual(body.methods.dns, {
      type: 'TXT',
      name: 'example.com',
      value: `afr-verify=${body.token}`,
    });
    assert.deepEqual(body.methods.meta, {
      name: 'afr-verification',
      content: body.token,
    });

    const row = raw
      .prepare('SELECT domain, token, created_at, expires_at, used_at FROM verify_tokens')
      .get() as {
      domain: string;
      token: string;
      created_at: string;
      expires_at: string;
      used_at: string | null;
    };
    assert.equal(row.domain, 'example.com');
    assert.equal(row.token, body.token);
    assert.equal(row.expires_at, body.expiresAt);
    assert.equal(row.used_at, null, 'fresh token is unused');
    assert.ok(row.created_at);
  });

  it('rejects bad JSON and invalid domains with 400', async () => {
    const { app, raw } = freshApp();

    const badJson = await app.request('/api/v1/verify/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{nope',
    });
    assert.equal(badJson.status, 400);
    assert.equal((await badJson.json()).error, 'invalid_json');

    for (const domain of ['http://example.com', 'foo', 42]) {
      const res = await start(app, domain as string);
      assert.equal(res.status, 400, `expected 400 for ${String(domain)}`);
      assert.equal((await res.json()).error, 'invalid_domain');
    }
    assert.equal(
      (raw.prepare('SELECT COUNT(*) AS n FROM verify_tokens').get() as { n: number }).n,
      0,
      'no token row on rejected requests',
    );
  });

  it('limits starts to 3 per domain per day', async () => {
    const { app, raw } = freshApp();
    for (let i = 0; i < VERIFY_START_DOMAIN_LIMIT; i++) {
      const res = await start(app, 'example.com');
      assert.equal(res.status, 200, `start ${i + 1} should pass`);
    }
    const blocked = await start(app, 'example.com');
    assert.equal(blocked.status, 429);
    const body = await blocked.json();
    assert.equal(body.error, 'rate_limited');
    assert.ok(body.retryAfter > 0 && body.retryAfter <= 86400);
    assert.ok(Date.parse(body.nextAllowedAt) > Date.now());
    assert.ok(Number(blocked.headers.get('retry-after')) > 0, 'Retry-After header present');
    assert.equal(
      (raw.prepare('SELECT COUNT(*) AS n FROM verify_tokens').get() as { n: number }).n,
      VERIFY_START_DOMAIN_LIMIT,
      'no token minted on the rejected request',
    );
  });

  it('limits starts to 10 per IP per hour across domains', async () => {
    const { app } = freshApp();
    for (let i = 0; i < VERIFY_IP_LIMIT; i++) {
      const res = await start(app, `ip${i}.example`, '203.0.113.50');
      assert.equal(res.status, 200, `start ${i + 1} should pass`);
    }
    const blocked = await start(app, 'one-too-many.example', '203.0.113.50');
    assert.equal(blocked.status, 429);
    assert.equal((await blocked.json()).error, 'rate_limited');

    const otherIp = await start(app, 'fresh-ip.example', '203.0.113.51');
    assert.equal(otherIp.status, 200, 'another IP is unaffected');
  });
});

// ---------------------------------------------------------------------------
// GET /api/v1/verify/check
// ---------------------------------------------------------------------------

describe('GET /api/v1/verify/check', () => {
  it('rejects invalid domains and reports missing tokens with 400', async () => {
    const { app } = freshApp();

    const invalid = await app.request('/api/v1/verify/check?domain=not_a_domain', {
      headers: { 'x-forwarded-for': '203.0.113.60' },
    });
    assert.equal(invalid.status, 400);
    assert.equal((await invalid.json()).error, 'invalid_domain');

    const missing = await check(app, 'ghost.example');
    assert.equal(missing.status, 400);
    assert.equal((await missing.json()).error, 'no_pending_verification');
  });

  it('ignores expired and already-used tokens', async () => {
    const { app, raw } = freshApp();
    raw
      .prepare(
        `INSERT INTO verify_tokens (domain, token, created_at, expires_at, used_at)
         VALUES ('old.example', 'av-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', '2026-11-01T00:00:00.000Z', '2026-11-08T00:00:00.000Z', NULL)`,
      )
      .run();
    raw
      .prepare(
        `INSERT INTO verify_tokens (domain, token, created_at, expires_at, used_at)
         VALUES ('used.example', 'av-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', '2026-11-01T00:00:00.000Z', '2099-01-01T00:00:00.000Z', '2026-11-02T00:00:00.000Z')`,
      )
      .run();

    const expired = await check(app, 'old.example');
    assert.equal(expired.status, 400);
    assert.equal((await expired.json()).error, 'no_pending_verification');

    const used = await check(app, 'used.example');
    assert.equal(used.status, 400);
    assert.equal((await used.json()).error, 'no_pending_verification');
  });

  it('verifies via the well-known file and writes owner + site', async () => {
    const token = `av-${'c'.repeat(32)}`;
    const impl = probeFetch({ file: () => new Response(`  ${token}\n`, { status: 200 }) });
    const { app, raw } = freshApp(impl);
    seedToken(raw, 'coolsite.io', token);

    const res = await check(app, 'coolsite.io');
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { verified: true, method: 'file' });

    const owner = raw
      .prepare('SELECT domain, verify_method, verified_at FROM owners')
      .get() as { domain: string; verify_method: string; verified_at: string };
    assert.equal(owner.domain, 'coolsite.io');
    assert.equal(owner.verify_method, 'file');
    assert.ok(owner.verified_at);

    const site = raw.prepare('SELECT verified FROM sites WHERE domain = ?').get('coolsite.io') as {
      verified: number;
    };
    assert.equal(site.verified, 1, 'sites.verified flipped to 1');

    const tok = raw.prepare('SELECT used_at FROM verify_tokens WHERE token = ?').get(token) as {
      used_at: string | null;
    };
    assert.ok(tok.used_at, 'token marked used');
  });

  it('verifies via DNS TXT over the DoH endpoint', async () => {
    const token = `av-${'d'.repeat(32)}`;
    const impl = probeFetch({
      doh: () =>
        Response.json({
          Status: 0,
          Answer: [{ name: 'fresh.example', type: 16, data: `"afr-verify=${token}"` }],
        }),
    });
    const { app, raw } = freshApp(impl);
    seedToken(raw, 'fresh.example', token);

    const res = await check(app, 'fresh.example');
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { verified: true, method: 'dns' });

    const owner = raw
      .prepare('SELECT verify_method FROM owners WHERE domain = ?')
      .get('fresh.example') as {
      verify_method: string;
    };
    assert.equal(owner.verify_method, 'dns-txt', 'schema spelling for the DNS method');
    assert.equal(
      raw.prepare(`SELECT * FROM sites WHERE domain = 'fresh.example'`).get(),
      undefined,
      'no sites row is created for an unlisted domain',
    );
  });

  it('verifies via the homepage meta tag (case-insensitive)', async () => {
    const token = `av-${'e'.repeat(32)}`;
    const impl = probeFetch({
      home: () =>
        new Response(
          `<html><head><META NAME="afr-verification" CONTENT="${token}"></head></html>`,
          { status: 200 },
        ),
    });
    const { app, raw } = freshApp(impl);
    seedToken(raw, 'meta.example', token);

    const res = await check(app, 'meta.example');
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { verified: true, method: 'meta' });
    const owner = raw
      .prepare('SELECT verify_method FROM owners WHERE domain = ?')
      .get('meta.example') as {
      verify_method: string;
    };
    assert.equal(owner.verify_method, 'meta');
  });

  it('returns failed checks (never a 500) when nothing matches', async () => {
    const token = `av-${'f'.repeat(32)}`;
    const impl = probeFetch({
      file: () => new Response('wrong content', { status: 200 }),
      home: () => new Response('<html><head><title>hi</title></head></html>', { status: 200 }),
      doh: () => Response.json({ Status: 0, Answer: [] }),
    });
    const { app, raw } = freshApp(impl);
    seedToken(raw, 'coolsite.io', token);

    const res = await check(app, 'coolsite.io');
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.verified, false);
    assert.equal(body.checks.length, 3);
    assert.deepEqual(
      body.checks.map((c: { method: string }) => c.method),
      ['file', 'dns', 'meta'],
    );
    for (const c of body.checks) {
      assert.equal(c.ok, false);
      assert.equal(typeof c.detail, 'string');
      assert.ok(c.detail.length <= 80, `detail too long: ${c.detail}`);
      assert.ok(!c.detail.includes('<html'), 'detail never contains raw HTML');
    }

    assert.equal(
      (raw.prepare('SELECT COUNT(*) AS n FROM owners').get() as { n: number }).n,
      0,
      'no owner row on failure',
    );
    const site = raw.prepare('SELECT verified FROM sites WHERE domain = ?').get('coolsite.io') as {
      verified: number;
    };
    assert.equal(site.verified, 0, 'site stays unverified');
    const tok = raw
      .prepare(`SELECT used_at FROM verify_tokens WHERE domain = 'coolsite.io'`)
      .get() as { used_at: string | null };
    assert.equal(tok.used_at, null, 'token stays pending after a failed check');
  });

  it('degrades to verified:false when the network fails on every probe', async () => {
    const token = `av-${'9'.repeat(32)}`;
    const impl = probeFetch({
      file: () => {
        throw new Error('network down');
      },
      home: () => {
        throw new Error('network down');
      },
      doh: () => {
        throw new Error('network down');
      },
    });
    const { app, raw } = freshApp(impl);
    seedToken(raw, 'offline.example', token);

    const res = await check(app, 'offline.example');
    assert.equal(res.status, 200, 'network failure is not a 500');
    const body = await res.json();
    assert.equal(body.verified, false);
    assert.equal(body.checks.length, 3);
    for (const c of body.checks) {
      assert.equal(c.ok, false);
      assert.ok(c.detail.includes('network down'), `detail: ${c.detail}`);
      assert.ok(c.detail.length <= 80);
    }
  });

  it('limits checks to 10 per IP per hour', async () => {
    const { app } = freshApp();
    for (let i = 0; i < VERIFY_IP_LIMIT; i++) {
      const res = await check(app, `probe${i}.example`, '203.0.113.70');
      assert.equal(res.status, 400, `check ${i + 1} consumes quota even without a token`);
    }
    const blocked = await check(app, 'probe-late.example', '203.0.113.70');
    assert.equal(blocked.status, 429);
    const body = await blocked.json();
    assert.equal(body.error, 'rate_limited');
    assert.ok(body.retryAfter > 0);
    assert.ok(Number(blocked.headers.get('retry-after')) > 0);

    const otherIp = await check(app, 'probe.example', '203.0.113.71');
    assert.equal(otherIp.status, 400, 'another IP still gets the normal 400');
  });
});
