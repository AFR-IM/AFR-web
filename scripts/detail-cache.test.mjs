// scripts/detail-cache.test.mjs — the on-demand detail page is cached by
// Cloudflare's Workers Cache, so a repeat visitor never runs the Worker.
//
// Two traps this guard closes:
//
//   1. `cache.enabled` lives in wrangler.jsonc. If it is dropped (or a
//      deploy forgets it) the page goes back to rendering on every single
//      request — the Worker runs, pays CPU and waits for the data repo.
//
//   2. `cloudflare-cdn-cache-control` has the HIGHEST cache precedence.
//      The 404 branch clears `Cache-Control` to `no-store`, but if it does
//      not clear the CDN header as well, the 404 still sits in the edge
//      cache for an hour — and a domain that is added to the catalog later
//      keeps answering 404 until the entry expires.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const WEB = join(here, '..', 'apps', 'web');

const wrangler = readFileSync(join(WEB, 'wrangler.jsonc'), 'utf8');
const page = readFileSync(join(WEB, 'src', 'pages', '[...locale]', 'site', '[domain].astro'), 'utf8');
const middleware = readFileSync(join(WEB, 'src', 'middleware.ts'), 'utf8');

test('the Worker caches its own responses (Workers Cache is on)', () => {
  assert.match(wrangler, /"cache"\s*:\s*\{[^}]*"enabled"\s*:\s*true/s);
});

test('the detail page tells the edge how long to keep it', () => {
  assert.match(page, /cloudflare-cdn-cache-control/);
  assert.match(page, /max-age=3600/);
});

test('a 404 is never cached — neither by the browser nor by the edge', () => {
  // Both headers have to say no-store: the CDN one outranks Cache-Control.
  const noStore = [...page.matchAll(/headers\.set\(\s*'([^']+)'\s*,\s*'no-store'\s*\)/g)].map((m) => m[1]);
  assert.deepEqual(
    [...noStore].sort(),
    ['Cache-Control', 'cloudflare-cdn-cache-control'],
    'the 404 branch must clear both cache headers',
  );
});

test('the trailing-slash redirect is cacheable (it never changes)', () => {
  assert.match(middleware, /context\.redirect\([\s\S]*?307\)/);
  assert.match(middleware, /Cache-Control/);
});
