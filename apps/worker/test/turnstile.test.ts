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
});
