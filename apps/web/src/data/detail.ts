// @afr/web — the detail payload, built from a scan snapshot.
//
// One builder, two callers:
//   · the build (apps/web/scripts/fetch-data.mjs) writes src/data/generated/
//     details/<domain>.json — the OG cards and the sitemap read it;
//   · the runtime (src/data/runtime-detail.ts) builds the same payload when
//     a detail page is rendered on demand.
//
// The two must not drift: a detail page that is rendered on demand has to
// show exactly what the static one showed. So the shape lives here and
// nowhere else.
//
// This module is imported by a Node build script as well as by the Worker
// bundle, so it must not import anything Node cannot load — the delisted
// map is passed in by the caller.

import type { SiteDetail } from './types.ts';
import { categorize } from './categorize.mjs';
import { resolvePageLang, resolvePageMeta, resolvePageTitle } from '../../../../packages/scanner/src/page-meta.ts';

/** The map the build writes: domain → snapshot date (YYYY/MM/DD). */
export const SITE_PATHS_FILE = 'site-paths.json';

/** The public path of that map (the browser and the Worker read it here). */
export const SITE_PATHS_URL = '/data/site-paths.json';

/** The snapshot shape this builder reads (the data repo's JSON). */
export interface SnapshotLike {
  afr?: {
    domain?: string;
    score?: number;
    grade?: string;
    strategyTag?: string;
    engineVersion?: string;
    scannerVersion?: string;
    scannedAt?: string;
    layers?: SiteDetail['layers'];
    breakdown?: Record<string, number>;
  };
  signals?: { domain?: string; homepage?: unknown };
}

/** The delisted map: domain → the note shown on its retired page. */
export type DelistedMap = Record<string, { noteEn: string; noteZh: string }>;

/**
 * The detail payload of one snapshot.
 *
 * The title, the language and the category come out of the snapshot the
 * same way the site build derives them: the scanner's own fields first,
 * the homepage body as the fallback (packages/scanner/src/page-meta.ts).
 */
export function buildDetail(
  snapshot: SnapshotLike,
  fallbackDomain: string,
  delisted?: DelistedMap,
): SiteDetail | undefined {
  const afr = snapshot?.afr;
  if (!afr || typeof afr.score !== 'number' || !Array.isArray(afr.layers)) return undefined;
  const domain = afr.domain ?? snapshot?.signals?.domain ?? fallbackDomain;
  if (!domain) return undefined;
  const probe = snapshot?.signals?.homepage;
  const title = resolvePageTitle(probe);
  const lang = resolvePageLang(probe);
  const category = categorize(domain, title, resolvePageMeta(probe));

  const detail: SiteDetail = {
    domain,
    score: afr.score,
    grade: afr.grade as SiteDetail['grade'],
    strategyTag: afr.strategyTag as SiteDetail['strategyTag'],
    category,
    scannedAt: afr.scannedAt ?? '',
    engineVersion: afr.engineVersion ?? '',
    scannerVersion: afr.scannerVersion ?? '',
    layers: afr.layers,
    breakdown: afr.breakdown ?? {},
    history: [
      {
        date: String(afr.scannedAt ?? '').slice(0, 10),
        score: afr.score,
        grade: afr.grade as SiteDetail['grade'],
      },
    ],
  };
  // The optional fields keep the site build's key order (title and lang sit
  // right after the domain there) — the payload is compared byte for byte in
  // some places, so the order must not drift.
  const ordered = {
    domain: detail.domain,
    ...(title ? { title } : {}),
    score: detail.score,
    grade: detail.grade,
    strategyTag: detail.strategyTag,
    category: detail.category,
    ...(lang ? { lang } : {}),
    scannedAt: detail.scannedAt,
    ...(delisted?.[domain] ? { delistedNote: delisted[domain] } : {}),
    engineVersion: detail.engineVersion,
    scannerVersion: detail.scannerVersion,
    layers: detail.layers,
    breakdown: detail.breakdown,
    history: detail.history,
  };
  return ordered as SiteDetail;
}
