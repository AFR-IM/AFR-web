// @afr/web — the detail page, rendered on demand.
//
// Why
//   A static detail page per site does not scale: the Worker Free plan
//   allows 20,000 asset files per version, and the bilingual detail pages
//   already cost two files per domain. The catalog was about to outgrow
//   that, and the catalog is the product.
//
//   So the detail page is rendered when it is asked for. The data is the
//   same snapshot the static build used — the data repo's JSON is the SSOT
//   (SSOT item 20: "详情页按需生成 … 静态只保留榜单/分类首页").
//
// How
//   · The build writes one map: public/data/site-paths.json — the newest
//     snapshot date per domain (the same merge rule as the site build:
//     the newest date directory wins).
//   · The map is fetched through the ASSETS binding (no network hop) and
//     kept in the isolate's memory.
//   · The snapshot itself is fetched from the data repo's raw endpoint and
//     kept in the Workers cache, so a page view does not hit GitHub twice.
//
//   Everything the page shows comes out of that one snapshot, so an
//   on-demand page is byte-for-byte the page the static build would have
//   written (see src/data/detail.ts — the one builder both use).

import type { SiteDetail } from './types.ts';
import { SITE_PATHS_URL, buildDetail } from './detail.ts';
import DELISTED from './delisted.json';

/** The data repo's raw endpoint (the SSOT layout). */
export const DATA_REPO_RAW = 'https://raw.githubusercontent.com/AFR-IM/AFR-data/main';

/** The map the build writes: domain → snapshot date (YYYY/MM/DD). */
export { SITE_PATHS_URL };

/** The minimum Cloudflare runtime shape this module needs. */
export interface RuntimeLike {
  env?: Record<string, unknown>;
  caches?: { default?: Cache };
}

/** domain → snapshot date. Kept per isolate — it only changes with a deploy. */
let pathMap: Record<string, string> | null = null;
let pathMapPromise: Promise<Record<string, string>> | null = null;

/** The snapshot cache: the same URL for a day, fetched once. */
const snapshotCache = new Map<string, { at: number; detail?: SiteDetail }>();
const SNAPSHOT_TTL_MS = 10 * 60 * 1000;

/** A slow upstream must not hang a page: give up and serve the fallback. */
const SNAPSHOT_TIMEOUT_MS = 5000;

/** Fetch a JSON payload, tolerating a missing binding (dev, fixtures). */
async function fetchJson(url: string, init?: RequestInit): Promise<unknown> {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(SNAPSHOT_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`http ${res.status}`);
  return res.json();
}

/**
 * The domain → snapshot-date map.
 *
 * Read through the ASSETS binding when it is there (the asset is part of
 * the same deployment, so this costs no network request), and over HTTP
 * otherwise (a preview deployment without the binding).
 */
export async function loadPathMap(
  runtime: RuntimeLike | undefined,
  origin = 'https://afr.im',
): Promise<Record<string, string>> {
  if (pathMap) return pathMap;
  if (!pathMapPromise) {
    pathMapPromise = (async () => {
      const path = SITE_PATHS_URL;
      const assets = runtime?.env?.ASSETS as
        | { fetch?: (req: Request) => Promise<Response> }
        | undefined;
      let map: Record<string, string> | null = null;
      if (assets?.fetch) {
        try {
          // the binding serves the asset itself — no network hop
          const res = await assets.fetch(new Request(new URL(path, origin)));
          if (res.ok) map = (await res.json()) as Record<string, string>;
        } catch {
          map = null;
        }
      }
      if (!map) {
        try {
          map = (await fetchJson(new URL(path, origin).toString())) as Record<string, string>;
        } catch {
          map = null;
        }
      }
      const out = map ?? {};
      pathMap = out;
      return out;
    })().finally(() => {
      pathMapPromise = null;
    });
  }
  return pathMapPromise;
}

/** The snapshot of one domain, from the data repo. */
async function loadSnapshot(
  domain: string,
  date: string,
  runtime: RuntimeLike | undefined,
): Promise<SiteDetail | undefined> {
  const url = `${DATA_REPO_RAW}/scans/${date}/${domain}.json`;
  const hit = snapshotCache.get(url);
  if (hit && Date.now() - hit.at < SNAPSHOT_TTL_MS) return hit.detail;

  // The Workers cache is shared by every isolate: the second visitor of a
  // page does not wait for the data repo again.
  const edge = runtime?.caches?.default;
  let detail: SiteDetail | undefined;
  if (edge) {
    try {
      const cached = await edge.match(url);
      if (cached) {
        const raw = (await cached.json()) as Parameters<typeof buildDetail>[0];
        detail = buildDetail(raw, domain, DELISTED as Record<string, { noteEn: string; noteZh: string }>);
      }
    } catch {
      detail = undefined;
    }
  }
  if (!detail) {
    try {
      const raw = (await fetchJson(url)) as Parameters<typeof buildDetail>[0];
      detail = buildDetail(raw, domain, DELISTED as Record<string, { noteEn: string; noteZh: string }>);
      if (edge && detail) {
        try {
          await edge.put(url, new Response(JSON.stringify(raw), { headers: { 'content-type': 'application/json' } }));
        } catch {
          /* the cache is an optimisation, never a requirement */
        }
      }
    } catch {
      detail = undefined;
    }
  }
  snapshotCache.set(url, { at: Date.now(), detail });
  // Keep the map small — the catalog is large and the entries expire anyway.
  if (snapshotCache.size > 500) {
    const oldest = [...snapshotCache.entries()].sort((a, b) => a[1].at - b[1].at)[0];
    if (oldest) snapshotCache.delete(oldest[0]);
  }
  return detail;
}

/**
 * The detail payload of one domain, rendered on demand.
 *
 * Returns undefined when the domain is not in the catalog (the caller
 * answers 404) — the same answer the static build gave for a domain it
 * never generated a page for.
 */
export async function loadRuntimeDetail(
  domain: string,
  runtime: RuntimeLike | undefined,
  origin = 'https://afr.im',
): Promise<SiteDetail | undefined> {
  if (!domain) return undefined;
  const map = await loadPathMap(runtime, origin);
  const date = map[domain];
  if (!date) return undefined;
  return loadSnapshot(domain, date, runtime);
}
