#!/usr/bin/env node
// scripts/rederive-signals.mjs — re-derive the in-site AI feature signals of
// existing scan snapshots, offline, and re-score what changed.
//
// Why this exists
//   The scanner freezes its findings in the snapshot. When the judgement of the
//   in-site AI features (chat assistant / AI search / developer console)
//   changes, every stored snapshot keeps the old verdict until the site is
//   crawled again. The homepage body is stored inside the snapshot, so the
//   signals can be re-derived without touching the network — no crawl, no
//   politeness budget, no re-scan.
//
// What it does NOT do
//   It does not re-implement the judgement and it does not re-implement the
//   scoring. The signals come from the scanner's own `detectAiFeatures`
//   (packages/scanner/src/markup.ts, reached through packages/scanner/src/scan.ts)
//   and the score comes from the engine entry point `scoreAfr` that
//   scripts/recalc.mjs uses. Only the input changes.
//
// Fidelity rules
//   · A snapshot is re-derivable only when its homepage probe was a 2xx with a
//     non-empty body — the same condition the live scanner uses before it
//     judges the markup. A 403 challenge page is not a homepage, so those
//     snapshots keep `aiFeatures: undefined` ("not probed").
//   · Only `signals.aiFeatures` and the re-scored `afr` block are touched.
//     Every other field, the key order, the indentation and the trailing
//     newline of the file are preserved exactly as they were.
//
// Usage
//   node scripts/rederive-signals.mjs [scans-dir] [options]
//
//   scans-dir            snapshot root (default: ../AFR-data/scans)
//   --write              write the updated snapshots back (default: dry run)
//   --dry-run            report only (default)
//   --date YYYY/MM/DD    restrict to one date folder (repeatable, prefix match)
//   --out DIR            write into DIR instead of in place (tree is mirrored)
//   --recalc-all         also re-score snapshots whose signals did not change
//                        (use after a bulk re-score to make the corpus uniform)
//   --bump-scanner-version  set signals.scannerVersion to the scanner version
//                        that owns the current judgement (off by default)
//   --report FILE.md     write the human-readable report
//   --json-report FILE   write the machine-readable report
//   --limit N            stop after N snapshots (for quick checks)
//   --quiet              only print the summary line
//
// Examples
//   node scripts/rederive-signals.mjs                                   # dry run, all dates
//   node scripts/rederive-signals.mjs --date 2026/11/17 --write         # one day, in place
//   node scripts/rederive-signals.mjs /tmp/afr-data-rewritten/scans --write --out /tmp/afr-out

