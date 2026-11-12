// @afr/web — category heuristics: maps a scanned domain (+ page title) to one
// of the 14 product category slugs.
//
// Matching order for one site:
//   1. domain keyword table — exact registrable-label match (e.g. "github" in
//      github.com / github.io) or full-domain suffix match for dotted entries
//      (e.g. "x.com", "developer.mozilla.org"); dotted entries never match titles.
//   2. TLD hint — .gov / .edu and their ccTLD families (gov.uk, gov.cn, ac.uk…).
//   3. title keyword table — word-boundary match against the extracted <title>
//      text, only for entries explicitly marked title-safe (third array element).
//   4. fallback — 'other'.
//
// The table only lists confident mappings. Unknown domains (ad-tech, CDNs,
// DNS, corporate infrastructure…) intentionally fall through to 'other'.

/** The 14 category slugs — must stay in sync with the i18n categories catalog. */
export const CATEGORY_SLUGS = [
  'dev-tools',
  'ai-tools',
  'news',
  'ecommerce',
  'education',
  'finance',
  'social',
  'entertainment',
  'health',
  'travel',
  'government',
  'reference',
  'docs',
  'other',
];

/**
 * [keyword, slug, titleSafe?]
 * - keyword without a dot: matched against each dot-label of the domain exactly
 * - keyword with a dot: matched against the whole domain / its suffix
 * - titleSafe: also allowed to match as a whole word inside <title>
 */
