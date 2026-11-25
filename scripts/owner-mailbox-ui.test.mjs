// scripts/owner-mailbox-ui.test.mjs — the owner panel's client-side state
// machine (apps/web/src/components/detail/OwnerMailbox.astro).
//
// The panel is the only place where an owner can ask for a lost management
// token (POST /owners/email/recover) or unregister the mailbox
// (DELETE /owners/email?domain=). Both are easy to break silently: the
// panel would keep asking the registration endpoint, or would delete with
// the wrong credential — and no HTTP-level test of the worker would notice.
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
  new URL('../apps/web/src/components/detail/OwnerMailbox.astro', import.meta.url),
  'utf8',
);
const script = source.match(/<script>\s*([\s\S]*?)<\/script>/)?.[1];
assert.ok(script, 'the owner panel must carry a client script');

/** The data attributes the panel reads — the server-side copy of them. */
const ATTRS = {
  'data-label-idle': 'Start verification',
  'data-label-busy': 'Starting…',
  'data-label-recover-start': 'Start recovery',
  'data-label-check': 'I published it — check now',
  'data-label-checking': 'Checking…',
  'data-label-delete': 'Delete the mailbox',
  'data-label-delete-busy': 'Deleting…',
  'data-desc-register': 'Register the mailbox',
  'data-desc-recover': 'Recover a lost management token',
  'data-sent-title': 'Confirmation mail sent',
  'data-sent-body': 'Open the link in the mail.',
  'data-sent-title-recover': 'Recovery mail sent',
  'data-sent-body-recover': 'Open the recovery link in the mail.',
  'data-msg-error': 'Could not reach the server — try again.',
  'data-msg-deleted': 'The mailbox was deleted.',
  'data-msg-token-invalid': 'This management token is not valid.',
  'data-msg-recover-token-saved': 'The new management token is saved in this browser.',
  'data-err-unauthorized': 'The management token is not valid.',
  'data-err-invalid-email': 'Please enter a valid email address.',
  'data-err-invalid-challenge': 'This challenge is missing or malformed.',
  'data-err-recovery-token': 'This recovery token is invalid or already used.',
  'data-err-recovery-unavailable': 'This domain has no confirmed mailbox.',
  'data-err-turnstile': 'Human verification failed — please try again.',
  'data-err-turnstile-required': 'Please complete the human verification, then try again.',
  'data-err-turnstile-unavailable': 'The human check could not be loaded.',
  'data-err-delivery': 'The confirmation email could not be sent.',
  'data-err-not-configured': 'The owner-mail feature is not configured.',
  'data-err-domain-control': 'AFR does not see the challenge on your domain yet.',
  'data-err-unknown-domain': 'This domain is not listed in AFR yet.',
  'data-err-mailbox-verified': 'This domain already has a confirmed mailbox.',
  'data-err-same-email': 'This is already the registered mailbox.',
  'data-err-rate-limited': 'Too many attempts — try again later.',
  'data-err-invalid-domain': 'This domain cannot be registered.',
  'data-err-invalid-challenge-not-found': 'Unknown challenge.',
};

const DOMAIN = 'example.com';

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
function setup({ fetchImpl, storage = {} }) {
  const registry = new Map();
  const states = [];
  for (const state of ['idle', 'challenge', 'sent', 'verified', 'loading']) {
    const el = makeElement(`[data-om-state="${state}"]`);
    el.dataset.omState = state;
    el.hidden = state !== 'idle';
    states.push(el);
    registry.set(`[data-om-state="${state}"]`, el);
  }
  const selectors = [
    '[data-om-form]',
    '[data-om-email]',
    '[data-om-start]',
    '[data-om-lost]',
    '[data-om-check]',
    '[data-om-reset]',
    '[data-om-signout]',
    '[data-om-token-use]',
    '[data-om-token]',
    '[data-om-notify]',
    '[data-om-change-box]',
    '[data-om-change-form]',
    '[data-om-change-email]',
    '[data-om-change-submit]',
    '[data-om-masked]',
    '[data-om-checks]',
    '[data-om-check-list]',
    '[data-om-status]',
    '[data-om-turnstile]',
    '[data-om-desc]',
    '[data-om-sent-title]',
    '[data-om-sent-body]',
    '[data-om-delete]',
    '[data-om-recover-token-use]',
    '[data-om-recover-token]',
  ];
  for (const sel of selectors) registry.set(sel, makeElement(sel));

  const root = makeElement('[data-owner-mailbox]');
  root.dataset.domain = DOMAIN;
  root.dataset.action = 'afr_owner_email';
  for (const [name, value] of Object.entries(ATTRS)) root.attrs[name] = value;
  root.querySelector = (sel) => registry.get(sel) ?? null;
  root.querySelectorAll = (sel) => (sel === '[data-om-state]' ? states : []);

  const calls = [];
  const store = new Map(Object.entries(storage));
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
    document: {
      querySelectorAll: (sel) => (sel === '[data-owner-mailbox]' ? [root] : []),
      querySelector: () => null,
      createElement: () => makeElement('created'),
    },
    window: {
      setInterval: () => 0,
      clearInterval: () => {},
      setTimeout: () => 0,
      clearTimeout: () => {},
    },
  };
  context.globalThis = context;
  runInNewContext(stripTypeScriptTypes(script, { mode: 'strip' }), context);

  return { root, registry, calls, store };
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

