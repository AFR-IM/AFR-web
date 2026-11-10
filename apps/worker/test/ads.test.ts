// test/ads.test.ts — GET /api/v1/ads active-ad serving (spec v1.2 §6.1/§6.2).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createApp } from '../src/index.ts';
import { openSeededDb } from './helpers.ts';

function app() {
  return createApp({ db: openSeededDb().db });
}

describe('GET /api/v1/ads', () => {
  it('serves only active, in-window ads for a slot + key', async () => {
    const res = await app().request('/api/v1/ads?slot=category-top&key=dev-tools');
    assert.equal(res.status, 200);
    const body = await res.json();
    // active slot-keyed ad + active generic ad (slot_key NULL matches any key);
    // pending and expired rows must never be served
    assert.deepEqual(
      body.items.map((i: { domain: string }) => i.domain),
      ['example.com', 'coolsite.io'],
    );
    assert.equal(body.items[0].headline, 'Ship faster');
  });

  it('never returns pending or expired ads', async () => {
    const body = await (await app().request('/api/v1/ads')).json();
    const domains = body.items.map((i: { domain: string }) => i.domain);
    assert.ok(domains.includes('example.com'));
    assert.ok(!domains.includes('closed.org'), 'pending ad leaked');
    assert.ok(!domains.includes('neutral.net'), 'expired ad leaked');
    for (const item of body.items) assert.equal(item.status, 'active');
  });

  it('returns an empty list for an unsold slot', async () => {
    const body = await (await app().request('/api/v1/ads?slot=report-sponsor')).json();
    assert.deepEqual(body.items, []);
  });
});
