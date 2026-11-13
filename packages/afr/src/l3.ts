// L3 Interactivity layer (25 points) = public API 8 + agent instructions 4 + MCP interface 6 + in-site AI features 7
// Spec §3.

import type { CheckResult, HttpProbe, LayerScore, ScanSignals } from '../../shared/src/index.ts';
import { round2 } from './l1.ts';

const ok = (p?: HttpProbe): p is HttpProbe => !!p && !p.error && (p.status ?? 0) >= 200 && (p.status ?? 0) < 300;

export function scoreL3(signals: ScanSignals): LayerScore {
  const checks: CheckResult[] = [];
  const homeOk = ok(signals.homepage);
  const doc = homeOk ? (signals.homepage.body ?? '') : undefined;

  // 1) Public API 8 = public-API evidence 5 + human-readable docs 2 + OpenAPI 1
  //    (published split; engine previously used an unpublished 4/2/2 layout)
  let a = 0;
  let aUnknown = false;
  const aDetails: string[] = [];
  const llmsProbed = signals.llms !== undefined;
  const llmsBody = ok(signals.llms) ? (signals.llms.body ?? '') : '';
  const llmsNamesApi = /\b(api|developers?|reference|rest)\b/i.test(llmsBody);
  const anyProbed = llmsProbed || signals.apiDocs !== undefined || (signals.openapi?.probed ?? false);
  if (!anyProbed) {
    aUnknown = true;
    aDetails.push('no API sources probed');
  }
  // 5 — the site exposes a public API: llms.txt names one, the homepage links
  // docs/dev/api paths, or an OpenAPI document was discovered
  if (llmsNamesApi || signals.apiDocs?.found || signals.openapi?.found) {
    a += 5;
    if (llmsNamesApi) aDetails.push('llms.txt references an API');
    if (signals.apiDocs?.found) aDetails.push('homepage links API/docs paths');
    if (signals.openapi?.found) aDetails.push('OpenAPI document discovered');
  } else {
    aDetails.push('no public-API evidence');
  }
  // 2 — a human-readable documentation entry point exists
  const docsEntry =
    signals.apiDocs?.found === true ||
    (llmsProbed && ok(signals.llms) && /docs\.|developer|documentation/i.test(llmsBody));
  if (docsEntry) {
    a += 2;
    aDetails.push('API documentation entry point present');
  } else {
    aDetails.push('no API documentation entry point');
  }
  // 1 — machine-readable OpenAPI spec
  if (signals.openapi?.found) {
    a += 1;
    aDetails.push(`OpenAPI: ${(signals.openapi.urls ?? []).join(', ') || 'yes'}`);
  } else if (signals.openapi?.probed) {
    aDetails.push('OpenAPI not found');
  } else {
    aDetails.push('OpenAPI not probed');
  }
  checks.push({
    id: 'l3.public-api',
    layer: 'L3',
    name: 'Public API',
    awarded: a,
    max: 8,
    status: a >= 8 ? 'pass' : a <= 0 ? (aUnknown ? 'unknown' : 'fail') : 'partial',
    evidence: { source: 'llms.txt + homepage HTML + OpenAPI probe', detail: aDetails.join('; ') },
  });

  // 2) Agent instructions 4 = agents.md reachable (HTTP 2xx) 2 + llms.txt
  //    agent-policy section 2 (published composition; the previous engine-only
  //    ai.txt and homepage-link awards are removed)
  let b = 0;
  let bUnknown = false;
  const bDetails: string[] = [];
  if (ok(signals.agentsMd)) {
    b += 2;
    bDetails.push('agents.md reachable (2xx)');
  } else if (signals.agentsMd?.error || !signals.agentsMd) {
    bUnknown = true;
    bDetails.push('agents.md not probed');
  } else {
    bDetails.push(`agents.md HTTP ${signals.agentsMd.status}`);
  }
  if (signals.llms === undefined) {
    bUnknown = true;
    bDetails.push('llms.txt not probed');
  } else if (ok(signals.llms)) {
    const policy = /(#+[^\n]*agent[^\n]*(policy|instruction|usage|guideline))|(agent\s*(usage|instruction|policy|guideline)\s*:)/i.test(
      signals.llms.body ?? '',
    );
    if (policy) {
      b += 2;
      bDetails.push('llms.txt declares an agent policy section');
    } else {
      bDetails.push('llms.txt has no agent policy section');
    }
  } else {
    bDetails.push(`llms.txt HTTP ${signals.llms.status}`);
  }
  checks.push({
    id: 'l3.agent-instructions',
    layer: 'L3',
    name: 'Agent instructions',
    awarded: b,
    max: 4,
    status: b >= 4 ? 'pass' : b <= 0 ? (bUnknown ? 'unknown' : 'fail') : 'partial',
    evidence: { source: 'GET /agents.md + /llms.txt', detail: bDetails.join('; ') },
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
