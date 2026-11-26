// Run the Astro panel's real browser script against a local fake DOM and API.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';

const read = (path) => readFileSync(new URL(`../apps/web/src/${path}`, import.meta.url), 'utf8');
const source = read('components/detail/OwnerAds.astro');
const markup = source.split('---')[2].split('<style>')[0];
const script = stripTypeScriptTypes(source.match(/<script>([\s\S]*?)<\/script>/)[1]);
const translations = source.match(/const copy = \{[\s\S]*?\n\};/)[0];
const API = 'https://afr.im/api/v1/ads';
const DOMAIN = 'example.com';
const TOKEN = 'test-owner-token';
const TOKEN_KEY = `afr-owner-mail-${DOMAIN}`;
const DRAFT_KEY = `afr-owner-ads-application-${DOMAIN}`;
const ORDER_KEY = `afr-owner-ads-order-${DOMAIN}`;
const REQUEST_ID = '00000000-0000-4000-8000-000000000001';
const ORDER_ID = `ad-${REQUEST_ID}`;
const CHECKOUT_URL = 'https://aipay.im/checkout/example';
const NOW = Date.parse('2026-11-26T11:00:00.000Z');
const ACTIVE_OFFERS = { salesOpen: true, items: [
  { slot: 'category-top', amount: 49, term_days: 30, capacity: 3, available: 1 },
  { slot: 'search-top', amount: 99, term_days: 30, capacity: 1, available: 1 },
  { slot: 'home-supporter', amount: 199, term_days: 30, capacity: 8, available: 1 },
  { slot: 'report-sponsor', amount: 999, term_days: 360, capacity: 1, available: 1 },
] };
const OWNER = { [TOKEN_KEY]: TOKEN };
const flush = () => new Promise((resolve) => setImmediate(resolve));
const response = (data, status = 200) => ({ status, ok: status >= 200 && status < 300, json: async () => data });
const makeOrder = (patch = {}) => ({ order: {
  orderId: ORDER_ID, adId: 1, domain: DOMAIN, reference: 'test-reference', checkoutUrl: CHECKOUT_URL,
  amount: '49', asset: 'USDC', chainKey: 'base', termDays: 30,
  expiresAt: '2026-11-26T11:15:00.000Z', status: 'pending', paid: false,
  startsAt: null, endsAt: null, ...patch,
} });

function element(attrs = '') {
  const node = new EventTarget();
  return Object.assign(node, {
    hidden: /\shidden(?:\s|>)/.test(attrs),
    disabled: /\sdisabled(?:\s|>)/.test(attrs),
    value: '',
    textContent: '',
    focus() {},
    removeAttribute(name) { delete this[name]; },
  });
}

function setup({ serve, storage = OWNER, path = '', lang = 'en', uuid = REQUEST_ID, observeMailbox = false, save = true }) {
  const store = new Map(Object.entries(storage));
  const nodes = new Map();
  for (const [tag, name] of markup.matchAll(/<[a-z][\w-]*\b[^>]*\bdata-oa-([a-z-]+)\b[^>]*>/g)) {
    nodes.set(name, element(tag));
  }
  const at = (name) => {
    const found = nodes.get(name);
    assert.ok(found, `no markup for data-oa-${name}`);
    return found;
  };
  const slot = at('slot');
  slot.options = ['category-top', 'search-top', 'home-supporter'].map((value) => ({ value, disabled: false }));
  at('apply').reset = () => {
    slot.value = 'category-top';
    at('category').value = 'dev-tools';
    at('search').value = '';
    at('headline').value = '';
    at('body').value = '';
    at('months').value = '1';
  };
  at('apply').reset();
  const root = Object.assign(element(markup.match(/<section[^>]*>/)[0]), {
    dataset: { domain: DOMAIN, locale: lang, copy: JSON.stringify(runInNewContext(`${translations}\ncopy`, { t: (en, zh) => lang === 'en' ? en : zh })) },
    querySelector(selector) { return at(selector.slice('[data-oa-'.length, -1)); },
    scrolled: false,
    scrollIntoView() { this.scrolled = true; },
  });
  const calls = [];
  const fetch = (url, init) => {
    const endpoint = new URL(url);
    assert.ok(url.startsWith(`${API}/`));
    const call = { path: endpoint.pathname.slice('/api/v1/ads'.length) + endpoint.search, ...init };
    if (init.body) call.data = JSON.parse(init.body);
    calls.push(call);
    return Promise.resolve(serve(call, store));
  };
  class Clock extends Date {
    static now() { return NOW; }
  }
  let onMutation;
  let count = 0;
  const window = new EventTarget();
  runInNewContext(script, {
    URL, URLSearchParams, AbortSignal, Date: Clock, fetch, window,
    crypto: { randomUUID: () => count++ === 0 ? uuid : '00000000-0000-4000-8000-000000000002' },
    document: { querySelectorAll: () => [root], querySelector: () => observeMailbox ? {} : null },
    MutationObserver: class {
      constructor(callback) { onMutation = callback; }
      observe() {}
    },
    localStorage: {
      getItem: (key) => store.get(key) ?? null,
      setItem(key, value) {
        if (!save) throw new Error('Storage blocked');
        store.set(key, String(value));
      },
    },
    location: new URL(`https://www.afr.im/owner/${DOMAIN}/${path}`),
  });
  async function fire(name, event) {
    at(name).dispatchEvent(new Event(event, { cancelable: true }));
    await flush();
  }
  return {
    at, root, store, calls, window, mailboxChanged: () => onMutation?.(),
    submit: () => fire('apply', 'submit'), check: () => fire('lookup', 'submit'), click: (name) => fire(name, 'click'),
    fill(values = { headline: 'Example sponsor', body: 'Read more about this site.' }) {
      for (const [name, value] of Object.entries(values)) at(name).value = value;
      at('apply').dispatchEvent(new Event('change'));
    },
  };
}

