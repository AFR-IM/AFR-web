// @aiapp/afr — AFR 评分引擎入口（纯函数，方案书 §3）
// 输入 ScanSignals（scanner 产出），输出 AfrResult；无 IO、无时钟，第三方可复算。
// 实施即标准：本包代码 + /method 页双语全文为评分事实源（方案书 §3）。

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

/** 主入口: signals → AFR 结果 */
export function scoreAfr(signals: ScanSignals): AfrResult {
  const rp = signals.robots;
  const robotsReachable = !!rp && !rp.error && rp.status !== undefined;
  let robotsTxt: RobotsTxt | null = null;
  if (robotsReachable && rp!.status! >= 200 && rp!.status! < 300) {
    robotsTxt = parseRobots(rp!.body ?? '');
  }
  // 404/无 robots.txt → robotsTxt = null, reachable = true（按未配置 0.5 计）
  // 网络错误 → reachable = false（全部 unknown，0 分不奖不罚）
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

/** 证据链完整性自检（测试与 /method 用）: 有分必有证据 */
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
