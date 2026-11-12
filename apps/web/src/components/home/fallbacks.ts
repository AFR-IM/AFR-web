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
  // incremental list pagination (category + search "Show more")
  loadMoreDone: { en: 'All {n} shown', zh: '已显示全部 {n} 个' },
  loadMoreProgress: { en: 'Showing {n} of {t}', zh: '已显示 {n} / {t}' },
  loadMoreError: {
    en: "Couldn't load more — check your connection and try again.",
    zh: '无法加载更多——请检查网络后重试。',
  },
  // search page — "not collected yet" scan flow
  scanHeading: { en: 'Not collected yet', zh: '尚未收录' },
  scanDesc: {
    en: "We have not scanned this site yet. Start a scan now — the report usually lands in about 3 minutes and appears right here.",
    zh: '我们还没有扫描过这个站点。现在开始扫描——报告通常约 3 分钟后生成，并直接显示在这里。',
  },
  scanBtn: { en: 'Scan it now (~3 min)', zh: '立即扫描（约 3 分钟）' },
  scanBusy: { en: 'Starting the scan…', zh: '正在启动扫描…' },
  scanQueued: {
    en: 'Queued — about {eta} left. We check for the report every 10 seconds.',
    zh: '已入队——预计还需 {eta}。我们每 10 秒查询一次报告。',
  },
  scanPolling: { en: 'Scanning… about {eta} left.', zh: '扫描中……预计还需 {eta}。' },
  scanStill: {
    en: 'Still scanning — we keep checking every 10 seconds.',
    zh: '仍在扫描——我们每 10 秒继续查询一次。',
  },
  scanTimeout: {
    en: 'The report has not landed yet — the scan may still be running. Try again in a few minutes.',
    zh: '报告尚未生成——扫描可能仍在进行。请几分钟后再试。',
  },
  scanRate: {
    en: 'Too many requests — retry in {eta}.',
    zh: '请求过于频繁——请在 {eta} 后重试。',
  },
  scanError: { en: 'Could not start the scan — please try again.', zh: '无法启动扫描——请重试。' },
  scanNet: {
    en: 'Connection problem — the request never reached the server.',
    zh: '网络异常——请求未能送达服务器。',
  },
  scanResultOpen: { en: 'Open full report', zh: '查看完整报告' },
  // submit page — real POST /api/v1/submissions flow
  submitNoteLabel: { en: 'Note (optional)', zh: '备注（可选）' },
  submitNotePlaceholder: {
    en: 'Anything the scanner should know?',
    zh: '有什么需要扫描器了解的信息？',
  },
  submitBusy: { en: 'Submitting…', zh: '提交中…' },
  submitQueued: {
    en: '{domain} is queued — about {eta} until it is collected. You will find it via search in ~3 min.',
    zh: '{domain} 已入队——约 {eta} 后完成收录。约 3 分钟后即可在搜索中找到它。',
  },
  submitRateLimited: {
    en: 'Submission limit reached from this network — try again later.',
    zh: '该网络的提交次数已达上限——请稍后再试。',
  },
  submitError: {
    en: 'Could not reach the server — please try again.',
    zh: '无法连接服务器——请重试。',
  },
  // detail page — real re-scan flow (POST /api/v1/rescan + polling)
  rescanQueuedEta: { en: 'queued · ~{n} min', zh: '已入队 · 约 {n} 分钟' },
  rescanPolling: { en: 'watching for the new report…', zh: '正在等待新报告……' },
  rescanUpdated: { en: 'updated ✓ — refreshing…', zh: '已更新 ✓ ——正在刷新……' },
  rescanTimeout: {
    en: 'still queued — refresh this page in a few minutes',
    zh: '仍在队列——请几分钟后刷新本页',
  },
  rescanThrottle: {
    en: 'One re-scan per 24h — it protects the free scanning budget. Next re-scan in {t}.',
    zh: '每 24 小时一次重扫——保护免费扫描额度。{t} 后可再次重扫。',
  },
  rescanUnknown: {
    en: 'This site is not in the directory yet.',
    zh: '该站点尚未收录。',
  },
  rescanError: { en: 'Could not reach the server — try again.', zh: '无法连接服务器——请重试。' },
  // detail page — owner verification panel
  verifyTitle: { en: 'Are you the owner?', zh: '你是站方吗？' },
  verifyDesc: {
    en: 'Verify that you control this domain to publish a statement and manage this report.',
    zh: '验证你对该域名的控制权，即可发布声明并管理本报告。',
  },
  verifyCta: { en: 'Verify this site', zh: '验证此站点' },
  verifyBusy: { en: 'Starting…', zh: '正在发起验证……' },
  verifyMethods: { en: 'Verification method', zh: '验证方式' },
  verifyFileTab: { en: 'File (recommended)', zh: '文件（推荐）' },
  verifyMetaTab: { en: 'Meta', zh: 'Meta 标签' },
  verifyDnsTab: { en: 'DNS', zh: 'DNS 记录' },
  verifyFileUrl: { en: 'File URL', zh: '文件地址' },
  verifyFileContent: { en: 'File content', zh: '文件内容' },
  verifyMetaTag: { en: 'Meta tag', zh: 'Meta 标签' },
  verifyDnsName: { en: 'Record name', zh: '记录名' },
  verifyDnsValue: { en: 'Record value', zh: '记录值' },
  verifyDnsType: { en: 'Record type', zh: '记录类型' },
  verifyPlace: {
    en: 'Place this on your site, then run the check.',
    zh: '将它放到你的站点上，然后运行检查。',
  },
  verifyRunCheck: { en: 'Run check', zh: '运行检查' },
  verifyChecking: { en: 'Checking…', zh: '检查中……' },
  verifyOk: { en: 'Verified ✓', zh: '已验证 ✓' },
  verifyOkNote: {
    en: 'You can now publish a statement below.',
    zh: '现在可以在下方发布声明。',
  },
  verifyFailTitle: { en: 'Not verified yet', zh: '尚未通过验证' },
  verifyRetryNote: {
    en: 'Fix what failed, then run the check again.',
    zh: '修正未通过的项后可再次运行检查。',
  },
  verifyRate: {
    en: 'Too many attempts — try again in {t}.',
    zh: '尝试过于频繁——请在 {t} 后重试。',
  },
  verifyError: { en: 'Could not reach the server — try again.', zh: '无法连接服务器——请重试。' },
  verifyMethodFile: { en: 'File', zh: '文件' },
  verifyMethodMeta: { en: 'Meta', zh: 'Meta' },
  verifyMethodDns: { en: 'DNS', zh: 'DNS' },
  // detail page — owner claim (statement) form
  claimFormTitle: { en: 'Publish a statement', zh: '发布声明' },
  claimLabel: { en: 'Your statement', zh: '你的声明' },
  claimPlaceholder: {
    en: 'Answer your score in up to 200 characters…',
    zh: '用 200 字以内回应你的评分……',
  },
  claimSubmit: { en: 'Submit statement', zh: '提交声明' },
  claimBusy: { en: 'Submitting…', zh: '提交中……' },
  claimDone: {
    en: 'Submitted — it will be published after a quick review.',
    zh: '已提交——经快速审核后发布。',
  },
  claimNotVerified: {
    en: 'Verify your site first, then publish your statement.',
    zh: '请先验证站点，再发布声明。',
  },
  claimInvalid: {
    en: 'Please write a statement (200 characters max).',
    zh: '请填写声明（最多 200 字）。',
  },
  claimError: { en: 'Could not submit — try again.', zh: '无法提交——请重试。' },
  // detail page — runtime views counter
  viewsLabel: { en: 'Views', zh: '浏览' },
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
