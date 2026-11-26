// scripts/torch-ui.test.mjs — the Torch Boost client surfaces
// (apps/web/src/components/detail/TorchBadge.astro,
//  apps/web/src/components/home/TorchBoard.astro,
//  apps/web/src/components/detail/TorchBoost.astro).
//
// The three scripts are TypeScript compiled by Astro, so they are stripped
// with node:module's stripTypeScriptTypes and run in a VM against a small
// fake DOM and a controlled fetch — no request can reach the public service.
//
// What breaks silently without these tests:
//   · a zero-boost site showing an empty badge,
//   · the leaderboard ignoring the URL it was shared with,
//   · a paid boost that never updates the badge on the same page,
//   · advertising a shop whose sales gate is closed.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';

const require = createRequire(import.meta.url);
const originalEmitWarning = process.emitWarning;
process.emitWarning = () => {};
const { stripTypeScriptTypes } = require('node:module');
process.emitWarning = originalEmitWarning;

const read = (path) => readFileSync(new URL(`../apps/web/src/${path}`, import.meta.url), 'utf8');

/** torch.ts + one component script, imports stripped, exports flattened. */
function clientSource(component) {
  const strip = (src) =>
    stripTypeScriptTypes(src, { mode: 'strip' })
      .replace(/^\s*import[\s\S]*?from\s*'[^']+';\s*$/gm, '')
      .replace(/^\s*export /gm, '');
  return `${strip(read('data/torch.ts'))}\n${strip(component)}`;
}

const componentScript = (path) => {
  const source = read(path);
  const script = source.match(/<script>\s*([\s\S]*?)<\/script>/)?.[1];
  assert.ok(script, `${path} must carry a client script`);
  return script;
};

/* ── a minimal element ──────────────────────────────────────────────────── */

function makeEl(props = {}) {
  const el = {
    hidden: false,
    textContent: '',
    innerHTML: '',
    value: '',
    disabled: false,
    dataset: {},
    attrs: {},
    listeners: {},
    children: {},
    childrenAll: {},
    style: { setProperty() {}, display: '' },
    getAttribute(name) {
      return name in this.attrs ? this.attrs[name] : null;
    },
    setAttribute(name, value) {
      this.attrs[name] = String(value);
    },
    addEventListener(type, fn) {
      (this.listeners[type] ||= []).push(fn);
    },
    removeEventListener() {},
    dispatch(type, event = {}) {
      for (const fn of this.listeners[type] ?? []) fn({ preventDefault() {}, target: this, ...event });
    },
    querySelector(sel) {
      return this.children[sel] ?? null;
    },
    querySelectorAll(sel) {
      return this.childrenAll[sel] ?? this.children[sel] ?? [];
    },
    replaceChildren() {
      this.innerHTML = '';
    },
    focus() {},
    ...props,
  };
  return el;
}

const jsonResponse = (status, body) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

const flush = () => new Promise((resolve) => setImmediate(resolve));

const DETAIL = {
  domain: 'example.com',
  total: 42.5,
  count: 3,
  rank: 7,
  lastAt: '2026-11-26T08:00:00.000Z',
  raised: 120,
  target: 1000,
  salesOpen: true,
};

/* ── TorchBadge ─────────────────────────────────────────────────────────── */

function loadBadge({ serve, locale = 'en', total = 0, rank = '' }) {
  const calls = [];
  const text = makeEl();
  const badge = makeEl({
    dataset: {
      domain: 'example.com',
      torchTotal: String(total),
      torchCount: '0',
      torchRank: rank,
      torchTplTotal: locale === 'zh-CN' ? '🔥 {amount} · 助力 {count} 次' : '🔥 {amount} · {count} boosts',
      torchTplRank: locale === 'zh-CN' ? ' · 全站第 {rank}' : ' · #{rank} all time',
    },
    hidden: true,
    children: { '[data-torch-badge-text]': text },
  });
  badge.hidden = true;
  const document = {
    querySelectorAll: (sel) => (sel === '[data-torch-badge]' ? [badge] : []),
    querySelector: () => null,
    addEventListener() {},
  };
  runInNewContext(clientSource(componentScript('components/detail/TorchBadge.astro')), {
    document,
    fetch: (url, options) => {
      calls.push({ url: String(url), options });
      return Promise.resolve(serve(String(url)));
    },
    URLSearchParams,
    AbortController,
    console,
  });
  return { badge, text, calls };
}

