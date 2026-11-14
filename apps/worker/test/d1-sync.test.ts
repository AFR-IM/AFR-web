// test/d1-sync.test.ts — snapshot → D1 upsert with a fake fetch (no network).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Grade } from '../../../packages/shared/src/index.ts';
import { DATA_REPO_RAW, type Snapshot, syncDate } from '../src/d1-sync.ts';
import { openSeededDb } from './helpers.ts';

const DATE = '2026/11/10';
const LISTING_URL = `https://api.github.com/repos/AFR-IM/AFR-data/git/trees/main:scans/${DATE}`;
const SNAPSHOT_PATH = `scans/${DATE}/acme.dev.json`;

/** Content-sensitive fake of a git blob sha (changes when the payload changes) */
function fakeSha(value: unknown): string {
  const s = JSON.stringify(value);
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h.toString(16);
}

/** Fixture shaped like a real AFR-data snapshot ({ signals, afr }) */
function makeSnapshot(score: number, grade: Grade): Snapshot {
  return {
    signals: {
      domain: 'acme.dev',
      fetchedAt: '2026-11-10T11:42:36.513Z',
      scannerVersion: 'scanner-0.1.0',
    },
    afr: {
      domain: 'acme.dev',
      engineVersion: 'afr-1.0.0',
      scannerVersion: 'scanner-0.1.0',
      scannedAt: '2026-11-10T11:42:36.513Z',
      score,
      grade,
      strategyTag: 'Middle-Path',
      layers: [
        {
          layer: 'L1',
          name: 'Reachable',
          awarded: 30,
          max: 35,
          checks: [
            {
              id: 'A1.gptbot',
              layer: 'L1',
              name: 'robots allows GPTBot',
              awarded: 3,
              max: 3,
              status: 'pass',
              evidence: { source: 'robots.txt', detail: 'User-agent: GPTBot / Allow: /' },
            },
            { id: 'A2.nojs', layer: 'L1', name: 'no JS wall', awarded: 3, max: 3, status: 'pass' },
          ],
        },
        {
          layer: 'L2',
          name: 'Legible',
          awarded: 30,
          max: 40,
          checks: [
            {
              id: 'B1.llms-txt',
              layer: 'L2',
              name: 'llms.txt exists',
              awarded: 0,
              max: 8,
              status: 'fail',
              evidence: { source: 'GET /llms.txt', detail: 'HTTP 404' },
            },
          ],
        },
        { layer: 'L3', name: 'Actionable', awarded: 15, max: 25, checks: [] },
      ],
      breakdown: { 'A1.gptbot': 3, 'A2.nojs': 3 },
    },
  };
}

interface FakeFetchOptions {
  listingStatus?: number;
  /** Snapshot path → payload; a path mapped to null returns HTTP 404 */
  files?: Record<string, unknown>;
  /** Skip raw fetches entirely (asserts sha-skip behaviour) */
  noRaw?: boolean;
}

function fakeFetch(options: FakeFetchOptions = {}) {
  const calls: string[] = [];
  const files = options.files ?? { [SNAPSHOT_PATH]: makeSnapshot(87, 'B') };
  const impl = (async (input: RequestInfo | URL): Promise<Response> => {
    const url = String(input);
    calls.push(url);
    if (url === LISTING_URL) {
      if (options.listingStatus && options.listingStatus >= 400) {
        return new Response('boom', { status: options.listingStatus });
      }
      // Git Trees shape: entries are relative to the queried subtree (bare
      // filenames), each carrying its blob sha; truncated=false.
      const tree = Object.keys(files)
        .sort()
        .map((path) => ({ path: path.split('/').pop(), type: 'blob', sha: fakeSha(files[path]) }));
      return Response.json({ sha: 'roottree', tree, truncated: false });
    }
    if (!options.noRaw && url.startsWith(`${DATA_REPO_RAW}/`)) {
      const path = url.slice(DATA_REPO_RAW.length + 1);
      if (path in files && files[path] !== null) return Response.json(files[path]);
    }
    return new Response('not found', { status: 404 });
  }) as typeof fetch;
  return { impl, calls };
}

