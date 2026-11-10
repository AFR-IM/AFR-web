// test/skeletons.test.ts — not-yet-built endpoints must answer 501 with an
// explicit milestone marker (spec §6.2 + §12 roadmap: M3 = verify/badges,
// M7 = ads domain from v1.2).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createApp } from '../src/index.ts';
import { openSeededDb } from './helpers.ts';

const M3_ROUTES: [string, string][] = [
  ['POST', '/api/v1/verify/start'],
  ['GET', '/api/v1/verify/check'],
  ['POST', '/api/v1/claims'],
  ['POST', '/api/v1/rescan'],
  ['POST', '/api/v1/badge/report'],
];

const M7_ROUTES: [string, string][] = [
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

describe('milestone skeletons', () => {
  for (const [method, path] of M3_ROUTES) {
    it(`${method} ${path} → 501 not_implemented (M3)`, async () => {
      const res = await request(method, path);
      assert.equal(res.status, 501);
      assert.deepEqual(await res.json(), { error: 'not_implemented', milestone: 'M3' });
    });
  }

  for (const [method, path] of M7_ROUTES) {
    it(`${method} ${path} → 501 not_implemented (M7)`, async () => {
      const res = await request(method, path);
      assert.equal(res.status, 501);
      assert.deepEqual(await res.json(), { error: 'not_implemented', milestone: 'M7' });
    });
  }
});
