// test/d1-sync-throughput.test.ts — the D1 sync page pipeline.
//
// The 2026-11-18 incident: one CI page of 32 fresh snapshots took ~2.5
// minutes because every snapshot was fetched and written strictly one after
// the other, so a full scan day needed ~80 minutes and never fit into the
// 60-minute job. These tests pin the properties that fix that:
//   - the raw fetches of a page overlap, but never exceed the Worker's
//     six-simultaneous-connections budget;
//   - the D1 writes of a page overlap as well, within a small fan-out;
//   - the evidence rows of one snapshot go out in a single statement
//     (chunked at D1's 100 bound-parameter limit);
//   - a snapshot whose check id appears twice, or whose evidence row was
//     already written by a concurrent sync, still lands (no UNIQUE abort).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { CheckResult, Grade } from '../../../packages/shared/src/index.ts';
import {
  DATA_REPO_RAW,
  DB_CONCURRENCY,
  SYNC_CONCURRENCY,
  syncDate,
  type Snapshot,
} from '../src/d1-sync.ts';
import type { Db, Prepared, Row, SqlParam } from '../src/db.ts';
import { openSeededDb } from './helpers.ts';

const DATE = '2026/11/19';

/** Snapshot with `checkCount` distinct checks (ids c0..cN) for `domain`. */
function makeSnapshot(domain: string, checkCount: number, score = 80, grade: Grade = 'B'): Snapshot {
  const checks: CheckResult[] = Array.from({ length: checkCount }, (_, i) => ({
    id: `c${i}.check`,
    layer: 'L1',
    name: `check ${i}`,
    awarded: 2,
    max: 3,
    status: 'pass',
    evidence: { source: 'robots.txt', detail: `detail ${i}` },
  }));
  return {
    signals: {
      domain,
      fetchedAt: '2026-11-19T09:00:00.000Z',
      scannerVersion: 'scanner-0.1.0',
    },
    afr: {
      domain,
      engineVersion: 'afr-1.3.0',
      scannerVersion: 'scanner-0.1.0',
      scannedAt: '2026-11-19T09:00:00.000Z',
      score,
      grade,
      state: 'scored',
      strategyTag: 'Middle-Path',
      layers: [{ layer: 'L1', name: 'Reachable', awarded: 10, max: 12, checks }],
      breakdown: {},
    },
  };
}

/** Content-sensitive fake of a git blob sha (changes when the payload changes) */
function fakeSha(value: unknown): string {
  const s = JSON.stringify(value);
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h.toString(16);
}

interface FakeFetchStats {
  calls: string[];
  maxInFlight: number;
}

function fakeFetch(files: Record<string, unknown>, delayMs = 5): { impl: typeof fetch; stats: FakeFetchStats } {
  const stats: FakeFetchStats = { calls: [], maxInFlight: 0 };
  let inFlight = 0;
  const impl = (async (input: RequestInfo | URL): Promise<Response> => {
    const url = String(input);
    if (url.startsWith('https://api.github.com/repos/AFR-IM/AFR-data/git/trees/main:scans/')) {
      const tree = Object.keys(files)
        .sort()
        .map((path) => ({ path: path.split('/').pop(), type: 'blob', sha: fakeSha(files[path]) }));
      return Response.json({ sha: 'roottree', tree, truncated: false });
    }
    stats.calls.push(url);
    // Only raw snapshot fetches count towards the connection budget.
    inFlight += 1;
    stats.maxInFlight = Math.max(stats.maxInFlight, inFlight);
    try {
      await new Promise((r) => setTimeout(r, delayMs));
      const path = url.slice(DATA_REPO_RAW.length + 1);
      if (path in files) return Response.json(files[path]);
      return new Response('not found', { status: 404 });
    } finally {
      inFlight -= 1;
    }
  }) as typeof fetch;
  return { impl, stats };
}

/** Wrap a Db so every statement goes through an async gap (lets a test see
 * how many statements are in flight at the same time) and so the executed
 * SQL can be inspected. */
