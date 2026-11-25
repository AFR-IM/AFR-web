// scripts/owner-pro-ui.test.mjs — the Pro panel's client-side state
// machine (apps/web/src/components/detail/OwnerPro.astro).
//
// The panel is the only place where an owner buys a term and watches the
// payment land. Three things break silently there:
//   · the order is created without the management token (the server then
//     answers 401 and the owner sees a dead button),
//   · the poll keeps running after the payment arrived (the panel would
//     keep asking the API for an order that is already settled),
//   · the plaintext of the API key is shown a second time (the server
//     never sends it twice — the panel has to drop it itself).
//
// The script is TypeScript (Astro compiles it), so the types are stripped
// with node:module's stripTypeScriptTypes before the code runs in a VM with
// a small fake DOM.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';

const require = createRequire(import.meta.url);
// The stripper is experimental; its one-time warning would otherwise show up
// in every test run.
const originalEmitWarning = process.emitWarning;
process.emitWarning = () => {};
const { stripTypeScriptTypes } = require('node:module');
process.emitWarning = originalEmitWarning;

const source = readFileSync(
  new URL('../apps/web/src/components/detail/OwnerPro.astro', import.meta.url),
  'utf8',
);
const script = source.match(/<script>\s*([\s\S]*?)<\/script>/)?.[1];
assert.ok(script, 'the Pro panel must carry a client script');

/** The data attributes the panel reads — the server-side copy of them. */
const ATTRS = {
  'data-desc-locked': 'Confirm your owner mailbox above — then Pro can be activated here.',
  'data-desc-loading': 'Reading your Pro status…',
  'data-desc-inactive': 'Pro is not active for this site yet.',
  'data-desc-active': 'Pro is active for this site.',
  'data-tpl-days': '{n} days',
  'data-label-tier': 'tier',
  'data-label-created': 'issued',
  'data-label-used': 'last used',
  'data-msg-never': 'never',
  'data-label-buy': 'Activate Pro',
  'data-label-renew': 'Renew Pro',
  'data-label-buying': 'Creating the order…',
  'data-label-cancel': 'Cancel this order',
  'data-label-cancelling': 'Cancelling…',
  'data-label-issue': 'Issue / rotate the key',
  'data-label-issuing': 'Working…',
  'data-label-revoke': 'Revoke the key',
  'data-label-revoking': 'Revoking…',
  'data-msg-error': 'Could not reach the server — try again.',
  'data-msg-paid': 'Pro is active — the payment landed.',
  'data-msg-cancelled': 'The order was cancelled.',
  'data-msg-cancel-failed': 'This order is already paid — it cannot be cancelled.',
  'data-msg-revoked': 'The key was revoked.',
  'data-msg-polling': 'Waiting for the payment…',
  'data-msg-timeout': 'The payment window closed before the order was paid.',
  'data-msg-key-issued': 'A key is live.',
  'data-msg-key-none': 'No key has been issued for this site yet.',
  'data-msg-locked': 'Confirm your owner mailbox above — then Pro can be activated here.',
  'data-msg-unauthorized': 'The management token is not valid — confirm your owner mailbox again.',
  'data-err-unauthorized': 'The management token is not valid — confirm your owner mailbox again.',
  'data-err-unknown-domain': 'This domain is not listed in AFR yet.',
  'data-err-order-pending': 'There is already an open Pro order for this site — finish or cancel it first.',
  'data-err-billing-not-configured': 'Pro payments are not configured on this deployment yet.',
  'data-err-billing-unavailable': 'The payment provider did not answer — try again in a moment.',
  'data-err-quota-exceeded': 'The quota is exhausted — try again later.',
  'data-err-not-found': 'That order no longer exists.',
  'data-err-invalid-domain': 'This domain is not valid.',
  'data-err-invalid-json': 'The request was malformed.',
  'data-err-api-keys-unavailable': 'API keys are not available on this deployment.',
};

const DOMAIN = 'example.com';
const TOKEN = 'manage-test-token';

