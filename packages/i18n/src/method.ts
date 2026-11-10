// @aiapp/i18n — machine-readable AFR standard.
// Faithful transcription of spec v1.0 §3 (lines 116-224); the bilingual /method
// page and this structure share the same vocabulary as the `checks` catalog in
// ./index.ts (engine-level ids like 'l2.sitemap' live there; standard-level
// sub-check ids like 'B1.llms-txt' live here).
//
// Cross-check: family point totals for A1 (search 9 / hybrid 6 / training 10 = 25)
// match FAMILY_MAX in packages/afr/src/ua.ts. NOTE: the spec's per-UA roster is
// authoritative here; the engine scores families as FAMILY_MAX * allowed-fraction
// over its own 14-UA roster (ua.ts AI_UAS), so family totals agree while some
// individual UA memberships differ between spec §3.2 and the engine appendix.
//
// Layer totals: L1 35 = A1 25 + A2 5 + A3 5; L2 40 = B1 14 + B2 8 + B3 8 + B4 4 + B5 6;
// L3 25 = C1 8 + C2 4 + C3 6 + C4 7.

export interface MethodCheck {
  id: string;
  /** Crawler family for A1 sub-checks: 'search' | 'hybrid' | 'training' */
  family?: string;
  /** robots.txt User-agent identifier for A1 sub-checks */
  ua?: string;
  points: number;
}

export interface MethodLayer {
  id: 'L1' | 'L2' | 'L3';
  name: { en: string; zh: string };
  weight: number;
  checks: MethodCheck[];
}

