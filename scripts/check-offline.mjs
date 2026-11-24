#!/usr/bin/env node
// scripts/check-offline.mjs — zero-dependency self-check for the PWA offline
// contract.
//
// Why this exists: the offline behaviour of afr.im is spread over four files
// that no type checker sees (a service worker, a Cloudflare Pages _headers
// file, a web app manifest and the page that registers the worker). A path
// that is forgotten in one of them only fails when a user is already offline
// — the worst moment to find out. This script reads those files and asserts
// the contract, so the mistake shows up in `npm test` instead.
//
// What it checks:
//   1. the service worker routes every offline-relevant path cache-first;
//   2. the service worker does not precache the huge sitemap, but does
//      precache the tiny robots.txt;
//   3. the routing actually behaves as claimed (the worker is executed in a
//      sandbox with a fake network and a fake cache);
//   4. /sw.js is served no-cache, so an update check really sees a new script;
//   5. /.well-known/openapi.yaml has a YAML content type;
//   6. the manifest is valid and points at icons that exist on disk;
//   7. the page registers the worker and asks for an explicit update.
//
// Usage: node scripts/check-offline.mjs   (exit code 1 on any failure)

import { readFileSync, existsSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import vm from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, '..');
const PUBLIC_DIR = join(ROOT, 'apps/web/public');
const BASE_LAYOUT = join(ROOT, 'apps/web/src/layouts/Base.astro');

/** Paths that must be available offline, cache-first. */
const REQUIRED_STATIC_FILES = [
  '/llms.txt',
  '/llms-full.txt',
  '/agents.md',
  '/ai.txt',
  '/openapi.json',
  '/robots.txt',
  '/sitemap.xml',
];

/** Static prefixes that must stay cache-first (build output, icons, fonts,
 *  discovery documents). */
const REQUIRED_STATIC_PREFIXES = ['/_astro/', '/icons/', '/fonts/', '/.well-known/'];

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------

/** Parse a Cloudflare Pages `_headers` file into path → header map.
 *  Format: a path at column 0, then indented `Name: value` lines. */
export function parseHeaders(text) {
  const rules = new Map();
  let current = null;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    if (!/^\s/.test(rawLine)) {
      current = line;
      if (!rules.has(current)) rules.set(current, new Map());
      continue;
    }
    if (!current) continue;
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const name = line.slice(0, idx).trim().toLowerCase();
    rules.get(current).set(name, line.slice(idx + 1).trim());
  }
  return rules;
}

/** Read a `const NAME = [ ... ];` array of string literals out of source code.
 *  The service worker is plain JavaScript, so the literal can be read without
 *  executing it (and without pulling in a parser dependency). Only quoted
 *  strings are collected: identifiers (OFFLINE_CANONICAL) and comments are
 *  skipped, so the result is exactly the list of paths the worker knows. */
export function extractStringArray(source, name) {
  const match = source.match(new RegExp(`const\\s+${name}\\s*=\\s*(\\[[\\s\\S]*?\\])\\s*;`));
  if (!match) return null;
  const body = match[1];
  const values = [];
  let i = 0;
  while (i < body.length) {
    const ch = body[i];
    if (ch === '/' && body[i + 1] === '/') {
      while (i < body.length && body[i] !== '\n') i += 1; // line comment
      continue;
    }
    if (ch === '"' || ch === "'") {
      const end = body.indexOf(ch, i + 1);
      const stop = end === -1 ? body.length : end;
      values.push(body.slice(i + 1, stop));
      i = stop + 1;
      continue;
    }
    i += 1;
  }
  return values;
}

// ---------------------------------------------------------------------------
// sandbox that runs the real service worker
// ---------------------------------------------------------------------------

class FakeHeaders {
  constructor(init = {}) {
    this.map = new Map(
      Object.entries(init).map(([k, v]) => [String(k).toLowerCase(), String(v)]),
    );
  }

  get(name) {
    return this.map.get(String(name).toLowerCase()) ?? null;
  }

  toObject() {
    return Object.fromEntries(this.map);
  }
}

class FakeResponse {
  constructor(body, init = {}) {
    this.body = body;
    this.status = init.status ?? 200;
    this.ok = this.status >= 200 && this.status < 300;
    this.type = init.type ?? 'basic';
    this.headers = new FakeHeaders(init.headers ?? {});
  }

  clone() {
    return new FakeResponse(this.body, {
      status: this.status,
      type: this.type,
      headers: this.headers.toObject(),
    });
  }