test('badge stays hidden on a zero-boost site and paints amount, count and rank otherwise', async () => {
  const zero = loadBadge({ serve: () => jsonResponse(200, { ...DETAIL, total: 0, count: 0, rank: null }) });
  await flush();
  assert.equal(zero.badge.hidden, true);
  assert.equal(zero.text.textContent, '');

  const paid = loadBadge({ serve: () => jsonResponse(200, DETAIL) });
  await flush();
  assert.equal(paid.badge.hidden, false);
  assert.equal(paid.text.textContent, '🔥 $42.5 · 3 boosts · #7 all time');
  assert.equal(paid.badge.dataset.torchTotal, '42.5');
  assert.match(paid.calls[0].url, /\/api\/v1\/torch\/detail\?domain=example\.com$/);
  assert.equal(paid.calls[0].options.cache, 'no-store');
});

test('badge renders the zh-CN copy and survives an unreachable API', async () => {
  const zh = loadBadge({ locale: 'zh-CN', serve: () => jsonResponse(200, DETAIL) });
  await flush();
  assert.equal(zh.text.textContent, '🔥 $42.5 · 助力 3 次 · 全站第 7');

  const down = loadBadge({
    serve: () => {
      throw new Error('offline');
    },
  });
  await flush();
  assert.equal(down.badge.hidden, true);
});

/* ── TorchBoard ─────────────────────────────────────────────────────────── */

const BOARD_ITEM = { domain: 'example.com', total: 12.5, count: 2, grade: 'B', score: 88 };

function loadBoard({ serve, search = '', siteBase = '/site/' }) {
  const calls = [];
  const replaced = [];
  const list = makeEl();
  const pager = makeEl({ hidden: true });
  const prev = makeEl();
  const next = makeEl();
  const pageLabel = makeEl({ textContent: 'Page {n} of {m}' });
  const tabs = ['day', 'week', 'month', 'all'].map((id) =>
    makeEl({ dataset: { torchTab: id }, attrs: { 'aria-selected': 'false' } }),
  );
  const root = makeEl({
    hidden: true,
    dataset: { locale: 'en', siteBase },
    children: {
      '[data-torch-items]': list,
      '[data-torch-pager]': pager,
      '[data-torch-prev]': prev,
      '[data-torch-next]': next,
      '[data-torch-page]': pageLabel,
    },
    childrenAll: { '[data-torch-tab]': tabs },
  });
  const document = {
    querySelector: (sel) => (sel === '[data-torch-board]' ? root : null),
    querySelectorAll: () => [],
    addEventListener() {},
  };
  const location = { search, href: `https://afr.im/${search}`, pathname: '/' };
  runInNewContext(clientSource(componentScript('components/home/TorchBoard.astro')), {
    document,
    location,
    history: { replaceState: (_s, _t, url) => replaced.push(String(url)) },
    fetch: (url, options) => {
      const href = String(url);
      calls.push({ url: href, options });
      return Promise.resolve(serve(href));
    },
    URL,
    URLSearchParams,
    AbortController,
    console,
  });
  return { root, list, pager, prev, next, pageLabel, tabs, calls, replaced };
}

const boardResponse = (overrides = {}) => ({
  tab: 'day',
  page: 1,
  pages: 1,
  total: 1,
  salesOpen: true,
  items: [BOARD_ITEM],
  ...overrides,
});

test('board restores tab and page from the URL and falls back on invalid values', async () => {
  const shared = loadBoard({ search: '?torch=week&p=2', serve: () => jsonResponse(200, boardResponse({ tab: 'week', page: 2, pages: 3, total: 70 })) });
  await flush();
  assert.match(shared.calls[0].url, /tab=week&page=2$/);
  assert.equal(shared.tabs[1].getAttribute('aria-selected'), 'true');
  assert.equal(shared.pageLabel.textContent, 'Page 2 of 3');
  assert.equal(shared.root.hidden, false);

  const bogus = loadBoard({ search: '?torch=never&p=-4', serve: () => jsonResponse(200, boardResponse()) });
  await flush();
  assert.match(bogus.calls[0].url, /tab=day&page=1$/);
  assert.equal(bogus.tabs[0].getAttribute('aria-selected'), 'true');
});

