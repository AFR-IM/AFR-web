#!/usr/bin/env node
// scripts/backfill-page-meta.mjs — write the page metadata into the snapshots
// that were taken before the scanner captured it.
//
// Why this exists
//   The scanner captures the page's own title, language and self-description
//   while the homepage body is still in hand and stores them as fields of the
//   homepage probe (`signals.homepage.title` / `.lang` / `.meta`). The raw
//   bodies are the bulk of the corpus (~98%) and are pruned away — the body is
//   only needed to re-judge the AI-feature signals offline.
//
//   The historical snapshots predate those fields. Pruning their bodies would
//   therefore wipe the titles (measured: 805 of 805 titles lost on one day)
//   and downgrade the sites whose category came from their meta description
//   (measured: 3 of 1,010 sites fell back to "other").
//
//   So the fields are backfilled offline, from the bodies that are still
//   there, with the very same parser the scanner uses
//   (packages/scanner/src/page-meta.ts). After the backfill a snapshot can
//   lose its body without losing its name, its language or its category.
//
// What it does
//   · Reads every snapshot under the scans root.
//   · For a snapshot whose homepage probe lacks `title` / `lang` / `meta`,
//     derives the missing ones from the stored homepage body and writes them
//     into the probe.
//   · Adds nothing else. The bodies, the AI-feature signals and the whole
//     `afr` block (scores, grades, evidence) are left byte-for-byte alone,
//     and the file keeps its own style (indentation, trailing newline, key
//     order) — the same rules scripts/prune-snapshot-bodies.mjs uses.
//
// What it does NOT do
//   · It never invents a field. A page that declares no title has no title
//     field; a snapshot whose body is already gone is skipped and counted
//     separately — those bytes are gone for good and only a new scan can
//     restore them.
//   · It never overwrites a field that is already there.
//
// Usage
//   node scripts/backfill-page-meta.mjs [scans-dir] [options]
//
//   scans-dir            snapshot root (default: ../AFR-data/scans)
//   --data-dir PATH      the same, named explicitly
//   --dry-run            report only (default)
//   --write              write the backfilled snapshots back
//   --out DIR            write into DIR instead of in place (tree is mirrored)
//   --report FILE.md     write the human-readable report
//   --limit N            stop after N snapshots (quick checks)
//   --quiet              only print the summary line
//
// Examples
//   node scripts/backfill-page-meta.mjs                                   # dry run
//   node scripts/backfill-page-meta.mjs --write                          # apply
//   node scripts/backfill-page-meta.mjs --write --out /tmp/afr-copy      # mirror

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { capturePageMeta } from '../packages/scanner/src/page-meta.ts';
import { collectSnapshots, detectStyle, serialize, DEFAULT_SCANS_DIR } from './rederive-signals.mjs';

export const DEFAULT_DIR = DEFAULT_SCANS_DIR;

/* ── arguments ─────────────────────────────────────────────────────────── */

export function parseArgs(argv) {
  const opts = {
    dir: null,
    write: false,
    out: null,
    report: null,
    limit: Infinity,
    limitGiven: false,
    quiet: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--write') opts.write = true;
    else if (a === '--dry-run') opts.write = false;
    else if (a === '--quiet') opts.quiet = true;
    else if (a === '--data-dir') opts.dir = argv[++i];
    else if (a.startsWith('--data-dir=')) opts.dir = a.slice('--data-dir='.length);
    else if (a === '--out') opts.out = argv[++i];
    else if (a.startsWith('--out=')) opts.out = a.slice('--out='.length);
    else if (a === '--report') opts.report = argv[++i];
    else if (a.startsWith('--report=')) opts.report = a.slice('--report='.length);
    else if (a === '--limit') {
      opts.limit = Number(argv[++i]);
      opts.limitGiven = true;
    } else if (a.startsWith('--limit=')) {
      opts.limit = Number(a.slice('--limit='.length));
      opts.limitGiven = true;
    }
    else if (a.startsWith('-')) throw new Error(`unknown option: ${a}`);
    else if (opts.dir === null) opts.dir = a;
    else throw new Error(`unexpected argument: ${a}`);
  }
  if (opts.limitGiven && (!Number.isInteger(opts.limit) || opts.limit < 0)) {
    throw new Error(`--limit must be a non-negative integer, got: ${opts.limit}`);
  }
  opts.dir = resolve(opts.dir ?? process.env.AFR_SCANS_DIR ?? DEFAULT_DIR);
  if (opts.out) opts.out = resolve(opts.out);
  if (opts.report) opts.report = resolve(opts.report);
  return opts;
}

