#!/usr/bin/env node
// scripts/measure-corpus-coverage.mjs — the expansion gate, measured on the
// snapshot corpus of the data repo (AFR-data/scans).
//
// Why this script exists
//   The Tranco cursor (AFR-data/scan-cursor.json) walks the top 1M in
//   1000-domain segments. Every segment that enters the catalog dilutes the
//   classification coverage: a site the rule table cannot place is a site the
//   catalog cannot describe, and the catalog's quality gate (SSOT §7
//   「分类门槛」) is measured on the whole catalog. So a segment must not
//   enter while the coverage would fall below the threshold.
//
//   The gate has to be answered *before* the segment is scanned — after the
//   scan the segment is already in the corpus. The decision is therefore made
//   on the corpus that exists today:
//
//     global     the catalog as it is (every domain, newest snapshot wins);
//     segment    the segment that was scanned last — the sample of the tail;
//     predicted  what the catalog's coverage becomes if the next segment
//                looks like the last one.
//
//   All three use the same rule table as the site build
//   (apps/web/src/data/categorize.mjs) and the same "what is a usable title"
//   definition as the classification gate (scripts/measure-classification.mjs):
//   one rule table, one denominator, no second opinion.
//
//   Which date directory is "the last segment"
//     The weekly head rescan and the on-demand queue write into the same
//     dated directories as the segment scan, and they are *not* samples of
//     the tail: the head rescan re-scans the top 1000 (well-known sites, high
//     coverage) and a queue day holds a handful of hand-submitted sites. So
//     the newest directory is not the segment. The cursor is: only the
//     segment scan advances it, and its `updatedAt` is the day that segment
//     was scanned. When the cursor is missing the newest directory that holds
//     at least a full segment's worth of snapshots is used instead.
//
//     The segment directory also holds whatever else was scanned that day
//     (the on-demand queue of the same run lands in the same directory), so
//     the number is the segment's coverage moved a little by a handful of
//     hand-submitted sites — close enough for a gate, and it errs towards
//     the segment's own quality.
//
// Usage:
//   node scripts/measure-corpus-coverage.mjs [--data-dir <AFR-data/scans>]
//        [--cursor <scan-cursor.json>] [--segment-size 1000]
//        [--json] [--json-out <file>] [--fail]
//
// Exit codes
//   0  the gate opens — the segment may advance
//   1  the gate is closed — measured, but below the threshold
//   2  the measurement failed (no corpus, unreadable corpus) — fail closed

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolvePageMeta, resolvePageTitle } from '../packages/scanner/src/page-meta.ts';
import { categorize } from '../apps/web/src/data/categorize.mjs';
import { THRESHOLD, isJunkTitle } from './measure-classification.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');

// The gate's vocabulary comes from one place: the classification gate owns
// the threshold and the "usable title" rule, this script only adds the corpus.
export { THRESHOLD, isJunkTitle };

/** Domains per Tranco segment — the unit the cursor advances in. */
export const SEGMENT_SIZE = 1000;

/** The date directories of the corpus, oldest first. */
export function listDateDirs(root) {
  if (!existsSync(root)) return [];
  const dirs = [];
  for (const y of readdirSync(root)) {
    const yp = join(root, y);
    if (!statSync(yp).isDirectory() || !/^\d{4}$/.test(y)) continue;
    for (const m of readdirSync(yp)) {
      const mp = join(yp, m);
      if (!statSync(mp).isDirectory() || !/^\d{2}$/.test(m)) continue;
      for (const d of readdirSync(mp)) {
        const dp = join(mp, d);
        if (!statSync(dp).isDirectory() || !/^\d{2}$/.test(d)) continue;
        dirs.push({ date: `${y}-${m}-${d}`, dir: dp });
      }
    }
  }
  dirs.sort((a, b) => a.date.localeCompare(b.date));
  return dirs;
}

