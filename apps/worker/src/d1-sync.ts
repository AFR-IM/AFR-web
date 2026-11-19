// src/d1-sync.ts — pull daily scan snapshots from the AFR-data repository and
// upsert them into D1 (sites / scans / evidence).
//
// SSOT layout: https://raw.githubusercontent.com/AFR-IM/AFR-data/main/scans/YYYY/MM/DD/<domain>.json
// Each snapshot is `{ signals, afr }` (packages/scanner output + packages/afr result).
// Both `fetch` and `db` are injected so the logic is fully testable offline
// (test/d1-sync.test.ts fakes the trees listing + raw file fetches).
//
// Listing uses the Git Trees API (`git/trees/main:scans/<date>`), not the
// contents API: contents silently truncates directories at 1000 entries with
// no pagination (a 1048-file day would lose 48 snapshots) and carries no
// content hash. Trees returns every entry plus each file's git blob sha,
// which we persist as scans.snapshot_sha — a file whose sha already matches D1
// is skipped without a fetch (idempotent re-syncs cost 1 listing + 1 query).
//
// One Worker invocation may only make ~50 subrequests (free-plan hard cap), so
// syncDate pages through the listing: callers loop `{offset}` until
// `nextOffset === null` (sync-site.yml drives the loop; the 04:30 cron falls
// back to one page of DEFAULT_SYNC_LIMIT per day).
//
// Latency note (2026-11-18): a page of 32 fresh snapshots used to cost ~2.5
// minutes because every snapshot was fetched and written strictly one after
// the other (32 raw fetches x ~2 s + ~21 D1 round trips x ~40 ms each). A
// full scan day (1000+ snapshots) therefore needed ~80 minutes and could not
// finish inside the 60-minute CI job. The page pipeline now runs the fetch
// phase and the D1 phase with bounded concurrency (SYNC_CONCURRENCY /
// DB_CONCURRENCY) and the evidence rows of one snapshot are written with a
// single multi-row INSERT, so the same page costs ~20 s instead of ~150 s.
// The cursor contract (offset / nextOffset / sha-skip) is unchanged: a page
// still fetches at most `limit` snapshots, skips are free, and a snapshot
// whose write failed keeps its old blob sha so the next run retries it.

import type { AfrResult, CheckResult, ScanSignals } from '../../../packages/shared/src/index.ts';
import type { Db } from './db.ts';

export const DATA_REPO_API = 'https://api.github.com/repos/AFR-IM/AFR-data/contents';
export const DATA_REPO_TREES = 'https://api.github.com/repos/AFR-IM/AFR-data/git/trees';
export const DATA_REPO_RAW = 'https://raw.githubusercontent.com/AFR-IM/AFR-data/main';

/** Max snapshot fetches per invocation: 3 dir listings (cron path) + 1 trees
 * listing + 32 raw fetches = 36 ≤ the ~50 subrequest free-plan cap. Kept at
 * 32 (not the theoretical 46) because a page also burns CPU parsing snapshots
 * + diffing evidence — 44-file pages intermittently tripped the CPU limit
 * (error 1102) during the backfill; sha-skip makes extra pages cheap. */
export const DEFAULT_SYNC_LIMIT = 32;

/** Max raw snapshot fetches in flight per page. A Worker invocation may hold
 * only six simultaneous open connections (Workers Free limit), so the fetch
 * phase never opens more than six at a time. */
export const SYNC_CONCURRENCY = 6;

/** Max snapshots written to D1 in parallel. D1 writes are serialised by the
 * primary anyway; a small fan-out keeps the request moving without piling
 * up concurrent statements on one database. */
export const DB_CONCURRENCY = 4;

/** D1 accepts at most 100 bound parameters per query and the evidence insert
 * binds 7 columns per row → at most 14 rows per multi-row INSERT. */
const EVIDENCE_COLUMNS_PER_ROW = 7;
const MAX_BOUND_PARAMS = 100;
const MAX_EVIDENCE_ROWS = Math.floor(MAX_BOUND_PARAMS / EVIDENCE_COLUMNS_PER_ROW);

export interface Snapshot {
  signals: ScanSignals;
  afr: AfrResult;
}

