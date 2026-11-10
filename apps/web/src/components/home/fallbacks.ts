// Inline EN/ZH fallbacks for UI keys the i18n catalog does not define yet.
// packages/i18n is owned by another writer — never edit it from here; every key
// in COPY below is reported as "missing from catalog" in the delivery notes.
// If the catalog gains a key, uiText() prefers the catalog automatically.

import type { Locale } from '../../i18n/loader.ts';

export interface Copy {
  en: string;
  zh: string;
}

export const COPY = {
  // counts (safety net — the catalog defines siteCount today)
  siteCount: { en: '{n} sites', zh: '{n} 个站点' },
  // homepage hero stats
  avgScore: { en: 'avg score', zh: '平均分' },
  // search page
  searchTitle: { en: 'Search', zh: '搜索' },
  // category page
  sortBy: { en: 'Sort by', zh: '排序' },
  // sponsored slot (spec §10.5)
  visit: { en: 'Visit', zh: '访问' },
  // submit page (P4)
  submitFlow: { en: 'How it works', zh: '流程说明' },
  submitInvalid: {
    en: 'Please enter a valid domain, e.g. example.com',
    zh: '请输入有效域名，例如 example.com',
  },
  submitConfirm: {
    en: '{domain} is ready for the scan queue. The scanner will publish its AFR report once the queue runs.',
    zh: '{domain} 已准备好进入扫描队列。扫描队列运行后将发布它的 AFR 报告。',
  },
  submitAfterTitle: { en: 'What happens next', zh: '接下来会发生什么' },
  submitAfterBody: {
    en: 'Your domain is queued, scanned against public signals only, then scored 0–100 and published with its full evidence chain. Nothing is hidden behind a login and scores cannot be bought.',
    zh: '域名入队后，我们只采集公开信号进行扫描，随后给出 0–100 分并连同完整证据链一起发布。全程无需登录，付费不能改分。',
  },
  submitPoliteNote: {
    en: 'Scanning is polite and transparent: the bot identifies itself and honors your robots.txt.',
    zh: '扫描公开且克制：爬虫会表明身份，并遵守你的 robots.txt。',
  },
  // empty category page
  emptyCategory: {
    en: 'No sites in this category yet.',
    zh: '该分类还没有收录站点。',
  },
} satisfies Record<string, Copy>;

export type CopyKey = keyof typeof COPY;

/** Catalog-first text lookup with a bilingual inline fallback (never edit packages/i18n). */
export function uiText(ui: Record<string, string>, key: CopyKey, locale: Locale): string {
  const fromCatalog = ui[key];
  if (fromCatalog !== undefined && fromCatalog !== '') return fromCatalog;
  const fb = COPY[key];
  return locale === 'zh-CN' ? fb.zh : fb.en;
}

/** Replace the `{n}` placeholder used by the `siteCount` catalog string. */
export function countLabel(template: string, n: number): string {
  return template.replace('{n}', String(n));
}

/** Convenience: catalog siteCount + `{n}` substitution in one call.
 *  English singular for 1 (the catalog template is always plural). */
export function sitesLabel(ui: Record<string, string>, locale: Locale, n: number): string {
  const s = countLabel(uiText(ui, 'siteCount', locale), n);
  return locale !== 'zh-CN' && n === 1 ? s.replace(/\bsites\b/, 'site') : s;
}
