// Single-site scan (spec §4): fixed ≤9 slots of public GETs → ScanSignals (AFR engine input)
//
// Slots:
//   1 GET /robots.txt            (1 retry on network error)
//   2 GET /llms.txt
//   3 GET /llms-full.txt
//   4 GET /                      (homepage, 1 retry on network error)
//   5 GET /sitemap.xml           (Sitemap declared in robots.txt takes priority)
//   6 GET /agents.md             (404 → fall back to /AGENTS.md)
//   7 GET /openapi.json          (prefer the homepage link when it links to swagger/openapi)
//   8 GET /.well-known/mcp       (discovery document; when it declares an
//                                 endpoint the scanner completes the MCP
//                                 handshake — POST initialize, POST
//                                 notifications/initialized, POST tools/list —
//                                 and stores the returned tool names, because
//                                 C3 scores the handshake, not the discovery)
//   9 GET /ai.txt                (machine-readable AI crawler policy; powers the
//                                  agent-instructions sub-check the standard scores)
// Politeness: ≤18 actual requests per site (hard cap, incl. fallbacks, retries
//             and the MCP handshake POSTs), robots crawl-delay honored (capped at 3s),
//             150ms gap between requests by default, transparent UA, 15s timeout.

import type { AiFeatures, HttpProbe, ScanSignals } from '../../shared/src/index.ts';
import { normalizeDomain, politeGet, politePostJson, RequestCounter, SCANNER_VERSION, sleep, type FetchImpl } from './http.ts';
import { detectAiSearch, detectChatWidget, detectDeveloperConsole, parseMarkup } from './markup.ts';
import { capturePageMeta, type PageMetaTags } from './page-meta.ts';

/**
 * The homepage probe plus the page's own title/lang/meta.
 *
 * The title and the language are captured while the body is still in hand:
 * the body is the bulk of the corpus and is pruned away later (it is only
 * needed to re-judge the AI-feature signals offline), so a title that is not
 * stored here is a title that is lost for good. The site's own
 * self-description (`meta`) rides along for the same reason — the category
 * heuristics read it, and a pruned body would cost the site its category.
 */
export interface HomepageProbe extends HttpProbe {
  /** The homepage <title> text, normalized (absent when the page has none) */
  title?: string;
  /** The <html lang> attribute (absent when the page declares none) */
  lang?: string;
  /** The site's own og:site_name / application-name / description / keywords */
  meta?: PageMetaTags;
}

/** Scan signals whose homepage probe carries the page metadata. */
export interface ScanSignalsWithPageMeta extends ScanSignals {
  homepage?: HomepageProbe;
}

export interface ScanOptions {
  fetchImpl?: FetchImpl;
  /** Base gap between requests (default 150ms) */
  gapMs?: number;
  /** Response body cap (tests may lower it) */
  maxBytes?: number;
  /** Override the current time (for tests) */
  now?: () => string;
}

/** Extract doc/OpenAPI links from homepage HTML */
export function extractLinks(html: string, pattern: RegExp): string[] {
  const out = new Set<string>();
  const re = /(?:href|src|content)\s*=\s*["']([^"']+)["']/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const url = m[1]!;
    if (pattern.test(url)) out.add(url);
  }
  return [...out];
}

/**
 * In-site AI feature heuristics (tunable after distribution calibration).
 *
 * Structural, not textual: a signal only counts when the markup carries it —
 * a chat script/iframe/link or a chat container element for the assistant, a
 * control/endpoint that names the search for AI search, a real link target
 * for the developer console. Prose and embedded JSON payloads (site catalogs
 * often list product names such as "Discord - Group Chat") are never chat
 * evidence — matching raw text there handed out points nobody earned.
 */
export function detectAiFeatures(html: string): AiFeatures {
  const markup = parseMarkup(html);
  return {
    chatWidget: detectChatWidget(markup),
    aiSearch: detectAiSearch(markup),
    developerConsole: detectDeveloperConsole(markup),
  };
}

function statusOk(r: { status?: number }): boolean {
  return r.status !== undefined && r.status >= 200 && r.status < 300;
}

/** Cap on stored MCP tool names — evidence, not a catalog */
const MAX_MCP_TOOLS = 50;

/** Parse a JSON-RPC 2.0 reply that may arrive as plain JSON or as one SSE `data:` line. */
export function parseJsonRpcReply(body: string | undefined): Record<string, unknown> | null {
  if (!body) return null;
  const parse = (raw: string): Record<string, unknown> | null => {
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : null;
    } catch {
      return null;
    }
  };
  const direct = parse(body.trim());
  if (direct) return direct;
  for (const line of body.split(/\r?\n/)) {
    if (line.startsWith('data:')) {
      const parsed = parse(line.slice(5).trim());
      if (parsed) return parsed;
    }
  }
  return null;
}