function instrumentDb(
  db: Db,
  opts: { delayMs?: number; onStatement?: (sql: string) => void } = {},
): { db: Db; maxInFlight: number; statements: string[] } {
  const statements: string[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const wrap = (sql: string, p: Prepared): Prepared => ({
    async all<T = Row>(...params: SqlParam[]): Promise<T[]> {
      statements.push(sql);
      opts.onStatement?.(sql);
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      try {
        if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
        return await p.all<T>(...params);
      } finally {
        inFlight -= 1;
      }
    },
    async get<T = Row>(...params: SqlParam[]): Promise<T | undefined> {
      statements.push(sql);
      opts.onStatement?.(sql);
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      try {
        if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
        return await p.get<T>(...params);
      } finally {
        inFlight -= 1;
      }
    },
    async run(...params: SqlParam[]): Promise<{ changes: number; lastInsertRowid: number }> {
      statements.push(sql);
      opts.onStatement?.(sql);
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      try {
        if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
        return await p.run(...params);
      } finally {
        inFlight -= 1;
      }
    },
  });
  return {
    db: {
      prepare: (sql: string) => wrap(sql, db.prepare(sql)),
      exec: (sql: string) => db.exec(sql),
    },
    get maxInFlight() {
      return maxInFlight;
    },
    statements,
  };
}

describe('sync page pipeline', () => {
  it('advances the cursor past snapshots that keep failing to download', async () => {
    // Regression (2026-11-18): a snapshot whose download always fails stayed
    // at the same cursor forever, so the sync-site loop re-requested the very
    // same page until the CI job timed out (226 MB of identical log lines).
    // The cursor must always move forward, even over failed snapshots.
    const { db } = openSeededDb();
    const files: Record<string, unknown> = {};
    for (let i = 0; i < 40; i++) {
      files[`scans/${DATE}/site${i}.test.json`] = makeSnapshot(`site${i}.test`, 3);
    }
    const { impl } = fakeFetch(files);

    // Two snapshots are listed but not fetchable: the listing promises them,
    // the raw download 404s.
    const broken = new Set(['unreachable-a.json', 'unreachable-b.json']);
    const listing = impl as unknown as (input: RequestInfo | URL) => Promise<Response>;
    const fetchImpl: typeof fetch = async (input: RequestInfo | URL): Promise<Response> => {
      const url = String(input);
      if (url.includes('/git/trees/')) {
        const tree = [
          ...Object.keys(files).map((path) => ({
            path: path.split('/').pop(),
            type: 'blob',
            sha: fakeSha(files[path]),
          })),
          ...[...broken].map((name) => ({ path: name, type: 'blob', sha: 'broken-sha' })),
        ];
        return Response.json({ sha: 'roottree', tree, truncated: false });
      }
      return listing(input);
    };

    // Page like sync-site.yml does: follow nextOffset until it is null.
    const offsets: number[] = [];
    let totalErrors = 0;
    let offset = 0;
    for (let page = 0; page < 20; page++) {
      const res = await syncDate(DATE, { db, fetchImpl }, { offset, limit: 20 });
      offsets.push(offset);
      totalErrors += res.errors.length;
      if (res.nextOffset === null) {
        assert.ok(
          offsets.length < 20,
          `the walk must terminate instead of re-requesting the same page (offsets: ${offsets.join(',')})`,
        );
        assert.equal(totalErrors, 2, 'both unreachable snapshots must be reported');
        return;
      }
      assert.ok(
        res.nextOffset > offset,
        `the cursor must advance (offset ${offset} → ${res.nextOffset})`,
      );
      offset = res.nextOffset;
    }
    assert.fail('the sync walk never finished');
  });

  it('fetches the snapshots of a page concurrently, within the connection budget', async () => {
    const { db } = openSeededDb();
    const files: Record<string, unknown> = {};
    for (let i = 0; i < 20; i++) {
      files[`scans/${DATE}/site${i}.test.json`] = makeSnapshot(`site${i}.test`, 3);
    }
    const { impl, stats } = fakeFetch(files);

    const result = await syncDate(DATE, { db, fetchImpl: impl }, { limit: 20 });

    assert.equal(result.listed, 20);
    assert.equal(result.scansUpserted, 20);
    assert.deepEqual(result.errors, []);
    assert.ok(
      stats.maxInFlight > 1,
      `the raw fetches must overlap (max in flight was ${stats.maxInFlight})`,
    );
    assert.ok(
      stats.maxInFlight <= SYNC_CONCURRENCY,
      `at most ${SYNC_CONCURRENCY} simultaneous fetches (max was ${stats.maxInFlight})`,
    );
  });

  it('writes the snapshots of a page concurrently, within the D1 fan-out', async () => {
    const { db } = openSeededDb();
    const files: Record<string, unknown> = {};
    for (let i = 0; i < 12; i++) {
      files[`scans/${DATE}/site${i}.test.json`] = makeSnapshot(`site${i}.test`, 3);
    }
    const { impl } = fakeFetch(files);
    const instrumented = instrumentDb(db, { delayMs: 2 });

    const result = await syncDate(DATE, { db: instrumented.db, fetchImpl: impl }, { limit: 12 });

    assert.equal(result.scansUpserted, 12);
    assert.ok(
      instrumented.maxInFlight > 1,
      `the D1 writes must overlap (max in flight was ${instrumented.maxInFlight})`,
    );
    assert.ok(
      instrumented.maxInFlight <= DB_CONCURRENCY,
      `at most ${DB_CONCURRENCY} concurrent statements (max was ${instrumented.maxInFlight})`,
    );
  });

  it('writes the evidence rows of one snapshot with a single statement', async () => {
    const { db, raw } = openSeededDb();
    const path = `scans/${DATE}/bulk.test.json`;
    const { impl } = fakeFetch({ [path]: makeSnapshot('bulk.test', 12) });
    const instrumented = instrumentDb(db);

    const result = await syncDate(DATE, { db: instrumented.db, fetchImpl: impl });

    assert.equal(result.evidenceRows, 12);
    const evidenceInserts = instrumented.statements.filter((s) =>
      s.includes('INSERT OR REPLACE INTO evidence'),
    );
    assert.equal(evidenceInserts.length, 1, '12 evidence rows must travel in one statement');
    const rows = raw
      .prepare(
        'SELECT e.check_id FROM evidence e JOIN scans s ON s.id = e.scan_id WHERE s.snapshot_path = ? ORDER BY e.check_id',
      )
      .all(path) as { check_id: string }[];
    assert.equal(rows.length, 12);
  });

  it('chunks the evidence insert at the D1 bound-parameter limit', async () => {
    const { db, raw } = openSeededDb();
    const path = `scans/${DATE}/big.test.json`;
    const { impl } = fakeFetch({ [path]: makeSnapshot('big.test', 30) });
    const instrumented = instrumentDb(db);

    const result = await syncDate(DATE, { db: instrumented.db, fetchImpl: impl });

    assert.equal(result.evidenceRows, 30);
    const evidenceInserts = instrumented.statements.filter((s) =>
      s.includes('INSERT OR REPLACE INTO evidence'),
    );
    // 30 rows → 14 + 14 + 2 (7 bound parameters per row, D1 allows 100).
    assert.equal(evidenceInserts.length, 3, 'the insert must be chunked at 14 rows');
    const n = raw
      .prepare(
        'SELECT COUNT(*) AS n FROM evidence e JOIN scans s ON s.id = e.scan_id WHERE s.snapshot_path = ?',
      )
      .get(path) as { n: number };
    assert.equal(n.n, 30);
  });

  it('lands a snapshot whose check id appears twice (one row per check id)', async () => {
    const { db, raw } = openSeededDb();
    const path = `scans/${DATE}/dup.test.json`;
    const snapshot = makeSnapshot('dup.test', 3);
    // The same check id in two layers — the UNIQUE index on
    // (scan_id, check_id) must not abort the snapshot.
    const l1 = snapshot.afr.layers[0]!;
    const l2 = { ...l1, layer: 'L2' as const, checks: [l1.checks[0]!] };
    snapshot.afr.layers = [l1, l2];
    const { impl } = fakeFetch({ [path]: snapshot });

    const result = await syncDate(DATE, { db, fetchImpl: impl });

    assert.deepEqual(result.errors, [], 'a duplicated check id must not fail the snapshot');
    assert.equal(result.scansUpserted, 1);
    const rows = raw
      .prepare(
        'SELECT e.check_id FROM evidence e JOIN scans s ON s.id = e.scan_id WHERE s.snapshot_path = ? ORDER BY e.check_id',
      )
      .all(path) as { check_id: string }[];
    assert.deepEqual(
      rows.map((r) => r.check_id),
      ['c0.check', 'c1.check', 'c2.check'],
      'the duplicated check id is stored once',
    );
  });

  it('survives an evidence row written by a concurrent sync (no UNIQUE abort)', async () => {
    const { db, raw } = openSeededDb();
    const path = `scans/${DATE}/race.test.json`;
    const { impl } = fakeFetch({ [path]: makeSnapshot('race.test', 3) });

    // Simulate a stale read: the evidence SELECT pretends the scan owns no
    // row although one is already stored — the INSERT then hits the UNIQUE
    // index, exactly like the 04:30 cron and the CI sync racing each other.
    const staling = instrumentDb(db, {
      onStatement: () => {},
    });
    let hidden = false;
    const staledDb: Db = {
      prepare: (sql: string): Prepared => {
        const inner = staling.db.prepare(sql);
        if (!sql.includes('FROM evidence WHERE scan_id')) return inner;
        return {
          async all<T = Row>(...params: SqlParam[]): Promise<T[]> {
            const rows = await inner.all<T>(...params);
            if (!hidden) {
              hidden = true;
              return rows.slice(0, 1); // pretend the row is not there yet
            }
            return rows;
          },
          get: inner.get.bind(inner),
          run: inner.run.bind(inner),
        };
      },
      exec: (sql: string) => db.exec(sql),
    };

    const result = await syncDate(DATE, { db: staledDb, fetchImpl: impl });

    assert.deepEqual(result.errors, [], 'a conflicting evidence row must not fail the snapshot');
    assert.equal(result.scansUpserted, 1);
    const rows = raw
      .prepare(
        'SELECT e.check_id FROM evidence e JOIN scans s ON s.id = e.scan_id WHERE s.snapshot_path = ? ORDER BY e.check_id',
      )
      .all(path) as { check_id: string }[];
    assert.equal(rows.length, 3, 'every wanted row is present exactly once');
    const sha = raw
      .prepare('SELECT snapshot_sha FROM scans WHERE snapshot_path = ?')
      .get(path) as { snapshot_sha: string | null };
    assert.ok(sha.snapshot_sha, 'the skip key is committed after a successful sync');
  });
});