test('owner workspace mounts a hidden panel with an AIPAY return anchor', () => {
  assert.match(read('pages/[...locale]/owner/[domain].astro'), /<OwnerAds domain=\{site\.domain\} locale=\{locale\}/);
  assert.match(markup, /<section\s+id="owner-ads"[^>]*\shidden\b/);
  assert.match(markup, /<form[^>]*data-oa-apply hidden/);
  assert.match(markup, /<a[^>]*data-oa-checkout[^>]*target="_blank" rel="noopener noreferrer"/);
  assert.match(source, /\.oa\[hidden\][^{}]*\{ display: none; \}/);
});

test('closed, unavailable, or malformed offers never expose purchase or price', async () => {
  for (const result of [
    response({ ...ACTIVE_OFFERS, salesOpen: false }), response({ ...ACTIVE_OFFERS, salesOpen: 'true' }),
    response({ ...ACTIVE_OFFERS, items: null }), response({}, 503),
  ]) {
    const panel = setup({ serve: () => result });
    await flush();
    assert.equal(panel.root.hidden, true);
    assert.equal(panel.at('apply').hidden, true);
    assert.equal(panel.at('price').textContent, '');
    await panel.submit();
    assert.deepEqual(panel.calls.map(({ path, method }) => [path, method]), [['/offers', 'GET']]);
    assert.equal(panel.calls[0].headers.authorization, undefined);
    assert.equal(panel.calls[0].cache, 'no-store');
    assert.equal(panel.calls[0].credentials, 'omit');
  }
});

test('only this domain’s token unlocks purchase, including when restored in OwnerMailbox', async () => {
  const panel = setup({ storage: { 'afr-owner-mail-other.example': TOKEN }, observeMailbox: true,
    serve: () => response(ACTIVE_OFFERS) });
  await flush();
  assert.equal(panel.root.hidden, true);
  assert.equal(panel.at('apply').hidden, true);
  assert.equal(panel.calls.length, 0);
  panel.store.set(TOKEN_KEY, TOKEN);
  panel.mailboxChanged();
  await flush();
  assert.equal(panel.at('apply').hidden, false);
  panel.store.delete(TOKEN_KEY);
  panel.mailboxChanged();
  assert.equal(panel.at('apply').hidden, true);
  await panel.submit();
  assert.equal(panel.calls.length, 1);
});

test('three offers price a 30-day term and send only the selected placement key', async () => {
  for (const [slot, slotKey, price] of [
    ['category-top', 'dev-tools', 49], ['search-top', 'AI 工具', 99], ['home-supporter', null, 199],
  ]) {
    const panel = setup({ serve: (call) => call.path === '/offers' ? response(ACTIVE_OFFERS) :
      response(makeOrder({ amount: String(price * 12), termDays: 360 }), 201) });
    await flush();
    panel.fill({ slot, months: '12', search: '  AI 工具  ', headline: ' Example ad ', body: ' Text ' });
    assert.equal(panel.at('category-wrap').hidden, slot !== 'category-top');
    assert.equal(panel.at('search-wrap').hidden, slot !== 'search-top');
    assert.equal(panel.at('home-note').hidden, slot !== 'home-supporter');
    assert.match(panel.at('price').textContent, new RegExp(`^${price} USDC / 30 days · Estimated total: `));
    await panel.submit();
    const call = panel.calls[1];
    assert.equal(call.path, '/apply');
    assert.equal(call.method, 'POST');
    assert.equal(call.headers.authorization, `Bearer ${TOKEN}`);
    assert.equal(call.headers['content-type'], 'application/json');
    assert.deepEqual(call.data, { requestId: REQUEST_ID, domain: DOMAIN, slot, slot_key: slotKey,
      headline: 'Example ad', body: 'Text', months: 12 });
    assert.equal(panel.at('order-id').value, ORDER_ID);
    assert.equal(panel.at('order-link').href, `?orderId=${ORDER_ID}#owner-ads`);
    assert.equal(panel.at('checkout').href, CHECKOUT_URL);
    assert.equal(panel.at('pay').hidden, false);
  }
});

