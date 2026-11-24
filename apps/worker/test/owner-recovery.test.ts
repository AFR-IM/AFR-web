// test/owner-recovery.test.ts — management-token recovery (owner lost the
// token) and the self-service unregistration of a mailbox.
//
// The recovery must not weaken the three locks of the owner mailbox:
//   1. domain control — the challenge has to be published on the domain and
//      observed by the platform again,
//   2. mailbox control — the reset mail goes to the confirmed address only,
//   3. the management token — the recovery link rotates it: the old token
//      dies with the click.
//
// The route answers with the *same* opaque error code for "this domain has
// no confirmed mailbox" and "this address is not the confirmed mailbox", so
// a stranger learns nothing about the mailbox of a domain.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
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
import { RateLimiter, DAY_MS, HOUR_MS, memoryStore } from '../src/rate-limit.ts';
import { openSeededDb } from './helpers.ts';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** 32-byte secret in base64 — the production shape of EMAIL_ENC_KEY */
const SECRET = btoa('a'.repeat(32));
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

interface SentMail {
  to: string;
  subject: string;
  text: string;
  html: string;
  idempotencyKey: string;
}

interface FakeSite {
  /** the value the domain publishes (null = publishes nothing) */
  challenge: string | null;
  /** every mail that went through the fake provider */
  mails: SentMail[];
}

/** The fake "domain" of the owner: it answers the three challenge probes and
 * the Resend endpoint, and records every mail that went out. */
function fakeSite(state: { challenge: string | null }): { site: FakeSite; impl: typeof fetch } {
  const site: FakeSite = { challenge: state.challenge, mails: [] };
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith('https://api.resend.com/emails')) {
      const body = JSON.parse(String(init?.body)) as {
        to: string;
        subject: string;
        text: string;
        html: string;
      };
      const headers = (init?.headers ?? {}) as Record<string, string>;
      site.mails.push({ ...body, idempotencyKey: headers['idempotency-key'] ?? '' });
      return Response.json({ id: 'email_123' }, { status: 200 });
    }
    if (url.includes('cloudflare-dns.com')) {
      if (!site.challenge) return Response.json({ Status: 0, Answer: [] });
      return Response.json({
        Status: 0,
        Answer: [{ type: 16, data: `afr-mail=${site.challenge}` }],
      });
    }
    if (url.includes('/.well-known/afr-mail.txt')) {
      if (!site.challenge) return new Response('not found', { status: 404 });
      return new Response(site.challenge, { headers: { 'content-type': 'text/plain' } });
    }
    // everything else is the homepage
    if (!site.challenge) return new Response('<html><head></head></html>');
    return new Response(
      `<html><head><meta name="afr-mail-verification" content="${site.challenge}"></head></html>`,
    );
  }) as unknown as typeof fetch;
  return { site, impl };
}

