#!/usr/bin/env node
// scripts/queue-title-repairs.mjs — queue the sites whose name was lost with
// the pruned bodies, so that the daily scan re-reads them.
//
// Why this exists
//   The scanner captures the page's own title while the homepage body is
//   still in hand (`signals.homepage.title`). The bodies are the bulk of the
//   corpus and are pruned away, so a snapshot taken before the field existed
//   lost its title with them — and there is no offline way back: the bytes
//   are gone (measured: 2,947 snapshots had no body left to re-parse).
//
//   A site without a title still shows up on afr.im, but it shows up as a
//   bare domain, and it cannot be found by the search index under its own
//   name. The only thing that brings the name back is a fresh scan of the
//   homepage.
//
//   So the repair is a scan, not an edit: the missing-title domains are put
//   into the ordinary on-demand queue (`submissions`, source='repair'), and
//   the daily queue scan (scan.yml, mode=queue) re-reads them like any other
//   request. Nothing here touches the Tranco expansion, and nothing is
//   dispatched by hand — the daily cron picks the queue up on its own.
//
// What it does
//   · Reads the merged view of the scan corpus (newest snapshot per domain,
//     the same rule as apps/web/scripts/fetch-data.mjs).
//   · Picks the domains whose homepage title resolves to nothing. The
//     resolver is the shared one (packages/scanner/src/page-meta.ts), so
//     "missing" means exactly what the site build means by it.
//   · Skips the domains that are already in the queue, and the ones that
//     were repaired recently (--retry-days), so a site whose homepage truly
//     has no <title> does not get re-queued every night.
//   · Writes the rest into the D1 `submissions` table with source='repair'.
//
// What it does NOT do
//   · It does not scan anything and does not dispatch any workflow. The rows
//     are a request; the daily queue scan is the worker.
//   · It does not write to the scan corpus. Only the snapshots the daily
//     scan produces change the corpus.
//   · It does not touch a domain that is already in the queue for any
//     reason — a pending on-demand request is not preempted.
//
// Usage
//   CLOUDFLARE_API_TOKEN=… CLOUDFLARE_ACCOUNT_ID=… \
//     node scripts/queue-title-repairs.mjs [--dry-run] [--write]
//
//   --dry-run          report only (default)
//   --write            insert the repair rows into the production D1
//   --data-dir PATH    the scans root (default: ../AFR-data/scans)
//   --include-pending  also queue the pending sites (homepage unreadable)
//   --retry-days N     re-queue a repaired domain after N days (default 30)
//   --limit N          queue at most N domains (oldest-first)
//   --note TEXT        the submitter_note stored with every row
//
// Examples
//   node scripts/queue-title-repairs.mjs                       # read-only report
//   node scripts/queue-title-repairs.mjs --write                # queue them
//   node scripts/queue-title-repairs.mjs --write --limit 50     # a small batch

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolvePageTitle } from '../packages/scanner/src/page-meta.ts';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');

const D1_NAME = 'aiapp';
const DEFAULT_RETRY_DAYS = 30;
const DEFAULT_NOTE = 'title repair: page title missing from the snapshot';
const CHUNK = 40; // rows per INSERT statement

/* ── arguments ─────────────────────────────────────────────────────────── */

export function parseArgs(argv) {
  const opts = {
    write: false,
    dataDir: resolve(repoRoot, '..', 'AFR-data', 'scans'),
    includePending: false,
    retryDays: DEFAULT_RETRY_DAYS,
    limit: Infinity,
    note: DEFAULT_NOTE,
    report: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--write') opts.write = true;
    else if (a === '--dry-run') opts.write = false;
    else if (a === '--include-pending') opts.includePending = true;
    else if (a === '--report') opts.report = argv[++i];
    else if (a === '--data-dir') opts.dataDir = resolve(argv[++i]);
    else if (a === '--retry-days') opts.retryDays = Number(argv[++i]);
    else if (a === '--limit') opts.limit = Number(argv[++i]);
    else if (a === '--note') opts.note = argv[++i];
    else if (a === '--help' || a === '-h') {
      console.log(
        'Usage: node scripts/queue-title-repairs.mjs [--dry-run|--write] ' +
          '[--data-dir PATH] [--include-pending] [--retry-days N] [--limit N] [--note TEXT] [--report FILE]',
      );
      process.exit(0);
    } else {
      console.error(`Unknown argument: ${a}`);
      process.exit(2);
    }
  }
  if (!Number.isFinite(opts.retryDays) || opts.retryDays < 0) {
    console.error('--retry-days must be a non-negative number');
    process.exit(2);
  }
  if (!(opts.limit >= 0) || Number.isNaN(opts.limit)) {
    console.error('--limit must be a non-negative number');
    process.exit(2);
  }
  return opts;
}

