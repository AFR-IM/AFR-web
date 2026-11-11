// test/skeletons.test.ts — not-yet-built endpoints must answer 501 with an
// explicit feature marker (planned surfaces: verification/badges,
// ads domain).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createApp } from '../src/index.ts';
import { openSeededDb } from './helpers.ts';

const VERIFY_ROUTES: [string, string][] = [
  ['POST', '/api/v1/verify/start'],
  ['GET', '/api/v1/verify/check'],
  ['POST', '/api/v1/claims'],
  ['POST', '/api/v1/rescan'],
  ['POST', '/api/v1/badge/report'],
];

const ADS_ROUTES: [string, string][] = [
  ['POST', '/api/v1/ads/apply'],
  ['POST', '/api/v1/ads/report'],
  ['POST', '/api/v1/_ads/webhook'],
];

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
  for (const [method, path] of VERIFY_ROUTES) {
    it(`${method} ${path} → 501 not_implemented (verification)`, async () => {
      const res = await request(method, path);
      assert.equal(res.status, 501);
      assert.deepEqual(await res.json(), { error: 'not_implemented', feature: 'verification' });
    });
  }

  for (const [method, path] of ADS_ROUTES) {
    it(`${method} ${path} → 501 not_implemented (ads)`, async () => {
      const res = await request(method, path);
      assert.equal(res.status, 501);
      assert.deepEqual(await res.json(), { error: 'not_implemented', feature: 'ads' });
    });
  }
});
