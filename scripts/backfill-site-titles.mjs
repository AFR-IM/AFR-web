#!/usr/bin/env node
// scripts/backfill-site-titles.mjs — fill the D1 `sites.title` / `sites.lang`
// columns from the scan snapshots.
//
// Why
//   The site's name and language are the scanner's data (the page's own
//   <title> and <html lang>), but neither the loader nor the daily sync
//   wrote them into D1 — the sync deliberately left "title, lang" alone as
//   if they were hand-curated. The result: 7,264 of the 7,948 sites had a
//   NULL title, so the public API, the badge and the MCP answer showed a
//   bare domain for 91% of the catalog.
//
//   The daily sync cannot repair it on its own: the sha-skip means a
//   snapshot that is already in D1 is never re-read, so the sites row is
//   never touched again. This script does the one-off repair — and it is
//   idempotent, so running it twice changes nothing.
//
// Usage:
//   node scripts/backfill-site-titles.mjs [--data-dir ../AFR-data/scans]
//   node scripts/backfill-site-titles.mjs --write      (apply to production)
//
// Writes only rows whose title is missing — a known title is never touched.

import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { resolvePageLang, resolvePageTitle } from '../packages/scanner/src/page-meta.ts';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, '..');
const WORKER_DIR = join(ROOT, 'apps/worker');

/** One statement may not exceed this (the D1 statement size budget). */
const MAX_BYTES = 60_000;

/** The newest snapshot of every domain: the same merge rule as the site build. */
export function newestSnapshots(dataDir) {
  const newest = new Map();
  // The scans are laid out as scans/YYYY/MM/DD/<domain>.json — the date
  // directories sort chronologically, so the last one wins.
  const dates = [];
  const walk = (dir, prefix) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const path = join(dir, entry.name);
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      // The layout is scans/YYYY/MM/DD/<domain>.json — a snapshot directory
      // is the one whose relative path is a full date.
      if (/^\d{4}\/\d{2}\/\d{2}$/.test(rel)) dates.push({ path, rel });
      else walk(path, rel);
    }
  };
  walk(dataDir, '');
  dates.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  for (const { path } of dates) {
    for (const file of readdirSync(path)) {
      if (!file.endsWith('.json')) continue;
      const domain = file.slice(0, -'.json'.length);
      newest.set(domain, join(path, file));
    }
  }
  return newest;
}

/** The title and the language of every snapshot that has one. */
export function collectRows(dataDir) {
  const rows = [];
  const skipped = [];
  for (const [domain, file] of newestSnapshots(dataDir)) {
    const snapshot = JSON.parse(readFileSync(file, 'utf8'));
    const probe = snapshot?.signals?.homepage;
    const title = resolvePageTitle(probe);
    const lang = resolvePageLang(probe);
    if (!title && !lang) {
      skipped.push(domain);
      continue;
    }
    rows.push({ domain, title: title ?? null, lang: lang ? lang.toLowerCase().slice(0, 12) : null });
  }
  return { rows, skipped };
}

const q = (v) => (v === null || v === undefined ? 'NULL' : `'${String(v).replace(/'/g, "''")}'`);

/**
 * The update statements.
 *
 * UPDATE ... FROM (a CTE over VALUES) touches only the rows that exist and
 * only the ones whose title is missing — an INSERT-based upsert would create
 * a bare row for a domain that is not in the catalog.
 */
export function updateStatements(rows, maxBytes = MAX_BYTES) {
  const stmts = [];
  let buf = '';
  const flush = () => {
    if (!buf) return;
    stmts.push(
      `WITH v(domain, title, lang) AS (VALUES ${buf})\n` +
        `UPDATE sites SET title = v.title, lang = COALESCE(v.lang, sites.lang)\n` +
        `FROM v WHERE sites.domain = v.domain AND (sites.title IS NULL OR sites.title = '');`,
    );
    buf = '';
  };
  for (const row of rows) {
    const tuple = `(${q(row.domain)}, ${q(row.title)}, ${q(row.lang)})`;
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

// ── CLI ────────────────────────────────────────────────────────────────────
const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) {
  const dataDir = resolve(
    process.argv.includes('--data-dir')
      ? process.argv[process.argv.indexOf('--data-dir') + 1]
      : join(ROOT, '..', 'AFR-data', 'scans'),
  );
  if (!existsSync(dataDir)) {
    console.error(`no scan directory at ${dataDir}`);
    process.exit(1);
  }
  const { rows, skipped } = collectRows(dataDir);
  const stmts = updateStatements(rows);
  console.log(
    `site titles: ${rows.length} snapshot(s) carry a title or a language ` +
      `(${skipped.length} carry neither) → ${stmts.length} statement(s)`,
  );
  if (!process.argv.includes('--write')) {
    console.log('dry run — pass --write to apply to the production D1');
    process.exit(0);
  }
  for (const [i, sql] of stmts.entries()) {
    const res = d1(sql);
    const meta = res?.meta ?? {};
    console.log(
      `statement ${i + 1}/${stmts.length}: ${meta.changes ?? res?.results?.length ?? 0} row(s) updated`,
    );
  }
  console.log('done — re-run scripts/check-d1-titles.mjs to verify');
}
