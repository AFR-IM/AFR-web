// scripts/check-search-index.test.mjs — the search-index guard must pass on the
// current tree, and it must actually fail when the contract is broken (a
// guard that cannot fail is worse than none).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runChecks, brotliBytes, DEFAULT_INDEX_PATH, DEFAULT_PAGE_PATH } from './check-search-index.mjs';
import {
  SEARCH_MANIFEST_FILE,
  SEARCH_TOP_FILE,
  assignShards,
  buildShardManifest,
  shardFileFor,
} from '../apps/web/scripts/search-index-contract.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(here, 'check-search-index.mjs');

/** Write a throwaway index + page so a broken variant can be checked. */
function withFiles({ index, page }, run) {
  const dir = mkdtempSync(join(tmpdir(), 'afr-search-index-'));
  try {
    const indexPath = join(dir, 'search-index.json');
    const pagePath = join(dir, 'search.astro');
    writeFileSync(indexPath, JSON.stringify(index ?? []), 'utf8');
    writeFileSync(pagePath, page ?? readFileSync(DEFAULT_PAGE_PATH, 'utf8'), 'utf8');
    return run({ indexPath, pagePath });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * A whole index tree: the legacy file, the shards, the leaderboard slice and
 * the manifest — written the way the generator writes them.
 */
function withIndexTree({ entries, page, mutate } = {}, run) {
  const dir = mkdtempSync(join(tmpdir(), 'afr-search-tree-'));
  try {
    const dataDir = join(dir, 'data');
    mkdirSync(join(dataDir, 'search-index'), { recursive: true });
    const serialize = (list) => `${JSON.stringify(list)}\n`;
    const shards = assignShards(entries);
    const sizes = {};
    for (const [id, list] of shards) {
      const text = serialize(list);
      sizes[id] = { raw: Buffer.byteLength(text, 'utf8'), wire: brotliBytes(text) };
      writeFileSync(join(dataDir, shardFileFor(id)), text, 'utf8');
    }
    const top = entries.slice(0, 2);
    const topText = serialize(top);
    writeFileSync(join(dataDir, SEARCH_TOP_FILE), topText, 'utf8');
    const manifest = buildShardManifest({
      shards,
      top,
      entries: entries.length,
      sizes,
      topSize: {
        raw: Buffer.byteLength(topText, 'utf8'),
        wire: brotliBytes(topText),
      },
    });
    writeFileSync(join(dataDir, SEARCH_MANIFEST_FILE), `${JSON.stringify(manifest)}\n`, 'utf8');
    writeFileSync(join(dataDir, 'search-index.json'), serialize(entries), 'utf8');
    const pagePath = join(dir, 'search.astro');
    writeFileSync(pagePath, page ?? readFileSync(DEFAULT_PAGE_PATH, 'utf8'), 'utf8');
    if (mutate) mutate({ dataDir, manifest });
    return run({
      dataDir,
      indexPath: join(dataDir, 'search-index.json'),
      manifestPath: join(dataDir, SEARCH_MANIFEST_FILE),
      pagePath,
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** A small catalog that covers several shards (shard "a" holds three). */
function sampleEntries() {
  return [
    { d: 'alpha.test', s: 91 },
    { d: 'acme.test', s: 85 },
    { d: 'apple.test', s: 82 },
    { d: 'beta.test', s: 80 },
    { d: 'gamma.test', s: 70 },
    { d: 'delta.test', s: 60 },
    { d: 'epsilon.test', s: 50 },
  ];
}

test('the search-index guard passes on the current tree', () => {
  const out = execFileSync(process.execPath, [SCRIPT], { encoding: 'utf8' });
  assert.match(out, /All checks passed/);
});

test('the guard reads the real index and the real search page by default', () => {
  const { failures } = runChecks();
  assert.deepEqual(failures, []);
});

test('the guard fails when the index grows past the wire budget', () => {
  // 40k entries with unique text — far past the 160 KB compressed budget
  const words = 'alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi rho sigma tau upsilon phi chi psi omega'.split(' ');
  let seed = 20261121;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const title = () => Array.from({ length: 8 }, () => words[Math.floor(rnd() * words.length)]).join(' ');
  const index = Array.from({ length: 40000 }, (_, i) => ({
    d: `site-${i}-with-a-long-name.example.com`,
    s: 50,
    c: 'dev-tools',
    t: title(),
  }));
  withFiles({ index }, ({ indexPath, pagePath }) => {
    const result = runChecks({ indexPath, pagePath });
    assert.ok(result.failures.length > 0, 'expected a failure');
    assert.match(result.failures.join('\n'), /wire size .* is over the .* budget/);
  });
});

test('the guard fails when an entry carries a key the browser does not read', () => {
  const index = [{ d: 'example.com', s: 91, g: 'A', c: 'dev-tools' }];
  withFiles({ index }, ({ indexPath, pagePath }) => {
    const result = runChecks({ indexPath, pagePath });
    assert.ok(result.failures.length > 0, 'expected a failure');
    assert.match(result.failures.join('\n'), /unknown key "g"/);
  });
});

test('the guard fails when a title outgrows its budget', () => {
  const index = [{ d: 'example.com', s: 91, t: 'x'.repeat(200) }];
  withFiles({ index }, ({ indexPath, pagePath }) => {
    const result = runChecks({ indexPath, pagePath });
    assert.ok(result.failures.length > 0, 'expected a failure');
    assert.match(result.failures.join('\n'), /"t" is 200 chars/);
  });
});

test('the guard fails when an entry keeps the "other" category', () => {
  const index = [{ d: 'example.com', s: 91, c: 'other' }];
  withFiles({ index }, ({ indexPath, pagePath }) => {
    const result = runChecks({ indexPath, pagePath });
    assert.ok(result.failures.length > 0, 'expected a failure');
    assert.match(result.failures.join('\n'), /"c" must be omitted for the "other" category/);
  });
});

test('the guard fails when the entries are not ordered by score', () => {
  const index = [
    { d: 'low.example.com', s: 10 },
    { d: 'high.example.com', s: 90 },
  ];
  withFiles({ index }, ({ indexPath, pagePath }) => {
    const result = runChecks({ indexPath, pagePath });
    assert.ok(result.failures.length > 0, 'expected a failure');
    assert.match(result.failures.join('\n'), /out of order/);
  });
});

test('the guard fails when the page stops taking the grade from the shared thresholds', () => {
  const page = readFileSync(DEFAULT_PAGE_PATH, 'utf8').replace(
    'data-grade-thresholds={JSON.stringify(GRADE_THRESHOLDS)}',
    '',
  );
  withFiles({ index: [{ d: 'example.com', s: 91 }], page }, ({ indexPath, pagePath }) => {
    const result = runChecks({ indexPath, pagePath });
    assert.ok(result.failures.length > 0, 'expected a failure');
    assert.match(result.failures.join('\n'), /data-grade-thresholds/);
  });
});

test('the guard fails when the page hardcodes its own grade table', () => {
  const page =
    readFileSync(DEFAULT_PAGE_PATH, 'utf8') + '\n<!-- var TABLE = [{ min: 75, grade: "A" }]; -->\n';
  withFiles({ index: [{ d: 'example.com', s: 91 }], page }, ({ indexPath, pagePath }) => {
    const result = runChecks({ indexPath, pagePath });
    assert.ok(result.failures.length > 0, 'expected a failure');
    assert.match(result.failures.join('\n'), /hardcodes a grade table/);
  });
});

test('the default paths point at the real artifacts', () => {
  assert.match(DEFAULT_INDEX_PATH, /apps\/web\/public\/data\/search-index\.json$/);
  assert.match(DEFAULT_PAGE_PATH, /apps\/web\/src\/pages\/.*search\.astro$/);
});

test('the guard passes on a well-formed shard tree', () => {
  withIndexTree({ entries: sampleEntries() }, ({ dataDir, indexPath, manifestPath, pagePath }) => {
    const result = runChecks({
      dataDir,
      indexPath,
      manifestPath,
      pagePath,
      buildManifestPath: join(dataDir, 'missing-index.json'),
    });
    assert.deepEqual(result.failures, []);
  });
});

test('the guard fails when a shard is missing', () => {
  withIndexTree(
    { entries: sampleEntries(), mutate: ({ dataDir }) => rmSync(join(dataDir, 'search-index/a.json')) },
    ({ dataDir, indexPath, manifestPath }) => {
      const result = runChecks({
        dataDir,
        indexPath,
        manifestPath,
        pagePath: DEFAULT_PAGE_PATH,
        buildManifestPath: join(dataDir, 'missing-index.json'),
      });
      assert.ok(result.failures.length > 0, 'expected a failure');
      assert.match(result.failures.join('\n'), /shard "a" is missing/);
    },
  );
});

test('the guard fails when a shard is not the deterministic partition', () => {
  withIndexTree(
    {
      entries: sampleEntries(),
      mutate: ({ dataDir }) =>
        writeFileSync(
          join(dataDir, 'search-index/a.json'),
          `${JSON.stringify([{ d: 'alpha.test', s: 91 }])}\n`,
          'utf8',
        ),
    },
    ({ dataDir, indexPath, manifestPath }) => {
      const result = runChecks({
        dataDir,
        indexPath,
        manifestPath,
        pagePath: DEFAULT_PAGE_PATH,
        buildManifestPath: join(dataDir, 'missing-index.json'),
      });
      assert.ok(result.failures.length > 0, 'expected a failure');
      assert.match(result.failures.join('\n'), /deterministic partition/);
    },
  );
});

test('the guard fails when the union misses a rated site', () => {
  const dir = mkdtempSync(join(tmpdir(), 'afr-search-tree-'));
  try {
    const dataDir = join(dir, 'data');
    mkdirSync(join(dataDir, 'search-index'), { recursive: true });
    const entries = sampleEntries();
    const serialize = (list) => `${JSON.stringify(list)}\n`;
    const shards = assignShards(entries);
    const sizes = {};
    for (const [id, list] of shards) {
      const text = serialize(list);
      sizes[id] = { raw: Buffer.byteLength(text, 'utf8'), wire: brotliBytes(text) };
      writeFileSync(join(dataDir, shardFileFor(id)), text, 'utf8');
    }
    const top = entries.slice(0, 2);
    writeFileSync(join(dataDir, SEARCH_TOP_FILE), serialize(top), 'utf8');
    const manifest = buildShardManifest({ shards, top, entries: entries.length, sizes });
    writeFileSync(join(dataDir, SEARCH_MANIFEST_FILE), `${JSON.stringify(manifest)}\n`, 'utf8');
    writeFileSync(join(dataDir, 'search-index.json'), serialize(entries), 'utf8');
    // the build reports one more rated site than the shards hold
    writeFileSync(join(dataDir, 'index.json'), JSON.stringify({ scored: entries.length + 1 }), 'utf8');
    const result = runChecks({
      dataDir,
      indexPath: join(dataDir, 'search-index.json'),
      manifestPath: join(dataDir, SEARCH_MANIFEST_FILE),
      pagePath: DEFAULT_PAGE_PATH,
      buildManifestPath: join(dataDir, 'index.json'),
    });
    assert.ok(result.failures.length > 0, 'expected a failure');
    assert.match(result.failures.join('\n'), /a rated site is missing/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the guard fails when the leaderboard slice is not the head of the shards', () => {
  withIndexTree(
    {
      entries: sampleEntries(),
      mutate: ({ dataDir }) =>
        writeFileSync(
          join(dataDir, SEARCH_TOP_FILE),
          `${JSON.stringify([{ d: 'gamma.test', s: 70 }])}\n`,
          'utf8',
        ),
    },
    ({ dataDir, indexPath, manifestPath }) => {
      const result = runChecks({
        dataDir,
        indexPath,
        manifestPath,
        pagePath: DEFAULT_PAGE_PATH,
        buildManifestPath: join(dataDir, 'missing-index.json'),
      });
      assert.ok(result.failures.length > 0, 'expected a failure');
      assert.match(result.failures.join('\n'), /leaderboard slice is not the head/);
    },
  );
});

test('the guard fails when the page stops reading the shard manifest', () => {
  const page = readFileSync(DEFAULT_PAGE_PATH, 'utf8').replace(
    "search-index-manifest.json",
    "search-index-other.json",
  );
  withFiles({ index: [{ d: 'example.com', s: 91 }], page }, ({ indexPath, pagePath }) => {
    const result = runChecks({ indexPath, pagePath });
    assert.ok(result.failures.length > 0, 'expected a failure');
    assert.match(result.failures.join('\n'), /does not read the shard manifest/);
  });
});

test('the guard fails when the page drops the legacy fallback', () => {
  const page = readFileSync(DEFAULT_PAGE_PATH, 'utf8').replace(
    "var LEGACY_URL = DATA_DIR + 'search-index.json';",
    "var LEGACY_URL = DATA_DIR + 'nope.json';",
  );
  withFiles({ index: [{ d: 'example.com', s: 91 }], page }, ({ indexPath, pagePath }) => {
    const result = runChecks({ indexPath, pagePath });
    assert.ok(result.failures.length > 0, 'expected a failure');
    assert.match(result.failures.join('\n'), /no fallback to the legacy single index/);
  });
});
