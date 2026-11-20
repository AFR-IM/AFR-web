#!/usr/bin/env node
// scripts/prune-snapshot-bodies.mjs — keep the AFR-data snapshot corpus inside
// the GitHub single-repository budget by dropping the raw response bodies from
// superseded snapshots, while keeping the evidence (the scored checks) intact.
//
// Why this exists
//   The data repository stores one JSON snapshot per scan. Each snapshot holds
//   two very different things:
//
//     · evidence — `afr.layers[].checks[]`: what every check found, the points
//       it awarded, and the human-readable reason. This is the audit trail.
//     · raw material — `signals.*.body`: the fetched HTML / robots.txt /
//       llms.txt / sitemap.xml / … as text. This is only needed to re-judge a
//       signal offline (`scripts/rederive-signals.mjs`) or to re-score a
//       snapshot with a newer engine (`scripts/recalc.mjs`).
//
//   The raw material is ~97% of the corpus and the evidence is ~2%. At the
//   measured median of ~470 KB per snapshot the corpus outgrows GitHub's
//   5 GB hard limit at well under 100k sites. Keeping the newest raw copy per
//   domain keeps the re-derivation ability for the current version of every
//   site while making the historical corpus small.
//
// What it does
//   · Retention rule: the newest `--keep N` snapshots of every domain keep
//     their raw bodies; every older snapshot keeps its evidence and loses its
//     raw bodies.
//   · `--max-age-days D` adds an age gate: a snapshot older than D days loses
//     its raw bodies even when it is the newest one of its domain.
//   · `--prune-text none|unused|all` selects which bodies are removed from a
//     superseded snapshot:
//       none   (default) only `signals.homepage.body` — the body the signal
//              re-derivation needs.
//       unused also `llmsFull` / `agentsMd` / `aiTxt`. The scoring engine
//              never reads those bodies (it only looks at their status), so
//              removing them costs nothing at all.
//       all    also `robots` / `llms` / `sitemap`. The engine DOES read those
//              bodies, so a snapshot pruned this way can no longer be
//              re-scored offline. Use with care.
//
// What it does NOT do
//   · It never touches the `afr` block, the check verdicts, the key order, the
//     indentation or the trailing newline of a file.
//   · It never deletes a snapshot. The scan history stays complete; only the
//     raw bytes of superseded snapshots go away.
//
// Body removal: the key is deleted, not set to null
//   The scanner already has a "body not kept" shape: a response that is too
//   large is stored as `{ status, url }` without a `body` key
//   (packages/scanner/src/http.ts). A pruned snapshot gets exactly that shape,
//   so every consumer keeps working through the code path it already has.
//   `null` would introduce a state the declared `HttpProbe` type
//   (`body?: string`) does not allow, i.e. a type lie that only fails at
//   runtime. `body ?? ''` and `typeof body === 'string'` consumers behave the
//   same for both.
//
// Usage
//   node scripts/prune-snapshot-bodies.mjs [scans-dir] [options]
//
//   scans-dir            snapshot root (default: ../AFR-data/scans)
//   --keep N             keep the newest N raw snapshots per domain (default 1)
//   --dry-run            report only (default)
//   --write              write the pruned snapshots back
//   --max-age-days D     drop bodies of snapshots older than D days
//   --now YYYY-MM-DD     reference date for --max-age-days (default: the
//                        newest snapshot in the corpus)
//   --prune-text MODE    none | unused | all (default none)
//   --out DIR            write into DIR instead of in place (tree is mirrored)
//   --report FILE.md     write the human-readable report
//   --json-report FILE   write the machine-readable report
//   --freeze-manifest F  write the list of pruned snapshots (JSON) — the input
//                        a future "never re-score a frozen snapshot" guard
//                        would need
//   --limit N            stop after N snapshots (quick checks)
//   --quiet              only print the summary line
//
// Examples
//   node scripts/prune-snapshot-bodies.mjs                                  # dry run
//   node scripts/prune-snapshot-bodies.mjs --write --keep 1                 # apply
//   node scripts/prune-snapshot-bodies.mjs --write --prune-text unused      # also drop
//                                                                        # unread bodies

import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync } from 'node:fs';
import { join, resolve, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  detectStyle,
  serialize,
  collectSnapshots,
  DEFAULT_SCANS_DIR,
} from './rederive-signals.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');

