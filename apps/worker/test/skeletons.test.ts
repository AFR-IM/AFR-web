// test/skeletons.test.ts — surfaces that are not built yet must say so
// explicitly instead of pretending to work. There are none left on the public
// API: the advertising surface ships with its own contract (below), and the
// former badge-report placeholder was removed rather than left as a 501.
// Kept as a guard: a route that regresses to `not_implemented` fails here.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createApp } from '../src/index.ts';
import { openSeededDb } from './helpers.ts';

function request(method: string, path: string): Promise<Response> {
  const app = createApp({ db: openSeededDb().db });
  const init: RequestInit = { method };
  if (method === 'POST') {
    init.headers = { 'content-type': 'application/json' };
    init.body = JSON.stringify({});
  }
  return app.request(path, init);
}

describe('feature skeletons', () => {
  // The advertising surface is built: it answers with its own contract rather
  // than a 501. Sales are closed until the operator opens them, and the second
  // webhook of the old Stripe design does not exist (payments arrive on the
  // one signed AIPAY webhook).
  it('POST /api/v1/ads/apply answers the sales gate, not 501', async () => {
    const res = await request('POST', '/api/v1/ads/apply');
    assert.equal(res.status, 403);
    assert.deepEqual(await res.json(), { error: 'ads_sales_closed' });
  });

  it('POST /api/v1/ads/report answers the report contract, not 501', async () => {
    const res = await request('POST', '/api/v1/ads/report');
    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), { error: 'invalid_report' });
  });

  it('the old per-purpose webhook is gone', async () => {
    const res = await request('POST', '/api/v1/_ads/webhook');
    assert.equal(res.status, 404);
  });

  it('POST /api/v1/badge/report is gone (never shipped, not a 501 stub)', async () => {
    const res = await request('POST', '/api/v1/badge/report');
    assert.equal(res.status, 404);
  });
});
