// @aiapp/afr — AFR scoring engine entry point (pure functions, spec §3)
// Input: ScanSignals (produced by the scanner); output: AfrResult.
// No IO, no clock — third parties can recompute every score.
// Implementation is the standard: this package's code plus the bilingual /method page
// full text are the source of truth for scoring facts (spec §3).

import {
  GRADE_THRESHOLDS,
  type AfrResult,
  type CheckResult,
  type Grade,
  type ScanSignals,
} from '../../shared/src/index.ts';
import { scoreL1 } from './l1.ts';
import { scoreL2 } from './l2.ts';
import { scoreL3 } from './l3.ts';
import { evaluateRobotsPolicy, parseRobots, type RobotsTxt } from './robots.ts';

export const ENGINE_VERSION = 'afr-1.0.0';

export function gradeFor(score: number): Grade {
  for (const t of GRADE_THRESHOLDS) {
    if (score >= t.min) return t.grade;
  }
  return 'F';
}

/** Main entry: signals → AFR result */
export function scoreAfr(signals: ScanSignals): AfrResult {
  const rp = signals.robots;
  const robotsReachable = !!rp && !rp.error && rp.status !== undefined;
  let robotsTxt: RobotsTxt | null = null;
  if (robotsReachable && rp!.status! >= 200 && rp!.status! < 300) {
    robotsTxt = parseRobots(rp!.body ?? '');
  }
  // 404 / no robots.txt → robotsTxt = null, reachable = true (scored as unconfigured, 0.5)
  // network error → reachable = false (all unknown, 0 points — no penalty, no reward)
  const robotsEval = evaluateRobotsPolicy(robotsTxt, robotsReachable);

  const layers = [scoreL1(signals, robotsEval), scoreL2(signals), scoreL3(signals)];
  const total = Math.round((layers[0]!.awarded + layers[1]!.awarded + layers[2]!.awarded) * 100) / 100;
  const score = Math.round(total);

  const breakdown: Record<string, number> = {};
  for (const layer of layers) {
    for (const c of layer.checks) breakdown[c.id] = c.awarded;
  }

  return {
    domain: signals.domain,
    engineVersion: ENGINE_VERSION,
    scannerVersion: signals.scannerVersion,
    scannedAt: signals.fetchedAt,
    score,
    grade: gradeFor(score),
    strategyTag: robotsEval.tag,
    layers,
    breakdown,
  };
}

/** Evidence-chain completeness self-check (used by tests and /method): points require evidence */
export function evidenceGaps(result: AfrResult): string[] {
  const gaps: string[] = [];
  for (const layer of result.layers) {
    for (const c of layer.checks as CheckResult[]) {
      if (c.awarded > 0 && !c.evidence) gaps.push(c.id);
      if (c.awarded > c.max) gaps.push(`${c.id}: awarded > max`);
    }
  }
  return gaps;
}

export { parseRobots, evaluateRobotsPolicy } from './robots.ts';
export { AI_UAS, FAMILY_MAX } from './ua.ts';
export { wordCount, jsonLdBlocks, visibleText } from './l2.ts';