/**
 * What one snapshot says about its site.
 *
 * The title comes from the scanner's own field, the body as the fallback
 * (the snapshots taken before that field existed); the self-description
 * (og:site_name / description / keywords) the same way. Both rules live in
 * packages/scanner/src/page-meta.ts — the same ones the site build uses, so
 * the gate measures the catalog the build would produce.
 */
export function readSnapshot(file) {
  let raw;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null; // an unreadable snapshot is a hole, not a crash
  }
  const homepage = raw?.signals?.homepage;
  const domain = raw?.afr?.domain ?? raw?.signals?.domain ?? file.replace(/\.json$/, '');
  const title = resolvePageTitle(homepage);
  const meta = resolvePageMeta(homepage);
  let category = 'other';
  try {
    category = categorize(domain, title, meta);
  } catch {
    category = 'other';
  }
  return {
    domain,
    title: title ?? '',
    category,
    judgable: Boolean((title ?? '').trim()) && !isJunkTitle(title),
  };
}

/**
 * Read one directory of snapshots.
 *
 * `newest` (optional) collects the merged view — the file name is the key
 * and a later date directory wins, the same rule the site build uses
 * (apps/web/scripts/fetch-data.mjs). One pass over the corpus serves both.
 */
export function measureDir(dir, date, newest) {
  const files = readdirSync(dir).filter((f) => f.endsWith('.json'));
  let judgable = 0;
  let classified = 0;
  let unreadable = 0;
  for (const f of files) {
    const snap = readSnapshot(join(dir, f));
    if (!snap) {
      unreadable++;
      continue;
    }
    if (newest) {
      const prev = newest.get(f);
      if (!prev || prev.stamp <= date) newest.set(f, { stamp: date, snap });
    }
    if (!snap.judgable) continue;
    judgable++;
    if (snap.category && snap.category !== 'other') classified++;
  }
  return {
    total: files.length,
    unreadable,
    judgable,
    classified,
    coverage: judgable === 0 ? 0 : classified / judgable,
  };
}

/** The cursor of the segment scan, when the data repo carries one. */
export function readCursor(cursorPath) {
  if (!cursorPath || !existsSync(cursorPath)) return null;
  try {
    const raw = JSON.parse(readFileSync(cursorPath, 'utf8'));
    return {
      path: cursorPath,
      lastRank: Number.isFinite(raw?.lastRank) ? raw.lastRank : null,
      updatedAt: typeof raw?.updatedAt === 'string' ? raw.updatedAt : null,
    };
  } catch {
    return null;
  }
}

/**
 * The directory of the last segment scan.
 *
 * Primary: the day the cursor last advanced (only the segment scan advances
 * it). Fallback: the newest directory that holds at least a full segment's
 * worth of snapshots.
 */
export function pickSegmentDir(dates, cursor, segmentSize, counts = new Map()) {
  if (cursor?.updatedAt) {
    const hit = dates.find((d) => d.date === cursor.updatedAt);
    if (hit) return { ...hit, source: 'cursor' };
  }
  for (let i = dates.length - 1; i >= 0; i--) {
    const count = counts.get(dates[i].date) ?? readdirSync(dates[i].dir).filter((f) => f.endsWith('.json')).length;
    if (count >= segmentSize) return { ...dates[i], source: 'largest-recent' };
  }
  const last = dates[dates.length - 1];
  return last ? { ...last, source: 'newest' } : null;
}

/**
 * The gate decision.
 *
 *   globalOk    the catalog is at or above the threshold right now;
 *   predictedOk the catalog would still be at or above the threshold after a
 *               segment like the last one enters it;
 *   segmentOk   the last segment itself is at or above the threshold — the
 *               SSOT's 「扩量不稀释」: a segment below the bar may not enter.
 *
 * All three must hold: the gate is fail-closed, and a segment that fails
 * them is not a segment that may be scanned.
 */