export interface SyncDeps {
  db: Db;
  /** Injected fetch (tests pass a fake; production passes global fetch) */
  fetchImpl: typeof fetch;
}

export interface SyncError {
  path: string;
  message: string;
}

export interface SyncOptions {
  /** First entry index (sorted by path) to process — resume cursor from `nextOffset`. */
  offset?: number;
  /** Max snapshot fetches this invocation (skips are free and do not consume budget). */
  limit?: number;
}

export interface SyncResult {
  date: string;
  /** Snapshot paths discovered from the repo trees listing */
  listed: number;
  /** Entries already in D1 with a matching snapshot_sha (no fetch, no write) */
  skipped: number;
  /** Sites updated (upsert is idempotent: re-running the same date does not duplicate) */
  sitesUpserted: number;
  scansUpserted: number;
  evidenceRows: number;
  /** Next entry index to process; null = this date is fully processed */
  nextOffset: number | null;
  errors: SyncError[];
}

const DATE_RE = /^\d{4}\/\d{2}\/\d{2}$/;

/** Run `fn` over `items` with at most `limit` calls in flight, keeping the
 * input order in the result. Used for the fetch phase and the D1 phase of a
 * sync page: both are latency-bound (network / database round trips), so
 * overlapping them is what makes a page cheap — the CPU work per snapshot is
 * unchanged. */
async function mapConcurrent<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) return [];
  const results = new Array<R>(items.length);
  let cursor = 0;
  const workerCount = Math.max(1, Math.min(limit, items.length));
  const workers: Promise<void>[] = [];
  for (let w = 0; w < workerCount; w++) {
    workers.push(
      (async () => {
        for (;;) {
          const index = cursor++;
          if (index >= items.length) return;
          const item = items[index] as T;
          results[index] = await fn(item, index);
        }
      })(),
    );
  }
  await Promise.all(workers);
  return results;
}

interface TreeEntry {
  path: string;
  type: string;
  sha: string;
}

/** Validate the YYYY/MM/DD date segment and return the Git Trees URL for that
 * day's directory. Entries come back relative to the queried subtree (bare
 * filenames), so syncDate re-prefixes them with `scans/<date>/`. */
export function listingUrl(date: string): string {
  if (!DATE_RE.test(date)) throw new Error(`invalid date "${date}" (expected YYYY/MM/DD)`);
  return `${DATA_REPO_TREES}/main:scans/${date}`;
}

export function snapshotUrl(path: string): string {
  return `${DATA_REPO_RAW}/${path}`;
}

/** Fetch the day's trees listing and upsert the snapshots that start at
 * `offset` and whose git sha is not already in D1. Skips are free; only
 * actual fetches consume the per-invocation subrequest budget, so a page
 * walks past already-synced entries and stops when it has fetched `limit`
 * files. `nextOffset` is the first entry that was not processed — the caller
 * pages with it until it is null. */
