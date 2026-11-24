import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';

const source = readFileSync(new URL('../apps/web/public/sw.js', import.meta.url), 'utf8');
const origin = 'https://afr.im';
const legacy = 'afr-runtime-afr-sw-v4';
const runtime = 'afr-runtime-afr-sw-v5';
const api = '/api/v1/owners/email/verify?token=fixture';

function worker() {
  const stores = new Map();
  const listeners = {};
  const urlOf = (req) => typeof req === 'string' ? origin + req : req.url;
  async function open(name) {
    if (!stores.has(name)) stores.set(name, new Map());
    const entries = stores.get(name);
    return {
      addAll: async (paths) => { for (const path of paths) entries.set(urlOf(path), new Response(path)); },
      match: async (req) => entries.get(urlOf(req))?.clone(),
      put: async (req, res) => { entries.set(urlOf(req), res); },
      delete: async (req) => entries.delete(urlOf(req)),
    };
  }
  let network = async () => { throw new Error('offline'); };
  runInNewContext(source, {
    Response, URL,
    fetch: (...args) => network(...args),
    caches: { open, keys: async () => [...stores.keys()], delete: async (name) => stores.delete(name) },
    self: { location: { origin }, skipWaiting: async () => {}, clients: { claim: async () => {} },
      addEventListener: (name, fn) => { listeners[name] = fn; } },
  });
  return {
    stores, open,
    setNetwork: (fn) => { network = fn; },
    run: async (name, path, mode = 'navigate') => {
      const jobs = [];
      let response;
      listeners[name]({ request: { method: 'GET', url: origin + path, mode },
        waitUntil: (p) => jobs.push(p), respondWith: (p) => { response = p; } });
      const result = await response;
      await Promise.all(jobs);
      return result;
    },
  };
}

function page(text, { headers, redirected = false } = {}) {
  const response = new Response(text, { headers });
  Object.defineProperties(response, { type: { value: 'basic' }, redirected: { value: redirected } });
  return response;
}

test('upgrade removes old confirmation responses; online and offline API navigations bypass Cache Storage', async () => {
  const sw = worker();
  await (await sw.open(legacy)).put(api, new Response('old-fixture-token'));
  await sw.open('unrelated');
  await sw.run('install');
  await sw.run('activate');
  assert.equal(sw.stores.has(legacy), false);
  assert.equal(sw.stores.has('unrelated'), true);

  sw.setNetwork(async (request, options) => {
    assert.equal(request.url, origin + api);
    assert.equal(options.cache, 'no-store');
    return page('new-fixture-token', { headers: { 'cache-control': 'no-store' } });
  });
  assert.equal(await (await sw.run('fetch', api)).text(), 'new-fixture-token');
  assert.ok([...sw.stores.values()].every((entries) => !entries.has(origin + api)));

  // Even a pre-existing entry from another writer must not be consulted.
  await (await sw.open(runtime)).put(api, new Response('stale-fixture-token'));
  sw.setNetwork(async () => { throw new Error('offline'); });
  for (const mode of ['navigate', 'same-origin']) {
    const response = await sw.run('fetch', api, mode);
    assert.equal(response.status, 503);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal((await response.json()).error, 'offline');
  }
});

test('public navigation retains offline fallback, but evicts no-store and redirect responses', async () => {
  const sw = worker();
  await sw.run('install');
  const cases = [
    ['/zh-CN/private', { headers: { 'cache-control': 'max-age=0, No-Store' } }, '/zh-CN/offline'],
    ['/moved', { redirected: true }, '/offline'],
  ];
  for (const [path, options, offline] of cases) {
    sw.setNetwork(async () => page('public'));
    assert.equal(await (await sw.run('fetch', path)).text(), 'public');
    sw.setNetwork(async () => { throw new Error('offline'); });
    assert.equal(await (await sw.run('fetch', path)).text(), 'public');
    sw.setNetwork(async () => page('do not store', options));
    await sw.run('fetch', path);
    assert.equal(sw.stores.get(runtime).has(origin + path), false);
    sw.setNetwork(async () => { throw new Error('offline'); });
    assert.equal(await (await sw.run('fetch', path)).text(), offline);
  }
});