test('limits are validated before sending, counting supplementary characters once', async () => {
  const panel = setup({ serve: ({ path }) => path === '/offers' ? response(ACTIVE_OFFERS) : response(makeOrder()) });
  await flush();
  panel.fill({ headline: '🙂'.repeat(41), body: '正文' });
  await panel.submit();
  panel.fill({ headline: '标题', body: '文'.repeat(91) });
  await panel.submit();
  panel.fill({ body: '正文', months: '13' });
  await panel.submit();
  assert.equal(panel.calls.length, 1);
  panel.fill({ headline: '🙂'.repeat(40), body: '文'.repeat(90), months: '1' });
  await panel.submit();
  assert.equal(panel.calls.length, 2);
  assert.equal([...panel.calls[1].data.headline].length, 40);
});

test('a lost response and provider failure replay the exact UUID and payload across reloads', async () => {
  let original;
  const first = setup({ serve(call, store) {
    if (call.path === '/offers') return response(ACTIVE_OFFERS);
    original = call.data;
    const saved = JSON.parse(store.get(DRAFT_KEY));
    assert.equal(saved.input.requestId, REQUEST_ID, 'the draft must be saved before fetch');
    assert.equal(saved.stage, 'retry');
    throw new Error('response lost');
  } });
  await flush();
  first.fill();
  await first.submit();
  assert.equal(first.at('fields').disabled, true);
  assert.equal(first.at('submit').textContent, 'Retry this application');
  assert.equal(first.at('order-id').value, ORDER_ID);

  let tries = 0;
  const next = setup({ storage: Object.fromEntries(first.store), uuid: '00000000-0000-4000-8000-000000000003', serve(call) {
    if (call.path === '/offers') return response(ACTIVE_OFFERS);
    if (call.path === `/orders/${ORDER_ID}`) return response(makeOrder({ checkoutUrl: undefined }));
    return ++tries === 1 ? response({ error: 'billing_unavailable' }, 502) : response(makeOrder());
  } });
  await flush();
  assert.equal(next.at('submit').textContent, 'Retry this application');
  next.fill({ headline: 'an edit to the frozen fields' });
  await next.submit();
  await next.submit();
  assert.deepEqual(next.calls.filter((call) => call.method === 'POST').map((call) => call.data), [original, original]);
  assert.equal(next.store.get(ORDER_KEY), ORDER_ID);
  assert.equal(JSON.parse(next.store.get(DRAFT_KEY)).input.requestId, REQUEST_ID);
  assert.equal(next.at('submit').textContent, 'View this order');
  await next.submit();
  assert.equal(next.calls.filter((call) => call.method === 'POST').length, 2);
  assert.equal(next.calls.at(-1).path, `/orders/${ORDER_ID}`);
  assert.equal(next.calls.at(-1).method, 'GET');
});

test('a definitive validation failure allows correction with the same UUID', async () => {
  let count = 0;
  const panel = setup({ serve: ({ path }) => path === '/offers' ? response(ACTIVE_OFFERS) :
    ++count === 1 ? response({ error: 'disallowed_claim' }, 400) : response(makeOrder()) });
  await flush();
  panel.fill({ headline: '#1', body: 'Example' });
  await panel.submit();
  assert.match(panel.at('apply-message').textContent, /misleading claims/);
  assert.equal(panel.at('fields').disabled, false);
  panel.fill({ headline: 'Example ad' });
  await panel.submit();
  assert.deepEqual(panel.calls.slice(1).map((call) => call.data.requestId), [REQUEST_ID, REQUEST_ID]);
  assert.equal(panel.calls[2].data.headline, 'Example ad');
  assert.equal(panel.at('new').hidden, false);
  await panel.click('new');
  assert.equal(panel.at('fields').disabled, false);
  assert.equal(panel.calls.length, 3);
});

test('no payment order is sent when the browser cannot persist a safe retry', async () => {
  const panel = setup({ save: false, serve: () => response(ACTIVE_OFFERS) });
  await flush();
  panel.fill();
  await panel.submit();
  assert.match(panel.at('apply-message').textContent, /could not save/);
  assert.equal(panel.calls.length, 1);
});

