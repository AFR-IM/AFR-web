// scripts/measure-classification.test.mjs — the classification gate must be
// measured on the right denominator, and the measurement must hold up.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { THRESHOLD, isJunkTitle, measure } from './measure-classification.mjs';

/** A throwaway catalog. */
function withCatalog(rows, run) {
  const dir = mkdtempSync(join(tmpdir(), 'afr-classification-'));
  try {
    mkdirSync(join(dir, 'details'), { recursive: true });
    for (const row of rows) {
      writeFileSync(join(dir, 'details', `${row.domain}.json`), JSON.stringify(row));
    }
    return run(join(dir, 'details'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('an error page title is not a usable title', () => {
  assert.equal(isJunkTitle(''), true);
  assert.equal(isJunkTitle('403 Forbidden'), true);
  assert.equal(isJunkTitle('404 Not Found'), true);
  assert.equal(isJunkTitle('Just a moment...'), true);
  assert.equal(isJunkTitle('Attention Required! | Cloudflare'), true);
  assert.equal(isJunkTitle('401 Unauthorized'), true);
});

test('a real title is usable', () => {
  assert.equal(isJunkTitle('GitHub · Where the world builds software'), false);
  assert.equal(isJunkTitle('1С:Предприятие 8'), false);
  assert.equal(isJunkTitle('360 Total Security'), false);
  assert.equal(isJunkTitle('257.cz — domény'), false);
});

test('the coverage is measured on the judgable pool', () => {
  withCatalog(
    [
      { domain: 'a.com', title: 'A site', category: 'news' },
      { domain: 'b.com', title: 'Another site', category: 'other' },
      { domain: 'c.com', title: '403 Forbidden', category: 'other' },
      { domain: 'd.com', title: '', category: 'other' },
    ],
    (dir) => {
      const m = measure(dir);
      assert.equal(m.total, 4);
      assert.equal(m.classified, 1);
      assert.equal(m.noTitle, 1);
      assert.equal(m.junkTitle, 1);
      // The judgable pool holds the two sites with a real title.
      assert.equal(m.judgable, 2);
      assert.equal(m.classifiedJudgable, 1);
      assert.equal(m.coverageJudgable, 0.5);
      // The old measure (everything) is still reported.
      assert.equal(m.coverageAll, 0.25);
    },
  );
});

test('the threshold is a fraction, not a percentage', () => {
  assert.ok(THRESHOLD > 0 && THRESHOLD < 1);
});