/**
 * Complete an MCP handshake against the endpoint the discovery document
 * declares: POST initialize → POST notifications/initialized → POST tools/list.
 *
 * Returns the tool names when tools/list answers with a JSON-RPC result — an
 * empty array means the handshake proved a server that lists no tools — and
 * `undefined` when any step fails (no endpoint declared, non-2xx, JSON-RPC
 * error, unparseable reply, polite budget spent). Discovery alone never earns
 * points: an ordinary page served under /.well-known/mcp is not an MCP server,
 * and only the handshake can tell the difference.
 */
export async function mcpHandshake(
  discoveryBody: string | undefined,
  opts: { counter: RequestCounter; fetchImpl?: FetchImpl; maxBytes?: number },
  gapMs: number,
): Promise<string[] | undefined> {
  let endpoint: string;
  try {
    const doc = JSON.parse(discoveryBody ?? '') as { endpoint?: unknown };
    if (typeof doc?.endpoint !== 'string') return undefined;
    const url = new URL(doc.endpoint);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return undefined;
    endpoint = url.toString();
  } catch {
    return undefined; // not a discovery document (HTML catch-all, invalid JSON)
  }

  const post = (body: string, headers?: Record<string, string>) =>
    politePostJson(endpoint, body, {
      counter: opts.counter,
      fetchImpl: opts.fetchImpl,
      maxBytes: opts.maxBytes,
      headers,
    });
  const ok2xx = (r: { status?: number; error?: string }) =>
    !r.error && r.status !== undefined && r.status >= 200 && r.status < 300;

  const initialize = await post(
    JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'afr-scanner', version: SCANNER_VERSION },
      },
    }),
  );
  if (!ok2xx(initialize)) return undefined;
  const initReply = parseJsonRpcReply(initialize.body);
  const initResult = initReply && !initReply.error ? initReply.result : undefined;
  if (!initResult || typeof initResult !== 'object') return undefined;
  const sessionId = initialize.responseHeaders?.['mcp-session-id'];
  const session = sessionId ? { 'mcp-session-id': sessionId } : undefined;

  await sleep(gapMs);
  const initialized = await post(
    JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    session,
  );
  if (!ok2xx(initialized)) return undefined;

  await sleep(gapMs);
  const list = await post(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }), session);
  if (!ok2xx(list)) return undefined;
  const listReply = parseJsonRpcReply(list.body);
  if (!listReply || listReply.error) return undefined;
  const result = listReply.result;
  const tools =
    result && typeof result === 'object' ? (result as { tools?: unknown }).tools : undefined;
  if (!Array.isArray(tools)) return undefined; // no tools list in the reply → unverified
  const names = tools
    .map((t) => (t && typeof t === 'object' ? (t as { name?: unknown }).name : undefined))
    .filter((n): n is string => typeof n === 'string' && n.length > 0);
  return names.slice(0, MAX_MCP_TOOLS);
}

