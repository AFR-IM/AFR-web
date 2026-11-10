// 14 AI crawler UA families (spec §14 appendix A, based on github.com/ai-robots-txt/ai.robots.txt)
// Three-way scoring: search-type 9 / hybrid 6 / training 10 = 25 points for the robots policy

export type UaFamily = 'search' | 'hybrid' | 'training';

export interface AiUa {
  /** User-agent identifier as written in robots.txt (ignoring browser UA prefix differences) */
  ua: string;
  family: UaFamily;
  vendor: string;
}

/** Max points per family (spec §3 L1) */
export const FAMILY_MAX: Record<UaFamily, number> = {
  search: 9,
  hybrid: 6,
  training: 10,
};

export const FAMILY_NAME: Record<UaFamily, { en: string; zh: string }> = {
  search: { en: 'Search-type crawlers', zh: '搜索型爬虫' },
  hybrid: { en: 'Hybrid crawlers', zh: '混合型爬虫' },
  training: { en: 'Training crawlers', zh: '训练型爬虫' },
};

/** The 14 UA families (fixed order so results stay reproducible) */
export const AI_UAS: readonly AiUa[] = [
  // Search-type (9 points): fetch live/indexed content for AI answers
  { ua: 'OAI-SearchBot', family: 'search', vendor: 'OpenAI' },
  { ua: 'Claude-SearchBot', family: 'search', vendor: 'Anthropic' },
  { ua: 'PerplexityBot', family: 'search', vendor: 'Perplexity' },
  { ua: 'Googlebot', family: 'search', vendor: 'Google' },
  // Hybrid (6 points): user-triggered fetches + retrieval-augmented training
  { ua: 'ChatGPT-User', family: 'hybrid', vendor: 'OpenAI' },
  { ua: 'Claude-User', family: 'hybrid', vendor: 'Anthropic' },
  { ua: 'Perplexity-User', family: 'hybrid', vendor: 'Perplexity' },
  { ua: 'Google-Extended', family: 'hybrid', vendor: 'Google' },
  // Training (10 points): used as model training corpus
  { ua: 'GPTBot', family: 'training', vendor: 'OpenAI' },
  { ua: 'ClaudeBot', family: 'training', vendor: 'Anthropic' },
  { ua: 'CCBot', family: 'training', vendor: 'Common Crawl' },
  { ua: 'Bytespider', family: 'training', vendor: 'ByteDance' },
  { ua: 'Amazonbot', family: 'training', vendor: 'Amazon' },
  { ua: 'Applebot-Extended', family: 'training', vendor: 'Apple' },
];
