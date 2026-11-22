// scripts/backfill-tranco-ranks.test.mjs — the Tranco rank backfill must
// read the list the way the segments were cut from, and touch only the rows
// whose rank is still missing.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseList, updateStatements } from './backfill-tranco-ranks.mjs';

test('the list is read as "rank,domain"', () => {
  const ranks = parseList(['1,google.com', '2,cloudflare.com', '35,github.com', ''].join('\n'));
  assert.equal(ranks.get('google.com'), 1);
  assert.equal(ranks.get('cloudflare.com'), 2);
  assert.equal(ranks.get('github.com'), 35);
  assert.equal(ranks.size, 3);
});

test('the domains are lower-cased', () => {
  const ranks = parseList('4,GitHub.com\n');
  assert.equal(ranks.get('github.com'), 4);
});

test('a site that is not in the list keeps no rank', () => {
  const ranks = parseList('1,google.com\n');
  assert.equal(ranks.get('afr.im'), undefined);
});

test('the update only touches rows whose rank is missing', () => {
  const stmts = updateStatements([{ domain: 'a.com', rank: 12 }]);
  assert.equal(stmts.length, 1);
  assert.match(stmts[0], /sites\.rank IS NULL/);
  assert.match(stmts[0], /rank_source = 'tranco'/);
  assert.doesNotMatch(stmts[0], /INSERT/i);
});

test('the statements stay under the size budget', () => {
  const many = Array.from({ length: 5000 }, (_, i) => ({ domain: `d${i}.com`, rank: i + 1 }));
  const stmts = updateStatements(many, 2000);
  assert.ok(stmts.length > 1);
  for (const sql of stmts) assert.ok(sql.length <= 2200, `statement too large: ${sql.length}`);
});