function envWith(overrides: Partial<WorkerEnv> = {}): WorkerEnv {
  return { DB: undefined as unknown as WorkerEnv['DB'], RESEND_API_KEY: API_KEY, ...overrides };
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
  return app.request(path, { method: 'POST', headers, body: JSON.stringify(body) }, env);
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

function del(
  app: ReturnType<typeof createApp>,
  path: string,
  ip = '203.0.113.70',
  env?: WorkerEnv,
  bearer?: string,
): Promise<Response> {
  const headers: Record<string, string> = { 'x-forwarded-for': ip };
  if (bearer) headers.authorization = `Bearer ${bearer}`;
  return app.request(path, { method: 'DELETE', headers }, env);
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
): Promise<{ manageToken: string }> {
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
  const mail = site.mails.at(-1);
  assert.ok(mail, 'the confirmation mail was sent');
  const token = /\/api\/v1\/owners\/email\/verify\?token=([0-9a-f]{32})/.exec(mail.text)?.[1];
  assert.ok(token, 'the confirmation link is delivered in the email');
  const verified = await get(app, `/api/v1/owners/email/verify?token=${token}`, ip);
  assert.equal(verified.status, 200);
  const { manageToken } = (await verified.json()) as { manageToken: string };
  assert.ok(manageToken, 'the confirmation hands out the management token');
  return { manageToken };
}

/** Ask for a recovery and return the recovery token from the mail. */
async function requestRecovery(
  app: ReturnType<typeof createApp>,
  site: FakeSite,
  domain: string,
  email: string,
  ip = '203.0.113.70',
): Promise<string> {
  const challenge = await startChallenge(app, domain, email, ip);
  site.challenge = challenge;
  const res = await post(
    app,
    '/api/v1/owners/email/recover',
    { domain, email, challenge },
    ip,
    envWith({ EMAIL_ENC_KEY: SECRET }),
  );
  assert.equal(res.status, 200, `recovery failed: ${res.status}`);
  const mail = site.mails.at(-1);
  assert.ok(mail, 'the recovery mail was sent');
  const token = /\/api\/v1\/owners\/email\/recover\/verify\?token=([0-9a-f]{32})/.exec(mail.text)?.[1];
  assert.ok(token, 'the recovery link is delivered in the mail');
  return token;
}

interface RecoveryRow {
  id: number;
  domain: string;
  email_hash: string;
  token_hash: string;
  expires_at: string;
  used_at: string | null;
  created_at: string;
}

// ---------------------------------------------------------------------------
// POST /api/v1/owners/email/recover — the recovery request
// ---------------------------------------------------------------------------

describe('POST /api/v1/owners/email/recover', () => {
  it('refuses when the domain does not publish the challenge — and sends nothing', async () => {
    const { site, impl } = fakeSite({ challenge: null });
    const { app, raw } = freshApp(impl);
    const ip = '203.0.113.90';
    await onboardOwner(app, site, 'example.com', 'owner@example.com', ip);

    // a fresh challenge for the recovery — but the domain publishes another
    // value, so the platform never observes it
    const challenge = await startChallenge(app, 'example.com', 'owner@example.com', ip);
    site.challenge = 'ch-11111111111111111111111111111111';

    const res = await post(
      app,
      '/api/v1/owners/email/recover',
      { domain: 'example.com', email: 'owner@example.com', challenge },
      ip,
      envWith({ EMAIL_ENC_KEY: SECRET }),
    );
    assert.equal(res.status, 403);
    const body = await res.json();
    assert.equal(body.error, 'domain_control_failed');
    assert.ok(Array.isArray(body.checks), 'the answer carries a per-method summary');
    assert.ok(!JSON.stringify(body).includes('owner@example.com'), 'no plaintext in the answer');

    const rows = raw.prepare('SELECT * FROM owner_mailbox_recoveries').all() as unknown as RecoveryRow[];
    assert.equal(rows.length, 0, 'nothing was stored');
  });

  it('refuses an address that is not the confirmed mailbox — and sends nothing', async () => {
    const { site, impl } = fakeSite({ challenge: null });
    const { app, raw } = freshApp(impl);
    const ip = '203.0.113.91';
    await onboardOwner(app, site, 'example.com', 'owner@example.com', ip);

    const mailsBefore = site.mails.length;
    const challenge = await startChallenge(app, 'example.com', 'stranger@example.com', ip);
    site.challenge = challenge;

    const res = await post(
      app,
      '/api/v1/owners/email/recover',
      { domain: 'example.com', email: 'stranger@example.com', challenge },
      ip,
      envWith({ EMAIL_ENC_KEY: SECRET }),
    );
    assert.equal(res.status, 403);
    const body = await res.json();
    // The same opaque code as "this domain has no mailbox at all" — the
    // difference must not be observable.
    assert.equal(body.error, 'recovery_not_available');
    assert.ok(!JSON.stringify(body).includes('owner@example.com'), 'no plaintext in the answer');

    assert.equal(site.mails.length, mailsBefore, 'no mail was sent');
    const rows = raw.prepare('SELECT * FROM owner_mailbox_recoveries').all() as unknown as RecoveryRow[];
    assert.equal(rows.length, 0, 'nothing was stored');
  });

  it('answers a domain without a confirmed mailbox with the very same code', async () => {
    const { site, impl } = fakeSite({ challenge: null });
    const { app, raw } = freshApp(impl);
    const ip = '203.0.113.92';

    const challenge = await startChallenge(app, 'coolsite.io', 'owner@coolsite.io', ip);
    site.challenge = challenge;

    const res = await post(
      app,
      '/api/v1/owners/email/recover',
      { domain: 'coolsite.io', email: 'owner@coolsite.io', challenge },
      ip,
      envWith({ EMAIL_ENC_KEY: SECRET }),
    );
    assert.equal(res.status, 403);
    assert.equal((await res.json()).error, 'recovery_not_available');
    assert.equal(site.mails.length, 0, 'no mail was sent');
    const rows = raw.prepare('SELECT * FROM owner_mailbox_recoveries').all() as unknown as RecoveryRow[];
    assert.equal(rows.length, 0, 'nothing was stored');
  });

  it('mails the recovery link to the confirmed address and stores only hashes', async () => {
    const { site, impl } = fakeSite({ challenge: null });
    const { app, raw } = freshApp(impl);
    const ip = '203.0.113.93';
    await onboardOwner(app, site, 'example.com', 'owner@example.com', ip);

    const challenge = await startChallenge(app, 'example.com', 'owner@example.com', ip);
    site.challenge = challenge;

    const res = await post(
      app,
      '/api/v1/owners/email/recover',
      { domain: 'example.com', email: 'owner@example.com', challenge },
      ip,
      envWith({ EMAIL_ENC_KEY: SECRET }),
    );
    assert.equal(res.status, 200);
    const answer = await res.text();
    assert.deepEqual(JSON.parse(answer), { status: 'sent', emailed: true });

    // the answer carries neither the link nor the token
    assert.ok(!answer.includes('token'), 'the answer carries no token');
    assert.ok(!answer.includes('http'), 'the answer carries no link');

    // the mail went to the confirmed address
    const mail = site.mails.at(-1);
    assert.ok(mail, 'the recovery mail was sent');
    assert.equal(mail.to, 'owner@example.com');
    assert.match(mail.subject, /example\.com/);
    assert.match(mail.text, /\/api\/v1\/owners\/email\/recover\/verify\?token=[0-9a-f]{32}/);
    assert.ok(mail.idempotencyKey.startsWith('owner-recovery:example.com:'));

    // the database holds the hash only
    const rows = raw.prepare('SELECT * FROM owner_mailbox_recoveries').all() as unknown as RecoveryRow[];
    assert.equal(rows.length, 1, 'one recovery row');
    const row = rows[0]!;
    assert.equal(row.domain, 'example.com');
    assert.match(row.email_hash, /^[0-9a-f]{64}$/);
    assert.match(row.token_hash, /^[0-9a-f]{64}$/);
    assert.equal(row.used_at, null, 'the recovery is unused');
    assert.ok(Date.parse(row.expires_at) > Date.now(), 'the recovery expires in the future');
    assert.ok(!JSON.stringify(row).includes('owner@example.com'), 'no plaintext address is stored');
    const token = /recover\/verify\?token=([0-9a-f]{32})/.exec(mail.text)?.[1] ?? '';
    assert.ok(token);
    assert.notEqual(row.token_hash, token, 'the token itself is not stored');
  });
});

// ---------------------------------------------------------------------------
// GET /api/v1/owners/email/recover/verify — the recovery link
// ---------------------------------------------------------------------------

describe('GET /api/v1/owners/email/recover/verify', () => {
  it('hands out a new management token and kills the old one', async () => {
    const { site, impl } = fakeSite({ challenge: null });
    const { app, raw } = freshApp(impl);
    const ip = '203.0.113.94';
    const { manageToken: oldToken } = await onboardOwner(
      app,
      site,
      'example.com',
      'owner@example.com',
      ip,
    );
    const token = await requestRecovery(app, site, 'example.com', 'owner@example.com', ip);

    const verified = await get(
      app,
      `/api/v1/owners/email/recover/verify?token=${token}`,
      ip,
      envWith({ EMAIL_ENC_KEY: SECRET }),
    );
    assert.equal(verified.status, 200);
    const body = (await verified.json()) as { verified: boolean; domain: string; manageToken: string };
    assert.equal(body.verified, true);
    assert.equal(body.domain, 'example.com');
    assert.match(body.manageToken, /^manage-[0-9a-f]{32}$/);
    assert.notEqual(body.manageToken, oldToken, 'the token is rotated');

    // the new token works …
    const status = await get(
      app,
      '/api/v1/owners/email?domain=example.com',
      ip,
      envWith({ EMAIL_ENC_KEY: SECRET }),
      body.manageToken,
    );
    assert.equal(status.status, 200);

    // … the old one does not
    const withOld = await get(
      app,
      '/api/v1/owners/email?domain=example.com',
      ip,
      envWith({ EMAIL_ENC_KEY: SECRET }),
      oldToken,
    );
    assert.equal(withOld.status, 401);
    assert.equal((await withOld.json()).error, 'unauthorized');

    // the recovery row is spent
    const row = raw.prepare('SELECT * FROM owner_mailbox_recoveries').get() as RecoveryRow;
    assert.ok(row.used_at, 'the recovery is consumed');
  });

  it('refuses a replayed link', async () => {
    const { site, impl } = fakeSite({ challenge: null });
    const { app } = freshApp(impl);
    const ip = '203.0.113.95';
    await onboardOwner(app, site, 'example.com', 'owner@example.com', ip);
    const token = await requestRecovery(app, site, 'example.com', 'owner@example.com', ip);

    const first = await get(app, `/api/v1/owners/email/recover/verify?token=${token}`, ip);
    assert.equal(first.status, 200);

    const replay = await get(app, `/api/v1/owners/email/recover/verify?token=${token}`, ip);
    assert.equal(replay.status, 400);
    assert.equal((await replay.json()).error, 'invalid_or_expired_token');
  });

  it('refuses an unknown token', async () => {
    const { app } = freshApp();
    const res = await get(app, '/api/v1/owners/email/recover/verify?token=nope', '203.0.113.96');
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error, 'invalid_or_expired_token');
  });
});

