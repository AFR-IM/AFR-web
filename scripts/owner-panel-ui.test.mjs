// scripts/owner-panel-ui.test.mjs — the client scripts of the two new Pro
// surfaces in the owner workspace:
//
//   owner/index.astro — the multi-domain panel: one stored management token
//                       expands to every domain of the same mailbox address,
//                       rows render as text only, a pasted token is kept
//                       under the domain it proves, stale tokens say so.
//   OwnerCompare      — the competitor comparison gate: no token → hint,
//                       free tier → the benefit described, Pro → the load
//                       button → the category table with the owner row
//                       highlighted.
//
// Both scripts are TypeScript (Astro compiles them): types are stripped with
// node:module's stripTypeScriptTypes, then the code runs in a VM with a
// small fake DOM.

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
    textContent: '',
    children: [],
    listeners: {},
    href: '',
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
    appendChild(child) {
      this.children.push(child);
      return child;
    },
    querySelector() {
      return null;
    },
    focus() {},
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

/** A localStorage whose enumeration (length / key) also works — the panel
 * walks the whole storage to find its tokens. */
function makeStorage(entries = {}) {
  const store = new Map(Object.entries(entries));
  return {
    store,
    get length() {
      return store.size;
    },
    key: (i) => [...store.keys()][i] ?? null,
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  };
}

// ---------------------------------------------------------------------------
// The multi-domain panel (owner/index.astro)
// ---------------------------------------------------------------------------

function setupPanel({ storage = {}, domainsResponse, status = 200 }) {
  const source = read('../apps/web/src/pages/[...locale]/owner/index.astro');
  const script = scriptOf(source);

  const page = makeElement('[data-owner-panel]');
  page.dataset.base = '';
  for (const [name, value] of Object.entries({
    'data-label-use': 'Open panel',
    'data-msg-using': 'Reading…',
    'data-msg-empty': 'No token yet',
    'data-msg-error': 'Could not read that token',
    'data-msg-stale': 'Stored tokens no longer work',
    'data-col-site': 'Site',
    'data-col-grade': 'Rating',
    'data-col-pro': 'Pro',
    'data-col-notify': 'Alerts',
    'data-pro-on': 'active',
    'data-pro-off': '—',
    'data-notify-on': 'on',
    'data-notify-off': 'muted',
    'data-open': 'Open workspace',
    'data-bind': 'Bind this site',
    'data-delisted': 'retired',
    'data-status-error': 'Some sites could not be read',
  })) {
    page.attrs[name] = value;
  }

  const statusEl = makeElement('[data-panel-status]');
  const tableWrap = makeElement('[data-panel-table]');
  tableWrap.hidden = true;
  const tbody = makeElement('[data-panel-body]');
  const emptyEl = makeElement('[data-panel-empty]');
  const form = makeElement('[data-token-form]');
  const input = makeElement('input');
  const submit = makeElement('[data-token-submit]');
  const bySelector = new Map([
    ['[data-panel-status]', statusEl],
    ['[data-panel-table]', tableWrap],
    ['[data-panel-body]', tbody],
    ['[data-panel-empty]', emptyEl],
    ['[data-token-form]', form],
    ['input[name="token"]', input],
    ['[data-token-submit]', submit],
  ]);
  page.querySelector = (sel) => bySelector.get(sel) ?? null;

  const calls = [];
  const local = makeStorage(storage);
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
    Map,
    Set,
    isFinite,
    encodeURIComponent,
    setTimeout,
    clearTimeout,
    fetch: (url, init) => {
      calls.push({ url: String(url), init: init ?? {} });
      return Promise.resolve(jsonResponse(status, domainsResponse));
    },
    localStorage: local,
    document: {
      querySelector: (sel) => (sel === '[data-owner-panel]' ? page : null),
      querySelectorAll: (sel) => (sel === '[data-owner-panel]' ? [page] : []),
      createElement: () => makeElement('created'),
    },
    window: { setTimeout: () => 0, clearTimeout: () => {}, setInterval: () => 0, clearInterval: () => {} },
  };
  context.globalThis = context;
  runInNewContext(stripTypeScriptTypes(script, { mode: 'strip' }), context);
  return { page, statusEl, tableWrap, tbody, emptyEl, form, input, calls, local };
}

const PANEL_ANSWER = {
  primary: DOMAIN,
  domains: [
    {
      domain: 'coolsite.io',
      title: 'Coolsite',
      grade: 'B',
      score: 78,
      status: 'active',
      notify: true,
      pro: { active: false, expiresAt: null },
    },
    {
      domain: DOMAIN,
      title: 'Example',
      grade: 'A',
      score: 92,
      status: 'active',
      notify: false,
      pro: { active: true, expiresAt: '2026-12-20T00:00:00.000Z' },
    },
  ],
};