test('board renders rows as validated text and writes shareable URL state', async () => {
  const page = loadBoard({ serve: () => jsonResponse(200, boardResponse({ pages: 3, total: 70 })) });
  await flush();
  assert.equal(page.root.hidden, false);
  assert.match(page.list.innerHTML, /href="\/site\/example\.com"/);
  assert.match(page.list.innerHTML, />01</);
  assert.match(page.list.innerHTML, />b</); // grade letter, lowercase
  assert.match(page.list.innerHTML, /\$12\.5/);
  assert.equal(page.pager.hidden, false);
  assert.equal(page.prev.disabled, true);
  assert.equal(page.next.disabled, false);

  page.tabs[1].dispatch('click');
  await flush();
  assert.match(page.calls.at(-1).url, /tab=week&page=1$/);
  assert.ok(page.replaced.at(-1).includes('torch=week'));

  page.next.dispatch('click');
  await flush();
  assert.match(page.calls.at(-1).url, /tab=week&page=2$/);
  assert.ok(page.replaced.at(-1).includes('p=2'));
});

test('an empty window still shows the tabs; a closed shop or bad payload stays hidden', async () => {
  // Open shop, empty window: the four tabs must stay reachable — hiding the
  // section would trap the reader on the default tab forever.
  const empty = loadBoard({ serve: () => jsonResponse(200, boardResponse({ items: [], total: 0 })) });
  await flush();
  assert.equal(empty.root.hidden, false);
  assert.equal(empty.list.innerHTML, '');

  // Closed shop with nothing at all: the board would only advertise a
  // closed feature, and the one extra look at the whole book confirms it.
  const closed = loadBoard({
    serve: () => jsonResponse(200, boardResponse({ items: [], total: 0, salesOpen: false })),
  });
  await flush();
  assert.equal(closed.root.hidden, true);
  assert.equal(closed.list.innerHTML, '');

  const junk = loadBoard({ serve: () => jsonResponse(200, { items: 'nope' }) });
  await flush();
  assert.equal(junk.root.hidden, true);
  assert.equal(junk.list.innerHTML, '');

  const failed = loadBoard({
    serve: () => {
      throw new Error('offline');
    },
  });
  await flush();
  assert.equal(failed.root.hidden, true);
});

/* ── TorchBoost ─────────────────────────────────────────────────────────── */

const COPY = {
  open: 'Boost this site', title: 'Boost this site', note: 'note', amountLabel: 'Amount',
  custom: 'Custom', invalidAmount: 'Enter an amount between $1 and $1000, at most two decimals.',
  pay: 'Pay with USDC', working: 'Creating your order…', checkout: 'Open checkout',
  codeLabel: 'Binding code', copy: 'Copy', copied: 'Copied ✓', valid15: 'Valid for 15 minutes',
  waiting: 'Waiting for payment…', checking: 'Checking payment status…',
  paid: 'Received — thank you for the boost.', expired: 'This order expired before payment. Order again to boost.',
  cancelled: 'This order was cancelled. You can order again.', review: 'Payment received, under review.',
  bindingExpired: 'The binding code expired before payment was seen. Order again to boost.',
  notFound: 'Order not found. Order again to boost.',
  close: 'Close', errClosed: 'Boost sales are currently closed.',
  errCap: 'This site has reached its $1,000 boost cap for today.',
  errBilling: 'Payments are temporarily unavailable.',
  errGeneric: 'Could not create the order — try again.',
  errNetwork: 'Network error — try again.',
};

