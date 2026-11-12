// @afr/i18n — locale catalogs for AFR.IM.
// Single source of localized vocabulary for the web app (apps/web/src/i18n/loader.ts
// imports `catalogs` / `getCatalog` from this module — do not rename exports).
//
// All source code and comments are in English; zh-CN values are Chinese translations
// (UA names, file names like llms.txt, and protocol terms stay in English).
//
// Content sources (spec v1.0):
//   - checks: engine CheckResult ids from packages/afr/src/{l1,l2,l3}.ts, EN = `name` in source
//   - layers: spec §3.1 three-layer model
//   - grades: spec §3.5 (lines 209-217)
//   - strategies: spec §3.2 A1 StrategyTag
//   - categories: spec §7.1 (lines 418-425), 14 slugs
//   - ui: spec §10.3 pages P1-P7 vocabulary

export type Locale = 'en' | 'zh-CN';

export interface Catalog {
  ui: Record<string, string>;
  checks: Record<string, string>; // engine check id -> localized name
  layers: Record<string, string>; // 'L1' | 'L2' | 'L3' -> name
  grades: Record<string, { label: string; slogan: string }>;
  strategies: Record<string, { label: string; desc: string }>;
  categories: Record<string, { name: string; blurb: string }>; // 14 slugs
}

const en: Catalog = {
  ui: {
    // Global chrome / nav (Base.astro + P1-P7)
    siteName: 'AFR.IM — AI Friendliness Directory',
    tagline: 'Objective AI-friendliness ratings for every website.',
    navHome: 'Home',
    navCategories: 'Categories',
    navMethod: 'Method',
    navSubmit: 'Submit',
    navBot: 'For Bots',
    navAbout: 'About',
    searchPlaceholder: 'Search a domain…',
    searchEmpty: 'No site matches that search.',
    searchSubmitHint: 'Not found? Submit it for scanning.',
    themeToggle: 'Toggle theme',
    footerPledge: 'Scores cannot be bought: payments never affect ratings.',
    footerRights: '© 2026 AFR.IM · All rights reserved.',

    // P1 home
    heroSlogan: 'See how friendly each website is to AI.',
    heroSub: 'AFR rates open web signals anyone can reproduce — facts and evidence, not opinions.',
    distributionTitle: 'AI openness distribution',
    leaderboardTitle: 'Top rated',
    latestTitle: 'Recently added',
    viewAll: 'View all',
    categoriesTitle: 'Browse by category',
    siteCount: '{n} sites',
    avgScore: 'avg score',
    searchTitle: 'Search',
    sortBy: 'Sort by',
    visit: 'Visit',
    submitFlow: 'How it works',
    submitInvalid: 'Please enter a valid domain, e.g. example.com',
    submitConfirm:
      '{domain} is ready for the scan queue. The scanner will publish its AFR report once the queue runs.',
    submitAfterTitle: 'What happens next',
    submitAfterBody:
      'Your domain is queued, scanned against public signals only, then scored 0–100 and published with its full evidence chain. Nothing is hidden behind a login and scores cannot be bought.',
    submitPoliteNote:
      'Scanning is polite and transparent: the bot identifies itself and honors your robots.txt.',
    emptyCategory: 'No sites in this category yet.',
    pendingBadge: 'Pending',
    pendingNotice:
      'Not ratable — neither the homepage nor robots.txt could be read, so no evidence exists to score. Excluded from rankings until a rescan succeeds.',

    // P1 home — "How we rate" explainer (short labels; body paragraphs stay page content)
    explainerTitle: 'How we rate',
    explainerScoreTitle: 'What the score measures',
    explainerFriendlyTitle: 'What makes a site AI-friendly',
    explore: 'Explore',
    docsLabel: 'API documentation',
    dataUpdated: 'Directory data last updated',

    // P2 category/listing page
    sortScore: 'Score',
    sortRank: 'Rank',
    sortNew: 'Newest',
    filterGrade: 'Grade',
    filterLang: 'Language',
    filterTag: 'Tag',
    filterCategory: 'Category',
    clearFilters: 'Clear filters',
    loading: 'Loading…',
    loadMore: 'Load more',
    // incremental list pagination (category + search "Show more")
    loadMoreDone: 'All {n} shown',
    loadMoreProgress: 'Showing {n} of {t}',
    loadMoreError: "Couldn't load more — check your connection and try again.",
    // Search page — "not collected yet" scan flow
    scanHeading: 'Not collected yet',
    scanDesc:
      'We have not scanned this site yet. Start a scan now — the report usually lands in about 3 minutes and appears right here.',
    scanBtn: 'Scan it now (~3 min)',
    scanBusy: 'Starting the scan…',
    scanQueued: 'Queued — about {eta} left. We check for the report every 10 seconds.',
    scanPolling: 'Scanning… about {eta} left.',
    scanStill: 'Still scanning — we keep checking every 10 seconds.',
    scanTimeout:
      'The report has not landed yet — the scan may still be running. Try again in a few minutes.',
    scanRate: 'Too many requests — retry in {eta}.',
    scanError: 'Could not start the scan — please try again.',
    scanNet: 'Connection problem — the request never reached the server.',
    scanResultOpen: 'Open full report',

    // Shared card/detail vocabulary
    score: 'Score',
    grade: 'Grade',
    strategy: 'Strategy',
    evidence: 'Evidence',
    sponsored: 'Sponsored',
    notFound: 'Site not found.',
    notFoundCta: 'Submit it for scanning',

    // P3 detail page
    reportTitle: 'AFR report',
    evidenceTitle: 'Evidence chain',
    statementTitle: "Owner's statement",
    statementEmpty: 'The owner has not left a statement yet.',
    verifiedOwner: 'Verified owner',
    scanTime: 'Scanned',
    addedOn: 'Added',
    historyTitle: 'Score history',
    rescan: 'Re-scan',
    rescanQueued: 'Re-scan queued — check back later.',
    // detail page — real re-scan flow (POST /api/v1/rescan + polling)
    rescanQueuedEta: 'queued · ~{n} min',
    rescanPolling: 'watching for the new report…',
    rescanUpdated: 'updated ✓ — refreshing…',
    rescanTimeout: 'still queued — refresh this page in a few minutes',
    rescanThrottle:
      'One re-scan per 30 minutes — it protects the free scanning budget. Next re-scan in {t}.',
    rescanUnknown: 'This site is not in the directory yet.',
    rescanError: 'Could not reach the server — try again.',
    rescanQuota: 'Daily scan write quota exhausted — restores at 00:00 UTC.',
    badgeEmbed: 'Embed badge',
    badgeTitle: 'Get your badge',
    copyHtml: 'Copy HTML embed',
    copyMarkdown: 'Copy Markdown',
    copy: 'Copy',
    copied: 'Copied',
    statusPending: 'Pending scan',
    statusDeclined: 'Scan declined',
    // detail page — views counter, owner verification, claim form, evidence microcopy
    viewsLabel: 'Views',
    verifyTitle: 'Are you the owner?',
    verifyDesc:
      'Verify that you control this domain to publish a statement and manage this report.',
    verifyCta: 'Verify this site',
    verifyBusy: 'Starting…',
    verifyMethods: 'Verification method',
    verifyFileTab: 'File (recommended)',
    verifyMetaTab: 'Meta',
    verifyDnsTab: 'DNS',
    verifyFileUrl: 'File URL',
    verifyFileContent: 'File content',
    verifyMetaTag: 'Meta tag',
    verifyDnsName: 'Record name',
    verifyDnsValue: 'Record value',
    verifyDnsType: 'Record type',
    verifyPlace: 'Place this on your site, then run the check.',
    verifyRunCheck: 'Run check',
    verifyChecking: 'Checking…',
    verifyOk: 'Verified ✓',
    verifyOkNote: 'You can now publish a statement below.',
    verifyFailTitle: 'Not verified yet',
    verifyRetryNote: 'Fix what failed, then run the check again.',
    verifyRate: 'Too many attempts — try again in {t}.',
    verifyError: 'Could not reach the server — try again.',
    verifyMethodFile: 'File',
    verifyMethodMeta: 'Meta',
    verifyMethodDns: 'DNS',
    claimFormTitle: 'Publish a statement',
    claimLabel: 'Your statement',
    claimPlaceholder: 'Answer your score in up to 200 characters…',
    claimSubmit: 'Submit statement',
    claimBusy: 'Submitting…',
    claimDone: 'Submitted — it will be published after a quick review.',
    claimNotVerified: 'Verify your site first, then publish your statement.',
    claimInvalid: 'Please write a statement (200 characters max).',
    claimError: 'Could not submit — try again.',
    claimHint: 'Verified owners can publish up to 200 characters here.',
    evidencePrinciple: 'No evidence, no points: every awarded point above links to its raw source.',
    checksLabel: 'checks',
    evidenceNone: 'No evidence recorded for this row.',
    sourceLabel: 'source',
    checkIdLabel: 'check id',
    historyEmpty: 'No scans yet.',
    outOf100: 'out of 100',

    // P4 submit page
    submitTitle: 'Submit a site',
    submitStep1: 'Enter a domain — it joins the scan queue',
    submitStep2: 'The scanner collects public signals',
    submitStep3: 'The AFR score and report go live',
    submitDomainLabel: 'Domain',
    submitCta: 'Submit domain',
    submitDisclaimer: 'Rate-limited; existing domains open their detail page instead.',
    // submit page — real POST /api/v1/submissions flow
    submitNoteLabel: 'Note (optional)',
    submitNotePlaceholder: 'Anything the scanner should know?',
    submitBusy: 'Submitting…',
    submitQueued:
      '{domain} is queued — about {eta} until it is collected. You will find it via search in ~3 min.',
    submitRateLimited: 'Submission limit reached from this network — try again later.',
    submitError: 'Could not reach the server — please try again.',

    // P5 method page
    methodTitle: 'The AFR standard',
    methodIntro: 'AFR scores every site 0–100 across three layers: reachability, legibility, actionability.',
    engineVersion: 'Engine version',
    recomputeTitle: 'Recompute any score yourself',
    neutralityStatement: 'Paying never changes a score.',
    methodLicense: 'AFR v1.0 published under CC BY 4.0.',

    // P6 badge page
    badgeAntiForgery: 'Official badges always load from AFR.IM — click one to verify it.',
    // detail/badge page — embed card note
    badgeEmbedNote:
      'Official badges are only served from AFR.IM — clicking one opens this site’s report.',

    // P7 about / bot / offline
    aboutTitle: 'About AFR',
    botTitle: 'Bot etiquette',
    offlineTitle: 'You are offline',
    offlineHint: 'Showing the last synced directory data.',
    // P7 offline card — sync details
    backToDirectory: 'Back to the directory',
    lastSync: 'Last sync',
    cachedSites: 'Cached sites',
  },

  // Engine check ids (packages/afr/src/l1.ts, l2.ts, l3.ts) — EN values = `name` in source
  checks: {
    'l1.robots.ai-policy': 'robots.txt AI crawler policy (14 UA families)',
    'l1.no-tech-wall': 'No technical wall for transparent AI UA',
    'l1.basic-availability': 'Basic availability',
    'l2.llms-family': 'llms.txt family',
    'l2.structured-data': 'Structured data (JSON-LD)',
    'l2.semantic-html': 'Semantic HTML',
    'l2.sitemap': 'Sitemap',
    'l2.content-signals': 'Content signals',
    'l3.public-api': 'Public API',
    'l3.agent-instructions': 'Agent instructions',
    'l3.mcp': 'MCP interface',
    'l3.site-ai-features': 'In-site AI features',
  },

  // Spec §3.1 three-layer model (weights 35 / 40 / 25)
  layers: {
    L1: 'Reachability',
    L2: 'Legibility',
    L3: 'Actionability',
  },

  // Spec §3.5 (lines 209-217)
  grades: {
    A: { label: 'AI-Open', slogan: 'Fully open' },
    B: { label: 'AI-Friendly', slogan: 'Friendly' },
    C: { label: 'AI-Neutral', slogan: 'Neutral' },
    D: { label: 'AI-Restricted', slogan: 'Restricted' },
    F: { label: 'AI-Closed', slogan: 'Closed' },
  },

  // Spec §3.2 A1 StrategyTag — shown alongside the grade, never used to shame
  strategies: {
    'AI-Open': {
      label: 'AI-Open',
      desc: 'Allows every AI crawler: search, hybrid, and training.',
    },
    'Middle-Path': {
      label: 'Middle-Path',
      desc: 'Allows search-type crawlers, blocks training crawlers.',
    },
    'Training-Open': {
      label: 'Training-Open',
      desc: 'Allows training crawlers while restricting search-type crawlers.',
    },
    'AI-Closed': {
      label: 'AI-Closed',
      desc: 'Blocks all AI crawlers site-wide.',
    },
    Unconfigured: {
      label: 'Unconfigured',
      desc: 'No AI-specific rules in robots.txt; protocol defaults apply.',
    },
  },

  // Spec §7.1 (lines 418-425) — 14 slugs
  categories: {
    'dev-tools': {
      name: 'Developer Tools',
      blurb: 'SDKs, CLIs, and platforms for builders.',
    },
    'ai-tools': {
      name: 'AI Applications & Assistants',
      blurb: 'Assistants, agents, and generative apps.',
    },
    news: {
      name: 'News & Media',
      blurb: 'Reporting and headlines from around the world.',
    },
    ecommerce: {
      name: 'E-commerce',
      blurb: 'Online stores and marketplaces.',
    },
    education: {
      name: 'Education',
      blurb: 'Courses, schools, and learning resources.',
    },
    finance: {
      name: 'Finance',
      blurb: 'Banking, markets, and financial data.',
    },
    social: {
      name: 'Social & Communities',
      blurb: 'Forums, networks, and communities.',
    },
    entertainment: {
      name: 'Entertainment',
      blurb: 'Streaming, games, and fun.',
    },
    health: {
      name: 'Health',
      blurb: 'Medical information and wellness services.',
    },
    travel: {
      name: 'Travel',
      blurb: 'Trips, bookings, and guides.',
    },
    government: {
      name: 'Government & Public',
      blurb: 'Public services and civic information.',
    },
    reference: {
      name: 'Reference & Knowledge',
      blurb: 'Encyclopedias, data, and lookup tools.',
    },
    docs: {
      name: 'Open Docs',
      blurb: 'Publicly accessible documentation and specs.',
    },
    other: {
      name: 'Other',
      blurb: 'Everything that fits nowhere else.',
    },
  },
};