/** Default snapshot root: the AFR-data checkout that sits next to this repo */
export const DEFAULT_DIR = DEFAULT_SCANS_DIR;

/* ── the raw bodies ─────────────────────────────────────────────────────── */

/**
 * Every place a snapshot keeps a raw response body, as a path under
 * `signals`. The order is the order used in the report.
 */
export const RAW_BODY_PATHS = [
  ['homepage', ['homepage']],
  ['robots', ['robots']],
  ['llms', ['llms']],
  ['llmsFull', ['llmsFull']],
  ['sitemap', ['sitemap']],
  ['agentsMd', ['agentsMd']],
  ['aiTxt', ['aiTxt']],
];

/**
 * Bodies the scoring engine never reads — it only looks at the probe status
 * (packages/afr/src/l2.ts, l3.ts). Dropping them cannot change a score.
 */
export const UNUSED_BY_ENGINE = ['llmsFull', 'agentsMd', 'aiTxt'];

/**
 * Bodies the scoring engine does read (packages/afr/src/index.ts, l1.ts, l2.ts,
 * l3.ts). A snapshot that loses them can no longer be re-scored offline.
 */
export const USED_BY_ENGINE = ['homepage', 'robots', 'llms', 'sitemap'];

/** Which bodies each --prune-text mode removes from a superseded snapshot */
export const PRUNE_MODES = {
  none: ['homepage'],
  unused: ['homepage', 'llmsFull', 'agentsMd', 'aiTxt'],
  all: ['homepage', 'robots', 'llms', 'llmsFull', 'sitemap', 'agentsMd', 'aiTxt'],
};

/* ── arguments ─────────────────────────────────────────────────────────── */

export function parseArgs(argv) {
  const opts = {
    dir: null,
    write: false,
    keep: 1,
    maxAgeDays: null,
    now: null,
    pruneText: 'none',
    out: null,
    report: null,
    jsonReport: null,
    freezeManifest: null,
    limit: Infinity,
    quiet: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--write') opts.write = true;
    else if (a === '--dry-run') opts.write = false;
    else if (a === '--quiet') opts.quiet = true;
    else if (a === '--keep') opts.keep = Number(argv[++i]);
    else if (a === '--max-age-days') opts.maxAgeDays = Number(argv[++i]);
    else if (a === '--now') opts.now = argv[++i];
    else if (a === '--prune-text') opts.pruneText = argv[++i];
    else if (a === '--out') opts.out = argv[++i];
    else if (a === '--report') opts.report = argv[++i];
    else if (a === '--json-report') opts.jsonReport = argv[++i];
    else if (a === '--freeze-manifest') opts.freezeManifest = argv[++i];
    else if (a === '--limit') opts.limit = Number(argv[++i]);
    else if (a.startsWith('-')) throw new Error(`unknown option: ${a}`);
    else if (opts.dir === null) opts.dir = a;
    else throw new Error(`unexpected argument: ${a}`);
  }
  if (!Number.isInteger(opts.keep) || opts.keep < 0) {
    throw new Error(`--keep must be a non-negative integer, got: ${opts.keep}`);
  }
  if (opts.maxAgeDays !== null && (!Number.isFinite(opts.maxAgeDays) || opts.maxAgeDays < 0)) {
    throw new Error(`--max-age-days must be a non-negative number, got: ${opts.maxAgeDays}`);
  }
  if (!Object.hasOwn(PRUNE_MODES, opts.pruneText)) {
    throw new Error(
      `--prune-text must be one of ${Object.keys(PRUNE_MODES).join(' | ')}, got: ${opts.pruneText}`,
    );
  }
  if (opts.now !== null && !/^\d{4}-\d{2}-\d{2}$/.test(opts.now)) {
    throw new Error(`--now must be YYYY-MM-DD, got: ${opts.now}`);
  }
  opts.dir = resolve(opts.dir ?? process.env.AFR_SCANS_DIR ?? DEFAULT_DIR);
  if (opts.out) opts.out = resolve(opts.out);
  for (const key of ['report', 'jsonReport', 'freezeManifest']) {
    if (opts[key]) opts[key] = resolve(opts[key]);
  }
  return opts;
}

