// test/email.test.ts — owner mailbox subsystem: address validation, mailbox
// encryption (AES-256-GCM + keyed HMAC), magic tokens, the domain-control
// challenge probes, the Resend delivery helper, the owner-email routes
// (challenge → registration → confirmation → management token) and the
// score-change notification outbox (enqueue + drain).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { DatabaseSync } from 'node:sqlite';
import {
  createApp,
  EMAIL_DOMAIN_LIMIT,
  EMAIL_IP_LIMIT,
  EMAIL_START_DOMAIN_LIMIT,
  EMAIL_START_IP_LIMIT,
  EMAIL_VERIFY_IP_LIMIT,
  type EmailRateLimits,
  type WorkerEnv,
} from '../src/index.ts';
import {
  buildMagicToken,
  buildMailChallenge,
  buildManageToken,
  decryptEmail,
  drainNotifyOutbox,
  emailHash,
  encryptEmail,
  enqueueScoreChangeNotifications,
  hasMailChallengeMeta,
  hashToken,
  magicLinkUrl,
  maskEmail,
  normalizeEmail,
  probeMailChallenge,
  renderScoreChangeEmail,
  sendEmailViaResend,
} from '../src/email.ts';
import { RateLimiter, DAY_MS, HOUR_MS, memoryStore } from '../src/rate-limit.ts';
import { openSeededDb } from './helpers.ts';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** 32-byte secret in base64 — the production shape of EMAIL_ENC_KEY */
const SECRET = btoa('a'.repeat(32));
/** A different secret: used to prove the cipher really is keyed */
const OTHER_SECRET = btoa('b'.repeat(32));
/** Dummy provider key — it must never show up in an error message */
const API_KEY = 're_test_key_do_not_log';

function freshEmailLimits(): EmailRateLimits {
  return {
    dailyDomain: new RateLimiter(memoryStore(), EMAIL_DOMAIN_LIMIT, DAY_MS, 'email-domain'),
    hourlyIp: new RateLimiter(memoryStore(), EMAIL_IP_LIMIT, HOUR_MS, 'email-ip'),
    verifyIp: new RateLimiter(memoryStore(), EMAIL_VERIFY_IP_LIMIT, HOUR_MS, 'email-verify-ip'),
    startDomain: new RateLimiter(memoryStore(), EMAIL_START_DOMAIN_LIMIT, DAY_MS, 'email-start-domain'),
    startIp: new RateLimiter(memoryStore(), EMAIL_START_IP_LIMIT, HOUR_MS, 'email-start-ip'),
  };
}

interface SentCall {
  url: string;
  init?: RequestInit;
}

/** Fake Resend endpoint: records the calls and answers with a provider body. */
function fakeResend(options: { status?: number; body?: unknown } = {}) {
  const calls: SentCall[] = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    const status = options.status ?? 200;
    return Response.json(options.body ?? { id: 'email_123' }, { status });
  }) as unknown as typeof fetch;
  return { calls, impl };
}

/** The fake "domain" of the owner: it answers the three challenge probes and
 * the Resend endpoint. `challenge` is the value the site publishes — setting
 * it to null makes the site publish nothing. */
interface FakeSite {
  challenge: string | null;
  /** which publication methods answer with the challenge */
  methods?: Set<'dns' | 'file' | 'meta'>;
  /** status the Resend endpoint answers with */
  resendStatus?: number;
}

function fakeSite(state: FakeSite) {
  const calls: SentCall[] = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    if (url.startsWith('https://api.resend.com/emails')) {
      return Response.json({ id: 'email_123' }, { status: state.resendStatus ?? 200 });
    }
    const methods = state.methods ?? new Set(['dns', 'file', 'meta']);
    if (url.includes('cloudflare-dns.com')) {
      if (!state.challenge || !methods.has('dns')) {
        return Response.json({ Status: 0, Answer: [] });
      }
      return Response.json({
        Status: 0,
        Answer: [{ type: 16, data: `afr-mail=${state.challenge}` }],
      });
    }
    if (url.includes('/.well-known/afr-mail.txt')) {
      if (!state.challenge || !methods.has('file')) {
        return new Response('not found', { status: 404 });
      }
      return new Response(state.challenge, { headers: { 'content-type': 'text/plain' } });
    }
    // everything else is the homepage
    if (!state.challenge || !methods.has('meta')) {
      return new Response('<html><head></head></html>');
    }
    return new Response(
      `<html><head><meta name="afr-mail-verification" content="${state.challenge}"></head></html>`,
    );
  }) as unknown as typeof fetch;
  return { calls, impl, state };
}

function envWith(overrides: Partial<WorkerEnv> = {}): WorkerEnv {
  return { DB: undefined as unknown as WorkerEnv['DB'], ...overrides };
}

function freshApp(fetchImpl?: typeof fetch, limits: EmailRateLimits = freshEmailLimits()) {
  const { db, raw } = openSeededDb();
  const app = createApp({ db, emailLimits: limits, fetchImpl });
  return { app, raw };
}

function post(
  app: ReturnType<typeof createApp>,
  path: string,
  body: unknown,
  ip = '203.0.113.70',
  env?: WorkerEnv,
  bearer?: string,
): Promise<Response> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'x-forwarded-for': ip,
  };
  if (bearer) headers.authorization = `Bearer ${bearer}`;
  return app.request(
    path,
    {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    },
    env,
  );
}

function get(
  app: ReturnType<typeof createApp>,
  path: string,
  ip = '203.0.113.70',
  env?: WorkerEnv,
  bearer?: string,
): Promise<Response> {
  const headers: Record<string, string> = { 'x-forwarded-for': ip };
  if (bearer) headers.authorization = `Bearer ${bearer}`;
  return app.request(path, { headers }, env);
}

interface OwnerEmailRow {
  domain: string;
  email_cipher: string;
  email_hash: string;
  verified_at: string | null;
  verify_token_hash: string | null;
  verify_expires_at: string | null;
  manage_token_hash: string | null;
  notify: number | null;
}

/** Ask for a domain-control challenge and return its value. */
async function startChallenge(
  app: ReturnType<typeof createApp>,
  domain: string,
  email: string,
  ip = '203.0.113.70',
): Promise<string> {
  const res = await post(
    app,
    '/api/v1/owners/email/start',
    { domain, email },
    ip,
    envWith({ EMAIL_ENC_KEY: SECRET }),
  );
  assert.equal(res.status, 200, `challenge failed: ${res.status}`);
  const body = (await res.json()) as { challenge: string };
  return body.challenge;
}

