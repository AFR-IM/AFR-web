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
//   8 GET /.well-known/mcp
//   9 GET /ai.txt                (machine-readable AI crawler policy; powers the
//                                  agent-instructions sub-check the standard scores)
// Politeness: ≤18 actual requests per site (hard cap, incl. fallbacks and retries),
//             robots crawl-delay honored (capped at 3s), 150ms gap between requests by default,
//             transparent UA, 15s timeout.

import type { AiFeatures, HttpProbe, ScanSignals } from '../../shared/src/index.ts';
import { normalizeDomain, politeGet, RequestCounter, SCANNER_VERSION, sleep, type FetchImpl } from './http.ts';
import { detectAiSearch, detectChatWidget, detectDeveloperConsole, parseMarkup } from './markup.ts';
import { capturePageMeta } from './page-meta.ts';

/**
 * The homepage probe plus the page's own title/lang.
 *
 * The title and the language are captured while the body is still in hand:
 * the body is the bulk of the corpus and is pruned away later (it is only
 * needed to re-judge the AI-feature signals offline), so a title that is not
 * stored here is a title that is lost for good.
 */
export interface HomepageProbe extends HttpProbe {
  /** The homepage <title> text, normalized (absent when the page has none) */
  title?: string;
  /** The <html lang> attribute (absent when the page declares none) */
  lang?: string;
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
  // The page's own title/lang are read here, while the body is in hand, and
  // stored next to the probe. They are what every reader of the corpus needs
  // (cards, search index, D1 rows) and the body — 98% of the corpus — is
  // pruned away afterwards, so a title that is not captured now is lost.
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

  // 8) MCP well-known
  const mcpResp = await politeGet(`https://${host}/.well-known/mcp`, base);
  await sleep(crawlDelayMs);

  // 9) ai.txt — machine-readable AI crawler policy (the agent-instructions
  // sub-check awards 1 point only when this probe succeeds)
  const aiTxt = await politeGet(`https://${host}/ai.txt`, base);
  const mcpFound = statusOk(mcpResp) && (mcpResp.body ?? '').trim().length > 0;

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
    apiDocs: { found: apiDocLinks.length > 0 || openapiFound, urls: apiDocLinks.slice(0, 3) },
    mcp: { probed: true, found: mcpFound, urls: mcpFound ? [`https://${host}/.well-known/mcp`] : [] },
    aiTxt,
    aiFeatures: html ? detectAiFeatures(html) : undefined,
  };
}
