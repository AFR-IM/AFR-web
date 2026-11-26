// Run the browser entry point with a controlled clock, visibility observer and API.
// No request can reach the public service.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';

const read = (path) => readFileSync(new URL(`../apps/web/src/${path}`, import.meta.url), 'utf8');
const client = [read('data/ads.ts'), read('utils/ad-slots.ts')]
  .map((source) => stripTypeScriptTypes(source).replace(/^import\s*\{[^}]*\}\s*from\s*'[^']+';\s*/m, '').replace(/^export /gm, ''))
  .join('\n');
const API = 'https://afr.im/api/v1/ads';
const NOW = '2026-11-26T10:59:50.000Z';
const DAY = '2026-11-26';
const ad = (overrides = {}) => ({
  id: 1, domain: 'sponsor.example', slot: 'category-top', slot_key: 'dev-tools', status: 'active',
  headline: 'Ad headline <strong>as text</strong>', body: 'Ad copy',
  grade: 'D', score: 83, starts_at: '2026-11-26T00:00:00.000Z', ends_at: '2026-11-28T00:00:00.000Z',
  ...overrides,
});
const searchAd = (id, key) => ad({ id, slot: 'search-top', slot_key: key });
const supporter = (id) => ad({ id, slot: 'home-supporter', slot_key: null });
const response = (items = [], ok = true) => ({ ok, json: async () => ({ items }) });
const flush = () => new Promise((resolve) => setImmediate(resolve));

function row(slot) {
  const attrs = new Map();
  const style = new Map();
  const parts = slot === 'home-supporter'
    ? { '[data-ad-domain]': {}, '[data-ad-report]': {} }
    : {
      '.ring': { dataset: {}, setAttribute: attrs.set.bind(attrs), style: { setProperty: style.set.bind(style) }, querySelector: () => null },
      '.ring-letter': {}, '.ring-score': {}, '[data-ad-domain]': {}, '[data-ad-headline]': {},
      '[data-ad-body]': {}, '[data-ad-report]': {},
    };
  for (const selector of ['[data-ad-visit]', '[data-ad-report]']) {
    parts[selector] = { setAttribute: (_name, value) => attrs.set(selector, value) };
  }
  return {
    attrs, parts, style, dataset: {}, isConnected: false,
    querySelector: (selector) => parts[selector] ?? null,
    querySelectorAll: () => [],
    cloneNode: () => row(slot),
  };
}

function loadSlot(slot, { serve, initial = '', start = NOW, locale = 'en' }) {
  const calls = [];
  const store = new Map();
  const watched = new Set();
  const timers = new Map();
  const window = new EventTarget();
  const document = new EventTarget();
  const input = Object.assign(new EventTarget(), { value: initial, form: new EventTarget() });
  const navigator = { onLine: true };
  let clock = Date.parse(start);
  let timerId = 0;
  let intersection;
  const outlet = {
    children: [row(slot)],
    get firstElementChild() { return this.children[0]; },
    replaceChildren(...nodes) {
      for (const node of this.children) node.isConnected = false;
      this.children = nodes;
      for (const node of nodes) node.isConnected = true;
    },
  };
  const root = {
    hidden: true,
    dataset: { adSlot: slot, adLocale: locale, adKey: 'dev-tools', adGradeLabel: 'Grade', adScoreLabel: 'Score' },
    querySelector: (selector) => selector === '[data-ad-items]' ? outlet : null,
  };
  Object.assign(document, {
    visibilityState: 'visible',
    querySelectorAll: () => [root],
    querySelector: () => input,
  });
  Object.assign(window, {
    setTimeout: (fn, delay) => timers.set(++timerId, { fn, time: clock + delay }) && timerId,
    clearTimeout: (id) => timers.delete(id),
  });
  class Clock extends Date {
    constructor(...args) { super(...(args.length ? args : [clock])); }
    static now() { return clock; }
  }
  class Observer {
    constructor(callback) { intersection = callback; }
    observe(node) { watched.add(node); }
    unobserve(node) { watched.delete(node); }
  }
  const fetch = (url, options) => {
    const parsed = new URL(url);
    assert.equal(parsed.origin, 'https://afr.im');
    const call = { url: parsed, options };
    calls.push(call);
    return Promise.resolve(serve(call));
  };
  runInNewContext(`${client}\nstartAdSlots();`, {
    AbortController, Date: Clock, document, fetch, IntersectionObserver: Observer,
    localStorage: { getItem: (key) => store.get(key), setItem: (key, value) => store.set(key, value) },
    location: { search: `?q=${encodeURIComponent(initial)}` }, navigator, URLSearchParams, window,
  });
  return {
    calls, root, outlet, store, window,
    show(state) {
      document.visibilityState = state;
      document.dispatchEvent(new Event('visibilitychange'));
    },
    type(value) {
      input.value = value;
      input.dispatchEvent(new Event('input'));
    },
    seen(node, inView = true) {
      assert.ok(watched.has(node));
      node.closest = () => root.hidden ? root : null;
      intersection([{ target: node, isIntersecting: inView, intersectionRatio: inView ? 0.5 : 0 }]);
    },
    async advance(ms) {
      const end = clock + ms;
      await flush();
      while (timers.size) {
        const [id, { fn, time }] = [...timers].sort((a, b) => a[1].time - b[1].time)[0];
        if (time > end) break;
        clock = time;
        timers.delete(id);
        fn();
        await flush();
      }
      clock = end;
    },
  };
}

