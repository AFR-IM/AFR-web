// 单站扫描（方案书 §4）: 固定 ≤8 槽位公开 GET → ScanSignals（AFR 引擎输入）
//
// 槽位:
//   1 GET /robots.txt            （网络错误重试 1 次）
//   2 GET /llms.txt
//   3 GET /llms-full.txt
//   4 GET /                      （首页，网络错误重试 1 次）
//   5 GET /sitemap.xml           （robots 声明的 Sitemap 优先）
//   6 GET /agents.md             （404 → 回退 /AGENTS.md）
//   7 GET /openapi.json          （首页链接到 swagger/openapi 时优先用链接）
//   8 GET /.well-known/mcp
// 礼貌: 每站实际请求 ≤12（硬上限，含回退与重试）、robots crawl-delay 生效（封顶 3s）、
//       请求间默认 150ms 间隔、UA 透明、15s 超时。

import type { AiFeatures, ScanSignals } from '../../shared/src/index.ts';
import { normalizeDomain, politeGet, RequestCounter, SCANNER_VERSION, sleep, type FetchImpl } from './http.ts';

export interface ScanOptions {
  fetchImpl?: FetchImpl;
  /** 请求间基础间隔（默认 150ms） */
  gapMs?: number;
  /** 上限时间（测试可调小） */
  maxBytes?: number;
  /** 覆盖当前时间（测试用） */
  now?: () => string;
}

/** 从首页 HTML 提取文档/OpenAPI 链接 */
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

/** 站内 AI 功能启发式（M1 分布校准后可调） */
export function detectAiFeatures(html: string): AiFeatures {
  const chat =
    /intercom|crisp(-frame|_container)?|tidio|drift\.js|zendesk|hubspot.*chat|chatbot|chat-widget|chatscope|botpress|typebot|voiceflow|landbot|tawk\.to|purechat|watson|dialogflow|sendbird|userlike|olark|jivochat|gobot|chatra|livechat|whatsapp\.com\/wa|customerchat|fb-customerchat|<script[^>]+["'][^"']*\/chat[^"']*["']/i.test(html);
  const aiSearch =
    /ai[- ]search|ask ai\b|semantic search|vector search|powered by (openai|gpt|claude|gemini)|generative search|gpt-[34]|llm[- ]based/i.test(
      html,
    );
  const console_ =
    /(?:href|action)\s*=\s*["'][^"']*\/(console|developers?|dev\/|api\/keys|account\/api|dashboard[^"']*api)[^"']*["']/i.test(
      html,
    );
  return { chatWidget: chat, aiSearch, developerConsole: console_ };
}

function statusOk(r: { status?: number }): boolean {
  return r.status !== undefined && r.status >= 200 && r.status < 300;
}

/** 扫描单个站点，产出 AFR 引擎输入。纯 IO 函数，不评分。 */
export async function scanSite(domain: string, opts: ScanOptions = {}): Promise<ScanSignals> {
  const host = normalizeDomain(domain);
  const gap = opts.gapMs ?? 150;
  const counter = new RequestCounter();
  // 所有槽位: 网络错误重试 1 次（方案书 §5.6 失败恢复），预算硬上限仍由 counter 兑底
  const base = { counter, fetchImpl: opts.fetchImpl, maxBytes: opts.maxBytes, retryOnNetworkError: true };

  // 1) robots.txt —— 同时获取 crawl-delay 与 Sitemap 声明
  const robots = await politeGet(`https://${host}/robots.txt`, { ...base, retryOnNetworkError: true });
  let crawlDelayMs = gap;
  let sitemapUrl = `https://${host}/sitemap.xml`;
  if (statusOk(robots) && robots.body) {
    const cd = /crawl-delay\s*:\s*([\d.]+)/i.exec(robots.body)?.[1];
    if (cd) crawlDelayMs = Math.min(Number(cd) * 1000, 3000); // 礼貌生效，封顶 3s
    const sm = /^sitemap\s*:\s*(\S+)/im.exec(robots.body)?.[1];
    if (sm) sitemapUrl = sm;
  }

  await sleep(crawlDelayMs);

  // 2) llms.txt / 3) llms-full.txt
  const llms = await politeGet(`https://${host}/llms.txt`, base);
  await sleep(crawlDelayMs);
  const llmsFull = await politeGet(`https://${host}/llms-full.txt`, base);
  await sleep(crawlDelayMs);

  // 4) 首页（关键槽位: 网络错误重试）
  const homepage = await politeGet(`https://${host}/`, { ...base, retryOnNetworkError: true, maxBytes: opts.maxBytes ?? 1024 * 1024 });
  const html = statusOk(homepage) ? (homepage.body ?? '') : '';
  await sleep(crawlDelayMs);

  // 5) sitemap（robots 声明优先）
  const sitemap = await politeGet(sitemapUrl, base);
  await sleep(crawlDelayMs);

  // 6) agents.md（404 回退 AGENTS.md —— 回退仍计入预算）
  let agentsMd = await politeGet(`https://${host}/agents.md`, base);
  if (agentsMd.status === 404 && counter.remaining > 0) {
    await sleep(crawlDelayMs);
    agentsMd = await politeGet(`https://${host}/AGENTS.md`, base);
  }
  await sleep(crawlDelayMs);

  // 7) OpenAPI: 首页链接优先（相对路径按站点根解析），否则探测 /openapi.json
  const linked = html ? extractLinks(html, /(openapi|swagger)[^\"'\s]*\.json/i) : [];
  const first = linked[0];
  const openapiUrl = first ? new URL(first, `https://${host}/`).toString() : `https://${host}/openapi.json`;
  const openapiResp = await politeGet(openapiUrl, base);
  const openapiFound = statusOk(openapiResp) && /"(openapi|swagger)"\s*:/i.test(openapiResp.body ?? '');
  await sleep(crawlDelayMs);

  // 8) MCP well-known
  const mcpResp = await politeGet(`https://${host}/.well-known/mcp`, base);
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
    homepage,
    sitemap,
    agentsMd,
    openapi: { probed: true, found: openapiFound, urls: openapiFound ? [openapiUrl] : [] },
    apiDocs: { found: apiDocLinks.length > 0 || openapiFound, urls: apiDocLinks.slice(0, 3) },
    mcp: { probed: true, found: mcpFound, urls: mcpFound ? [`https://${host}/.well-known/mcp`] : [] },
    aiFeatures: html ? detectAiFeatures(html) : undefined,
  };
}