const RULES = [
  // ── dev-tools: builders' platforms, hosting, SDKs, infra tooling ──────────
  ['developer.mozilla.org', 'docs'], // MDN is documentation, kept before any label rule
  ['appspot.com', 'dev-tools'],
  ['run.app', 'dev-tools'],
  ['pages.dev', 'dev-tools'],
  ['workers.dev', 'dev-tools'],
  ['wp.com', 'dev-tools'],
  ['name.com', 'dev-tools'],
  ['github', 'dev-tools', true],
  ['gitlab', 'dev-tools', true],
  ['stackoverflow', 'dev-tools', true],
  ['sourceforge', 'dev-tools', true],
  ['launchpad', 'dev-tools', true],
  ['vercel', 'dev-tools', true],
  ['netlify', 'dev-tools', true],
  ['heroku', 'dev-tools', true],
  ['herokuapp', 'dev-tools'],
  ['digitalocean', 'dev-tools', true],
  ['linode', 'dev-tools', true],
  ['docker', 'dev-tools', true],
  ['cloudflare', 'dev-tools', true],
  ['amazonaws', 'dev-tools'],
  ['aws', 'dev-tools'],
  ['azure', 'dev-tools'],
  ['oraclecloud', 'dev-tools'],
  ['aliyun', 'dev-tools', true],
  ['googleapis', 'dev-tools'],
  ['googledomains', 'dev-tools'],
  ['supabase', 'dev-tools', true],
  ['visualstudio', 'dev-tools', true],
  ['atlassian', 'dev-tools', true],
  ['jetbrains', 'dev-tools', true],
  ['sentry', 'dev-tools', true],
  ['datadog', 'dev-tools', true],
  ['newrelic', 'dev-tools', true],
  ['bugsnag', 'dev-tools', true],
  ['dynatrace', 'dev-tools', true],
  ['launchdarkly', 'dev-tools', true],
  ['auth0', 'dev-tools'],
  ['twilio', 'dev-tools', true],
  ['wordpress', 'dev-tools', true],
  ['redhat', 'dev-tools', true],
  ['debian', 'dev-tools', true],
  ['ubuntu', 'dev-tools', true],
  ['apache', 'dev-tools', true],
  ['nginx', 'dev-tools', true],
  ['python', 'dev-tools', true],
  ['php', 'dev-tools'],
  ['mysql', 'dev-tools', true],
  ['jquery', 'dev-tools', true],
  ['jsdelivr', 'dev-tools', true],
  ['unpkg', 'dev-tools', true],
  ['gnu', 'dev-tools'],
  ['godaddy', 'dev-tools', true],
  ['namecheap', 'dev-tools', true],
  ['bluehost', 'dev-tools', true],
  ['hostgator', 'dev-tools', true],
  ['dreamhost', 'dev-tools', true],
  ['gandi', 'dev-tools'],
  ['cpanel', 'dev-tools'],
  ['plesk', 'dev-tools'],
  ['porkbun', 'dev-tools', true],
  ['unity3d', 'dev-tools', true],
  ['cursor', 'dev-tools'],
  ['ampproject', 'dev-tools', true],
  ['fontawesome', 'dev-tools', true],

  // ── ai-tools: assistants, models, generative products ────────────────────
  ['character.ai', 'ai-tools'],
  ['openai', 'ai-tools', true],
  ['anthropic', 'ai-tools', true],
  ['claude', 'ai-tools'],
  ['chatgpt', 'ai-tools', true],
  ['deepseek', 'ai-tools', true],
  ['perplexity', 'ai-tools', true],
  ['huggingface', 'ai-tools', true],
  ['grammarly', 'ai-tools', true],
  ['deepl', 'ai-tools', true],
  ['amazonalexa', 'ai-tools'],
  ['capcut', 'ai-tools', true],

  // ── news: reporting, editorial media, publishing platforms ───────────────
  ['theguardian', 'news'],
  ['guardian', 'news', true],
  ['washingtonpost', 'news'],
  ['theverge', 'news'],
  ['verge', 'news', true],
  ['nytimes', 'news', true],
  ['bbc', 'news'],
  ['cnn', 'news'],
  ['reuters', 'news', true],
  ['apnews', 'news', true],
  ['nbcnews', 'news', true],
  ['cbsnews', 'news', true],
  ['foxnews', 'news', true],
  ['huffpost', 'news', true],
  ['usatoday', 'news', true],
  ['npr', 'news'],
  ['forbes', 'news', true],
  ['wired', 'news'],
  ['techcrunch', 'news', true],
  ['businessinsider', 'news', true],
  ['bloomberg', 'news', true],
  ['cnbc', 'news', true],
  ['ft.com', 'news'],
  ['wsj', 'news'],
  ['latimes', 'news', true],
  ['cnet', 'news'],
  ['prnewswire', 'news', true],
  ['indiatimes', 'news', true],
  ['telegraph', 'news'],
  ['dailymail', 'news', true],
  ['independent', 'news'],
  ['bild', 'news'],
  ['spiegel', 'news', true],
  ['welt', 'news'],
  ['corriere', 'news'],
  ['repubblica', 'news'],
  ['elpais', 'news', true],
  ['lemonde', 'news', true],
  ['nikkei', 'news', true],
  ['time.com', 'news'],
  ['people.com', 'news'],
  ['hbr', 'news'],
  ['yahoo', 'news', true],
  ['aol', 'news'],
  ['msn', 'news'],
  ['sina', 'news'],
  ['sohu', 'news'],
  ['163', 'news'],
  ['uol', 'news'],
  ['dzen', 'news'],
  ['wp.pl', 'news'],
  ['blogger', 'news', true],
  ['blogspot', 'news'],
  ['ameblo', 'news'],
  ['focus', 'news'],
  ['n-tv.de', 'news'],
  ['medium', 'news'],
  ['substack', 'news', true],
  ['note', 'news'],

  // ── ecommerce: stores, marketplaces, retail brands with online shops ─────
  ['shop.app', 'ecommerce'],
  ['mobile.de', 'ecommerce'],
  ['hm.com', 'ecommerce'],
  ['wb.ru', 'ecommerce'],
  ['jd.com', 'ecommerce'],
  ['target.com', 'ecommerce'],
  ['hp.com', 'ecommerce'],
  ['amazon', 'ecommerce'],
  ['aliexpress', 'ecommerce', true],
  ['alibaba', 'ecommerce', true],
  ['taobao', 'ecommerce', true],
  ['ebay', 'ecommerce', true],
  ['etsy', 'ecommerce', true],
  ['walmart', 'ecommerce', true],
  ['homedepot', 'ecommerce', true],
  ['lowes', 'ecommerce', true],
  ['bestbuy', 'ecommerce', true],
  ['shopify', 'ecommerce', true],
  ['myshopify', 'ecommerce'],
  ['shopee', 'ecommerce', true],
  ['flipkart', 'ecommerce', true],
  ['temu', 'ecommerce', true],
  ['shein', 'ecommerce', true],
  ['rakuten', 'ecommerce', true],
  ['mercadolibre', 'ecommerce'],
  ['mercadolivre', 'ecommerce'],
  ['ozon', 'ecommerce'],
  ['wildberries', 'ecommerce', true],
  ['allegro', 'ecommerce', true],
  ['kleinanzeigen', 'ecommerce'],
  ['craigslist', 'ecommerce', true],
  ['coupang', 'ecommerce', true],
  ['trendyol', 'ecommerce', true],
  ['fiverr', 'ecommerce', true],
  ['avito', 'ecommerce'],
  ['drom', 'ecommerce'],
  ['otto', 'ecommerce'],
  ['ikea', 'ecommerce', true],
  ['nike', 'ecommerce', true],
  ['apple', 'ecommerce'],
  ['samsung', 'ecommerce', true],
  ['dell', 'ecommerce'],
  ['lenovo', 'ecommerce', true],
  ['asus', 'ecommerce'],
  ['lg.com', 'ecommerce'],
  ['huawei', 'ecommerce', true],
  ['xiaomi', 'ecommerce', true],
  ['vivoglobal', 'ecommerce'],
  ['vivo', 'ecommerce'],

  // ── education: schools, courses, academic publishers ─────────────────────
  ['washington.edu', 'education'],
  ['mit.edu', 'education'],
  ['ted.com', 'education'],
  ['academia', 'education', true],
  ['duolingo', 'education', true],
  ['instructure', 'education'],
  ['classlink', 'education'],
  ['clever', 'education'],
  ['springer', 'education', true],
  ['wiley', 'education', true],
  ['cambridge', 'education', true],
  ['oup', 'education'],
  ['sagepub', 'education', true],
  ['tandfonline', 'education', true],
  ['sciencedirect', 'education', true],
  ['mdpi', 'education'],
  ['frontiersin', 'education', true],
  ['nature', 'education'],
  ['researchgate', 'education', true],
  ['harvard', 'education', true],
  ['stanford', 'education', true],
  ['berkeley', 'education', true],
  ['cornell', 'education', true],
  ['princeton', 'education', true],

  // ── finance: banking, payments, markets ──────────────────────────────────
  ['bankofamerica', 'finance', true],
  ['paypal', 'finance', true],
  ['stripe', 'finance', true],
  ['alipay', 'finance', true],
  ['visa', 'finance'],
  ['intuit', 'finance', true],
  ['binance', 'finance', true],
  ['tradingview', 'finance', true],
  ['manulife', 'finance', true],
  ['sberbank', 'finance', true],
  ['shiabank', 'finance'],
  ['bybanking', 'finance'],

  // ── social: networks, forums, messaging ──────────────────────────────────
  ['x.com', 'social'],
  ['ok.ru', 'social'],
  ['fb.com', 'social'],
  ['t.me', 'social'],
  ['wa.me', 'social'],
  ['line.me', 'social'],
  ['qq.com', 'social'],
  ['bsky.app', 'social'],
  ['pikabu', 'social', true],
  ['facebook', 'social'],
  ['instagram', 'social'],
  ['twitter', 'social', true],
  ['linkedin', 'social', true],
  ['reddit', 'social', true],
  ['quora', 'social', true],
  ['discord', 'social', true],
  ['telegram', 'social', true],
  ['whatsapp', 'social', true],
  ['snapchat', 'social', true],
  ['threads', 'social'],
  ['pinterest', 'social', true],
  ['tumblr', 'social', true],
  ['weibo', 'social', true],
  ['skype', 'social', true],
  ['viber', 'social', true],
  ['behance', 'social', true],
  ['flickr', 'social', true],
  ['deviantart', 'social', true],
  ['myspace', 'social', true],
  ['livejournal', 'social', true],
  ['vk', 'social'],

  // ── entertainment: streaming, games, broadcast, media ────────────────────
  ['youtu.be', 'entertainment'],
  ['max.com', 'entertainment'],
  ['ea.com', 'entertainment'],
  ['go.com', 'entertainment'],
  ['amazonvideo', 'entertainment'],
  ['xboxlive', 'entertainment'],
  ['kwai', 'entertainment', true],
  ['ivi', 'entertainment'],
  ['youtube', 'entertainment', true],
  ['netflix', 'entertainment', true],
  ['spotify', 'entertainment', true],
  ['twitch', 'entertainment', true],
  ['tiktok', 'entertainment', true],
  ['bilibili', 'entertainment', true],
  ['youku', 'entertainment', true],
  ['vimeo', 'entertainment', true],
  ['dailymotion', 'entertainment', true],
  ['soundcloud', 'entertainment', true],
  ['bandcamp', 'entertainment', true],
  ['disneyplus', 'entertainment', true],
  ['paramountplus', 'entertainment', true],
  ['primevideo', 'entertainment', true],
  ['roku', 'entertainment', true],
  ['tubi', 'entertainment'],
  ['plex', 'entertainment'],
  ['steampowered', 'entertainment'],
  ['steamcommunity', 'entertainment'],
  ['epicgames', 'entertainment', true],
  ['roblox', 'entertainment', true],
  ['nintendo', 'entertainment', true],
  ['playstation', 'entertainment', true],
  ['xbox', 'entertainment'],
  ['gamepass', 'entertainment', true],
  ['supercell', 'entertainment', true],
  ['curseforge', 'entertainment', true],
  ['nexusmods', 'entertainment', true],
  ['poki', 'entertainment'],
  ['itch', 'entertainment'],
  ['chess', 'entertainment'],
  ['kick', 'entertainment'],
  ['espn', 'entertainment'],
  ['mlb', 'entertainment'],
  ['pbs', 'entertainment'],
  ['cbs', 'entertainment'],
  ['globo', 'entertainment', true],
  ['fandom', 'entertainment', true],
  ['imdb', 'reference', true], // title database → lookup, not streaming

  // ── health: medical information and services ─────────────────────────────
  ['mayoclinic', 'health', true],
  ['who.int', 'health'],
  ['cdc', 'health'],
  ['nih', 'health'],
  ['fda', 'health'],

  // ── travel: bookings, stays, rides ───────────────────────────────────────
  ['booking', 'travel'],
  ['airbnb', 'travel', true],
  ['agoda', 'travel', true],
  ['tripadvisor', 'travel', true],
  ['marriott', 'travel', true],
  ['uber', 'travel'],

  // ── government: public bodies and international institutions ─────────────
  ['un.org', 'government'],
  ['europa', 'government', true],
  ['unesco', 'government', true],
  ['worldbank', 'government', true],
  ['bund', 'government'],
  ['gosuslugi', 'government'],
  ['usps', 'government'],

  // ── reference: encyclopedias, databases, lookup and search ───────────────
  ['doi.org', 'reference'],
  ['2gis', 'reference'],
  ['merriam-webster', 'reference', true],
  ['biblegateway', 'reference', true],
  ['discogs', 'reference', true],
  ['trustpilot', 'reference', true],
  ['wikipedia', 'reference', true],
  ['wikimedia', 'reference', true],
  ['britannica', 'reference', true],
  ['merriam', 'reference', true],
  ['archive', 'reference'],
  ['openstreetmap', 'reference', true],
  ['statista', 'reference', true],
  ['arxiv', 'reference', true],
  ['yelp', 'reference', true],
  ['google', 'reference'],
  ['bing', 'reference'],
  ['duckduckgo', 'reference', true],
  ['yandex', 'reference', true],
  ['baidu', 'reference', true],
  ['seznam', 'reference', true],
  ['naver', 'reference', true],
  ['daum', 'reference', true],

  // ── docs: public specifications and documentation sites ──────────────────
  ['w3.org', 'docs'],
  ['iso.org', 'docs'],
  ['rfc-editor', 'docs'],
  ['readthedocs', 'docs', true],
  ['ietf', 'docs'],
  ['ieee', 'docs'],
];