describe('syncDate', () => {
  it('upserts sites, scans and evidence from the day listing', async () => {
    const { db, raw } = openSeededDb();
    const { impl } = fakeFetch();

    const result = await syncDate(DATE, { db, fetchImpl: impl });
    assert.equal(result.listed, 1);
    assert.equal(result.sitesUpserted, 1);
    assert.equal(result.scansUpserted, 1);
    assert.equal(result.evidenceRows, 3);
    assert.deepEqual(result.errors, []);

    const site = raw
      .prepare('SELECT grade, score_total, score_l1, score_l2, score_l3, status FROM sites WHERE domain = ?')
      .get('acme.dev') as Record<string, unknown>;
    assert.equal(site.grade, 'B');
    assert.equal(site.score_total, 87);
    assert.equal(site.score_l1, 30);
    assert.equal(site.score_l2, 30);
    assert.equal(site.score_l3, 15);
    assert.equal(site.status, 'active');

    const scan = raw
      .prepare('SELECT id, engine_version, snapshot_path, started_at FROM scans WHERE domain = ?')
      .get('acme.dev') as { id: number; engine_version: string; snapshot_path: string; started_at: string };
    assert.equal(scan.engine_version, 'afr-1.0.0');
    assert.equal(scan.snapshot_path, SNAPSHOT_PATH);
    assert.equal(scan.started_at, '2026-11-10T11:42:36.513Z');

    const evidence = raw
      .prepare('SELECT check_id, status, points, max_points, evidence_type FROM evidence WHERE scan_id = ? ORDER BY rowid')
      .all(scan.id) as Record<string, unknown>[];
    assert.equal(evidence.length, 3);
    assert.equal(evidence[0]?.check_id, 'A1.gptbot');
    assert.equal(evidence[0]?.status, 'pass');
    assert.equal(evidence[0]?.points, 3);
    assert.equal(evidence[0]?.max_points, 3);
    assert.equal(evidence[0]?.evidence_type, 'robots.txt');
    assert.equal(evidence[2]?.check_id, 'B1.llms-txt');
    assert.equal(evidence[2]?.status, 'fail');
  });

  it('is idempotent: re-syncing the same date updates instead of duplicating', async () => {
    const { db, raw } = openSeededDb();
    const first = fakeFetch();
    await syncDate(DATE, { db, fetchImpl: first.impl });

    // second run with a changed score (engine re-run on the same snapshot path)
    const second = fakeFetch({
      files: { [SNAPSHOT_PATH]: makeSnapshot(91, 'A') },
    });
    const result = await syncDate(DATE, { db, fetchImpl: second.impl });
    assert.equal(result.sitesUpserted, 1);
    assert.deepEqual(result.errors, []);

    const siteCount = raw.prepare("SELECT COUNT(*) AS n FROM sites WHERE domain = 'acme.dev'").get() as { n: number };
    assert.equal(siteCount.n, 1);
    const scanCount = raw.prepare("SELECT COUNT(*) AS n FROM scans WHERE domain = 'acme.dev'").get() as { n: number };
    assert.equal(scanCount.n, 1, 'scan row must be updated, not inserted');
    const evidenceCount = raw
      .prepare('SELECT COUNT(*) AS n FROM evidence e JOIN scans s ON s.id = e.scan_id WHERE s.domain = ?')
      .get('acme.dev') as { n: number };
    assert.equal(evidenceCount.n, 3, 'evidence rows must be replaced, not appended');

    const site = raw.prepare('SELECT grade, score_total FROM sites WHERE domain = ?').get('acme.dev') as {
      grade: string;
      score_total: number;
    };
    assert.equal(site.grade, 'A');
    assert.equal(site.score_total, 91);
  });

  it('keeps human-curated site fields untouched on upsert', async () => {
    const { db, raw } = openSeededDb();
    raw.prepare("UPDATE sites SET title = 'Curated Title', category_id = 3 WHERE domain = 'example.com'").run();

    // craft a snapshot for an existing curated site
    const snapshot = makeSnapshot(50, 'C');
    snapshot.afr.domain = 'example.com';
    snapshot.signals.domain = 'example.com';
    const path = `scans/${DATE}/example.com.json`;
    const { impl } = fakeFetch({ files: { [path]: snapshot } });

    await syncDate(DATE, { db, fetchImpl: impl });
    const site = raw
      .prepare('SELECT title, category_id, score_total FROM sites WHERE domain = ?')
      .get('example.com') as { title: string; category_id: number; score_total: number };
    assert.equal(site.title, 'Curated Title', 'title must not be overwritten by the scanner');
    assert.equal(site.category_id, 3, 'category mapping must not be overwritten');
    assert.equal(site.score_total, 50, 'scores must be refreshed');
  });

  it('records per-file fetch errors without aborting the run', async () => {
    const { db } = openSeededDb();
    const brokenPath = `scans/${DATE}/broken.example.json`;
    const { impl } = fakeFetch({
      files: { [brokenPath]: null as unknown as Snapshot, [SNAPSHOT_PATH]: makeSnapshot(70, 'B') },
    });

    const result = await syncDate(DATE, { db, fetchImpl: impl });
    assert.equal(result.listed, 2);
    assert.equal(result.sitesUpserted, 1);
    assert.equal(result.errors.length, 1);
    assert.equal(result.errors[0]?.path, brokenPath);
    assert.match(result.errors[0]?.message ?? '', /404/);
  });

  it('throws when the directory listing fails and rejects malformed dates', async () => {
    const { db } = openSeededDb();
    const failing = fakeFetch({ listingStatus: 500 });
    await assert.rejects(
      syncDate(DATE, { db, fetchImpl: failing.impl }),
      /listing failed: HTTP 500/,
    );
    await assert.rejects(syncDate('2026-11-10', { db, fetchImpl: failing.impl }), /invalid date/);
  });

  it('skips files whose stored snapshot_sha matches the listing (no raw fetch)', async () => {
    const { db, raw } = openSeededDb();
    const first = fakeFetch();
    await syncDate(DATE, { db, fetchImpl: first.impl });
    const sha = raw
      .prepare('SELECT snapshot_sha FROM scans WHERE snapshot_path = ?')
      .get(SNAPSHOT_PATH) as { snapshot_sha: string | null };
    assert.ok(sha.snapshot_sha, 'sha must be committed after a successful sync');

    // Second run: listing still shows the same blob sha → skip without fetching.
    const second = fakeFetch({ noRaw: true });
    const result = await syncDate(DATE, { db, fetchImpl: second.impl });
    assert.equal(result.listed, 1);
    assert.equal(result.skipped, 1);
    assert.equal(result.sitesUpserted, 0);
    assert.equal(result.nextOffset, null);
    assert.equal(
      second.calls.filter((u) => u.startsWith(DATA_REPO_RAW)).length,
      0,
      'a matching sha must not trigger a raw fetch',
    );
  });

  it('re-fetches when the blob sha changes (engine re-run / same-day rescan)', async () => {
    const { db, raw } = openSeededDb();
    await syncDate(DATE, { db, fetchImpl: fakeFetch().impl });

    // Same path, new content → new blob sha → must be pulled and applied.
    const rescanned = fakeFetch({ files: { [SNAPSHOT_PATH]: makeSnapshot(95, 'A') } });
    const result = await syncDate(DATE, { db, fetchImpl: rescanned.impl });
    assert.equal(result.skipped, 0);
    assert.equal(result.sitesUpserted, 1);
    const row = raw.prepare('SELECT score_total FROM sites WHERE domain = ?').get('acme.dev') as {
      score_total: number;
    };
    assert.equal(row.score_total, 95);
  });

  it('pages through the listing with offset/limit until nextOffset is null', async () => {
    const { db, raw } = openSeededDb();
    const pathA = `scans/${DATE}/aaa.json`;
    const pathB = `scans/${DATE}/bbb.json`;
    const snapA = makeSnapshot(60, 'D');
    const snapB = makeSnapshot(70, 'C');
    (snapA.afr as { domain: string }).domain = 'aaa.test';
    (snapA.signals as { domain: string }).domain = 'aaa.test';
    (snapB.afr as { domain: string }).domain = 'bbb.test';
    (snapB.signals as { domain: string }).domain = 'bbb.test';
    const { impl } = fakeFetch({ files: { [pathA]: snapA, [pathB]: snapB } });

    const page1 = await syncDate(DATE, { db, fetchImpl: impl }, { offset: 0, limit: 1 });
    assert.equal(page1.listed, 2);
    assert.equal(page1.scansUpserted, 1, 'limit=1 → only aaa.test on page 1');
    assert.equal(page1.nextOffset, 1);

    const page2 = await syncDate(DATE, { db, fetchImpl: impl }, { offset: page1.nextOffset!, limit: 1 });
    assert.equal(page2.scansUpserted, 1);
    assert.equal(page2.nextOffset, null, 'end of listing → done');

    const n = raw
      .prepare(
        'SELECT COUNT(*) AS n FROM scans WHERE snapshot_path = ? OR snapshot_path = ?',
      )
      .get(pathA, pathB) as { n: number };
    assert.equal(n.n, 2);
  });

  it('never lets an older snapshot downgrade a newer site score', async () => {
    const { db, raw } = openSeededDb();
    // example.com seed: scanned_at 2026-11-10T10:00, score 92.
    const stale = makeSnapshot(50, 'C');
    (stale.afr as { domain: string }).domain = 'example.com';
    (stale.signals as { domain: string }).domain = 'example.com';
    (stale.afr as { scannedAt: string }).scannedAt = '2026-11-01T00:00:00.000Z'; // older
    const path = `scans/${DATE}/example.com.json`;
    const { impl } = fakeFetch({ files: { [path]: stale } });

    const result = await syncDate(DATE, { db, fetchImpl: impl });
    assert.equal(result.sitesUpserted, 0, 'stale write must be guarded');
    assert.equal(result.scansUpserted, 1, 'the scan row still lands (history is kept)');
    const site = raw
      .prepare('SELECT score_total, scanned_at FROM sites WHERE domain = ?')
      .get('example.com') as { score_total: number; scanned_at: string };
    assert.equal(site.score_total, 92, 'live score must stay at the newer scan');
    assert.equal(site.scanned_at, '2026-11-10T10:00:00.000Z');
  });
});