test('the lost-token button switches the panel into the recovery mode', async () => {
  const { registry, calls } = setup({
    fetchImpl: async (url) => {
      if (url === '/api/v1/owners/email/start') {
        return jsonResponse(200, { challenge: 'ch-test', methods: {} });
      }
      return jsonResponse(200, { emailed: true });
    },
  });

  registry.get('[data-om-lost]').dispatch('click');
  assert.equal(registry.get('[data-om-desc]').textContent, 'Recover a lost management token');
  assert.equal(registry.get('[data-om-start]').textContent, 'Start recovery');

  registry.get('[data-om-email]').value = 'owner@example.com';
  registry.get('[data-om-form]').dispatch('submit');
  await flush();

  assert.equal(calls[0].url, '/api/v1/owners/email/start');
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    domain: DOMAIN,
    email: 'owner@example.com',
    turnstile_token: '',
  });

  registry.get('[data-om-check]').dispatch('click');
  await flush();

  /* the recovery must go to the recovery endpoint, not to the registration
     one — the registration would answer "mailbox_already_verified" */
  assert.equal(calls[1].url, '/api/v1/owners/email/recover');
  assert.deepEqual(JSON.parse(calls[1].init.body), {
    domain: DOMAIN,
    email: 'owner@example.com',
    challenge: 'ch-test',
    turnstile_token: '',
  });
  /* the mail-sent state speaks about the recovery */
  assert.equal(registry.get('[data-om-sent-title]').textContent, 'Recovery mail sent');
  assert.equal(registry.get('[data-om-sent-body]').textContent, 'Open the recovery link in the mail.');
});

test('without the lost-token button the panel registers a mailbox', async () => {
  const { registry, calls } = setup({
    fetchImpl: async (url) => {
      if (url === '/api/v1/owners/email/start') {
        return jsonResponse(200, { challenge: 'ch-test', methods: {} });
      }
      return jsonResponse(200, { emailed: true });
    },
  });

  registry.get('[data-om-email]').value = 'owner@example.com';
  registry.get('[data-om-form]').dispatch('submit');
  await flush();
  registry.get('[data-om-check]').dispatch('click');
  await flush();

  assert.equal(calls[1].url, '/api/v1/owners/email');
  assert.equal(registry.get('[data-om-sent-title]').textContent, 'Confirmation mail sent');
});

test('unregistering the mailbox presents the management token and drops it', async () => {
  const tokenKey = `afr-owner-mail-${DOMAIN}`;
  const { registry, calls, store } = setup({
    storage: { [tokenKey]: 'manage-test-token' },
    fetchImpl: async (url, init) => {
      if (init.method === 'DELETE') return jsonResponse(200, { deleted: true });
      if (url.startsWith('/api/v1/owners/email?')) {
        return jsonResponse(200, { email_masked: 'o***@example.com', verified: true, notify: true });
      }
      return jsonResponse(200, {});
    },
  });
  await flush();

  /* the panel restored the confirmed state from the token in localStorage */
  assert.equal(calls[0].url, `/api/v1/owners/email?domain=${DOMAIN}`);
  assert.equal(calls[0].init.headers.authorization, 'Bearer manage-test-token');

  registry.get('[data-om-delete]').dispatch('click');
  await flush();

  const del = calls.find((c) => c.init.method === 'DELETE');
  assert.ok(del, 'the delete request must be sent');
  assert.equal(del.url, `/api/v1/owners/email?domain=${DOMAIN}`);
  assert.equal(del.init.headers.authorization, 'Bearer manage-test-token');
  assert.equal(store.get(tokenKey), undefined, 'the token must not stay in this browser');
  assert.equal(registry.get('[data-om-status]').textContent, 'The mailbox was deleted.');
});

test('the token of a recovery mail is redeemed for a new management token', async () => {
  const tokenKey = `afr-owner-mail-${DOMAIN}`;
  const { registry, calls, store } = setup({
    fetchImpl: async (url) => {
      if (url.startsWith('/api/v1/owners/email/recover/verify')) {
        return jsonResponse(200, { verified: true, domain: DOMAIN, manageToken: 'manage-new-token' });
      }
      return jsonResponse(200, { email_masked: 'o***@example.com', verified: true, notify: true });
    },
  });

  registry.get('[data-om-recover-token]').value = 'recovery-token';
  registry.get('[data-om-recover-token-use]').dispatch('click');
  await flush();

  assert.equal(calls[0].url, '/api/v1/owners/email/recover/verify?token=recovery-token');
  assert.equal(store.get(tokenKey), 'manage-new-token');
  assert.equal(registry.get('[data-om-status]').textContent, 'The new management token is saved in this browser.');
});
