// scripts/rejudge-c1-c3.mjs — apply the afr-1.6.0 evidence rules to the two
// L3 checks of stored snapshots, without re-scoring the corpus.
//
// Why this exists
//   afr-1.6.0 tightened two evidence rules:
//     · C3 (MCP interface) now awards only a verified tools/list handshake;
//       discovery (GET /.well-known/mcp answering 2xx with any body) scores 0.
//     · C1's API-docs signal no longer folds in the OpenAPI hit, so a lone
//       openapi.json can no longer satisfy the human-readable docs entry —
//       an OpenAPI-only site scores 6 of 8, not 8.
//   The data repo's raw bodies were pruned (scripts/prune-snapshot-bodies.mjs),
//   so the corpus cannot be re-scored wholesale: scoreAfr over the stored
//   signals would silently zero every check that reads a body. What survives
//   pruning is exactly what these two checks need — the structured probes
//   (apiDocs.urls, openapi, mcp) and the stored evidence detail — so the two
//   checks are re-judged at check level and the stored score is adjusted by
//   the delta. Every other check keeps its stored verdict.
//
// What it does NOT do
//   It does not re-derive signals from bodies and it does not touch L1/L2/C2/C4.
//   A snapshot whose C1 evidence cannot be decomposed back into its stored
//   award is skipped, never guessed.
//
// Fidelity rules
//   · Only snapshots whose score actually changes are written. Files keep
//     their original indentation and trailing newline (same style helpers as
//     scripts/rederive-signals.mjs); a file that does not survive a
//     parse/serialize round trip is skipped instead of reformatted.
//   · When a file is written, both re-judged checks are refreshed (even the
//     one whose award did not move), the L3 layer sum, breakdown, score,
//     grade and engineVersion follow, and a conflated signals.apiDocs.found
//     (true with no stored links) is re-derived from signals.apiDocs.urls.
//   · A pruned llms.txt body cannot be re-judged: when the stored docs-entry
//     verdict came from llms.txt and the body is gone, the stored 2 points
//     stand (benefit of the doubt — the same stance as the corpus-wide
//     "missing bodies keep their stored score" rule).
//
// Usage
//   node scripts/rejudge-c1-c3.mjs [scans-dir] [options]
//
//   scans-dir            snapshot root (default: ../AFR-data/scans)
//   --write              write the updated snapshots back (default: dry run)
//   --dry-run            report only (default)
//   --date YYYY/MM/DD    restrict to one date folder (repeatable, prefix match)
//   --out DIR            write into DIR instead of in place (tree is mirrored)
//   --limit N            stop after N snapshots (for quick checks)
//   --report FILE.md     write the human-readable report
//   --json-report FILE   write the machine-readable report
//   --quiet              only print the summary line

import { readFileSync, writeFileSync, readdirSync, mkdirSync, existsSync, statSync } from 'node:fs';
import { join, resolve, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ENGINE_VERSION, gradeFor } from '../packages/afr/src/index.ts';
import { detectStyle, serialize } from './rederive-signals.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
/** Default snapshot root: the AFR-data checkout that sits next to this repo */
export const DEFAULT_SCANS_DIR = resolve(repoRoot, '..', 'AFR-data', 'scans');

/** The docs-entry regex the engine runs over a successful llms.txt body (l3.ts) */
const LLMS_DOCS_REGEX = /docs\.|developer|documentation/i;

const r2 = (x) => Math.round(x * 100) / 100;
const ok2xx = (p) => !!p && !p.error && p.status !== undefined && p.status >= 200 && p.status < 300;

/* ── the two re-judgements (pure) ──────────────────────────────────────── */

/**
 * Re-judge C3 (MCP interface, 6 points) under the afr-1.6.0 handshake rule.
 * `mcp` is signals.mcp; the stored award is compared by applyRejudge.
 * Returns { awarded, status, detail } mirroring packages/afr/src/l3.ts.
 */
export function rejudgeC3(mcp) {
  if (!mcp || !mcp.probed) {
    return { awarded: 0, status: 'unknown', detail: 'MCP not probed' };
  }
  if (Array.isArray(mcp.tools) && mcp.tools.length > 0) {
    const names = mcp.tools;
    return {
      awarded: 6,
      status: 'pass',
      detail: `tools/list handshake verified: ${names.slice(0, 8).join(', ')}${
        names.length > 8 ? ` … (+${names.length - 8})` : ''
      }`,
    };
  }
  if (Array.isArray(mcp.tools)) {
    return { awarded: 0, status: 'fail', detail: 'MCP handshake completed; tools/list returned no tools' };
  }
  if (mcp.found) {
    return {
      awarded: 0,
      status: 'unknown',
      detail: `MCP endpoint discovered: ${(mcp.urls ?? []).join(', ') || 'yes'} — no verified tools/list handshake`,
    };
  }
  return { awarded: 0, status: 'fail', detail: 'MCP probed; no endpoint found' };
}