export function decide({ global, segment, predicted, threshold }) {
  const globalOk = global.coverage >= threshold;
  const predictedOk = predicted.coverage >= threshold;
  const segmentOk = segment.coverage >= threshold;
  return { globalOk, predictedOk, segmentOk, pass: globalOk && predictedOk && segmentOk };
}

/**
 * How many more sites have to be classified for the gate to open.
 *
 *   global     sites the catalog as a whole is short of the threshold;
 *   projected  sites in the last segment that have to be classified for the
 *              *projected* coverage to reach the threshold;
 *   segment    sites in the last segment that have to be classified for the
 *              segment itself to reach the threshold;
 *   sites      the largest of the three — the actionable number (one manual
 *              batch of ~48 sites at a time).
 */
export function countNeeded({ global, segment, predicted, threshold }) {
  const needGlobal = Math.max(0, Math.ceil(threshold * global.judgable) - global.classified);
  const needProjected = Math.max(
    0,
    Math.ceil(threshold * (global.judgable + segment.judgable)) -
      (global.classified + segment.classified),
  );
  const needSegment = Math.max(0, Math.ceil(threshold * segment.judgable) - segment.classified);
  return {
    global: needGlobal,
    projected: needProjected,
    segment: needSegment,
    sites: Math.max(needGlobal, needProjected, needSegment),
  };
}

/**
 * Measure the corpus and decide the gate.
 *
 * Throws when the corpus cannot be measured — the caller must then fail
 * closed, never open the gate on a missing measurement.
 */
export function measureCorpus({
  dataDir,
  cursorPath,
  segmentSize = SEGMENT_SIZE,
  threshold = THRESHOLD,
} = {}) {
  if (!dataDir) throw new Error('no snapshot directory given');
  if (!existsSync(dataDir)) throw new Error(`snapshot directory not found: ${dataDir}`);
  const dates = listDateDirs(dataDir);
  if (dates.length === 0) throw new Error(`no dated snapshot directories under ${dataDir}`);

  const newest = new Map(); // file name (the domain) -> {stamp, snap}
  const perDate = [];
  for (const { date, dir } of dates) {
    const stats = measureDir(dir, date, newest);
    perDate.push({ date, ...stats });
  }

  const cursor = readCursor(cursorPath);
  const counts = new Map(perDate.map((d) => [d.date, d.total]));
  const picked = pickSegmentDir(dates, cursor, segmentSize, counts);
  if (!picked) throw new Error(`no snapshot directories under ${dataDir}`);
  const segment = {
    ...(perDate.find((d) => d.date === picked.date) ?? { date: picked.date, total: 0, judgable: 0, classified: 0, coverage: 0 }),
    source: picked.source,
  };

  let judgable = 0;
  let classified = 0;
  for (const { snap } of newest.values()) {
    if (!snap.judgable) continue;
    judgable++;
    if (snap.category && snap.category !== 'other') classified++;
  }
  const global = {
    domains: newest.size,
    judgable,
    classified,
    coverage: judgable === 0 ? 0 : classified / judgable,
  };
  if (global.domains === 0) throw new Error(`no readable snapshots under ${dataDir}`);
  if (global.judgable === 0) {
    throw new Error(`no site with a usable title under ${dataDir} — nothing to measure`);
  }

  // What the catalog becomes if the next segment looks like the last one:
  // the same number of judgable sites, the same number of classified ones.
  const predicted = {
    judgable: global.judgable + segment.judgable,
    classified: global.classified + segment.classified,
    coverage:
      global.judgable + segment.judgable === 0
        ? 0
        : (global.classified + segment.classified) / (global.judgable + segment.judgable),
  };

  const gate = decide({ global, segment, predicted, threshold });
  const need = countNeeded({ global, segment, predicted, threshold });
  const latest = perDate[perDate.length - 1];

  return {
    ok: true,
    dataDir,
    threshold,
    segmentSize,
    cursor,
    global,
    segment,
    latestDir: latest,
    predicted,
    gate,
    need,
    dates: perDate,
    hint: gate.pass
      ? `gate open — the next segment may be scanned (segment ${segment.date}, ${segment.judgable} judgable sites)`
      : `do not advance the segment: ${need.sites} more site(s) need a category — run the manual ` +
        'evidence review in batches of ~48 (see internal-docs/ENGINEERING-SSOT.md §7 「分类门槛」), ' +
        'then re-run scripts/measure-corpus-coverage.mjs',
  };
}

