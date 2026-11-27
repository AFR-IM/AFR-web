// test/turnstile.test.ts — Cloudflare Turnstile server-side verification.
//
// The siteverify call is the only outbound traffic of the gate, so it is
// replaced by a fake fetch here: no network, no secrets, fully deterministic.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  parseTurnstileResponse,
  TURNSTILE_ACTIONS,
  TURNSTILE_FAIL_OPEN,
  TURNSTILE_VERIFY_URL,
  verifyTurnstile,
} from '../src/turnstile.ts';
import { API_KEY_HEADER, hashApiKey } from '../src/api-key.ts';
import { createApp } from '../src/index.ts';
import { openSeededDb } from './helpers.ts';

/** A fetch double that records the call and answers with a canned body. */
function fakeFetch(
  handler: (url: string, init: RequestInit) => Response | Promise<Response>,
): { fetchImpl: typeof fetch; calls: { url: string; body: string }[] } {
  const calls: { url: string; body: string }[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    calls.push({ url, body: String(init?.body ?? '') });
    return handler(url, init ?? {});
  }) as typeof fetch;
  return { fetchImpl, calls };
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

describe('parseTurnstileResponse', () => {
  it('passes the siteverify fields through', () => {
    const parsed = parseTurnstileResponse(
      JSON.stringify({
        success: true,
        hostname: 'afr.im',
        action: 'afr_submit',
        cdata: 'abc',
        challenge_ts: '2026-11-20T10:00:00.000Z',
      }),
    );
    assert.ok(parsed);
    assert.equal(parsed.success, true);
    assert.equal(parsed.hostname, 'afr.im');
    assert.equal(parsed.action, 'afr_submit');
    assert.equal(parsed.cdata, 'abc');
    assert.equal(parsed.challenge_ts, '2026-11-20T10:00:00.000Z');
  });

  it('returns null for a body that is not JSON', () => {
    assert.equal(parseTurnstileResponse('<html>502</html>'), null);
    assert.equal(parseTurnstileResponse(''), null);
    assert.equal(parseTurnstileResponse('[1,2,3]'), null);
  });

  it('keeps error-codes as a string array', () => {
    const parsed = parseTurnstileResponse(
      JSON.stringify({ success: false, 'error-codes': ['invalid-input-response', 42] }),
    );
    assert.ok(parsed);
    assert.equal(parsed.success, false);
    assert.deepEqual(parsed['error-codes'], ['invalid-input-response']);
  });
});

