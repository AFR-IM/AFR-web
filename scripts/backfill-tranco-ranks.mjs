#!/usr/bin/env node
// scripts/backfill-tranco-ranks.mjs — fill the D1 `sites.rank` /
// `sites.rank_source` columns from the Tranco top-1M list.
//
// Why
//   The catalog was built from the Tranco list, but the rank was never
//   written down: the scan workflow takes the domain column of the list
//   and drops the rank column, and the snapshot carries no rank field.
//   So `sites.rank_source`/`sites.rank` stayed NULL for every site, and
//   the rank the category pages show ("#12,345 in the Tranco top 1M")
//   was never rendered — the site kept the field for a reason it could
//   not fill.
//
//   The Tranco list itself is public and stable, so the rank can be
//   recovered for every site that is in it: the list is the same source
//   the segments came from.
//
//   Only rows whose rank is still NULL are touched, so a rank that was
//   set by hand (or by a later source) is never overwritten, and a site
//   that is not in the top 1M keeps a NULL rank — which is the truth,
//   not a gap.
//
// Usage:
//   node scripts/backfill-tranco-ranks.mjs [--list top-1m.csv] [--write]
//
// --list  a local copy of the Tranco CSV (rank,domain). When it is not
//         given the list is fetched from https://tranco-list.eu.
// --write apply to the production D1 (default: dry run).

import { existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, '..');
const WORKER_DIR = join(ROOT, 'apps/worker');

/** The public list the segments were cut from. */
export const LIST_URL = 'https://tranco-list.eu/top-1m.csv.zip';

/** One statement may not exceed this (the D1 statement size budget). */
const MAX_BYTES = 60_000;

/** Parse the list into domain -> rank. The CSV is "rank,domain". */
export function parseList(csv) {
  const ranks = new Map();
  let line = 0;
  for (const raw of csv.split('\n')) {
    line++;
    if (!raw) continue;
    const comma = raw.indexOf(',');
    if (comma <= 0) continue;
    const rank = Number(raw.slice(0, comma));
    const domain = raw.slice(comma + 1).trim().toLowerCase();
    if (!Number.isFinite(rank) || !domain) continue;
    ranks.set(domain, rank);
  }
  return ranks;
}

/** Fetch and unzip the list (the shell does the unzip; the CI has it too). */
export function fetchList(url = LIST_URL) {
  const zip = join(ROOT, 'tmp', 'top-1m.csv.zip');
  execFileSync('curl', ['-fsSL', '-o', zip, url], { stdio: ['ignore', 'inherit', 'inherit'] });
  execFileSync('unzip', ['-o', '-q', zip, '-d', join(ROOT, 'tmp')], { stdio: ['ignore', 'inherit', 'inherit'] });
  return readFileSync(join(ROOT, 'tmp', 'top-1m.csv'), 'utf8');
}

/**
 * The update statements.
 *
 * UPDATE ... FROM (a CTE over VALUES) touches only the rows that exist
 * and only the ones whose rank is still missing.
 */
export function updateStatements(rows, maxBytes = MAX_BYTES) {
  const stmts = [];
  let buf = '';
  const flush = () => {
    if (!buf) return;
    stmts.push(
      `WITH v(domain, rank) AS (VALUES ${buf})\n` +
        `UPDATE sites SET rank = v.rank, rank_source = 'tranco'\n` +
        `FROM v WHERE sites.domain = v.domain AND sites.rank IS NULL;`,
    );
    buf = '';
  };
  for (const row of rows) {
    const tuple = `('${row.domain.replace(/'/g, "''")}', ${row.rank})`;
    if (buf && buf.length + tuple.length + 2 > maxBytes) flush();
    buf += (buf ? ',' : '') + tuple;
  }
  flush();
  return stmts;
}

/** Run one statement against the remote D1. */
function d1(sql) {
  const out = execFileSync(
    'npx',
    ['wrangler', 'd1', 'execute', 'aiapp', '--remote', '--json', '--command', sql],
    { cwd: WORKER_DIR, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );
  const jsonStart = out.indexOf('[');
  const parsed = JSON.parse(out.slice(jsonStart));
  return parsed?.[0] ?? {};
}

/** The sites whose rank is still missing. */
function sitesWithoutRank() {
  const out = execFileSync(
    'npx',
    ['wrangler', 'd1', 'execute', 'aiapp', '--remote', '--json', '--command',
      'SELECT domain FROM sites WHERE rank IS NULL'],
    { cwd: WORKER_DIR, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );
  const jsonStart = out.indexOf('[');
  const parsed = JSON.parse(out.slice(jsonStart));
  return (parsed?.[0]?.results ?? []).map((r) => r.domain);
}

// ── CLI ────────────────────────────────────────────────────────────────────
const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) {
  const listArg = process.argv.includes('--list')
    ? process.argv[process.argv.indexOf('--list') + 1]
    : null;
  const csv = listArg && existsSync(listArg) ? readFileSync(listArg, 'utf8') : fetchList();
  const ranks = parseList(csv);
  console.log(`tranco list: ${ranks.size} domains`);

  const domains = sitesWithoutRank();
  const rows = [];
  let notInList = 0;
  for (const domain of domains) {
    const rank = ranks.get(String(domain).toLowerCase());
    if (rank === undefined) {
      notInList++;
      continue;
    }
    rows.push({ domain, rank });
  }
  const stmts = updateStatements(rows);
  console.log(
    `sites without a rank: ${domains.length} → ${rows.length} found in the list ` +
      `(${notInList} not in the top 1M) → ${stmts.length} statement(s)`,
  );
  if (!process.argv.includes('--write')) {
    console.log('dry run — pass --write to apply to the production D1');
    process.exit(0);
  }
  for (const [i, sql] of stmts.entries()) {
    const res = d1(sql);
    console.log(`statement ${i + 1}/${stmts.length}: ${res?.meta?.changes ?? 0} row(s) updated`);
  }
  console.log('done');
}
