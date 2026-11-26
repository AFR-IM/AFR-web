// scripts/fetch-claims.test.mjs — the build's read of the published owner
// statements (GET /api/v1/claims/published → /data/claims.json).
//
// The read path of the statement is as important as the write path: a form
// that accepts statements nobody can ever read is a broken promise. The
// failure rule mirrors the category labels — every failure ends as an empty
// map with a warning, because a build must never die on an endpoint.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fetchPublishedClaims, CLAIMS_ENDPOINT } from '../apps/web/scripts/fetch-claims.mjs';

const okResponse = (body) => ({
  ok: true,
  status: 200,
  json: async () => body,
});

test('published statements are fetched from the public API and sanitized', async () => {
  let seenUrl = '';
  const map = await fetchPublishedClaims({
    apiBase: 'https://example.test/',
    fetchImpl: async (url) => {
      seenUrl = String(url);
      return okResponse({
        'acme.test': '  We publish llms.txt.  ',
        'UPPER.test': 'normalized key',
        'not a domain!': 'dropped',
        'long.test': 'x'.repeat(601),
        'num.test': 42,
      });
    },
  });
  assert.equal(seenUrl, `https://example.test${CLAIMS_ENDPOINT}`, 'trailing slash on the base is harmless');
  assert.deepEqual(map, {
    'acme.test': 'We publish llms.txt.',
    'upper.test': 'normalized key',
  });
});

test('a failing endpoint ends as an empty map with a warning — never a throw', async () => {
  const httpError = await fetchPublishedClaims({
    fetchImpl: async () => ({ ok: false, status: 503, json: async () => ({}) }),
  });
  assert.deepEqual(httpError, {});

  const networkError = await fetchPublishedClaims({
    fetchImpl: async () => {
      throw new Error('offline');
    },
  });
  assert.deepEqual(networkError, {});

  const malformed = await fetchPublishedClaims({
    fetchImpl: async () => okResponse(['not', 'an', 'object']),
  });
  assert.deepEqual(malformed, {});
});