/** Run the whole owner flow: challenge → publish → register → confirm.
 * Returns the management token that authorises every later change. */
async function onboardOwner(
  app: ReturnType<typeof createApp>,
  site: FakeSite,
  domain: string,
  email: string,
  ip = '203.0.113.70',
): Promise<{ manageToken: string; verifyToken: string }> {
  const challenge = await startChallenge(app, domain, email, ip);
  site.challenge = challenge;
  const res = await post(
    app,
    '/api/v1/owners/email',
    { domain, email, challenge },
    ip,
    envWith({ EMAIL_ENC_KEY: SECRET }),
  );
  assert.equal(res.status, 200, `registration failed: ${res.status}`);
  const body = (await res.json()) as { verifyUrl?: string };
  const token = /token=([0-9a-f]{32})/.exec(String(body.verifyUrl))?.[1];
  assert.ok(token, 'the registration hands out the confirmation link');
  const verified = await get(app, `/api/v1/owners/email/verify?token=${token}`, ip);
  assert.equal(verified.status, 200);
  const { manageToken } = (await verified.json()) as { manageToken: string };
  assert.ok(manageToken, 'the confirmation hands out the management token');
  return { manageToken, verifyToken: token };
}

// ---------------------------------------------------------------------------
// Address validation
// ---------------------------------------------------------------------------

describe('normalizeEmail', () => {
  it('accepts deliverable addresses and canonicalizes them', () => {
    assert.equal(normalizeEmail('owner@example.com'), 'owner@example.com');
    assert.equal(normalizeEmail('  Owner@Example.COM  '), 'owner@example.com');
    assert.equal(normalizeEmail('a.b+tag@sub.example.co.uk'), 'a.b+tag@sub.example.co.uk');
  });

  it('rejects malformed addresses', () => {
    const bad: unknown[] = [
      '',
      'a@b', // no dot in the domain
      'a@@b.com', // two @
      'a@b@c.com',
      'a b@example.com', // whitespace
      'no-at-sign',
      '@example.com', // empty local part
      'owner@', // empty domain
      'owner@.com',
      'owner@com.',
      'owner@b..com',
      'owner@b.c', // one-letter TLD
      42,
      null,
      undefined,
      {},
    ];
    for (const value of bad) {
      assert.equal(normalizeEmail(value), null, `expected null for ${JSON.stringify(value)}`);
    }
  });

  it('masks an address for public output', () => {
    assert.equal(maskEmail('owner@example.com'), 'o***@example.com');
    assert.equal(maskEmail('broken'), '***');
  });
});

// ---------------------------------------------------------------------------
// Mailbox encryption
// ---------------------------------------------------------------------------

describe('mailbox encryption', () => {
  it('round-trips an address without ever exposing the plaintext', async () => {
    const { cipher, hash } = await encryptEmail('Owner@Example.com', SECRET);
    assert.ok(!cipher.includes('owner@example.com'));
    assert.ok(!cipher.includes('Owner'));
    assert.match(hash, /^[0-9a-f]{64}$/);
    assert.equal(await decryptEmail(cipher, SECRET), 'owner@example.com');
  });

  it('uses a fresh IV per call but a stable lookup hash', async () => {
    const first = await encryptEmail('owner@example.com', SECRET);
    const second = await encryptEmail('owner@example.com', SECRET);
    assert.notEqual(first.cipher, second.cipher, 'a fresh IV means a fresh ciphertext');
    assert.equal(first.hash, second.hash, 'the lookup hash is deterministic');
  });

  it('refuses to decrypt with the wrong secret', async () => {
    const { cipher } = await encryptEmail('owner@example.com', SECRET);
    await assert.rejects(() => decryptEmail(cipher, OTHER_SECRET));
  });

  it('derives the lookup hash from the same key material as encryptEmail', async () => {
    const { hash } = await encryptEmail('Owner@Example.com', SECRET);
    assert.equal(await emailHash('owner@example.com', SECRET), hash);
    assert.equal(await emailHash('owner@example.com', OTHER_SECRET).then((other) => other === hash), false);
  });
});

// ---------------------------------------------------------------------------
// Magic tokens
// ---------------------------------------------------------------------------

describe('magic tokens', () => {
  it('hashes a token to 64 hex characters, stably', async () => {
    const token = buildMagicToken();
    assert.match(token, /^[0-9a-f]{32}$/);
    const hash = await hashToken(token);
    assert.match(hash, /^[0-9a-f]{64}$/);
    assert.equal(await hashToken(token), hash);
    assert.notEqual(await hashToken('another-token'), hash);
  });

  it('escapes the token inside the magic link', () => {
    assert.equal(
      magicLinkUrl('https://afr.im', 'abc+def/ghi'),
      'https://afr.im/api/v1/owners/email/verify?token=abc%2Bdef%2Fghi',
    );
  });

  it('mints prefixed challenge and management tokens', () => {
    assert.match(buildMailChallenge(), /^ch-[0-9a-f]{32}$/);
    assert.match(buildManageToken(), /^manage-[0-9a-f]{32}$/);
    assert.notEqual(buildMailChallenge(), buildMailChallenge());
  });
});

// ---------------------------------------------------------------------------
// Mail rendering + delivery
// ---------------------------------------------------------------------------

describe('renderScoreChangeEmail', () => {
  it('shows the old and the new rating plus the report link', () => {
    const mail = renderScoreChangeEmail({
      domain: 'example.com',
      prevGrade: 'A',
      prevScore: 92,
      grade: 'B',
      score: 78,
      reportUrl: 'https://afr.im/site/example.com',
    });
    assert.equal(mail.subject, 'AFR rating changed: example.com is now B (78)');
    assert.match(mail.text, /Previous rating: A \(92\)/);
    assert.match(mail.text, /New rating: B \(78\)/);
    assert.match(mail.text, /https:\/\/afr\.im\/site\/example\.com/);
    assert.match(mail.html, /A \(92\)/);
    assert.match(mail.html, /B \(78\)/);
    assert.match(mail.html, /href="https:\/\/afr\.im\/site\/example\.com"/);
    assert.ok(!/<script/i.test(mail.html), 'the HTML mail carries no script');
  });
});

