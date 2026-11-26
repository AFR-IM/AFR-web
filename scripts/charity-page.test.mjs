// scripts/charity-page.test.mjs — the public charity page
// (apps/web/src/pages/[...locale]/charity.astro) and the build-time ledger
// mirror (apps/web/scripts/fetch-charity-ledger.mjs).
//
// The page ships an empty static shell and fills itself in the browser. Two
// guarantees are worth a test:
//   · the empty state (what production looks like today) never throws,
//   · ledger rows link to basescan with a validated tx hash — an unvalidated
//     hash must never become an href.
// Plus the build rule: a dead ledger endpoint must warn, never fail the build.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { CHARITY_LEDGER_ENDPOINT, fetchCharityLedger } from '../apps/web/scripts/fetch-charity-ledger.mjs';

const require = createRequire(import.meta.url);
const originalEmitWarning = process.emitWarning;
process.emitWarning = () => {};
const { stripTypeScriptTypes } = require('node:module');
process.emitWarning = originalEmitWarning;

const read = (path) => readFileSync(new URL(`../apps/web/src/${path}`, import.meta.url), 'utf8');

const source = read('pages/[...locale]/charity.astro');
const script = source.match(/<script>\s*([\s\S]*?)<\/script>/)?.[1];
assert.ok(script, 'the charity page must carry a client script');

const client = [read('data/torch.ts'), script]
  .map((src) =>
    stripTypeScriptTypes(src, { mode: 'strip' })
      .replace(/^\s*import[\s\S]*?from\s*'[^']+';\s*$/gm, '')
      .replace(/^\s*export /gm, ''),
  )
  .join('\n');

function makeEl(props = {}) {
  return {
    hidden: false,
    textContent: '',
    innerHTML: '',
    dataset: { locale: 'en' },
    style: { setProperty() {}, width: '' },
    attrs: {},
    children: {},
    getAttribute(name) {
      return name in this.attrs ? this.attrs[name] : null;
    },
    setAttribute(name, value) {
      this.attrs[name] = String(value);
    },
    querySelector(sel) {
      return this.children[sel] ?? null;
    },
    ...props,
  };
}

const SELECTORS = [
  '[data-charity-pool]',
  '[data-charity-pool-empty]',
  '[data-charity-fill]',
  '[data-charity-pool-num]',
  '[data-charity-countdown]',
  '[data-charity-beneficiaries]',
  '[data-charity-beneficiaries-empty]',
  '[data-charity-addresses]',
  '[data-charity-addresses-empty]',
  '[data-charity-pool-addr]',
  '[data-charity-promo-addr]',
  '[data-charity-fingerprint]',
  '[data-charity-history-wrap]',
  '[data-charity-history]',
  '[data-charity-history-empty]',
  '[data-charity-ledger-note]',
  '[data-charity-ledger-wrap]',
  '[data-charity-ledger]',
  '[data-charity-ledger-empty]',
  '[data-charity-load-error]',
  '[data-charity-bar]',
];

function loadPage({ serveCharity, serveLedger }) {
  const els = new Map(SELECTORS.map((sel) => [sel, makeEl()]));
  // empty states start visible (server-rendered), content blocks and the
  // load-error hint start hidden
  for (const sel of els.keys()) {
    els.get(sel).hidden = !sel.includes('-empty]');
  }
  const root = makeEl({
    dataset: { locale: 'en' },
    children: Object.fromEntries(els),
  });
  const document = {
    querySelector: (sel) => (sel === '[data-charity]' ? root : null),
    querySelectorAll: () => [],
  };
  const calls = [];
  runInNewContext(client, {
    document,
    fetch: (url, options) => {
      const href = String(url);
      calls.push({ url: href, options: options ?? {} });
      if (href.includes('/charity/ledger')) return Promise.resolve(serveLedger());
      if (href.includes('/api/v1/charity')) return Promise.resolve(serveCharity());
      return Promise.resolve({ ok: false, status: 404, json: async () => ({}) });
    },
    URLSearchParams,
    AbortController,
    Date,
    console,
  });
  return { els, root, calls };
}

const ok = (body) => ({ ok: true, status: 200, json: async () => body });

const EMPTY_CHARITY = {
  beneficiaries: [],
  promoWallet: '',
  charityPool: '',
  fingerprint: null,
  publishedAt: null,
  history: [],
  torch: { raised: 0, target: 1000, crossedAt: null, publishedUntil: null },
};

test('the production-shaped empty payload never throws and keeps the empty states visible', async () => {
  const page = loadPage({
    serveCharity: () => ok(EMPTY_CHARITY),
    serveLedger: () => ok({ generatedAt: '', entries: [] }),
  });
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(page.els.get('[data-charity-pool-empty]').hidden, false);
  assert.equal(page.els.get('[data-charity-pool]').hidden, true);
  assert.equal(page.els.get('[data-charity-beneficiaries-empty]').hidden, false);
  assert.equal(page.els.get('[data-charity-ledger-empty]').hidden, false);
  assert.equal(page.els.get('[data-charity-load-error]').hidden, true);
});

