// scripts/measure-corpus-coverage.test.mjs — the expansion gate must measure
// the catalog the way the site build measures it, and it must fail closed.
//
// Fully offline: no network, no data repo, no D1. The corpus is a throwaway
// directory of fake snapshots.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  SEGMENT_SIZE,
  THRESHOLD,
  countNeeded,
  decide,
  isJunkTitle,
  measureCorpus,
} from './measure-corpus-coverage.mjs';
import { THRESHOLD as GATE_THRESHOLD } from './measure-classification.mjs';

const here = resolve(fileURLToPath(import.meta.url), '..');
const SCRIPT = resolve(here, 'measure-corpus-coverage.mjs');

/** One snapshot, shaped like the scanner's output. */
function snap(domain, { title, meta, body, noTitle = false } = {}) {
  const homepage = { url: `https://${domain}/`, status: 200 };
  if (!noTitle) homepage.title = title;
  if (body !== undefined) homepage.body = body;
  if (meta) homepage.meta = meta;
  return {
    signals: { domain, homepage },
    afr: {
      domain,
      score: 50,
      grade: 'C',
      state: 'scored',
      layers: [],
      scannedAt: '2026-01-01T00:00:00.000Z',
    },
  };
}

/**
 * A throwaway corpus.
 *   days   [{date: '2026-11-20', sites: {domain: snapshot}}]
 *   cursor {lastRank, updatedAt} | null
 */