describe('sendEmailViaResend', () => {
  const args = {
    apiKey: API_KEY,
    from: 'AFR <notifications@afr.im>',
    to: 'owner@example.com',
    subject: 'AFR rating changed: example.com is now B (78)',
    text: 'body',
    html: '<p>body</p>',
    idempotencyKey: 'email-verify:example.com:abc',
  };

  it('posts to Resend with the idempotency key and the mail body', async () => {
    const { calls, impl } = fakeResend();
    const res = await sendEmailViaResend(args, impl);

    assert.equal(res.ok, true);
    assert.equal(res.id, 'email_123');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://api.resend.com/emails');

    const init = calls[0].init as RequestInit;
    assert.equal(init.method, 'POST');
    const headers = init.headers as Record<string, string>;
    assert.equal(headers.authorization, `Bearer ${API_KEY}`);
    assert.equal(headers['content-type'], 'application/json');
    assert.equal(headers['idempotency-key'], 'email-verify:example.com:abc');
    assert.deepEqual(JSON.parse(String(init.body)), {
      from: 'AFR <notifications@afr.im>',
      to: 'owner@example.com',
      subject: args.subject,
      text: 'body',
      html: '<p>body</p>',
    });
  });

  it('reports a provider failure without leaking the key or the address', async () => {
    const { impl } = fakeResend({
      status: 500,
      body: { message: `rejected owner@example.com with key ${API_KEY}` },
    });
    const res = await sendEmailViaResend(args, impl);

    assert.equal(res.ok, false);
    assert.ok(res.error);
    assert.ok(!res.error.includes(API_KEY), 'the API key never appears in an error');
    assert.ok(!res.error.includes('owner@example.com'), 'the full address never appears in an error');
    assert.match(res.error, /o\*\*\*@example\.com/, 'the address is masked');
    assert.ok(res.error.length <= 200, 'the error is truncated');
  });

  it('survives a network failure', async () => {
    const impl = (async () => {
      throw new Error('network down');
    }) as unknown as typeof fetch;
    const res = await sendEmailViaResend(args, impl);

    assert.equal(res.ok, false);
    assert.match(res.error ?? '', /network error/);
    assert.ok(!(res.error ?? '').includes(API_KEY));
  });
});

// ---------------------------------------------------------------------------
// probeMailChallenge — the domain-control proof
// ---------------------------------------------------------------------------

describe('probeMailChallenge', () => {
  const CHALLENGE = 'ch-0123456789abcdef0123456789abcdef';

  it('matches a DNS TXT record', async () => {
    const impl = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('cloudflare-dns.com')) {
        return Response.json({
          Status: 0,
          Answer: [{ type: 16, data: `afr-mail=${CHALLENGE}` }],
        });
      }
      return new Response('not found', { status: 404 });
    }) as unknown as typeof fetch;

    const res = await probeMailChallenge('example.com', CHALLENGE, impl);
    assert.equal(res.ok, true);
    assert.equal(res.method, 'dns');
  });

  it('matches the well-known file', async () => {
    const impl = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/.well-known/afr-mail.txt')) return new Response(`${CHALLENGE}\n`);
      return new Response('not found', { status: 404 });
    }) as unknown as typeof fetch;

    const res = await probeMailChallenge('example.com', CHALLENGE, impl);
    assert.equal(res.ok, true);
    assert.equal(res.method, 'file');
  });

  it('matches the homepage meta tag (any attribute order and case)', async () => {
    const impl = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === 'https://example.com/') {
        return new Response(
          '<html><head><META CONTENT="' + CHALLENGE + '" NAME="afr-mail-verification"></head></html>',
        );
      }
      return new Response('not found', { status: 404 });
    }) as unknown as typeof fetch;

    const res = await probeMailChallenge('example.com', CHALLENGE, impl);
    assert.equal(res.ok, true);
    assert.equal(res.method, 'meta');
  });

  it('reports a miss without throwing and without leaking remote bodies', async () => {
    const impl = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('cloudflare-dns.com')) return Response.json({ Status: 0, Answer: [] });
      if (url.endsWith('/.well-known/afr-mail.txt')) {
        return new Response('some other content', { status: 200 });
      }
      return new Response('<html><head><meta name="afr-mail-verification" content="other"></head></html>');
    }) as unknown as typeof fetch;

    const res = await probeMailChallenge('example.com', CHALLENGE, impl);
    assert.equal(res.ok, false);
    assert.equal(res.method, null);
    assert.ok(res.detail.length <= 80, 'the detail stays short');
    assert.ok(!res.detail.includes('some other content'), 'no remote body in the detail');
  });

  it('treats a network failure as "not observed" instead of throwing', async () => {
    const impl = (async () => {
      throw new Error('network down');
    }) as unknown as typeof fetch;

    const res = await probeMailChallenge('example.com', CHALLENGE, impl);
    assert.equal(res.ok, false);
    assert.equal(res.method, null);
    assert.ok(res.detail.length <= 80);
  });

  it('matches the meta tag only with the exact challenge value', () => {
    const html = '<html><head><meta name="afr-mail-verification" content="ch-abc"></head></html>';
    assert.equal(hasMailChallengeMeta(html, 'ch-abc'), true);
    assert.equal(hasMailChallengeMeta(html, 'ch-abd'), false);
    assert.equal(hasMailChallengeMeta('<meta content="ch-abc">', 'ch-abc'), false);
  });
});

// ---------------------------------------------------------------------------
// POST /api/v1/owners/email/start — the domain-control challenge
// ---------------------------------------------------------------------------