test('a dead API only adds the hint line — the page still renders', async () => {
  const page = loadPage({
    serveCharity: () => {
      throw new Error('offline');
    },
    serveLedger: () => {
      throw new Error('offline');
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(page.els.get('[data-charity-load-error]').hidden, false);
});

test('ledger entries render with validated basescan links and anchor ids', async () => {
  const page = loadPage({
    serveCharity: () => ok({
      ...EMPTY_CHARITY,
      charityPool: '0x7b39000000000000000000000000000000001f62',
      fingerprint: 'a'.repeat(64),
      beneficiaries: [{ name: 'Clean Water Fund', website: 'https://water.example', direction: 'Water wells' }],
      torch: { raised: 120, target: 1000, crossedAt: null, publishedUntil: null },
    }),
    serveLedger: () => ok({
      generatedAt: '2026-11-26T08:00:00.000Z',
      entries: [
        {
          kind: 'torch_in',
          id: 't1',
          amount: '10.00',
          domain: 'example.com',
          txHash: '0xabc123',
          at: '2026-11-26T07:00:00.000Z',
          anchor: 'torch-t1',
        },
        {
          kind: 'donation_out',
          id: 'd1',
          amount: '1000.00',
          beneficiary: 'Clean Water Fund',
          txHash: '0xdef456',
          at: '2026-11-26T06:00:00.000Z',
          fundedInTx: ['0xabc123'],
          anchor: 'donation-d1',
        },
        {
          // hostile tx hash: must not become a link
          kind: 'torch_in',
          id: 't2',
          amount: '1.00',
          txHash: 'javascript:alert(1)',
          at: '2026-11-26T05:00:00.000Z',
          anchor: 'torch-t2',
        },
      ],
    }),
  });
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  const ledger = page.els.get('[data-charity-ledger]').innerHTML;
  assert.match(ledger, /id="torch-t1"/);
  assert.match(ledger, /id="donation-d1"/);
  assert.match(ledger, /https:\/\/basescan\.org\/tx\/0xabc123/);
  assert.match(ledger, /https:\/\/basescan\.org\/tx\/0xdef456/);
  assert.ok(!ledger.includes('href="javascript'), 'an invalid hash must never become an href');
  assert.match(ledger, /<span class="mono">javascript:alert\(1\)<\/span>/, 'the invalid hash stays plain text');
  assert.match(ledger, /Clean Water Fund/);
  assert.equal(page.els.get('[data-charity-ledger-wrap]').hidden, false);
  assert.equal(page.els.get('[data-charity-ledger-empty]').hidden, true);

  // pool + beneficiaries rendered too
  assert.equal(page.els.get('[data-charity-pool]').hidden, false);
  assert.match(page.els.get('[data-charity-pool-num]').textContent, /\$120/);
  assert.match(page.els.get('[data-charity-beneficiaries]').innerHTML, /water\.example/);
  assert.match(page.els.get('[data-charity-beneficiaries]').innerHTML, /rel="noopener"/);
});

/* ── the build-time mirror ──────────────────────────────────────────────── */

test('the ledger mirror fetches the public endpoint and parses it', async () => {
  let seen = '';
  const ledger = await fetchCharityLedger({
    apiBase: 'https://example.test',
    fetchImpl: async (url) => {
      seen = String(url);
      return {
        ok: true,
        status: 200,
        json: async () => ({
          generatedAt: '2026-11-26T08:00:00.000Z',
          entries: [{ kind: 'torch_in', id: 't1', amount: '10.00', txHash: '0xabc', at: 'now', anchor: 'torch-t1' }],
        }),
      };
    },
  });
  assert.equal(seen, `https://example.test${CHARITY_LEDGER_ENDPOINT}`);
  assert.equal(ledger.entries.length, 1);
  assert.equal(ledger.generatedAt, '2026-11-26T08:00:00.000Z');
});

test('a failing ledger endpoint ends as an empty ledger with a warning — never a throw', async () => {
  const httpError = await fetchCharityLedger({
    fetchImpl: async () => ({ ok: false, status: 503, json: async () => ({}) }),
  });
  assert.deepEqual(httpError, { generatedAt: '', entries: [] });

  const networkError = await fetchCharityLedger({
    fetchImpl: async () => {
      throw new Error('offline');
    },
  });
  assert.deepEqual(networkError, { generatedAt: '', entries: [] });

  const malformed = await fetchCharityLedger({
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ['not', 'an', 'object'] }),
  });
  assert.deepEqual(malformed, { generatedAt: '', entries: [] });
});

test('the page ships prerendered with the API fallback and bilingual copy', () => {
  assert.match(source, /export const prerender = true;/);
  assert.match(source, /getStaticPaths/);
  assert.match(source, /<noscript>[\s\S]*\/api\/v1\/charity/);
  assert.match(source, /公益/);
  assert.match(source, /Charity/);
  assert.match(source, /append-only|只增不改/);
  assert.match(source, /助力不改变评分|never change a score/);
});
