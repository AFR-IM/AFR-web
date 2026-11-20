// scripts/check-search-index.test.mjs — the search-index guard must pass on the
// current tree, and it must actually fail when the contract is broken (a
// guard that cannot fail is worse than none).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runChecks, DEFAULT_INDEX_PATH, DEFAULT_PAGE_PATH } from './check-search-index.mjs';

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
