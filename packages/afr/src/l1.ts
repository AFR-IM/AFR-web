// L1 Reachability layer (35 points) = robots AI policy 25 + no technical wall 5 + basic availability 5
// Spec §3. Only publicly reproducible facts are tested; every point has an evidence chain.

import type { CheckResult, HttpProbe, LayerScore, ScanSignals } from '../../shared/src/index.ts';
import type { RobotsEvaluation } from './robots.ts';

const HOME_2XX = (p?: HttpProbe): p is HttpProbe => !!p && !p.error && (p.status ?? 0) >= 200 && (p.status ?? 0) < 300;

function statusText(p?: HttpProbe): string {
  if (!p) return 'not probed';
  if (p.error) return `network error: ${p.error}`;
  return `HTTP ${p.status}`;
}

export function scoreL1(signals: ScanSignals, robotsEval: RobotsEvaluation): LayerScore {
  const checks: CheckResult[] = [];

  // 1) robots AI crawler policy — 25 points
  const rp = signals.robots;
  const robotsReachable = !!rp && !rp.error && rp.status !== undefined;
  const robotsTotal = robotsReachable ? robotsEval.robotsTotal : 0;
  const blocked = robotsEval.verdicts.filter((v) => v.access === 'explicit-block').slice(0, 3);
  const unconf = robotsEval.verdicts.filter((v) => v.access === 'unconfigured').slice(0, 3);
  checks.push({
    id: 'l1.robots.ai-policy',
    layer: 'L1',
    name: 'robots.txt AI crawler policy (14 UA families)',
    awarded: robotsTotal,
    max: 25,
    status: !robotsReachable ? 'unknown' : robotsTotal === 25 ? 'pass' : robotsTotal === 0 ? 'fail' : 'partial',
    evidence: {
      source: 'robots.txt',
      detail: robotsReachable
        ? `search-type ${robotsEval.familyScores.search.toFixed(2)}/9 · hybrid ${robotsEval.familyScores.hybrid.toFixed(2)}/6 · training ${robotsEval.familyScores.training.toFixed(2)}/10; strategy tag ${robotsEval.tag}.` +
          (blocked.length ? ` Blocked examples: ${blocked.map((v) => v.ua).join(', ')}.` : '') +
          (unconf.length ? ` Unconfigured examples: ${unconf.map((v) => v.ua).join(', ')}.` : '')
        : `Failed to fetch robots.txt: ${statusText(rp)}`,
    },
  });

  // 2) No technical wall — 5 points (judged from fetching the homepage with a transparent UA;
  //    a challenge fallback only recovers content and never whitewashes the wall)
  const hp = signals.homepage;
  let wall = 0;
  let wallStatus: CheckResult['status'] = 'unknown';
  if (hp && !hp.error && hp.status !== undefined) {
    if (hp.challengedStatus) {
      // Transparent UA was challenged (content fetched via browser-UA fallback) → wall honestly scores 0
      wall = 0;
      wallStatus = 'fail';
    } else if (hp.status >= 200 && hp.status < 300) {
      wall = 5;
      wallStatus = 'pass';
    } else if (hp.status >= 300 && hp.status < 400) {
      wall = 4;
      wallStatus = 'partial';
    } else {
      wall = 0;
      wallStatus = 'fail';
    }
  }
  checks.push({
    id: 'l1.no-tech-wall',
    layer: 'L1',
    name: 'No technical wall for transparent AI UA',
    awarded: wall,
    max: 5,
    status: wallStatus,
    evidence: {
      source: 'GET / (transparent AI UA)',
      detail:
        wallStatus === 'unknown'
          ? `Homepage probe failed: ${statusText(hp)}`
          : hp!.challengedStatus
            ? `transparent UA GET / → ${hp!.challengedStatus} (challenge page); content fetched via browser-UA fallback → wall honestly scored 0 for unfamiliar UAs`
            : `GET / → ${hp!.status}${wallStatus === 'fail' ? ' (blocked/challenge page = technical wall)' : ''}`,
    },
  });

  // 3) Basic availability — 5 points
  let avail = 0;
  let availStatus: CheckResult['status'] = 'unknown';
  if (hp && !hp.error && hp.status !== undefined) {
    if (HOME_2XX(hp)) {
      if (/<html[\s>]/i.test(hp.body ?? '')) {
        avail = 5;
        availStatus = 'pass';
      } else {
        avail = 3;
        availStatus = 'partial';
      }
    } else if (hp.status >= 300 && hp.status < 400) {
      avail = 3;
      availStatus = 'partial';
    } else {
      avail = 0;
      availStatus = 'fail';
    }
  }
  checks.push({
    id: 'l1.basic-availability',
    layer: 'L1',
    name: 'Basic availability',
    awarded: avail,
    max: 5,
    status: availStatus,
    evidence: {
      source: 'GET /',
      detail:
        availStatus === 'unknown'
          ? `Homepage probe failed: ${statusText(hp)}`
          : avail === 5
            ? `GET / → ${hp!.status}, full HTML document returned`
            : avail === 3
              ? `GET / → ${hp!.status}, not a full HTML document or unconverged redirect`
              : `GET / → ${hp!.status}, homepage unavailable`,
    },
  });

  const awarded = round2(checks.reduce((s, c) => s + c.awarded, 0));
  return { layer: 'L1', name: 'Reachability', awarded, max: 35, checks };
}

export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
