// @afr/web — search index payload contract.
//
// The client search payload (public/data/search-index.json) is read by the
// browser on every visit to /search. Three parties depend on its shape:
//
//   · the generator  (apps/web/scripts/fetch-data.mjs) writes it,
//   · the browser    (apps/web/src/pages/[...locale]/search.astro) reads it,
//   · the guardrail  (scripts/check-search-index.mjs) asserts it.
//
// The rules live in this module so the three cannot drift apart: the
// generator imports the builder, the guardrail imports the validator, and
// the browser reads exactly the keys the builder writes.
//
// Entry shape — one entry per rated site:
//
//   { d: domain, s: score, c?: category, t?: title }
//
//   d  the domain (always present)
//   s  the AFR score, 0..100 (always present)
//   c  the category slug — OMITTED for 'other': that category renders no
//      chip, so the key would only cost wire bytes
//   t  the page title, cut at a title separator (— | · :) or a word
//      boundary within SEARCH_TITLE_MAX chars, always carrying an "…" when
//      it was cut — OMITTED when the page title is unknown
//
// Two things are deliberately NOT in the payload:
//
//   · the grade. It is derived from the score with the engine's own
//     thresholds (packages/shared GRADE_THRESHOLDS): the server serializes
//     that table into the page, so no second copy of the grade table exists
//     in the browser.
//   · pending (unratable) sites. The browser filtered them out anyway, so
//     they only cost wire bytes.
//
// Budgets (SSOT §7b/T7): the browser pays the *compressed* size, so the
// wire budget is measured with brotli; the raw guard is a per-entry linear
// headroom check that warns long before the wire budget is reached.
//
// ── sharding ─────────────────────────────────────────────────────────────
//
// One file cannot hold the catalog forever: a single shard is measured
// against the same wire budget, and at ~20 B/entry that runs out around
// 8,000 rated sites (measured: 5,406 entries = 106 KB br today).
//
// So the index is written as a set of shards plus a manifest:
//
//   /data/search-index-manifest.json   what the browser needs to load them
//   /data/search-index/<id>.json        one shard per first character
//   /data/search-index-top.json         the leaderboard slice (the browse case)
//   /data/search-index.json             the legacy single file, while it fits
//
// The shard key is the first character of the domain. It is a pure function
// of the domain, so it never changes when the catalog grows: a new site
// only touches the shard of its own first letter, and every other shard
// keeps its bytes (and its CDN cache entry). A shard is also naturally
// balanced — the biggest letter holds ~9% of the catalog — so the per-file
// budget holds for a catalog an order of magnitude larger than today's.
//
// The manifest is the only thing the browser reads before it fetches
// anything. It carries the schema version, the total number of rated sites,
// and per shard: the file, the entry count, the raw bytes and the wire
// bytes. A browser that does not understand the version ignores it and
// falls back to the legacy single file, so a deploy never breaks a cached
// page.
//
// The legacy single file stays as long as the whole catalog fits the wire
// budget: an old page (a cached HTML shell from before the shards existed)
// asks for /data/search-index.json and must find it. When the catalog
// outgrows the budget the file is dropped — by then the old pages are long
// gone and the shards are the only sensible payload.

import { CATEGORY_SLUGS } from '../src/data/categorize.mjs';
import { gradeFor } from '../../../packages/afr/src/index.ts';

/** The keys an entry may carry (the grade is derived, not carried). */
export const SEARCH_ENTRY_KEYS = ['d', 's', 'c', 't'];

/** Max characters kept from a page title (cut on a word boundary). */
export const SEARCH_TITLE_MAX = 28;

/** Wire budget: brotli-compressed bytes of the whole index (160 KB). */
export const SEARCH_INDEX_WIRE_BUDGET = 160 * 1024;

/** Raw guard: bytes per entry — linear headroom, not a fixed ceiling. */
export const SEARCH_INDEX_RAW_PER_ENTRY = 96;

/* ── the shard contract ─────────────────────────────────────────────────── */

/** The manifest schema version — a browser that does not know it falls back. */
export const SEARCH_SHARD_VERSION = 1;

/** The manifest's schema name (a file that is not this, is not ours). */
export const SEARCH_SHARD_SCHEMA = 'afr.search-index';

/** The manifest file, relative to /data/. */
export const SEARCH_MANIFEST_FILE = 'search-index-manifest.json';

/** The directory the shards live in, relative to /data/. */
export const SEARCH_SHARD_DIR = 'search-index';

/** The leaderboard slice: the first entries by score — the browse case. */
export const SEARCH_TOP_SLICE_SIZE = 500;

