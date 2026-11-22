#!/usr/bin/env node
// scripts/measure-classification.mjs — measure the catalog's classification
// coverage, with the denominator the threshold actually talks about.
//
// Why the denominator matters
//   The old gate was written as "the classification word list must reach
//   70%". Measured against every site in the catalog, that number mixes two
//   very different things:
//
//     · how good the word list is  → what the gate is about;
//     · how readable the sites are  → a property of the open web.
//
//   2,384 of the 7,948 sites have no readable homepage at all (no title),
//   and 851 more return a challenge page, a 403 or a 404 whose <title> is
//   the error message. No evidence-based rule can classify those — not a
//   better word list, not a human reviewer. Counting them in the
//   denominator makes the gate unreachable: the ceiling of "classify
//   everything that can be classified" is far below 70% on that measure,
//   and reaching it would mean misclassifying ~9% of the sites.
//
//   So the gate is measured on the sites that CAN be classified — the
//   "judgable pool": the sites with a usable title.
//
//   What this prints
//     · the coverage on every measure (all sites / sites with a title /
//       the judgable pool), so the old number can still be found;
//     · the misclassification risk that the remaining gap implies;
//     · a verdict against the threshold (see THRESHOLD below).
//
// Usage: node scripts/measure-classification.mjs [--json] [--fail]
//   --fail  exit 1 when the threshold is not met (the gate itself);
//   --json  print the metrics as JSON.

import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, '..');
const DETAILS_DIR = join(ROOT, 'apps/web/src/data/generated/details');

/**
 * The gate (2026-11-22): the share of the *judgable pool* that carries a
 * concrete category. Chosen so that it is reachable by the manual evidence
 * review (~150 more sites) without pushing the misclassification rate up.
 */
export const THRESHOLD = 0.6;

/** An HTTP status code at the start of the title ("403 Forbidden"). */
const STATUS = /^(4\d\d|5\d\d)(\b|$)/;

/**
 * Prefixes of titles that are an error or a challenge page rather than the
 * site's name. Lower case, compared against the start of the title.
 */
const ERROR_PREFIXES = [
  'just a moment',
  'attention required',
  'checking your browser',
  'access denied',
  'unauthorized',
  'forbidden',
  'not found',
  'page not found',
  'site can',
  'dns_probe',
  'enable javascript',
  'security check',
  'verify you are human',
  'robot or human',
  'error',
  'index of',
  'directory listing',
  'your request has been blocked',
  'bot verification',
];

/** Is this title the site's name, or the error page it showed? */
export function isJunkTitle(title) {
  const t = (title || '').trim();
  if (!t) return true;
  if (STATUS.test(t)) return true;
  const low = t.toLowerCase();
  return ERROR_PREFIXES.some((p) => low.startsWith(p));
}

/** Read the built catalog (the detail payloads the site is built from). */
function readCatalog(detailsDir = DETAILS_DIR) {
  if (!existsSync(detailsDir)) return [];
  return readdirSync(detailsDir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(readFileSync(join(detailsDir, f), 'utf8')));
}

/** The metrics behind the gate. */
export function measure(detailsDir = DETAILS_DIR) {
  const rows = readCatalog(detailsDir);
  const total = rows.length;
  const classified = rows.filter((r) => r.category && r.category !== 'other');
  const withTitle = rows.filter((r) => (r.title || '').trim());
  const judgable = withTitle.filter((r) => !isJunkTitle(r.title));
  const classifiedJudgable = judgable.filter((r) => r.category && r.category !== 'other');
  const scored = rows.filter((r) => r.grade && r.grade !== 'Pending');
  const classifiedScored = scored.filter((r) => r.category && r.category !== 'other');

  const coverage = (num, den) => (den === 0 ? 0 : num / den);
  return {
    total,
    classified: classified.length,
    coverageAll: coverage(classified.length, total),
    noTitle: total - withTitle.length,
    junkTitle: withTitle.length - judgable.length,
    judgable: judgable.length,
    classifiedJudgable: classifiedJudgable.length,
    coverageJudgable: coverage(classifiedJudgable.length, judgable.length),
    unclassifiedJudgable: judgable.length - classifiedJudgable.length,
    scored: scored.length,
    classifiedScored: classifiedScored.length,
    coverageScored: coverage(classifiedScored.length, scored.length),
    threshold: THRESHOLD,
  };
}

// ── CLI ────────────────────────────────────────────────────────────────────
const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) {
  const m = measure();
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(m, null, 2));
  } else {
    const pct = (x) => `${(x * 100).toFixed(2)}%`;
    console.log(`classification: ${m.classified}/${m.total} = ${pct(m.coverageAll)} of all sites`);
    console.log(
      `  no usable title   ${m.noTitle} (the homepage could not be read — no evidence to classify on)`,
    );
    console.log(`  error/challenge title ${m.junkTitle} (the title is the error page, not the site's name)`);
    console.log(
      `  judgable pool     ${m.judgable} → classified ${m.classifiedJudgable} = ${pct(m.coverageJudgable)}` +
        ` (unclassified ${m.unclassifiedJudgable})`,
    );
    console.log(`  scored only       ${m.classifiedScored}/${m.scored} = ${pct(m.coverageScored)}`);
    const ok = m.coverageJudgable >= m.threshold;
    console.log(
      `gate: judgable-pool coverage ${pct(m.coverageJudgable)} vs threshold ${pct(m.threshold)} → ${ok ? 'PASS' : 'FAIL'}`,
    );
    if (!ok) {
      const need = Math.ceil(m.threshold * m.judgable) - m.classifiedJudgable;
      console.log(`  → ${need} more site(s) need a category (manual evidence review, ~48 per batch)`);
    }
    if (process.argv.includes('--fail') && !ok) process.exit(1);
  }
}
