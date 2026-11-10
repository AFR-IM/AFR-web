// Sponsored-slot fixtures for M2 (spec §10.5 positions 1 and 2).
// Copy is synthetic sample content — real ad-server payloads replace this later.
// A slot only renders when its domain resolves in the site list, because the
// block must show that site's REAL GradeRing (spec §10.5) — see resolvableAds().

import { listSites } from '../../data/loader.ts';

export interface AdFixture {
  domain: string;
  headline: string;
  body: string;
  headlineZh?: string;
  bodyZh?: string;
}

export const ADS: AdFixture[] = [
  {
    domain: 'openai.com',
    headline: 'Build with the OpenAI Platform',
    body: 'Models, tools, and docs for shipping AI features — AgentKit, Realtime, and the API.',
    headlineZh: '使用 OpenAI 平台构建',
    bodyZh: '面向 AI 应用的模型、工具与文档——AgentKit、Realtime 与 API。',
  },
  {
    domain: 'stackoverflow.com',
    headline: 'Stack Overflow for Teams',
    body: 'Trusted developer knowledge, now with AI-assisted answers inside your workspace.',
    headlineZh: 'Stack Overflow for Teams',
    bodyZh: '开发者信赖的知识库，现支持工作区内的 AI 辅助回答。',
  },
];

/** Ads whose domain exists in the current site list (so a real GradeRing can be shown). */
export function resolvableAds(): AdFixture[] {
  const domains = new Set(listSites().map((s) => s.domain));
  return ADS.filter((a) => domains.has(a.domain));
}
