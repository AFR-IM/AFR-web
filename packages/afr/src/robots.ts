// robots.txt 解析与 AI UA 政策评估（纯函数）
// 语义遵循 robots.txt 标准: 最长 UA 匹配优先、路径最长匹配优先、同长 Allow 优先、空 Disallow 忽略。

import { AI_UAS, FAMILY_MAX, type UaFamily } from './ua.ts';

export interface RobotsRule {
  allow: boolean;
  path: string;
}

export interface RobotsGroup {
  agents: string[];
  rules: RobotsRule[];
}

export interface RobotsTxt {
  groups: RobotsGroup[];
  sitemaps: string[];
  crawlDelays: string[];
}

/** 解析 robots.txt 全文。容错: 注释、空行、缺冒号行、重复字段。 */
export function parseRobots(text: string): RobotsTxt {
  const groups: RobotsGroup[] = [];
  const sitemaps: string[] = [];
  const crawlDelays: string[] = [];
  let agents: string[] = [];
  let rules: RobotsRule[] = [];
  let sawRule = false;

  const flush = () => {
    if (agents.length > 0) groups.push({ agents, rules });
    agents = [];
    rules = [];
    sawRule = false;
  };

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, '').trim();
    if (!line) continue;
    const idx = line.indexOf(':');
    if (idx < 0) continue;
    const field = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    switch (field) {
      case 'user-agent':
        // 新 UA 行出现在规则之后 → 开新组
        if (sawRule) flush();
        if (value) agents.push(value.toLowerCase());
        break;
      case 'allow':
      case 'disallow':
        if (!agents.length) break; // 规则出现在任何 UA 之前 → 忽略
        sawRule = true;
        // 空路径 = 无限制，按标准忽略
        if (value === '') break;
        rules.push({ allow: field === 'allow', path: value });
        break;
      case 'sitemap':
        if (value) sitemaps.push(value);
        break;
      case 'crawl-delay':
        if (value) crawlDelays.push(value);
        break;
      default:
        break;
    }
  }
  flush();
  return { groups, sitemaps, crawlDelays };
}

/** 为指定 UA 选择最匹配的组（最长 token 优先；'*' 仅作通配兜底）。返回 [组, 是否通配]。 */
export function matchGroup(
  robots: RobotsTxt,
  uaToken: string,
): { group: RobotsGroup; wildcard: boolean } | undefined {
  const ua = uaToken.toLowerCase();
  let best: { group: RobotsGroup; len: number } | undefined;
  let wildcard: { group: RobotsGroup } | undefined;
  for (const group of robots.groups) {
    for (const token of group.agents) {
      if (token === '*') {
        wildcard ??= { group };
        continue;
      }
      if (ua.startsWith(token) && (!best || token.length > best.len)) {
        best = { group, len: token.length };
      }
    }
  }
  if (best) return { group: best.group, wildcard: false };
  if (wildcard) return { group: wildcard.group, wildcard: true };
  return undefined;
}

/** 对路径（默认 "/"）做规则裁决: 'allowed' | 'blocked' | 'default-allow' */
export function decidePath(group: RobotsGroup, path: string): 'allowed' | 'blocked' | 'default-allow' {
  let best: { allow: boolean; len: number } | undefined;
  for (const rule of group.rules) {
    if (!path.startsWith(rule.path)) continue;
    if (!best || rule.path.length > best.len || (rule.path.length === best.len && rule.allow)) {
      best = { allow: rule.allow, len: rule.path.length };
    }
  }
  if (!best) return 'default-allow';
  return best.allow ? 'allowed' : 'blocked';
}

export type UaAccess =
  /** 该 UA 被显式配置且首页可达 */
  | 'explicit-allow'
  /** 该 UA 被显式阻止（含通配阻止） */
  | 'explicit-block'
  /** robots.txt 未针对该 UA 配置（含只有 '*' 通用组、含无 robots.txt） */
  | 'unconfigured';

export interface UaVerdict {
  ua: string;
  family: UaFamily;
  access: UaAccess;
  /** 计分因子: 1 / 0 / 0.5（显式开放 / 阻止 / 未配置） */
  factor: number;
  detail: string;
}

