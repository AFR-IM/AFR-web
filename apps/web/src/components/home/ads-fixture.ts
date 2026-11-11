// Ad slot data (ad slots 1 and 2). Production ships EMPTY: a Sponsored block
// may only ever contain a real, paid, reviewed placement — synthetic samples
// must never render on the live site. Real payloads arrive with the ads system
// (SSOT: data repo /ads/active.json). The render path above stays in place so
// slots light up the moment real entries exist.

import { listSites } from '../../data/loader.ts';

export interface AdFixture {
  domain: string;
  headline: string;
  body: string;
  headlineZh?: string;
  bodyZh?: string;
}

export const ADS: AdFixture[] = [];

/** Ads whose domain exists in the current site list (so a real GradeRing can be shown). */
export function resolvableAds(): AdFixture[] {
  const domains = new Set(listSites().map((s) => s.domain));
  return ADS.filter((a) => domains.has(a.domain));
}
