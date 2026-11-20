// scripts/check-offline.test.mjs — the offline self-check must pass on the
// current tree, and it must actually fail when the contract is broken (a
// self-check that cannot fail is worse than none).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runChecks, parseHeaders, extractStringArray } from './check-offline.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(here, 'check-offline.mjs');
const PUBLIC_DIR = join(here, '..', 'apps/web/public');

test('the offline self-check passes on the current tree', () => {
  const out = execFileSync(process.execPath, [SCRIPT], { encoding: 'utf8' });
  assert.match(out, /All checks passed/);
});

test('parseHeaders reads paths and their headers', () => {
  const rules = parseHeaders('# comment\n/sw.js\n  Cache-Control: no-cache\n\n/robots.txt\n  Cache-Control: public, max-age=3600\n');
  assert.equal(rules.get('/sw.js').get('cache-control'), 'no-cache');
  assert.equal(rules.get('/robots.txt').get('cache-control'), 'public, max-age=3600');
  assert.equal(rules.size, 2);
});

test('extractStringArray reads literals and skips identifiers and comments', () => {
  const source = `const SHELL = [
  OFFLINE_CANONICAL,
  // a comment mentioning '/not-a-path'
  '/robots.txt',
];`;
  assert.deepEqual(extractStringArray(source, 'SHELL'), ['/robots.txt']);
  assert.equal(extractStringArray(source, 'MISSING'), null);
});

/** Build a throwaway copy of the public folder so a broken variant can be
 *  checked without touching the real files. */
function withPublicCopy(mutate, run) {
  const dir = mkdtempSync(join(tmpdir(), 'afr-offline-'));
  try {
    mkdirSync(join(dir, 'icons'), { recursive: true });
    for (const file of ['sw.js', '_headers', 'manifest.webmanifest']) {
      copyFileSync(join(PUBLIC_DIR, file), join(dir, file));
    }
    for (const icon of ['icon-192.png', 'icon-512.png', 'maskable-512.png']) {
      writeFileSync(join(dir, 'icons', icon), 'not-a-real-png');
    }
    mutate(dir);
    return run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('the self-check fails when a path leaves the cache-first list', async () => {
  await withPublicCopy(
    (dir) => {
      const sw = readFileSync(join(dir, 'sw.js'), 'utf8').replace("  '/robots.txt',\n", '');
      writeFileSync(join(dir, 'sw.js'), sw);
    },
    async (dir) => {
      const result = await runChecks({ publicDir: dir });
      assert.ok(result.failures.length > 0, 'expected a failure');
      assert.match(result.failures.join('\n'), /\/robots\.txt/);
    },
  );
});

test('the self-check fails when the sitemap is precached', async () => {
  await withPublicCopy(
    (dir) => {
      const sw = readFileSync(join(dir, 'sw.js'), 'utf8').replace(
        "  '/robots.txt',\n",
        "  '/robots.txt',\n  '/sitemap.xml',\n",
      );
      writeFileSync(join(dir, 'sw.js'), sw);
    },
    async (dir) => {
      const result = await runChecks({ publicDir: dir });
      assert.ok(result.failures.length > 0, 'expected a failure');
      assert.match(result.failures.join('\n'), /sitemap\.xml is not precached/);
    },
  );
});

test('the self-check fails when /sw.js loses its no-cache rule', async () => {
  await withPublicCopy(
    (dir) => {
      const headers = readFileSync(join(dir, '_headers'), 'utf8').replace(
        '/sw.js\n  Cache-Control: no-cache\n',
        '/sw.js\n  Cache-Control: public, max-age=3600\n',
      );
      writeFileSync(join(dir, '_headers'), headers);
    },
    async (dir) => {
      const result = await runChecks({ publicDir: dir });
      assert.ok(result.failures.length > 0, 'expected a failure');
      assert.match(result.failures.join('\n'), /no-cache/);
    },
  );
});

test('the self-check fails when the manifest points at a missing icon', async () => {
  await withPublicCopy(
    (dir) => {
      const manifest = JSON.parse(readFileSync(join(dir, 'manifest.webmanifest'), 'utf8'));
      manifest.icons.push({ src: '/icons/icon-1024.png', sizes: '1024x1024', type: 'image/png' });
      writeFileSync(join(dir, 'manifest.webmanifest'), JSON.stringify(manifest, null, 2));
    },
    async (dir) => {
      const result = await runChecks({ publicDir: dir });
      assert.ok(result.failures.length > 0, 'expected a failure');
      assert.match(result.failures.join('\n'), /missing icon file/);
    },
  );
});