/**
 * Re-judge C1 (Public API, 8 points) under the afr-1.6.0 split.
 *
 * The stored evidence detail carries the four markers the old engine wrote;
 * they decompose back into the stored award (asserted below), which makes the
 * re-judge safe on pruned bodies. What the markers cannot tell apart is
 * "homepage links to API/docs paths" from the old conflation (apiDocs.found
 * was links ∪ openapi) — the structured signals.apiDocs.urls can, so the
 * 5-point homepage-links leg and the 2-point docs entry read from urls, while
 * the llms.txt legs read the stored marker (llmsRef) or re-run the engine's
 * regex on a body that survived (docs entry).
 *
 * Returns { awarded, status, detail } or { skip: reason }.
 */
export function rejudgeC1(signals, old) {
  const detail = old?.evidence?.detail ?? '';
  const llmsRef = detail.includes('llms.txt references an API');
  const linksMarker = detail.includes('homepage links API/docs paths');
  const openapiMarker = detail.includes('OpenAPI document discovered');
  const oldDocsEntry = detail.includes('API documentation entry point present');
  const openapiFound = signals.openapi?.found === true;

  // Fail-safe guards: an unexpected format is skipped, never guessed.
  if (openapiMarker !== openapiFound) return { skip: 'c1 openapi marker/signals mismatch' };
  const oldEst =
    (llmsRef || linksMarker || openapiMarker ? 5 : 0) + (oldDocsEntry ? 2 : 0) + (openapiMarker ? 1 : 0);
  if (old && oldEst !== old.awarded) return { skip: `c1 marker mismatch (${oldEst} != ${old.awarded})` };

  const homeLinks = (signals.apiDocs?.urls?.length ?? 0) > 0;
  const five = llmsRef || homeLinks || openapiFound;

  const llms = signals.llms;
  let docsEntry;
  if (homeLinks) {
    docsEntry = true;
  } else if (ok2xx(llms) && typeof llms.body === 'string') {
    docsEntry = LLMS_DOCS_REGEX.test(llms.body);
  } else if (ok2xx(llms)) {
    // 2xx but the body is gone (pruned, or too large to store): the stored
    // verdict stands — the tool must not turn missing bytes into a missing
    // documentation entry point.
    docsEntry = oldDocsEntry;
  } else {
    docsEntry = false;
  }

  const awarded = (five ? 5 : 0) + (docsEntry ? 2 : 0) + (openapiFound ? 1 : 0);

  // Rebuild the detail exactly like packages/afr/src/l3.ts.
  const anyProbed =
    signals.llms !== undefined || signals.apiDocs !== undefined || (signals.openapi?.probed ?? false);
  const parts = [];
  if (!anyProbed) parts.push('no API sources probed');
  if (five) {
    if (llmsRef) parts.push('llms.txt references an API');
    if (homeLinks) parts.push('homepage links API/docs paths');
    if (openapiFound) parts.push('OpenAPI document discovered');
  } else {
    parts.push('no public-API evidence');
  }
  parts.push(docsEntry ? 'API documentation entry point present' : 'no API documentation entry point');
  if (openapiFound) parts.push(`OpenAPI: ${(signals.openapi.urls ?? []).join(', ') || 'yes'}`);
  else if (signals.openapi?.probed) parts.push('OpenAPI not found');
  else parts.push('OpenAPI not probed');

  const status = awarded >= 8 ? 'pass' : awarded <= 0 ? (anyProbed ? 'fail' : 'unknown') : 'partial';
  return { awarded, status, detail: parts.join('; ') };
}

/* ── snapshot application ──────────────────────────────────────────────── */

/**
 * Apply both re-judgements to one parsed snapshot (in place for the checks it
 * touches). Returns:
 *   { skip: reason }              — shape/marker problem, leave the file alone
 *   { changed: false }            — awards identical, leave the file alone
 *   { changed: true, before, after, signalsPatched, gradeChanged }
 */
