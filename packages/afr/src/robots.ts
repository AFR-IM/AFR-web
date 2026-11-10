// robots.txt parsing and AI UA policy evaluation (pure functions)
// Semantics follow the robots.txt standard: longest UA match wins, longest path match wins,
// Allow wins on ties, empty Disallow is ignored.

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

/** Parse the full robots.txt text. Tolerant of comments, blank lines, missing colons, duplicate fields. */
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
        // A new UA line after rules → start a new group
        if (sawRule) flush();
        if (value) agents.push(value.toLowerCase());
        break;
      case 'allow':
      case 'disallow':
        if (!agents.length) break; // rule appears before any UA line → ignore
        sawRule = true;
        // empty path = no restriction, ignored per the standard
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

/** Pick the best-matching group for the given UA (longest token wins; '*' is the wildcard fallback).
 *  Returns [group, isWildcard]. */
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

/** Decide rules for a path (default "/"): 'allowed' | 'blocked' | 'default-allow' */
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
  /** The UA is explicitly configured and the homepage is reachable */
  | 'explicit-allow'
  /** The UA is explicitly blocked (including wildcard blocks) */
  | 'explicit-block'
  /** robots.txt has no configuration for this UA (including only a '*' wildcard group, or no robots.txt) */
  | 'unconfigured';

export interface UaVerdict {
  ua: string;
  family: UaFamily;
  access: UaAccess;
  /** Scoring factor: 1 / 0 / 0.5 (explicitly open / blocked / unconfigured) */
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
 * Evaluate the robots policy for the 14 AI UAs.
 * @param robots parsed robots.txt; null means no robots.txt (404) → all scored as unconfigured 0.5
 * @param reachable whether robots.txt itself was fetchable; false (network error) → all unknown
 *                  (0 points, no penalty, no reward)
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
        detail: 'failed to fetch robots.txt (network error) → unknown; no penalty, no reward',
      });
      continue;
    }
    if (!robots || robots.groups.length === 0) {
      verdicts.push({
        ua,
        family,
        access: 'unconfigured',
        factor: 0.5,
        detail: robots ? 'robots.txt is empty → unconfigured (default reachable)' : 'no robots.txt (404) → unconfigured (default reachable)',
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
        detail: `robots.txt does not mention ${ua} → unconfigured (default reachable)`,
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
          ? `wildcard group User-agent: * blocks ${ua} (Disallow matches /)`
          : `User-agent: ${ua} is blocked (Disallow matches /)`,
      });
      continue;
    }
    if (match.wildcard) {
      verdicts.push({
        ua,
        family,
        access: 'unconfigured',
        factor: 0.5,
        detail: `only the wildcard group User-agent: * exists; ${ua} not explicitly configured → unconfigured`,
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
          ? `User-agent: ${ua} explicitly allowed for /`
          : `User-agent: ${ua} group present and / not blocked → explicitly open`,
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
  if (!reachable) tag = 'Unconfigured'; // policy unavailable → cannot claim a stance, shown as unconfigured (disclosed on /method)
  else if (unconfigured === verdicts.length) tag = 'Unconfigured';
  else if (explicitBlock >= 10) tag = 'AI-Closed';
  else if (explicitAllow >= Math.ceil(verdicts.length * 0.8)) tag = 'AI-Open';
  else if (avg('training') >= 0.8 && avg('search') <= 0.5) tag = 'Training-Open';
  else tag = 'Middle-Path';

  return { verdicts, familyScores, robotsTotal, tag, sitemaps: robots?.sitemaps ?? [] };
}