test('static entry points ship hidden shells with no ad payload; natural results have a separate grid', () => {
  const card = read('components/home/SponsoredCard.astro');
  const strip = read('components/home/SupporterStrip.astro');
  const search = read('pages/[...locale]/search.astro');
  assert.match(card, /<aside[^>]+data-ad-slot=[^>]+\bhidden\b/);
  assert.match(strip, /<section[^>]+data-ad-slot="home-supporter"[^>]+\bhidden\b/);
  assert.match(card, /<GradeRing [^>]+animate=\{false\}/);
  assert.doesNotMatch(strip, /<GradeRing/);
  assert.match(search, /data-ad-search/);
  assert.match(search, /<SponsoredCard slot="search-top"[^>]+\/>\s*<div\s+class="grid"/);
  assert.match(read('pages/[...locale]/c/[slug].astro'), /<SponsoredCard slot="category-top" adKey=\{slug\}/);
  assert.match(read('pages/[...locale]/index.astro'), /<SupporterStrip locale=\{locale\}/);
  assert.doesNotMatch(client + card + strip + search, /ads\.json|loadAds\(|__afrAdImpression/);
});

test('category requests fresh scoped placements and paints the grade and score returned by the API', async () => {
  const page = loadSlot('category-top', { serve: () => response([
    ad({ id: 2, status: 'paused' }), ad({ id: 3, slot_key: 'other' }), ad({ id: 4, grade: null }),
    ad({ id: 5, score: '83' }), ad({ id: 6, ends_at: NOW }), ad({ id: 7, ends_at: 'invalid' }),
    ad({ id: 8, starts_at: '2026-11-27T00:00:00.000Z' }), ad(),
  ]) });
  await page.advance(0);
  const [call] = page.calls;
  assert.equal(call.url.href, `${API}?slot=category-top&key=dev-tools`);
  assert.equal(call.options.cache, 'no-store');
  assert.equal(call.options.credentials, 'omit');
  assert.equal(page.root.hidden, false);
  const [card] = page.outlet.children;
  assert.equal(card.dataset.adId, '1');
  assert.equal(card.parts['.ring'].dataset.grade, 'D');
  assert.equal(card.parts['.ring-score'].textContent, '83');
  assert.equal(card.style.get('--pct'), '83%');
  assert.equal(card.parts['[data-ad-headline]'].textContent, ad().headline);
  assert.equal(card.attrs.get('[data-ad-visit]'), `${API}/go?id=1`);
  assert.equal(card.attrs.get('[data-ad-report]'), `${API}/report?id=1&lang=en`);
});

test('category rotates at the UTC hour boundary and hides exactly at ends_at', async () => {
  let items = [ad(), ad({ id: 2 })];
  const page = loadSlot('category-top', { serve: () => response(items) });
  await page.advance(9_999);
  assert.equal(page.outlet.children[0].dataset.adId, '1');
  assert.equal(page.calls.length, 1);
  items = [ad({ id: 2, ends_at: '2026-11-26T11:00:05.000Z' }), ad()];
  await page.advance(1);
  assert.equal(page.calls.length, 2);
  assert.equal(page.outlet.children[0].dataset.adId, '2');
  // A slow follow-up response cannot keep the expired ad on screen.
  items = [];
  await page.advance(4_999);
  assert.equal(page.root.hidden, false);
  await page.advance(1);
  assert.equal(page.root.hidden, true);
  assert.equal(page.outlet.children.length, 0);
});

test('a live slot disappears on pause or failure and rechecks on returning to the tab', async () => {
  let items = [supporter(1)];
  const page = loadSlot('home-supporter', { serve: () => response(items ?? [], !!items) });
  await page.advance(0);
  assert.equal(page.root.hidden, false);
  items = [supporter(1)];
  page.show('hidden');
  assert.equal(page.root.hidden, true);
  await page.advance(120_000);
  assert.equal(page.calls.length, 1);
  page.show('visible');
  await page.advance(0);
  assert.equal(page.root.hidden, false);
  items = [];
  await page.advance(30_000);
  assert.equal(page.root.hidden, true);
  items = [supporter(2)];
  page.show('hidden');
  page.show('visible');
  await page.advance(0);
  assert.equal(page.outlet.children[0].dataset.adId, '2');
  items = null;
  await page.advance(30_000);
  assert.equal(page.root.hidden, true);
  assert.equal(page.outlet.children.length, 0);
});

test('debounced search sends the exact current term only to AFR and drops late responses', async () => {
  let resolveOld;
  const deferred = new Promise((resolve) => { resolveOld = resolve; });
  const key = 'Dev 工具 & Cloud';
  const page = loadSlot('search-top', {
    initial: 'Old keyword', locale: 'zh-CN', serve: ({ url }) => url.searchParams.get('key') === 'Old keyword'
      ? deferred : response([searchAd(4, 'dev 工具 & cloud')]),
  });
  await page.advance(250);
  page.type('Dev');
  await page.advance(150);
  page.type(`  ${key} `);
  assert.equal(page.calls[0].options.signal.aborted, true);
  await page.advance(249);
  assert.equal(page.calls.length, 1);
  await page.advance(1);
  assert.equal(page.calls[1].url.searchParams.get('key'), key);
  assert.equal(page.calls[1].options.referrerPolicy, 'no-referrer');
  assert.equal(page.calls[1].options.redirect, 'error');
  assert.equal(page.outlet.children[0].attrs.get('[data-ad-report]'), `${API}/report?id=4&lang=zh-CN`);
  resolveOld(response([searchAd(5, 'old keyword')]));
  await page.advance(0);
  assert.equal(page.outlet.children[0].dataset.adId, '4');
  page.type('');
  assert.equal(page.root.hidden, true);
  await page.advance(30_000);
  assert.equal(page.calls.length, 2);
});

test('supporter impressions require an actual visible row, retry failures and deduplicate by UTC day', async () => {
  let ok = false;
  const page = loadSlot('home-supporter', {
    start: '2026-11-26T23:59:20.000Z',
    serve: ({ options }) => options.method === 'POST' ? response([], ok) : response([supporter(1), supporter(2)]),
  });
  const posts = () => page.calls.filter(({ options }) => options.method === 'POST');
  await page.advance(0);
  assert.equal(page.calls[0].url.href, `${API}?slot=home-supporter`);
  assert.equal(posts().length, 0);
  page.seen(page.outlet.children[1], false);
  assert.equal(posts().length, 0);
  page.seen(page.outlet.children[0]);
  page.seen(page.outlet.children[0]);
  assert.equal(posts().length, 1);
  await page.advance(0);
  assert.equal(page.store.has(`afr-ad-imp:1:${DAY}`), false);
  ok = true;
  await page.advance(30_000);
  assert.equal(posts().length, 2);
  assert.equal(page.store.get(`afr-ad-imp:1:${DAY}`), '1');
  page.show('hidden');
  page.show('visible');
  await page.advance(0);
  page.seen(page.outlet.children[0]);
  assert.equal(posts().length, 2);
  await page.advance(30_000);
  assert.equal(posts().length, 3);
  assert.equal(page.store.get('afr-ad-imp:1:2026-11-27'), '1');
  for (const { url, options } of posts()) {
    assert.equal(url.href, `${API}/event`);
    assert.equal(options.headers['content-type'], 'application/json');
    assert.deepEqual(JSON.parse(options.body), { id: 1 });
  }
});
