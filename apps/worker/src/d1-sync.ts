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

import type { AfrResult, CheckResult, ScanSignals } from '../../../packages/shared/src/index.ts';
import type { Db } from './db.ts';

export const DATA_REPO_API = 'https://api.github.com/repos/AFR-IM/AFR-data/contents';
export const DATA_REPO_TREES = 'https://api.github.com/repos/AFR-IM/AFR-data/git/trees';
export const DATA_REPO_RAW = 'https://raw.githubusercontent.com/AFR-IM/AFR-data/main';

/** Max snapshot fetches per invocation: 3 dir listings (cron path) + 1 trees
 * listing + 44 raw fetches = 48 ≤ the ~50 subrequest free-plan cap. */
export const DEFAULT_SYNC_LIMIT = 44;

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

/** Fetch the day's trees listing and upsert the snapshots at `[offset,
 * offset+limit)` whose git sha is not already in D1. Skips are free; only
 * actual fetches consume the per-invocation subrequest budget. */
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

  // One indexed range read over idx_scans_snapshot: every snapshot of this
  // date already in D1 plus its stored sha (upper bound = prefix with the
  // trailing '/' bumped, i.e. 'scans/2026/11/130' for prefix '…/11/13/').
  const upper = `${prefix.slice(0, -1)}0`;
  const knownRows = await deps.db
    .prepare('SELECT snapshot_path, snapshot_sha FROM scans WHERE snapshot_path >= ? AND snapshot_path < ?')
    .all<{ snapshot_path: string; snapshot_sha: string | null }>(prefix, upper);
  const known = new Map(knownRows.map((r) => [r.snapshot_path, r.snapshot_sha]));

  let fetches = 0;
  let i = offset;
  for (; i < entries.length; i++) {
    const entry = entries[i];
    if (!entry) continue;
    const { path, sha } = entry;
    if (known.get(path) === sha) {
      result.skipped += 1;
      continue;
    }
    if (fetches >= limit) break; // budget spent before processing entries[i]
    fetches += 1;
    try {
      const res = await deps.fetchImpl(snapshotUrl(path));
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const snapshot = (await res.json()) as Snapshot;
      const stats = await upsertSnapshot(deps.db, snapshot, path, sha);
      result.sitesUpserted += stats.siteChanged ? 1 : 0;
      result.scansUpserted += 1;
      result.evidenceRows += stats.evidenceRows;
    } catch (err) {
      result.errors.push({ path, message: err instanceof Error ? err.message : String(err) });
    }
  }
  result.nextOffset = i < entries.length ? i : null;

  return result;
}

export interface UpsertStats {
  siteChanged: boolean;
  evidenceRows: number;
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
    .prepare('SELECT id FROM scans WHERE snapshot_path = ?')
    .get<{ id: number }>(path);

  let scanId: number;
  if (existing) {
    scanId = existing.id;
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

  // --- evidence: DIFF against what the scan already has. A full replace cost
  // ~24 writes per site every sync (~25k/day) and blew the free-tier row-write
  // budget; unchanged rows must cost zero writes. evidenceRows counts actual
  // writes (inserts + updates + deletes) performed here.
  const existingEvidence = await db
    .prepare(
      `SELECT check_id, status, points, max_points, evidence_type, evidence_ref
       FROM evidence WHERE scan_id = ?`,
    )
    .all<{
      check_id: string;
      status: string | null;
      points: number | null;
      max_points: number | null;
      evidence_type: string | null;
      evidence_ref: string | null;
    }>(scanId);
  const currentByCheck = new Map(existingEvidence.map((r) => [r.check_id, r]));

  interface WantedRow {
    check_id: string;
    status: string | null;
    points: number | null;
    max_points: number | null;
    evidence_type: string | null;
    evidence_ref: string | null;
  }
  const wanted: WantedRow[] = (afr.layers.flatMap((l) => l.checks) as CheckResult[]).map((c) => ({
    check_id: c.id,
    status: c.status ?? null,
    points: c.awarded ?? null,
    max_points: c.max ?? null,
    evidence_type: c.evidence?.source ?? null,
    // Snapshot-local excerpt (spec wants a snapshot path or excerpt hash;
    // the detail text is the excerpt until hash referencing lands)
    evidence_ref: c.evidence?.detail ?? null,
  }));
  const wantedIds = new Set(wanted.map((w) => w.check_id));

  let evidenceRows = 0;
  for (const row of existingEvidence) {
    if (!wantedIds.has(row.check_id)) {
      await db.prepare('DELETE FROM evidence WHERE scan_id = ? AND check_id = ?').run(scanId, row.check_id);
      evidenceRows += 1;
    }
  }
  for (const w of wanted) {
    const cur = currentByCheck.get(w.check_id);
    if (!cur) {
      await db
        .prepare(
          `INSERT INTO evidence (scan_id, check_id, status, points, max_points, evidence_type, evidence_ref)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(scanId, w.check_id, w.status, w.points, w.max_points, w.evidence_type, w.evidence_ref);
      evidenceRows += 1;
      continue;
    }
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
