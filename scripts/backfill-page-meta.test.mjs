// scripts/backfill-page-meta.test.mjs — the offline backfill of the page
// metadata (title / lang / meta) into the snapshots that predate the fields.
//
// Why it matters: the raw bodies are pruned away (they are ~98% of the corpus
// and are only needed to re-judge the AI-feature signals offline). A title,
// a language or a category that only exists inside a body is lost with it.
// The backfill moves them into the snapshot itself, so the body can go.
//
// Run: node --test scripts/*.test.mjs

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyBackfill, main, parseArgs, planBackfill } from './backfill-page-meta.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');

const HTML =
  '<html lang="en"><head><title>Acme &amp; Co</title>' +
  '<meta property="og:site_name" content="Acme Widgets">' +
  '<meta name="description" content="Widgets for everyone">' +
  '</head><body>hi</body></html>';

/** A snapshot shaped like the real corpus output */
function snapshot({ homepage, extra = {} } = {}) {
  return {
    signals: {
      domain: 'acme.test',
      fetchedAt: '2026-11-10T11:42:36.513Z',
      scannerVersion: 'scanner-0.1.0',
      homepage: homepage ?? { status: 200, body: HTML, url: 'https://acme.test/' },
      ...extra,
    },
    afr: {
      domain: 'acme.test',
      engineVersion: 'afr-1.0.0',
      scannedAt: '2026-11-10T11:42:36.513Z',
      score: 87,
      grade: 'B',
      strategyTag: 'Middle-Path',
      layers: [{ layer: 'L1', name: 'Reachable', awarded: 35, max: 35, checks: [] }],
      breakdown: {},
    },
  };
}