function makeElement(selector) {
  const el = {
    selector,
    dataset: {},
    attrs: {},
    value: '',
    checked: false,
    hidden: false,
    open: false,
    disabled: false,
    textContent: '',
    listeners: {},
    getAttribute(name) {
      return name in this.attrs ? this.attrs[name] : null;
    },
    setAttribute(name, value) {
      this.attrs[name] = value;
    },
    addEventListener(type, fn) {
      (this.listeners[type] ||= []).push(fn);
    },
    dispatch(type, event = {}) {
      for (const fn of this.listeners[type] ?? []) fn({ preventDefault() {}, ...event });
    },
    focus() {},
    replaceChildren() {},
    appendChild() {},
    closest() {
      return null;
    },
  };
  return el;
}

/**
 * A panel with the elements the script looks for. The registry is keyed by
 * the exact selector the script uses, so a renamed attribute fails the test
 * instead of silently doing nothing.
 */
function setup({ fetchImpl, storage = {}, hidden = false }) {
  const registry = new Map();
  const states = [];
  for (const state of ['loading', 'locked', 'inactive', 'active']) {
    const el = makeElement(`[data-op-state="${state}"]`);
    el.dataset.opState = state;
    el.hidden = true;
    states.push(el);
    registry.set(`[data-op-state="${state}"]`, el);
  }
  const selectors = [
    '[data-op-desc]',
    '[data-op-expires]',
    '[data-op-term]',
    '[data-op-status]',
    '[data-op-refresh]',
    '[data-op-buy]',
    '[data-op-renew]',
    '[data-op-cancel]',
    '[data-op-order]',
    '[data-op-checkout]',
    '[data-op-keys]',
    '[data-op-key-state]',
    '[data-op-key-plain]',
    '[data-op-key-value]',
    '[data-op-key-issue]',
    '[data-op-key-revoke]',
  ];
  for (const sel of selectors) registry.set(sel, makeElement(sel));

  /* the two copy buttons carry their own labels */
  const copyLink = makeElement('[data-op-copy-link]');
  copyLink.dataset.label = 'Copy';
  copyLink.dataset.done = 'Copied ✓';
  const copyKey = makeElement('[data-op-copy-key]');
  copyKey.dataset.label = 'Copy';
  copyKey.dataset.done = 'Copied ✓';
  registry.set('[data-op-copy-link]', copyLink);
  registry.set('[data-op-copy-key]', copyKey);

  const root = makeElement('[data-owner-pro]');
  root.dataset.domain = DOMAIN;
  for (const [name, value] of Object.entries(ATTRS)) root.attrs[name] = value;
  root.querySelector = (sel) => registry.get(sel) ?? null;
  root.querySelectorAll = (sel) => {
    if (sel === '[data-op-state]') return states;
    if (sel === '[data-op-copy-link]') return [copyLink];
    if (sel === '[data-op-copy-key]') return [copyKey];
    return [];
  };

  const calls = [];
  const store = new Map(Object.entries(storage));

  /* the poll timer is a window timer — the test drives it by hand */
  const timers = new Map();
  let timerId = 0;
  const window = {
    setTimeout(fn) {
      timerId += 1;
      timers.set(timerId, fn);
      return timerId;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
  };

  const doc = {
    hidden,
    handlers: {},
    addEventListener(type, fn) {
      (doc.handlers[type] ||= []).push(fn);
    },
    dispatch(type) {
      for (const fn of doc.handlers[type] ?? []) fn();
    },
    querySelectorAll: (sel) => (sel === '[data-owner-pro]' ? [root] : []),
    querySelector: () => null,
    createElement: () => makeElement('created'),
  };

  const context = {
    URLSearchParams,
    console,
    Date,
    JSON,
    Promise,
    Object,
    Array,
    String,
    Number,
    Boolean,
    Math,
    Error,
    isFinite,
    isNaN,
    parseInt,
    encodeURIComponent,
    decodeURIComponent,
    setTimeout,
    clearTimeout,
    fetch: (url, init) => {
      calls.push({ url, init: init ?? {} });
      return fetchImpl(url, init ?? {}, calls.length - 1);
    },
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: (k) => store.delete(k),
    },
    navigator: { clipboard: { writeText: async () => {} } },
    document: doc,
    window,
  };
  context.globalThis = context;
  runInNewContext(stripTypeScriptTypes(script, { mode: 'strip' }), context);

  /** Run the pending timers one by one (the poll uses one). */
  const runTimers = async () => {
    for (const [id, fn] of [...timers.entries()]) {
      timers.delete(id);
      fn();
      await flush();
    }
  };

  return { root, registry, calls, store, doc, timers, runTimers };
}

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    json: async () => body,
  };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