describe('POST /api/v1/owners/email/start', () => {
  it('rejects an invalid domain or address with 400', async () => {
    const { app } = freshApp();
    const env = envWith({ EMAIL_ENC_KEY: SECRET });

    const badDomain = await post(
      app,
      '/api/v1/owners/email/start',
      { domain: 'http://example.com', email: 'owner@example.com' },
      '203.0.113.71',
      env,
    );
    assert.equal(badDomain.status, 400);
    assert.equal((await badDomain.json()).error, 'invalid_domain');

    const badEmail = await post(
      app,
      '/api/v1/owners/email/start',
      { domain: 'example.com', email: 'not-an-address' },
      '203.0.113.71',
      env,
    );
    assert.equal(badEmail.status, 400);
    assert.equal((await badEmail.json()).error, 'invalid_email');
  });

  it('answers 404 for a domain AFR does not list', async () => {
    const { app } = freshApp();
    const res = await post(
      app,
      '/api/v1/owners/email/start',
      { domain: 'unknown-domain.test', email: 'owner@unknown-domain.test' },
      '203.0.113.72',
      envWith({ EMAIL_ENC_KEY: SECRET }),
    );
    assert.equal(res.status, 404);
    assert.equal((await res.json()).error, 'unknown_domain');
  });

  it('answers 503 when the encryption key is not configured', async () => {
    const { app } = freshApp();
    const res = await post(
      app,
      '/api/v1/owners/email/start',
      { domain: 'example.com', email: 'owner@example.com' },
      '203.0.113.73',
      envWith(),
    );
    assert.equal(res.status, 503);
    assert.equal((await res.json()).error, 'email_not_configured');
  });

  it('returns the challenge with the three publication methods and stores only the hash', async () => {
    const { app, raw } = freshApp();

    const res = await post(
      app,
      '/api/v1/owners/email/start',
      { domain: 'Example.com', email: 'Owner@Example.com' },
      '203.0.113.74',
      envWith({ EMAIL_ENC_KEY: SECRET }),
    );
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      challenge: string;
      methods: {
        dns: { type: string; name: string; value: string };
        file: { url: string; content: string };
        meta: { name: string; content: string };
      };
      expiresAt: string;
    };

    assert.match(body.challenge, /^ch-[0-9a-f]{32}$/);
    assert.equal(body.methods.dns.type, 'TXT');
    assert.equal(body.methods.dns.name, 'example.com');
    assert.equal(body.methods.dns.value, `afr-mail=${body.challenge}`);
    assert.equal(body.methods.file.url, 'https://example.com/.well-known/afr-mail.txt');
    assert.equal(body.methods.file.content, body.challenge);
    assert.equal(body.methods.meta.name, 'afr-mail-verification');
    assert.equal(body.methods.meta.content, body.challenge);
    assert.ok(Date.parse(body.expiresAt) > Date.now(), 'the challenge expires in the future');

    // the database holds the hash only — never the challenge value itself
    const row = raw.prepare('SELECT * FROM email_challenges').get() as {
      domain: string;
      challenge_hash: string;
      email_cipher: string;
      email_hash: string;
      used_at: string | null;
    };
    assert.equal(row.domain, 'example.com');
    assert.equal(row.challenge_hash, await hashToken(body.challenge));
    assert.notEqual(row.challenge_hash, body.challenge);
    assert.equal(row.used_at, null, 'the challenge is unused');
    assert.ok(!JSON.stringify(row).includes(body.challenge), 'the challenge value is not stored');
    assert.ok(!row.email_cipher.includes('owner@example.com'), 'the mailbox is encrypted');
  });

  it('rate-limits the challenges per domain and per IP', async () => {
    const { app } = freshApp();
    const env = envWith({ EMAIL_ENC_KEY: SECRET });

    for (let i = 0; i < 3; i += 1) {
      const res = await post(
        app,
        '/api/v1/owners/email/start',
        { domain: 'example.com', email: 'owner@example.com' },
        `198.51.100.${i + 1}`,
        env,
      );
      assert.equal(res.status, 200, `challenge ${i + 1} should pass`);
    }
    const fourth = await post(
      app,
      '/api/v1/owners/email/start',
      { domain: 'example.com', email: 'owner@example.com' },
      '198.51.100.9',
      env,
    );
    assert.equal(fourth.status, 429);
    assert.equal((await fourth.json()).error, 'rate_limited');
  });
});

// ---------------------------------------------------------------------------
// POST /api/v1/owners/email — registration behind the challenge
// ---------------------------------------------------------------------------