export const AFR_METHOD: {
  standard: 'AFR';
  version: string;
  layers: MethodLayer[];
  grades: { min: number; grade: string; color: string }[];
} = {
  standard: 'AFR',
  version: '1.0',
  layers: [
    {
      id: 'L1',
      name: { en: 'Reachability', zh: '可达层' },
      weight: 35,
      checks: [
        // A1 robots.txt AI crawler policy — 25 points (spec §3.2)
        // search-type 9: OAI-SearchBot 4 / PerplexityBot 3 / ChatGPT-User 2
        { id: 'A1.OAI-SearchBot', family: 'search', ua: 'OAI-SearchBot', points: 4 },
        { id: 'A1.PerplexityBot', family: 'search', ua: 'PerplexityBot', points: 3 },
        { id: 'A1.ChatGPT-User', family: 'search', ua: 'ChatGPT-User', points: 2 },
        // hybrid 6: Google-Extended 3 / Applebot-Assistant 2 / Bingbot 1
        { id: 'A1.Google-Extended', family: 'hybrid', ua: 'Google-Extended', points: 3 },
        { id: 'A1.Applebot-Assistant', family: 'hybrid', ua: 'Applebot-Assistant', points: 2 },
        { id: 'A1.Bingbot', family: 'hybrid', ua: 'Bingbot', points: 1 },
        // training 10: GPTBot 3 / ClaudeBot 2 / CCBot 1 / Bytespider 1 /
        //              meta-externalagent 1 / Amazonbot 1 / Applebot-Extended 1
        { id: 'A1.GPTBot', family: 'training', ua: 'GPTBot', points: 3 },
        { id: 'A1.ClaudeBot', family: 'training', ua: 'ClaudeBot', points: 2 },
        { id: 'A1.CCBot', family: 'training', ua: 'CCBot', points: 1 },
        { id: 'A1.Bytespider', family: 'training', ua: 'Bytespider', points: 1 },
        { id: 'A1.meta-externalagent', family: 'training', ua: 'meta-externalagent', points: 1 },
        { id: 'A1.Amazonbot', family: 'training', ua: 'Amazonbot', points: 1 },
        { id: 'A1.Applebot-Extended', family: 'training', ua: 'Applebot-Extended', points: 1 },
        // A2 no technical wall — 5 points (3 + 2)
        { id: 'A2.no-js-body', points: 3 }, // readable body for no-JS UA (>=80 words or <noscript>)
        { id: 'A2.no-login-wall', points: 2 }, // no site-wide forced login wall
        // A3 basic availability — 5 points (2 + 2 + 1)
        { id: 'A3.https-valid', points: 2 }, // HTTPS with valid certificate
        { id: 'A3.response-time', points: 2 }, // homepage response < 2.5s (median of 3)
        { id: 'A3.redirect-chain', points: 1 }, // no suspicious redirect chain (<=2 hops, same site family)
      ],
    },
    {
      id: 'L2',
      name: { en: 'Legibility', zh: '可懂层' },
      weight: 40,
      checks: [
        // B1 llms.txt family — 14 points (8 + 4 + 2)
        { id: 'B1.llms-txt', points: 8 }, // /llms.txt exists and returns 200
        { id: 'B1.format', points: 4 }, // H1 + intro + parseable Markdown link list
        { id: 'B1.llms-full-txt', points: 2 }, // /llms-full.txt exists
        // B2 structured data — 8 points (2 + 4 + 2)
        { id: 'B2.json-ld', points: 2 }, // JSON-LD or microdata present
        { id: 'B2.core-entity', points: 4 }, // Organization / Website / Article / Product
        { id: 'B2.rich-type', points: 2 }, // FAQPage / HowTo / BreadcrumbList
        // B3 semantic HTML — 8 points (1 + 2 + 2 + 2 + 1)
        { id: 'B3.unique-h1', points: 1 }, // exactly one <h1> per page
        { id: 'B3.heading-order', points: 2 }, // heading levels do not skip (h1->h2->h3)
        { id: 'B3.img-alt', points: 2 }, // <img> alt coverage >= 60%
        { id: 'B3.og-tags', points: 2 }, // og:title / og:description present
        { id: 'B3.html-lang', points: 1 }, // <html lang> declared
        // B4 sitemap — 4 points (2 + 1 + 1)
        { id: 'B4.sitemap-reachable', points: 2 }, // /sitemap.xml reachable (robots-declared or direct)
        { id: 'B4.lastmod', points: 1 }, // contains lastmod
        { id: 'B4.link-coverage', points: 1 }, // >=80% of sampled homepage links in sitemap (10 sampled)
        // B5 content signals — 6 points (2 + 2 + 2)
        { id: 'B5.word-count', points: 2 }, // homepage extractable text >= 500 words
        { id: 'B5.machine-dates', points: 2 }, // machine-readable dates (<time datetime> or ISO)
        { id: 'B5.about-contact', points: 2 }, // About/contact path reachable from homepage
      ],
    },
    {
      id: 'L3',
      name: { en: 'Actionability', zh: '可交互层' },
      weight: 25,
      checks: [
        // C1 public API — 8 points (5 + 2 + 1)
        { id: 'C1.public-api', points: 5 }, // public API detected (llms.txt / common paths / dev subdomain)
        { id: 'C1.api-docs', points: 2 }, // human-readable API documentation
        { id: 'C1.openapi-spec', points: 1 }, // machine-readable OpenAPI spec
        // C2 agent instructions — 4 points (2 + 2)
        { id: 'C2.agents-md', points: 2 }, // /agents.md exists
        { id: 'C2.llms-agent-policy', points: 2 }, // agent policy/instructions section in llms.txt (Optional part)
        // C3 MCP interface — 6 points
        { id: 'C3.mcp-server', points: 6 }, // publicly available MCP server, URL reachable
        // C4 in-site AI features — 7 points
        { id: 'C4.ai-features', points: 7 }, // in-site AI assistant / AI search / generative features
      ],
    },
  ],
  // Spec §3.5 (lines 209-217): A 85–100 / B 70–84 / C 50–69 / D 30–49 / F 0–29;
  // colors = design tokens §10.2 (grade-a..grade-f)
  grades: [
    { min: 85, grade: 'A', color: '#3ECFAD' },
    { min: 70, grade: 'B', color: '#8BD450' },
    { min: 50, grade: 'C', color: '#F2C94C' },
    { min: 30, grade: 'D', color: '#F2994A' },
    { min: 0, grade: 'F', color: '#EB5757' },
  ],
};