export function applyRejudge(snapshot) {
  const signals = snapshot.signals;
  const afr = snapshot.afr;
  if (!signals || !afr || !Array.isArray(afr.layers) || !afr.breakdown) {
    return { skip: 'missing signals/afr shape' };
  }
  if (typeof afr.score !== 'number') return { skip: 'no numeric score' };
  const l3 = afr.layers.find((l) => l.layer === 'L3');
  const c1 = l3?.checks?.find((c) => c.id === 'l3.public-api');
  const c3 = l3?.checks?.find((c) => c.id === 'l3.mcp');
  if (!l3 || !c1 || !c3 || !c1.evidence || !c3.evidence) return { skip: 'missing L3 checks/evidence' };

  const n3 = rejudgeC3(signals.mcp);
  const n1 = rejudgeC1(signals, c1);
  if (n1.skip) return { skip: n1.skip };

  const before = {
    score: afr.score,
    grade: afr.grade,
    c1: c1.awarded,
    c3: c3.awarded,
    engineVersion: afr.engineVersion,
  };
  if (n1.awarded === c1.awarded && n3.awarded === c3.awarded) return { changed: false, before };

  c1.awarded = n1.awarded;
  c1.status = n1.status;
  c1.evidence.detail = n1.detail;
  c3.awarded = n3.awarded;
  c3.status = n3.status;
  c3.evidence.detail = n3.detail;

  l3.awarded = r2(l3.checks.reduce((s, c) => s + c.awarded, 0));
  afr.breakdown['l3.public-api'] = c1.awarded;
  afr.breakdown['l3.mcp'] = c3.awarded;

  const l1 = afr.layers.find((l) => l.layer === 'L1')?.awarded ?? 0;
  const l2 = afr.layers.find((l) => l.layer === 'L2')?.awarded ?? 0;
  const total = Math.round((l1 + l2 + l3.awarded) * 100) / 100;
  const score = Math.round(total);
  if (!(score >= 0 && score <= 100)) return { skip: `score out of range: ${score}` };

  afr.score = score;
  afr.grade = afr.state === 'pending' ? 'Pending' : gradeFor(score);
  afr.engineVersion = ENGINE_VERSION;

  // The old scanner set apiDocs.found = links ∪ openapi. With the OpenAPI
  // fold-in gone the flag is re-derived from the links that are stored —
  // the raw material (urls) never changes, only the judgement over it.
  let signalsPatched = false;
  const ad = signals.apiDocs;
  if (ad && ad.found && (ad.urls?.length ?? 0) === 0) {
    ad.found = false;
    signalsPatched = true;
  }

  return {
    changed: true,
    before,
    after: { score: afr.score, grade: afr.grade, c1: c1.awarded, c3: c3.awarded, engineVersion: afr.engineVersion },
    signalsPatched,
    gradeChanged: before.grade !== afr.grade,
    scoreDelta: afr.score - before.score,
  };
}

/* ── corpus walk ───────────────────────────────────────────────────────── */

function listDates(root) {
  const dates = [];
  const isDir = (p) => {
    try {
      return statSync(p).isDirectory();
    } catch {
      return false;
    }
  };
  for (const y of readdirSync(root)) {
    const yp = join(root, y);
    if (!isDir(yp)) continue;
    for (const m of readdirSync(yp)) {
      const mp = join(yp, m);
      if (!isDir(mp)) continue;
      for (const d of readdirSync(mp)) {
        const dp = join(mp, d);
        if (!isDir(dp)) continue;
        dates.push(`${y}/${m}/${d}`);
      }
    }
  }
  return dates.sort();
}

export function parseArgs(argv) {
  const opts = {
    dir: null,
    write: false,
    dates: [],
    out: null,
    limit: Infinity,
    report: null,
    jsonReport: null,
    quiet: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--write') opts.write = true;
    else if (a === '--dry-run') opts.write = false;
    else if (a === '--date') opts.dates.push(argv[++i]);
    else if (a === '--out') opts.out = argv[++i];
    else if (a === '--limit') opts.limit = Number(argv[++i]);
    else if (a === '--report') opts.report = argv[++i];
    else if (a === '--json-report') opts.jsonReport = argv[++i];
    else if (a === '--quiet') opts.quiet = true;
    else if (!a.startsWith('--') && !opts.dir) opts.dir = a;
    else throw new Error(`unknown argument: ${a}`);
  }
  opts.dir = opts.dir ? resolve(opts.dir) : DEFAULT_SCANS_DIR;
  if (opts.out) opts.out = resolve(opts.out);
  return opts;
}