  async text() {
    return String(this.body);
  }
}

/** Build a sandbox that runs sw.js with a fake Cache API and a fake network.
 *  `state.online` toggles between "the network works" and "the network is
 *  gone", which is exactly the distinction the routing rules are about. */
export function createWorkerSandbox(swSource) {
  const listeners = new Map();
  const store = new Map();
  const key = (request) => (typeof request === 'string' ? request : request.url);
  const state = { online: false };

  const cache = {
    async match(request) {
      return store.get(key(request));
    },
    async put(request, response) {
      store.set(key(request), response);
    },
    async delete(request) {
      return store.delete(key(request));
    },
    async addAll(urls) {
      for (const url of urls) {
        store.set(url, new FakeResponse(`precached:${url}`, { status: 200 }));
      }
    },
  };

  const caches = {
    async open() {
      return cache;
    },
    async keys() {
      return [];
    },
    async delete() {
      return true;
    },
    async match(request) {
      return store.get(key(request));
    },
  };

  const self = {
    addEventListener(type, handler) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(handler);
    },
    skipWaiting: async () => {},
    clients: { claim: async () => {} },
    location: new URL('https://afr.im/sw.js'),
  };

  const context = vm.createContext({
    self,
    caches,
    Response: FakeResponse,
    Headers: FakeHeaders,
    URL,
    console,
    fetch: async (request) => {
      if (!state.online) throw new TypeError('Failed to fetch');
      const url = typeof request === 'string' ? request : request.url;
      return new FakeResponse(`network:${url}`, {
        status: 200,
        headers: { date: new Date().toUTCString() },
      });
    },
  });

  vm.runInContext(swSource, context, { filename: 'sw.js' });

  /** Dispatch a synthetic fetch event and return the response the worker
   *  produced (or null when the worker did not handle the request). */
  async function route(path, { mode = 'cors' } = {}) {
    const handlers = listeners.get('fetch') ?? [];
    if (handlers.length === 0) throw new Error('the service worker registered no fetch handler');
    const request = { method: 'GET', url: `https://afr.im${path}`, mode };
    let answered = null;
    const jobs = [];
    for (const handler of handlers) {
      handler({ request, respondWith: (promise) => { answered = promise; }, waitUntil: (job) => jobs.push(job) });
    }
    if (!answered) return null;
    const response = await answered;
    await Promise.all(jobs);
    return {
      status: response.status,
      body: typeof response.body === 'string' ? response.body : await response.text(),
    };
  }

  return { route, state, store };
}

// ---------------------------------------------------------------------------
// the checks
// ---------------------------------------------------------------------------

/**
 * Run every offline-contract check.
 * @param {{publicDir?: string, layoutFile?: string, log?: (line: string) => void}} options
 * @returns {Promise<{passed: number, failures: string[]}>}
 */
