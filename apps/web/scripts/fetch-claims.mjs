#!/usr/bin/env node
// @afr/web — the published owner statements, fetched from the public API.
//
// Why
//   Owner statements live in the Worker's database and are published by the
//   moderation queue. The report page renders them next to the score, so the
//   build has to know them: the API publishes {domain: statement} for every
//   published statement, and the build writes it to public/data/claims.json
//   — the file the on-demand detail page reads at render time.
//
//   Without this the form would accept statements nobody could ever read:
//   the write path exists, the read path would not.
//
// Failure is never fatal
//   The build falls back to no statements — the page then shows the empty
//   state it showed before statements existed. A build must not die because
//   an endpoint is down, so every failure ends as an empty map and a warning.

import { sanitizeClaims } from '../src/data/detail.ts';

/** The public, read-only endpoint that publishes the statements. */
export const CLAIMS_ENDPOINT = '/api/v1/claims/published';

/** The API base the build reads from. */
export const DEFAULT_API_BASE = 'https://afr.im';

/** An endpoint that does not answer in time must not hang the build. */
const REQUEST_TIMEOUT_MS = 8000;

/**
 * The published owner statements: domain → statement text.
 *
 * Any failure (network, HTTP status, malformed payload) yields an empty
 * map: the build then ships pages without statements instead of stopping.
 */
export async function fetchPublishedClaims({ fetchImpl = fetch, apiBase = DEFAULT_API_BASE } = {}) {
  const base = String(apiBase).replace(/\/+$/, '');
  const url = `${base}${CLAIMS_ENDPOINT}`;
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
    return sanitizeClaims(raw);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.warn(`Published claims unavailable (${url}); the build ships without statements: ${reason}`);
    return {};
  }
}

// Run directly: print the map (a quick manual check of the endpoint).
if (import.meta.url === `file://${process.argv[1]}`) {
  const map = await fetchPublishedClaims();
  console.log(JSON.stringify(map, null, 2));
}