/* ── snapshot helpers ───────────────────────────────────────────────────── */

/** Read a nested value by path */
function at(obj, path) {
  let node = obj;
  for (const key of path) {
    if (node === null || typeof node !== 'object') return undefined;
    node = node[key];
  }
  return node;
}

/** The domain a snapshot belongs to */
export function domainOf(snapshot, file) {
  const signals = snapshot?.signals;
  const domain =
    signals?.domain ?? snapshot?.afr?.domain ?? String(file).split('/').pop()?.replace(/\.json$/, '');
  return typeof domain === 'string' ? domain : null;
}

/**
 * When the snapshot was taken. The stored timestamp is authoritative; the
 * date folder is the fallback for a snapshot without one.
 */
export function snapshotTime(snapshot, file) {
  const raw = snapshot?.signals?.fetchedAt ?? snapshot?.afr?.scannedAt;
  const t = Date.parse(raw ?? '');
  if (Number.isFinite(t)) return t;
  const m = /(20\d\d)[/\\-](\d\d)[/\\-](\d\d)/.exec(String(file));
  if (m) {
    const d = Date.parse(`${m[1]}-${m[2]}-${m[3]}T00:00:00Z`);
    if (Number.isFinite(d)) return d;
  }
  return null;
}

/** The byte size of a JSON value as it is written into the file (escaped) */
function jsonBytes(value) {
  if (value === undefined) return 0;
  return Buffer.byteLength(JSON.stringify(value) ?? '');
}

/**
 * Remove the listed raw bodies from a snapshot. The key is deleted (not set to
 * null) so the probe keeps the shape the scanner itself uses for "body not
 * kept" — see the header comment.
 */
export function pruneSnapshot(snapshot, fields) {
  const signals = snapshot?.signals;
  if (!signals || typeof signals !== 'object') return snapshot;
  let changed = false;
  const nextSignals = { ...signals };
  for (const field of fields) {
    const entry = RAW_BODY_PATHS.find(([name]) => name === field);
    if (!entry) continue;
    const [, path] = entry;
    const probe = at(nextSignals, path);
    if (!probe || typeof probe !== 'object') continue;
    if (!Object.hasOwn(probe, 'body')) continue;
    if (probe.body === undefined) continue;
    const nextProbe = { ...probe };
    delete nextProbe.body;
    nextSignals[path[0]] = nextProbe;
    changed = true;
  }
  if (!changed) return snapshot;
  return { ...snapshot, signals: nextSignals };
}

/** The UTC midnight of the day a timestamp falls into */
export function startOfUtcDay(ms) {
  return Math.floor(ms / 86400000) * 86400000;
}

/**
 * Decide which snapshots keep their raw bodies.
 *
 * The rule is per DOMAIN and it counts the snapshots that actually carry a
 * body: the newest `keep` of them keep their body, every older one loses it.
 * A snapshot without a body (a challenged homepage, a probe that was never
 * made) never takes a slot, so a domain whose newest snapshot has no body
 * still keeps the body of its newest snapshot that has one — the domain never
 * loses its re-derivation ability because of the order of its scans.
 *
 * @param records  [{ path, domain, time, bytes, hasBody }]
 * @param opts     { keep, maxAgeDays, referenceTime }
 * @returns        Map<path, { keep: boolean, reason: string }>
 */
export function planRetention(records, opts) {
  const byDomain = new Map();
  for (const record of records) {
    const key = record.domain ?? record.path;
    if (!byDomain.has(key)) byDomain.set(key, []);
    byDomain.get(key).push(record);
  }
  const plan = new Map();
  for (const [, group] of byDomain) {
    // newest first; the path breaks ties so the order is deterministic
    group.sort((a, b) => (b.time ?? 0) - (a.time ?? 0) || a.path.localeCompare(b.path));
    // only the snapshots that carry a body compete for a slot
    let slots = opts.keep;
    for (const record of group) {
      const hasBody = record.hasBody !== false;
      if (!hasBody) {
        plan.set(record.path, { keep: true, reason: 'no body to keep', rank: -1 });
        continue;
      }
      let keep = slots > 0;
      let reason = keep ? 'within the keep window' : 'superseded by a newer snapshot';
      if (keep) slots--;
      else if (opts.maxAgeDays === null) {
        // outside the window and not age-gated
      }
      if (keep && opts.maxAgeDays !== null && record.time !== null) {
        // whole calendar days between the reference day and the snapshot day
        const ageDays =
          (startOfUtcDay(opts.referenceTime) - startOfUtcDay(record.time)) / 86400000;
        if (ageDays > opts.maxAgeDays) {
          keep = false;
          reason = `older than ${opts.maxAgeDays} day(s)`;
        }
      }
      plan.set(record.path, { keep, reason, rank: -1 });
    }
  }
  return plan;
}