/** Scan a single site and produce AFR engine input. Pure IO function; does not score. */
export async function scanSite(domain: string, opts: ScanOptions = {}): Promise<ScanSignalsWithPageMeta> {
  const host = normalizeDomain(domain);
  const gap = opts.gapMs ?? 150;
  const counter = new RequestCounter();
  // All slots: 1 retry on network error; the hard budget is still enforced by the counter
  const base = { counter, fetchImpl: opts.fetchImpl, maxBytes: opts.maxBytes, retryOnNetworkError: true };

  // 1) robots.txt — also fetches crawl-delay and Sitemap declarations
  const robots = await politeGet(`https://${host}/robots.txt`, { ...base, retryOnNetworkError: true });
  let crawlDelayMs = gap;
  let sitemapUrl = `https://${host}/sitemap.xml`;
  if (statusOk(robots) && robots.body) {
    const cd = /crawl-delay\s*:\s*([\d.]+)/i.exec(robots.body)?.[1];
    if (cd) crawlDelayMs = Math.min(Number(cd) * 1000, 3000); // politeness honored, capped at 3s
    const sm = /^sitemap\s*:\s*(\S+)/im.exec(robots.body)?.[1];
    if (sm) sitemapUrl = sm;
  }

  await sleep(crawlDelayMs);

  // 2) llms.txt / 3) llms-full.txt
  const llms = await politeGet(`https://${host}/llms.txt`, base);
  await sleep(crawlDelayMs);
  const llmsFull = await politeGet(`https://${host}/llms-full.txt`, base);
  await sleep(crawlDelayMs);

  // 4) homepage (key slot: retry on network error)
  const homepage = await politeGet(`https://${host}/`, { ...base, retryOnNetworkError: true, maxBytes: opts.maxBytes ?? 1024 * 1024 });
  const html = statusOk(homepage) ? (homepage.body ?? '') : '';
  // The page's own title/lang/meta are read here, while the body is in hand,
  // and stored next to the probe. They are what every reader of the corpus
  // needs (cards, categories, search index, D1 rows) and the body — 98% of
  // the corpus — is pruned away afterwards, so a title that is not captured
  // now is lost.
  // A body we cannot parse costs us the field, never the scan.
  const pageMeta = capturePageMeta(homepage.body);
  const homepageProbe: HomepageProbe = { ...homepage, ...pageMeta };
  await sleep(crawlDelayMs);

  // 5) sitemap (robots.txt declaration takes priority)
  const sitemap = await politeGet(sitemapUrl, base);
  await sleep(crawlDelayMs);

  // 6) agents.md (404 → fall back to AGENTS.md — the fallback still counts against the budget)
  let agentsMd = await politeGet(`https://${host}/agents.md`, base);
  if (agentsMd.status === 404 && counter.remaining > 0) {
    await sleep(crawlDelayMs);
    agentsMd = await politeGet(`https://${host}/AGENTS.md`, base);
  }
  await sleep(crawlDelayMs);

  // 7) OpenAPI: prefer the homepage link (relative paths resolved against the site root), else probe /openapi.json
  const linked = html ? extractLinks(html, /(openapi|swagger)[^\"'\s]*\.json/i) : [];
  const first = linked[0];
  const openapiUrl = first ? new URL(first, `https://${host}/`).toString() : `https://${host}/openapi.json`;
  const openapiResp = await politeGet(openapiUrl, base);
  const openapiFound = statusOk(openapiResp) && /"(openapi|swagger)"\s*:/i.test(openapiResp.body ?? '');
  await sleep(crawlDelayMs);

  // 8) MCP well-known → handshake. The GET only finds the door: C3 scores
  //    initialize → initialized → tools/list, so the tool names are stored
  //    only when that sequence completes (undefined = discovery only).
  const mcpResp = await politeGet(`https://${host}/.well-known/mcp`, base);
  await sleep(crawlDelayMs);
  const mcpFound = statusOk(mcpResp) && (mcpResp.body ?? '').trim().length > 0;
  const mcpTools = mcpFound
    ? await mcpHandshake(
        mcpResp.body,
        { counter, fetchImpl: opts.fetchImpl, maxBytes: opts.maxBytes },
        crawlDelayMs,
      )
    : undefined;
  await sleep(crawlDelayMs);

  // 9) ai.txt — machine-readable AI crawler policy (the agent-instructions
  // sub-check awards 1 point only when this probe succeeds)
  const aiTxt = await politeGet(`https://${host}/ai.txt`, base);

  const apiDocLinks = html
    ? extractLinks(html, /\/(docs|developers?|reference|api\/docs)([/?#"']|$)/i).map((u) =>
        new URL(u, `https://${host}/`).toString(),
      )
    : [];

  return {
    domain: host,
    fetchedAt: (opts.now ?? (() => new Date().toISOString()))(),
    scannerVersion: SCANNER_VERSION,
    robots,
    llms,
    llmsFull,
    homepage: homepageProbe,
    sitemap,
    agentsMd,
    openapi: { probed: true, found: openapiFound, urls: openapiFound ? [openapiUrl] : [] },
    // The API-docs signal is homepage links only (afr-1.6.0). An OpenAPI
    // document used to set this flag too, which let a single openapi.json
    // satisfy both the 5-point and the 2-point C1 evidence — the spec is now
    // scored by the openapi probe alone (5+1, never the docs entry).
    apiDocs: { found: apiDocLinks.length > 0, urls: apiDocLinks.slice(0, 3) },
    mcp: {
      probed: true,
      found: mcpFound,
      urls: mcpFound ? [`https://${host}/.well-known/mcp`] : [],
      ...(mcpTools !== undefined ? { tools: mcpTools } : {}),
    },
    aiTxt,
    aiFeatures: html ? detectAiFeatures(html) : undefined,
  };
}
