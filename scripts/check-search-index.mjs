#!/usr/bin/env node
// scripts/check-search-index.mjs — budget + shape guard for the client search
// index (apps/web/public/data/search-index.json and its shards).
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
// The shards
//   The index is written as one file per first character of the domain plus
//   a manifest (the browser reads the manifest, then fetches the shards it
//   needs). A shard set is only useful if it is *complete* and *stable*, so
//   the guard asserts:
//     · every shard fits the wire budget on its own,
//     · the shards together hold every rated site — the same count the
//       build manifest reports, and the same domains the legacy file holds,
//     · the shards are a byte-exact partition of the legacy file, so a
//       second build of the same catalog produces the same bytes,
//     · the leaderboard slice is the head of the same list.
//
// Usage: node scripts/check-search-index.mjs   (exit code 1 on any failure)

import { existsSync, readFileSync } from 'node:fs';
import { brotliCompressSync, constants } from 'node:zlib';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  SEARCH_INDEX_RAW_PER_ENTRY,
  SEARCH_INDEX_WIRE_BUDGET,
  SEARCH_MANIFEST_FILE,
  SEARCH_TOP_FILE,
  assignShards,
  validateSearchEntry,
  validateShardManifest,
} from '../apps/web/scripts/search-index-contract.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, '..');

export const DEFAULT_DATA_DIR = join(ROOT, 'apps/web/public/data');
export const DEFAULT_INDEX_PATH = join(DEFAULT_DATA_DIR, 'search-index.json');
export const DEFAULT_MANIFEST_PATH = join(DEFAULT_DATA_DIR, SEARCH_MANIFEST_FILE);
export const DEFAULT_TOP_PATH = join(DEFAULT_DATA_DIR, SEARCH_TOP_FILE);
export const DEFAULT_PAGE_PATH = join(ROOT, 'apps/web/src/pages/[...locale]/search.astro');
export const DEFAULT_BUILD_MANIFEST_PATH = join(ROOT, 'apps/web/src/data/generated/index.json');

/** Brotli-compressed size — what the browser actually downloads. */
export function brotliBytes(text) {
  return brotliCompressSync(Buffer.from(text, 'utf8'), {
    params: { [constants.BROTLI_PARAM_QUALITY]: 4 },
  }).length;
}

/** The bytes the generator writes for a list of entries. */
function serializeEntries(entries) {
  return `${JSON.stringify(entries)}\n`;
}

/**
 * Run every check.
 * @param {{indexPath?: string, pagePath?: string, manifestPath?: string,
 *          dataDir?: string, buildManifestPath?: string}} options
 * @returns {{failures: string[], notes: string[], metrics: object}}
 */