test('saved and bookmarked orders show review and placement statuses while sales are closed', async () => {
  const states = {
    pending: 'Awaiting payment', paid: 'Paid · awaiting manual review', scheduled: 'Approved · scheduled',
    active: 'Live', paused: 'Paused', expired: 'Expired', rejected: 'Rejected',
    review: 'Under review', cancelled: 'Cancelled',
  };
  let status = 'pending';
  const serve = ({ path }) => path === '/offers' ? response({ salesOpen: false, items: [] }) : response(makeOrder({
    status, paid: status !== 'pending', startsAt: '2026-12-01T00:00:00.000Z', endsAt: '2026-12-31T00:00:00.000Z',
  }));
  for (const input of [{ storage: { ...OWNER, [ORDER_KEY]: ORDER_ID } }, { path: `?orderId=${ORDER_ID}#owner-ads` }]) {
    const panel = setup({ ...input, serve });
    await flush();
    assert.equal(panel.root.hidden, false);
    if (input.path) assert.equal(panel.root.scrolled, true);
    assert.equal(panel.at('order-id').value, ORDER_ID);
    assert.equal(panel.at('apply').hidden, true);
    assert.equal(panel.at('price').textContent, '');
    assert.equal(panel.at('pay').hidden, true);
    assert.equal(panel.at('order-amount').textContent, '');
    assert.equal(panel.at('checkout').href, undefined);
    assert.equal(panel.calls[1].path, `/orders/${ORDER_ID}`);
    assert.equal(panel.calls[1].headers.authorization, `Bearer ${TOKEN}`);
    for (const [value, label] of Object.entries(states)) {
      status = value;
      await panel.check();
      assert.equal(panel.at('state').textContent, label);
      assert.match(panel.at('starts').textContent, /Dec 1, 2026.* UTC/);
      assert.match(panel.at('ends').textContent, /Dec 31, 2026.* UTC/);
    }
    await panel.submit();
    assert.ok(panel.calls.every(({ method }) => method === 'GET'));
  }
});

test('malformed or unauthenticated return IDs cannot trigger a status request', async () => {
  const serve = () => response({ salesOpen: false, items: [] });
  const malformed = setup({ path: '?orderId=..%2Foffers#owner-ads', serve });
  const noToken = setup({ storage: {}, path: `?orderId=${ORDER_ID}#owner-ads`, serve });
  await flush();
  assert.equal(malformed.root.hidden, true);
  assert.equal(noToken.at('locked').hidden, false);
  assert.equal(noToken.at('lookup').hidden, true);
  await malformed.check();
  await noToken.check();
  assert.deepEqual(malformed.calls.map(({ path }) => path), ['/offers']);
  assert.deepEqual(noToken.calls.map(({ path }) => path), []);
});

test('checkout only links to an unexpired HTTPS AIPAY order with USDC on Base', async () => {
  for (const patch of [
    { checkoutUrl: 'https://aipay.im.example/checkout' }, { checkoutUrl: 'https://checkout.aipay.im/order' },
    { checkoutUrl: 'https://aipay.im@example.net/' }, { checkoutUrl: 'https://owner@aipay.im/' },
    { checkoutUrl: 'https://aipay.im:444/checkout' }, { checkoutUrl: 'http://aipay.im/checkout' },
    { checkoutUrl: 'blob:https://aipay.im/id' }, { checkoutUrl: 'javascript:void(0)' },
    { checkoutUrl: '//aipay.im/checkout' }, { expiresAt: '2026-11-26T10:59:00.000Z' },
    { paid: true }, { status: 'review' }, { asset: 'ETH' }, { chainKey: 'ethereum' },
  ]) {
    const panel = setup({ path: `?orderId=${ORDER_ID}`, lang: 'zh-CN', serve: ({ path }) => path === '/offers' ?
      response(ACTIVE_OFFERS) : response(makeOrder(patch)) });
    await flush();
    assert.equal(panel.at('apply').hidden, false);
    assert.match(panel.at('price').textContent, /USDC \/ 30 天/);
    assert.equal(panel.at('order').hidden, false);
    assert.equal(panel.at('pay').hidden, true);
    assert.equal(panel.at('checkout').href, undefined);
  }
});

test('a stale open offer disappears immediately when apply reports sales closed', async () => {
  const panel = setup({ serve: ({ path }) => path === '/offers' ? response(ACTIVE_OFFERS) :
    response({ error: 'ads_sales_closed' }, 403) });
  await flush();
  panel.fill();
  await panel.submit();
  assert.equal(panel.at('apply').hidden, true);
  assert.equal(panel.at('price').textContent, '');
  assert.match(panel.at('apply-message').textContent, /sales are currently closed/);
  await panel.submit();
  assert.equal(panel.calls.length, 2);
});
