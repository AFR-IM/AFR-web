// L1 可达层（35 分）= robots AI 政策 25 + 无技术墙 5 + 基础可用性 5
// 方案书 §3。只测公开可复现事实；每分有证据链。

import type { CheckResult, HttpProbe, LayerScore, ScanSignals } from '../../shared/src/index.ts';
import type { RobotsEvaluation } from './robots.ts';

const HOME_2XX = (p?: HttpProbe): p is HttpProbe => !!p && !p.error && (p.status ?? 0) >= 200 && (p.status ?? 0) < 300;

function statusText(p?: HttpProbe): string {
  if (!p) return '未探测';
  if (p.error) return `网络错误: ${p.error}`;
  return `HTTP ${p.status}`;
}

export function scoreL1(signals: ScanSignals, robotsEval: RobotsEvaluation): LayerScore {
  const checks: CheckResult[] = [];

  // 1) robots AI 爬虫政策 25 分
  const rp = signals.robots;
  const robotsReachable = !!rp && !rp.error && rp.status !== undefined;
  const robotsTotal = robotsReachable ? robotsEval.robotsTotal : 0;
  const blocked = robotsEval.verdicts.filter((v) => v.access === 'explicit-block').slice(0, 3);
  const unconf = robotsEval.verdicts.filter((v) => v.access === 'unconfigured').slice(0, 3);
  checks.push({
    id: 'l1.robots.ai-policy',
    layer: 'L1',
    nameEn: 'robots.txt AI crawler policy (14 UA families)',
    nameZh: 'robots.txt AI 爬虫政策（14 UA 家族）',
    awarded: robotsTotal,
    max: 25,
    status: !robotsReachable ? 'unknown' : robotsTotal === 25 ? 'pass' : robotsTotal === 0 ? 'fail' : 'partial',
    evidence: {
      source: 'robots.txt',
      detail: robotsReachable
        ? `搜索型 ${robotsEval.familyScores.search.toFixed(2)}/9 · 混合型 ${robotsEval.familyScores.hybrid.toFixed(2)}/6 · 训练型 ${robotsEval.familyScores.training.toFixed(2)}/10；策略标签 ${robotsEval.tag}。` +
          (blocked.length ? ` 阻止示例: ${blocked.map((v) => v.ua).join(', ')}。` : '') +
          (unconf.length ? ` 未配置示例: ${unconf.map((v) => v.ua).join(', ')}。` : '')
        : `robots.txt 获取失败: ${statusText(rp)}`,
    },
  });

  // 2) 无技术墙 5 分（以透明 UA 抓取首页的结果判定；挑战回退只取内容，不洗白墙）
  const hp = signals.homepage;
  let wall = 0;
  let wallStatus: CheckResult['status'] = 'unknown';
  if (hp && !hp.error && hp.status !== undefined) {
    if (hp.challengedStatus) {
      // 透明 UA 被挑战（内容经浏览器 UA 回退获取）→ 墙如实计 0
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
    nameEn: 'No technical wall for transparent AI UA',
    nameZh: '无技术墙（透明 UA 可达）',
    awarded: wall,
    max: 5,
    status: wallStatus,
    evidence: {
      source: 'GET / (transparent AI UA)',
      detail:
        wallStatus === 'unknown'
          ? `首页探测失败: ${statusText(hp)}`
          : hp!.challengedStatus
            ? `透明 UA GET / → ${hp!.challengedStatus}（挑战页），内容经浏览器 UA 回退获取 → 对陌生 UA 的墙如实计 0`
            : `GET / → ${hp!.status}${wallStatus === 'fail' ? '（拦截/挑战页即技术墙）' : ''}`,
    },
  });

  // 3) 基础可用性 5 分
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
    nameEn: 'Basic availability',
    nameZh: '基础可用性',
    awarded: avail,
    max: 5,
    status: availStatus,
    evidence: {
      source: 'GET /',
      detail:
        availStatus === 'unknown'
          ? `首页探测失败: ${statusText(hp)}`
          : avail === 5
            ? `GET / → ${hp!.status}，返回完整 HTML 文档`
            : avail === 3
              ? `GET / → ${hp!.status}，非完整 HTML 或未收敛重定向`
              : `GET / → ${hp!.status}，首页不可用`,
    },
  });

  const awarded = round2(checks.reduce((s, c) => s + c.awarded, 0));
  return { layer: 'L1', nameEn: 'Reachability', nameZh: '可达层', awarded, max: 35, checks };
}

export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
