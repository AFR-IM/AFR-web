// scripts/pro-perks-ui.test.mjs — the client scripts of three Pro-facing
// details of the owner workspace:
//
//   ClaimForm     — the statement ceiling follows the Pro term (200 → 600);
//                   hardcoding 200 back would silently truncate Pro copy.
//   RescanButton  — the management token rides along (the server's Pro
//                   priority path only exists for a token), and a priority
//                   answer says so instead of looking like the free path.
//   ClaimBlock    — http(s) links inside a published statement render as
//                   links, trailing sentence punctuation stays text, and
//                   nothing but a URL match can become a link.
//
// The scripts are TypeScript (Astro compiles them) and the ClaimBlock logic
// lives in the component's frontmatter, so both are stripped with node:module's
// stripTypeScriptTypes before running in a VM with a small fake DOM.

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

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');
const scriptOf = (source) => {
  const script = source.match(/<script>\s*([\s\S]*?)<\/script>/)?.[1];
  assert.ok(script, 'the component must carry a client script');
  return script;
};

const DOMAIN = 'example.com';
const TOKEN = 'fixture-manage-token';

function makeElement(selector = 'el') {
  const el = {
    selector,
    dataset: {},
    attrs: {},
    value: '',
    hidden: false,
    disabled: false,
    maxLength: 200,
    textContent: '',
    children: [],
    listeners: {},
    getAttribute(name) {
      return name in this.attrs ? this.attrs[name] : null;
    },
    setAttribute(name, value) {
      this.attrs[name] = value;
      if (name === 'data-you') this.dataset.you = value;
    },
    addEventListener(type, fn) {
      (this.listeners[type] ||= []).push(fn);
    },
    dispatch(type, event = {}) {
      for (const fn of this.listeners[type] ?? []) fn({ preventDefault() {}, ...event });
    },
    appendChild(child) {
      this.children.push(child);
      return child;
    },
    querySelector() {
      return null;
    },
    focus() {},
    removeAttribute(name) {
      delete this.attrs[name];
    },
  };
  return el;
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

// ---------------------------------------------------------------------------
// ClaimForm — the statement ceiling
// ---------------------------------------------------------------------------

function setupClaimForm({ proActive, withToken = true }) {
  const source = read('../apps/web/src/components/detail/ClaimForm.astro');
  const script = scriptOf(source);

  const form = makeElement('[data-claim-form]');
  form.dataset.domain = DOMAIN;
  for (const [name, value] of Object.entries({
    'data-label-idle': 'Submit statement',
    'data-label-busy': 'Submitting…',
    'data-done': 'Submitted',
    'data-not-verified': 'Verify first',
    'data-invalid': 'Please write a statement',
    'data-error': 'Could not submit',
    'data-unauthorized': 'Confirm the mailbox first',
  })) {
    form.attrs[name] = value;
  }
  const input = makeElement('textarea');
  input.value = '';
  const count = makeElement('[data-claim-count]');
  const btn = makeElement('[data-claim-submit]');
  const status = makeElement('[data-claim-status]');
  const hint = makeElement('[data-claim-hint]');
  const hintText = makeElement('[data-claim-hint-text]');
  const verify = makeElement('[data-claim-verify-link]');
  const mailbox = makeElement('[data-claim-mailbox-link]');
  const doneBox = makeElement('[data-claim-done]');
  const bySelector = new Map([
    ['textarea[name="statement"]', input],
    ['[data-claim-count]', count],
    ['[data-claim-submit]', btn],
    ['[data-claim-status]', status],
    ['[data-claim-hint]', hint],
    ['[data-claim-hint-text]', hintText],
    ['[data-claim-verify-link]', verify],
    ['[data-claim-mailbox-link]', mailbox],
  ]);
  form.querySelector = (sel) => bySelector.get(sel) ?? null;

  const calls = [];
  const store = new Map();
  if (withToken) store.set(`afr-owner-mail-${DOMAIN}`, TOKEN);

  const context = {
    console,
    Promise,
    Object,
    Array,
    String,
    Number,
    Boolean,
    Math,
    Error,
    isFinite,
    encodeURIComponent,
    setTimeout,
    clearTimeout,
    fetch: (url, init) => {
      calls.push({ url: String(url), init: init ?? {} });
      if (String(url).includes('/api/v1/pro/status')) {
        return Promise.resolve(jsonResponse(200, { pro: { active: proActive } }));
      }
      return Promise.resolve(jsonResponse(201, { status: 'pending' }));
    },
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: (k) => store.delete(k),
    },
    document: {
      querySelectorAll: (sel) => (sel === '[data-claim-form]' ? [form] : []),
      querySelector: (sel) => (sel === '[data-claim-done]' ? doneBox : null),
      createElement: () => makeElement('created'),
    },
    window: { setTimeout: () => 0, clearTimeout: () => {}, setInterval: () => 0, clearInterval: () => {} },
  };
  context.globalThis = context;
  runInNewContext(stripTypeScriptTypes(script, { mode: 'strip' }), context);
  return { form, input, count, btn, status, calls, store };
}