export function runChecks({
  indexPath = DEFAULT_INDEX_PATH,
  pagePath = DEFAULT_PAGE_PATH,
  manifestPath = DEFAULT_MANIFEST_PATH,
  dataDir = DEFAULT_DATA_DIR,
  buildManifestPath = DEFAULT_BUILD_MANIFEST_PATH,
} = {}) {
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
    // The page must read the shard manifest and keep the legacy file as the
    // fallback — a page that only knows one of the two breaks on a deploy
    // that publishes the other.
    if (!page.includes('search-index-manifest.json')) {
      failures.push('search page does not read the shard manifest — the browser cannot load the shards');
    }
    if (!/search-index\.json/.test(page)) {
      failures.push('search page has no fallback to the legacy single index — a payload from before the shards must still work');
    }
  }

  // ── 2. the legacy single file (only when it has been built) ─────────────
  let legacyEntries = null;
  if (!existsSync(indexPath)) {
    notes.push(
      `legacy search index not built (${indexPath}) — the catalog outgrew the wire budget, ` +
        'so the browser reads the shards',
    );
  } else {
    const raw = readFileSync(indexPath, 'utf8');
    const wire = brotliBytes(raw);
    metrics.rawBytes = Buffer.byteLength(raw, 'utf8');
    metrics.wireBytes = wire;

    let entries;
    try {
      entries = JSON.parse(raw);
    } catch (err) {
      failures.push(`search index is not valid JSON: ${err.message}`);
      entries = null;
    }
    if (entries && !Array.isArray(entries)) {
      failures.push('search index must be a JSON array of entries');
      entries = null;
    }
    if (entries) {
      legacyEntries = entries;
      metrics.entries = entries.length;

      // 2a. the wire budget — the browser pays the compressed size
      if (wire > SEARCH_INDEX_WIRE_BUDGET) {
        failures.push(
          `search index wire size ${wire} B is over the ${SEARCH_INDEX_WIRE_BUDGET} B budget ` +
            `(${Math.round(wire / 1024)} KB > ${SEARCH_INDEX_WIRE_BUDGET / 1024} KB)`,
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
      failures.push(...checkEntries(entries));
    }
  }

  // ── 3. the shards + the manifest ────────────────────────────────────────
  if (!existsSync(manifestPath)) {
    notes.push(
      `shard manifest not built (${manifestPath}) — run "node apps/web/scripts/fetch-data.mjs" ` +
        'to write the shards and check them',
    );
    return { failures, notes, metrics };
  }

  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch (err) {
    failures.push(`shard manifest is not valid JSON: ${err.message}`);
    return { failures, notes, metrics };
  }
  failures.push(...validateShardManifest(manifest));
  metrics.shards = manifest.shards?.length ?? 0;
  metrics.shardEntries = manifest.entries ?? 0;

  // 3a. the union must be every rated site
  const buildManifestPathExists = existsSync(buildManifestPath);
  if (buildManifestPathExists) {
    try {
      const build = JSON.parse(readFileSync(buildManifestPath, 'utf8'));
      if (Number.isInteger(build.scored) && build.scored !== manifest.entries) {
        failures.push(
          `the shards hold ${manifest.entries} entries, but the build reports ${build.scored} rated sites — ` +
            'a rated site is missing from the index (or a pending one slipped in)',
        );
      }
    } catch (err) {
      notes.push(`build manifest unreadable (${err.message}) — the shard union was not cross-checked`);
    }
  } else {
    notes.push('no build manifest — the shard union was not cross-checked against the rated-site count');
  }

  // 3b. every shard: the file, its shape, its budget, its sizes
  const seen = new Set();
  const union = [];
  for (const shard of manifest.shards ?? []) {
    const file = join(dataDir, shard.file);
    if (!existsSync(file)) {
      failures.push(`shard "${shard.id}" is missing: ${file}`);
      continue;
    }
    const text = readFileSync(file, 'utf8');
    const raw = Buffer.byteLength(text, 'utf8');
    const wire = brotliBytes(text);
    if (raw !== shard.raw) {
      failures.push(`shard "${shard.id}" is ${raw} B raw, but the manifest says ${shard.raw} B`);
    }
    if (wire !== shard.wire) {
      failures.push(`shard "${shard.id}" is ${wire} B on the wire, but the manifest says ${shard.wire} B`);
    }
    if (wire > SEARCH_INDEX_WIRE_BUDGET) {
      failures.push(
        `shard "${shard.id}" wire size ${wire} B is over the ${SEARCH_INDEX_WIRE_BUDGET} B budget — ` +
          'the shard key needs another level (SSOT item 20)',
      );
    }
    let entries;
    try {
      entries = JSON.parse(text);
    } catch (err) {
      failures.push(`shard "${shard.id}" is not valid JSON: ${err.message}`);
      continue;
    }
    if (!Array.isArray(entries)) {
      failures.push(`shard "${shard.id}" must be a JSON array of entries`);
      continue;
    }
    if (entries.length !== shard.count) {
      failures.push(`shard "${shard.id}" holds ${entries.length} entries, but the manifest says ${shard.count}`);
    }
    if (raw > entries.length * SEARCH_INDEX_RAW_PER_ENTRY) {
      failures.push(
        `shard "${shard.id}" is ${raw} B raw, over the ` +
          `${entries.length * SEARCH_INDEX_RAW_PER_ENTRY} B guard (${entries.length} × ${SEARCH_INDEX_RAW_PER_ENTRY} B/entry)`,
      );
    }
    failures.push(...checkEntries(entries, `shard "${shard.id}"`));
    for (const entry of entries) {
      const domain = entry?.d;
      if (typeof domain !== 'string') continue;
      if (seen.has(domain)) {
        failures.push(`"${domain}" is in more than one shard — the shards must partition the catalog`);
      }
      seen.add(domain);
      union.push(entry);
    }
  }

  // 3c. the union must be the legacy file, byte for byte
  if (legacyEntries) {
    const legacyDomains = new Set(legacyEntries.map((e) => e?.d));
    if (legacyDomains.size !== seen.size) {
      failures.push(
        `the shards hold ${seen.size} domains, the legacy file holds ${legacyDomains.size} — ` +
          'they must be the same catalog',
      );
    }
    for (const domain of legacyDomains) {
      if (!seen.has(domain)) failures.push(`"${domain}" is in the legacy index but in no shard`);
    }
    // The partition must be reproducible: re-partitioning the legacy entries
    // has to reproduce the shard files byte for byte, or the build is not
    // deterministic and every rebuild invalidates the CDN cache.
    const rebuilt = assignShards(legacyEntries);
    for (const [id, entries] of rebuilt) {
      const file = join(dataDir, 'search-index', `${id}.json`);
      if (!existsSync(file)) {
        failures.push(`shard "${id}" is missing (the legacy file holds it)`);
        continue;
      }
      const expected = serializeEntries(entries);
      const actual = readFileSync(file, 'utf8');
      if (expected !== actual) {
        failures.push(
          `shard "${id}" is not the deterministic partition of the legacy index — ` +
            'two builds of the same catalog must produce the same bytes',
        );
      }
    }
  }

  // 3d. the leaderboard slice is the head of the same list
  const topPath = join(dataDir, manifest.top?.file ?? SEARCH_TOP_FILE);
  if (existsSync(topPath)) {
    const topText = readFileSync(topPath, 'utf8');
    let top = null;
    try {
      top = JSON.parse(topText);
    } catch (err) {
      failures.push(`the leaderboard slice is not valid JSON: ${err.message}`);
    }
    if (Array.isArray(top)) {
      if (top.length !== manifest.top.count) {
        failures.push(
          `the leaderboard slice holds ${top.length} entries, but the manifest says ${manifest.top.count}`,
        );
      }
      failures.push(...checkEntries(top, 'the leaderboard slice'));
      const head = union
        .slice()
        .sort((a, b) => b.s - a.s || (a.d < b.d ? -1 : a.d > b.d ? 1 : 0))
        .slice(0, top.length);
      if (serializeEntries(top) !== serializeEntries(head)) {
        failures.push(
          'the leaderboard slice is not the head of the merged shards — the browse case and a query ' +
            'would show different sites',
        );
      }
    }
  } else {
    failures.push(`the leaderboard slice is missing: ${topPath}`);
  }

  return { failures, notes, metrics };
}

/** The shape every entry must have (the contract is the only judge). */
function checkEntries(entries, label = 'the index') {
  const problems = [];
  const seen = new Set();
  let previous = null;
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    for (const problem of validateSearchEntry(entry, i)) {
      if (problems.length < 20) problems.push(`${label}: ${problem}`);
    }
    if (entry && typeof entry.d === 'string') {
      if (seen.has(entry.d)) {
        if (problems.length < 20) problems.push(`${label}: duplicate domain "${entry.d}"`);
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
          problems.push(
            `${label}: entry ${i}: out of order (${previous.d} ${previous.s} before ${entry.d} ${entry.s})`,
          );
        }
      }
    }
    previous = entry;
  }
  return problems;
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
  if (metrics.shards !== undefined) {
    console.log(
      `shards: ${metrics.shards} files · ${metrics.shardEntries} entries · manifest ${SEARCH_MANIFEST_FILE}`,
    );
  }
  if (failures.length > 0) {
    console.error(`FAIL: ${failures.length} problem(s) with the search index:`);
    for (const failure of failures) console.error(`  · ${failure}`);
    process.exit(1);
  }
  console.log('All checks passed');
}