describe('verifyTurnstile', () => {
  it('fails open when no secret is configured', async () => {
    const { fetchImpl, calls } = fakeFetch(() => jsonResponse({ success: true }));
    const result = await verifyTurnstile({ token: 'token', secret: '', fetchImpl });
    assert.deepEqual(result, { ok: true, reason: 'not_configured' });
    assert.equal(TURNSTILE_FAIL_OPEN, true);
    assert.equal(calls.length, 0); // no secret → no outbound call at all
  });

  it('rejects a missing token without calling siteverify', async () => {
    const { fetchImpl, calls } = fakeFetch(() => jsonResponse({ success: true }));
    const result = await verifyTurnstile({ token: '', secret: 's', fetchImpl });
    assert.deepEqual(result, { ok: false, reason: 'missing_token' });
    assert.equal(calls.length, 0);
  });

  it('accepts a valid token', async () => {
    const { fetchImpl } = fakeFetch(() => jsonResponse({ success: true, action: 'afr_submit' }));
    const result = await verifyTurnstile({
      token: 'good-token',
      secret: 's',
      expectedAction: 'afr_submit',
      fetchImpl,
    });
    assert.deepEqual(result, { ok: true });
  });

  it('rejects a token Cloudflare refused', async () => {
    const { fetchImpl } = fakeFetch(() =>
      jsonResponse({ success: false, 'error-codes': ['invalid-input-response'] }),
    );
    const result = await verifyTurnstile({ token: 'bad-token', secret: 's', fetchImpl });
    assert.deepEqual(result, { ok: false, reason: 'invalid_token' });
  });

  it('rejects a token minted for another action', async () => {
    const { fetchImpl } = fakeFetch(() => jsonResponse({ success: true, action: 'afr_search_scan' }));
    const result = await verifyTurnstile({
      token: 'token',
      secret: 's',
      expectedAction: 'afr_submit',
      fetchImpl,
    });
    assert.deepEqual(result, { ok: false, reason: 'wrong_action' });
  });

  it('reports a network failure as verify_failed', async () => {
    const { fetchImpl } = fakeFetch(() => {
      throw new Error('network down');
    });
    const result = await verifyTurnstile({ token: 'token', secret: 's', fetchImpl });
    assert.deepEqual(result, { ok: false, reason: 'verify_failed' });
  });

  it('reports a non-JSON answer as verify_failed', async () => {
    const { fetchImpl } = fakeFetch(() => new Response('not json', { status: 502 }));
    const result = await verifyTurnstile({ token: 'token', secret: 's', fetchImpl });
    assert.deepEqual(result, { ok: false, reason: 'verify_failed' });
  });

  it('posts secret, response, remoteip and action to the siteverify endpoint', async () => {
    const { fetchImpl, calls } = fakeFetch(() => jsonResponse({ success: true, action: 'afr_submit' }));
    await verifyTurnstile({
      token: 'the-token',
      secret: 'the-secret',
      remoteIp: '203.0.113.7',
      expectedAction: TURNSTILE_ACTIONS.submit,
      fetchImpl,
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.url, TURNSTILE_VERIFY_URL);
    const body = new URLSearchParams(calls[0]!.body);
    assert.equal(body.get('secret'), 'the-secret');
    assert.equal(body.get('response'), 'the-token');
    assert.equal(body.get('remoteip'), '203.0.113.7');
    assert.equal(body.get('action'), 'afr_submit');
  });

  it('omits remoteip and action when they are not known', async () => {
    const { fetchImpl, calls } = fakeFetch(() => jsonResponse({ success: true }));
    await verifyTurnstile({ token: 'the-token', secret: 'the-secret', fetchImpl });
    const body = new URLSearchParams(calls[0]!.body);
    assert.equal(body.get('secret'), 'the-secret');
    assert.equal(body.get('response'), 'the-token');
    assert.equal(body.has('remoteip'), false);
    assert.equal(body.has('action'), false);
  });
});

describe('protected POST endpoints', () => {
  /** A worker deployment with the Turnstile secret injected. */
  function gatedApp() {
    return createApp({
      db: openSeededDb().db,
      // The siteverify answer for a request without a token is never needed —
      // the token check happens first — so no fake fetch is required here.
      turnstileFetch: (async () => jsonResponse({ success: true })) as typeof fetch,
    });
  }

  it('POST /api/v1/submissions rejects a request without a token', async () => {
    const res = await gatedApp().request(
      '/api/v1/submissions',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ domain: 'brandnew.test' }),
      },
      { TURNSTILE_SECRET: 'test-secret' },
    );
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.error, 'turnstile_failed');
    assert.equal(body.reason, 'missing_token');
  });

  it('POST /api/v1/search-scan rejects a request without a token', async () => {
    const res = await gatedApp().request(
      '/api/v1/search-scan',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ domain: 'brandnew.test' }),
      },
      { TURNSTILE_SECRET: 'test-secret' },
    );
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.error, 'turnstile_failed');
    assert.equal(body.reason, 'missing_token');
  });

  it('lets a request through when the deployment has no secret (fail-open)', async () => {
    const app = createApp({ db: openSeededDb().db });
    const res = await app.request('/api/v1/submissions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ domain: 'brandnew.test' }),
    });
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.equal(body.status, 'queued');
  });

  // ── owner mailbox — the two write endpoints of the self-service panel ──

  it('POST /api/v1/owners/email/start rejects a request without a token', async () => {
    const res = await gatedApp().request(
      '/api/v1/owners/email/start',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ domain: 'example.com', email: 'owner@example.com' }),
      },
      { TURNSTILE_SECRET: 'test-secret' },
    );
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.error, 'turnstile_failed');
    assert.equal(body.reason, 'missing_token');
  });

  it('POST /api/v1/owners/email rejects a request without a token', async () => {
    const res = await gatedApp().request(
      '/api/v1/owners/email',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          domain: 'example.com',
          email: 'owner@example.com',
          challenge: 'ch-0123456789abcdef0123456789abcdef',
        }),
      },
      { TURNSTILE_SECRET: 'test-secret' },
    );
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.error, 'turnstile_failed');
    assert.equal(body.reason, 'missing_token');
  });

  it('POST /api/v1/owners/email/change rejects a request without a token', async () => {
    const res = await gatedApp().request(
      '/api/v1/owners/email/change',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ domain: 'example.com', email: 'new@example.com' }),
      },
      { TURNSTILE_SECRET: 'test-secret' },
    );
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.error, 'turnstile_failed');
    assert.equal(body.reason, 'missing_token');
  });

  it('lets a machine client through the owner-mail endpoints with an API key', async () => {
    const seeded = openSeededDb();
    const key = 'owner-mail-agent-key';
    seeded.raw
      .prepare(
        'INSERT INTO api_keys (key_hash, domain_contact, tier, created_at, revoked_at) VALUES (?, ?, ?, ?, NULL)',
      )
      .run(await hashApiKey(key), null, 'free', new Date().toISOString());

    const app = createApp({
      db: seeded.db,
      turnstileFetch: (async () => jsonResponse({ success: true })) as typeof fetch,
    });
    const env = { TURNSTILE_SECRET: 'test-secret', EMAIL_ENC_KEY: btoa('a'.repeat(32)) };

    const started = await app.request(
      '/api/v1/owners/email/start',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', [API_KEY_HEADER]: key },
        body: JSON.stringify({ domain: 'example.com', email: 'owner@example.com' }),
      },
      env,
    );
    assert.equal(started.status, 200, 'an API key replaces the human check');
    const startedBody = await started.json();
    assert.match(startedBody.challenge, /^ch-[0-9a-f]{32}$/);

    // The gate let the request through — it now fails on the challenge
    // itself, which is the next check of that endpoint.
    const registered = await app.request(
      '/api/v1/owners/email',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', [API_KEY_HEADER]: key },
        body: JSON.stringify({
          domain: 'example.com',
          email: 'owner@example.com',
          challenge: 'ch-ffffffffffffffffffffffffffffffff',
        }),
      },
      env,
    );
    assert.equal(registered.status, 403);
    assert.equal((await registered.json()).error, 'challenge_not_found');
  });

  it('lets a machine client through the mailbox change with an API key', async () => {
    const seeded = openSeededDb();
    const key = 'owner-mail-agent-key';
    seeded.raw
      .prepare(
        'INSERT INTO api_keys (key_hash, domain_contact, tier, created_at, revoked_at) VALUES (?, ?, ?, ?, NULL)',
      )
      .run(await hashApiKey(key), null, 'free', new Date().toISOString());

    const app = createApp({
      db: seeded.db,
      turnstileFetch: (async () => jsonResponse({ success: true })) as typeof fetch,
    });
    const env = { TURNSTILE_SECRET: 'test-secret', EMAIL_ENC_KEY: btoa('a'.repeat(32)) };

    // The gate let the request through — it now fails on the management
    // token, which is the next check of that endpoint.
    const res = await app.request(
      '/api/v1/owners/email/change',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', [API_KEY_HEADER]: key },
        body: JSON.stringify({ domain: 'example.com', email: 'new@example.com' }),
      },
      env,
    );
    assert.equal(res.status, 401, 'an API key replaces the human check');
    assert.equal((await res.json()).error, 'unauthorized');
  });
});

