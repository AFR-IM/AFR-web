// scripts/check-sitemap.test.mjs — the sitemap guard must pass on the current
// tree, and it must actually fail when the contract is broken (a guard that
// cannot fail is worse than none).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runChecks } from './check-sitemap.mjs';
import {
  CATS,
  INDEX_FILE,
  MAX_URLS_PER_FILE,
  SHARD_DIR,
  TOP,
  planShards,
  renderIndex,
  renderShard,
  shardName,
  urlsFor,
} from '../apps/web/scripts/sitemap-contract.mjs';

const SITES = ['alpha.com', 'beta.com', 'gamma.com'];
const STATIC = [...TOP, ...CATS.map((s) => `/c/${s}`)];
const LASTMOD = '2026-11-22';

/** Build a sitemap tree for a small catalog in a temp directory. */
function withTree(run, { sites = SITES } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'afr-sitemap-'));
  try {
    const shardDir = join(dir, SHARD_DIR);
    mkdirSync(shardDir, { recursive: true });
    const shards = planShards(STATIC, sites.map((d) => `/site/${d}`), LASTMOD);
    for (const [i, shard] of shards.entries()) {
      writeFileSync(join(dir, shardName(i)), renderShard(shard.paths, LASTMOD));
    }
    writeFileSync(join(dir, INDEX_FILE), renderIndex(shards, LASTMOD));
    return run({ dir, shards });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('the guard passes on a well-formed tree', () => {
  withTree(({ dir }) => {
    const { failures } = runChecks({ publicDir: dir, sites: SITES });
    assert.deepEqual(failures, []);
  });
});

test('the guard passes on the repository tree', () => {
  const { failures } = runChecks();
  assert.deepEqual(failures, []);
});

test('a missing shard is caught', () => {
  withTree(({ dir }) => {
    rmSync(join(dir, shardName(1)));
    const { failures } = runChecks({ publicDir: dir, sites: SITES });
    assert.ok(failures.some((f) => /does not exist|missing/.test(f)), failures.join('; '));
  });
});

test('an orphan shard is caught', () => {
  withTree(({ dir }) => {
    writeFileSync(join(dir, shardName(9)), renderShard(['/site/orphan.com/'], LASTMOD));
    const { failures } = runChecks({ publicDir: dir, sites: SITES });
    assert.ok(failures.some((f) => /orphan/.test(f)), failures.join('; '));
  });
});

test('a URL dropped from a shard is caught', () => {
  withTree(({ dir }) => {
    // The site shard loses its last path.
    const file = join(dir, shardName(1));
    const xml = readFileSync(file, 'utf8');
    writeFileSync(file, xml.replace(/  <url>[\s\S]*?<\/url>\n(?!  <url>)/, ''));
    const { failures } = runChecks({ publicDir: dir, sites: SITES });
    assert.ok(failures.some((f) => /missing from the sitemap|does not match the plan/.test(f)), failures.join('; '));
  });
});

test('a broken hreflang pair is caught', () => {
  withTree(({ dir }) => {
    const file = join(dir, shardName(1));
    const xml = readFileSync(file, 'utf8');
    // Point the zh alternate of the first site at its own (en) URL.
    const { en, zh } = urlsFor('/site/alpha.com');
    writeFileSync(file, xml.replace(`hreflang="zh-CN" href="${zh}"`, `hreflang="zh-CN" href="${en}"`));
    const { failures } = runChecks({ publicDir: dir, sites: SITES });
    assert.ok(failures.some((f) => /alternate|both locales/.test(f)), failures.join('; '));
  });
});

test('an index that does not match the shards is caught', () => {
  withTree(({ dir, shards }) => {
    writeFileSync(join(dir, INDEX_FILE), renderIndex(shards.slice(0, 1), LASTMOD));
    const { failures } = runChecks({ publicDir: dir, sites: SITES });
    assert.ok(failures.length > 0, failures.join('; '));
  });
});

test('a shard over the URL cap is caught', () => {
  // A catalog large enough to overflow one shard, checked without writing
  // the files: the plan itself must respect the cap.
  const many = Array.from({ length: MAX_URLS_PER_FILE }, (_, i) => `/site/s${i}.com`);
  const shards = planShards(STATIC, many, LASTMOD);
  for (const shard of shards) {
    assert.ok(shard.urls <= MAX_URLS_PER_FILE, `shard holds ${shard.urls} urls`);
  }
  assert.ok(shards.length > 2, 'the catalog must be split into several shards');
  // Every URL is still there, and no path is split across shards (the
  // static paths live in the first shard, the sites in the rest).
  const planned = shards.slice(1).flatMap((s) => s.paths);
  assert.deepEqual(planned, many);
});