/* ── the corpus ────────────────────────────────────────────────────────── */

const isDir = (p) => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};
const subdirs = (p) =>
  readdirSync(p, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();

/**
 * The merged view of the corpus: the newest snapshot per domain.
 *
 * The same rule as apps/web/scripts/fetch-data.mjs — a later date directory
 * wins — so "the site's current title" means the same thing here as it does
 * on the site.
 */
export function loadMerged(root) {
  const byDomain = new Map();
  if (!isDir(root)) return byDomain;
  for (const y of subdirs(root)) {
    if (!/^\d{4}$/.test(y)) continue;
    for (const m of subdirs(join(root, y))) {
      if (!/^\d{2}$/.test(m)) continue;
      for (const d of subdirs(join(root, y, m))) {
        if (!/^\d{2}$/.test(d)) continue;
        const stamp = `${y}-${m}-${d}`;
        const dir = join(root, y, m, d);
        for (const f of readdirSync(dir)) {
          if (!f.endsWith('.json')) continue;
          const prev = byDomain.get(f);
          if (!prev || prev.stamp <= stamp) byDomain.set(f, { stamp, dir, name: f });
        }
      }
    }
  }
  return byDomain;
}

/**
 * The domains whose title is missing, with the facts a repair decision needs:
 * the homepage status (was the page even readable?), the grade (is the site
 * listed at all?) and the snapshot the verdict came from.
 */
export function collectMissingTitles(root, { includePending = false } = {}) {
  const merged = loadMerged(root);
  const missing = [];
  const stats = { domains: 0, pending: 0, scored: 0, missing: 0, missingPending: 0, missingScored: 0 };
  for (const { stamp, dir, name } of merged.values()) {
    let raw;
    try {
      raw = JSON.parse(readFileSync(join(dir, name), 'utf8'));
    } catch {
      continue;
    }
    const afr = raw?.afr ?? {};
    const probe = raw?.signals?.homepage;
    const domain = afr.domain ?? raw?.signals?.domain ?? name.replace(/\.json$/, '');
    if (!domain) continue;
    stats.domains++;
    const isPending = afr.state === 'pending' || afr.grade === 'Pending';
    if (isPending) stats.pending++;
    else stats.scored++;
    if (resolvePageTitle(probe)) continue;
    stats.missing++;
    if (isPending) stats.missingPending++;
    else stats.missingScored++;
    if (isPending && !includePending) continue;
    missing.push({
      domain,
      stamp,
      pending: isPending,
      grade: afr.grade ?? null,
      score: typeof afr.score === 'number' ? afr.score : null,
      status: typeof probe?.status === 'number' ? probe.status : null,
    });
  }
  return { missing, stats };
}

/* ── D1 ────────────────────────────────────────────────────────────────── */

function d1(sql) {
  const out = execFileSync(
    'npx',
    ['wrangler', 'd1', 'execute', D1_NAME, '--remote', '--json', '--command', sql],
    { cwd: repoRoot, env: process.env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );
  const m = out.match(/\[[\s\S]*\]/);
  if (!m) return [];
  const parsed = JSON.parse(m[0]);
  return parsed[0]?.results ?? [];
}

const q = (v) => `'${String(v).replace(/'/g, "''")}'`;

/** The queue rows we already know about, so a second run inserts nothing. */
function readSubmissions() {
  const rows = d1(
    `SELECT domain, source, status, created_at, done_at FROM submissions`,
  );
  const byDomain = new Map();
  for (const r of rows) {
    const list = byDomain.get(r.domain) ?? [];
    list.push(r);
    byDomain.set(r.domain, list);
  }
  return byDomain;
}

const ACTIVE = new Set(['queued', 'pending', 'scanning']);

/**
 * The domains that may be queued now.
 *
 *   · a domain with an active row (from any source) is already in flight —
 *     the repair joins that request instead of opening a second one;
 *   · a domain whose last repair was scanned less than `retryDays` ago is
 *     left alone: a site whose homepage truly has no <title> would
 *     otherwise be re-queued every single night.
 */
export function selectQueueable(missing, submissions, { retryDays, limit }) {
  const cutoff = Date.now() - retryDays * 86400_000;
  const skipped = { active: 0, recentlyRepaired: 0, limit: 0 };
  const queueable = [];
  for (const item of missing) {
    const rows = submissions.get(item.domain) ?? [];
    if (rows.some((r) => ACTIVE.has(r.status))) {
      skipped.active++;
      continue;
    }
    const repairs = rows.filter((r) => r.source === 'repair');
    if (repairs.length > 0) {
      const last = repairs
        .map((r) => Date.parse(r.done_at ?? r.created_at ?? '') || 0)
        .reduce((a, b) => Math.max(a, b), 0);
      if (last > cutoff) {
        skipped.recentlyRepaired++;
        continue;
      }
    }
    queueable.push(item);
    if (queueable.length >= limit) {
      skipped.limit++;
      break;
    }
  }
  return { queueable, skipped };
}

/* ── main ──────────────────────────────────────────────────────────────── */

function main() {
  const opts = parseArgs(process.argv.slice(2));

  if (!existsSync(opts.dataDir)) {
    console.error(`scans root not found: ${opts.dataDir}`);
    process.exit(1);
  }

  const { missing, stats } = collectMissingTitles(opts.dataDir, {
    includePending: opts.includePending,
  });

  console.log(`scans root   : ${opts.dataDir}`);
  console.log(
    `merged view  : ${stats.domains} domains (scored ${stats.scored}, pending ${stats.pending})`,
  );
  console.log(
    `missing title: ${stats.missing} ` +
      `(scored ${stats.missingScored}, pending ${stats.missingPending})`,
  );

  if (missing.length === 0) {
    console.log('nothing to repair');
    return;
  }

  const submissions = readSubmissions();
  const { queueable, skipped } = selectQueueable(missing, submissions, {
    retryDays: opts.retryDays,
    limit: opts.limit,
  });

  const readable = queueable.filter((m) => m.status !== null && m.status >= 200 && m.status < 400);
  console.log(
    `repairable   : ${queueable.length} domains ` +
      `(${readable.length} had a readable homepage, ${queueable.length - readable.length} did not)`,
  );
  console.log(
    `skipped      : ${skipped.active} already queued, ` +
      `${skipped.recentlyRepaired} repaired within ${opts.retryDays}d` +
      (skipped.limit ? `, ${skipped.limit} over the limit` : ''),
  );

  if (opts.report) {
    const lines = [
      '# Title repair queue',
      '',
      `- generated: ${new Date().toISOString()}`,
      `- scans root: ${opts.dataDir}`,
      `- merged domains: ${stats.domains}`,
      `- missing title: ${stats.missing} (scored ${stats.missingScored}, pending ${stats.missingPending})`,
      `- queueable: ${queueable.length}`,
      '',
      '| domain | grade | score | homepage | snapshot |',
      '|---|---|---|---|---|',
      ...queueable.map(
        (m) => `| ${m.domain} | ${m.grade ?? ''} | ${m.score ?? ''} | ${m.status ?? ''} | ${m.stamp} |`,
      ),
      '',
    ];
    writeFileSync(opts.report, lines.join('\n'), 'utf8');
    console.log(`report       : ${opts.report}`);
  }

  if (!opts.write) {
    console.log('dry run — nothing written (pass --write to insert the rows)');
    return;
  }
  if (queueable.length === 0) {
    console.log('nothing to write');
    return;
  }

  const now = new Date().toISOString();
  let written = 0;
  for (let i = 0; i < queueable.length; i += CHUNK) {
    const part = queueable.slice(i, i + CHUNK);
    // One guarded INSERT per domain: the NOT EXISTS clause is the
    // idempotency — a second run (or a concurrent one) inserts nothing.
    const inline = part
      .map(
        (m) =>
          `INSERT INTO submissions (domain, submitter_note, source, status, created_at)\n` +
          `SELECT ${q(m.domain)}, ${q(opts.note)}, 'repair', 'queued', ${q(now)}\n` +
          `WHERE NOT EXISTS (\n` +
          `  SELECT 1 FROM submissions s\n` +
          `  WHERE s.domain = ${q(m.domain)} AND s.status IN ('queued', 'pending', 'scanning')\n` +
          `)`,
      )
      .join(';\n');
    execFileSync(
      'npx',
      ['wrangler', 'd1', 'execute', D1_NAME, '--remote', '--command', inline],
      { cwd: repoRoot, env: process.env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
    written += part.length;
    console.log(
      `queued ${written}/${queueable.length} (chunk ${Math.floor(i / CHUNK) + 1}/${Math.ceil(queueable.length / CHUNK)})`,
    );
  }
  console.log(`done: ${written} repair rows inserted`);

  const check = d1(
    `SELECT COUNT(*) AS n FROM submissions WHERE source = 'repair' AND status = 'queued'`,
  );
  console.log(`verify: ${check[0]?.n ?? '?'} repair rows are queued right now`);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main();
}