describe('API key scope', () => {
  // The exemption follows the key's site (audit item: a leaked owner key must
  // not bypass the human gate everywhere). A key bound to a site only exempts
  // requests about that site; a key issued without a site exempts everything.
  const env = { TURNSTILE_SECRET: 'test-secret' };

  async function keyApp(t: TestContext, domain: string | null) {
    const seeded = openSeededDb();
    t.after(() => seeded.raw.close());
    const key = `scope-key-${domain ?? 'siteless'}`;
    if (domain) {
      seeded.raw
        .prepare('INSERT INTO api_keys (key_hash, domain, tier, created_at, revoked_at) VALUES (?, ?, ?, ?, NULL)')
        .run(await hashApiKey(key), domain, 'free', new Date().toISOString());
    } else {
      seeded.raw
        .prepare('INSERT INTO api_keys (key_hash, tier, created_at, revoked_at) VALUES (?, ?, ?, NULL)')
        .run(await hashApiKey(key), 'free', new Date().toISOString());
    }
    const siteverify = { calls: 0 };
    const app = createApp({
      db: seeded.db,
      turnstileFetch: (async () => {
        siteverify.calls += 1;
        return jsonResponse({ success: false, 'error-codes': ['bad-token'] });
      }) as typeof fetch,
    });
    const submit = (target: string) =>
      app.request('/api/v1/submissions', {
        method: 'POST',
        headers: { 'content-type': 'application/json', [API_KEY_HEADER]: key },
        body: JSON.stringify({ domain: target }),
      }, env);
    return { submit, siteverify };
  }

  it('a key bound to a site exempts that site', async (t) => {
    const { submit, siteverify } = await keyApp(t, 'example.com');
    // example.com is listed: passing the gate answers "exists", not 400.
    const res = await submit('example.com');
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, status: 'exists', domain: 'example.com' });
    assert.equal(siteverify.calls, 0, 'an exempt request never reaches siteverify');
  });

  it('a key bound to a site does not exempt other sites', async (t) => {
    const { submit, siteverify } = await keyApp(t, 'example.com');
    const res = await submit('other.example');
    assert.equal(res.status, 400);
    const body = await res.json() as { error: string; reason: string };
    assert.equal(body.error, 'turnstile_failed');
    assert.equal(body.reason, 'missing_token');
    assert.equal(siteverify.calls, 0, 'a missing token is refused before siteverify');
  });

  it('a key issued without a site exempts every site', async (t) => {
    const { submit, siteverify } = await keyApp(t, null);
    const res = await submit('brandnew.test');
    assert.equal(res.status, 201, 'a siteless key is a general agent key');
    assert.equal((await res.json()).status, 'queued');
    assert.equal(siteverify.calls, 0);
  });
});
