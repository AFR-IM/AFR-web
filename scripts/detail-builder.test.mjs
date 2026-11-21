// scripts/detail-builder.test.mjs — the one builder both the build and the
// on-demand detail pages use.
//
// Why it matters: the detail page is now rendered per request (SSOT item 20
// — 详情页按需生成), and the payload comes from the data repo's snapshot. The
// static build writes the same payload into src/data/generated/details/. If
// the two builders ever disagree, a rendered page would show something
// else than the built one — and nobody would notice, because both look
// plausible.
//
// So the builder is tested against the shapes the scanner really writes: a
// snapshot with the title captured as a field, one from before that field
// existed (the body carries it), a pending scan, and a delisted site.
//
// Run: node --test scripts/*.test.mjs

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildDetail } from '../apps/web/src/data/detail.ts';

const HTML =
  '<html lang="en"><head><title>Acme &amp; Co</title>' +
  '<meta property="og:site_name" content="Acme Widgets">' +
  '<meta name="description" content="Widgets for everyone">' +
  '</head><body>hi</body></html>';

/** A snapshot shaped like the real corpus output. */
function snapshot({ homepage = {}, grade = 'B', state = 'scored' } = {}) {
  return {
    signals: {
      domain: 'acme.test',
      fetchedAt: '2026-11-10T11:42:36.513Z',
      scannerVersion: 'scanner-0.1.0',
      homepage: { status: 200, url: 'https://acme.test/', ...homepage },
    },
    afr: {
      domain: 'acme.test',
      engineVersion: 'afr-1.5.0',
      scannerVersion: 'scanner-0.1.0',
      scannedAt: '2026-11-10T11:42:36.513Z',
      score: 87,
      grade,
      state,
      strategyTag: 'Middle-Path',
      layers: [{ layer: 'L1', name: 'Reachability', awarded: 35, max: 35, checks: [] }],
      breakdown: { 'l1.robots.ai-policy': 25 },
    },
  };
}

test('a snapshot without an afr block is not a detail page', () => {
  assert.equal(buildDetail({}, 'acme.test'), undefined);
  assert.equal(buildDetail({ afr: { score: 87 } }, 'acme.test'), undefined);
});

test('the title comes from the scanner field, and the body is the fallback', () => {
  const withField = buildDetail(snapshot({ homepage: { title: 'Acme Widgets' } }), 'acme.test');
  assert.equal(withField.title, 'Acme Widgets');

  const fromBody = buildDetail(snapshot({ homepage: { body: HTML } }), 'acme.test');
  assert.equal(fromBody.title, 'Acme & Co');
  assert.equal(fromBody.lang, 'en');
});

test('the payload carries the report, the evidence chain and the history', () => {
  const detail = buildDetail(snapshot(), 'acme.test');
  assert.equal(detail.domain, 'acme.test');
  assert.equal(detail.score, 87);
  assert.equal(detail.grade, 'B');
  assert.equal(detail.strategyTag, 'Middle-Path');
  assert.equal(detail.engineVersion, 'afr-1.5.0');
  assert.equal(detail.scannerVersion, 'scanner-0.1.0');
  assert.equal(detail.layers.length, 1);
  assert.deepEqual(detail.breakdown, { 'l1.robots.ai-policy': 25 });
  assert.deepEqual(detail.history, [{ date: '2026-11-10', score: 87, grade: 'B' }]);
});

test('a pending scan keeps its grade and claims no score', () => {
  const detail = buildDetail(snapshot({ grade: 'Pending', state: 'pending' }), 'acme.test');
  assert.equal(detail.grade, 'Pending');
  assert.equal(detail.score, 87); // the engine's raw number; the page shows "Pending"
});

test('a delisted site keeps its note', () => {
  const delisted = { 'acme.test': { noteEn: 'Retired', noteZh: '已下线' } };
  const detail = buildDetail(snapshot(), 'acme.test', delisted);
  assert.deepEqual(detail.delistedNote, { noteEn: 'Retired', noteZh: '已下线' });
  assert.equal(buildDetail(snapshot(), 'acme.test').delistedNote, undefined);
});

test('the key order is the site build order (the payload is compared byte for byte)', () => {
  const detail = buildDetail(snapshot({ homepage: { title: 'Acme Widgets' } }), 'acme.test');
  assert.deepEqual(Object.keys(detail), [
    'domain',
    'title',
    'score',
    'grade',
    'strategyTag',
    'category',
    'scannedAt',
    'engineVersion',
    'scannerVersion',
    'layers',
    'breakdown',
    'history',
  ]);
});