// ── CLI ────────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const args = { dataDir: null, cursorPath: null, segmentSize: SEGMENT_SIZE, threshold: THRESHOLD };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--data-dir') args.dataDir = resolve(argv[++i] ?? '');
    else if (a === '--cursor') args.cursorPath = resolve(argv[++i] ?? '');
    else if (a === '--segment-size') args.segmentSize = Number(argv[++i] ?? SEGMENT_SIZE);
    else if (a === '--threshold') args.threshold = Number(argv[++i] ?? THRESHOLD);
    else if (a === '--json-out') args.jsonOut = resolve(argv[++i] ?? '');
    else if (a === '--json') args.json = true;
    else if (a === '--fail') args.fail = true;
  }
  if (!args.dataDir) args.dataDir = resolve(repoRoot, '..', 'AFR-data', 'scans');
  if (!args.cursorPath) args.cursorPath = resolve(args.dataDir, '..', 'scan-cursor.json');
  return args;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) {
  const args = parseArgs(process.argv.slice(2));
  let metrics = null;
  let error = null;
  try {
    metrics = measureCorpus({
      dataDir: args.dataDir,
      cursorPath: args.cursorPath,
      segmentSize: args.segmentSize,
      threshold: args.threshold,
    });
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }

  if (error) {
    // Fail closed: a measurement that could not be made never opens the gate.
    const payload = {
      ok: false,
      error,
      gate: { pass: false },
      hint: 'measurement failed — the gate stays closed',
    };
    if (args.jsonOut) writeFileSync(args.jsonOut, `${JSON.stringify(payload, null, 2)}\n`);
    if (args.json) {
      console.log(JSON.stringify(payload, null, 2));
    } else {
      console.error(`corpus coverage: measurement failed — ${error}`);
      console.error('gate: closed (fail-closed) — the segment must not advance');
    }
    process.exit(2);
  }

  const pct = (x) => `${(x * 100).toFixed(2)}%`;
  if (args.jsonOut) writeFileSync(args.jsonOut, `${JSON.stringify(metrics, null, 2)}\n`);
  if (args.json) {
    console.log(JSON.stringify(metrics, null, 2));
  } else {
    const m = metrics;
    console.log(`corpus: ${m.dataDir}`);
    console.log(
      `  global        ${m.global.classified}/${m.global.judgable} = ${pct(m.global.coverage)} ` +
        `(${m.global.domains} domains)`,
    );
    console.log(
      `  last segment  ${m.segment.date} (${m.segment.source}) ${m.segment.classified}/${m.segment.judgable} = ${pct(m.segment.coverage)}`,
    );
    console.log(
      `  predicted     ${m.predicted.classified}/${m.predicted.judgable} = ${pct(m.predicted.coverage)} ` +
        'after a segment like the last one',
    );
    console.log(`  threshold     ${pct(m.threshold)}`);
    console.log(
      `gate: global ${m.gate.globalOk ? 'ok' : 'FAIL'} / predicted ${m.gate.predictedOk ? 'ok' : 'FAIL'} / ` +
        `segment ${m.gate.segmentOk ? 'ok' : 'FAIL'} → ${m.gate.pass ? 'PASS' : 'FAIL'}`,
    );
    if (!m.gate.pass) {
      console.log(
        `  → ${m.need.sites} more site(s) need a category ` +
          `(segment ${m.need.segment}, projected ${m.need.projected}, global ${m.need.global})`,
      );
      console.log(`  → ${m.hint}`);
    }
  }
  if (args.fail && !metrics.gate.pass) process.exit(1);
}