function withCorpus(days, cursor, run) {
  const root = mkdtempSync(join(tmpdir(), 'afr-corpus-'));
  try {
    const scans = join(root, 'scans');
    mkdirSync(scans, { recursive: true });
    for (const day of days) {
      const dir = join(scans, ...day.date.split('-'));
      mkdirSync(dir, { recursive: true });
      for (const [domain, snapshot] of Object.entries(day.sites ?? {})) {
        writeFileSync(join(dir, `${domain}.json`), JSON.stringify(snapshot));
      }
    }
    const cursorPath = join(root, 'scan-cursor.json');
    if (cursor) writeFileSync(cursorPath, JSON.stringify(cursor));
    return run({ scans, cursorPath });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/** n sites that classify (dev-tools) and m that do not. */
function sites(n, m, prefix = 'site') {
  const out = {};
  for (let i = 0; i < n; i++) out[`${prefix}-ok-${i}.github.io`] = snap(`${prefix}-ok-${i}.github.io`, { title: 'GitHub' });
  for (let i = 0; i < m; i++) out[`${prefix}-no-${i}.example`] = snap(`${prefix}-no-${i}.example`, { title: 'Welcome home' });
  return out;
}

// ── the vocabulary comes from one place ────────────────────────────────────

test('the threshold and the junk-title rule are the ones of the classification gate', () => {
  assert.equal(THRESHOLD, GATE_THRESHOLD);
  assert.equal(THRESHOLD, 0.6);
  assert.equal(isJunkTitle('Just a moment...'), true);
  assert.equal(isJunkTitle('403 Forbidden'), true);
  assert.equal(isJunkTitle('A real site'), false);
});

// ── the judgable pool ──────────────────────────────────────────────────────

test('the judgable pool holds the sites with a usable title, and only those', () => {
  withCorpus(
    [
      {
        date: '2026-11-20',
        sites: {
          'github.com': snap('github.com', { title: 'GitHub' }),
          'plain.example': snap('plain.example', { title: 'Welcome home' }),
          'blocked.example': snap('blocked.example', { title: 'Just a moment...' }),
          'notfound.example': snap('notfound.example', { title: '404 Not Found' }),
          'silent.example': snap('silent.example', { noTitle: true }),
        },
      },
    ],
    { lastRank: 1000, updatedAt: '2026-11-20' },
    ({ scans, cursorPath }) => {
      const m = measureCorpus({ dataDir: scans, cursorPath });
      // 5 snapshots, 3 of them without a usable title (a challenge page, a
      // 404 and a homepage that could not be read) -> 2 judgable,
      // 1 of them classified (github.com is dev-tools in the rule table).
      assert.equal(m.global.domains, 5);
      assert.equal(m.global.judgable, 2);
      assert.equal(m.global.classified, 1);
      assert.equal(m.global.coverage, 0.5);
    },
  );
});

test('a title that only lives in the body is still a title', () => {
  withCorpus(
    [
      {
        date: '2026-11-20',
        sites: {
          'github.com': snap('github.com', { body: '<html><head><title>GitHub</title></head></html>' }),
        },
      },
    ],
    { lastRank: 1000, updatedAt: '2026-11-20' },
    ({ scans, cursorPath }) => {
      const m = measureCorpus({ dataDir: scans, cursorPath });
      assert.equal(m.global.judgable, 1);
      assert.equal(m.global.classified, 1);
    },
  );
});

// ── the merged view ───────────────────────────────────────────────────────

test('the newest snapshot of a domain wins, the older one is not counted twice', () => {
  withCorpus(
    [
      { date: '2026-11-20', sites: { 'x.example': snap('x.example', { title: 'Welcome home' }) } },
      {
        date: '2026-11-21',
        sites: { 'x.example': snap('x.example', { title: 'Breaking News - Daily Report' }) },
      },
    ],
    { lastRank: 2000, updatedAt: '2026-11-21' },
    ({ scans, cursorPath }) => {
      const m = measureCorpus({ dataDir: scans, cursorPath });
      assert.equal(m.global.domains, 1);
      assert.equal(m.global.judgable, 1);
      assert.equal(m.global.classified, 1);
      // the per-day numbers keep both days apart
      assert.equal(m.dates.length, 2);
      assert.equal(m.dates[0].classified, 0);
      assert.equal(m.dates[1].classified, 1);
    },
  );
});

// ── which directory is the last segment ───────────────────────────────────

test('the last segment is the day the cursor advanced, not the newest directory', () => {
  withCorpus(
    [
      { date: '2026-11-20', sites: sites(4, 0, 'seg') },
      // the weekly head rescan wrote into a newer directory — it is not the
      // segment that walked the tail of the Tranco list
      { date: '2026-11-21', sites: sites(9, 0, 'head') },
    ],
    { lastRank: 12000, updatedAt: '2026-11-20' },
    ({ scans, cursorPath }) => {
      const m = measureCorpus({ dataDir: scans, cursorPath });
      assert.equal(m.segment.date, '2026-11-20');
      assert.equal(m.segment.source, 'cursor');
      assert.equal(m.segment.judgable, 4);
      assert.equal(m.segment.classified, 4);
    },
  );
});

test('without a cursor the newest full segment is used', () => {
  withCorpus(
    [
      { date: '2026-11-20', sites: sites(2, 0, 'a') },
      { date: '2026-11-21', sites: sites(3, 0, 'b') },
    ],
    null,
    ({ scans, cursorPath }) => {
      const m = measureCorpus({ dataDir: scans, cursorPath, segmentSize: 1 });
      assert.equal(m.segment.date, '2026-11-21');
      assert.equal(m.segment.source, 'largest-recent');
    },
  );
});

// ── the gate ──────────────────────────────────────────────────────────────

test('a healthy corpus opens the gate', () => {
  withCorpus(
    [{ date: '2026-11-20', sites: sites(10, 0, 'ok') }],
    { lastRank: 1000, updatedAt: '2026-11-20' },
    ({ scans, cursorPath }) => {
      const m = measureCorpus({ dataDir: scans, cursorPath });
      assert.equal(m.gate.globalOk, true);
      assert.equal(m.gate.predictedOk, true);
      assert.equal(m.gate.segmentOk, true);
      assert.equal(m.gate.pass, true);
      assert.equal(m.need.sites, 0);
    },
  );
});

test('a segment below the bar closes the gate even when the catalog is fine', () => {
  withCorpus(
    [
      { date: '2026-11-20', sites: sites(100, 0, 'old') },
      { date: '2026-11-21', sites: sites(0, 10, 'new') },
    ],
    { lastRank: 12000, updatedAt: '2026-11-21' },
    ({ scans, cursorPath }) => {
      const m = measureCorpus({ dataDir: scans, cursorPath });
      assert.equal(m.gate.globalOk, true);
      assert.equal(m.gate.segmentOk, false);
      assert.equal(m.gate.pass, false);
      // the segment has to be classified up to the threshold itself
      assert.equal(m.need.segment, 6);
      assert.equal(m.need.global, 0);
      assert.equal(m.need.sites, 6);
    },
  );
});

test('a segment that would dilute the catalog closes the gate', () => {
  withCorpus(
    [
      { date: '2026-11-20', sites: sites(10, 0, 'old') },
      { date: '2026-11-21', sites: sites(0, 10, 'new') },
    ],
    { lastRank: 12000, updatedAt: '2026-11-21' },
    ({ scans, cursorPath }) => {
      const m = measureCorpus({ dataDir: scans, cursorPath });
      // 10 classified + 10 unclassified, the segment adds 10 more judgable
      // sites that carry no category: 10/30 = 33% -> below the threshold
      assert.equal(m.gate.predictedOk, false);
      assert.equal(m.gate.pass, false);
      assert.equal(m.predicted.judgable, 30);
      assert.equal(m.predicted.classified, 10);
      assert.equal(m.need.projected, 8);
      assert.equal(m.need.sites, 8);
    },
  );
});

test('the decision and the counts are pure functions of the numbers', () => {
  const global = { judgable: 100, classified: 61, coverage: 0.61 };
  const segment = { judgable: 100, classified: 61, coverage: 0.61 };
  const predicted = { judgable: 200, classified: 122, coverage: 0.61 };
  const d = decide({ global, segment, predicted, threshold: 0.6 });
  assert.deepEqual(d, { globalOk: true, predictedOk: true, segmentOk: true, pass: true });
  const need = countNeeded({ global, segment, predicted, threshold: 0.6 });
  assert.equal(need.global, 0);
  assert.equal(need.segment, 0);
  assert.equal(need.projected, 0);
  assert.equal(need.sites, 0);
});

// ── fail closed ───────────────────────────────────────────────────────────

test('a corpus that cannot be measured throws instead of opening the gate', () => {
  assert.throws(() => measureCorpus({ dataDir: '/nonexistent/corpus' }), /not found/);
  withCorpus([], null, ({ scans, cursorPath }) => {
    assert.throws(() => measureCorpus({ dataDir: scans, cursorPath }), /no dated snapshot directories/);
  });
  withCorpus(
    [{ date: '2026-11-20', sites: { 'x.example': snap('x.example', { noTitle: true }) } }],
    { lastRank: 1000, updatedAt: '2026-11-20' },
    ({ scans, cursorPath }) => {
      assert.throws(() => measureCorpus({ dataDir: scans, cursorPath }), /no site with a usable title/);
    },
  );
});

test('the command line exits 2 without a corpus', () => {
  let code = 0;
  let out = '';
  try {
    out = execFileSync(process.execPath, [SCRIPT, '--data-dir', '/nonexistent/corpus', '--json'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    code = err.status;
    out = err.stdout ?? '';
  }
  assert.equal(code, 2);
  const payload = JSON.parse(out);
  assert.equal(payload.ok, false);
  assert.equal(payload.gate.pass, false);
});

test('the command line exits 1 with --fail when the gate is closed', () => {
  withCorpus(
    [
      { date: '2026-11-20', sites: sites(100, 0, 'old') },
      { date: '2026-11-21', sites: sites(0, 10, 'new') },
    ],
    { lastRank: 12000, updatedAt: '2026-11-21' },
    ({ scans, cursorPath }) => {
      let code = 0;
      try {
        execFileSync(process.execPath, [SCRIPT, '--data-dir', scans, '--cursor', cursorPath, '--fail', '--json'], {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch (err) {
        code = err.status;
      }
      assert.equal(code, 1);
    },
  );
});

test('the segment size is the one the cursor advances in', () => {
  assert.equal(SEGMENT_SIZE, 1000);
});