/* ── the report ─────────────────────────────────────────────────────────── */

const mb = (bytes) => `${(bytes / 1048576).toFixed(1)} MB`;
const gb = (bytes) => `${(bytes / 1073741824).toFixed(2)} GB`;

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
}

function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(String(err.message ?? err));
    console.error(
      'usage: node scripts/prune-snapshot-bodies.mjs [scans-dir] [--write] [--keep N] [--max-age-days D] [--prune-text none|unused|all]',
    );
    process.exit(1);
  }

  if (!existsSync(opts.dir) || !statSync(opts.dir).isDirectory()) {
    console.error(`not a directory: ${opts.dir}`);
    process.exit(1);
  }

  const files = collectSnapshots(opts.dir);
  const total = Math.min(files.length, opts.limit);
  const fields = PRUNE_MODES[opts.pruneText];

  /* pass 1 — read every snapshot once, collect the metadata and the volume */
  const records = [];
  const buckets = new Map(RAW_BODY_PATHS.map(([name]) => [name, 0]));
  const perDate = new Map();
  const sizes = [];
  const domainBodies = new Map();
  let corpusBytes = 0;
  let parseFailures = 0;
  let styleRoundTripFailures = 0;
  let snapshotsWithHomepageBody = 0;
  let homePageBodyBytes = 0;

  for (let i = 0; i < total; i++) {
    const { path: file, date } = files[i];
    const raw = readFileSync(file, 'utf8');
    const bytes = Buffer.byteLength(raw);
    corpusBytes += bytes;
    sizes.push(bytes);
    let snapshot;
    try {
      snapshot = JSON.parse(raw);
    } catch {
      parseFailures++;
      continue;
    }
    const style = detectStyle(raw);
    if (serialize(snapshot, style) !== raw) styleRoundTripFailures++;

    const signals = snapshot?.signals;
    const bodies = [];
    for (const [name, path] of RAW_BODY_PATHS) {
      const probe = at(signals, path);
      const body = probe && typeof probe === 'object' ? probe.body : undefined;
      if (typeof body === 'string') {
        bodies.push(name);
        buckets.set(name, buckets.get(name) + jsonBytes(body));
      }
    }
    const homepageBody = at(signals, ['homepage', 'body']);
    if (typeof homepageBody === 'string') {
      snapshotsWithHomepageBody++;
      homePageBodyBytes += jsonBytes(homepageBody);
    }
    const domain = domainOf(snapshot, file);
    const time = snapshotTime(snapshot, file);
    records.push({
      path: file,
      rel: relative(opts.dir, file),
      date,
      domain,
      time,
      bytes,
      // does this snapshot carry a body the selected mode would remove?
      hasBody: bodies.some((name) => fields.includes(name)),
      bodies,
    });

    const day = perDate.get(date) ?? { count: 0, bytes: 0, bodyBytes: 0 };
    day.count++;
    day.bytes += bytes;
    if (typeof homepageBody === 'string') day.bodyBytes += jsonBytes(homepageBody);
    perDate.set(date, day);

    const d = domainBodies.get(domain) ?? { count: 0, bytes: 0, bodies: 0 };
    d.count++;
    d.bytes += bytes;
    if (typeof homepageBody === 'string') d.bodies++;
    domainBodies.set(domain, d);
  }

  const newest = records.reduce((max, r) => (r.time !== null && r.time > max ? r.time : max), 0);
  const referenceTime = opts.now
    ? startOfUtcDay(Date.parse(`${opts.now}T00:00:00Z`))
    : startOfUtcDay(newest);

  const plan = planRetention(records, {
    keep: opts.keep,
    maxAgeDays: opts.maxAgeDays,
    referenceTime,
  });

  /* pass 2 — apply the plan, measure the exact saving, write when asked */
  let prunedFiles = 0;
  let prunedBodies = 0;
  let savedBytes = 0;
  let written = 0;
  let newBytes = 0;
  const writeFailures = [];
  const frozen = [];

  for (const record of records) {
    const decision = plan.get(record.path);
    if (!decision || decision.keep) continue;
    const raw = readFileSync(record.path, 'utf8');
    let snapshot;
    try {
      snapshot = JSON.parse(raw);
    } catch {
      continue;
    }
    const pruned = pruneSnapshot(snapshot, fields);
    if (pruned === snapshot) continue;
    const style = detectStyle(raw);
    const content = serialize(pruned, style);
    if (content === raw) continue;
    const oldSize = Buffer.byteLength(raw);
    const newSize = Buffer.byteLength(content);
    let removedBodies = 0;
    for (const [name, path] of RAW_BODY_PATHS) {
      if (!fields.includes(name)) continue;
      const before = at(snapshot?.signals, path);
      const after = at(pruned?.signals, path);
      if (typeof before?.body === 'string' && !Object.hasOwn(after ?? {}, 'body')) removedBodies++;
    }
    prunedFiles++;
    prunedBodies += removedBodies;
    savedBytes += oldSize - newSize;
    newBytes += newSize;
    frozen.push({ file: record.rel, domain: record.domain, date: record.date, reason: decision.reason });

    if (!opts.write) continue;
    const target = opts.out ? join(opts.out, record.rel) : record.path;
    try {
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, content);
      written++;
    } catch (err) {
      writeFailures.push({ file: record.rel, error: String(err.message ?? err) });
    }
  }

  const projectedBytes = corpusBytes - savedBytes;
  const domains = domainBodies.size;
  const sizesSorted = [...sizes].sort((a, b) => a - b);

  /* ── the report ─────────────────────────────────────────────────────── */
  const lines = [];
  lines.push(`# Snapshot body pruning — ${opts.write ? 'write' : 'dry run'}`);
  lines.push('');
  lines.push(`- scans root: \`${opts.dir}\``);
  lines.push(`- policy: keep ${opts.keep} raw snapshot(s) per domain · prune-text \`${opts.pruneText}\``);
  if (opts.maxAgeDays !== null) {
    lines.push(
      `- age gate: bodies older than ${opts.maxAgeDays} day(s) are dropped (reference ${opts.now ?? new Date(referenceTime).toISOString().slice(0, 10)})`,
    );
  }
  lines.push('');
  lines.push('## Corpus');
  lines.push('');
  lines.push(`- snapshots: ${records.length} · domains: ${domains}`);
  lines.push(`- corpus size: ${mb(corpusBytes)} (${gb(corpusBytes)})`);
  lines.push(
    `- per snapshot: min ${mb(sizesSorted[0] ?? 0)} · median ${mb(percentile(sizesSorted, 0.5))} · mean ${mb(Math.round(corpusBytes / Math.max(1, records.length)))} · p90 ${mb(percentile(sizesSorted, 0.9))} · max ${mb(sizesSorted[sizesSorted.length - 1] ?? 0)}`,
  );
  if (parseFailures) lines.push(`- **unparseable snapshots: ${parseFailures}**`);
  if (styleRoundTripFailures) {
    lines.push(`- **style round-trip failures (not rewritten): ${styleRoundTripFailures}**`);
  }
  lines.push('');
  lines.push('## Where the bytes are (raw bodies, compact-JSON size)');
  lines.push('');
  lines.push('| field | size | share |');
  lines.push('| --- | --- | --- |');
  const bucketTotal = [...buckets.values()].reduce((a, b) => a + b, 0);
  for (const [name] of RAW_BODY_PATHS) {
    const bytes = buckets.get(name) ?? 0;
    lines.push(
      `| \`signals.${name}.body\` | ${mb(bytes)} | ${bucketTotal ? ((100 * bytes) / bucketTotal).toFixed(1) : '0.0'}% |`,
    );
  }
  lines.push(
    `| **raw bodies total** | **${mb(bucketTotal)}** | ${corpusBytes ? ((100 * bucketTotal) / corpusBytes).toFixed(1) : '0.0'}% of corpus |`,
  );
  lines.push(
    `| evidence + metadata (the rest) | ${mb(corpusBytes - bucketTotal)} | ${corpusBytes ? ((100 * (corpusBytes - bucketTotal)) / corpusBytes).toFixed(1) : '0.0'}% of corpus |`,
  );
  lines.push('');
  lines.push('## Per day');
  lines.push('');
  lines.push('| date | snapshots | size | homepage bodies |');
  lines.push('| --- | --- | --- | --- |');
  for (const [date, day] of [...perDate].sort()) {
    lines.push(`| ${date} | ${day.count} | ${mb(day.bytes)} | ${mb(day.bodyBytes)} |`);
  }
  lines.push('');
  lines.push('## Result');
  lines.push('');
  lines.push(`- snapshots that lose their raw bodies: ${prunedFiles} of ${records.length}`);
  lines.push(`- raw bodies removed: ${prunedBodies}`);
  lines.push(`- bytes saved: ${mb(savedBytes)} (${gb(savedBytes)})`);
  lines.push(
    `- projected corpus: ${mb(projectedBytes)} (${gb(projectedBytes)}) — ${corpusBytes ? ((100 * savedBytes) / corpusBytes).toFixed(1) : '0.0'}% smaller`,
  );
  lines.push(`- snapshots written: ${written}`);
  lines.push(`- snapshots with a homepage body before: ${snapshotsWithHomepageBody}`);
  if (opts.pruneText === 'all') {
    lines.push('');
    lines.push(
      '> **Warning** — `--prune-text all` removes the bodies the scoring engine reads ' +
        '(robots / llms.txt / sitemap.xml). The affected snapshots can no longer be re-scored ' +
        'offline; their stored `afr` block is the only truth for them.',
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
  lines.push('node scripts/prune-snapshot-bodies.mjs ../AFR-data/scans');
  lines.push('');
  lines.push('# 2) apply (commits the pruned snapshots)');
  lines.push('node scripts/prune-snapshot-bodies.mjs ../AFR-data/scans --write --keep 1');
  lines.push('```');
  lines.push('');
  const markdown = lines.join('\n') + '\n';

  if (!opts.quiet) console.log(markdown);
  else
    console.log(
      `${opts.write ? 'write' : 'dry-run'}: ${records.length} snapshots · ${prunedFiles} pruned · saved ${mb(savedBytes)} · corpus ${mb(corpusBytes)} → ${mb(projectedBytes)}`,
    );

  if (opts.report) {
    mkdirSync(dirname(opts.report), { recursive: true });
    writeFileSync(opts.report, markdown);
  }
  if (opts.jsonReport) {
    mkdirSync(dirname(opts.jsonReport), { recursive: true });
    writeFileSync(
      opts.jsonReport,
      JSON.stringify(
        {
          stats: {
            dir: opts.dir,
            mode: opts.write ? 'write' : 'dry-run',
            policy: { keep: opts.keep, pruneText: opts.pruneText, maxAgeDays: opts.maxAgeDays },
            snapshots: records.length,
            domains,
            corpusBytes,
            projectedBytes,
            savedBytes,
            prunedFiles,
            prunedBodies,
            written,
            snapshotsWithHomepageBody,
            homePageBodyBytes,
            buckets: Object.fromEntries(buckets),
            perDate: Object.fromEntries([...perDate].sort()),
            parseFailures,
            styleRoundTripFailures,
          },
          pruned: frozen,
          writeFailures,
        },
        null,
        2,
      ) + '\n',
    );
  }
  if (opts.freezeManifest) {
    mkdirSync(dirname(opts.freezeManifest), { recursive: true });
    writeFileSync(
      opts.freezeManifest,
      JSON.stringify(
        {
          note: 'Snapshots whose raw bodies were pruned. Their stored afr block is the audit truth; they must not be re-scored offline.',
          generatedAt: new Date().toISOString(),
          policy: { keep: opts.keep, pruneText: opts.pruneText, maxAgeDays: opts.maxAgeDays },
          files: frozen.map((f) => f.file),
        },
        null,
        2,
      ) + '\n',
    );
  }
}

// Run only when executed directly (`node scripts/prune-snapshot-bodies.mjs`).
const invokedDirectly =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) main();

export { detectStyle, serialize, collectSnapshots, repoRoot };