const zhCN: Catalog = {
  ui: {
    // Global chrome / nav (Base.astro + P1-P7)
    siteName: 'AFR.IM — AI 友好度导航',
    tagline: '每个网站的客观 AI 友好度评级。',
    navHome: '首页',
    navCategories: '分类',
    navMethod: '方法',
    navSubmit: '提交',
    navBot: '爬虫礼仪',
    navAbout: '关于',
    searchPlaceholder: '搜索域名…',
    searchEmpty: '没有匹配的站点。',
    searchSubmitHint: '没找到？提交它进入扫描。',
    themeToggle: '切换主题',
    footerPledge: '付费不能改分：评分永远不受付费影响。',
    footerRights: '© 2026 AFR.IM · 保留所有权利。',

    // P1 home
    heroSlogan: '看看每个网站，对 AI 有多友好。',
    heroSub: 'AFR 只测人人可复现的公开信号——讲证据，不讲观点。',
    distributionTitle: '全网 AI 开放度分布',
    leaderboardTitle: 'Top 榜',
    latestTitle: '最新收录',
    viewAll: '查看全部',
    categoriesTitle: '按分类浏览',
    siteCount: '{n} 个站点',
    avgScore: '平均分',
    searchTitle: '搜索',
    sortBy: '排序',
    visit: '访问',
    submitFlow: '流程说明',
    submitInvalid: '请输入有效域名，例如 example.com',
    submitConfirm: '{domain} 已准备好进入扫描队列。扫描队列运行后将发布它的 AFR 报告。',
    submitAfterTitle: '接下来会发生什么',
    submitAfterBody:
      '域名入队后，我们只采集公开信号进行扫描，随后给出 0–100 分并连同完整证据链一起发布。全程无需登录，付费不能改分。',
    submitPoliteNote: '扫描公开且克制：爬虫会表明身份，并遵守你的 robots.txt。',
    emptyCategory: '该分类还没有收录站点。',
    pendingBadge: '待评定',
    pendingNotice: '不可评——首页与 robots.txt 均无法读取，没有可计分的证据链，暂不参与排行，待重扫成功后自动更新。',

    // P1 home — "How we rate" explainer (short labels; body paragraphs stay page content)
    explainerTitle: '我们如何评级',
    explainerScoreTitle: '分数测什么',
    explainerFriendlyTitle: '什么让一个网站 AI 友好',
    explore: '继续了解',
    docsLabel: 'API 文档',
    dataUpdated: '目录数据最后更新于',

    // P2 category/listing page
    sortScore: '分数',
    sortRank: '排名',
    sortNew: '最新',
    filterGrade: '等级',
    filterLang: '语言',
    filterTag: '标签',
    filterCategory: '分类',
    clearFilters: '清除筛选',
    loading: '加载中…',
    loadMore: '加载更多',
    // incremental list pagination (category + search "Show more")
    loadMoreDone: '已显示全部 {n} 个',
    loadMoreProgress: '已显示 {n} / {t}',
    loadMoreError: '无法加载更多——请检查网络后重试。',
    // Search page — "not collected yet" scan flow
    scanHeading: '尚未收录',
    scanDesc: '我们还没有扫描过这个站点。现在开始扫描——报告通常约 3 分钟后生成，并直接显示在这里。',
    scanBtn: '立即扫描（约 3 分钟）',
    scanBusy: '正在启动扫描…',
    scanQueued: '已入队——预计还需 {eta}。我们每 10 秒查询一次报告。',
    scanPolling: '扫描中……预计还需 {eta}。',
    scanStill: '仍在扫描——我们每 10 秒继续查询一次。',
    scanTimeout: '报告尚未生成——扫描可能仍在进行。请几分钟后再试。',
    scanRate: '请求过于频繁——请在 {eta} 后重试。',
    scanError: '无法启动扫描——请重试。',
    scanNet: '网络异常——请求未能送达服务器。',
    scanResultOpen: '查看完整报告',

    // Shared card/detail vocabulary
    score: '分数',
    grade: '等级',
    strategy: '策略',
    evidence: '证据',
    sponsored: '赞助',
    notFound: '未找到该站点。',
    notFoundCta: '提交扫描',

    // P3 detail page
    reportTitle: 'AFR 检测报告',
    evidenceTitle: '证据链',
    statementTitle: '站方声明',
    statementEmpty: '站方还没有留下声明。',
    verifiedOwner: '已验证站方',
    scanTime: '扫描时间',
    addedOn: '收录时间',
    historyTitle: '评分历史',
    rescan: '重新检测',
    rescanQueued: '重扫已排队——请稍后查看。',
    // detail page — real re-scan flow (POST /api/v1/rescan + polling)
    rescanQueuedEta: '已入队 · 约 {n} 分钟',
    rescanPolling: '正在等待新报告……',
    rescanUpdated: '已更新 ✓ ——正在刷新……',
    rescanTimeout: '仍在队列——请几分钟后刷新本页',
    rescanThrottle: '每 30 分钟可重扫一次——保护免费扫描额度。{t} 后可再次重扫。',
    rescanUnknown: '该站点尚未收录。',
    rescanError: '无法连接服务器——请重试。',
    rescanQuota: '今日扫描写入额度已用尽——UTC 00:00 恢复。',
    badgeEmbed: '嵌入徽章',
    badgeTitle: '获取徽章',
    copyHtml: '复制 HTML 嵌入',
    copyMarkdown: '复制 Markdown',
    copy: '复制',
    copied: '已复制',
    statusPending: '待扫描',
    statusDeclined: '婉拒扫描',
    // detail page — views counter, owner verification, claim form, evidence microcopy
    viewsLabel: '浏览',
    verifyTitle: '你是站方吗？',
    verifyDesc: '验证你对该域名的控制权，即可发布声明并管理本报告。',
    verifyCta: '验证此站点',
    verifyBusy: '正在发起验证……',
    verifyMethods: '验证方式',
    verifyFileTab: '文件（推荐）',
    verifyMetaTab: 'Meta 标签',
    verifyDnsTab: 'DNS 记录',
    verifyFileUrl: '文件地址',
    verifyFileContent: '文件内容',
    verifyMetaTag: 'Meta 标签',
    verifyDnsName: '记录名',
    verifyDnsValue: '记录值',
    verifyDnsType: '记录类型',
    verifyPlace: '将它放到你的站点上，然后运行检查。',
    verifyRunCheck: '运行检查',
    verifyChecking: '检查中……',
    verifyOk: '已验证 ✓',
    verifyOkNote: '现在可以在下方发布声明。',
    verifyFailTitle: '尚未通过验证',
    verifyRetryNote: '修正未通过的项后可再次运行检查。',
    verifyRate: '尝试过于频繁——请在 {t} 后重试。',
    verifyError: '无法连接服务器——请重试。',
    verifyMethodFile: '文件',
    verifyMethodMeta: 'Meta',
    verifyMethodDns: 'DNS',
    claimFormTitle: '发布声明',
    claimLabel: '你的声明',
    claimPlaceholder: '用 200 字以内回应你的评分……',
    claimSubmit: '提交声明',
    claimBusy: '提交中……',
    claimDone: '已提交——经快速审核后发布。',
    claimNotVerified: '请先验证站点，再发布声明。',
    claimInvalid: '请填写声明（最多 200 字）。',
    claimError: '无法提交——请重试。',
    claimHint: '已验证站方可在此发布 200 字以内的声明。',
    evidencePrinciple: '无证据不给分：上方每个得分点都可展开查看原始证据。',
    checksLabel: '项检查',
    evidenceNone: '本行暂无证据记录。',
    sourceLabel: '来源',
    checkIdLabel: '检查项 id',
    historyEmpty: '暂无扫描记录。',
    outOf100: '满分 100',

    // P4 submit page
    submitTitle: '提交站点',
    submitStep1: '输入域名——进入扫描队列',
    submitStep2: '扫描器收集公开信号',
    submitStep3: 'AFR 评分与报告上线',
    submitDomainLabel: '域名',
    submitCta: '提交域名',
    submitDisclaimer: '提交限频；已收录域名将直接跳转详情页。',
    // submit page — real POST /api/v1/submissions flow
    submitNoteLabel: '备注（可选）',
    submitNotePlaceholder: '有什么需要扫描器了解的信息？',
    submitBusy: '提交中…',
    submitQueued: '{domain} 已入队——约 {eta} 后完成收录。约 3 分钟后即可在搜索中找到它。',
    submitRateLimited: '该网络的提交次数已达上限——请稍后再试。',
    submitError: '无法连接服务器——请重试。',

    // P5 method page
    methodTitle: 'AFR 标准全文',
    methodIntro: 'AFR 按三层给每个网站 0–100 分：可达、可懂、可交互。',
    engineVersion: '引擎版本',
    recomputeTitle: '自己复算任何评分',
    neutralityStatement: '付费不能改分。',
    methodLicense: 'AFR v1.0 以 CC BY 4.0 发布。',

    // P6 badge page
    badgeAntiForgery: '官方徽章一律从 AFR.IM 引用——点击徽章即可验真。',
    // detail/badge page — embed card note
    badgeEmbedNote: '官方徽章只从 AFR.IM 提供——点击徽章即可回到本站报告页验真。',

    // P7 about / bot / offline
    aboutTitle: '关于 AFR',
    botTitle: '爬虫礼仪',
    offlineTitle: '当前离线',
    offlineHint: '显示上次同步的目录数据。',
    // P7 offline card — sync details
    backToDirectory: '返回目录',
    lastSync: '上次同步',
    cachedSites: '已缓存站点',
  },

  // Engine check ids (packages/afr/src/l1.ts, l2.ts, l3.ts) — ZH = faithful translation,
  // UA names / file names / protocol terms stay in English
  checks: {
    'l1.robots.ai-policy': 'robots.txt AI 爬虫政策（14 个 UA 家族）',
    'l1.no-tech-wall': '透明 AI UA 无技术墙',
    'l1.basic-availability': '基础可用性',
    'l2.llms-family': 'llms.txt 家族',
    'l2.structured-data': '结构化数据（JSON-LD）',
    'l2.semantic-html': '语义化 HTML',
    'l2.sitemap': 'Sitemap 站地图',
    'l2.content-signals': '内容信号',
    'l3.public-api': '公开 API',
    'l3.agent-instructions': 'Agent 指令',
    'l3.mcp': 'MCP 接口',
    'l3.site-ai-features': '站内 AI 功能',
  },

  // Spec §3.1 three-layer model (权重 35 / 40 / 25)
  layers: {
    L1: '可达层',
    L2: '可懂层',
    L3: '可交互层',
  },

  // Spec §3.5 (lines 209-217)
  grades: {
    A: { label: 'AI-Open', slogan: '全开放' },
    B: { label: 'AI-Friendly', slogan: '友好' },
    C: { label: 'AI-Neutral', slogan: '中性' },
    D: { label: 'AI-Restricted', slogan: '受限' },
    F: { label: 'AI-Closed', slogan: '封闭' },
  },

  // Spec §3.2 A1 StrategyTag
  strategies: {
    'AI-Open': {
      label: 'AI-Open',
      desc: '允许全部 AI 爬虫：搜索型、混合型与训练型。',
    },
    'Middle-Path': {
      label: 'Middle-Path',
      desc: '放行搜索型爬虫，拦截训练型爬虫。',
    },
    'Training-Open': {
      label: 'Training-Open',
      desc: '开放训练型爬虫，同时限制搜索型爬虫。',
    },
    'AI-Closed': {
      label: 'AI-Closed',
      desc: '全站封锁所有 AI 爬虫。',
    },
    Unconfigured: {
      label: 'Unconfigured',
      desc: 'robots.txt 无任何 AI 相关规则，按协议缺省语义处理。',
    },
  },

  // Spec §7.1 (lines 418-425) — 14 slugs
  categories: {
    'dev-tools': {
      name: '开发者工具',
      blurb: '面向开发者的 SDK、CLI 与平台。',
    },
    'ai-tools': {
      name: 'AI 应用与助手',
      blurb: '助手、智能体与生成式应用。',
    },
    news: {
      name: '新闻媒体',
      blurb: '全球报道与新闻头条。',
    },
    ecommerce: {
      name: '电商购物',
      blurb: '在线商店与交易平台。',
    },
    education: {
      name: '教育学习',
      blurb: '课程、学校与学习资源。',
    },
    finance: {
      name: '金融财经',
      blurb: '银行、市场与金融数据。',
    },
    social: {
      name: '社交社区',
      blurb: '论坛、网络与社区。',
    },
    entertainment: {
      name: '娱乐',
      blurb: '流媒体、游戏与休闲娱乐。',
    },
    health: {
      name: '医疗健康',
      blurb: '医疗信息与健康服务。',
    },
    travel: {
      name: '旅行出行',
      blurb: '行程、预订与旅行指南。',
    },
    government: {
      name: '政府公共',
      blurb: '公共服务与政务信息。',
    },
    reference: {
      name: '参考知识',
      blurb: '百科、数据与查询工具。',
    },
    docs: {
      name: '开放文档',
      blurb: '公开可访问的文档与规范。',
    },
    other: {
      name: '其他',
      blurb: '不归属以上分类的内容。',
    },
  },
};

export const catalogs: Record<Locale, Catalog> = {
  en,
  'zh-CN': zhCN,
};

/** Resolve a catalog by locale string; anything unsupported falls back to en. */
export function getCatalog(locale?: string): Catalog {
  if (locale && Object.hasOwn(catalogs, locale)) return catalogs[locale as Locale]!;
  return catalogs.en;
}