describe('POST /api/v1/owners/email', () => {
  it('answers 503 when the encryption key is not configured', async () => {
    const { app } = freshApp();
    const res = await post(
      app,
      '/api/v1/owners/email',
      { domain: 'example.com', email: 'owner@example.com', challenge: 'ch-x' },
      '203.0.113.75',
      envWith(),
    );
    assert.equal(res.status, 503);
    assert.equal((await res.json()).error, 'email_not_configured');
  });

  it('rejects a missing challenge with 400', async () => {
    const { app } = freshApp();
    const env = envWith({ EMAIL_ENC_KEY: SECRET });

    const missing = await post(
      app,
      '/api/v1/owners/email',
      { domain: 'example.com', email: 'owner@example.com' },
      '203.0.113.76',
      env,
    );
    assert.equal(missing.status, 400);
    assert.equal((await missing.json()).error, 'invalid_challenge');

    const badEmail = await post(
      app,
      '/api/v1/owners/email',
      { domain: 'example.com', email: 'not-an-address', challenge: 'ch-x' },
      '203.0.113.76',
      env,
    );
    assert.equal(badEmail.status, 400);
    assert.equal((await badEmail.json()).error, 'invalid_email');
  });

  it('rejects an unknown challenge with 403 challenge_not_found', async () => {
    const site = fakeSite({ challenge: null });
    const { app } = freshApp(site.impl);
    await startChallenge(app, 'example.com', 'owner@example.com', '203.0.113.77');
    site.state.challenge = 'ch-0123456789abcdef0123456789abcdef';

    const res = await post(
      app,
      '/api/v1/owners/email',
      {
        domain: 'example.com',
        email: 'owner@example.com',
        challenge: 'ch-ffffffffffffffffffffffffffffffff',
      },
      '203.0.113.77',
      envWith({ EMAIL_ENC_KEY: SECRET }),
    );
    assert.equal(res.status, 403);
    assert.equal((await res.json()).error, 'challenge_not_found');
  });

  it('rejects a challenge the domain does not publish with 403 domain_control_failed', async () => {
    const site = fakeSite({ challenge: null });
    const { app, raw } = freshApp(site.impl);
    const challenge = await startChallenge(app, 'example.com', 'owner@example.com', '203.0.113.78');
    // the site publishes a different value
    site.state.challenge = 'ch-11111111111111111111111111111111';

    const res = await post(
      app,
      '/api/v1/owners/email',
      { domain: 'example.com', email: 'owner@example.com', challenge },
      '203.0.113.78',
      envWith({ EMAIL_ENC_KEY: SECRET }),
    );
    assert.equal(res.status, 403);
    const body = await res.json();
    assert.equal(body.error, 'domain_control_failed');
    assert.ok(Array.isArray(body.checks), 'the answer carries a per-method summary');
    assert.ok(!JSON.stringify(body).includes('owner@example.com'), 'no plaintext in the answer');

    const count = raw.prepare('SELECT COUNT(*) AS n FROM owner_emails').get() as { n: number };
    assert.equal(count.n, 0, 'nothing was stored');
  });

  it('stores the mailbox encrypted once the domain publishes the challenge', async () => {
    const site = fakeSite({ challenge: null });
    const { app, raw } = freshApp(site.impl);
    const challenge = await startChallenge(app, 'Example.com', 'Owner@Example.com', '203.0.113.79');
    site.state.challenge = challenge;

    const res = await post(
      app,
      '/api/v1/owners/email',
      { domain: 'Example.com', email: 'Owner@Example.com', challenge },
      '203.0.113.79',
      envWith({ EMAIL_ENC_KEY: SECRET }),
    );
    assert.equal(res.status, 200);
    const body = (await res.json()) as { status: string; emailed: boolean; verifyUrl: string };
    assert.equal(body.status, 'stored');
    assert.equal(body.emailed, false);
    assert.match(body.verifyUrl, /\/api\/v1\/owners\/email\/verify\?token=[0-9a-f]{32}$/);

    const row = raw.prepare('SELECT * FROM owner_emails WHERE domain = ?').get('example.com') as OwnerEmailRow;
    assert.ok(row, 'the mailbox row exists');
    assert.equal(row.domain, 'example.com');
    assert.equal(row.verified_at, null, 'the mailbox is unconfirmed until the link is clicked');
    assert.equal(row.notify, 1);
    assert.match(row.email_hash, /^[0-9a-f]{64}$/);
    assert.match(row.verify_token_hash, /^[0-9a-f]{64}$/);
    assert.equal(row.manage_token_hash, null, 'no management token before the confirmation');
    assert.ok(row.verify_expires_at);
    assert.ok(!JSON.stringify(row).includes('owner@example.com'), 'the plaintext address is not stored');
    assert.ok(!row.email_cipher.includes('owner@example.com'));

    // the challenge is consumed — it cannot be replayed
    const used = raw
      .prepare('SELECT used_at FROM email_challenges WHERE domain = ?')
      .get('example.com') as { used_at: string | null };
    assert.ok(used.used_at, 'the challenge is burned');
  });

  it('refuses to overwrite a confirmed mailbox', async () => {
    const site = fakeSite({ challenge: null });
    const { app, raw } = freshApp(site.impl);
    await onboardOwner(app, site.state, 'example.com', 'owner@example.com', '203.0.113.80');

    const before = raw
      .prepare('SELECT * FROM owner_emails WHERE domain = ?')
      .get('example.com') as OwnerEmailRow;

    // a second registration attempt for the very same mailbox
    const challenge = await startChallenge(app, 'example.com', 'owner@example.com', '203.0.113.80');
    site.state.challenge = challenge;
    const res = await post(
      app,
      '/api/v1/owners/email',
      { domain: 'example.com', email: 'owner@example.com', challenge },
      '203.0.113.80',
      envWith({ EMAIL_ENC_KEY: SECRET }),
    );
    assert.equal(res.status, 409);
    assert.equal((await res.json()).error, 'mailbox_already_verified');

    const after = raw
      .prepare('SELECT * FROM owner_emails WHERE domain = ?')
      .get('example.com') as OwnerEmailRow;
    assert.equal(after.email_cipher, before.email_cipher, 'the confirmed mailbox is untouched');
    assert.equal(after.verified_at, before.verified_at);
    assert.equal(after.manage_token_hash, before.manage_token_hash);
  });

  it('keeps the notification flag of an existing row when the mailbox is replaced', async () => {
    const site = fakeSite({ challenge: null });
    const { app, raw } = freshApp(site.impl);
    const challenge = await startChallenge(app, 'example.com', 'owner@example.com', '203.0.113.91');
    site.state.challenge = challenge;
    const first = await post(
      app,
      '/api/v1/owners/email',
      { domain: 'example.com', email: 'owner@example.com', challenge },
      '203.0.113.91',
      envWith({ EMAIL_ENC_KEY: SECRET }),
    );
    assert.equal(first.status, 200);
    raw.prepare('UPDATE owner_emails SET notify = 0 WHERE domain = ?').run('example.com');

    // a second registration replaces the (still unconfirmed) mailbox
    const next = await startChallenge(app, 'example.com', 'owner@example.com', '203.0.113.91');
    site.state.challenge = next;
    const second = await post(
      app,
      '/api/v1/owners/email',
      { domain: 'example.com', email: 'owner@example.com', challenge: next },
      '203.0.113.91',
      envWith({ EMAIL_ENC_KEY: SECRET }),
    );
    assert.equal(second.status, 200);

    const row = raw.prepare('SELECT notify FROM owner_emails WHERE domain = ?').get('example.com') as { notify: number };
    assert.equal(row.notify, 0, 'the opt-out survives a re-registration');
  });

  it('mails the magic link when a provider is configured', async () => {
    const site = fakeSite({ challenge: null });
    const { app } = freshApp(site.impl);
    const challenge = await startChallenge(app, 'example.com', 'owner@example.com', '203.0.113.81');
    site.state.challenge = challenge;

    const res = await post(
      app,
      '/api/v1/owners/email',
      { domain: 'example.com', email: 'owner@example.com', challenge },
      '203.0.113.81',
      envWith({ EMAIL_ENC_KEY: SECRET, RESEND_API_KEY: API_KEY }),
    );
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { status: 'sent', emailed: true });

    const mail = site.calls.find((call) => call.url.startsWith('https://api.resend.com/emails'));
    assert.ok(mail, 'the provider was called');
    const init = mail.init as RequestInit;
    const body = JSON.parse(String(init.body)) as { to: string; text: string; subject: string };
    assert.equal(body.to, 'owner@example.com');
    assert.match(body.subject, /example\.com/);
    assert.match(body.text, /\/api\/v1\/owners\/email\/verify\?token=[0-9a-f]{32}/);
    const headers = init.headers as Record<string, string>;
    assert.ok(headers['idempotency-key'].startsWith('email-verify:example.com:'));
  });

  it('rate-limits the registrations per domain and per IP', async () => {
    const site = fakeSite({ challenge: null });
    // The registration tier is deliberately smaller than the challenge tier:
    // the two budgets are independent, so publishing a challenge can never
    // exhaust the registration budget (and the other way round).
    const limits: EmailRateLimits = {
      dailyDomain: new RateLimiter(memoryStore(), 2, DAY_MS, 'email-domain'),
      hourlyIp: new RateLimiter(memoryStore(), 5, HOUR_MS, 'email-ip'),
      verifyIp: new RateLimiter(memoryStore(), EMAIL_VERIFY_IP_LIMIT, HOUR_MS, 'email-verify-ip'),
      startDomain: new RateLimiter(memoryStore(), 5, DAY_MS, 'email-start-domain'),
      startIp: new RateLimiter(memoryStore(), 5, HOUR_MS, 'email-start-ip'),
    };
    const { app } = freshApp(site.impl, limits);
    const env = envWith({ EMAIL_ENC_KEY: SECRET });
    const ip = '198.51.100.1';

    for (let i = 0; i < 2; i += 1) {
      const challenge = await startChallenge(app, 'example.com', 'owner@example.com', ip);
      site.state.challenge = challenge;
      const res = await post(
        app,
        '/api/v1/owners/email',
        { domain: 'example.com', email: 'owner@example.com', challenge },
        ip,
        env,
      );
      assert.equal(res.status, 200, `registration ${i + 1} should pass`);
    }

    // the third registration for the same domain is refused
    const challenge = await startChallenge(app, 'example.com', 'owner@example.com', ip);
    site.state.challenge = challenge;
    const third = await post(
      app,
      '/api/v1/owners/email',
      { domain: 'example.com', email: 'owner@example.com', challenge },
      ip,
      env,
    );
    assert.equal(third.status, 429);
    assert.equal((await third.json()).error, 'rate_limited');

    // a rejected request must not burn the IP budget either
    const otherChallenge = await startChallenge(app, 'coolsite.io', 'owner@coolsite.io', ip);
    site.state.challenge = otherChallenge;
    const other = await post(
      app,
      '/api/v1/owners/email',
      { domain: 'coolsite.io', email: 'owner@coolsite.io', challenge: otherChallenge },
      ip,
      env,
    );
    assert.equal(other.status, 200, 'a rejected request must not burn the IP budget');
  });
});

