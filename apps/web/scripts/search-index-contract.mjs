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
//   t  the page title, cut on a word boundary at SEARCH_TITLE_MAX chars —
//      OMITTED when the page title is unknown
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

/** Cut a title to `max` characters without cutting a word in half. */
export function truncateTitle(title, max = SEARCH_TITLE_MAX) {
  if (!title) return undefined;
  if (title.length <= max) return title;
  const cut = title.slice(0, max);
  const space = cut.lastIndexOf(' ');
  /* No space in the head means the first word alone is longer than the
     budget — a hard cut is the only option left. */
  const head = space > 0 ? cut.slice(0, space) : cut;
  return head.trim() || undefined;
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
