// src/method-checks.ts — per-check enumeration of the AFR standard v1.0
// (spec §3 of the v1.0 spec document). Pure data: consumed by
// GET /api/v1/method (spec §14-D machine-readable schema). Layer weights come
// from LAYER_MAX in packages/shared (imported by src/index.ts), so the checks
// listed here must sum to their layer weight — test/method.test.ts asserts it.

export type AfrLayerId = 'L1' | 'L2' | 'L3';

export interface AfrCheckDef {
  id: string;
  /** English display name */
  name: string;
  /** Points awarded when the check passes (spec §3) */
  points: number;
  /** A1 robots.txt only: crawler family per spec §3.2 */
  family?: 'search' | 'mixed' | 'training';
  /** A1 robots.txt only: the crawler UA this check scores */
  ua?: string;
}

export interface AfrLayerDef {
  id: AfrLayerId;
  name: { en: string; zh: string };
  checks: AfrCheckDef[];
}

/** AFR standard version (spec §14-D shape) */
export const AFR_VERSION = '1.1.0';

export const LAYER_NAMES: Record<AfrLayerId, { en: string; zh: string }> = {
  L1: { en: 'Reachable', zh: '可达' },
  L2: { en: 'Legible', zh: '可懂' },
  L3: { en: 'Actionable', zh: '可交互' },
};

// L1 Reachable (35 = 25 + 5 + 5), spec §3.2
const L1_CHECKS: AfrCheckDef[] = [
  // A1 robots.txt AI crawler policy — search/referencing (9)
  { id: 'A1.oai-searchbot', name: 'robots.txt allows OAI-SearchBot', points: 4, family: 'search', ua: 'OAI-SearchBot' },
  { id: 'A1.perplexitybot', name: 'robots.txt allows PerplexityBot', points: 3, family: 'search', ua: 'PerplexityBot' },
  { id: 'A1.chatgpt-user', name: 'robots.txt allows ChatGPT-User', points: 2, family: 'search', ua: 'ChatGPT-User' },
  // A1 hybrid training+product grounding (6)
  { id: 'A1.google-extended', name: 'robots.txt allows Google-Extended', points: 3, family: 'mixed', ua: 'Google-Extended' },
  { id: 'A1.applebot-assistant', name: 'robots.txt allows Applebot-Assistant', points: 2, family: 'mixed', ua: 'Applebot-Assistant' },
  { id: 'A1.bingbot', name: 'robots.txt allows Bingbot', points: 1, family: 'mixed', ua: 'Bingbot' },
  // A1 training crawlers (10) — Claude family is scored merged on ClaudeBot
  { id: 'A1.gptbot', name: 'robots.txt allows GPTBot', points: 3, family: 'training', ua: 'GPTBot' },
  { id: 'A1.claudebot', name: 'robots.txt allows ClaudeBot (Claude family)', points: 2, family: 'training', ua: 'ClaudeBot' },
  { id: 'A1.ccbot', name: 'robots.txt allows CCBot', points: 1, family: 'training', ua: 'CCBot' },
  { id: 'A1.bytespider', name: 'robots.txt allows Bytespider', points: 1, family: 'training', ua: 'Bytespider' },
  { id: 'A1.meta-externalagent', name: 'robots.txt allows meta-externalagent', points: 1, family: 'training', ua: 'meta-externalagent' },
  { id: 'A1.amazonbot', name: 'robots.txt allows Amazonbot', points: 1, family: 'training', ua: 'Amazonbot' },
  { id: 'A1.applebot-extended', name: 'robots.txt allows Applebot-Extended', points: 1, family: 'training', ua: 'Applebot-Extended' },
  // A2 no technical wall (5)
  { id: 'A2.nojs', name: 'Homepage readable without JavaScript', points: 3 },
  { id: 'A2.loginwall', name: 'No site-wide login wall on the homepage', points: 2 },
  // A3 baseline usability (5)
  { id: 'A3.https', name: 'HTTPS with a valid certificate', points: 2 },
  { id: 'A3.latency', name: 'Homepage responds in < 2.5s (median of 3)', points: 2 },
  { id: 'A3.redirects', name: 'No suspicious redirect chain (<= 2 hops, same site family)', points: 1 },
];

