// scripts/d1-load.test.mjs — the SQL d1-load generates must be idempotent:
// re-running over the same day refreshes re-scored values (DO UPDATE) and never
// duplicates scans/evidence rows. Fully offline: node:sqlite in-memory against
// apps/worker/schema.sql (no wrangler, no network, no remote D1).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildDayStatements,
  evidenceStatements,
  compoundUpsert,
} from './d1-load.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const SCHEMA_SQL = readFileSync(join(here, '..', 'apps', 'worker', 'schema.sql'), 'utf8');
const DATE = '2026/11/10';

/** Snapshot shaped like real AFR-data output ({ signals, afr }) */
function makeSnapshot(domain, { score, grade, points, status, homepage }) {
  return {
    signals: {
      domain,
      fetchedAt: '2026-11-10T11:42:36.513Z',
      scannerVersion: 'scanner-0.1.0',
      homepage: homepage ?? { body: '<html lang="en"><title>Acme</title></html>' },
    },
    afr: {
      domain,
      engineVersion: 'afr-1.0.0',
      scannedAt: '2026-11-10T11:42:36.513Z',
      score,
      grade,
      strategyTag: 'Middle-Path',
      layers: [
        {
          layer: 'L1',
          name: 'Reachable',
          awarded: points,
          max: 35,
          checks: [
            {
              id: 'A1.gptbot',
              layer: 'L1',
              name: 'robots allows GPTBot',
              awarded: points,
              max: 3,
              status,
              evidence: { source: 'robots.txt', detail: 'User-agent: GPTBot / Allow: /' },
            },
          ],
        },
        { layer: 'L2', name: 'Legible', awarded: 0, max: 40, checks: [] },
        { layer: 'L3', name: 'Actionable', awarded: 0, max: 25, checks: [] },
      ],
      breakdown: {},
    },
  };
}

/** Write a day of snapshots under <root>/YYYY/MM/DD/ and return the day dir */
function writeDay(root, date, snapshots) {
  const dir = join(root, ...date.split('/'));
  mkdirSync(dir, { recursive: true });
  for (const [domain, snap] of Object.entries(snapshots)) {
    writeFileSync(join(dir, `${domain}.json`), JSON.stringify(snap));
  }
  return dir;
}

function openDb() {
  const db = new DatabaseSync(':memory:');
  db.exec(SCHEMA_SQL);
  return db;
}

/** Run exactly what d1-load runs for one day: day statements, then evidence */
function applyDay(db, dir, date = DATE) {
  const { files, batches, siteRows, scanRows, pending, catRows } = buildDayStatements({ dir, date });
  for (const stmts of batches) for (const st of stmts) db.exec(st);
  const idRows = db.prepare('SELECT id, snapshot_path FROM scans').all();
  const evStmts = evidenceStatements(idRows, dir, date, files);
  for (const st of evStmts) db.exec(st);
  return { files, siteRows, scanRows, pending, catRows, evStmts };
}

const count = (db, sql, ...params) => db.prepare(sql).get(...params).n;
const DAY_COUNTS = {
  sites: "SELECT COUNT(*) n FROM sites",
  scans: "SELECT COUNT(*) n FROM scans",
  evidence: "SELECT COUNT(*) n FROM evidence",
};