test('one stored token expands to every domain of the same mailbox address', async () => {
  const { tableWrap, tbody, calls, statusEl } = setupPanel({
    storage: { [`afr-owner-mail-${DOMAIN}`]: TOKEN },
    domainsResponse: PANEL_ANSWER,
  });
  await flush();

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, '/api/v1/owners/domains');
  assert.equal(calls[0].init.headers.authorization, `Bearer ${TOKEN}`);
  assert.equal(tableWrap.hidden, false, 'the table appears');
  assert.equal(statusEl.textContent, '', 'no status noise on success');
  assert.equal(tbody.children.length, 2, 'both domains of the address');

  const [first, second] = tbody.children;
  // rows: site cell, grade, pro, notify, action
  assert.equal(first.children.length, 5);
  const siteCell = first.children[0].children[0];
  assert.equal(siteCell.children[0].textContent, 'coolsite.io');
  assert.equal(siteCell.children[1].textContent, 'Coolsite', 'the title rides along');
  assert.equal(first.children[1].textContent, 'B · 78');
  assert.equal(first.children[2].children[0].textContent, '—', 'no Pro on that domain');
  assert.equal(first.children[3].children[0].textContent, 'on');
  assert.equal(
    first.children[4].children[0].textContent,
    'Bind this site',
    'no local token for that domain → bind wording',
  );
  assert.equal(first.children[4].children[0].href, '/owner/coolsite.io/');

  assert.equal(second.children[2].children[0].textContent, 'active', 'Pro state per domain');
  assert.equal(second.children[3].children[0].textContent, 'muted', 'the notify toggle per domain');
  assert.equal(second.children[4].children[0].textContent, 'Open workspace');
  assert.equal(second.children[4].children[0].href, `/owner/${DOMAIN}/`);
});

test('a pasted token is stored under the domain it proves', async () => {
  const { form, input, local, calls } = setupPanel({
    storage: {},
    domainsResponse: PANEL_ANSWER,
  });
  input.value = TOKEN;
  form.dispatch('submit');
  await flush();

  assert.equal(calls[0].url, '/api/v1/owners/domains');
  assert.equal(calls[0].init.headers.authorization, `Bearer ${TOKEN}`);
  assert.equal(local.getItem(`afr-owner-mail-${DOMAIN}`), TOKEN, 'kept for the workspace links');
  assert.equal(input.value, '', 'the field is cleared after use');
});

test('stale stored tokens say so instead of showing an empty page silently', async () => {
  const { statusEl, tableWrap, emptyEl } = setupPanel({
    storage: { [`afr-owner-mail-${DOMAIN}`]: 'rotated-away' },
    status: 401,
    domainsResponse: { error: 'unauthorized' },
  });
  await flush();

  assert.equal(tableWrap.hidden, true);
  assert.match(statusEl.textContent, /no longer work/i);
  assert.equal(statusEl.dataset.tone, 'error');
  assert.equal(emptyEl.hidden, false, 'the explanatory paragraph stays visible');
});

// ---------------------------------------------------------------------------
// The competitor comparison (OwnerCompare.astro)
// ---------------------------------------------------------------------------

function setupCompare({ token, proActive, compareAnswer, compareStatus = 200 }) {
  const source = read('../apps/web/src/components/detail/OwnerCompare.astro');
  const script = scriptOf(source);

  const section = makeElement('[data-owner-compare]');
  section.dataset.domain = DOMAIN;
  section.dataset.locale = 'en';
  for (const [name, value] of Object.entries({
    'data-desc-notoken': 'Confirm your owner mailbox first',
    'data-desc-free': 'Competitor comparison is part of AFR Pro',
    'data-label-load': 'Show my category',
    'data-msg-loading': 'Loading…',
    'data-msg-error': 'Could not load the comparison',
    'data-msg-unauthorized': 'Token not on this device',
    'data-tpl-rank': 'Your rank: {r} of {n}',
    'data-msg-noscore': 'No comparable score yet',
    'data-col-rank': 'Rank',
    'data-col-site': 'Site',
    'data-col-grade': 'Grade',
    'data-col-score': 'Score',
    'data-label-you': 'you',
  })) {
    section.attrs[name] = value;
  }

  const desc = makeElement('[data-oc-desc]');
  const btn = makeElement('[data-oc-load]');
  btn.hidden = true;
  const tableBox = makeElement('[data-oc-table]');
  tableBox.hidden = true;
  const status = makeElement('[data-oc-status]');
  const bySelector = new Map([
    ['[data-oc-desc]', desc],
    ['[data-oc-load]', btn],
    ['[data-oc-table]', tableBox],
    ['[data-oc-status]', status],
  ]);
  section.querySelector = (sel) => bySelector.get(sel) ?? null;

  const calls = [];
  const store = new Map();
  if (token) store.set(`afr-owner-mail-${DOMAIN}`, token);
  const local = makeStorage(Object.fromEntries(store));

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
    Map,
    Set,
    isFinite,
    encodeURIComponent,
    setTimeout,
    clearTimeout,
    fetch: (url, init) => {
      const u = String(url);
      calls.push({ url: u, init: init ?? {} });
      if (u.includes('/api/v1/pro/status')) {
        return Promise.resolve(jsonResponse(200, { pro: { active: proActive } }));
      }
      if (u.includes('/api/v1/compare')) {
        return Promise.resolve(jsonResponse(compareStatus, compareAnswer));
      }
      return Promise.resolve(jsonResponse(404, { error: 'not_found' }));
    },
    localStorage: local,
    document: {
      querySelectorAll: (sel) => (sel === '[data-owner-compare]' ? [section] : []),
      querySelector: () => null,
      createElement: () => makeElement('created'),
    },
    window: { setTimeout: () => 0, clearTimeout: () => {}, setInterval: () => 0, clearInterval: () => {} },
  };
  context.globalThis = context;
  runInNewContext(stripTypeScriptTypes(script, { mode: 'strip' }), context);
  return { section, desc, btn, tableBox, status, calls };
}

