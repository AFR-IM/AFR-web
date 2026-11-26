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
import { CATEGORY_SLUGS, categorize } from './categorize.mjs';
import { resolvePageLang, resolvePageMeta, resolvePageTitle } from '../../../../packages/scanner/src/page-meta.ts';

/** The map the build writes: domain → snapshot date (YYYY/MM/DD). */
export const SITE_PATHS_FILE = 'site-paths.json';

/** The public path of that map (the browser and the Worker read it here). */
export const SITE_PATHS_URL = '/data/site-paths.json';

/** The map the build writes: the manual category labels (domain → slug). */
export const CATEGORY_OVERRIDES_FILE = 'category-overrides.json';

/** The map the build writes: published owner statements (domain → text). */
export const CLAIMS_FILE = 'claims.json';

/** The public path of that map (the Worker reads it here). */
export const CLAIMS_URL = '/data/claims.json';

/**
 * What a category slug must look like to be used as a category key.
 *
 * A slug ends up in a URL and in a payload, so only the conservative shape
 * is accepted: lower case letters, digits and dashes. Anything else is
 * ignored — an override is data, not markup.
 */
export const CATEGORY_SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** The manual category labels: domain → category slug. */
export type CategoryOverrideMap = Record<string, string>;

/** Published owner statements: domain → statement text. */
export type ClaimMap = Record<string, string>;

/** A domain key may appear in a payload: bare host, conservative shape. */
const CLAIM_DOMAIN_PATTERN = /^[a-z0-9]([a-z0-9.-]{0,118}[a-z0-9])?$/;

/**
 * Keep the usable entries of a raw claims payload.
 *
 * The payload comes from an HTTP endpoint, so it is treated as data: only
 * safe domain keys with a bounded statement survive. The bound is the Pro
 * statement ceiling — a longer entry is dropped rather than truncated,
 * because a cut-off statement is not the statement that was reviewed.
 */
export function sanitizeClaims(raw: unknown): ClaimMap {
  const out: ClaimMap = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof key !== 'string' || typeof value !== 'string') continue;
    const domain = key.trim().toLowerCase();
    const statement = value.trim();
    if (!domain || !CLAIM_DOMAIN_PATTERN.test(domain)) continue;
    if (statement.length < 1 || statement.length > 600) continue;
    out[domain] = statement;
  }
  return out;
}

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
 * Keep the usable entries of a raw override payload.
 *
 * The payload comes from an HTTP endpoint, so it is treated as data: only
 * string domains with a safe slug survive. A malformed entry is dropped
 * rather than guessed at.
 */
export function sanitizeCategoryOverrides(raw: unknown): CategoryOverrideMap {
  const out: CategoryOverrideMap = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof key !== 'string' || typeof value !== 'string') continue;
    const domain = key.trim().toLowerCase();
    const slug = value.trim();
    if (!domain || !CATEGORY_SLUG_PATTERN.test(slug)) continue;
    out[domain] = slug;
  }
  return out;
}

/** The 14 product categories. A label outside this set names no category
 * page, so it would render a chip that links to a 404. */
export const KNOWN_CATEGORY_SLUGS: ReadonlySet<string> = new Set(CATEGORY_SLUGS);

/**
 * The category of one site: the manual label when there is one, the
 * heuristic result otherwise.
 *
 * The manual label wins — it is the human decision about a site the
 * heuristic could not read. A label that is not a safe slug, or that names
 * no category page, is ignored, so a bad payload can never put a broken
 * link into a page.
 */
export function resolveCategorySlug(
  domain: string,
  heuristic: string,
  overrides?: CategoryOverrideMap,
): string {
  const raw = overrides?.[domain] ?? (domain ? overrides?.[domain.toLowerCase()] : undefined);
  if (typeof raw !== 'string') return heuristic;
  const slug = raw.trim();
  if (!CATEGORY_SLUG_PATTERN.test(slug) || !KNOWN_CATEGORY_SLUGS.has(slug)) return heuristic;
  return slug;
}

/**
 * The detail payload of one snapshot.
 *
 * The title, the language and the category come out of the snapshot the
 * same way the site build derives them: the scanner's own fields first,
 * the homepage body as the fallback (packages/scanner/src/page-meta.ts).
 * The category is the heuristic's answer unless a manual label overrides
 * it — the same label the API and the badge show.
 */
export function buildDetail(
  snapshot: SnapshotLike,
  fallbackDomain: string,
  delisted?: DelistedMap,
  overrides?: CategoryOverrideMap,
  claims?: ClaimMap,
): SiteDetail | undefined {
  const afr = snapshot?.afr;
  if (!afr || typeof afr.score !== 'number' || !Array.isArray(afr.layers)) return undefined;
  const domain = afr.domain ?? snapshot?.signals?.domain ?? fallbackDomain;
  if (!domain) return undefined;
  const probe = snapshot?.signals?.homepage;
  const title = resolvePageTitle(probe);
  const lang = resolvePageLang(probe);
  const category = resolveCategorySlug(
    domain,
    categorize(domain, title, resolvePageMeta(probe)),
    overrides,
  );

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
    ...(claims?.[domain] ? { claim: claims[domain] } : {}),
    engineVersion: detail.engineVersion,
    scannerVersion: detail.scannerVersion,
    layers: detail.layers,
    breakdown: detail.breakdown,
    history: detail.history,
  };
  return ordered as SiteDetail;
}
