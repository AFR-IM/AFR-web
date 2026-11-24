import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';

const page = readFileSync(new URL('../apps/web/src/pages/[...locale]/search.astro', import.meta.url), 'utf8');
const script = [...page.matchAll(/<script is:inline>([\s\S]*?)<\/script>/g)]
  .map(([, code]) => code).find((code) => code.includes('function startScan()'));
assert.ok(script);
const end = script.indexOf('      if (scanBox) {');
assert.ok(end > 0);

async function simulate(responses) {
  const calls = [];
  const timers = new Map();
  let nextTimer = 0;
  const attrs = {
    'data-tpl-queued': 'Queued: {eta}', 'data-tpl-polling': 'Polling: {eta}',
    'data-tpl-rate': 'Retry: {eta}', 'data-report-base': '/site/', 'data-msg-net': 'Network error',
  };
  const element = () => ({ hidden: true, classList: { toggle() {} } });
  const els = { btn: element(), btnTxt: element(), status: element(), result: element(), rLink: element() };
  runInNewContext(`${script.slice(0, end)}
    els = fixture;
    resetScan('example.com');
    startScan();
  })();`, {
    document: {
      getElementById: () => null,
      querySelector: (name) => ['[data-grid]', '[data-card-tpl]', '[data-scan]'].includes(name)
        ? { getAttribute: (key) => attrs[key] } : null,
    },
    window: {}, fixture: els,
    setInterval(fn) { timers.set(++nextTimer, fn); return nextTimer; },
    clearInterval(id) { timers.delete(id); },
    async fetch(url) {
      calls.push(url);
      assert.ok(responses.length, `Unexpected request: ${url}`);
      const [status, body, retryAfter] = responses.shift();
      return new Response(JSON.stringify(body), { status, headers: retryAfter ? { 'Retry-After': retryAfter } : {} });
    },
  });
  const flush = () => new Promise((resolve) => setImmediate(resolve));
  await flush();
  return { els, calls, async tick(n) {
    for (let i = 0; i < n; i++) {
      for (const fn of [...timers.values()]) fn();
      await flush();
    }
  } };
}

test('bare domain and pasted URLs resolve to the same indexed site', () => {
  const matchStart = script.indexOf('      function computeMatches(q)');
  const matchEnd = script.indexOf('      /* clone the inert template', matchStart);
  assert.ok(matchStart > end && matchEnd > matchStart);
  const matches = runInNewContext(`${script.slice(0, end)}
    ${script.slice(matchStart, matchEnd)}
    INDEX.entries = [{ d: 'example.com', t: 'Example' }, { d: 'other.example', t: 'Example.com article' }];
    return ['example.com', 'https://www.example.com/', 'https://example.com/path?q=1']
      .map(function (query) { computeMatches(query); return matches.map(function (entry) { return entry.d; }).join(','); }).join('|');
  })();`, { document: {
    getElementById: () => null,
    querySelector: (name) => ['[data-grid]', '[data-card-tpl]'].includes(name) ? { getAttribute: () => null } : null,
  } });
  assert.equal(matches, 'example.com|example.com|example.com');
});

const report = [200, { site: { domain: 'example.com', grade: 'B' } }];

test('queued search scan starts polling and opens a published report', async () => {
  const { els, calls, tick } = await simulate([[200, { status: 'queued', etaSeconds: 20 }], [404, {}], report]);
  assert.equal(els.status.textContent, 'Queued: 20 s');
  await tick(10);
  assert.equal(els.status.textContent, 'Polling: 10 s');
  await tick(10);
  assert.deepEqual(calls, ['/api/v1/search-scan', '/api/v1/sites/example.com', '/api/v1/sites/example.com']);
  assert.equal(els.result.hidden, false);
  assert.equal(els.rLink.href, '/site/example.com/');
});

test('existing site skips the countdown and immediately loads the report', async () => {
  const { els, calls } = await simulate([[200, { status: 'exists' }], report]);
  assert.deepEqual(calls, ['/api/v1/search-scan', '/api/v1/sites/example.com']);
  assert.equal(els.result.hidden, false);
});

test('rate limited submission honors Retry-After and unlocks the button', async () => {
  const { els, calls, tick } = await simulate([[429, {}, '6']]);
  assert.equal(els.status.textContent, 'Retry: 6 s');
  assert.equal(els.btn.disabled, true);
  await tick(5);
  assert.equal(els.btn.disabled, true);
  await tick(1);
  assert.equal(els.btn.disabled, false);
  assert.equal(els.status.textContent, '');
  assert.deepEqual(calls, ['/api/v1/search-scan']);
});