const COMPARE_ANSWER = {
  domain: DOMAIN,
  category: { id: 2, slug: 'dev-tools', nameEn: 'Developer Tools', nameZh: '开发者工具' },
  you: { grade: 'A', score: 92, rank: 2, total: 3 },
  peers: [
    { domain: 'strong.test', title: 'Strong', grade: 'B', score: 95, you: false },
    { domain: DOMAIN, title: 'Example', grade: 'A', score: 92, you: true },
    { domain: 'coolsite.io', title: 'Coolsite', grade: 'B', score: 78, you: false },
  ],
};

test('without a token the comparison only explains itself', async () => {
  const { desc, btn, calls } = setupCompare({ token: null, proActive: false });
  await flush();
  assert.match(desc.textContent, /Confirm your owner mailbox/);
  assert.equal(btn.hidden, true);
  assert.equal(calls.length, 0, 'no API calls without a credential');
});

test('a free term describes the benefit instead of opening the button', async () => {
  const { desc, btn, calls } = setupCompare({ token: TOKEN, proActive: false });
  await flush();
  assert.ok(calls.some((c) => c.url.includes('/api/v1/pro/status')));
  assert.match(desc.textContent, /part of AFR Pro/);
  assert.equal(btn.hidden, true);
});

test('an active Pro term opens the button and renders the category table', async () => {
  const { desc, btn, tableBox, calls } = setupCompare({
    token: TOKEN,
    proActive: true,
    compareAnswer: COMPARE_ANSWER,
  });
  await flush();
  assert.equal(btn.hidden, false, 'the load button appears for Pro');
  assert.equal(desc.textContent, '', 'no locked description for Pro');

  btn.dispatch('click');
  await flush();

  const compareCall = calls.find((c) => c.url.includes('/api/v1/compare'));
  assert.ok(compareCall, 'the comparison was fetched');
  assert.equal(compareCall.init.headers.authorization, `Bearer ${TOKEN}`);
  assert.equal(tableBox.hidden, false);

  const [meta, table] = tableBox.children;
  assert.match(meta.textContent, /Developer Tools · Your rank: 2 of 3/);
  const [thead, tbody] = table.children;
  assert.equal(thead.children[0].children.length, 4, 'four columns');
  assert.equal(tbody.children.length, 3, 'the window holds the category');
  const ownerRow = tbody.children[1];
  assert.ok('data-you' in ownerRow.attrs, 'the owner row is marked');
  assert.equal(ownerRow.children[0].textContent, '2', 'absolute rank in the category');
  assert.equal(ownerRow.children[1].textContent, DOMAIN, 'the domain is text, never markup');
  assert.match(ownerRow.children[1].children[0].textContent, /\(you\)/, 'the you-mark sits beside it');
  assert.equal(ownerRow.children[3].textContent, '92');
});

test('403 (term expired mid-session) falls back to the benefit description', async () => {
  const { desc, btn, tableBox, status } = setupCompare({
    token: TOKEN,
    proActive: true,
    compareStatus: 403,
    compareAnswer: { error: 'pro_required' },
  });
  await flush();
  btn.dispatch('click');
  await flush();

  assert.match(desc.textContent, /part of AFR Pro/);
  assert.equal(btn.hidden, true, 'the button withdraws');
  assert.equal(tableBox.hidden, true);
  assert.equal(status.textContent, '', '403 is not an error — the term simply lapsed');
});