export interface RobotsEvaluation {
  verdicts: UaVerdict[];
  familyScores: Record<UaFamily, number>;
  robotsTotal: number; // ≤ 25
  tag: 'AI-Open' | 'Middle-Path' | 'Training-Open' | 'AI-Closed' | 'Unconfigured';
  sitemaps: string[];
}

/**
 * 评估 14 个 AI UA 的 robots 政策。
 * @param robots 解析后的 robots.txt；null 表示无 robots.txt（404）→ 全部按未配置 0.5 计
 * @param reachable  robots.txt 本身是否可取；false（网络失败）→ 全部 unknown（0 分，不奖不罚）
 */
export function evaluateRobotsPolicy(
  robots: RobotsTxt | null,
  reachable: boolean,
): RobotsEvaluation {
  const verdicts: UaVerdict[] = [];

  for (const { ua, family } of AI_UAS) {
    if (!reachable) {
      verdicts.push({
        ua,
        family,
        access: 'unconfigured',
        factor: 0,
        detail: 'robots.txt 获取失败（网络错误）→ unknown，不奖不罚',
      });
      continue;
    }
    if (!robots || robots.groups.length === 0) {
      verdicts.push({
        ua,
        family,
        access: 'unconfigured',
        factor: 0.5,
        detail: robots ? 'robots.txt 为空 → 未配置（默认可达）' : '无 robots.txt（404）→ 未配置（默认可达）',
      });
      continue;
    }
    const match = matchGroup(robots, ua);
    if (!match) {
      verdicts.push({
        ua,
        family,
        access: 'unconfigured',
        factor: 0.5,
        detail: `robots.txt 未提及 ${ua} → 未配置（默认可达）`,
      });
      continue;
    }
    const decision = decidePath(match.group, '/');
    if (decision === 'blocked') {
      verdicts.push({
        ua,
        family,
        access: 'explicit-block',
        factor: 0,
        detail: match.wildcard
          ? `通配组 User-agent: * 阻止 ${ua}（Disallow 匹配 /）`
          : `User-agent: ${ua} 被阻止（Disallow 匹配 /）`,
      });
      continue;
    }
    if (match.wildcard) {
      verdicts.push({
        ua,
        family,
        access: 'unconfigured',
        factor: 0.5,
        detail: `仅有通配组 User-agent: *，未针对 ${ua} 显式配置 → 未配置`,
      });
      continue;
    }
    verdicts.push({
      ua,
      family,
      access: 'explicit-allow',
      factor: 1,
      detail:
        decision === 'allowed'
          ? `User-agent: ${ua} 显式 Allow 匹配 /`
          : `User-agent: ${ua} 组存在且未阻止 / → 显式开放`,
    });
  }

  const families: UaFamily[] = ['search', 'hybrid', 'training'];
  const familyScores = {} as Record<UaFamily, number>;
  for (const family of families) {
    const inFamily = verdicts.filter((v) => v.family === family);
    const avg = inFamily.reduce((s, v) => s + v.factor, 0) / inFamily.length;
    familyScores[family] = FAMILY_MAX[family] * avg;
  }
  const robotsTotal = families.reduce((s, f) => s + familyScores[f], 0);

  const explicitAllow = verdicts.filter((v) => v.access === 'explicit-allow').length;
  const explicitBlock = verdicts.filter((v) => v.access === 'explicit-block').length;
  const unconfigured = verdicts.filter((v) => v.access === 'unconfigured').length;
  const avg = (f: UaFamily) => {
    const inFamily = verdicts.filter((v) => v.family === f);
    return inFamily.reduce((s, v) => s + v.factor, 0) / inFamily.length;
  };

  let tag: RobotsEvaluation['tag'];
  if (!reachable) tag = 'Unconfigured'; // 取不到策略无法声明，按未配置展示（/method 公示）
  else if (unconfigured === verdicts.length) tag = 'Unconfigured';
  else if (explicitBlock >= 10) tag = 'AI-Closed';
  else if (explicitAllow >= Math.ceil(verdicts.length * 0.8)) tag = 'AI-Open';
  else if (avg('training') >= 0.8 && avg('search') <= 0.5) tag = 'Training-Open';
  else tag = 'Middle-Path';

  return { verdicts, familyScores, robotsTotal, tag, sitemaps: robots?.sitemaps ?? [] };
}