/* ── the backfill itself ───────────────────────────────────────────────── */

/** A field counts as present when it is a non-empty string. */
function hasText(value) {
  return typeof value === 'string' && value.trim() !== '';
}

/** A meta block counts as present when it carries at least one usable value. */
function hasMeta(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return ['ogSiteName', 'appName', 'description', 'keywords'].some((k) => hasText(value[k]));
}

/**
 * What a snapshot is missing, and what can be derived from its body.
 *
 * Returns one of:
 *   { status: 'no-homepage' }        — the snapshot has no homepage probe
 *   { status: 'no-body' }             — the probe carries no body (already
 *                                       pruned, or never stored): the fields
 *                                       cannot be derived and must not be
 *                                       invented
 *   { status: 'complete', missing }   — nothing to do
 *   { status: 'partial', additions }  — these fields can be written
 *
 * `additions` holds only the fields that are missing AND derivable, so a
 * page that declares no title simply gets no title field.
 */
export function planBackfill(snapshot) {
  const homepage = snapshot?.signals?.homepage;
  if (!homepage || typeof homepage !== 'object') {
    return { status: 'no-homepage', missing: ['title', 'lang', 'meta'], additions: {} };
  }
  const missing = [];
  if (!hasText(homepage.title)) missing.push('title');
  if (!hasText(homepage.lang)) missing.push('lang');
  if (!hasMeta(homepage.meta)) missing.push('meta');
  if (missing.length === 0) {
    return { status: 'complete', missing: [], additions: {} };
  }
  if (typeof homepage.body !== 'string') {
    return { status: 'no-body', missing, additions: {} };
  }
  const derived = capturePageMeta(homepage.body);
  const additions = {};
  if (missing.includes('title') && hasText(derived.title)) additions.title = derived.title;
  if (missing.includes('lang') && hasText(derived.lang)) additions.lang = derived.lang;
  if (missing.includes('meta') && derived.meta && hasMeta(derived.meta)) {
    additions.meta = derived.meta;
  }
  if (Object.keys(additions).length === 0) {
    return { status: 'nothing-derived', missing, additions: {} };
  }
  return { status: 'partial', missing, additions };
}

/**
 * The snapshot with the missing fields written into its homepage probe.
 *
 * Only the probe changes: the new keys are appended after the existing ones
 * (status, body, url, title, lang, meta — the order the scanner writes), and
 * everything else is carried over untouched.
 */
export function applyBackfill(snapshot, additions) {
  const homepage = snapshot.signals.homepage;
  return {
    ...snapshot,
    signals: {
      ...snapshot.signals,
      homepage: { ...homepage, ...additions },
    },
  };
}

/* ── the report ────────────────────────────────────────────────────────── */

const mb = (bytes) => `${(bytes / 1048576).toFixed(1)} MB`;

