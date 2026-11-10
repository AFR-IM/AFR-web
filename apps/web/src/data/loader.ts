// @aiapp/web data loader — build-time reads of /data payloads (spec §5.1).
// M2 NOTE: the first Tranco scan lands in aiapp-data; until the fetch script
// (scripts/fetch-data.mjs) generates src/data/generated/, this loader serves
// fixture data so every page can be built and reviewed against real layout.

import type { CategoryData, HomeData, SiteCard, SiteDetail } from './types.ts';
import { FIXTURE_CATEGORIES, FIXTURE_HOME, FIXTURE_DETAILS } from './fixtures.ts';

export function loadHome(): HomeData {
  return FIXTURE_HOME;
}

export function listSites(): SiteCard[] {
  return FIXTURE_HOME.leaderboard;
}

export function loadCategory(slug: string): CategoryData | undefined {
  const sites = listSites().filter((s) => s.category === slug);
  if (sites.length === 0 && !FIXTURE_CATEGORIES.some((c) => c.slug === slug)) return undefined;
  return { slug, count: sites.length, sites };
}

export function listCategories(): { slug: string; count: number }[] {
  return FIXTURE_HOME.categories;
}

export function loadSite(domain: string): SiteDetail | undefined {
  return FIXTURE_DETAILS.find((d) => d.domain === domain);
}
