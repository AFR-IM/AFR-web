// @aiapp/shared — Type definitions (shared by scanner / afr / worker / web)
// Design spec §5.3 repository structure; this package contains only types and constants,
// with zero runtime dependencies.

export type Grade = 'A' | 'B' | 'C' | 'D' | 'F';

/** Site rating states beyond the five grades (spec §3.5): Pending = no evaluable evidence */
export type GradeState = Grade | 'Pending';

/** Scan outcome: 'scored' = homepage evidence obtained; 'pending' = no evaluable homepage (spec Q2 calibration) */
export type ScanState = 'scored' | 'pending';

export type StrategyTag =
  | 'AI-Open'
  | 'Middle-Path'
  | 'Training-Open'
  | 'AI-Closed'
  | 'Unconfigured';

export type CheckStatus = 'pass' | 'partial' | 'fail' | 'unknown';

export type LayerId = 'L1' | 'L2' | 'L3';

/** Evidence chain backing every awarded point (spec §3: every point has an evidence chain) */
export interface Evidence {
  /** Evidence source, e.g. "robots.txt" / "homepage HTML" / "GET /llms.txt" */
  source: string;
  /** Human-readable justification, e.g. "UA GPTBot matched group line 3 Disallow: /" */
  detail: string;
}

/** Result of a single check item */
export interface CheckResult {
  id: string;
  layer: LayerId;
  /** English display name (localized text will come from language packs) */
  name: string;
  awarded: number;
  max: number;
  status: CheckStatus;
  evidence?: Evidence;
}

/** Score of a single layer (L1 35 / L2 40 / L3 25) */
export interface LayerScore {
  layer: LayerId;
  /** English display name: Reachability / Comprehensibility / Interactivity */
  name: string;
  awarded: number;
  max: number;
  checks: CheckResult[];
}

/** AFR scoring result (pure-function output, recomputable) */
export interface AfrResult {
  domain: string;
  engineVersion: string;
  scannerVersion: string;
  scannedAt: string;
  /** 0–100, rounded to an integer */
  score: number;
  /** 'Pending' when state === 'pending' (no evaluable homepage evidence; excluded from ranking) */
  grade: GradeState;
  /** scored = full evidence available; pending = homepage unreachable/challenged with no fallback content */
  state: ScanState;
  strategyTag: StrategyTag;
  layers: LayerScore[];
  /** checkId -> awarded, convenient for diffs and incremental notifications */
  breakdown: Record<string, number>;
}

/** Result of a single HTTP probe (produced by the scanner; the engine only reads, never requests) */
export interface HttpProbe {
  /** Final response status code; undefined on network failure */
  status?: number;
  body?: string;
  headers?: Record<string, string>;
  /** Original network/timeout error text; when present the probe counts as unknown */
  error?: string;
  /** Actual final URL (after redirects) */
  url?: string;
  /** Challenge fallback: status code returned when the transparent UA was challenged (401/403/429/503);
   *  L1 scores no technical wall as 0 based on this */
  challengedStatus?: number;
  /** Body was re-fetched with a browser UA fallback (transparent UA was challenged);
   *  used by L2/L3 content checks */
  uaFallback?: boolean;
}

export interface OpenApiProbe {
  probed: boolean;
  found: boolean;
  urls?: string[];
}

export interface McpProbe {
  probed: boolean;
  found: boolean;
  urls?: string[];
}

export interface AiFeatures {
  chatWidget?: boolean;
  aiSearch?: boolean;
  developerConsole?: boolean;
}

/**
 * Scan signal input — output of the scanner's ≤8 public GETs (spec §4).
 * The engine is a pure function: it only reads signals, never issues requests and never reads
 * the clock (scannedAt comes from signals.fetchedAt).
 */
export interface ScanSignals {
  domain: string;
  fetchedAt: string;
  scannerVersion: string;
  /** GET /robots.txt */
  robots?: HttpProbe;
  /** GET /llms.txt */
  llms?: HttpProbe;
  /** GET /llms-full.txt */
  llmsFull?: HttpProbe;
  /** GET / homepage HTML */
  homepage?: HttpProbe;
  /** GET /sitemap.xml */
  sitemap?: HttpProbe;
  /** GET /agents.md (falls back to /AGENTS.md; the scanner merges both into one probe) */
  agentsMd?: HttpProbe;
  /** GET /ai.txt or /.well-known/ai.txt (optional 8th probe) */
  aiTxt?: HttpProbe;
  openapi?: OpenApiProbe;
  apiDocs?: { found: boolean; urls?: string[] };
  mcp?: McpProbe;
  aiFeatures?: AiFeatures;
}

/** Grade thresholds (spec §3.5, calibrated against the first Tranco Top1000
 * scan 2026-11-10 — decision T2; see docs/calibration/first-scan-2026-11-10.md) */
export const GRADE_THRESHOLDS: { min: number; grade: Grade }[] = [
  { min: 75, grade: 'A' },
  { min: 60, grade: 'B' },
  { min: 42, grade: 'C' },
  { min: 25, grade: 'D' },
  { min: 0, grade: 'F' },
];

/** Layer max points (spec §3: 100 = 35 + 40 + 25) */
export const LAYER_MAX = { L1: 35, L2: 40, L3: 25 } as const;
