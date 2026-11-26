#!/usr/bin/env node
// @afr/web — the public charity ledger, fetched from the public API.
//
// Why
//   The charity page renders the ledger live in the browser, but the repo
//   should carry a mirror of it too: an append-only ledger that only exists
//   while one endpoint answers is not verifiable after the fact. The build
//   reads GET /api/v1/charity/ledger once and publishes it as
//   public/data/ledger.json — the same file the Worker-side readers use.
//
// Failure is never fatal
//   The build falls back to an empty ledger — the page then shows the empty
//   state it showed before the ledger existed. A build must not die because
//   an endpoint is down, so every failure ends as an empty ledger and a
//   warning (same rule as fetch-category-overrides.mjs / fetch-claims.mjs).

import { pathToFileURL } from 'node:url';
import { parseCharityLedger } from '../src/data/torch.ts';

/** The public, read-only endpoint that publishes the ledger. */
export const CHARITY_LEDGER_ENDPOINT = '/api/v1/charity/ledger';

/** The file the build writes the mirror to, under public/data/. */
export const CHARITY_LEDGER_FILE = 'ledger.json';

/** The API base the build reads from. */
export const DEFAULT_API_BASE = 'https://afr.im';

/** An endpoint that does not answer in time must not hang the build. */
const REQUEST_TIMEOUT_MS = 8000;

/** The empty shape the build ships when the endpoint is unavailable. */
export function emptyLedger() {
  return { generatedAt: '', entries: [] };
}

/**
 * The charity ledger: generatedAt + append-only entries.
 *
 * Any failure (network, HTTP status, malformed payload) yields the empty
 * ledger: the build then ships the empty state instead of stopping.
 */
export async function fetchCharityLedger({ fetchImpl = fetch, apiBase = DEFAULT_API_BASE } = {}) {
  const base = String(apiBase).replace(/\/+$/, '');
  const url = `${base}${CHARITY_LEDGER_ENDPOINT}`;
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
    const ledger = parseCharityLedger(raw);
    if (!ledger) throw new Error('malformed payload');
    return ledger;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.warn(`Charity ledger unavailable (${url}); the build ships an empty ledger: ${reason}`);
    return emptyLedger();
  }
}

// Run directly: print the ledger (a quick manual check of the endpoint).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const ledger = await fetchCharityLedger();
  console.log(JSON.stringify(ledger, null, 2));
}
