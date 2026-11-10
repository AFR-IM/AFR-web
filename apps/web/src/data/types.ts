// @aiapp/web data layer types — derived from aiapp-data scan snapshots (spec §5.1:
// data repo JSON is the SSOT; Pages bakes /data/*.json at build time).

import type { Grade, StrategyTag } from '../../../../packages/shared/src/index.ts';

export type { Grade, StrategyTag };

/** Aggregated site row used by cards / leaderboard / detail header. */
export interface SiteCard {
  domain: string;
  title?: string;
  score: number;
  grade: Grade;
  strategyTag: StrategyTag;
  category?: string; // category slug (§7.1)
  tags?: string[]; // secondary tags (§7.2)
  lang?: string;
  rankSource?: number; // Tranco rank
  verified?: boolean;
  scannedAt: string; // ISO
}

export interface CategoryCount {
  slug: string;
  count: number;
}

export interface Distribution {
  A: number;
  B: number;
  C: number;
  D: number;
  F: number;
  unscanned?: number;
}

/** Payload for the homepage (P1). */
export interface HomeData {
  generatedAt: string;
  total: number;
  avgScore: number;
  distribution: Distribution;
  categories: CategoryCount[];
  /** top sites by score — natural ranking, pure AFR desc (red line) */
  leaderboard: SiteCard[];
  /** newest scans first */
  latest: SiteCard[];
}

/** Payload for a category page (P2). */
export interface CategoryData {
  slug: string;
  count: number;
  sites: SiteCard[]; // sorted by score desc by default
}

/** Check row inside the detail report card (P3). */
export interface SiteCheck {
  id: string;
  layer: 'L1' | 'L2' | 'L3';
  name: string; // English canonical name (packages/afr output)
  awarded: number;
  max: number;
  status: 'pass' | 'partial' | 'fail' | 'unknown';
  evidence?: { source: string; detail: string };
}

export interface SiteLayer {
  layer: 'L1' | 'L2' | 'L3';
  name: string;
  awarded: number;
  max: number;
  checks: SiteCheck[];
}

/** Full detail payload (P3). */
export interface SiteDetail extends SiteCard {
  engineVersion: string;
  scannerVersion: string;
  layers: SiteLayer[];
  breakdown: Record<string, number>;
  history: { date: string; score: number; grade: Grade }[];
  claim?: string; // published owner statement (§8.2)
}
