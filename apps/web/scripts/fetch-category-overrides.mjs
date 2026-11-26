#!/usr/bin/env node
// @afr/web — the manual category labels, fetched from the public API.
//
// Why
//   The site build labels every site with the heuristic table
//   (src/data/categorize.mjs). A human decision in the admin console
//   (the manual category column) is better than a heuristic, so the build
//   has to know about it: the API publishes {domain: categorySlug} for the
//   sites that were labelled by hand, and the build applies it.
//
//   Without this the public pages would keep the heuristic label while the
//   API, the badge and the MCP answer with the manual one — the site would
//   show two different categories at once.
//
// Failure is never fatal
//   The build falls back to the heuristic labels — the same labels it
//   shipped before the manual ones existed. A build must not die because an
//   endpoint is down, so every failure ends as an empty map and a warning.

import { pathToFileURL } from 'node:url';
import { sanitizeCategoryOverrides } from '../src/data/detail.ts';

/** The public, read-only endpoint that publishes the manual labels. */
export const CATEGORY_OVERRIDES_ENDPOINT = '/api/v1/category-overrides';

/** The API base the build reads from. */
export const DEFAULT_API_BASE = 'https://afr.im';

/** An endpoint that does not answer in time must not hang the build. */
const REQUEST_TIMEOUT_MS = 8000;

/**
 * The manual category labels: domain → category slug.
 *
 * Any failure (network, HTTP status, malformed payload) yields an empty
 * map: the build then ships the heuristic labels instead of stopping.
 */
export async function fetchCategoryOverrides({ fetchImpl = fetch, apiBase = DEFAULT_API_BASE } = {}) {
  const base = String(apiBase).replace(/\/+$/, '');
  const url = `${base}${CATEGORY_OVERRIDES_ENDPOINT}`;
  try {
    const res = await fetchImpl(url, {
      headers: {
        accept: 'application/json',
        // Some edges refuse a request without one.
        'user-agent': 'afr-build (+https://afr.im)',
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`http ${res.status}`);
    const raw = await res.json();
    return sanitizeCategoryOverrides(raw);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.warn(`Category overrides unavailable (${url}); the build keeps the heuristic labels: ${reason}`);
    return {};
  }
}

// Run directly: print the map (a quick manual check of the endpoint).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const map = await fetchCategoryOverrides();
  console.log(JSON.stringify(map, null, 2));
}