// ---------------------------------------------------------------------------
// DELETE /api/v1/owners/email — the owner unregisters the mailbox
// ---------------------------------------------------------------------------

describe('DELETE /api/v1/owners/email', () => {
  it('deletes the mailbox with the management token', async () => {
    const { site, impl } = fakeSite({ challenge: null });
    const { app, raw } = freshApp(impl);
    const ip = '203.0.113.97';
    const { manageToken } = await onboardOwner(
      app,
      site,
      'example.com',
      'owner@example.com',
      ip,
    );

    const res = await del(
      app,
      '/api/v1/owners/email?domain=example.com',
      ip,
      envWith({ EMAIL_ENC_KEY: SECRET }),
      manageToken,
    );
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { deleted: true });

    const row = raw.prepare('SELECT domain FROM owner_emails WHERE domain = ?').get('example.com');
    assert.equal(row, undefined, 'the mailbox row is gone');
  });

  it('refuses without a token (and with a wrong one)', async () => {
    const { site, impl } = fakeSite({ challenge: null });
    const { app, raw } = freshApp(impl);
    const ip = '203.0.113.98';
    const { manageToken } = await onboardOwner(
      app,
      site,
      'example.com',
      'owner@example.com',
      ip,
    );

    const anonymous = await del(app, '/api/v1/owners/email?domain=example.com', ip);
    assert.equal(anonymous.status, 401);
    assert.equal((await anonymous.json()).error, 'unauthorized');

    const wrong = await del(
      app,
      '/api/v1/owners/email?domain=example.com',
      ip,
      undefined,
      'manage-ffffffffffffffffffffffffffffffff',
    );
    assert.equal(wrong.status, 401);

    // the mailbox is still there
    const row = raw.prepare('SELECT domain FROM owner_emails WHERE domain = ?').get('example.com');
    assert.ok(row, 'the mailbox survives a refused delete');
    assert.ok(manageToken);
  });
});