// L2 Legible (40 = 14 + 8 + 8 + 4 + 6), spec §3.3
const L2_CHECKS: AfrCheckDef[] = [
  // B1 llms.txt family (14)
  { id: 'B1.llms-txt', name: '/llms.txt exists and returns 200', points: 8 },
  { id: 'B1.format', name: 'llms.txt format compliant (H1 + intro + Markdown link list)', points: 4 },
  { id: 'B1.llms-full', name: '/llms-full.txt exists', points: 2 },
  // B2 structured data (8)
  { id: 'B2.jsonld', name: 'Page contains JSON-LD or microdata', points: 2 },
  { id: 'B2.core-entity', name: 'Core entity type present (Organization/WebSite/Article/Product)', points: 4 },
  { id: 'B2.rich-types', name: 'Rich types present (FAQPage/HowTo/BreadcrumbList)', points: 2 },
  // B3 semantic HTML (8)
  { id: 'B3.h1', name: 'Exactly one <h1> per page', points: 1 },
  { id: 'B3.heading-order', name: 'Heading levels do not skip (h1 -> h2 -> h3)', points: 2 },
  { id: 'B3.img-alt', name: '<img> alt coverage >= 60%', points: 2 },
  { id: 'B3.og', name: 'og:title / og:description present', points: 2 },
  { id: 'B3.lang', name: '<html lang> declared', points: 1 },
  // B4 sitemap (4)
  { id: 'B4.sitemap', name: '/sitemap.xml reachable', points: 2 },
  { id: 'B4.lastmod', name: 'Sitemap entries include lastmod', points: 1 },
  { id: 'B4.coverage', name: 'Sampled homepage links (10) >= 80% present in sitemap', points: 1 },
  // B5 content signals (6)
  { id: 'B5.word-count', name: 'Homepage extractable text >= 500 words', points: 2 },
  { id: 'B5.dates', name: 'Machine-readable dates (<time datetime> or ISO date)', points: 2 },
  { id: 'B5.about', name: 'About/contact path reachable from the homepage', points: 2 },
];

// L3 Actionable (25 = 8 + 4 + 6 + 7), spec §3.4
const L3_CHECKS: AfrCheckDef[] = [
  // C1 public API (8)
  { id: 'C1.api', name: 'Public API discoverable (llms.txt / common paths / dev subdomain)', points: 5 },
  { id: 'C1.api-docs', name: 'Human-readable API documentation', points: 2 },
  { id: 'C1.openapi', name: 'Machine-readable OpenAPI spec', points: 1 },
  // C2 agent instructions (4)
  { id: 'C2.agents-md', name: '/agents.md exists', points: 2 },
  { id: 'C2.llms-policy', name: 'llms.txt contains an agent usage policy / instructions section', points: 2 },
  // C3 MCP interface (6)
  { id: 'C3.mcp', name: 'Publicly reachable MCP server declared by the site', points: 6 },
  // C4 in-site AI features (7) — the only semi-manual check (spec §3.4)
  { id: 'C4.ai-features', name: 'In-site AI assistant / AI search / generative feature', points: 7 },
];

export const AFR_CHECKS: Record<AfrLayerId, AfrCheckDef[]> = {
  L1: L1_CHECKS,
  L2: L2_CHECKS,
  L3: L3_CHECKS,
};

export const AFR_LAYERS: AfrLayerDef[] = [
  { id: 'L1', name: LAYER_NAMES.L1, checks: L1_CHECKS },
  { id: 'L2', name: LAYER_NAMES.L2, checks: L2_CHECKS },
  { id: 'L3', name: LAYER_NAMES.L3, checks: L3_CHECKS },
];