/** The legacy single file, relative to /data/. */
export const SEARCH_LEGACY_FILE = 'search-index.json';

/**
 * The shard a domain belongs to: its first character.
 *
 * Lowercase, and only a–z get their own shard; everything else (digits, and
 * anything odd) shares one fallback shard. A pure function of the domain:
 * the same domain always lands in the same shard, and the shard of a letter
 * only changes when a site of that letter is added or removed.
 */
export function shardKeyFor(domain) {
  const c = String(domain ?? '').trim().toLowerCase().charAt(0);
  return c >= 'a' && c <= 'z' ? c : '0';
}

/**
 * Split the sorted entries into their shards.
 *
 * The entries keep their order inside a shard (score desc, then domain asc),
 * so a shard is a contiguous slice of the catalog and the shards merge back
 * into exactly the original order.
 */
export function assignShards(entries) {
  const shards = new Map();
  for (const entry of entries ?? []) {
    const key = shardKeyFor(entry?.d);
    const list = shards.get(key);
    if (list) list.push(entry);
    else shards.set(key, [entry]);
  }
  return shards;
}

/** The shard file name (relative to /data/). */
export function shardFileFor(key) {
  return `${SEARCH_SHARD_DIR}/${key}.json`;
}

/** The leaderboard slice file (relative to /data/). */
export const SEARCH_TOP_FILE = 'search-index-top.json';

/**
 * Build the manifest the browser reads before it fetches any shard.
 *
 * No timestamp: the manifest is part of the reproducible build — the same
 * catalog must produce byte-identical files, or the CDN cache would miss
 * on every build for no reason.
 *
 * `sizes` carries the measured payload sizes (raw bytes and brotli wire
 * bytes per shard id); the generator measures them, the contract only
 * records them, so the browser can see what a fetch will cost before it
 * starts.
 */
export function buildShardManifest({ shards, top, entries, sizes, topSize } = {}) {
  const list = [];
  for (const [id, shardEntries] of shards ?? new Map()) {
    const size = sizes?.[id] ?? {};
    list.push({
      id,
      file: shardFileFor(id),
      count: shardEntries.length,
      raw: size.raw ?? 0,
      wire: size.wire ?? 0,
    });
  }
  list.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return {
    v: SEARCH_SHARD_VERSION,
    schema: SEARCH_SHARD_SCHEMA,
    entries: entries ?? 0,
    top: {
      file: SEARCH_TOP_FILE,
      count: top?.length ?? 0,
      raw: topSize?.raw ?? 0,
      wire: topSize?.wire ?? 0,
    },
    shards: list,
    budget: { wire: SEARCH_INDEX_WIRE_BUDGET, rawPerEntry: SEARCH_INDEX_RAW_PER_ENTRY },
  };
}

/** Validate a manifest against the contract → list of problems (empty = ok). */
export function validateShardManifest(manifest) {
  const problems = [];
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    return ['manifest: not an object'];
  }
  if (manifest.v !== SEARCH_SHARD_VERSION) {
    problems.push(`manifest: version ${manifest.v} is not ${SEARCH_SHARD_VERSION}`);
  }
  if (manifest.schema !== SEARCH_SHARD_SCHEMA) {
    problems.push(`manifest: schema "${manifest.schema}" is not "${SEARCH_SHARD_SCHEMA}"`);
  }
  if (!Number.isInteger(manifest.entries) || manifest.entries < 0) {
    problems.push('manifest: "entries" must be a non-negative integer');
  }
  if (!manifest.top || typeof manifest.top.file !== 'string') {
    problems.push('manifest: "top.file" must be a file name');
  }
  if (!Array.isArray(manifest.shards) || manifest.shards.length === 0) {
    problems.push('manifest: "shards" must be a non-empty array');
    return problems;
  }
  const seen = new Set();
  let counted = 0;
  for (const shard of manifest.shards) {
    if (!shard || typeof shard !== 'object') {
      problems.push('manifest: a shard is not an object');
      continue;
    }
    if (typeof shard.id !== 'string' || !/^[a-z0]$/.test(shard.id)) {
      problems.push(`manifest: shard id "${shard.id}" is not a shard key`);
    }
    if (seen.has(shard.id)) problems.push(`manifest: shard "${shard.id}" is listed twice`);
    seen.add(shard.id);
    if (shard.file !== shardFileFor(shard.id)) {
      problems.push(`manifest: shard "${shard.id}" points at "${shard.file}"`);
    }
    if (!Number.isInteger(shard.count) || shard.count < 0) {
      problems.push(`manifest: shard "${shard.id}" has no entry count`);
    } else {
      counted += shard.count;
    }
    if (!Number.isInteger(shard.raw) || shard.raw < 0) {
      problems.push(`manifest: shard "${shard.id}" has no raw size`);
    }
    if (!Number.isInteger(shard.wire) || shard.wire < 0) {
      problems.push(`manifest: shard "${shard.id}" has no wire size`);
    }
  }
  if (counted !== manifest.entries) {
    problems.push(
      `manifest: the shards hold ${counted} entries, but the manifest says ${manifest.entries}`,
    );
  }
  return problems;
}

