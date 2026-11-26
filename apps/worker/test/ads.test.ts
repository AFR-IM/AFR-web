// test/ads.test.ts — the public ad surface (GET /api/v1/ads and its siblings).
//
// A placement is only ever served when it was paid through the local ledger,
// approved by an operator and is inside its term. The fixture rows of the seed
// (an 'active' row with no ledger) must therefore never be served: that is the
// rule this suite pins down, together with the click/report surfaces.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createApp } from '../src/index.ts';
import { openSeededDb } from './helpers.ts';

function app() {
  return createApp({ db: openSeededDb().db });
}

describe('GET /api/v1/ads', () => {
  it('serves nothing that has no confirmed payment and no approval', async () => {
    // The seed carries an 'active' ad row (example.com) that was never bought:
    // the old static implementation would have served it.
    const res = await app().request('/api/v1/ads?slot=category-top&key=dev-tools');
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { items: [] });
  });

  it('serves nothing at all without a slot, and never lists the search slot blind', async () => {
    for (const path of ['/api/v1/ads', '/api/v1/ads?slot=search-top', '/api/v1/ads?slot=home-supporter']) {
      assert.deepEqual(await (await app().request(path)).json(), { items: [] }, path);
    }
  });

  it('keeps the answer out of every cache', async () => {
    const res = await app().request('/api/v1/ads?slot=category-top&key=dev-tools');
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.equal(res.headers.get('cloudflare-cdn-cache-control'), 'no-store');
  });
});

describe('the sponsorship surfaces', () => {
  it('closes self-serve sales unless the operator opened them', async () => {
    const res = await app().request('/api/v1/ads/apply', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ domain: 'example.com' }),
    });
    assert.equal(res.status, 403);
    assert.deepEqual(await res.json(), { error: 'ads_sales_closed' });
  });

  it('publishes no price list while sales are closed', async () => {
    const body = await (await app().request('/api/v1/ads/offers')).json();
    assert.deepEqual(body, { salesOpen: false, items: [] });
  });

  it('redirects a click only for a placement it can verify, and never to a caller URL', async () => {
    const unknown = await app().request('/api/v1/ads/go?id=1');
    assert.equal(unknown.status, 404);
    const injected = await app().request('/api/v1/ads/go?id=1&url=https://evil.example');
    assert.equal(injected.status, 404);
    const traversal = await app().request('/api/v1/ads/go?id=1/../../');
    assert.equal(traversal.status, 404);
  });

  it('answers an impression report without charging the visitor', async () => {
    const res = await app().request('/api/v1/ads/event', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 1 }),
    });
    // Nothing is counted for an unapproved placement, and the call stays cheap.
    assert.equal(res.status, 204);
    const bad = await app().request('/api/v1/ads/event', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'https://evil.example' }),
    });
    assert.equal(bad.status, 400);
  });

  it('renders a readable report form and refuses an unknown placement', async () => {
    const form = await app().request('/api/v1/ads/report?id=1&lang=zh-CN');
    assert.equal(form.status, 200);
    assert.match(String(form.headers.get('content-type')), /text\/html/);
    const html = await form.text();
    assert.match(html, /<form method="post" action="\/api\/v1\/ads\/report">/);
    assert.match(html, /举报广告位/);
    assert.equal(form.headers.get('x-robots-tag'), 'noindex, nofollow');

    const unknown = await app().request('/api/v1/ads/report?id=999999');
    assert.equal(unknown.status, 404);

    const missing = await app().request('/api/v1/ads/report');
    assert.equal(missing.status, 404);
  });

  it('accepts a JSON report from a script and answers in JSON', async () => {
    const res = await app().request('/api/v1/ads/report', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ id: 1, reason: 'spam', detail: 'x' }),
    });
    assert.equal(res.status, 201);
    assert.deepEqual(await res.json(), { ok: true });

    const unknown = await app().request('/api/v1/ads/report', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ id: 999999, reason: 'spam' }),
    });
    assert.equal(unknown.status, 404);
    assert.deepEqual(await unknown.json(), { error: 'not_found' });

    const badReason = await app().request('/api/v1/ads/report', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ id: 1, reason: 'because' }),
    });
    assert.equal(badReason.status, 400);
  });

  it('keeps the report endpoint small', async () => {
    const res = await app().request('/api/v1/ads/report', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ id: 1, reason: 'spam', detail: 'x'.repeat(5000) }),
    });
    assert.equal(res.status, 413);
  });
});
