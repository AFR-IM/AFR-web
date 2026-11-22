// scripts/backfill-site-titles.test.mjs — the D1 title backfill must fill the
// missing titles and touch nothing else.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectRows, newestSnapshots, updateStatements } from './backfill-site-titles.mjs';

/** A scan corpus with two dates: the newer one wins. */
function withScans(run) {
  const dir = mkdtempSync(join(tmpdir(), 'afr-titles-'));
  try {
    const day = (d, domain, title) => {
      const p = join(dir, '2026', '11', d);
      mkdirSync(p, { recursive: true });
      writeFileSync(
        join(p, `${domain}.json`),
        JSON.stringify({
          signals: { domain, homepage: { status: 200, title, lang: 'en' } },
          afr: { domain, grade: 'B' },
        }),
      );
    };
    day('10', 'old.com', 'Old Title');
    day('20', 'old.com', 'New Title');
    day('20', 'new.com', 'New Site');
    day('20', 'blank.com', undefined);
    return run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('the newest snapshot of every domain wins', () => {
  withScans((dir) => {
    const newest = newestSnapshots(dir);
    assert.equal(newest.size, 3);
    const { rows } = collectRows(dir);
    const byDomain = new Map(rows.map((r) => [r.domain, r]));
    assert.equal(byDomain.get('old.com').title, 'New Title');
    assert.equal(byDomain.get('new.com').title, 'New Site');
    // A snapshot without a title carries no title — but its language still
    // counts as evidence, so the row is not dropped.
    assert.equal(byDomain.get('blank.com').title, null);
    assert.equal(byDomain.get('blank.com').lang, 'en');
  });
});

test('the update only touches rows whose title is missing', () => {
  withScans((dir) => {
    const { rows } = collectRows(dir);
    const stmts = updateStatements(rows);
    assert.equal(stmts.length, 1);
    assert.match(stmts[0], /sites\.title IS NULL OR sites\.title = ''/);
    assert.match(stmts[0], /UPDATE sites SET title = v\.title/);
    // It is an UPDATE, never an INSERT: a domain that is not in the catalog
    // must not be created.
    assert.doesNotMatch(stmts[0], /INSERT/i);
  });
});

test('the statements stay under the size budget', () => {
  withScans((dir) => {
    const { rows } = collectRows(dir);
    const many = Array.from({ length: 5000 }, (_, i) => ({
      domain: `d${i}.com`,
      title: `Title ${i}`,
      lang: 'en',
    }));
    const stmts = updateStatements([...rows, ...many], 2000);
    assert.ok(stmts.length > 1);
    for (const sql of stmts) assert.ok(sql.length <= 2200, `statement too large: ${sql.length}`);
  });
});