/** The status answer of a site without Pro and without a key. */
const idleStatus = {
  domain: DOMAIN,
  pro: { active: false, expiresAt: null, termDays: 30, source: null },
  apiKey: null,
};

test('the Pro order is created with the management token', async () => {
  const { registry, calls } = setup({
    storage: { [`afr-owner-mail-${DOMAIN}`]: TOKEN },
    fetchImpl: async (url, init) => {
      if (url.startsWith('/api/v1/pro/status')) return jsonResponse(200, idleStatus);
      if (url === '/api/v1/billing/pro/orders' && init.method === 'POST') {
        return jsonResponse(201, {
          orderId: 'pro-example.com-1',
          reference: 'ref-1',
          checkoutUrl: 'https://checkout.aipay.im/order/ref-1',
          amount: '12',
          asset: 'USDT',
          chainKey: 'base',
          expiresAt: '2026-11-25T10:15:00.000Z',
        });
      }
      return jsonResponse(200, {});
    },
  });
  await flush();

  assert.equal(calls[0].url, `/api/v1/pro/status?domain=${DOMAIN}`);
  assert.equal(calls[0].init.headers.authorization, `Bearer ${TOKEN}`);
  /* the site has no Pro yet */
  assert.equal(registry.get('[data-op-state="inactive"]').hidden, false);

  registry.get('[data-op-buy]').dispatch('click');
  await flush();

  const order = calls.find((c) => c.url === '/api/v1/billing/pro/orders');
  assert.ok(order, 'the order must be created');
  assert.equal(order.init.method, 'POST');
  assert.equal(order.init.headers.authorization, `Bearer ${TOKEN}`);
  assert.deepEqual(JSON.parse(order.init.body), { domain: DOMAIN });

  /* the payment link is shown to the owner */
  assert.equal(registry.get('[data-op-order]').hidden, false);
  assert.equal(
    registry.get('[data-op-checkout]').getAttribute('href'),
    'https://checkout.aipay.im/order/ref-1',
  );
});

test('the poll switches the panel to "Pro is active" when the order is paid', async () => {
  let orderPaid = false;
  const { registry, calls, runTimers } = setup({
    storage: { [`afr-owner-mail-${DOMAIN}`]: TOKEN },
    fetchImpl: async (url, init) => {
      if (url.startsWith('/api/v1/pro/status')) {
        return jsonResponse(200, {
          domain: DOMAIN,
          pro: {
            active: orderPaid,
            expiresAt: orderPaid ? '2026-12-25T00:00:00.000Z' : null,
            termDays: 30,
            source: orderPaid ? 'ref-1' : null,
          },
          apiKey: null,
        });
      }
      if (url === '/api/v1/billing/pro/orders' && init.method === 'POST') {
        return jsonResponse(201, {
          orderId: 'pro-example.com-1',
          reference: 'ref-1',
          checkoutUrl: 'https://checkout.aipay.im/order/ref-1',
          amount: '12',
          asset: 'USDT',
          chainKey: 'base',
          expiresAt: '2026-11-25T10:15:00.000Z',
        });
      }
      if (url.startsWith('/api/v1/billing/pro/orders/') && !url.endsWith('/cancel')) {
        return jsonResponse(200, {
          reference: 'ref-1',
          orderId: 'pro-example.com-1',
          status: orderPaid ? 'confirmed' : 'pending',
          paid: orderPaid,
          amount: '12',
          asset: 'USDT',
          chainKey: 'base',
          expiresAt: '2026-11-25T10:15:00.000Z',
          pro: { active: orderPaid, expiresAt: orderPaid ? '2026-12-25T00:00:00.000Z' : null },
        });
      }
      return jsonResponse(200, {});
    },
  });
  await flush();

  registry.get('[data-op-buy]').dispatch('click');
  await flush();
  assert.equal(registry.get('[data-op-state="active"]').hidden, true);

  /* the payment lands */
  orderPaid = true;
  await runTimers();

  const poll = calls.find((c) => c.url.startsWith('/api/v1/billing/pro/orders/ref-1'));
  assert.ok(poll, 'the order must be polled');
  assert.equal(poll.init.headers.authorization, `Bearer ${TOKEN}`);

  assert.equal(registry.get('[data-op-state="active"]').hidden, false);
  assert.equal(registry.get('[data-op-expires]').textContent, '2026-12-25');
  assert.equal(registry.get('[data-op-term]').textContent, '30 days');
  assert.equal(registry.get('[data-op-status]').textContent, 'Pro is active — the payment landed.');
  /* the settled order is not polled forever */
  assert.equal(registry.get('[data-op-order]').hidden, true);
});