// ---------------------------------------------------------------------------
// GET /api/v1/owners/email/verify — the mailbox confirmation
// ---------------------------------------------------------------------------

describe('GET /api/v1/owners/email/verify', () => {
  it('verifies the mailbox, burns the token and hands out the management token', async () => {
    const site = fakeSite({ challenge: null });
    const { app, raw } = freshApp(site.impl);
    const { manageToken, verifyToken } = await onboardOwner(
      app,
      site.state,
      'example.com',
      'owner@example.com',
      '203.0.113.82',
    );

    assert.match(manageToken, /^manage-[0-9a-f]{32}$/);

    const row = raw.prepare('SELECT * FROM owner_emails WHERE domain = ?').get('example.com') as OwnerEmailRow;
    assert.ok(row.verified_at, 'the mailbox is confirmed');
    assert.equal(row.verify_token_hash, null, 'the token is consumed');
    assert.equal(row.manage_token_hash, await hashToken(manageToken));
    assert.ok(!JSON.stringify(row).includes(manageToken), 'only the hash of the token is stored');

    // replaying the link must fail
    const replay = await get(app, `/api/v1/owners/email/verify?token=${verifyToken}`, '203.0.113.82');
    assert.equal(replay.status, 400);
    assert.equal((await replay.json()).error, 'invalid_or_expired_token');
  });

  it('rejects an expired token', async () => {
    const { app, raw } = freshApp();
    raw
      .prepare(
        `INSERT INTO owner_emails
           (domain, email_cipher, email_hash, verified_at, verify_token_hash, verify_expires_at, notify, created_at, updated_at)
         VALUES ('example.com', 'cipher', 'hash', NULL, ?, ?, 1, '2026-11-01', '2026-11-01')`,
      )
      .run(await hashToken('expired-token'), '2020-01-01T00:00:00.000Z');

    const res = await get(app, '/api/v1/owners/email/verify?token=expired-token', '203.0.113.83');
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error, 'invalid_or_expired_token');
  });

  it('rejects an unknown token', async () => {
    const { app } = freshApp();
    const res = await get(app, '/api/v1/owners/email/verify?token=nope', '203.0.113.84');
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error, 'invalid_or_expired_token');
  });
});

// ---------------------------------------------------------------------------
// GET /api/v1/owners/email — mailbox status behind the management token
// ---------------------------------------------------------------------------