import { readFileSync, writeFileSync, readdirSync, mkdirSync, existsSync, statSync } from 'node:fs';
import { join, resolve, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { detectAiFeatures } from '../packages/scanner/src/index.ts';
import { scoreAfr } from '../packages/afr/src/index.ts';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
/** Default snapshot root: the AFR-data checkout that sits next to this repo */
export const DEFAULT_SCANS_DIR = resolve(repoRoot, '..', 'AFR-data', 'scans');

/** Body cap of the scanner — a body of exactly this size was truncated */
export const BODY_CAP = 1024 * 1024;

/* ── arguments ─────────────────────────────────────────────────────────── */

export function parseArgs(argv) {
  const opts = {
    dir: null,
    write: false,
    dates: [],
    out: null,
    recalcAll: false,
    bumpScannerVersion: false,
    report: null,
    jsonReport: null,
    limit: Infinity,
    quiet: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--write') opts.write = true;
    else if (a === '--dry-run') opts.write = false;
    else if (a === '--recalc-all') opts.recalcAll = true;
    else if (a === '--bump-scanner-version') opts.bumpScannerVersion = true;
    else if (a === '--quiet') opts.quiet = true;
    else if (a === '--date') opts.dates.push(argv[++i]);
    else if (a === '--out') opts.out = argv[++i];
    else if (a === '--report') opts.report = argv[++i];
    else if (a === '--json-report') opts.jsonReport = argv[++i];
    else if (a === '--limit') opts.limit = Number(argv[++i]);
    else if (a.startsWith('-')) throw new Error(`unknown option: ${a}`);
    else if (opts.dir === null) opts.dir = a;
    else throw new Error(`unexpected argument: ${a}`);
  }
  opts.dir = resolve(opts.dir ?? process.env.AFR_SCANS_DIR ?? DEFAULT_SCANS_DIR);
  if (opts.out) opts.out = resolve(opts.out);
  return opts;
}

/* ── snapshot helpers ──────────────────────────────────────────────────── */

/**
 * The file style of a snapshot: indentation width and trailing newline.
 * The corpus holds two styles (1-space + newline from scripts/recalc.mjs,
 * 2-space without newline from the scanner CLI) and both are preserved.
 */
export function detectStyle(raw) {
  const m = raw.match(/\n(\s+)"/);
  return { indent: m ? m[1].length : 2, trailingNewline: raw.endsWith('\n') };
}

/** Serialize a snapshot in the style of the file it came from */
export function serialize(value, style) {
  return JSON.stringify(value, null, style.indent) + (style.trailingNewline ? '\n' : '');
}

/**
 * A snapshot can be re-derived offline when its homepage probe was a 2xx with
 * a non-empty body — the same gate the live scanner applies before it judges
 * the markup (a challenged homepage is not a homepage).
 */
export function isReDerivable(homepage) {
  if (!homepage || typeof homepage !== 'object') return false;
  const status = homepage.status;
  if (status === undefined || status < 200 || status >= 300) return false;
  return typeof homepage.body === 'string' && homepage.body.length > 0;
}

/** True when the stored body hit the scanner's body cap (truncated page) */
export function isTruncated(homepage) {
  return typeof homepage?.body === 'string' && homepage.body.length >= BODY_CAP;
}

const FEATURE_KEYS = ['chatWidget', 'aiSearch', 'developerConsole'];

/** Compare two feature objects; missing keys count as false */
export function featuresEqual(a, b) {
  const va = a ?? {};
  const vb = b ?? {};
  return FEATURE_KEYS.every((k) => Boolean(va[k]) === Boolean(vb[k]));
}

/** The transitions between two feature objects, e.g. 'chatWidget:true->false' */
export function featureTransitions(a, b) {
  const va = a ?? {};
  const vb = b ?? {};
  return FEATURE_KEYS.filter((k) => Boolean(va[k]) !== Boolean(vb[k])).map(
    (k) => `${k}:${Boolean(va[k])}->${Boolean(vb[k])}`,
  );
}

/**
 * Compare two snapshots structurally and return the paths that differ.
 * Used to prove that a write-back touched nothing but the expected fields.
 */
export function jsonDiff(a, b, path = '', out = []) {
  if (a === b) return out;
  const ta = a === null ? 'null' : Array.isArray(a) ? 'array' : typeof a;
  const tb = b === null ? 'null' : Array.isArray(b) ? 'array' : typeof b;
  if (ta !== tb) {
    out.push(path || '<root>');
    return out;
  }
  if (ta === 'object') {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const k of keys) {
      const child = path ? `${path}.${k}` : k;
      if (!(k in a) || !(k in b)) out.push(child);
      else jsonDiff(a[k], b[k], child, out);
    }
    return out;
  }
  if (ta === 'array') {
    if (a.length !== b.length) {
      out.push(`${path}[]`);
      return out;
    }
    for (let i = 0; i < a.length; i++) jsonDiff(a[i], b[i], `${path}[${i}]`, out);
    return out;
  }
  out.push(path || '<root>');
  return out;
}

/* ── snapshot discovery ────────────────────────────────────────────────── */

/** Collect the snapshot files of a scan root, newest date folder last */
export function collectSnapshots(dir, dates = []) {
  const files = [];
  const walk = (d, datePath) => {
    let entries;
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p, datePath ? `${datePath}/${e.name}` : e.name);
      else if (e.name.endsWith('.json')) files.push({ path: p, date: datePath });
    }
  };
  walk(dir, '');
  if (dates.length === 0) return files;
  return files.filter((f) => dates.some((d) => f.date && (f.date === d || f.date.startsWith(`${d}/`))));
}

/* ── main ──────────────────────────────────────────────────────────────── */

function gradeRank(g) {
  return { F: 0, D: 1, C: 2, B: 3, A: 4, Pending: -1 }[g] ?? -1;
}

function pct(x, base) {
  return base ? `${((100 * x) / base).toFixed(1)}%` : '—';
}