test('a hidden tab does not poll the order', async () => {
  const { registry, calls, doc, runTimers } = setup({
    storage: { [`afr-owner-mail-${DOMAIN}`]: TOKEN },
    fetchImpl: async (url, init) => {
      if (url.startsWith('/api/v1/pro/status')) return jsonResponse(200, idleStatus);
      if (url === '/api/v1/billing/pro/orders' && init.method === 'POST') {
        return jsonResponse(201, {
          orderId: 'pro-example.com-1',
          reference: 'ref-1',
          checkoutUrl: 'https://checkout.aipay.im/order/ref-1',
          amount: '12',
          asset: 'USDT',
          chainKey: 'base',
          expiresAt: '2026-11-25T10:15:00.000Z',
        });
      }
      if (url.startsWith('/api/v1/billing/pro/orders/')) {
        return jsonResponse(200, {
          reference: 'ref-1',
          orderId: 'pro-example.com-1',
          status: 'pending',
          paid: false,
          amount: '12',
          asset: 'USDT',
          chainKey: 'base',
          expiresAt: '2026-11-25T10:15:00.000Z',
          pro: { active: false, expiresAt: null },
        });
      }
      return jsonResponse(200, {});
    },
  });
  await flush();

  registry.get('[data-op-buy]').dispatch('click');
  await flush();

  /* the tab goes to the background: the poll is paused */
  doc.hidden = true;
  doc.dispatch('visibilitychange');
  await runTimers();
  assert.equal(
    calls.filter((c) => c.url.startsWith('/api/v1/billing/pro/orders/ref-1')).length,
    0,
    'a hidden tab must not poll',
  );

  /* and it resumes when the owner comes back */
  doc.hidden = false;
  doc.dispatch('visibilitychange');
  await runTimers();
  assert.equal(
    calls.filter((c) => c.url.startsWith('/api/v1/billing/pro/orders/ref-1')).length,
    1,
    'the poll resumes when the tab is visible again',
  );
});

test('the plaintext of the API key is shown exactly once', async () => {
  const { registry, calls } = setup({
    storage: { [`afr-owner-mail-${DOMAIN}`]: TOKEN },
    fetchImpl: async (url, init) => {
      if (url.startsWith('/api/v1/pro/status')) return jsonResponse(200, idleStatus);
      if (url === '/api/v1/pro/api-key' && init.method === 'POST') {
        return jsonResponse(201, { key: 'afr_0123456789abcdef', tier: 'pro', createdAt: '2026-11-25T10:00:00.000Z' });
      }
      return jsonResponse(200, {});
    },
  });
  await flush();

  registry.get('[data-op-key-issue]').dispatch('click');
  await flush();

  const issue = calls.find((c) => c.url === '/api/v1/pro/api-key');
  assert.ok(issue, 'the key must be issued');
  assert.equal(issue.init.method, 'POST');
  assert.equal(issue.init.headers.authorization, `Bearer ${TOKEN}`);
  assert.deepEqual(JSON.parse(issue.init.body), { domain: DOMAIN });

  assert.equal(registry.get('[data-op-key-plain]').hidden, false);
  assert.equal(registry.get('[data-op-key-value]').textContent, 'afr_0123456789abcdef');

  /* the next status read drops the plaintext — the server never sends it
     twice, and the panel must not keep it on screen either */
  registry.get('[data-op-refresh]').dispatch('click');
  await flush();

  assert.equal(registry.get('[data-op-key-plain]').hidden, true);
  assert.equal(registry.get('[data-op-key-value]').textContent, '');
});