describe('GET /api/v1/owners/email', () => {
  it('requires the management token', async () => {
    const site = fakeSite({ challenge: null });
    const { app } = freshApp(site.impl);
    const { manageToken } = await onboardOwner(app, site.state, 'example.com', 'owner@example.com', '203.0.113.85');
    const env = envWith({ EMAIL_ENC_KEY: SECRET });

    const anonymous = await get(app, '/api/v1/owners/email?domain=example.com', '203.0.113.85', env);
    assert.equal(anonymous.status, 401);
    assert.equal((await anonymous.json()).error, 'unauthorized');

    const wrong = await get(
      app,
      '/api/v1/owners/email?domain=example.com',
      '203.0.113.85',
      env,
      'manage-ffffffffffffffffffffffffffffffff',
    );
    assert.equal(wrong.status, 401);
    assert.equal((await wrong.json()).error, 'unauthorized');

    // the right token opens the door
    const ok = await get(app, '/api/v1/owners/email?domain=example.com', '203.0.113.85', env, manageToken);
    assert.equal(ok.status, 200);
  });

  it('returns the masked address only', async () => {
    const site = fakeSite({ challenge: null });
    const { app } = freshApp(site.impl);
    const { manageToken } = await onboardOwner(app, site.state, 'example.com', 'owner@example.com', '203.0.113.86');

    const res = await get(
      app,
      '/api/v1/owners/email?domain=example.com',
      '203.0.113.86',
      envWith({ EMAIL_ENC_KEY: SECRET }),
      manageToken,
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(Object.keys(body).sort(), ['domain', 'email_masked', 'notify', 'verified']);
    assert.equal(body.domain, 'example.com');
    assert.equal(body.email_masked, 'o***@example.com');
    assert.equal(body.verified, true);
    assert.equal(body.notify, true);
    assert.ok(!JSON.stringify(body).includes('owner@example.com'), 'no plaintext address in the response');
  });

  it('refuses a management token of another domain', async () => {
    const site = fakeSite({ challenge: null });
    const { app } = freshApp(site.impl);
    const { manageToken } = await onboardOwner(app, site.state, 'example.com', 'owner@example.com', '203.0.113.87');

    const res = await get(
      app,
      '/api/v1/owners/email?domain=coolsite.io',
      '203.0.113.87',
      envWith({ EMAIL_ENC_KEY: SECRET }),
      manageToken,
    );
    assert.equal(res.status, 401);
    assert.equal((await res.json()).error, 'unauthorized');
  });

  it('accepts the bearer scheme in any case', async () => {
    const site = fakeSite({ challenge: null });
    const { app } = freshApp(site.impl);
    const { manageToken } = await onboardOwner(app, site.state, 'example.com', 'owner@example.com', '203.0.113.92');

    const res = await app.request('/api/v1/owners/email?domain=example.com', {
      headers: { 'x-forwarded-for': '203.0.113.92', authorization: `bearer ${manageToken}` },
    }, envWith({ EMAIL_ENC_KEY: SECRET }));
    assert.equal(res.status, 200);
  });
});

// ---------------------------------------------------------------------------
// POST /api/v1/owners/notify — the notification switch
// ---------------------------------------------------------------------------

describe('POST /api/v1/owners/notify', () => {
  it('requires the management token', async () => {
    const site = fakeSite({ challenge: null });
    const { app } = freshApp(site.impl);
    await onboardOwner(app, site.state, 'example.com', 'owner@example.com', '203.0.113.88');
    const env = envWith({ EMAIL_ENC_KEY: SECRET });

    const anonymous = await post(
      app,
      '/api/v1/owners/notify',
      { domain: 'example.com', notify: false },
      '203.0.113.88',
      env,
    );
    assert.equal(anonymous.status, 401);
    assert.equal((await anonymous.json()).error, 'unauthorized');

    const wrong = await post(
      app,
      '/api/v1/owners/notify',
      { domain: 'example.com', notify: false },
      '203.0.113.88',
      env,
      'manage-ffffffffffffffffffffffffffffffff',
    );
    assert.equal(wrong.status, 401);
    assert.equal((await wrong.json()).error, 'unauthorized');
  });

  it('updates the notification flag and keeps the token valid', async () => {
    const site = fakeSite({ challenge: null });
    const { app, raw } = freshApp(site.impl);
    const { manageToken } = await onboardOwner(app, site.state, 'example.com', 'owner@example.com', '203.0.113.89');
    const env = envWith({ EMAIL_ENC_KEY: SECRET });

    const res = await post(
      app,
      '/api/v1/owners/notify',
      { domain: 'example.com', notify: false },
      '203.0.113.89',
      env,
      manageToken,
    );
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { domain: 'example.com', notify: false });

    const row = raw.prepare('SELECT notify FROM owner_emails WHERE domain = ?').get('example.com') as { notify: number };
    assert.equal(row.notify, 0);

    // the same token still works after the toggle
    const status = await get(app, '/api/v1/owners/email?domain=example.com', '203.0.113.89', env, manageToken);
    assert.equal(status.status, 200);
    assert.equal((await status.json()).notify, false);
  });

  it('rejects a non-boolean flag', async () => {
    const site = fakeSite({ challenge: null });
    const { app } = freshApp(site.impl);
    const { manageToken } = await onboardOwner(app, site.state, 'example.com', 'owner@example.com', '203.0.113.90');

    const res = await post(
      app,
      '/api/v1/owners/notify',
      { domain: 'example.com', notify: 'yes' },
      '203.0.113.90',
      envWith({ EMAIL_ENC_KEY: SECRET }),
      manageToken,
    );
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error, 'invalid_notify');
  });
});

// ---------------------------------------------------------------------------
// Score-change outbox
// ---------------------------------------------------------------------------

interface OutboxRow {
  id: number;
  domain: string;
  event_key: string;
  grade: string | null;
  score_total: number | null;
  prev_grade: string | null;
  prev_score: number | null;
  status: string;
  attempts: number;
  last_error: string | null;
  sent_at: string | null;
}

/** Insert a confirmed owner mailbox directly (the outbox tests do not need
 * the delivery flow). */
async function seedOwner(raw: DatabaseSync, domain: string, notify = 1): Promise<void> {
  const { cipher, hash } = await encryptEmail(`owner@${domain}`, SECRET);
  raw
    .prepare(
      `INSERT INTO owner_emails
         (domain, email_cipher, email_hash, verified_at, verify_token_hash, verify_expires_at, manage_token_hash, notify, created_at, updated_at)
       VALUES (?, ?, ?, '2026-11-10T00:00:00.000Z', NULL, NULL, NULL, ?, '2026-11-10', '2026-11-10')`,
    )
    .run(domain, cipher, hash, notify);
}