function loadBoost({ serveOrder, serveStatus, serveDetail = () => jsonResponse(200, DETAIL) }) {
  const calls = [];
  const timers = new Map();
  let timerId = 0;

  const modal = makeEl({ hidden: true });
  const open = makeEl();
  const pay = makeEl({ textContent: COPY.pay });
  const custom = makeEl();
  const error = makeEl({ hidden: true });
  const orderBox = makeEl({ hidden: true });
  const checkout = makeEl();
  const code = makeEl();
  const copyBtn = makeEl({ textContent: COPY.copy });
  const statusText = makeEl({ textContent: COPY.waiting });
  const spinner = makeEl();
  const done = makeEl({ hidden: true });
  const doneText = makeEl();
  const backdrop = makeEl();
  const closes = [makeEl(), makeEl()];
  const presets = [1, 5, 10, 25, 50, 100].map((v) => makeEl({ dataset: { torchAmt: String(v) }, attrs: { 'aria-pressed': 'false' } }));

  const badgeText = makeEl();
  const badge = makeEl({
    dataset: {
      domain: 'example.com',
      torchTotal: '42.5',
      torchCount: '3',
      torchRank: '7',
      torchTplTotal: '🔥 {amount} · {count} boosts',
      torchTplRank: ' · #{rank} all time',
    },
    hidden: false,
    children: { '[data-torch-badge-text]': badgeText },
  });
  badgeText.textContent = '🔥 $42.5 · 3 boosts · #7 all time';

  const root = makeEl({
    hidden: true,
    dataset: { domain: 'example.com', copy: JSON.stringify(COPY) },
    children: {
      '[data-torch-modal]': modal,
      '[data-torch-open]': open,
      '[data-torch-pay]': pay,
      '[data-torch-custom]': custom,
      '[data-torch-error]': error,
      '[data-torch-order]': orderBox,
      '[data-torch-checkout]': checkout,
      '[data-torch-code]': code,
      '[data-torch-copy]': copyBtn,
      '[data-torch-status-text]': statusText,
      '[data-torch-done]': done,
      '[data-torch-done-text]': doneText,
      '[data-torch-backdrop]': backdrop,
      '.tb-spinner': spinner,
    },
    childrenAll: {
      '[data-torch-close]': closes,
      '[data-torch-amt]': presets,
    },
  });

  const document = {
    querySelectorAll: (sel) => {
      if (sel === '[data-torch-boost]') return [root];
      if (sel === '[data-torch-badge]') return [badge];
      return [];
    },
    querySelector: () => null,
    listeners: {},
    addEventListener(type, fn) {
      (this.listeners[type] ||= []).push(fn);
    },
  };

  runInNewContext(clientSource(componentScript('components/detail/TorchBoost.astro')), {
    document,
    fetch: (url, options) => {
      const href = String(url);
      calls.push({ url: href, options: options ?? {} });
      if (href.includes('/torch/detail')) return Promise.resolve(serveDetail());
      if (href.includes('/torch/order')) return Promise.resolve(serveOrder(options ?? {}));
      if (href.includes('/torch/status')) return Promise.resolve(serveStatus());
      return Promise.resolve(jsonResponse(404, { error: 'not_found' }));
    },
    crypto: { randomUUID: () => '123e4567-e89b-42d3-a456-426614174000' },
    setTimeout: (fn, ms) => {
      timerId += 1;
      timers.set(timerId, { fn, ms });
      return timerId;
    },
    clearTimeout: (id) => timers.delete(id),
    navigator: { clipboard: { writeText: async () => {} } },
    URLSearchParams,
    AbortController,
    console,
  });

  const runTimers = async () => {
    const entries = [...timers.entries()];
    timers.clear();
    for (const [, { fn }] of entries) {
      fn();
      await flush();
    }
  };

  return { root, modal, open, pay, error, orderBox, checkout, code, statusText, done, doneText, badge, badgeText, calls, runTimers };
}

const ORDER = {
  orderId: 'torch-123e4567-e89b-42d3-a456-426614174000',
  bindingCode: 'ABCD2345',
  amount: 10,
  checkoutUrl: 'https://pay.example/xyz',
  expiresAt: '2026-11-26T09:15:00.000Z',
};

test('boost orders, polls, and credits the badge the moment the payment lands', async () => {
  let status = { status: 'pending', amount: 10, paidAt: null };
  const page = loadBoost({
    serveOrder: () => jsonResponse(201, ORDER),
    serveStatus: () => jsonResponse(200, status),
  });
  await flush();
  // salesOpen from the detail endpoint reveals the button
  assert.equal(page.root.hidden, false);

  page.open.dispatch('click');
  assert.equal(page.modal.hidden, false);

  page.pay.dispatch('click');
  await flush();
  const orderCall = page.calls.find((c) => c.url.includes('/torch/order'));
  assert.ok(orderCall, 'the order must be posted');
  assert.equal(orderCall.options.method, 'POST');
  assert.deepEqual(JSON.parse(orderCall.options.body), {
    domain: 'example.com',
    amount: 10,
    requestId: '123e4567-e89b-42d3-a456-426614174000',
  });
  assert.equal(page.orderBox.hidden, false);
  assert.equal(page.checkout.attrs.href ?? page.checkout.href, 'https://pay.example/xyz');
  assert.equal(page.code.textContent, 'ABCD2345');

  // first poll: still pending → a5-second timer is armed
  await flush();
  assert.ok(page.calls.some((c) => c.url.includes('/torch/status')));
  status = { status: 'paid', amount: 10, paidAt: '2026-11-26T08:30:00.000Z' };
  await page.runTimers();

  assert.equal(page.done.hidden, false);
  assert.equal(page.doneText.textContent, COPY.paid);
  assert.equal(page.badge.dataset.torchTotal, '52.5');
  assert.equal(page.badge.dataset.torchCount, '4');
  assert.equal(page.badge.hidden, false);
  assert.equal(page.badgeText.textContent, '🔥 $52.5 · 4 boosts · #7 all time');
});