test('an active Pro term raises the statement ceiling to 600', async () => {
  const { input, count, calls } = setupClaimForm({ proActive: true });
  await flush();
  assert.ok(
    calls.some((c) => c.url.includes('/api/v1/pro/status')),
    'the form asks the Pro status with the stored token',
  );
  assert.equal(input.maxLength, 600);
  assert.equal(count.textContent, '0/600');
});

test('a free term keeps the 200 ceiling', async () => {
  const { input, count } = setupClaimForm({ proActive: false });
  await flush();
  assert.equal(input.maxLength, 200);
  assert.equal(count.textContent, '0/200');
});

test('without a token the form keeps the free ceiling and never calls the API', async () => {
  const { input, calls } = setupClaimForm({ proActive: true, withToken: false });
  await flush();
  assert.equal(input.maxLength, 200);
  assert.equal(calls.length, 0);
});

// ---------------------------------------------------------------------------
// RescanButton — the token rides along, the priority answer says so
// ---------------------------------------------------------------------------

function setupRescan({ storedToken }) {
  const source = read('../apps/web/src/components/detail/RescanButton.astro');
  const script = scriptOf(source);

  const btn = makeElement('[data-rescan]');
  btn.dataset.domain = DOMAIN;
  btn.dataset.scannedAt = '2026-11-20T10:00:00.000Z';
  btn.dataset.score = '92';
  for (const [name, value] of Object.entries({
    'data-label': 'Re-scan',
    'data-tpl-queued': 'queued · ~{n} min',
    'data-polling': 'polling',
    'data-updated': 'updated ✓',
    'data-timeout': 'timeout',
    'data-tpl-throttle': 'next in {t}',
    'data-unknown': 'unknown',
    'data-error': 'error',
    'data-quota': 'quota',
    'data-priority': 'Pro priority · drained first',
  })) {
    btn.attrs[name] = value;
  }
  const txt = makeElement('.txt');
  btn.querySelector = (sel) => (sel === '.txt' ? txt : null);
  const sub = makeElement('[data-rescan-sub]');
  const ring = makeElement('[data-ring-count]');
  const parent = makeElement('wrap');
  parent.querySelector = (sel) => (sel === '[data-rescan-sub]' ? sub : null);
  btn.parentElement = parent;

  const calls = [];
  const store = new Map();
  if (storedToken) store.set(`afr-owner-mail-${DOMAIN}`, storedToken);

  const context = {
    console,
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
    Date,
    setTimeout,
    clearTimeout,
    fetch: (url, init) => {
      calls.push({ url: String(url), init: init ?? {} });
      if (String(url) === '/api/v1/rescan') {
        return Promise.resolve(
          jsonResponse(200, { status: 'queued', priority: storedToken ? 1 : 0, etaSeconds: 180 }),
        );
      }
      return Promise.resolve(jsonResponse(200, { scannedAt: '2026-11-26T00:00:00.000Z', score: 92 }));
    },
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: (k) => store.delete(k),
    },
    document: {
      querySelectorAll: (sel) => (sel === '[data-rescan]' ? [btn] : []),
      querySelector: (sel) => (sel === '[data-ring-count]' ? ring : null),
      createElement: () => makeElement('created'),
    },
    window: { setTimeout: () => 0, clearTimeout: () => {}, setInterval: () => 0, clearInterval: () => {} },
  };
  context.globalThis = context;
  runInNewContext(stripTypeScriptTypes(script, { mode: 'strip' }), context);
  return { btn, sub, calls, store };
}