test('the open order can be cancelled', async () => {
  const { registry, calls } = setup({
    storage: { [`afr-owner-mail-${DOMAIN}`]: TOKEN },
    fetchImpl: async (url, init) => {
      if (url.startsWith('/api/v1/pro/status')) return jsonResponse(200, idleStatus);
      if (url === '/api/v1/billing/pro/orders' && init.method === 'POST') {
        return jsonResponse(201, {
          orderId: 'pro-example.com-1',
          reference: 'ref-1',
          checkoutUrl: 'https://checkout.aipay.im/order/ref-1',
          amount: '12',
          asset: 'USDT',
          chainKey: 'base',
          expiresAt: '2026-11-25T10:15:00.000Z',
        });
      }
      if (url.endsWith('/cancel')) return jsonResponse(200, { cancelled: true });
      return jsonResponse(200, {});
    },
  });
  await flush();

  registry.get('[data-op-buy]').dispatch('click');
  await flush();

  registry.get('[data-op-cancel]').dispatch('click');
  await flush();

  const cancel = calls.find((c) => c.url.endsWith('/cancel'));
  assert.ok(cancel, 'the order must be cancelled');
  assert.equal(cancel.init.method, 'POST');
  assert.equal(cancel.init.headers.authorization, `Bearer ${TOKEN}`);
  assert.equal(registry.get('[data-op-order]').hidden, true);
  assert.equal(registry.get('[data-op-status]').textContent, 'The order was cancelled.');
});

test('a running Pro can be renewed', async () => {
  const { registry, calls } = setup({
    storage: { [`afr-owner-mail-${DOMAIN}`]: TOKEN },
    fetchImpl: async (url, init) => {
      if (url.startsWith('/api/v1/pro/status')) {
        return jsonResponse(200, {
          domain: DOMAIN,
          pro: { active: true, expiresAt: '2026-12-25T00:00:00.000Z', termDays: 30, source: 'ref-0' },
          apiKey: null,
        });
      }
      if (url === '/api/v1/billing/pro/orders' && init.method === 'POST') {
        return jsonResponse(201, {
          orderId: 'pro-example.com-2',
          reference: 'ref-2',
          checkoutUrl: 'https://checkout.aipay.im/order/ref-2',
          amount: '12',
          asset: 'USDT',
          chainKey: 'base',
          expiresAt: '2026-11-25T10:15:00.000Z',
        });
      }
      return jsonResponse(200, {});
    },
  });
  await flush();

  assert.equal(registry.get('[data-op-state="active"]').hidden, false);
  assert.equal(registry.get('[data-op-renew]').hidden, false);

  registry.get('[data-op-renew]').dispatch('click');
  await flush();

  const order = calls.find((c) => c.url === '/api/v1/billing/pro/orders');
  assert.ok(order, 'the renewal must create an order');
  assert.equal(order.init.headers.authorization, `Bearer ${TOKEN}`);
  assert.equal(registry.get('[data-op-checkout]').getAttribute('href'), 'https://checkout.aipay.im/order/ref-2');
});

test('the error codes of the billing endpoints are turned into sentences', async () => {
  const { registry } = setup({
    storage: { [`afr-owner-mail-${DOMAIN}`]: TOKEN },
    fetchImpl: async (url, init) => {
      if (url.startsWith('/api/v1/pro/status')) return jsonResponse(200, idleStatus);
      if (url === '/api/v1/billing/pro/orders' && init.method === 'POST') {
        return jsonResponse(409, { error: 'order_pending' });
      }
      return jsonResponse(200, {});
    },
  });
  await flush();

  registry.get('[data-op-buy]').dispatch('click');
  await flush();

  assert.equal(
    registry.get('[data-op-status]').textContent,
    'There is already an open Pro order for this site — finish or cancel it first.',
  );
  assert.equal(registry.get('[data-op-status]').dataset.tone, 'error');
  /* the button is usable again */
  assert.equal(registry.get('[data-op-buy]').disabled, false);
});

test('without a management token the panel shows no buttons', async () => {
  const { registry, calls } = setup({
    fetchImpl: async () => jsonResponse(200, idleStatus),
  });
  await flush();

  assert.equal(registry.get('[data-op-state="locked"]').hidden, false);
  assert.equal(registry.get('[data-op-state="inactive"]').hidden, true);
  assert.equal(calls.length, 0, 'no request without a token');
});