test('a closed sales gate hides the whole block instead of advertising it', async () => {
  const page = loadBoost({
    serveOrder: () => jsonResponse(403, { error: 'torch_sales_closed' }),
    serveStatus: () => jsonResponse(200, { status: 'pending', amount: 10, paidAt: null }),
    serveDetail: () => jsonResponse(200, { ...DETAIL, salesOpen: false }),
  });
  await flush();
  assert.equal(page.root.hidden, true, 'closed sales must never show the button');

  // Even if the gate flips mid-session, the order error hides the block again.
  const flipped = loadBoost({
    serveOrder: () => jsonResponse(403, { error: 'torch_sales_closed' }),
    serveStatus: () => jsonResponse(200, { status: 'pending', amount: 10, paidAt: null }),
  });
  await flush();
  assert.equal(flipped.root.hidden, false);
  flipped.open.dispatch('click');
  flipped.pay.dispatch('click');
  await flush();
  assert.equal(flipped.root.hidden, true);
  assert.equal(flipped.modal.hidden, true);
});

test('the daily cap error shows the $1,000 message and keeps the dialog usable', async () => {
  const page = loadBoost({
    serveOrder: () => jsonResponse(409, { error: 'torch_cap_reached' }),
    serveStatus: () => jsonResponse(200, { status: 'pending', amount: 10, paidAt: null }),
  });
  await flush();
  page.open.dispatch('click');
  page.pay.dispatch('click');
  await flush();
  assert.equal(page.error.hidden, false);
  assert.equal(page.error.textContent, COPY.errCap);
  assert.equal(page.root.hidden, false, 'the cap is not the sales gate');
  assert.equal(page.pay.disabled, false, 'the owner can try a smaller amount');
});

test('a 503 says payments are unavailable and an expired order invites a retry', async () => {
  const billing = loadBoost({
    serveOrder: () => jsonResponse(503, { error: 'settings_missing' }),
    serveStatus: () => jsonResponse(200, { status: 'pending', amount: 10, paidAt: null }),
  });
  await flush();
  billing.open.dispatch('click');
  billing.pay.dispatch('click');
  await flush();
  assert.equal(billing.error.textContent, COPY.errBilling);

  const expired = loadBoost({
    serveOrder: () => jsonResponse(201, ORDER),
    serveStatus: () => jsonResponse(200, { status: 'expired', amount: 10, paidAt: null }),
  });
  await flush();
  expired.open.dispatch('click');
  expired.pay.dispatch('click');
  await flush();
  assert.equal(expired.done.hidden, false);
  assert.equal(expired.doneText.textContent, COPY.expired);
});

/* ── static wiring ──────────────────────────────────────────────────────── */

test('the pages mount the boost surfaces in the promised places', () => {
  const home = read('pages/[...locale]/index.astro');
  const leaderAt = home.indexOf('<Leaderboard');
  const torchAt = home.indexOf('<TorchBoard');
  const stripAt = home.indexOf('<SupporterStrip');
  assert.ok(leaderAt > -1 && torchAt > leaderAt && torchAt < stripAt, 'TorchBoard sits between Leaderboard and SupporterStrip');

  const detail = read('pages/[...locale]/site/[domain].astro');
  assert.ok(detail.includes('<TorchBadge domain={site.domain} locale={locale} />'));
  assert.ok(detail.includes('<TorchBoost domain={site.domain} locale={locale} />'));
  assert.ok(detail.includes('<PromoCard domain={site.domain} locale={locale} />'));
  assert.match(detail, /<TorchBadge[\s\S]{0,200}?data-views/, 'the badge lives next to the views counter');
  // the h1 domain is a sponsorship link with the sponsored rel.
  assert.match(detail, /<h1 class="domain mono">\s*<a href=\{`https:\/\/\$\{site\.domain\}`\} rel="[^"]*nofollow sponsored[^"]*" target="_blank">/);

  const board = read('components/home/TorchBoard.astro');
  assert.match(board, /data-torch-board[^>]*\bhidden\b/);
  assert.match(board, /Paid boosts, never part of the AFR score/);
  assert.match(board, /助力金额不参与评分/);

  const boost = read('components/detail/TorchBoost.astro');
  assert.match(boost, /助力不改变评分/);
  assert.match(boost, /\$1,000 上限/);
});
