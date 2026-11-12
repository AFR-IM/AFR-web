// Fixture data for development ONLY — shape mirrors what fetch-data.mjs will
// generate from AFR-data scans/. Scores/grades below are synthetic samples used
// to exercise layout, never presented as real ratings in production.

import type { HomeData, SiteDetail } from './types.ts';

export const FIXTURE_CATEGORIES = [
  { slug: 'dev-tools', count: 3 },
  { slug: 'ai-tools', count: 2 },
  { slug: 'reference', count: 2 },
  { slug: 'news', count: 1 },
];

export const FIXTURE_HOME: HomeData = {
  generatedAt: '2026-11-10T12:00:00Z',
  total: 8,
  avgScore: 58,
  distribution: { A: 1, B: 2, C: 2, D: 2, F: 1 },
  categories: FIXTURE_CATEGORIES,
  leaderboard: [
    { domain: 'github.com', title: 'GitHub · Where software is built', score: 91, grade: 'A', strategyTag: 'AI-Open', category: 'dev-tools', rankSource: 4, verified: true, scannedAt: '2026-11-10T11:40:00Z' },
    { domain: 'wikipedia.org', title: 'Wikipedia, the free encyclopedia', score: 82, grade: 'B', strategyTag: 'AI-Open', category: 'reference', rankSource: 9, verified: true, scannedAt: '2026-11-10T11:41:00Z' },
    { domain: 'stackoverflow.com', title: 'Stack Overflow — Where developers learn', score: 74, grade: 'B', strategyTag: 'Middle-Path', category: 'dev-tools', rankSource: 36, scannedAt: '2026-11-10T11:42:00Z' },
    { domain: 'reuters.com', title: 'Reuters | Breaking International News', score: 61, grade: 'C', strategyTag: 'Middle-Path', category: 'news', rankSource: 88, scannedAt: '2026-11-10T11:43:00Z' },
    { domain: 'openai.com', title: 'OpenAI', score: 57, grade: 'C', strategyTag: 'AI-Open', category: 'ai-tools', rankSource: 120, scannedAt: '2026-11-10T11:44:00Z' },
    { domain: 'nytimes.com', title: 'The New York Times', score: 44, grade: 'D', strategyTag: 'AI-Closed', category: 'news', rankSource: 74, scannedAt: '2026-11-10T11:45:00Z' },
    { domain: 'linkedin.com', title: 'LinkedIn: Log In or Sign Up', score: 33, grade: 'D', strategyTag: 'AI-Closed', category: 'social' as string, rankSource: 15, scannedAt: '2026-11-10T11:46:00Z' },
    { domain: 'example.com', title: 'Example Domain', score: 18, grade: 'F', strategyTag: 'Unconfigured', category: 'other' as string, rankSource: 900, scannedAt: '2026-11-10T11:47:00Z' },
  ],
  latest: [],
};

FIXTURE_HOME.latest = [...FIXTURE_HOME.leaderboard].reverse();

export const FIXTURE_DETAILS: SiteDetail[] = [
  {
    ...FIXTURE_HOME.leaderboard[0]!,
    engineVersion: 'afr-1.0.0',
    scannerVersion: 'afr-im-bot/1.0',
    history: [
      { date: '2026-11-03', score: 89, grade: 'A' },
      { date: '2026-11-10', score: 91, grade: 'A' },
    ],
    breakdown: { 'l1.robots.ai-policy': 25, 'l1.no-tech-wall': 5, 'l1.basic-availability': 5 },
    layers: [
      {
        layer: 'L1', name: 'Reachability', awarded: 35, max: 35,
        checks: [
          { id: 'l1.robots.ai-policy', layer: 'L1', name: 'robots.txt AI crawler policy (14 UA families)', awarded: 25, max: 25, status: 'pass', evidence: { source: 'robots.txt', detail: 'search-type 9.00/9 · hybrid 6.00/6 · training 10.00/10; strategy tag AI-Open.' } },
          { id: 'l1.no-tech-wall', layer: 'L1', name: 'No technical wall for transparent AI UA', awarded: 5, max: 5, status: 'pass', evidence: { source: 'GET / (transparent AI UA)', detail: 'GET / → 200' } },
          { id: 'l1.basic-availability', layer: 'L1', name: 'Basic availability', awarded: 5, max: 5, status: 'pass', evidence: { source: 'GET /', detail: 'GET / → 200, full HTML document returned' } },
        ],
      },
      {
        layer: 'L2', name: 'Legibility', awarded: 38, max: 40,
        checks: [
          { id: 'l2.llms-txt', layer: 'L2', name: 'llms.txt family', awarded: 14, max: 14, status: 'pass', evidence: { source: 'GET /llms.txt', detail: 'HTTP 200, valid H1 + markdown link list' } },
          { id: 'l2.sitemap', layer: 'L2', name: 'Sitemap', awarded: 2, max: 4, status: 'partial', evidence: { source: 'GET /sitemap.xml', detail: 'HTTP 200 but no lastmod entries' } },
        ],
      },
      {
        layer: 'L3', name: 'Actionability', awarded: 18, max: 25,
        checks: [
          { id: 'l3.mcp', layer: 'L3', name: 'MCP interface', awarded: 0, max: 6, status: 'fail', evidence: { source: 'probe', detail: 'no public MCP server declared' } },
        ],
      },
    ],
  },
];
