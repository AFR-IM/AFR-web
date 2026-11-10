// L3 可交互层（25 分）= 公开 API 8 + Agent 指令 4 + MCP 接口 6 + 站内 AI 功能 7
// 方案书 §3。

import type { CheckResult, HttpProbe, LayerScore, ScanSignals } from '../../shared/src/index.ts';
import { round2 } from './l1.ts';

const ok = (p?: HttpProbe): p is HttpProbe => !!p && !p.error && (p.status ?? 0) >= 200 && (p.status ?? 0) < 300;

export function scoreL3(signals: ScanSignals): LayerScore {
  const checks: CheckResult[] = [];
  const homeOk = ok(signals.homepage);
  const doc = homeOk ? (signals.homepage.body ?? '') : undefined;

  // 1) 公开 API 8 = OpenAPI 4 + API 文档 2 + 首页文档链接 2
  let a = 0;
  let aUnknown = false;
  const aDetails: string[] = [];
  if (signals.openapi === undefined || !signals.openapi.probed) {
    aUnknown = true;
    aDetails.push('OpenAPI 未探测');
  } else if (signals.openapi.found) {
    a += 4;
    aDetails.push(`OpenAPI 发现: ${(signals.openapi.urls ?? []).join(', ') || '是'}`);
  } else {
    aDetails.push('OpenAPI 未发现');
  }
  if (signals.apiDocs === undefined) {
    aUnknown = true;
    aDetails.push('API 文档未探测');
  } else if (signals.apiDocs.found) {
    a += 2;
    aDetails.push('API 文档存在');
  } else {
    aDetails.push('API 文档未发现');
  }
  if (doc === undefined) {
    aUnknown = true;
    aDetails.push('首页不可用');
  } else if (/(href|action)\s*=\s*["'][^"']*\/(docs|developers?|api\/docs|reference)["']/i.test(doc)) {
    a += 2;
    aDetails.push('首页链接到文档/开发者页');
  } else {
    aDetails.push('首页无文档链接');
  }
  checks.push({
    id: 'l3.public-api',
    layer: 'L3',
    nameEn: 'Public API',
    nameZh: '公开 API',
    awarded: a,
    max: 8,
    status: a >= 8 ? 'pass' : a <= 0 ? (aUnknown ? 'unknown' : 'fail') : 'partial',
    evidence: { source: 'openapi probe + homepage HTML', detail: aDetails.join('；') },
  });

  // 2) Agent 指令 4 = agents.md 2 + ai.txt 1 + 首页 AI 说明链接 1
  let b = 0;
  let bUnknown = false;
  const bDetails: string[] = [];
  if (ok(signals.agentsMd)) {
    b += 2;
    bDetails.push('agents.md 可取');
  } else if (signals.agentsMd?.error || !signals.agentsMd) {
    bUnknown = true;
    bDetails.push('agents.md 未探测');
  } else {
    bDetails.push(`agents.md HTTP ${signals.agentsMd.status}`);
  }
  if (ok(signals.aiTxt)) {
    b += 1;
    bDetails.push('ai.txt 可取');
  } else if (signals.aiTxt?.error || !signals.aiTxt) {
    bUnknown = true;
    bDetails.push('ai.txt 未探测');
  } else {
    bDetails.push(`ai.txt HTTP ${signals.aiTxt.status}`);
  }
  if (doc === undefined) {
    bUnknown = true;
    bDetails.push('首页不可用');
  } else if (/href\s*=\s*["'][^"']*\/(ai|agents?)[^"']*["']/i.test(doc)) {
    b += 1;
    bDetails.push('首页链接到 AI/Agent 说明页');
  } else {
    bDetails.push('首页无 AI 说明页链接');
  }
  checks.push({
    id: 'l3.agent-instructions',
    layer: 'L3',
    nameEn: 'Agent instructions',
    nameZh: 'Agent 指令',
    awarded: b,
    max: 4,
    status: b >= 4 ? 'pass' : b <= 0 ? (bUnknown ? 'unknown' : 'fail') : 'partial',
    evidence: { source: 'GET /agents.md, /ai.txt + homepage HTML', detail: bDetails.join('；') },
  });

  // 3) MCP 接口 6
  const mcp = signals.mcp;
  let c = 0;
  let cStatus: CheckResult['status'] = 'unknown';
  let cDetail = 'MCP 未探测';
  if (mcp?.probed) {
    if (mcp.found) {
      c = 6;
      cStatus = 'pass';
      cDetail = `MCP 端点发现: ${(mcp.urls ?? []).join(', ') || '是'}`;
    } else {
      c = 0;
      cStatus = 'fail';
      cDetail = 'MCP 探测完成，未发现端点';
    }
  }
  checks.push({
    id: 'l3.mcp',
    layer: 'L3',
    nameEn: 'MCP interface',
    nameZh: 'MCP 接口',
    awarded: c,
    max: 6,
    status: cStatus,
    evidence: { source: 'MCP probe', detail: cDetail },
  });

  // 4) 站内 AI 功能 7 = 聊天助手 4 + AI 搜索 2 + 开发者控制台 1
  const f = signals.aiFeatures;
  let d = 0;
  let dStatus: CheckResult['status'] = 'unknown';
  const dDetails: string[] = [];
  if (f === undefined) {
    dDetails.push('AI 功能未探测');
  } else {
    if (f.chatWidget) {
      d += 4;
      dDetails.push('站内聊天/助手 ✓');
    } else dDetails.push('无站内聊天/助手');
    if (f.aiSearch) {
      d += 2;
      dDetails.push('AI 搜索 ✓');
    } else dDetails.push('无 AI 搜索');
    if (f.developerConsole) {
      d += 1;
      dDetails.push('开发者控制台 ✓');
    } else dDetails.push('无开发者控制台');
    dStatus = d >= 7 ? 'pass' : d <= 0 ? 'fail' : 'partial';
  }
  checks.push({
    id: 'l3.site-ai-features',
    layer: 'L3',
    nameEn: 'In-site AI features',
    nameZh: '站内 AI 功能',
    awarded: d,
    max: 7,
    status: dStatus,
    evidence: { source: 'homepage HTML heuristics', detail: dDetails.join('；') },
  });

  const awarded = round2(checks.reduce((s, c) => s + c.awarded, 0));
  return { layer: 'L3', nameEn: 'Interactivity', nameZh: '可交互层', awarded, max: 25, checks };
}
