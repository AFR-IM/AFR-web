// L3 Interactivity layer (25 points) = public API 8 + agent instructions 4 + MCP interface 6 + in-site AI features 7
// Spec §3.

import type { CheckResult, HttpProbe, LayerScore, ScanSignals } from '../../shared/src/index.ts';
import { round2 } from './l1.ts';

const ok = (p?: HttpProbe): p is HttpProbe => !!p && !p.error && (p.status ?? 0) >= 200 && (p.status ?? 0) < 300;

export function scoreL3(signals: ScanSignals): LayerScore {
  const checks: CheckResult[] = [];
  const homeOk = ok(signals.homepage);
  const doc = homeOk ? (signals.homepage.body ?? '') : undefined;

  // 1) Public API 8 = OpenAPI 4 + API docs 2 + homepage docs link 2
  let a = 0;
  let aUnknown = false;
  const aDetails: string[] = [];
  if (signals.openapi === undefined || !signals.openapi.probed) {
    aUnknown = true;
    aDetails.push('OpenAPI not probed');
  } else if (signals.openapi.found) {
    a += 4;
    aDetails.push(`OpenAPI found: ${(signals.openapi.urls ?? []).join(', ') || 'yes'}`);
  } else {
    aDetails.push('OpenAPI not found');
  }
  if (signals.apiDocs === undefined) {
    aUnknown = true;
    aDetails.push('API docs not probed');
  } else if (signals.apiDocs.found) {
    a += 2;
    aDetails.push('API docs present');
  } else {
    aDetails.push('API docs not found');
  }
  if (doc === undefined) {
    aUnknown = true;
    aDetails.push('homepage unavailable');
  } else if (/(href|action)\s*=\s*["'][^"']*\/(docs|developers?|api\/docs|reference)["']/i.test(doc)) {
    a += 2;
    aDetails.push('homepage links to docs/developer pages');
  } else {
    aDetails.push('homepage has no docs link');
  }
  checks.push({
    id: 'l3.public-api',
    layer: 'L3',
    name: 'Public API',
    awarded: a,
    max: 8,
    status: a >= 8 ? 'pass' : a <= 0 ? (aUnknown ? 'unknown' : 'fail') : 'partial',
    evidence: { source: 'openapi probe + homepage HTML', detail: aDetails.join('; ') },
  });

  // 2) Agent instructions 4 = agents.md 2 + ai.txt 1 + homepage AI info link 1
  let b = 0;
  let bUnknown = false;
  const bDetails: string[] = [];
  if (ok(signals.agentsMd)) {
    b += 2;
    bDetails.push('agents.md fetchable');
  } else if (signals.agentsMd?.error || !signals.agentsMd) {
    bUnknown = true;
    bDetails.push('agents.md not probed');
  } else {
    bDetails.push(`agents.md HTTP ${signals.agentsMd.status}`);
  }
  if (ok(signals.aiTxt)) {
    b += 1;
    bDetails.push('ai.txt fetchable');
  } else if (signals.aiTxt?.error || !signals.aiTxt) {
    bUnknown = true;
    bDetails.push('ai.txt not probed');
  } else {
    bDetails.push(`ai.txt HTTP ${signals.aiTxt.status}`);
  }
  if (doc === undefined) {
    bUnknown = true;
    bDetails.push('homepage unavailable');
  } else if (/href\s*=\s*["'][^"']*\/(ai|agents?)[^"']*["']/i.test(doc)) {
    b += 1;
    bDetails.push('homepage links to AI/Agent info page');
  } else {
    bDetails.push('homepage has no AI info page link');
  }
  checks.push({
    id: 'l3.agent-instructions',
    layer: 'L3',
    name: 'Agent instructions',
    awarded: b,
    max: 4,
    status: b >= 4 ? 'pass' : b <= 0 ? (bUnknown ? 'unknown' : 'fail') : 'partial',
    evidence: { source: 'GET /agents.md, /ai.txt + homepage HTML', detail: bDetails.join('; ') },
  });

  // 3) MCP interface — 6 points
  const mcp = signals.mcp;
  let c = 0;
  let cStatus: CheckResult['status'] = 'unknown';
  let cDetail = 'MCP not probed';
  if (mcp?.probed) {
    if (mcp.found) {
      c = 6;
      cStatus = 'pass';
      cDetail = `MCP endpoint found: ${(mcp.urls ?? []).join(', ') || 'yes'}`;
    } else {
      c = 0;
      cStatus = 'fail';
      cDetail = 'MCP probed; no endpoint found';
    }
  }
  checks.push({
    id: 'l3.mcp',
    layer: 'L3',
    name: 'MCP interface',
    awarded: c,
    max: 6,
    status: cStatus,
    evidence: { source: 'MCP probe', detail: cDetail },
  });

  // 4) In-site AI features 7 = chat assistant 4 + AI search 2 + developer console 1
  const f = signals.aiFeatures;
  let d = 0;
  let dStatus: CheckResult['status'] = 'unknown';
  const dDetails: string[] = [];
  if (f === undefined) {
    dDetails.push('AI features not probed');
  } else {
    if (f.chatWidget) {
      d += 4;
      dDetails.push('in-site chat/assistant ✓');
    } else dDetails.push('no in-site chat/assistant');
    if (f.aiSearch) {
      d += 2;
      dDetails.push('AI search ✓');
    } else dDetails.push('no AI search');
    if (f.developerConsole) {
      d += 1;
      dDetails.push('developer console ✓');
    } else dDetails.push('no developer console');
    dStatus = d >= 7 ? 'pass' : d <= 0 ? 'fail' : 'partial';
  }
  checks.push({
    id: 'l3.site-ai-features',
    layer: 'L3',
    name: 'In-site AI features',
    awarded: d,
    max: 7,
    status: dStatus,
    evidence: { source: 'homepage HTML heuristics', detail: dDetails.join('; ') },
  });

  const awarded = round2(checks.reduce((s, c) => s + c.awarded, 0));
  return { layer: 'L3', name: 'Actionability', awarded, max: 25, checks };
}
