// src/d1-sync.ts — pull daily scan snapshots from the AFR-data repository and
// upsert them into D1 (sites / scans / evidence).
//
// SSOT layout: https://raw.githubusercontent.com/AFR-IM/AFR-data/main/scans/YYYY/MM/DD/<domain>.json
// Each snapshot is `{ signals, afr }` (packages/scanner output + packages/afr result).
// Both `fetch` and `db` are injected so the logic is fully testable offline
// (test/d1-sync.test.ts fakes the GitHub contents listing + raw file fetches).

import type { AfrResult, CheckResult, ScanSignals } from '../../../packages/shared/src/index.ts';
import type { Db } from './db.ts';

export const DATA_REPO_API = 'https://api.github.com/repos/AFR-IM/AFR-data/contents';
export const DATA_REPO_RAW = 'https://raw.githubusercontent.com/AFR-IM/AFR-data/main';

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

export interface SyncResult {
  date: string;
  /** Snapshot paths discovered from the repo directory listing */
  listed: number;
  /** Sites updated (upsert is idempotent: re-running the same date does not duplicate) */
  sitesUpserted: number;
  scansUpserted: number;
  evidenceRows: number;
  errors: SyncError[];
}

const DATE_RE = /^\d{4}\/\d{2}\/\d{2}$/;

interface ContentEntry {
  name: string;
  path: string;
  type: string;
}

/** Validate the YYYY/MM/DD date segment and return the listing URL */
export function listingUrl(date: string): string {
  if (!DATE_RE.test(date)) throw new Error(`invalid date "${date}" (expected YYYY/MM/DD)`);
  return `${DATA_REPO_API}/scans/${date}`;
}

export function snapshotUrl(path: string): string {
  return `${DATA_REPO_RAW}/${path}`;
}

/** Fetch the day's directory listing and upsert every `*.json` snapshot */
export async function syncDate(date: string, deps: SyncDeps): Promise<SyncResult> {
  const result: SyncResult = {
    date,
    listed: 0,
    sitesUpserted: 0,
    scansUpserted: 0,
    evidenceRows: 0,
    errors: [],
  };

  const listingRes = await deps.fetchImpl(listingUrl(date));
  if (!listingRes.ok) {
    throw new Error(`snapshot listing failed: HTTP ${listingRes.status}`);
  }
  const entries = (await listingRes.json()) as ContentEntry[];
  const paths = entries
    .filter((e) => e.type === 'file' && e.path.endsWith('.json'))
    .map((e) => e.path)
    .sort();
  result.listed = paths.length;

  for (const path of paths) {
    try {
      const res = await deps.fetchImpl(snapshotUrl(path));
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const snapshot = (await res.json()) as Snapshot;
      const stats = await upsertSnapshot(deps.db, snapshot, path);
      result.sitesUpserted += stats.siteChanged ? 1 : 0;
      result.scansUpserted += 1;
      result.evidenceRows += stats.evidenceRows;
    } catch (err) {
      result.errors.push({ path, message: err instanceof Error ? err.message : String(err) });
    }
  }

  return result;
}

export interface UpsertStats {
  siteChanged: boolean;
  evidenceRows: number;
}

/** Upsert one snapshot: site row (scores/grade/status) + its scan + evidence rows.
 * Re-syncing the same snapshot path updates in place (keyed on scans.snapshot_path)
 * and replaces that scan's evidence — no duplicate rows. */
export async function upsertSnapshot(db: Db, snapshot: Snapshot, path: string): Promise<UpsertStats> {
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
  await db
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
         scanned_at = excluded.scanned_at`,
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

  // --- scans: one row per snapshot path (idempotent re-sync)
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

  // --- evidence: replace the scan's rows (fresh snapshot = fresh evidence chain)
  await db.prepare('DELETE FROM evidence WHERE scan_id = ?').run(scanId);

  let evidenceRows = 0;
  for (const layer of afr.layers) {
    for (const check of layer.checks as CheckResult[]) {
      await db
        .prepare(
          `INSERT INTO evidence (scan_id, check_id, status, points, max_points, evidence_type, evidence_ref)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          scanId,
          check.id,
          check.status ?? null,
          check.awarded ?? null,
          check.max ?? null,
          check.evidence?.source ?? null,
          // Snapshot-local excerpt (spec wants a snapshot path or excerpt hash;
          // the detail text is the excerpt until hash referencing lands)
          check.evidence?.detail ?? null,
        );
      evidenceRows += 1;
    }
  }

  return { siteChanged: true, evidenceRows };
}