const TITLE_RULES = RULES.filter((r) => r[2] === true && !r[0].includes('.'));

/** ccTLD second-level families that mark government / education domains. */
const GOV_SLD = new Set(['gov', 'gob', 'gouv', 'go', 'gc']);
const EDU_SLD = new Set(['edu', 'ac']);

function tldHint(labels) {
  const tld = labels[labels.length - 1];
  if (tld === 'gov') return 'government';
  if (tld === 'edu') return 'education';
  // Second-level check only for 2-letter ccTLDs (gov.uk, gov.cn, edu.au…) —
  // never for generic TLDs, otherwise "go.com" would read as a gov family.
  if (labels.length >= 2 && tld.length === 2) {
    const sld = labels[labels.length - 2];
    if (GOV_SLD.has(sld)) return 'government';
    if (EDU_SLD.has(sld)) return 'education';
  }
  return undefined;
}

function matchDomain(domain, labels) {
  for (const [keyword, slug] of RULES) {
    if (keyword.includes('.')) {
      if (domain === keyword || domain.endsWith(`.${keyword}`)) return slug;
    } else if (labels.includes(keyword)) {
      return slug;
    }
  }
  return undefined;
}

function matchTitle(title) {
  if (!title) return undefined;
  // Word-boundary normalized copy: "The Verge — Tech" -> " the verge tech "
  const words = ` ${title.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()} `;
  for (const [keyword, slug] of TITLE_RULES) {
    if (words.includes(` ${keyword} `)) return slug;
  }
  return undefined;
}

/**
 * Map one site to a category slug.
 * @param {string} domain lowercase domain, e.g. "github.com"
 * @param {string} [title] extracted <title> text, when the homepage was readable
 * @returns {string} one of CATEGORY_SLUGS
 */
export function categorize(domain, title) {
  const lower = String(domain ?? '').toLowerCase();
  const labels = lower.split('.').filter(Boolean);
  if (labels.length === 0) return 'other';
  return (
    matchDomain(lower, labels) ??
    tldHint(labels) ??
    matchTitle(title) ??
    'other'
  );
}
