import assert from 'node:assert/strict';
import { test } from 'node:test';
import { syncRelease } from './sync-release-d1.mjs';

const dataSha = 'a'.repeat(40);
const date = '2026/11/24';
const options = { dates: [date], dataSha, pause: async () => {}, log: () => {} };

test('retries a partially failed page at the same pinned cursor', async () => {
  const requests = [];
  await syncRelease({ ...options, async requestPage(request) {
    requests.push(request);
    if (requests.length === 1) {
      return { ...request, ok: false, errors: 1, nextOffset: 32, failedPaths: ['scans/failed.json'] };
    }
    return { ...request, ok: true, errors: 0, nextOffset: request.offset === 0 ? 32 : null };
  } });
  assert.deepEqual(requests, [0, 0, 32].map((offset) => ({ date, dataSha, offset })));
});

test('fails after three retries and reports the pinned page and failed paths', async () => {
  const requests = [];
  await assert.rejects(syncRelease({ ...options, async requestPage(request) {
    requests.push(request);
    return { ...request, ok: false, errors: 1, nextOffset: 32, failedPaths: ['scans/failed.json'] };
  } }), /2026\/11\/24@0, attempt 3\/3: .*scans\/failed.json/);
  assert.deepEqual(requests.map(({ offset }) => offset), [0, 0, 0]);
});

test('rejects responses from an unpinned worker and non-advancing cursors', async () => {
  await assert.rejects(syncRelease({ ...options, async requestPage() {
    return { date, ok: true, errors: 0, nextOffset: null };
  } }), /does not match requested commit/);
  await assert.rejects(syncRelease({ ...options, async requestPage(request) {
    return { ...request, ok: true, errors: 0, nextOffset: 0 };
  } }), /cursor did not advance/);
});