export async function runChecks(options = {}) {
  const publicDir = options.publicDir ?? PUBLIC_DIR;
  const layoutFile = options.layoutFile ?? BASE_LAYOUT;
  const log = options.log ?? (() => {});
  const failures = [];
  let passed = 0;

  const pass = (name, detail) => {
    passed += 1;
    log(`  ✓ ${name}${detail ? ` — ${detail}` : ''}`);
  };
  const fail = (name, detail) => {
    failures.push(`${name}: ${detail}`);
    log(`  ✗ ${name} — ${detail}`);
  };
  const check = async (name, fn) => {
    try {
      const detail = await fn();
      if (detail === false) fail(name, 'assertion failed');
      else pass(name, typeof detail === 'string' ? detail : undefined);
    } catch (error) {
      fail(name, error instanceof Error ? error.message : String(error));
    }
  };

  const swPath = join(publicDir, 'sw.js');
  const headersPath = join(publicDir, '_headers');
  const manifestPath = join(publicDir, 'manifest.webmanifest');

  for (const file of [swPath, headersPath, manifestPath]) {
    if (!existsSync(file)) {
      fail('files exist', `${file} is missing`);
      return { passed, failures };
    }
  }

  const swSource = readFileSync(swPath, 'utf8');
  const headersText = readFileSync(headersPath, 'utf8');
  const manifestText = readFileSync(manifestPath, 'utf8');

  // --- 1. static routing tables -------------------------------------------
  log('service worker routing');

  const staticFiles = extractStringArray(swSource, 'STATIC_FILES');
  const staticPrefixes = extractStringArray(swSource, 'STATIC_PREFIXES');
  const shell = extractStringArray(swSource, 'SHELL');

  await check('STATIC_FILES / STATIC_PREFIXES are declared', () => {
    if (!staticFiles || !staticPrefixes) return false;
    return `${staticFiles.length} exact paths, ${staticPrefixes.length} prefixes`;
  });

  if (staticFiles) {
    for (const path of REQUIRED_STATIC_FILES) {
      await check(`${path} is cache-first`, () => {
        if (!staticFiles.includes(path)) {
          throw new Error(`${path} is not in STATIC_FILES (${staticFiles.join(', ')})`);
        }
        return 'declared in STATIC_FILES';
      });
    }
  }

  if (staticPrefixes) {
    for (const prefix of REQUIRED_STATIC_PREFIXES) {
      await check(`${prefix}* is cache-first`, () => {
        if (!staticPrefixes.includes(prefix)) {
          throw new Error(`${prefix} is not in STATIC_PREFIXES`);
        }
        return 'declared in STATIC_PREFIXES';
      });
    }
  }

  // --- 2. precache budget --------------------------------------------------
  log('service worker precache');

  if (shell) {
    await check('/sitemap.xml is not precached', () => {
      if (shell.includes('/sitemap.xml')) {
        throw new Error('the sitemap is ~1.7 MB and must stay runtime-only');
      }
      return 'runtime cache-first only';
    });
    await check('/robots.txt is precached', () => {
      if (!shell.includes('/robots.txt')) {
        throw new Error('/robots.txt is tiny and should be available offline immediately');
      }
      return 'precached (app shell)';
    });
  }

  // --- 3. behavioural routing ---------------------------------------------
  log('service worker behaviour (sandboxed)');

  let sandbox = null;
  try {
    sandbox = createWorkerSandbox(swSource);
  } catch (error) {
    fail(
      'the service worker loads in a sandbox',
      error instanceof Error ? error.message : String(error),
    );
  }

  if (sandbox) {
    for (const path of REQUIRED_STATIC_FILES) {
      await check(`${path} answers offline from the cache-first branch`, async () => {
        const answer = await sandbox.route(path);
        if (!answer) throw new Error('the worker did not handle the request');
        if (!answer.body.includes('Offline and this file is not cached yet.')) {
          throw new Error(`unexpected offline body: ${answer.body.slice(0, 120)}`);
        }
        return '503 from the cache-first branch';
      });
    }

    await check('a cached document is served offline (cache-first really caches)', async () => {
      sandbox.state.online = true;
      const online = await sandbox.route('/llms-full.txt');
      if (!online || !online.body.startsWith('network:')) {
        throw new Error('the online request did not reach the network');
      }
      sandbox.state.online = false;
      const offline = await sandbox.route('/llms-full.txt');
      if (!offline || !offline.body.startsWith('network:')) {
        throw new Error('the cached copy was not served while offline');
      }
      return 'second (offline) request answered from the cache';
    });

    await check('/data/* still uses stale-while-revalidate', async () => {
      sandbox.state.online = false;
      const answer = await sandbox.route('/data/scans.json');
      if (!answer || !answer.body.includes('Data is not cached yet')) {
        throw new Error(`unexpected body: ${(answer && answer.body.slice(0, 120)) || 'no answer'}`);
      }
      return 'friendly JSON offline error';
    });

    await check('/api/* still uses network-first', async () => {
      sandbox.state.online = false;
      const answer = await sandbox.route('/api/site/example.com');
      if (!answer || !answer.body.includes('The afr.im API is unreachable')) {
        throw new Error(`unexpected body: ${(answer && answer.body.slice(0, 120)) || 'no answer'}`);
      }
      return 'friendly JSON offline error';
    });

    await check('navigations still fall back to the offline page', async () => {
      sandbox.state.online = false;
      const answer = await sandbox.route('/', { mode: 'navigate' });
      if (!answer || !answer.body.includes('You are offline and no cached copy')) {
        throw new Error(`unexpected body: ${(answer && answer.body.slice(0, 120)) || 'no answer'}`);
      }
      return 'offline fallback';
    });
  }

  // --- 4. header rules -----------------------------------------------------
  log('cloudflare pages _headers');

  const rules = parseHeaders(headersText);

  await check('/sw.js is served no-cache', () => {
    const rule = rules.get('/sw.js');
    if (!rule) throw new Error('no /sw.js rule');
    const value = rule.get('cache-control') ?? '';
    if (!value.toLowerCase().includes('no-cache')) {
      throw new Error(`Cache-Control is "${value}"`);
    }
    return `Cache-Control: ${value}`;
  });

  await check('/.well-known/openapi.yaml has a YAML content type', () => {
    const rule = rules.get('/.well-known/openapi.yaml');
    if (!rule) throw new Error('no /.well-known/openapi.yaml rule');
    const value = rule.get('content-type') ?? '';
    if (!/yaml/i.test(value)) throw new Error(`Content-Type is "${value}"`);
    return `Content-Type: ${value}`;
  });

  await check('every _headers rule has at least one header', () => {
    for (const [path, rule] of rules) {
      if (rule.size === 0) throw new Error(`${path} declares no header`);
    }
    return `${rules.size} rules parsed`;
  });

  // --- 5. manifest ---------------------------------------------------------
  log('web app manifest');

  let manifest = null;
  await check('manifest.webmanifest is valid JSON', () => {
    manifest = JSON.parse(manifestText);
    return 'parsed';
  });

  if (manifest) {
    await check('manifest declares name, short_name, icons, display, dir and lang', () => {
      const missing = ['name', 'short_name', 'icons', 'display', 'dir', 'lang'].filter(
        (key) => manifest[key] === undefined || manifest[key] === null || manifest[key] === '',
      );
      if (missing.length) throw new Error(`missing: ${missing.join(', ')}`);
      if (!Array.isArray(manifest.icons) || manifest.icons.length === 0) {
        throw new Error('icons must be a non-empty array');
      }
      return `${manifest.icons.length} icons, display=${manifest.display}, dir=${manifest.dir}`;
    });

    await check('the manifest name matches its lang', () => {
      const lang = String(manifest.lang ?? 'en').toLowerCase();
      const name = String(manifest.name ?? '');
      if (lang.startsWith('en') && /[一-鿿]/.test(name)) {
        throw new Error(`lang is "${lang}" but the name is not English: ${name}`);
      }
      return `lang=${lang}, name="${name}"`;
    });

    await check('short_name is short enough for the launcher', () => {
      const short = String(manifest.short_name ?? '');
      if (short.length === 0 || short.length > 12) {
        throw new Error(`short_name "${short}" should be 1-12 characters`);
      }
      return `"${short}"`;
    });

    await check('every declared icon exists on disk', () => {
      for (const icon of manifest.icons) {
        const src = String(icon.src ?? '');
        if (!src.startsWith('/')) throw new Error(`icon src must be a root path: ${src}`);
        const file = join(publicDir, src.replace(/^\//, ''));
        if (!existsSync(file) || !statSync(file).isFile()) {
          throw new Error(`missing icon file: ${src}`);
        }
      }
      return `${manifest.icons.length} icon files found`;
    });

    await check('start_url and scope stay inside the site', () => {
      for (const key of ['start_url', 'scope']) {
        const value = String(manifest[key] ?? '/');
        if (!value.startsWith('/')) throw new Error(`${key} must be a root path: ${value}`);
      }
      return `start_url=${manifest.start_url}, scope=${manifest.scope}`;
    });
  }

  // --- 6. registration and update channel ---------------------------------
  log('service worker registration');

  await check('the page registers the worker and asks for an explicit update', () => {
    if (!existsSync(layoutFile)) throw new Error(`${layoutFile} is missing`);
    const source = readFileSync(layoutFile, 'utf8');
    if (!/serviceWorker\s*\.?\s*register\(\s*['"`]\/sw\.js/.test(source)) {
      throw new Error('no register("/sw.js") call found');
    }
    if (!/registration\.update\(\)/.test(source)) {
      throw new Error('no registration.update() call found — updates would rely on the browser only');
    }
    return 'register() + registration.update()';
  });

  return { passed, failures };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export function formatReport({ passed, failures }) {
  const lines = [];
  lines.push('');
  if (failures.length === 0) {
    lines.push(`All checks passed (${passed}/${passed}).`);
  } else {
    lines.push(`${failures.length} check(s) failed (${passed} passed):`);
    for (const failure of failures) lines.push(`  - ${failure}`);
  }
  return lines.join('\n');
}

async function main() {
  console.log('AFR offline self-check — apps/web/public');
  const result = await runChecks({ log: (line) => console.log(line) });
  console.log(formatReport(result));
  if (result.failures.length > 0) process.exitCode = 1;
}

const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