const GRADE_ORDER = ['A', 'B', 'C', 'D', 'F', 'Pending'];

function gradeDist() {
  const d = { A: 0, B: 0, C: 0, D: 0, F: 0, Pending: 0 };
  return d;
}

function pct(x, base) {
  return base ? `${((100 * x) / base).toFixed(1)}%` : '—';
}

export function main(argv = process.argv.slice(2)) {
  const opts = parseArgs(argv);
  if (!existsSync(opts.dir)) {
    console.error(`scans dir not found: ${opts.dir}`);
    process.exit(1);
  }

  const stats = {
    files: 0,
    changed: 0,
    unchanged: 0,
    skipped: 0,
    skipReasons: {},
    c3Only: 0,
    c1Only: 0,
    both: 0,
    gradeChanged: 0,
    signalsPatched: 0,
    scoreDeltaSum: 0,
    transitions: {},
    latestTransitions: {},
    written: 0,
    writeFailures: [],
    styleRoundTripFailures: 0,
    benefitOfDoubt: 0, // files whose C1 kept its stored docs entry on a pruned llms body
  };
  const transitions = []; // every changed file, machine-readable
  /** latest snapshot per domain (by signals.fetchedAt), before/after */
  const latest = new Map();

  const dates = listDates(opts.dir).filter(
    (d) => opts.dates.length === 0 || opts.dates.some((pre) => d.startsWith(pre)),
  );

  for (const date of dates) {
    const dir = join(opts.dir, date);
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.json')) continue;
      if (stats.files >= opts.limit) break;
      const path = join(dir, name);
      const rel = relative(opts.dir, path);
      stats.files++;

      let raw;
      try {
        raw = readFileSync(path, 'utf8');
      } catch (err) {
        stats.skipped++;
        stats.skipReasons.read = (stats.skipReasons.read ?? 0) + 1;
        continue;
      }
      let snapshot;
      try {
        snapshot = JSON.parse(raw);
      } catch {
        stats.skipped++;
        stats.skipReasons.parse = (stats.skipReasons.parse ?? 0) + 1;
        continue;
      }

      const domain = snapshot?.signals?.domain ?? name.replace(/\.json$/, '');
      const fetchedAt = snapshot?.signals?.fetchedAt ?? '';
      // Newest-wins bookkeeping: the walk is ascending, so the map ends up
      // holding each domain's latest snapshot. "Latest" stats are computed
      // from the finished map, never from a mid-walk flag (an older file
      // processed first would otherwise count as latest at that moment).
      const remember = (row) => {
        const prev = latest.get(domain);
        if (!prev || fetchedAt >= prev.fetchedAt) latest.set(domain, { fetchedAt, file: rel, ...row });
      };

      const result = applyRejudge(snapshot);
      if (result.skip) {
        stats.skipped++;
        stats.skipReasons[result.skip] = (stats.skipReasons[result.skip] ?? 0) + 1;
        remember({ before: result.before ?? null, after: null, skipped: result.skip });
        continue;
      }
      if (!result.changed) {
        stats.unchanged++; // benefit-of-the-doubt bookkeeping: C1 kept a stored docs entry on a
        // pruned llms.txt body (conflated API-docs flag, 2xx with no body left)
        const ad = snapshot.signals.apiDocs;
        const llms = snapshot.signals.llms;
        if (ad && ad.found && (ad.urls?.length ?? 0) === 0 && ok2xx(llms) && typeof llms.body !== 'string') {
          stats.benefitOfDoubt++;
        }
        remember({ before: result.before, after: result.before, skipped: null });
        continue;
      }

      stats.changed++;
      if (result.before.c3 !== result.after.c3 && result.before.c1 !== result.after.c1) stats.both++;
      else if (result.before.c3 !== result.after.c3) stats.c3Only++;
      else stats.c1Only++;
      if (result.gradeChanged) stats.gradeChanged++;
      if (result.signalsPatched) stats.signalsPatched++;
      stats.scoreDeltaSum += result.scoreDelta;
      const key = `${result.before.grade}→${result.after.grade}`;
      if (result.before.grade !== result.after.grade) {
        stats.transitions[key] = (stats.transitions[key] ?? 0) + 1;
      }
      transitions.push({ file: rel, domain, ...result });
      remember({ before: result.before, after: result.after, skipped: null });

      if (opts.write) {
        const style = detectStyle(raw);
        // The file must survive a parse/serialize round trip in its own style
        // before we touch it — a snapshot in an unknown layout is skipped, not
        // reformatted.
        const roundTrip = JSON.stringify(JSON.parse(raw), null, style.indent) + (style.trailingNewline ? '\n' : '');
        if (roundTrip !== raw) {
          stats.styleRoundTripFailures++;
          stats.writeFailures.push({ file: rel, reason: 'style round-trip' });
          continue;
        }
        const target = opts.out ? join(opts.out, rel) : path;
        try {
          mkdirSync(dirname(target), { recursive: true });
          writeFileSync(target, serialize(snapshot, style));
          stats.written++;
        } catch (err) {
          stats.writeFailures.push({ file: rel, reason: String(err) });
        }
      }
    }
  }

  /* ── latest-per-domain summary (what the site shows) ─────────────────── */
  const latestBefore = gradeDist();
  const latestAfter = gradeDist();
  let latestScored = 0;
  for (const row of latest.values()) {
    if (!row.before) continue;
    const b = row.before.grade ?? 'Pending';
    const a = row.after ? row.after.grade : b;
    if (b !== 'Pending') {
      latestBefore[b] = (latestBefore[b] ?? 0) + 1;
      latestScored++;
    }
    if (a !== 'Pending') latestAfter[a] = (latestAfter[a] ?? 0) + 1;
    if (row.after && row.before.grade !== row.after.grade) {
      const k = `${row.before.grade}→${row.after.grade}`;
      stats.latestTransitions[k] = (stats.latestTransitions[k] ?? 0) + 1;
    }
  }

  const lines = [];
  lines.push(
    `# rejudge C1/C3 with ${ENGINE_VERSION} over ${stats.files} snapshots (${opts.dir}${opts.write ? ', WRITTEN' : ', dry-run'})`,
  );
  lines.push(
    `changed ${stats.changed} · unchanged ${stats.unchanged} · skipped ${stats.skipped} · written ${stats.written}`,
  );
  lines.push(
    `changed by check: C3 only ${stats.c3Only} · C1 only ${stats.c1Only} · both ${stats.both} · grade moved ${stats.gradeChanged} · signals.apiDocs patched ${stats.signalsPatched}`,
  );
  lines.push(`score delta sum ${stats.scoreDeltaSum} · benefit-of-doubt C1 kept ${stats.benefitOfDoubt}`);
  lines.push(`style round-trip failures ${stats.styleRoundTripFailures} · write failures ${stats.writeFailures.length}`);
  if (Object.keys(stats.skipReasons).length) lines.push(`skip reasons: ${JSON.stringify(stats.skipReasons)}`);
  if (Object.keys(stats.transitions).length) {
    lines.push(`all-file grade transitions: ${Object.entries(stats.transitions).map(([k, v]) => `${k} ${v}`).join(' · ')}`);
  }
  if (Object.keys(stats.latestTransitions).length) {
    lines.push(
      `latest-per-domain grade transitions: ${Object.entries(stats.latestTransitions).map(([k, v]) => `${k} ${v}`).join(' · ')}`,
    );
  }
  lines.push(
    `latest-per-domain grades (scored ${latestScored}): ` +
      GRADE_ORDER.filter((g) => g !== 'Pending')
        .map((g) => `${g} ${latestBefore[g] ?? 0}→${latestAfter[g] ?? 0}`)
        .join('  '),
  );
  const report = lines.join('\n');
  if (!opts.quiet) console.log(report);

  if (opts.report) {
    const rows = transitions
      .map(
        (t) =>
          `| ${t.domain} | ${t.file} | ${t.before.score} ${t.before.grade} | ${t.after.score} ${t.after.grade} | ${t.before.c1}→${t.after.c1} | ${t.before.c3}→${t.after.c3} |`,
      )
      .join('\n');
    writeFileSync(
      resolve(opts.report),
      `${report}\n\n| domain | file | before | after | C1 | C3 |\n|---|---|---|---|---|---|\n${rows}\n`,
    );
  }
  if (opts.jsonReport) {
    writeFileSync(
      resolve(opts.jsonReport),
      JSON.stringify({ engineVersion: ENGINE_VERSION, stats, transitions, latest: [...latest.entries()] }, null, 2) + '\n',
    );
  }
}

// Run only when executed directly (`node scripts/rejudge-c1-c3.mjs`).
const invokedDirectly =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) main();
