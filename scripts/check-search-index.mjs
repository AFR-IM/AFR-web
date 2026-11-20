#!/usr/bin/env node
// scripts/check-search-index.mjs — budget + shape guard for the client search
// index (apps/web/public/data/search-index.json).
//
// Why this exists
//   The search index is the one payload every visitor of /search downloads
//   before they can type a query, and it is fetched by the browser, not by
//   the server. Two things can break it without any test noticing:
//
//     1. size — the browser pays the *compressed* size. An index that grows
//        past the wire budget makes every search slower, and nobody notices
//        until the payload is already too big.
//     2. shape — the browser reads the entry keys directly. A renamed key, a
//        category that no longer exists or a title that outgrew its budget
//        makes the search page render half a card (or no grade at all)
//        without any error anywhere.
//
//   So this script asserts both: the measured brotli size against the
//   budget, and every entry against the contract in
//   apps/web/scripts/search-index-contract.mjs — the same module the
//   generator writes from, so the two cannot disagree.
//
//   It also checks the browser side of the contract: the grade must come from
//   the thresholds the server serializes (packages/shared GRADE_THRESHOLDS),
//   never from a second copy of the grade table inside the page.
//
// Usage: node scripts/check-search-index.mjs   (exit code 1 on any failure)

import { existsSync, readFileSync } from 'node:fs';
import { brotliCompressSync, constants } from 'node:zlib';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  SEARCH_INDEX_RAW_PER_ENTRY,
  SEARCH_INDEX_WIRE_BUDGET,
  validateSearchEntry,
} from '../apps/web/scripts/search-index-contract.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, '..');

export const DEFAULT_INDEX_PATH = join(ROOT, 'apps/web/public/data/search-index.json');
export const DEFAULT_PAGE_PATH = join(ROOT, 'apps/web/src/pages/[...locale]/search.astro');

/** Brotli-compressed size — what the browser actually downloads. */
export function brotliBytes(text) {
  return brotliCompressSync(Buffer.from(text, 'utf8'), {
    params: { [constants.BROTLI_PARAM_QUALITY]: 4 },
  }).length;
}

/**
 * Run every check.
 * @param {{indexPath?: string, pagePath?: string}} options
 * @returns {{failures: string[], notes: string[], metrics: object}}
 */
export function runChecks({ indexPath = DEFAULT_INDEX_PATH, pagePath = DEFAULT_PAGE_PATH } = {}) {
  const failures = [];
  const notes = [];
  const metrics = {};

  // ── 1. the browser page must take the grade from the shared thresholds ──
  if (!existsSync(pagePath)) {
    failures.push(`search page not found: ${pagePath}`);
  } else {
    const page = readFileSync(pagePath, 'utf8');
    if (!page.includes('GRADE_THRESHOLDS')) {
      failures.push('search page does not use GRADE_THRESHOLDS — the grade table must come from packages/shared');
    }
    if (!/GRADE_THRESHOLDS\s*\}\s*from\s*'[^']*packages\/shared\/src\/index\.ts'/.test(page)) {
      failures.push('search page must import GRADE_THRESHOLDS from packages/shared/src/index.ts');
    }
    if (!/data-grade-thresholds=\{/.test(page)) {
      failures.push('search page does not expose the data-grade-thresholds attribute — the browser cannot derive the grade');
    }
    if (!/getAttribute\('data-grade-thresholds'\)/.test(page)) {
      failures.push('search page does not read the grade thresholds it exposes');
    }
    if (/\{\s*min\s*:/.test(page)) {
      failures.push('search page looks like it hardcodes a grade table — the thresholds must not be copied into the page');
    }
  }

  // ── 2. the index itself (only when it has been built) ───────────────────
  if (!existsSync(indexPath)) {
    notes.push(
      `search index not built (${indexPath}) — run "node apps/web/scripts/fetch-data.mjs" to check the size and the shape`,
    );
    return { failures, notes, metrics };
  }

  const raw = readFileSync(indexPath, 'utf8');
  const wire = brotliBytes(raw);
  metrics.rawBytes = Buffer.byteLength(raw, 'utf8');
  metrics.wireBytes = wire;

  let entries;
  try {
    entries = JSON.parse(raw);
  } catch (err) {
    failures.push(`search index is not valid JSON: ${err.message}`);
    return { failures, notes, metrics };
  }
  if (!Array.isArray(entries)) {
    failures.push('search index must be a JSON array of entries');
    return { failures, notes, metrics };
  }
  metrics.entries = entries.length;

  // 2a. the wire budget — the browser pays the compressed size
  if (wire > SEARCH_INDEX_WIRE_BUDGET) {
    failures.push(
      `search index wire size ${wire} B is over the ${SEARCH_INDEX_WIRE_BUDGET} B budget ` +
        `(${Math.round(wire / 1024)} KB > ${SEARCH_INDEX_WIRE_BUDGET / 1024} KB) — ` +
        'shard it before scaling (SSOT item 20)',
    );
  }

  // 2b. the raw guard — linear headroom, warns long before the wire budget
  const rawBudget = entries.length * SEARCH_INDEX_RAW_PER_ENTRY;
  metrics.rawBudget = rawBudget;
  if (Buffer.byteLength(raw, 'utf8') > rawBudget) {
    failures.push(
      `search index raw size ${Buffer.byteLength(raw, 'utf8')} B is over the ` +
        `${rawBudget} B guard (${entries.length} entries × ${SEARCH_INDEX_RAW_PER_ENTRY} B/entry)`,
    );
  }

  // 2c. the shape every entry must have
  const problems = [];
  const seen = new Set();
  let previous = null;
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    for (const problem of validateSearchEntry(entry, i)) {
      if (problems.length < 20) problems.push(problem);
    }
    if (entry && typeof entry.d === 'string') {
      if (seen.has(entry.d)) {
        if (problems.length < 20) problems.push(`entry ${i}: duplicate domain "${entry.d}"`);
      }
      seen.add(entry.d);
    }
    /* the order decides what an empty query shows first: score desc, then
       domain asc */
    if (previous && entry) {
      const ordered =
        previous.s > entry.s || (previous.s === entry.s && previous.d <= entry.d);
      if (!ordered) {
        if (problems.length < 20) {
          problems.push(`entry ${i}: out of order (${previous.d} ${previous.s} before ${entry.d} ${entry.s})`);
        }
      }
    }
    previous = entry;
  }
  failures.push(...problems);

  return { failures, notes, metrics };
}

// ── CLI ────────────────────────────────────────────────────────────────────
const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) {
  const { failures, notes, metrics } = runChecks();
  for (const note of notes) console.log(`note: ${note}`);
  if (metrics.entries !== undefined) {
    console.log(
      `search index: ${metrics.entries} entries · raw ${(metrics.rawBytes / 1024).toFixed(1)} KB ` +
        `(guard ${(metrics.rawBudget / 1024).toFixed(0)} KB) · wire ${(metrics.wireBytes / 1024).toFixed(1)} KB br ` +
        `(budget ${SEARCH_INDEX_WIRE_BUDGET / 1024} KB)`,
    );
  }
  if (failures.length > 0) {
    console.error(`FAIL: ${failures.length} problem(s) with the search index:`);
    for (const failure of failures) console.error(`  · ${failure}`);
    process.exit(1);
  }
  console.log('All checks passed');
}