test('first load inserts sites, scans and evidence', () => {
  const root = mkdtempSync(join(tmpdir(), 'd1-load-'));
  try {
    const dir = writeDay(root, DATE, {
      'acme.dev': makeSnapshot('acme.dev', { score: 87, grade: 'B', points: 3, status: 'pass' }),
      'other.dev': makeSnapshot('other.dev', { score: 40, grade: 'C', points: 0, status: 'fail' }),
    });
    const db = openDb();
    const result = applyDay(db, dir);
    assert.equal(result.files.length, 2);
    assert.equal(count(db, DAY_COUNTS.sites), 2);
    assert.equal(count(db, DAY_COUNTS.scans), 2);
    assert.equal(count(db, DAY_COUNTS.evidence), 2);
    const site = db.prepare('SELECT grade, score_total FROM sites WHERE domain = ?').get('acme.dev');
    assert.deepEqual({ grade: site.grade, score: site.score_total }, { grade: 'B', score: 87 });
    const scan = db.prepare('SELECT id, grade FROM scans WHERE domain = ?').get('acme.dev');
    assert.equal(scan.grade, 'B');
    const ev = db.prepare('SELECT status, points FROM evidence WHERE scan_id = ?').get(scan.id);
    assert.deepEqual({ status: ev.status, points: ev.points }, { status: 'pass', points: 3 });
    db.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('second run performs UPDATEs: a stale score gets refreshed', () => {
  const root = mkdtempSync(join(tmpdir(), 'd1-load-'));
  try {
    const dir = writeDay(root, DATE, {
      'acme.dev': makeSnapshot('acme.dev', { score: 87, grade: 'B', points: 3, status: 'pass' }),
      'other.dev': makeSnapshot('other.dev', { score: 40, grade: 'C', points: 0, status: 'fail' }),
    });
    const db = openDb();
    applyDay(db, dir);

    // re-score: the engine re-run publishes A/91 for acme.dev
    writeDay(root, DATE, {
      'acme.dev': makeSnapshot('acme.dev', { score: 91, grade: 'A', points: 3, status: 'pass' }),
      'other.dev': makeSnapshot('other.dev', { score: 40, grade: 'C', points: 0, status: 'fail' }),
    });
    applyDay(db, dir);

    const site = db.prepare('SELECT grade, score_total FROM sites WHERE domain = ?').get('acme.dev');
    assert.equal(site.grade, 'A', 'sites.grade must be updated, not left stale');
    assert.equal(site.score_total, 91, 'sites.score_total must be updated, not left stale');
    const scan = db.prepare('SELECT grade, score_total FROM scans WHERE domain = ?').get('acme.dev');
    assert.equal(scan.grade, 'A', 'scans.grade must be updated');
    assert.equal(scan.score_total, 91, 'scans.score_total must be updated');
    assert.equal(count(db, DAY_COUNTS.sites), 2, 'no extra site rows');
    assert.equal(count(db, DAY_COUNTS.scans), 2, 'no extra scan rows');
    db.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('three runs over the same day never duplicate scans rows', () => {
  const root = mkdtempSync(join(tmpdir(), 'd1-load-'));
  try {
    const dir = writeDay(root, DATE, {
      'acme.dev': makeSnapshot('acme.dev', { score: 87, grade: 'B', points: 3, status: 'pass' }),
      'other.dev': makeSnapshot('other.dev', { score: 40, grade: 'C', points: 0, status: 'fail' }),
    });
    const db = openDb();
    applyDay(db, dir);
    applyDay(db, dir);
    applyDay(db, dir);
    assert.equal(count(db, DAY_COUNTS.scans), 2, 'one scan row per snapshot_path after 3 runs');
    assert.equal(count(db, DAY_COUNTS.sites), 2, 'one row per domain after 3 runs');
    assert.equal(count(db, DAY_COUNTS.evidence), 2, 'one evidence row per (scan, check)');
    db.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('evidence conflicts update values instead of appending', () => {
  const root = mkdtempSync(join(tmpdir(), 'd1-load-'));
  try {
    const dir = writeDay(root, DATE, {
      'acme.dev': makeSnapshot('acme.dev', { score: 87, grade: 'B', points: 3, status: 'pass' }),
    });
    const db = openDb();
    applyDay(db, dir);

    // re-score flips the check to fail with 0 points
    writeDay(root, DATE, {
      'acme.dev': makeSnapshot('acme.dev', { score: 60, grade: 'C', points: 0, status: 'fail' }),
    });
    const second = applyDay(db, dir);

    assert.equal(count(db, DAY_COUNTS.evidence), 1, 'evidence row must be updated, not appended');
    const scan = db.prepare('SELECT id FROM scans WHERE domain = ?').get('acme.dev');
    const ev = db
      .prepare('SELECT status, points, evidence_type, evidence_ref FROM evidence WHERE scan_id = ?')
      .get(scan.id);
    assert.equal(ev.status, 'fail');
    assert.equal(ev.points, 0);
    assert.equal(ev.evidence_type, 'robots.txt');
    // the statements really are upserts (shape check on the generated SQL)
    assert.ok(second.evStmts[0].includes('ON CONFLICT(scan_id, check_id) DO UPDATE SET'));
    db.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a reload refreshes the scanner-owned title but keeps the curated category', () => {
  const root = mkdtempSync(join(tmpdir(), 'd1-load-'));
  try {
    const dir = writeDay(root, DATE, {
      'acme.dev': makeSnapshot('acme.dev', { score: 87, grade: 'B', points: 3, status: 'pass' }),
    });
    const db = openDb();
    applyDay(db, dir);
    db.prepare("UPDATE sites SET title = 'Curated Title', category_id = 3 WHERE domain = 'acme.dev'").run();

    writeDay(root, DATE, {
      'acme.dev': makeSnapshot('acme.dev', { score: 91, grade: 'A', points: 3, status: 'pass' }),
    });
    applyDay(db, dir);

    const site = db.prepare('SELECT title, category_id, score_total FROM sites WHERE domain = ?').get('acme.dev');
    // The title is the scanner's data (the page's own <title>) — the loader
    // refreshes it like the scores. A curated CATEGORY is not scanner data
    // and stays.
    assert.equal(site.title, 'Acme', 'the title is scanner-owned and refreshes with the scan');
    assert.equal(site.category_id, 3, 'category mapping must not be overwritten');
    assert.equal(site.score_total, 91, 'scanner-owned scores must refresh');
    db.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a snapshot without a title does not erase a known one', () => {
  const root = mkdtempSync(join(tmpdir(), 'd1-load-'));
  try {
    const dir = writeDay(root, DATE, {
      'acme.dev': makeSnapshot('acme.dev', { score: 87, grade: 'B', points: 3, status: 'pass', homepage: { body: '<html lang="en"><title>Acme</title></html>' } }),
    });
    const db = openDb();
    applyDay(db, dir);
    assert.equal(db.prepare('SELECT title FROM sites WHERE domain = ?').get('acme.dev').title, 'Acme');

    // The next scan could not read the homepage: it knows less than the
    // row it lands on, so it must not erase the title.
    writeDay(root, DATE, {
      'acme.dev': makeSnapshot('acme.dev', { score: 87, grade: 'B', points: 3, status: 'pass', homepage: { body: '<html>no title here</html>' } }),
    });
    applyDay(db, dir);
    assert.equal(
      db.prepare('SELECT title FROM sites WHERE domain = ?').get('acme.dev').title,
      'Acme',
      'a title-less snapshot must not erase a known title',
    );
    db.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the title and the lang come from the scanner fields, the body is the fallback', () => {
  const root = mkdtempSync(join(tmpdir(), 'd1-load-'));
  try {
    const dir = writeDay(root, DATE, {
      // a snapshot of the new shape: the fields, no body (the body was pruned)
      'fields.dev': makeSnapshot('fields.dev', {
        score: 87,
        grade: 'B',
        points: 3,
        status: 'pass',
        homepage: { status: 200, title: 'Fields Ltd', lang: 'en-US' },
      }),
      // an old snapshot: no fields, the title lives in the body
      'body.dev': makeSnapshot('body.dev', {
        score: 40,
        grade: 'C',
        points: 0,
        status: 'fail',
        homepage: { status: 200, body: '<html lang="de"><title>Body Title</title></html>' },
      }),
      // both: the field wins
      'both.dev': makeSnapshot('both.dev', {
        score: 40,
        grade: 'C',
        points: 0,
        status: 'fail',
        homepage: {
          status: 200,
          title: 'Field Title',
          lang: 'fr',
          body: '<html lang="de"><title>Body Title</title></html>',
        },
      }),
    });
    const db = openDb();
    applyDay(db, dir);

    const fields = db.prepare('SELECT title, lang FROM sites WHERE domain = ?').get('fields.dev');
    assert.equal(fields.title, 'Fields Ltd', 'a body-less snapshot still carries its title');
    assert.equal(fields.lang, 'en-us', 'the D1 language keeps its lowercase shape');

    const body = db.prepare('SELECT title, lang FROM sites WHERE domain = ?').get('body.dev');
    assert.equal(body.title, 'Body Title', 'an old snapshot reads its title from the body');
    assert.equal(body.lang, 'de');

    const both = db.prepare('SELECT title, lang FROM sites WHERE domain = ?').get('both.dev');
    assert.equal(both.title, 'Field Title', 'the field wins over the body');
    assert.equal(both.lang, 'fr');
    db.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the category comes from the meta field, the body is the fallback', () => {
  const root = mkdtempSync(join(tmpdir(), 'd1-load-'));
  try {
    const dir = writeDay(root, DATE, {
      // a snapshot of the new shape: the meta field, no body (the body was pruned)
      'fields.test': makeSnapshot('fields.test', {
        score: 87,
        grade: 'B',
        points: 3,
        status: 'pass',
        homepage: { status: 200, meta: { ogSiteName: 'Acme — add to cart' } },
      }),
      // an old snapshot: no field, the meta lives in the body
      'body.test': makeSnapshot('body.test', {
        score: 40,
        grade: 'C',
        points: 0,
        status: 'fail',
        homepage: {
          status: 200,
          body: '<html><head><meta property="og:site_name" content="Acme — add to cart"></head></html>',
        },
      }),
      // neither: the site stays uncategorized
      'bare.test': makeSnapshot('bare.test', {
        score: 40,
        grade: 'C',
        points: 0,
        status: 'fail',
        homepage: { status: 200, title: 'Acme Portal' },
      }),
    });
    const db = openDb();
    applyDay(db, dir);

    const fields = db.prepare('SELECT category_id FROM sites WHERE domain = ?').get('fields.test');
    assert.equal(fields.category_id, 4, 'a body-less snapshot still carries its category');
    const body = db.prepare('SELECT category_id FROM sites WHERE domain = ?').get('body.test');
    assert.equal(body.category_id, 4, 'an old snapshot reads its meta from the body');
    const bare = db.prepare('SELECT category_id FROM sites WHERE domain = ?').get('bare.test');
    assert.equal(bare.category_id, 14, 'without meta the site stays in "other"');
    db.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('compoundUpsert keeps every statement under maxBytes', () => {
  const rows = Array.from({ length: 50 }, (_, i) => [`'row-${i}'`, String(i), `'${'x'.repeat(60)}'`]);
  const stmts = compoundUpsert('sites', ['domain', 'score_total', 'title'], ['domain'], ['score_total'], rows, 300);
  assert.ok(stmts.length > 1, 'rows must split into several statements');
  for (const st of stmts) assert.ok(st.length <= 300, `statement too large: ${st.length}`);
  assert.ok(stmts.every((st) => st.includes('ON CONFLICT(domain) DO UPDATE SET score_total = excluded.score_total;')));
});

test('schema.sql enforces one scan row per snapshot_path', () => {
  const db = openDb();
  db.prepare("INSERT INTO sites (domain) VALUES ('acme.dev')").run();
  const insert = db.prepare(
    'INSERT INTO scans (domain, engine_version, snapshot_path) VALUES (?, ?, ?)',
  );
  insert.run('acme.dev', 'afr-1.0.0', `scans/${DATE}/acme.dev.json`);
  assert.throws(
    () => insert.run('acme.dev', 'afr-1.0.1', `scans/${DATE}/acme.dev.json`),
    /UNIQUE/i,
    'idx_scans_snapshot must reject a duplicate snapshot_path',
  );
  // NULL snapshot_path rows (history without a snapshot) stay allowed
  insert.run('acme.dev', 'afr-1.0.0', null);
  insert.run('acme.dev', 'afr-1.0.0', null);
  db.close();
});