/** The grade rule the browser mirrors (the engine's own rule). */
export { gradeFor };

/**
 * The category that carries no chip (the card never renders it). The entry
 * omits the category key for these sites, so the payload never carries a
 * category that renders nothing.
 */
export const UNCATEGORIZED = 'other';

if (!CATEGORY_SLUGS.includes(UNCATEGORIZED)) {
  throw new Error(
    `search index contract: "${UNCATEGORIZED}" is not a known category slug — ` +
      'the category taxonomy changed, update the contract',
  );
}

/** Separators that mark a semantic boundary inside a title. The cut prefers
 *  the last one inside the window: a head cut there never ends on a
 *  dangling mark ("TokensHubs —", "New Atlas:"). */
const TITLE_SEPARATORS = ['—', '|', '·', ':'];

/** Marks a truncated head must never end with — including a plain hyphen
 *  ("Vanity Fair -"), which the cut never lands on but can still be left
 *  hanging at the end of a word-boundary cut. */
const TRAILING_MARKS = /[\s—|·:-]+$/;

/**
 * Cut a title to `max` characters, appending "…" whenever it was cut.
 *
 * The boundary chain inside the truncation window: the last separator
 * (— | · :), else the last space, else a hard cut — and whatever dangling
 * mark sits at the end of that head is stripped first. The ellipsis is
 * reserved inside `max`, so a truncated title still satisfies the
 * `SEARCH_TITLE_MAX` check in validateSearchEntry.
 */
export function truncateTitle(title, max = SEARCH_TITLE_MAX) {
  if (!title) return undefined;
  if (title.length <= max) return title;
  const cut = title.slice(0, max - 1); /* reserve the ellipsis */
  let head = '';
  let sepAt = -1;
  for (const sep of TITLE_SEPARATORS) sepAt = Math.max(sepAt, cut.lastIndexOf(sep));
  if (sepAt > 0) head = cut.slice(0, sepAt);
  if (!head.trim()) {
    /* No separator in the window — fall back to the word boundary. */
    const space = cut.lastIndexOf(' ');
    head = space > 0 ? cut.slice(0, space) : cut;
  }
  head = head.replace(TRAILING_MARKS, '').trim();
  /* A head that is all marks carries no information — drop the title, the
     same contract as before (an entry simply omits `t`). */
  return head ? `${head}…` : undefined;
}

/** Build one index entry. */
export function buildSearchEntry({ domain, score, category, title } = {}) {
  const entry = { d: domain, s: score };
  if (category && category !== UNCATEGORIZED) entry.c = category;
  const t = truncateTitle(title);
  if (t) entry.t = t;
  return entry;
}

/** Validate one entry against the contract → list of problems (empty = ok). */
export function validateSearchEntry(entry, index = 0) {
  const problems = [];
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    return [`entry ${index}: not an object`];
  }
  for (const key of Object.keys(entry)) {
    if (!SEARCH_ENTRY_KEYS.includes(key)) {
      problems.push(`entry ${index}: unknown key "${key}"`);
    }
  }
  if (typeof entry.d !== 'string' || entry.d.length === 0) {
    problems.push(`entry ${index}: "d" must be a non-empty domain string`);
  }
  if (!Number.isInteger(entry.s) || entry.s < 0 || entry.s > 100) {
    problems.push(`entry ${index}: "s" must be an integer score between 0 and 100`);
  }
  if (entry.c !== undefined) {
    if (!CATEGORY_SLUGS.includes(entry.c)) {
      problems.push(`entry ${index}: "c" must be a known category slug`);
    }
    if (entry.c === UNCATEGORIZED) {
      problems.push(`entry ${index}: "c" must be omitted for the "${UNCATEGORIZED}" category`);
    }
  }
  if (entry.t !== undefined) {
    if (typeof entry.t !== 'string' || entry.t.length === 0) {
      problems.push(`entry ${index}: "t" must be a non-empty title string`);
    } else if (entry.t.length > SEARCH_TITLE_MAX) {
      problems.push(`entry ${index}: "t" is ${entry.t.length} chars (max ${SEARCH_TITLE_MAX})`);
    }
  }
  return problems;
}