export function main(argv = process.argv.slice(2)) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (err) {
    console.error(String(err.message ?? err));
    console.error(
      'usage: node scripts/backfill-page-meta.mjs [scans-dir] [--data-dir PATH] [--write] [--out DIR] [--report FILE] [--limit N] [--quiet]',
    );
    process.exit(2);
  }

  if (!existsSync(opts.dir) || !statSync(opts.dir).isDirectory()) {
    console.error(`not a directory: ${opts.dir}`);
    process.exit(1);
  }

  const files = collectSnapshots(opts.dir);
  const total = Math.min(files.length, opts.limit);

  const stats = {
    snapshots: 0,
    complete: 0,
    partial: 0,
    nothingDerived: 0,
    noHomepage: 0,
    noBody: 0,
    parseFailures: 0,
    styleRoundTripFailures: 0,
    written: 0,
    bytesBefore: 0,
    bytesAfter: 0,
    bytesChangedBefore: 0,
    added: { title: 0, lang: 0, meta: 0 },
    writeFailures: [],
  };
  const touched = [];

  for (let i = 0; i < total; i++) {
    const { path: file, date } = files[i];
    const raw = readFileSync(file, 'utf8');
    stats.snapshots++;
    stats.bytesBefore += Buffer.byteLength(raw);
    let snapshot;
    try {
      snapshot = JSON.parse(raw);
    } catch {
      stats.parseFailures++;
      continue;
    }
    const plan = planBackfill(snapshot);
    if (plan.status === 'complete') {
      stats.complete++;
      continue;
    }
    if (plan.status === 'no-homepage') {
      stats.noHomepage++;
      continue;
    }
    if (plan.status === 'no-body') {
      stats.noBody++;
      continue;
    }
    if (plan.status === 'nothing-derived') {
      stats.nothingDerived++;
      continue;
    }
    const next = applyBackfill(snapshot, plan.additions);
    const style = detectStyle(raw);
    const content = serialize(next, style);
    if (content === raw) continue;
    // A file whose parse→serialize round trip is not byte-identical would be
    // rewritten in a different shape than it was written in; such a file is
    // reported instead of rewritten.
    if (serialize(snapshot, style) !== raw) {
      stats.styleRoundTripFailures++;
      continue;
    }
    stats.partial++;
    for (const key of Object.keys(plan.additions)) stats.added[key]++;
    stats.bytesAfter += Buffer.byteLength(content);
    stats.bytesChangedBefore += Buffer.byteLength(raw);
    touched.push({ file: relative(opts.dir, file), date, additions: Object.keys(plan.additions) });

    if (!opts.write) continue;
    const target = opts.out ? join(opts.out, relative(opts.dir, file)) : file;
    try {
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, content);
      stats.written++;
    } catch (err) {
      stats.writeFailures.push({ file: relative(opts.dir, file), error: String(err.message ?? err) });
    }
  }

  const lines = [];
  lines.push(`# Page metadata backfill — ${opts.write ? 'write' : 'dry run'}`);
  lines.push('');
  lines.push(`- scans root: \`${opts.dir}\``);
  lines.push(`- fields written: \`signals.homepage.title\` / \`.lang\` / \`.meta\``);
  lines.push('');
  lines.push('## Result');
  lines.push('');
  lines.push(`- snapshots read: ${stats.snapshots}`);
  lines.push(`- already complete (nothing to do): ${stats.complete}`);
  lines.push(`- backfilled (at least one field written): ${stats.partial}`);
  lines.push(`- nothing derivable (the page declares none of them): ${stats.nothingDerived}`);
  lines.push(`- skipped — no homepage probe: ${stats.noHomepage}`);
  lines.push(`- **skipped — the body is already gone (fields cannot be invented): ${stats.noBody}**`);
  if (stats.parseFailures) lines.push(`- **unparseable snapshots: ${stats.parseFailures}**`);
  if (stats.styleRoundTripFailures) {
    lines.push(`- **style round-trip failures (not rewritten): ${stats.styleRoundTripFailures}**`);
  }
  lines.push('');
  lines.push('## Fields written');
  lines.push('');
  lines.push(`- \`title\`: ${stats.added.title}`);
  lines.push(`- \`lang\`: ${stats.added.lang}`);
  lines.push(`- \`meta\`: ${stats.added.meta}`);
  lines.push('');
  lines.push('## Size');
  lines.push('');
  lines.push(
    `- corpus before: ${mb(stats.bytesBefore)} · the ${stats.partial} backfilled file(s): ${mb(stats.bytesChangedBefore)} → ${mb(stats.bytesAfter)}`,
  );
  lines.push(
    `- projected corpus after the backfill: ${mb(stats.bytesBefore - stats.bytesChangedBefore + stats.bytesAfter)} (+${mb(stats.bytesAfter - stats.bytesChangedBefore)})`,
  );
  lines.push(`- snapshots written: ${stats.written}`);
  if (stats.writeFailures.length) {
    lines.push('');
    lines.push('## Write failures');
    lines.push('');
    for (const f of stats.writeFailures) lines.push(`- ${f.file}: ${f.error}`);
  }
  lines.push('');
  lines.push('## How to apply');
  lines.push('');
  lines.push('```sh');
  lines.push('# 1) dry run over the corpus (no file is touched)');
  lines.push('node scripts/backfill-page-meta.mjs ../AFR-data/scans');
  lines.push('');
  lines.push('# 2) apply (commits the backfilled snapshots)');
  lines.push('node scripts/backfill-page-meta.mjs ../AFR-data/scans --write');
  lines.push('```');
  lines.push('');
  const markdown = lines.join('\n') + '\n';

  if (!opts.quiet) console.log(markdown);
  else
    console.log(
      `${opts.write ? 'write' : 'dry-run'}: ${stats.snapshots} snapshots · ${stats.partial} backfilled · ${stats.noBody} skipped (no body) · ${stats.complete} already complete`,
    );

  if (opts.report) {
    mkdirSync(dirname(opts.report), { recursive: true });
    writeFileSync(opts.report, markdown);
  }

  return { stats, touched };
}

// Run only when executed directly (`node scripts/backfill-page-meta.mjs`).
const invokedDirectly =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) main();

export { capturePageMeta };