function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(String(err.message ?? err));
    console.error(
      'usage: node scripts/rederive-signals.mjs [scans-dir] [--write] [--date YYYY/MM/DD] [--out DIR]',
    );
    process.exit(1);
  }

  if (!existsSync(opts.dir) || !statSync(opts.dir).isDirectory()) {
    console.error(`not a directory: ${opts.dir}`);
    process.exit(1);
  }

  const snapshots = collectSnapshots(opts.dir, opts.dates);
  const total = Math.min(snapshots.length, opts.limit);

  const stats = {
    dir: opts.dir,
    mode: opts.write ? 'write' : 'dry-run',
    dates: opts.dates,
    snapshots: total,
    reDerivable: 0,
    notDerivable: 0,
    truncated: 0,
    changed: 0,
    unchanged: 0,
    written: 0,
    styleRoundTripFailures: 0,
    transitions: {},
    // effect of the new signals alone (same engine, old vs. new features)
    signalUp: 0,
    signalDown: 0,
    signalSame: 0,
    // effect of the whole rewrite (stored snapshot vs. re-derived + re-scored)
    totalUp: 0,
    totalDown: 0,
    totalSame: 0,
    signalGradeUp: 0,
    signalGradeDown: 0,
    totalGradeUp: 0,
    totalGradeDown: 0,
    signalDeltaSum: 0,
    signalDeltaCount: 0,
    totalDeltaSum: 0,
    totalDeltaCount: 0,
    // how far the stored snapshots are from the current engine, independent
    // of the signals (the engine moved on since the snapshots were written)
    engineDriftFiles: 0,
    engineDriftChecked: 0,
    engineDriftUp: 0,
    engineDriftDown: 0,
    engineDriftSame: 0,
    engineDriftSum: 0,
    maxDrop: null,
    maxGain: null,
    changedPaths: {},
  };
  const affected = [];
  const writeFailures = [];

  for (let i = 0; i < total; i++) {
    const { path: file, date } = snapshots[i];
    const raw = readFileSync(file, 'utf8');
    const style = detectStyle(raw);
    let snapshot;
    try {
      snapshot = JSON.parse(raw);
    } catch {
      continue;
    }
    const signals = snapshot?.signals;
    if (!signals || typeof signals !== 'object') continue;

    // style fidelity: the file must survive a parse/serialize round trip
    if (serialize(snapshot, style) !== raw) stats.styleRoundTripFailures++;

    const homepage = signals.homepage;
    const derivable = isReDerivable(homepage);

    // The engine result of the stored signals (old features, current engine):
    // the baseline that isolates the effect of the new signals, and at the
    // same time the measure of how far the stored score is from the engine.
    let baseline = null;
    try {
      baseline = scoreAfr(signals);
    } catch {
      continue;
    }
    const storedScore = snapshot.afr?.score ?? null;
    if (storedScore !== null) {
      stats.engineDriftChecked++;
      if (storedScore !== baseline.score) {
        stats.engineDriftFiles++;
        stats.engineDriftSum += baseline.score - storedScore;
        if (baseline.score > storedScore) stats.engineDriftUp++;
        else stats.engineDriftDown++;
      } else stats.engineDriftSame++;
    }

    if (!derivable) {
      stats.notDerivable++;
      continue;
    }
    stats.reDerivable++;
    if (isTruncated(homepage)) stats.truncated++;

    const oldFeatures = signals.aiFeatures;
    let newFeatures = oldFeatures;
    let changed = false;
    try {
      newFeatures = detectAiFeatures(homepage.body);
      changed = !featuresEqual(oldFeatures, newFeatures);
    } catch {
      continue;
    }

    let next = baseline;
    if (changed) {
      const nextSignals = { ...signals, aiFeatures: newFeatures };
      try {
        next = scoreAfr(nextSignals);
      } catch {
        continue;
      }
      stats.changed++;
      const transitions = featureTransitions(oldFeatures, newFeatures);
      for (const t of transitions) stats.transitions[t] = (stats.transitions[t] ?? 0) + 1;

      const signalDelta = next.score - baseline.score;
      const totalDelta = next.score - (storedScore ?? baseline.score);
      stats.signalDeltaSum += signalDelta;
      stats.signalDeltaCount++;
      stats.totalDeltaSum += totalDelta;
      stats.totalDeltaCount++;

      if (signalDelta > 0) stats.signalUp++;
      else if (signalDelta < 0) stats.signalDown++;
      else stats.signalSame++;

      if (totalDelta > 0) stats.totalUp++;
      else if (totalDelta < 0) stats.totalDown++;
      else stats.totalSame++;

      const storedGrade = snapshot.afr?.grade ?? baseline.grade;
      const storedRank = gradeRank(storedGrade);
      const baselineRank = gradeRank(baseline.grade);
      const newRank = gradeRank(next.grade);
      if (baselineRank !== newRank && baselineRank >= 0 && newRank >= 0) {
        if (newRank > baselineRank) stats.signalGradeUp++;
        else stats.signalGradeDown++;
      }
      if (storedRank !== newRank && storedRank >= 0 && newRank >= 0) {
        if (newRank > storedRank) stats.totalGradeUp++;
        else stats.totalGradeDown++;
      }

      const record = {
        domain: signals.domain ?? file,
        date,
        file: relative(opts.dir, file),
        storedScore,
        storedGrade,
        baselineScore: baseline.score,
        baselineGrade: baseline.grade,
        newScore: next.score,
        newGrade: next.grade,
        signalDelta,
        totalDelta,
        transitions,
        truncated: isTruncated(homepage),
        bodyBytes: homepage.body.length,
      };
      affected.push(record);
      if (signalDelta < 0 && (!stats.maxDrop || signalDelta < stats.maxDrop.signalDelta)) {
        stats.maxDrop = record;
      }
      if (signalDelta > 0 && (!stats.maxGain || signalDelta > stats.maxGain.signalDelta)) {
        stats.maxGain = record;
      }
    } else {
      stats.unchanged++;
    }

    const shouldWrite = opts.write && (changed || opts.recalcAll);
    if (!shouldWrite) continue;

    // Build the next snapshot: only the signals and the re-scored block change.
    const nextSnapshot = { ...snapshot };
    const nextSignals = { ...signals };
    if (changed) nextSignals.aiFeatures = newFeatures;
    if (opts.bumpScannerVersion) nextSignals.scannerVersion = 'scanner-0.2.0';
    nextSnapshot.signals = nextSignals;
    nextSnapshot.afr = next;

    const content = serialize(nextSnapshot, style);
    const target = opts.out ? join(opts.out, relative(opts.dir, file)) : file;
    try {
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, content);
      stats.written++;
      for (const p of jsonDiff(snapshot, nextSnapshot)) {
        stats.changedPaths[p] = (stats.changedPaths[p] ?? 0) + 1;
      }
    } catch (err) {
      writeFailures.push({ file, error: String(err.message ?? err) });
    }

    if (!opts.quiet && (i + 1) % 500 === 0) process.stderr.write(`… ${i + 1}/${total}\n`);
  }

  affected.sort((a, b) => a.signalDelta - b.signalDelta);
  const avgSignal = stats.signalDeltaCount
    ? (stats.signalDeltaSum / stats.signalDeltaCount).toFixed(2)
    : '—';

  const lines = [];
  lines.push(`# Re-derived in-site AI features — ${stats.mode}`);
  lines.push('');
  lines.push(`- snapshots read: ${stats.snapshots} (${opts.dir})`);
  lines.push(
    `- re-derivable (homepage 2xx with body): ${stats.reDerivable} (${pct(stats.reDerivable, stats.snapshots)})`,
  );
  lines.push(
    `- not re-derivable (no homepage / non-2xx): ${stats.notDerivable} (${pct(stats.notDerivable, stats.snapshots)})`,
  );
  lines.push(`- body truncated at the 1 MiB scanner cap: ${stats.truncated}`);
  lines.push(`- signals changed: ${stats.changed} · unchanged: ${stats.unchanged}`);
  lines.push(`- snapshots written: ${stats.written}`);
  if (stats.styleRoundTripFailures) {
    lines.push(`- **style round-trip failures: ${stats.styleRoundTripFailures}**`);
  }
  lines.push('');
  lines.push('## Signal transitions');
  lines.push('');
  const tKeys = Object.keys(stats.transitions).sort();
  if (tKeys.length === 0) lines.push('_none_');
  for (const k of tKeys) lines.push(`- ${k}: ${stats.transitions[k]}`);
  lines.push('');
  lines.push('## Score effect of the new signals (same engine, old signals as baseline)');
  lines.push('');
  lines.push(`- up: ${stats.signalUp} · down: ${stats.signalDown} · unchanged: ${stats.signalSame}`);
  lines.push(`- average change: ${avgSignal} points`);
  lines.push(
    `- largest drop: ${stats.maxDrop ? `${stats.maxDrop.domain} ${stats.maxDrop.baselineScore}→${stats.maxDrop.newScore}` : '—'}`,
  );
  lines.push(
    `- largest gain: ${stats.maxGain ? `${stats.maxGain.domain} ${stats.maxGain.baselineScore}→${stats.maxGain.newScore}` : '—'}`,
  );
  lines.push(`- grade up: ${stats.signalGradeUp} · grade down: ${stats.signalGradeDown}`);
  lines.push('');
  lines.push('## Score effect of the whole rewrite (stored snapshot vs. re-derived + re-scored)');
  lines.push('');
  lines.push(`- up: ${stats.totalUp} · down: ${stats.totalDown} · unchanged: ${stats.totalSame}`);
  lines.push(
    `- average change: ${stats.totalDeltaCount ? (stats.totalDeltaSum / stats.totalDeltaCount).toFixed(2) : '—'} points`,
  );
  lines.push(`- grade up: ${stats.totalGradeUp} · grade down: ${stats.totalGradeDown}`);
  lines.push('');
  lines.push('## Engine drift (stored score vs. the current engine, signals untouched)');
  lines.push('');
  lines.push(
    `- snapshots whose stored score is behind the engine: ${stats.engineDriftFiles} (${pct(stats.engineDriftFiles, stats.snapshots)})`,
  );
  lines.push(`- up: ${stats.engineDriftUp} · down: ${stats.engineDriftDown} · unchanged: ${stats.engineDriftSame}`);
  lines.push(
    `- average change: ${stats.engineDriftFiles ? (stats.engineDriftSum / stats.engineDriftFiles).toFixed(2) : '—'} points`,
  );
  lines.push('');
  lines.push('## Ten largest drops (by signal effect)');
  lines.push('');
  lines.push('| domain | date | stored → new | Δsignal | grade | transitions |');
  lines.push('| --- | --- | --- | --- | --- | --- |');
  for (const r of affected.slice(0, 10)) {
    lines.push(
      `| ${r.domain} | ${r.date} | ${r.storedScore} → ${r.newScore} | ${r.signalDelta} | ${r.storedGrade} → ${r.newGrade} | ${r.transitions.join(', ')} |`,
    );
  }
  lines.push('');
  lines.push('## Ten largest gains (by signal effect)');
  lines.push('');
  lines.push('| domain | date | stored → new | Δsignal | grade | transitions |');
  lines.push('| --- | --- | --- | --- | --- | --- |');
  for (const r of affected.slice(-10).reverse()) {
    lines.push(
      `| ${r.domain} | ${r.date} | ${r.storedScore} → ${r.newScore} | ${r.signalDelta} | ${r.storedGrade} → ${r.newGrade} | ${r.transitions.join(', ')} |`,
    );
  }
  if (writeFailures.length) {
    lines.push('');
    lines.push('## Write failures');
    lines.push('');
    for (const f of writeFailures) lines.push(`- ${f.file}: ${f.error}`);
  }
  lines.push('');
  lines.push('## How to apply');
  lines.push('');
  lines.push('```sh');
  lines.push('# 1) dry run over the corpus (no file is touched)');
  lines.push('node scripts/rederive-signals.mjs ../AFR-data/scans');
  lines.push('');
  lines.push('# 2) write the re-derived signals + the re-scored block back');
  lines.push('node scripts/rederive-signals.mjs ../AFR-data/scans --write');
  lines.push('');
  lines.push('# 3) optional: bring every snapshot onto the current engine as well');
  lines.push('node scripts/rederive-signals.mjs ../AFR-data/scans --write --recalc-all');
  lines.push('```');
  lines.push('');
  const markdown = lines.join('\n') + '\n';

  if (!opts.quiet) console.log(markdown);
  else
    console.log(
      `${stats.mode}: ${stats.snapshots} snapshots · ${stats.reDerivable} re-derivable · ${stats.changed} changed · ${stats.written} written`,
    );

  if (opts.report) {
    mkdirSync(dirname(resolve(opts.report)), { recursive: true });
    writeFileSync(resolve(opts.report), markdown);
  }
  if (opts.jsonReport) {
    mkdirSync(dirname(resolve(opts.jsonReport)), { recursive: true });
    writeFileSync(
      resolve(opts.jsonReport),
      JSON.stringify(
        {
          stats: { ...stats, changedPaths: undefined },
          changedPaths: stats.changedPaths,
          affected,
          writeFailures,
        },
        null,
        2,
      ) + '\n',
    );
  }
}

// Run only when executed directly (`node scripts/rederive-signals.mjs`).
const invokedDirectly =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) main();
