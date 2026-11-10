// 14 个 AI 爬虫 UA 家族（方案书 §14 附录 A，参考 github.com/ai-robots-txt/ai.robots.txt）
// 三分法计分: 搜索型 9 / 混合型 6 / 训练型 10 = robots 政策 25 分

export type UaFamily = 'search' | 'hybrid' | 'training';

export interface AiUa {
  /** robots.txt 中的 User-agent 标识（不含浏览器 UA 前缀差异） */
  ua: string;
  family: UaFamily;
  vendor: string;
}

/** 家族满分（方案书 §3 L1） */
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

/** 14 个 UA 家族（顺序固定，保证结果可复算） */
export const AI_UAS: readonly AiUa[] = [
  // 搜索型（9 分）：为 AI 回答抓取实时/索引内容
  { ua: 'OAI-SearchBot', family: 'search', vendor: 'OpenAI' },
  { ua: 'Claude-SearchBot', family: 'search', vendor: 'Anthropic' },
  { ua: 'PerplexityBot', family: 'search', vendor: 'Perplexity' },
  { ua: 'Googlebot', family: 'search', vendor: 'Google' },
  // 混合型（6 分）：用户触发抓取 + 检索增强训练
  { ua: 'ChatGPT-User', family: 'hybrid', vendor: 'OpenAI' },
  { ua: 'Claude-User', family: 'hybrid', vendor: 'Anthropic' },
  { ua: 'Perplexity-User', family: 'hybrid', vendor: 'Perplexity' },
  { ua: 'Google-Extended', family: 'hybrid', vendor: 'Google' },
  // 训练型（10 分）：用于模型训练语料
  { ua: 'GPTBot', family: 'training', vendor: 'OpenAI' },
  { ua: 'ClaudeBot', family: 'training', vendor: 'Anthropic' },
  { ua: 'CCBot', family: 'training', vendor: 'Common Crawl' },
  { ua: 'Bytespider', family: 'training', vendor: 'ByteDance' },
  { ua: 'Amazonbot', family: 'training', vendor: 'Amazon' },
  { ua: 'Applebot-Extended', family: 'training', vendor: 'Apple' },
];