describe('enqueueScoreChangeNotifications', () => {
  it('enqueues one event per rating change and stays idempotent', async () => {
    const { db, raw } = openSeededDb();
    await seedOwner(raw, 'example.com');

    // The seed holds example.com as A (92) while its previous scan was B (88).
    const first = await enqueueScoreChangeNotifications(db, {});
    assert.equal(first, 1);

    const rows = raw.prepare('SELECT * FROM notify_outbox').all() as unknown as OutboxRow[];
    assert.equal(rows.length, 1);
    assert.equal(rows[0].domain, 'example.com');
    assert.equal(rows[0].grade, 'A');
    assert.equal(rows[0].score_total, 92);
    assert.equal(rows[0].prev_grade, 'B');
    assert.equal(rows[0].prev_score, 88);
    assert.equal(rows[0].status, 'pending');
    assert.equal(rows[0].attempts, 0);
    assert.ok(rows[0].event_key.startsWith('example.com|'));

    // A second run must not add a second event for the same state.
    const second = await enqueueScoreChangeNotifications(db, {});
    assert.equal(second, 0);
    const count = raw.prepare('SELECT COUNT(*) AS n FROM notify_outbox').get() as { n: number };
    assert.equal(count.n, 1);
  });

  it('enqueues again when the rating moves on', async () => {
    const { db, raw } = openSeededDb();
    await seedOwner(raw, 'example.com');
    await enqueueScoreChangeNotifications(db, {});

    raw
      .prepare("UPDATE sites SET grade = 'B', score_total = 80, scanned_at = '2026-11-11T10:00:00.000Z' WHERE domain = 'example.com'")
      .run();

    const inserted = await enqueueScoreChangeNotifications(db, {});
    assert.equal(inserted, 1);
    const rows = raw.prepare('SELECT * FROM notify_outbox ORDER BY id').all() as unknown as OutboxRow[];
    assert.equal(rows.length, 2);
    assert.equal(rows[1].grade, 'B');
    assert.equal(rows[1].score_total, 80);
    assert.equal(rows[1].prev_grade, 'A');
    assert.equal(rows[1].prev_score, 92);
  });

  it('ignores unconfirmed mailboxes and owners who opted out', async () => {
    const { db, raw } = openSeededDb();
    await seedOwner(raw, 'example.com', 0); // notify = 0
    raw
      .prepare(
        `INSERT INTO owner_emails
           (domain, email_cipher, email_hash, verified_at, verify_token_hash, verify_expires_at, manage_token_hash, notify, created_at, updated_at)
         VALUES ('coolsite.io', 'cipher', 'hash', NULL, NULL, NULL, NULL, 1, '2026-11-10', '2026-11-10')`,
      )
      .run();

    const inserted = await enqueueScoreChangeNotifications(db, {});
    assert.equal(inserted, 0);
    const count = raw.prepare('SELECT COUNT(*) AS n FROM notify_outbox').get() as { n: number };
    assert.equal(count.n, 0);
  });

  it('ignores a mailbox whose domain is not a verified site', async () => {
    const { db, raw } = openSeededDb();
    await seedOwner(raw, 'example.com');
    // example.com has a score change, but AFR never confirmed the domain
    raw.prepare('UPDATE sites SET verified = 0 WHERE domain = ?').run('example.com');
    assert.equal(await enqueueScoreChangeNotifications(db, {}), 0);

    // an owners row is a verification signal on its own
    raw
      .prepare('INSERT INTO owners (domain, verify_method, verified_at) VALUES (?, ?, ?)')
      .run('example.com', 'dns-txt', '2026-11-10T00:00:00.000Z');
    assert.equal(await enqueueScoreChangeNotifications(db, {}), 1);
  });

  it('stays silent when there is no data at all', async () => {
    const { db, raw } = openSeededDb();
    raw.prepare('DELETE FROM owner_emails').run();
    assert.equal(await enqueueScoreChangeNotifications(db, {}), 0);
  });
});

describe('drainNotifyOutbox', () => {
  it('sends a pending event once and marks it sent', async () => {
    const { db, raw } = openSeededDb();
    await seedOwner(raw, 'example.com');
    await enqueueScoreChangeNotifications(db, {});

    const { calls, impl } = fakeResend();
    const result = await drainNotifyOutbox(
      db,
      { secretB64: SECRET, resendApiKey: API_KEY, from: 'AFR <notifications@afr.im>', baseUrl: 'https://afr.im' },
      impl,
    );
    assert.deepEqual(result, { sent: 1, failed: 0, skipped: 0 });

    const row = raw.prepare('SELECT * FROM notify_outbox WHERE id = 1').get() as unknown as OutboxRow;
    assert.equal(row.status, 'sent');
    assert.ok(row.sent_at);

    // the mail went to the decrypted address, keyed by the event key
    assert.equal(calls.length, 1);
    const init = calls[0].init as RequestInit;
    const body = JSON.parse(String(init.body)) as { to: string; subject: string; text: string };
    assert.equal(body.to, 'owner@example.com');
    assert.match(body.subject, /AFR rating changed: example\.com is now A \(92\)/);
    assert.match(body.text, /Previous rating: B \(88\)/);
    const headers = init.headers as Record<string, string>;
    assert.equal(headers['idempotency-key'], row.event_key);

    // a delivered event is never sent twice
    const second = await drainNotifyOutbox(db, { secretB64: SECRET, resendApiKey: API_KEY }, impl);
    assert.deepEqual(second, { sent: 0, failed: 0, skipped: 0 });
    assert.equal(calls.length, 1, 'no second mail for the same event');
  });

  it('skips an event whose owner opted out in the meantime', async () => {
    const { db, raw } = openSeededDb();
    await seedOwner(raw, 'example.com');
    await enqueueScoreChangeNotifications(db, {});
    raw.prepare('UPDATE owner_emails SET notify = 0 WHERE domain = ?').run('example.com');

    const { calls, impl } = fakeResend();
    const result = await drainNotifyOutbox(db, { secretB64: SECRET, resendApiKey: API_KEY }, impl);
    assert.deepEqual(result, { sent: 0, failed: 0, skipped: 1 });
    assert.equal(calls.length, 0, 'an opted-out owner gets no mail');
  });

  it('keeps the event pending after a failed delivery', async () => {
    const { db, raw } = openSeededDb();
    await seedOwner(raw, 'example.com');
    await enqueueScoreChangeNotifications(db, {});

    const { impl } = fakeResend({ status: 500, body: { message: 'provider is down' } });
    const result = await drainNotifyOutbox(db, { secretB64: SECRET, resendApiKey: API_KEY }, impl);
    assert.deepEqual(result, { sent: 0, failed: 1, skipped: 0 });

    const row = raw.prepare('SELECT * FROM notify_outbox WHERE id = 1').get() as unknown as OutboxRow;
    assert.equal(row.status, 'pending');
    assert.equal(row.attempts, 1);
    assert.ok(row.last_error && row.last_error.length > 0);
  });

  it('gives up after the attempt cap', async () => {
    const { db, raw } = openSeededDb();
    await seedOwner(raw, 'example.com');
    await enqueueScoreChangeNotifications(db, {});
    raw.prepare('UPDATE notify_outbox SET attempts = 4 WHERE id = 1').run();

    const { impl } = fakeResend({ status: 500, body: { message: 'provider is down' } });
    await drainNotifyOutbox(db, { secretB64: SECRET, resendApiKey: API_KEY }, impl);

    const row = raw.prepare('SELECT * FROM notify_outbox WHERE id = 1').get() as unknown as OutboxRow;
    assert.equal(row.attempts, 5);
    assert.equal(row.status, 'failed');
  });

  it('is a no-op without a mail provider', async () => {
    const { db, raw } = openSeededDb();
    await seedOwner(raw, 'example.com');
    await enqueueScoreChangeNotifications(db, {});

    const { calls, impl } = fakeResend();
    const result = await drainNotifyOutbox(db, { secretB64: SECRET }, impl);
    assert.deepEqual(result, { sent: 0, failed: 0, skipped: 0 });
    assert.equal(calls.length, 0);

    const row = raw.prepare('SELECT status FROM notify_outbox WHERE id = 1').get() as { status: string };
    assert.equal(row.status, 'pending', 'the event waits for a provider');
  });
});