test('the rescan request carries the management token and says when it is priority', async () => {
  const { btn, sub, calls } = setupRescan({ storedToken: TOKEN });
  btn.dispatch('click');
  await flush();

  const post = calls.find((c) => c.url === '/api/v1/rescan');
  assert.ok(post, 'the button called the API');
  assert.equal(post.init.headers.authorization, `Bearer ${TOKEN}`, 'the token rides along');
  assert.match(sub.textContent, /Pro priority/, 'the owner sees the priority path');
});

test('without a stored token the request is the plain free one', async () => {
  const { btn, sub, calls } = setupRescan({ storedToken: null });
  btn.dispatch('click');
  await flush();

  const post = calls.find((c) => c.url === '/api/v1/rescan');
  assert.ok(post);
  assert.equal(post.init.headers.authorization, undefined);
  assert.ok(!sub.textContent.includes('Pro priority'), 'no priority claim on the free path');
});

// ---------------------------------------------------------------------------
// ClaimBlock — link rendering of a published statement
// ---------------------------------------------------------------------------

function loadStatementParts() {
  const source = read('../apps/web/src/components/detail/ClaimBlock.astro');
  const frontmatter = source.match(/^---\s*([\s\S]*?)\n---/)?.[1];
  assert.ok(frontmatter, 'the component must carry frontmatter');
  const snippet = frontmatter.match(/const LINK_RE =[\s\S]*?return parts;\n}/)?.[0];
  assert.ok(snippet, 'the statement splitter must exist in the frontmatter');
  const context = { String, Array, Object, RegExp };
  context.globalThis = context;
  runInNewContext(stripTypeScriptTypes(snippet, { mode: 'strip' }), context);
  return context.statementParts;
}

test('only an http(s) URL becomes a link, and sentence punctuation stays text', () => {
  const parts = loadStatementParts();
  const out = parts('Policy: see https://afr.im/docs. We answer there.');
  // JSON round-trip: the parts are built in the VM realm, and deepStrictEqual
  // would compare prototypes across realms.
  assert.deepEqual(JSON.parse(JSON.stringify(out)), [
    'Policy: see ',
    { href: 'https://afr.im/docs' },
    '.',
    ' We answer there.',
  ]);
});

test('a statement without URLs is one plain chunk (Astro escapes it)', () => {
  const parts = loadStatementParts();
  const out = parts('<img src=x onerror=alert(1)> — no link here');
  assert.equal(out.length, 1);
  assert.equal(typeof out[0], 'string');
  assert.equal(out[0], '<img src=x onerror=alert(1)> — no link here');
  assert.ok(
    out.every((p) => typeof p === 'string'),
    'markup in the text never becomes a node — it stays escaped text',
  );
});

test('several links split the statement without losing bytes', () => {
  const parts = loadStatementParts();
  const text = 'A https://a.example/x and B https://b.example/y?z=1 end';
  const out = parts(text);
  assert.deepEqual(JSON.parse(JSON.stringify(out)), [
    'A ',
    { href: 'https://a.example/x' },
    ' and B ',
    { href: 'https://b.example/y?z=1' },
    ' end',
  ]);
  const rejoined = out.map((p) => (typeof p === 'string' ? p : p.href)).join('');
  assert.equal(rejoined, text, 'no byte of the reviewed statement is lost');
});
