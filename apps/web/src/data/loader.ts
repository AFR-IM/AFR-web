// @aiapp/web data loader — build-time reads of the generated scan payloads.
//
// Data flow: scripts/fetch-data.mjs turns aiapp-data snapshots into
// src/data/generated/{index,home,categories}.json + details/*.json. This
// module serves them through static imports guarded by the manifest: when the
// generated directory is absent (fresh clone / pre-fetch build), every loader
// falls back to fixtures.ts so `npx astro build` still succeeds.

import type { CategoryData, HomeData, SiteCard, SiteDetail } from './types.ts';
import { FIXTURE_CATEGORIES, FIXTURE_HOME, FIXTURE_DETAILS } from './fixtures.ts';

/** Manifest written by fetch-data.mjs — the availability gate for generated data. */
interface GeneratedManifest {
  date: string;
  sites: number;
  scored: number;
  pending: number;
}

type JsonModule<T> = { default: T };

// Static import graph (Vite): resolves to {} when generated/ does not exist,
// so no dynamic fs access and no build failure pre-fetch.
const generatedModules = import.meta.glob('./generated/*.json', { eager: true }) as Record<
  string,
  JsonModule<unknown>
>;
const detailModules = import.meta.glob('./generated/details/*.json', { eager: true }) as Record<
  string,
  JsonModule<SiteDetail>
>;

function readGenerated<T>(store: Record<string, JsonModule<unknown>>, key: string): T | undefined {
  return (store[key] as JsonModule<T> | undefined)?.default;
}

const manifest = readGenerated<GeneratedManifest>(generatedModules, './generated/index.json');
const generatedHome = readGenerated<HomeData>(generatedModules, './generated/home.json');
const generatedCategories = readGenerated<Record<string, SiteCard[]>>(
  generatedModules,
  './generated/categories.json',
);

/** All three payloads present → generated data is complete enough to serve. */
const generated: { manifest: GeneratedManifest; home: HomeData; categories: Record<string, SiteCard[]> } | null =
  manifest && generatedHome && generatedCategories
    ? { manifest, home: generatedHome, categories: generatedCategories }
    : null;

/** Scored-only cards (pending sites are never listed), score desc. */
const generatedScored: SiteCard[] | null = generated
  ? Object.values(generated.categories)
      .flat()
      .sort((a, b) => b.score - a.score || a.domain.localeCompare(b.domain))
  : null;

/** Site payload for the homepage (P1). */
export function loadHome(): HomeData {
  return generated?.home ?? FIXTURE_HOME;
}

/** Rated sites only — search page pre-render and card lists. */
export function listSites(): SiteCard[] {
  if (generated && generatedScored) return generatedScored;
  return FIXTURE_HOME.leaderboard;
}

/** Scored + pending sites — detail routes need pages for unratable sites too. */
export function listAllSites(): SiteCard[] {
  if (generated) return Object.values(detailModules).map((m) => m.default);
  // Fixtures: every fixture card gets a route; loadSite() fills in the ones
  // with a full snapshot, the rest render the "pending scan" fallback.
  return FIXTURE_HOME.leaderboard;
}

export function loadCategory(slug: string): CategoryData | undefined {
  if (generated) {
    const sites = generated.categories[slug];
    if (!sites) return undefined;
    return { slug, count: sites.length, sites };
  }
  const sites = FIXTURE_HOME.leaderboard.filter((s) => s.category === slug);
  if (sites.length === 0 && !FIXTURE_CATEGORIES.some((c) => c.slug === slug)) return undefined;
  return { slug, count: sites.length, sites };
}

export function listCategories(): { slug: string; count: number }[] {
  if (generated) return generated.home.categories;
  return FIXTURE_HOME.categories;
}

/** Full detail payload (scored AND pending) for one domain. */
export function loadSite(domain: string): SiteDetail | undefined {
  if (generated) return detailModules[`./generated/details/${domain}.json`]?.default;
  return FIXTURE_DETAILS.find((d) => d.domain === domain);
}