/** Write a snapshot into a scans tree and return the tree root */
function writeTree(files) {
  const root = mkdtempSync(join(tmpdir(), 'backfill-meta-'));
  for (const [rel, content] of Object.entries(files)) {
    const target = join(root, rel);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
  return root;
}

test('parseArgs: the default is a dry run over the data dir', () => {
  const opts = parseArgs(['--data-dir', '/tmp/x']);
  assert.equal(opts.write, false);
  assert.equal(opts.dir, '/tmp/x');
  assert.equal(opts.out, null);
  assert.equal(opts.limit, Infinity);
});

test('parseArgs: --write, --out, --report, --limit and --quiet', () => {
  const opts = parseArgs([
    '--data-dir=/tmp/y',
    '--write',
    '--out=/tmp/z',
    '--report=/tmp/r.md',
    '--limit=5',
    '--quiet',
  ]);
  assert.equal(opts.write, true);
  assert.equal(opts.dir, '/tmp/y');
  assert.equal(opts.out, '/tmp/z');
  assert.equal(opts.report, '/tmp/r.md');
  assert.equal(opts.limit, 5);
  assert.equal(opts.quiet, true);
});

test('planBackfill: derives the missing fields from the stored body', () => {
  const plan = planBackfill(snapshot());
  assert.equal(plan.status, 'partial');
  assert.deepEqual(plan.additions, {
    title: 'Acme & Co',
    lang: 'en',
    meta: { ogSiteName: 'Acme Widgets', description: 'Widgets for everyone' },
  });
});

test('planBackfill: a snapshot that already has the fields is complete', () => {
  const home = {
    status: 200,
    body: HTML,
    url: 'https://acme.test/',
    title: 'Acme & Co',
    lang: 'en',
    meta: { ogSiteName: 'Acme Widgets' },
  };
  assert.equal(planBackfill(snapshot({ homepage: home })).status, 'complete');
});

test('planBackfill: a snapshot without a body is skipped, never invented', () => {
  const plan = planBackfill(snapshot({ homepage: { status: 200, url: 'https://acme.test/' } }));
  assert.equal(plan.status, 'no-body');
  assert.deepEqual(plan.additions, {});
});

test('planBackfill: a snapshot without a homepage probe is skipped', () => {
  const snap = snapshot();
  delete snap.signals.homepage;
  assert.equal(planBackfill(snap).status, 'no-homepage');
});

test('planBackfill: a page that declares nothing gets no field', () => {
  const plan = planBackfill(
    snapshot({ homepage: { status: 200, body: '<html><body>plain</body></html>' } }),
  );
  assert.equal(plan.status, 'nothing-derived');
  assert.deepEqual(plan.additions, {});
});

test('planBackfill: an existing field is never overwritten', () => {
  const home = { status: 200, body: HTML, title: 'Curated Title' };
  const plan = planBackfill(snapshot({ homepage: home }));
  assert.equal(plan.status, 'partial');
  assert.ok(!('title' in plan.additions), 'the stored title stays as it is');
  assert.equal(plan.additions.lang, 'en');
});

test('applyBackfill: only the probe changes, the rest is carried over', () => {
  const before = snapshot();
  const after = applyBackfill(before, { title: 'X', lang: 'en' });
  assert.deepEqual(after.afr, before.afr, 'the afr block (scores, evidence) must not move');
  assert.deepEqual(after.signals.aiFeatures, before.signals.aiFeatures);
  assert.equal(after.signals.homepage.body, before.signals.homepage.body);
  assert.equal(after.signals.homepage.title, 'X');
  assert.equal(after.signals.homepage.lang, 'en');
  assert.deepEqual(Object.keys(after.signals.homepage), [
    'status',
    'body',
    'url',
    'title',
    'lang',
  ]);
});

test('the backfill writes the fields into a snapshot and keeps the file style', () => {
  const root = writeTree({
    '2026/11/10/acme.test.json': JSON.stringify(snapshot(), null, 1) + '\n',
  });
  try {
    const result = main(['--data-dir', root, '--write', '--quiet']);
    assert.equal(result.stats.partial, 1);
    assert.equal(result.stats.written, 1);
    const raw = readFileSync(join(root, '2026/11/10/acme.test.json'), 'utf8');
    assert.ok(raw.endsWith('\n'), 'the trailing newline of the file is kept');
    assert.ok(raw.includes('\n "signals": {'), 'the 1-space indentation of the file is kept');
    const parsed = JSON.parse(raw);
    assert.equal(parsed.signals.homepage.title, 'Acme & Co');
    assert.equal(parsed.signals.homepage.lang, 'en');
    assert.deepEqual(parsed.signals.homepage.meta, {
      ogSiteName: 'Acme Widgets',
      description: 'Widgets for everyone',
    });
    assert.equal(parsed.signals.homepage.body, HTML, 'the body is untouched');
    assert.equal(parsed.afr.score, 87, 'the score is untouched');
    assert.deepEqual(
      Object.keys(parsed.signals.homepage),
      ['status', 'body', 'url', 'title', 'lang', 'meta'],
      'the new keys come after the ones the scanner wrote',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the backfill is idempotent: a second run changes nothing', () => {
  const root = writeTree({
    '2026/11/10/acme.test.json': JSON.stringify(snapshot(), null, 2),
  });
  try {
    const first = main(['--data-dir', root, '--write', '--quiet']);
    assert.equal(first.stats.partial, 1);
    const after = readFileSync(join(root, '2026/11/10/acme.test.json'), 'utf8');
    const second = main(['--data-dir', root, '--write', '--quiet']);
    assert.equal(second.stats.partial, 0, 'nothing left to backfill');
    assert.equal(second.stats.complete, 1);
    assert.equal(second.stats.written, 0);
    assert.equal(readFileSync(join(root, '2026/11/10/acme.test.json'), 'utf8'), after);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the backfill counts the snapshots it cannot touch', () => {
  const root = writeTree({
    '2026/11/10/nobody.test.json': JSON.stringify(
      snapshot({ homepage: { status: 200, url: 'https://nobody.test/' } }),
      null,
      2,
    ),
    '2026/11/10/acme.test.json': JSON.stringify(snapshot(), null, 2),
  });
  try {
    const result = main(['--data-dir', root, '--write', '--quiet']);
    assert.equal(result.stats.noBody, 1);
    assert.equal(result.stats.partial, 1);
    assert.equal(result.stats.written, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the web build and the D1 loader read the field first, the body second', () => {
  const fetchData = readFileSync(join(repoRoot, 'apps/web/scripts/fetch-data.mjs'), 'utf8');
  assert.ok(
    fetchData.includes('resolvePageMeta(homepage)'),
    'fetch-data.mjs must read the meta field',
  );
  assert.ok(
    !/function extractMeta\s*\(/.test(fetchData),
    'fetch-data.mjs must not keep its own meta parser (one implementation only)',
  );
  const d1Load = readFileSync(join(repoRoot, 'scripts/d1-load.mjs'), 'utf8');
  assert.ok(
    d1Load.includes('resolvePageMeta(signals.homepage)'),
    'd1-load.mjs must read the meta field',
  );
  assert.ok(
    !/const extractMeta\s*=/.test(d1Load),
    'd1-load.mjs must not keep its own meta parser (one implementation only)',
  );
});