export async function syncDate(date: string, deps: SyncDeps, opts: SyncOptions = {}): Promise<SyncResult> {
  const offset = Math.max(0, Math.floor(opts.offset ?? 0));
  const limit = Math.min(Math.max(1, Math.floor(opts.limit ?? DEFAULT_SYNC_LIMIT)), DEFAULT_SYNC_LIMIT);
  const result: SyncResult = {
    date,
    listed: 0,
    skipped: 0,
    sitesUpserted: 0,
    scansUpserted: 0,
    evidenceRows: 0,
    nextOffset: null,
    errors: [],
  };

  const listingRes = await deps.fetchImpl(listingUrl(date));
  if (!listingRes.ok) {
    throw new Error(`snapshot listing failed: HTTP ${listingRes.status}`);
  }
  const tree = (await listingRes.json()) as { tree?: TreeEntry[]; truncated?: boolean };
  if (tree.truncated) throw new Error(`snapshot listing truncated for ${date}`);

  const prefix = `scans/${date}/`;
  const entries = (tree.tree ?? [])
    .filter((e) => e.type === 'blob' && e.path.endsWith('.json'))
    .map((e) => ({ path: e.path.startsWith('scans/') ? e.path : prefix + e.path, sha: e.sha }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  result.listed = entries.length;

  // Page-local sha probe: instead of range-scanning the whole date (1000
  // rows on every page — what blew the D1 row-read budget during backfill),
  // probe only as far as this invocation can process: chunks of `limit`
  // paths via one IN() query each. Fetch-heavy pages stop after the first
  // chunk (44 rows read); already-synced dates walk further because skips
  // are free — only fetches consume the subrequest budget.
  const known = new Map<string, string | null>();
  const probePaths = async (from: number, count: number): Promise<void> => {
    const chunk = entries.slice(from, from + count);
    if (chunk.length === 0) return;
    const placeholders = chunk.map(() => '?').join(',');
    const rows = await deps.db
      .prepare(`SELECT snapshot_path, snapshot_sha FROM scans WHERE snapshot_path IN (${placeholders})`)
      .all<{ snapshot_path: string; snapshot_sha: string | null }>(...chunk.map((e) => e.path));
    for (const r of rows) known.set(r.snapshot_path, r.snapshot_sha);
  };

  let fetches = 0;
  let i = offset;
  while (i < entries.length) {
    await probePaths(i, limit);
    const chunkEnd = Math.min(i + limit, entries.length);
    const chunk = entries.slice(i, chunkEnd);

    // Split the chunk: entries whose blob sha is already in D1 are free (no
    // fetch, no write); the rest need a fetch. The invocation's fetch budget
    // is `limit` — when it runs out inside the chunk the remainder belongs to
    // the next page, which resumes at the same cursor the old code used
    // (nextOffset = the first entry that was not processed).
    const todo: Array<{ path: string; sha: string }> = [];
    let consumed = 0;
    for (const entry of chunk) {
      if (known.get(entry.path) === entry.sha) {
        result.skipped += 1;
        consumed += 1;
        continue;
      }
      if (fetches + todo.length >= limit) break;
      todo.push(entry);
      consumed += 1;
    }

    // Phase 1 — fetch the snapshots that are missing or stale. Overlapping
    // the raw downloads is the single biggest win of the page: 32 sequential
    // fetches cost ~64 s, six at a time cost ~11 s.
    const fetched = await mapConcurrent(todo, SYNC_CONCURRENCY, async (entry) => {
      try {
        const res = await deps.fetchImpl(snapshotUrl(entry.path));
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return { path: entry.path, sha: entry.sha, snapshot: (await res.json()) as Snapshot };
      } catch (err) {
        return {
          path: entry.path,
          sha: entry.sha,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    });

    // Phase 2 — write them to D1 (a few statements per snapshot, overlapped
    // across snapshots). A failed write is recorded and its snapshot keeps
    // its old blob sha, so the next run picks it up again.
    const written = await mapConcurrent(fetched, DB_CONCURRENCY, async (item) => {
      if (item.error !== undefined) return { path: item.path, error: item.error };
      try {
        const stats = await upsertSnapshot(deps.db, item.snapshot, item.path, item.sha);
        return { path: item.path, stats };
      } catch (err) {
        return { path: item.path, error: err instanceof Error ? err.message : String(err) };
      }
    });

    for (const outcome of written) {
      if (outcome.error !== undefined) {
        result.errors.push({ path: outcome.path, message: outcome.error });
        continue;
      }
      const stats = outcome.stats!;
      result.sitesUpserted += stats.siteChanged ? 1 : 0;
      result.scansUpserted += 1;
      result.evidenceRows += stats.evidenceRows;
    }

    fetches += todo.length;
    i += consumed;
    if (consumed < chunk.length) break; // fetch budget spent → next page resumes at i
  }
  result.nextOffset = i < entries.length ? i : null;

  return result;
}

export interface UpsertStats {
  siteChanged: boolean;
  evidenceRows: number;
}

/** The six persisted evidence columns, as stored (owner) or wanted (snapshot). */
interface EvidenceSnapshotRow {
  check_id: string;
  status: string | null;
  points: number | null;
  max_points: number | null;
  evidence_type: string | null;
  evidence_ref: string | null;
}

/** Flatten an AFR result into the evidence rows it wants persisted.
 * One row per check id: `evidence` carries a UNIQUE index on
 * (scan_id, check_id), so a snapshot that lists the same check twice (two
 * layers, or a duplicated check in the engine output) must collapse to a
 * single row instead of aborting the whole snapshot. The first occurrence
 * wins, which is what the row-by-row insert did before it hit the index. */
function wantedRows(afr: AfrResult): EvidenceSnapshotRow[] {
  const rows: EvidenceSnapshotRow[] = [];
  const seen = new Set<string>();
  for (const check of afr.layers.flatMap((l) => l.checks) as CheckResult[]) {
    if (seen.has(check.id)) continue;
    seen.add(check.id);
    rows.push({
      check_id: check.id,
      status: check.status ?? null,
      points: check.awarded ?? null,
      max_points: check.max ?? null,
      evidence_type: check.evidence?.source ?? null,
      // Snapshot-local excerpt (spec wants a snapshot path or excerpt hash;
      // the detail text is the excerpt until hash referencing lands)
      evidence_ref: check.evidence?.detail ?? null,
    });
  }
  return rows;
}

/** Write the evidence rows of one snapshot with multi-row INSERTs.
 *
 * One statement per row cost 12 round trips per snapshot (~640 per page);
 * batching them into a single INSERT (≤14 rows → ≤98 bound parameters, D1's
 * limit is 100) cuts the write phase to one round trip per snapshot.
 *
 * `INSERT OR REPLACE` instead of plain `INSERT`: the UNIQUE index on
 * (scan_id, check_id) makes a duplicate row a hard error, and a duplicate
 * can appear when the same snapshot path is synced by two invocations at
 * once (the 04:30 cron and the CI sync-site run can overlap) — the row is
 * then replaced with the wanted values instead of failing the snapshot and
 * leaving it without its blob sha (which would re-fetch it forever). */
async function insertEvidenceRows(
  db: Db,
  scanId: number,
  rows: EvidenceSnapshotRow[],
): Promise<number> {
  let written = 0;
  for (let start = 0; start < rows.length; start += MAX_EVIDENCE_ROWS) {
    const slice = rows.slice(start, start + MAX_EVIDENCE_ROWS);
    const placeholders = slice.map(() => '(?,?,?,?,?,?,?)').join(',');
    const params: (string | number | null)[] = [];
    for (const row of slice) {
      params.push(
        scanId,
        row.check_id,
        row.status,
        row.points,
        row.max_points,
        row.evidence_type,
        row.evidence_ref,
      );
    }
    await db
      .prepare(
        `INSERT OR REPLACE INTO evidence (scan_id, check_id, status, points, max_points, evidence_type, evidence_ref)
         VALUES ${placeholders}`,
      )
      .run(...params);
    written += slice.length;
  }
  return written;
}

/** True when both sides hold the same check set with identical field values
 * (order-independent). Evidence details are deterministic (no timestamps),
 * so an unchanged site re-scan compares equal across rounds — this is what
 * makes the cross-round zero-write diff safe. */
function evidenceSetsEqual(a: EvidenceSnapshotRow[], b: EvidenceSnapshotRow[]): boolean {
  if (a.length !== b.length) return false;
  const byId = new Map(a.map((r) => [r.check_id, r]));
  for (const row of b) {
    const other = byId.get(row.check_id);
    if (!other) return false;
    if (
      other.status !== row.status ||
      other.points !== row.points ||
      other.max_points !== row.max_points ||
      other.evidence_type !== row.evidence_type ||
      other.evidence_ref !== row.evidence_ref
    ) {
      return false;
    }
  }
  return true;
}

/** Upsert one snapshot: site row (scores/grade/status) + its scan + evidence rows.
 * Re-syncing the same snapshot path updates in place (keyed on scans.snapshot_path)
 * and diffs that scan's evidence — unchanged rows are never rewritten.
 * `sha` is the git blob sha from the trees listing: it is the skip key for the
 * next sync (a changed file — engine re-run, same-day rescan — yields a new
 * sha and is re-fetched automatically). */
export async function upsertSnapshot(
  db: Db,
  snapshot: Snapshot,
  path: string,
  sha: string | null = null,
): Promise<UpsertStats> {
  const afr = snapshot.afr;
  const signals = snapshot.signals;
  const domain = afr.domain || signals.domain;
  if (!domain) throw new Error(`snapshot ${path} has no domain`);

  const layerScore = (id: 'L1' | 'L2' | 'L3'): number | null =>
    afr.layers.find((l) => l.layer === id)?.awarded ?? null;

  const now = new Date().toISOString();
  const scannedAt = afr.scannedAt ?? signals.fetchedAt ?? now;

  // --- sites: upsert keeps human-curated fields (category_id, title, lang,
  // rank, verified) untouched — only scanner-owned columns are overwritten.
  // The WHERE clause makes the write order-independent: an older snapshot
  // syncing after a newer one (multi-date backfill, cron racing the CI loop)
  // can never downgrade the live score. Equal scanned_at still updates, so an
  // engine re-run of the same scan refreshes in place.
  const siteRun = await db
    .prepare(
      `INSERT INTO sites (domain, strategy_tag, grade, score_total, score_l1, score_l2, score_l3,
                          status, created_at, updated_at, scanned_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)
       ON CONFLICT(domain) DO UPDATE SET
         strategy_tag = excluded.strategy_tag,
         grade = excluded.grade,
         score_total = excluded.score_total,
         score_l1 = excluded.score_l1,
         score_l2 = excluded.score_l2,
         score_l3 = excluded.score_l3,
         status = excluded.status,
         updated_at = excluded.updated_at,
         scanned_at = excluded.scanned_at
       WHERE sites.scanned_at IS NULL OR excluded.scanned_at >= sites.scanned_at`,
    )
    .run(
      domain,
      afr.strategyTag ?? null,
      afr.grade ?? null,
      afr.score ?? null,
      layerScore('L1'),
      layerScore('L2'),
      layerScore('L3'),
      now,
      now,
      scannedAt,
    );

  // --- scans: one row per snapshot path (idempotent re-sync).
  // snapshot_sha is deliberately NOT written here: the sha is the skip key for
  // the next sync, so it may only land after this snapshot's evidence diff has
  // fully completed — otherwise a write-limit abort mid-evidence would leave a
  // "synced" sha behind and permanently skip the missing rows.
  const existing = await db
    .prepare('SELECT id, evidence_prev FROM scans WHERE snapshot_path = ?')
    .get<{ id: number; evidence_prev: number | null }>(path);

  let scanId: number;
  let scanPointer: number | null = null;
  if (existing) {
    scanId = existing.id;
    scanPointer = existing.evidence_prev ?? null;
    await db
      .prepare(
        `UPDATE scans SET engine_version = ?, score_total = ?, score_l1 = ?, score_l2 = ?, score_l3 = ?,
                          grade = ?, started_at = ?, finished_at = ?
         WHERE id = ?`,
      )
      .run(
        afr.engineVersion ?? null,
        afr.score ?? null,
        layerScore('L1'),
        layerScore('L2'),
        layerScore('L3'),
        afr.grade ?? null,
        scannedAt,
        signals.fetchedAt ?? now,
        scanId,
      );
  } else {
    const inserted = await db
      .prepare(
        `INSERT INTO scans (domain, engine_version, score_total, score_l1, score_l2, score_l3,
                            grade, snapshot_path, started_at, finished_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        domain,
        afr.engineVersion ?? null,
        afr.score ?? null,
        layerScore('L1'),
        layerScore('L2'),
        layerScore('L3'),
        afr.grade ?? null,
        path,
        scannedAt,
        signals.fetchedAt ?? now,
      );
    scanId = inserted.lastInsertRowid;
  }

  const wanted = wantedRows(afr);

  // --- evidence rows this scan already owns. One query replaces the old
  // COUNT(*) probe: an empty result set means the scan owns no evidence yet.
  const existingEvidence = await db
    .prepare(
      `SELECT check_id, status, points, max_points, evidence_type, evidence_ref
       FROM evidence WHERE scan_id = ?`,
    )
    .all<EvidenceSnapshotRow>(scanId);

  // --- cross-round diff (T8b): a re-scan whose evidence is byte-identical to
  // the most recent FULL set for this domain must cost zero evidence rows.
  // The daily pipeline spends most of its row-write budget re-inserting the
  // same 12 rows per unchanged site (weekly full re-scan at 5k sites ≈ 60k
  // rows in one day, against a 100k/day free-tier cap). Instead this scan
  // points at the owner via scans.evidence_prev — one row update instead of
  // twelve inserts. Reads fall back through the pointer (see the detail
  // endpoint). Only scans that own a full set (evidence_prev IS NULL) are
  // candidates, so a pointed scan can never be compared against another
  // pointed scan's (possibly stale) pointer — chains cannot form.
  if (existingEvidence.length === 0) {
    const prevOwner = await db
      .prepare(
        `SELECT id FROM scans
         WHERE domain = ? AND id <> ? AND evidence_prev IS NULL
         ORDER BY started_at DESC, id DESC LIMIT 1`,
      )
      .get<{ id: number }>(domain, scanId);
    if (prevOwner) {
      const prevEvidence = await db
        .prepare(
          `SELECT check_id, status, points, max_points, evidence_type, evidence_ref
           FROM evidence WHERE scan_id = ?`,
        )
        .all<EvidenceSnapshotRow>(prevOwner.id);
      if (evidenceSetsEqual(prevEvidence, wanted)) {
        if (scanPointer !== prevOwner.id) {
          await db.prepare('UPDATE scans SET evidence_prev = ? WHERE id = ?').run(prevOwner.id, scanId);
        }
        // Content verified identical — committing the skip key is safe.
        if (sha !== null) {
          await db.prepare('UPDATE scans SET snapshot_sha = ? WHERE id = ?').run(sha, scanId);
        }
        return { siteChanged: siteRun.changes > 0, evidenceRows: 0 };
      }
      // Same path re-fetched with different bytes (engine re-run): this scan
      // must own a full set again — drop the stale pointer, then fall through
      // to the per-scan diff, which inserts every wanted row (it sees an
      // empty evidence set for this scan).
      if (scanPointer !== null) {
        await db.prepare('UPDATE scans SET evidence_prev = NULL WHERE id = ?').run(scanId);
        scanPointer = null;
      }
    }
  }

  // --- evidence: DIFF against what the scan already has. A full replace cost
  // ~24 writes per site every sync (~25k/day) and blew the free-tier row-write
  // budget; unchanged rows must cost zero writes. evidenceRows counts actual
  // writes (inserts + updates + deletes) performed here.
  const currentByCheck = new Map(existingEvidence.map((r) => [r.check_id, r]));

  const wantedIds = new Set(wanted.map((w) => w.check_id));

  let evidenceRows = 0;
  for (const row of existingEvidence) {
    if (!wantedIds.has(row.check_id)) {
      await db.prepare('DELETE FROM evidence WHERE scan_id = ? AND check_id = ?').run(scanId, row.check_id);
      evidenceRows += 1;
    }
  }
  // New rows go in with one batched INSERT; rows whose values changed keep
  // their own UPDATE (rare — only an engine re-run changes a check).
  const inserts = wanted.filter((w) => !currentByCheck.has(w.check_id));
  if (inserts.length > 0) {
    evidenceRows += await insertEvidenceRows(db, scanId, inserts);
  }
  for (const w of wanted) {
    const cur = currentByCheck.get(w.check_id);
    if (!cur) continue;
    if (
      cur.status !== w.status ||
      cur.points !== w.points ||
      cur.max_points !== w.max_points ||
      cur.evidence_type !== w.evidence_type ||
      cur.evidence_ref !== w.evidence_ref
    ) {
      await db
        .prepare(
          `UPDATE evidence SET status = ?, points = ?, max_points = ?, evidence_type = ?, evidence_ref = ?
           WHERE scan_id = ? AND check_id = ?`,
        )
        .run(w.status, w.points, w.max_points, w.evidence_type, w.evidence_ref, scanId, w.check_id);
      evidenceRows += 1;
    }
  }

  // --- commit the skip key: only now that sites + scans + evidence for this
  // snapshot are fully written does it become safe for the next sync to skip
  // this path. One extra row write per fetched snapshot (not per re-sync).
  if (sha !== null) {
    await db.prepare('UPDATE scans SET snapshot_sha = ? WHERE id = ?').run(sha, scanId);
  }

  // siteChanged reflects the guarded write: an older snapshot that lost the
  // scanned_at race reports 0 (its scan + evidence rows still land).
  return { siteChanged: siteRun.changes > 0, evidenceRows };
}
