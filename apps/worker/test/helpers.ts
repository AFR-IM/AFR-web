// test/helpers.ts — shared in-memory database + fixtures for the worker tests.
// Not matched by the `test/*.test.ts` glob; imported by the test files.

import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSqliteDb, type Db } from '../src/db.ts';

const here = dirname(fileURLToPath(import.meta.url));

/** Full D1 DDL (schema.sql) — executed against every test database */
export const SCHEMA_SQL = readFileSync(join(here, '..', 'schema.sql'), 'utf8');

export interface TestDb {
  db: Db;
  raw: DatabaseSync;
}

/** Open a fresh :memory: database with schema + fixtures applied */
export function openSeededDb(): TestDb {
  const raw = new DatabaseSync(':memory:');
  raw.exec(SCHEMA_SQL);
  seed(raw);
  return { db: createSqliteDb(raw), raw };
}

/** Apply the standard fixture set:
 *  - 3 categories (tech → dev-tools, news)
 *  - 5 sites: A/B/C/F + one Pending (null score), 2 per category
 *  - 2 scans + 2 evidence rows for example.com
 *  - 4 ads: active, pending, expired, active-generic */
export function seed(raw: DatabaseSync): void {
  const run = (sql: string, ...params: (string | number | null)[]): void => {
    raw.prepare(sql).run(...params);
  };

  run(`INSERT INTO categories (id, slug, name_en, name_zh, parent) VALUES (1, 'tech', 'Technology', 'Technology ZH', NULL)`);
  run(`INSERT INTO categories (id, slug, name_en, name_zh, parent) VALUES (2, 'dev-tools', 'Developer Tools', 'Developer Tools ZH', 1)`);
  run(`INSERT INTO categories (id, slug, name_en, name_zh, parent) VALUES (3, 'news', 'News', 'News ZH', 1)`);

  const siteCols =
    'domain, title, lang, category_id, strategy_tag, grade, score_total, score_l1, score_l2, score_l3, ' +
    'rank_source, rank, status, verified, created_at, updated_at, scanned_at';
  run(
    `INSERT INTO sites (${siteCols}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    'example.com', 'Example', 'en', 2, 'AI-Open', 'A', 92, 33, 35, 24,
    'tranco', 100, 'active', 1,
    '2026-11-01T00:00:00.000Z', '2026-11-10T00:00:00.000Z', '2026-11-10T10:00:00.000Z',
  );
  run(
    `INSERT INTO sites (${siteCols}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    'coolsite.io', 'Coolsite', 'en', 2, 'Middle-Path', 'B', 78, 28, 30, 20,
    'tranco', 500, 'active', 0,
    '2026-11-03T00:00:00.000Z', '2026-11-09T00:00:00.000Z', '2026-11-09T10:00:00.000Z',
  );
  run(
    `INSERT INTO sites (${siteCols}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    'neutral.net', 'Neutral', 'en', 3, 'Unconfigured', 'C', 55, 20, 22, 13,
    'tranco', 1200, 'active', 0,
    '2026-11-05T00:00:00.000Z', '2026-11-08T00:00:00.000Z', '2026-11-08T10:00:00.000Z',
  );
  run(
    `INSERT INTO sites (${siteCols}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    'closed.org', 'Closed', 'en', 3, 'AI-Closed', 'F', 10, 5, 5, 0,
    'tranco', 3000, 'active', 0,
    '2026-11-07T00:00:00.000Z', '2026-11-07T00:00:00.000Z', '2026-11-07T10:00:00.000Z',
  );
  run(
    `INSERT INTO sites (${siteCols}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    'pending.dev', 'Pending Site', 'en', 2, null, 'Pending', null, null, null, null,
    null, null, 'active', 0,
    '2026-11-08T00:00:00.000Z', null, null,
  );

  run(
    `INSERT INTO scans (domain, engine_version, score_total, score_l1, score_l2, score_l3, grade, snapshot_path, started_at, finished_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    'example.com', 'afr-1.0.0', 92, 33, 35, 24, 'A',
    'scans/2026/11/10/example.com.json', '2026-11-10T10:00:00.000Z', '2026-11-10T10:05:00.000Z',
  );
  run(
    `INSERT INTO scans (domain, engine_version, score_total, score_l1, score_l2, score_l3, grade, snapshot_path, started_at, finished_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    'example.com', 'afr-1.0.0', 88, 30, 35, 23, 'B',
    'scans/2026/11/09/example.com.json', '2026-11-09T10:00:00.000Z', '2026-11-09T10:05:00.000Z',
  );

  run(
    `INSERT INTO evidence (scan_id, check_id, status, points, max_points, evidence_type, evidence_ref)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    1, 'A1.gptbot', 'pass', 3, 3, 'robots.txt', 'User-agent: GPTBot / Allow: /',
  );
  run(
    `INSERT INTO evidence (scan_id, check_id, status, points, max_points, evidence_type, evidence_ref)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    1, 'B1.llms-txt', 'fail', 0, 8, 'http-head', 'GET /llms.txt -> 404',
  );

  const adCols = 'domain, slot, slot_key, headline, body, starts_at, ends_at, status, impressions, clicks, created_at';
  run(
    `INSERT INTO ads (${adCols}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    'example.com', 'category-top', 'dev-tools', 'Ship faster', 'Dev tools for AI agents.',
    '2000-01-01', '2099-01-01', 'active', 0, 0, '2026-11-01T00:00:00.000Z',
  );
  run(
    `INSERT INTO ads (${adCols}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    'closed.org', 'category-top', 'dev-tools', 'Pending ad', 'Must never be served.',
    '2000-01-01', '2099-01-01', 'pending', 0, 0, '2026-11-01T00:00:00.000Z',
  );
  run(
    `INSERT INTO ads (${adCols}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    'neutral.net', 'home-supporter', null, 'Expired ad', 'Ended long ago.',
    '2000-01-01', '2000-06-01', 'active', 0, 0, '2000-01-01T00:00:00.000Z',
  );
  run(
    `INSERT INTO ads (${adCols}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    'coolsite.io', 'category-top', null, 'Generic ad', 'Shows for any slot key.',
    '2000-01-01', '2099-01-01', 'active', 0, 0, '2026-11-01T00:00:00.000Z',
  );
}
