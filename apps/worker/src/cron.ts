// src/cron.ts — daily scheduled job: sync the newest scan snapshot from the
// AFR-data repository into D1 (sites / scans / evidence).
//
// Scope note: the Worker never scans — scanners run in GitHub Actions
// (scan.yml). This job only pulls snapshots the data repo already published,
// and it never touches the scan-request queue (scanning the queue is likewise
// the GitHub side's job; it reports back via POST /api/v1/queue/:domain/done).

import { DATA_REPO_API, syncDate, type SyncResult } from './d1-sync.ts';
import type { Db } from './db.ts';

export interface CronDeps {
  db: Db;
  /** Injected fetch (tests pass a fake; production passes global fetch) */
  fetchImpl: typeof fetch;
  /** Logger (defaults to console) */
  log?: (message: string) => void;
}

interface ContentEntry {
  name: string;
  type: string;
}

/** Wrap a fetch so every api.github.com call carries the repo token.
 * Anonymous calls from Worker IPs are rate-limited/unstable and made
 * latestSnapshotDate() return null — which silently disabled the daily sync. */
export function githubAuthedFetch(token: string | undefined, base: typeof fetch): typeof fetch {
  if (!token) return base;
  const wrapped = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.startsWith('https://api.github.com/')) {
      const headers = new Headers(init?.headers);
      headers.set('authorization', `Bearer ${token}`);
      headers.set('user-agent', 'afr-sync');
      return base(input, { ...init, headers });
    }
    return base(input, init);
  };
  return wrapped as typeof fetch;
}

/** List one directory under the data repo's scans/ tree; null when absent/empty */
async function listDir(fetchImpl: typeof fetch, path: string): Promise<string[] | null> {
  const res = await fetchImpl(`${DATA_REPO_API}/${path}`);
  if (!res.ok) return null;
  const entries = (await res.json()) as ContentEntry[];
  const dirs = entries.filter((e) => e.type === 'dir').map((e) => e.name);
  // GitHub returns names ascending: 01..12 / 01..31 sort chronologically.
  return dirs.sort();
}

/** Resolve the newest YYYY/MM/DD snapshot directory in the data repo,
 * or null when there are no snapshots yet (nothing to sync). */
export async function latestSnapshotDate(fetchImpl: typeof fetch): Promise<string | null> {
  const year = await listDir(fetchImpl, 'scans');
  const latestYear = year?.at(-1);
  if (!latestYear) return null;
  const month = await listDir(fetchImpl, `scans/${latestYear}`);
  const latestMonth = month?.at(-1);
  if (!latestMonth) return null;
  const day = await listDir(fetchImpl, `scans/${latestYear}/${latestMonth}`);
  const latestDay = day?.at(-1);
  if (!latestDay) return null;
  return `${latestYear}/${latestMonth}/${latestDay}`;
}

/** Sync the latest snapshot date into D1. Never throws: failures are logged
 * and reported as null so a bad network day cannot wedge the cron. */
export async function runDailySync(deps: CronDeps): Promise<SyncResult | null> {
  const log = deps.log ?? ((message: string) => console.log(message));
  try {
    const date = await latestSnapshotDate(deps.fetchImpl);
    if (!date) {
      log('daily sync: no snapshot date found, skipping');
      return null;
    }
    const result = await syncDate(date, { db: deps.db, fetchImpl: deps.fetchImpl });
    log(
      `daily sync ${date}: ${result.sitesUpserted} sites, ${result.scansUpserted} scans, ` +
        `${result.evidenceRows} evidence rows, ${result.errors.length} errors`,
    );
    return result;
  } catch (err) {
    log(`daily sync failed: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}
