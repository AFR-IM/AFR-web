// scripts/queue-title-repairs.test.mjs — the queue of the sites whose title
// was lost with the pruned bodies.
//
// What it matters: the title is the name a site shows up under. When the
// bodies were pruned, the snapshots taken before the scanner captured the
// title as a field lost it — and only a fresh scan can bring it back. The
// script that puts those domains into the ordinary scan queue must therefore
// be idempotent: running it twice must not fill the queue with the same
// domain, and it must not preempt a request that is already in flight.
//
// Run: node --test scripts/*.test.mjs

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  collectMissingTitles,
  loadMerged,
  parseArgs,
  selectQueueable,
} from './queue-title-repairs.mjs';

const here = dirname(fileURLToPath(import.meta.url));

/** A snapshot shaped like the real corpus output. */
function snapshot({ domain, homepage = {}, grade = 'B', state = 'scored' } = {}) {
  return {
    signals: {
      domain,
      fetchedAt: '2026-11-10T11:42:36.513Z',
      scannerVersion: 'scanner-0.1.0',
      homepage: { status: 200, url: `https://${domain}/`, ...homepage },
    },
    afr: {
      domain,
      engineVersion: 'afr-1.5.0',
      scannedAt: '2026-11-10T11:42:36.513Z',
      score: 80,
      grade,
      state,
      strategyTag: 'Middle-Path',
      layers: [{ layer: 'L1', name: 'Reachable', awarded: 35, max: 35, checks: [] }],
      breakdown: {},
    },
  };
}

/** A scans root with one date directory. */
function scansRoot(entries, date = ['2026', '11', '10']) {
  const root = mkdtempSync(join(tmpdir(), 'afr-repairs-'));
  const dir = join(root, ...date);
  mkdirSync(dir, { recursive: true });
  for (const [name, body] of Object.entries(entries)) {
    writeFileSync(join(dir, `${name}.json`), JSON.stringify(body), 'utf8');
  }
  return root;
}

test('a snapshot with a title field is not a repair candidate', () => {
  const root = scansRoot({
    'acme.test': snapshot({ domain: 'acme.test', homepage: { title: 'Acme Widgets' } }),
  });
  try {
    const { missing, stats } = collectMissingTitles(root);
    assert.equal(missing.length, 0);
    assert.equal(stats.missing, 0);
    assert.equal(stats.domains, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a snapshot without a title is a repair candidate', () => {
  const root = scansRoot({
    'acme.test': snapshot({ domain: 'acme.test' }),
  });
  try {
    const { missing, stats } = collectMissingTitles(root);
    assert.equal(missing.length, 1);
    assert.equal(missing[0].domain, 'acme.test');
    assert.equal(missing[0].status, 200);
    assert.equal(stats.missing, 1);
    assert.equal(stats.missingScored, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('pending sites are left out unless they are asked for', () => {
  const root = scansRoot({
    'down.test': snapshot({ domain: 'down.test', grade: 'Pending', state: 'pending' }),
  });
  try {
    assert.equal(collectMissingTitles(root).missing.length, 0);
    const withPending = collectMissingTitles(root, { includePending: true });
    assert.equal(withPending.missing.length, 1);
    assert.equal(withPending.missing[0].pending, true);
    assert.equal(withPending.stats.missingPending, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the merged view keeps the newest snapshot per domain', () => {
  const root = scansRoot(
    {
      'acme.test': snapshot({ domain: 'acme.test', homepage: { title: 'Old Name' } }),
    },
    ['2026', '11', '10'],
  );
  const newer = join(root, '2026', '11', '11');
  mkdirSync(newer, { recursive: true });
  writeFileSync(
    join(newer, 'acme.test.json'),
    JSON.stringify(snapshot({ domain: 'acme.test' })),
    'utf8',
  );
  try {
    const merged = loadMerged(root);
    assert.equal(merged.size, 1);
    assert.equal(merged.get('acme.test.json').stamp, '2026-11-11');
    // The newer snapshot has no title, so the site needs a repair.
    assert.equal(collectMissingTitles(root).missing.length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a domain that is already in the queue is not queued again', () => {
  const missing = [{ domain: 'acme.test', pending: false }];
  const submissions = new Map([
    ['acme.test', [{ domain: 'acme.test', source: 'on_demand', status: 'queued', created_at: '2026-11-20T00:00:00.000Z' }]],
  ]);
  const { queueable, skipped } = selectQueueable(missing, submissions, {
    retryDays: 30,
    limit: Infinity,
  });
  assert.equal(queueable.length, 0);
  assert.equal(skipped.active, 1);
});

test('a domain repaired recently is not queued again, an old repair is', () => {
  const missing = [{ domain: 'acme.test', pending: false }];
  const recent = new Map([
    ['acme.test', [{ domain: 'acme.test', source: 'repair', status: 'scanned', created_at: '2026-11-20T00:00:00.000Z', done_at: '2026-11-20T01:00:00.000Z' }]],
  ]);
  const old = new Map([
    ['acme.test', [{ domain: 'acme.test', source: 'repair', status: 'scanned', created_at: '2026-01-01T00:00:00.000Z', done_at: '2026-01-01T01:00:00.000Z' }]],
  ]);
  const opts = { retryDays: 30, limit: Infinity };
  assert.equal(selectQueueable(missing, recent, opts).queueable.length, 0);
  assert.equal(selectQueueable(missing, old, opts).queueable.length, 1);
});

test('the limit caps the batch and says how many were left out', () => {
  const missing = [
    { domain: 'a.test', pending: false },
    { domain: 'b.test', pending: false },
    { domain: 'c.test', pending: false },
  ];
  const { queueable, skipped } = selectQueueable(missing, new Map(), {
    retryDays: 30,
    limit: 2,
  });
  assert.equal(queueable.length, 2);
  assert.equal(skipped.limit, 1);
});

test('the arguments are read the way the usage says', () => {
  const opts = parseArgs(['--write', '--include-pending', '--retry-days', '7', '--limit', '50']);
  assert.equal(opts.write, true);
  assert.equal(opts.includePending, true);
  assert.equal(opts.retryDays, 7);
  assert.equal(opts.limit, 50);
  assert.equal(parseArgs([]).write, false);
  assert.equal(parseArgs(['--dry-run']).write, false);
});
