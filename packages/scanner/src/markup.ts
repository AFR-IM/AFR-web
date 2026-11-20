// Structural markup analysis behind the in-site AI feature signals.
//
// Why this file exists: the first implementation matched the raw homepage HTML
// with flat regular expressions. Every literal occurrence of a vendor word
// counted — including the JSON catalog that many sites embed for client-side
// rendering. A directory that renders "HubSpot | Software & Tools" next to
// "Discord - Group Chat" was scored as "has an in-site chat widget" and took
// four points it never earned.
//
// Rule now: a signal needs markup behind it.
//   · chat        → a script/iframe/link that points at a chat provider, or an
//                   element whose own attributes carry the chat semantics.
//                   Prose is never chat evidence.
//   · ai search   → visible prose that advertises the feature, a control
//                   attribute that names it, or an endpoint that serves it.
//   · dev console → a real link or form target that points at a console path.
// JSON payloads and script bodies never count for any of them.
//
// Everything here is structural on purpose: the rule set must decide from the
// shape of the document (element names, attribute values, URL targets), never
// from "does the page know this site".

export interface MarkupAttr {
  name: string;
  value: string;
}

export interface MarkupTag {
  name: string;
  attrs: MarkupAttr[];
  /** first occurrence of every attribute, lower-cased names */
  map: Map<string, string>;
}

export interface MarkupScript {
  map: Map<string, string>;
  body: string;
  /** true when the script carries a JSON data payload instead of executable code */
  isJson: boolean;
}

export interface Markup {
  tags: MarkupTag[];
  scripts: MarkupScript[];
  /** visible text — markup, script bodies and style bodies are excluded */
  text: string;
}

/** Elements whose content is raw text and must not be parsed as markup */
const RAW_TEXT_TAGS = new Set(['script', 'style', 'textarea', 'title']);

/** Script types that carry a data payload instead of executable code */
const JSON_SCRIPT_TYPES = new Set([
  'application/json',
  'application/ld+json',
  'text/json',
  'application/x-json',
  'application/manifest+json',
  'importmap',
  'speculationrules',
]);

/* ── vocabulary ────────────────────────────────────────────────────────── */

/**
 * Chat vendors whose name is unambiguous. Matched in host names and in asset
 * paths (a script served from "/js/intercom.js" is the widget).
 */
const CHAT_VENDORS = [
  'intercom',
  'zendesk',
  'zopim',
  'tidio',
  'tawk',
  'botpress',
  'typebot',
  'voiceflow',
  'landbot',
  'purechat',
  'dialogflow',
  'sendbird',
  'userlike',
  'olark',
  'jivochat',
  'gobot',
  'chatra',
  'livechat',
  'customerchat',
  'fb-customerchat',
  'whatsapp',
];

/**
 * Vendor words that are also ordinary product words ("crisp", "drift",
 * "watson"). They only count in a host name — never in a path, where a blog
 * post about drifting or a CSS file called drift.js would misfire.
 */
const CHAT_VENDORS_HOST_ONLY = ['crisp', 'drift', 'watson'];

/**
 * One-word chat products. "chat" on its own is too weak to be evidence (a
 * "chat" icon or a "voice-chat" changelog entry is not a chat surface), so the
 * generic word only counts next to a qualifier or inside a known compound.
 */
const CHAT_COMPOUNDS = [
  'chatbox',
  'chatbot',
  'chatscope',
  'livechat',
  'webchat',
  'customerchat',
  'fb-customerchat',
];

/**
 * Qualifiers that turn the word "chat" into a surface: a widget, a launcher,
 * a bubble, an input … A bare "chat" (an icon, a CSS class) is not enough.
 */
const CHAT_QUALIFIERS = [
  'widget',
  'box',
  'launcher',
  'launch',
  'container',
  'bubble',
  'window',
  'toggle',
  'panel',
  'frame',
  'app',
  'button',
  'btn',
  'modal',
  'embed',
  'dock',
  'drawer',
  'head',
  'input',
  'bar',
  'popup',
  'overlay',
  'portal',
  'script',
  'iframe',
  'root',
  'wrapper',
  'client',
  'layer',
  'hook',
  'menu',
  'list',
  'room',
  'area',
  'sidebar',
  'instance',
  'entry',
  'dialog',
  'tray',
  'now',
  'live',
  'bot',
];

/**
 * Multi-product suites. The suite name alone proves nothing (HubSpot is a
 * CRM, not a chat widget), so it only counts when the same URL also names a
 * chat surface.
 */
const CHAT_SUITES = ['hubspot', 'freshdesk', 'zoho', 'salesforce'];

/** Hosts that are chat products by themselves */
const CHAT_HOST_EXACT = ['wa.me', 'm.me'];

/** Attributes that describe the element itself (not the prose around it) */
const SEMANTIC_ATTRS = new Set([
  'id',
  'class',
  'name',
  'role',
  'aria-label',
  'placeholder',
  'title',
]);

/** Attribute values longer than this are payloads, not markup vocabulary */
const MAX_ATTR_SCAN = 300;

/** A path segment that looks like a hostname points at another site */
const DOMAIN_LIKE = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/i;

/* ── parsing ───────────────────────────────────────────────────────────── */

function isJsonScriptType(type: string | undefined): boolean {
  if (!type) return false;
  const t = type.split(';')[0]!.trim().toLowerCase();
  return JSON_SCRIPT_TYPES.has(t) || t.endsWith('+json');
}

function readTag(html: string, start: number): (MarkupTag & { end: number }) | null {
  let i = start + 1;
  const nameStart = i;
  while (i < html.length && /[a-zA-Z0-9:_.-]/.test(html[i]!)) i++;
  const name = html.slice(nameStart, i).toLowerCase();
  if (!name) return null;

  const attrs: MarkupAttr[] = [];
  const map = new Map<string, string>();
  while (i < html.length) {
    while (i < html.length && /\s/.test(html[i]!)) i++;
    const ch = html[i];
    if (ch === undefined) break;
    if (ch === '>') {
      i++;
      break;
    }
    if (ch === '/' && html[i + 1] === '>') {
      i += 2;
      break;
    }
    const aStart = i;
    while (i < html.length && !/[\s=>/]/.test(html[i]!)) i++;
    const aName = html.slice(aStart, i).toLowerCase();
    if (!aName) {
      i++;
      continue;
    }
    let aVal = '';
    while (i < html.length && /\s/.test(html[i]!)) i++;
    if (html[i] === '=') {
      i++;
      while (i < html.length && /\s/.test(html[i]!)) i++;
      const quote = html[i];
      if (quote === '"' || quote === "'") {
        const end = html.indexOf(quote, i + 1);
        aVal = end === -1 ? html.slice(i + 1) : html.slice(i + 1, end);
        i = end === -1 ? html.length : end + 1;
      } else {
        const vStart = i;
        while (i < html.length && !/[\s>]/.test(html[i]!)) i++;
        aVal = html.slice(vStart, i);
      }
    }
    attrs.push({ name: aName, value: aVal });
    if (!map.has(aName)) map.set(aName, aVal);
  }
  return { name, attrs, map, end: i };
}

function findRawEnd(html: string, name: string, from: number): number {
  const re = new RegExp(`</${name}\\s*>`, 'ig');
  re.lastIndex = from;
  const m = re.exec(html);
  return m ? m.index : -1;
}

/** Parse a homepage into the elements, script bodies and visible text we score from. */
export function parseMarkup(html: string): Markup {
  const tags: MarkupTag[] = [];
  const scripts: MarkupScript[] = [];
  const textParts: string[] = [];
  let i = 0;
  const n = html.length;

  while (i < n) {
    const lt = html.indexOf('<', i);
    if (lt === -1) {
      textParts.push(html.slice(i));
      break;
    }
    if (lt > i) textParts.push(html.slice(i, lt));
    if (html.startsWith('<!--', lt)) {
      const end = html.indexOf('-->', lt + 4);
      i = end === -1 ? n : end + 3;
      continue;
    }
    if (html.startsWith('<!', lt) || html.startsWith('<?', lt)) {
      const end = html.indexOf('>', lt);
      i = end === -1 ? n : end + 1;
      continue;
    }
    if (html.startsWith('</', lt)) {
      const end = html.indexOf('>', lt);
      i = end === -1 ? n : end + 1;
      continue;
    }
    const tag = readTag(html, lt);
    if (!tag) {
      i = lt + 1;
      continue;
    }
    tags.push(tag);
    i = tag.end;
    if (!RAW_TEXT_TAGS.has(tag.name)) continue;

    const close = findRawEnd(html, tag.name, tag.end);
    const body = html.slice(tag.end, close === -1 ? n : close);
    if (tag.name === 'script') {
      scripts.push({ map: tag.map, body, isJson: isJsonScriptType(tag.map.get('type')) });
    } else if (tag.name === 'textarea' || tag.name === 'title') {
      // textarea/title content is visible text; script/style content is not
      textParts.push(body);
    }
    if (close === -1) {
      i = n;
    } else {
      const gt = html.indexOf('>', close);
      i = gt === -1 ? n : gt + 1;
    }
  }

  return { tags, scripts, text: textParts.join(' ') };
}

/* ── matching helpers ──────────────────────────────────────────────────── */

const isAlnum = (ch: string): boolean => /[a-z0-9]/i.test(ch);

/** true when `token` occurs in `s` delimited by non-alphanumeric characters */
function hasToken(s: string, token: string): boolean {
  let from = 0;
  for (;;) {
    const idx = s.indexOf(token, from);
    if (idx === -1) return false;
    const before = idx === 0 ? '' : s[idx - 1]!;
    const after = s[idx + token.length] ?? '';
    if (!isAlnum(before) && !isAlnum(after)) return true;
    from = idx + 1;
  }
}

/**
 * Words of a value: split on non-alphanumeric characters and on camelCase
 * boundaries, so "onlineChat" and "chat-widget" both expose the word "chat".
 */
function words(value: string): string[] {
  const out: string[] = [];
  for (const part of value.split(/[^a-z0-9]+/i)) {
    if (!part) continue;
    for (const w of part.split(/(?<=[a-z0-9])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])/)) {
      if (w) out.push(w.toLowerCase());
    }
  }
  return out;
}

function hostHasToken(host: string, tokens: string[]): boolean {
  if (!host) return false;
  const labels = host.split('.').filter(Boolean);
  return tokens.some((t) => labels.some((l) => hasToken(l, t)));
}

/** The words of a host name (labels split on dots and camelCase) */
function hostWords(host: string): string[] {
  if (!host) return [];
  const out: string[] = [];
  for (const label of host.split('.')) out.push(...words(label));
  return out;
}

function pathHasToken(path: string, tokens: string[]): boolean {
  if (!path) return false;
  return tokens.some((t) => hasToken(path, t));
}

/** Path segments that are not a hostname (a hostname points at another site) */
function featureSegments(path: string): string[] {
  if (!path) return [];
  return path.split('/').filter(Boolean).filter((seg) => !DOMAIN_LIKE.test(seg));
}

/** A path segment that carries a chat word in any spelling */
function segmentHasChatWord(seg: string): boolean {
  return words(seg).includes('chat');
}

/**
 * A path segment that names a chat page: "chat", "chat-with-us", "live-chat".
 * A segment that merely ends with the word ("voice-chat", "bits-chat") is a
 * marketing or changelog page, not a chat surface.
 */
function segmentNamesChatPage(seg: string): boolean {
  const lower = seg.toLowerCase();
  if (CHAT_COMPOUNDS.some((t) => hasToken(lower, t))) return true;
  if (!words(seg).includes('chat')) return false;
  return seg === 'chat' || /^chat[-_]/.test(lower) || words(seg).includes('live');
}

interface UrlParts {
  host: string;
  path: string;
  query: string;
  absolute: boolean;
}

const IGNORED_SCHEMES = /^(mailto|tel|javascript|data|sms):/i;

function splitUrl(url: string): UrlParts {
  const raw = url.trim();
  if (!raw || raw.startsWith('#') || IGNORED_SCHEMES.test(raw)) {
    return { host: '', path: '', query: '', absolute: false };
  }
  const m = /^(?:[a-z][a-z0-9+.-]*:)?\/\/([^/?#]*)([^?#]*)/i.exec(raw);
  if (m) {
    const host = (m[1] ?? '').toLowerCase();
    const path = (m[2] ?? '').toLowerCase();
    const rest = raw.slice(m[0].length);
    const q = rest.indexOf('?');
    return {
      host,
      path,
      query: q === -1 ? '' : rest.slice(q + 1).toLowerCase(),
      absolute: true,
    };
  }
  const noHash = raw.split('#')[0]!.toLowerCase();
  const qi = noHash.indexOf('?');
  return {
    host: '',
    path: qi === -1 ? noHash : noHash.slice(0, qi),
    query: qi === -1 ? '' : noHash.slice(qi + 1),
    absolute: false,
  };
}

/** A JSON payload parked in an attribute is data, not markup vocabulary */
function looksLikePayload(value: string): boolean {
  const v = value.trim();
  if (v.length > MAX_ATTR_SCAN) return true;
  if (!/^[[{]/.test(v)) return false;
  return /["'&]?\s*:/.test(v);
}

/* ── chat ──────────────────────────────────────────────────────────────── */

/**
 * A chat signal needs a chat *surface*: an asset URL, a link target or an
 * element attribute that names one.
 *   · asset scope (script/iframe src) — the vendor word may sit anywhere in
 *     the path, a chat word may sit in a path segment
 *   · link scope (a/form targets) — the vendor word must be in the host name;
 *     a path segment only counts when it names a chat page, never when it is
 *     another site's domain
 */
function chatUrlSignal(url: string, scope: 'asset' | 'link'): boolean {
  const parts = splitUrl(url);
  if (!parts.host && !parts.path) return false;

  if (hostHasToken(parts.host, CHAT_VENDORS)) return true;
  if (hostHasToken(parts.host, CHAT_VENDORS_HOST_ONLY)) return true;
  // a dedicated chat host (chat.example.com) is a chat surface
  if (hostWords(parts.host).includes('chat')) return true;
  if (CHAT_HOST_EXACT.some((h) => parts.host === h || parts.host.endsWith('.' + h))) return true;

  if (scope === 'asset') {
    if (pathHasToken(parts.path, CHAT_VENDORS)) return true;
    if (pathHasToken(parts.path, CHAT_VENDORS_HOST_ONLY)) return true;
    if (featureSegments(parts.path).some((seg) => segmentHasChatWord(seg))) return true;
  } else if (featureSegments(parts.path).some((seg) => segmentNamesChatPage(seg))) {
    return true;
  }

  // A suite name alone is not a chat signal; the same URL must name a chat surface.
  if (CHAT_SUITES.some((s) => hasToken(parts.host, s) || hasToken(parts.path, s))) {
    if (featureSegments(parts.path).some((seg) => segmentHasChatWord(seg))) return true;
  }
  return false;
}

/** An element attribute that names a chat surface (container, widget, launcher) */
function chatAttrSignal(value: string): boolean {
  if (!value || looksLikePayload(value)) return false;
  const v = value.toLowerCase();
  if (CHAT_VENDORS.some((t) => hasToken(v, t))) return true;
  if (CHAT_COMPOUNDS.some((t) => hasToken(v, t))) return true;
  const w = words(value);
  if (w.includes('chat') && w.some((x) => CHAT_QUALIFIERS.includes(x))) return true;
  return false;
}

/** Chat vendor used as a code symbol — `Intercom(...)`, `intercomSettings` */
const CHAT_CODE_CALL = new RegExp(
  `\\b(${CHAT_VENDORS.join('|')}|${CHAT_VENDORS_HOST_ONLY.join('|')})\\s*\\(`,
  'i',
);
const CHAT_CODE_PROP = new RegExp(
  `\\b(${CHAT_VENDORS.join('|')}|${CHAT_VENDORS_HOST_ONLY.join('|')})(settings|_api|_widget|_js)\\b`,
  'i',
);

/** True when the document really carries an in-site chat/assistant surface. */
export function detectChatWidget(markup: Markup): boolean {
  for (const tag of markup.tags) {
    // 1) the chat widget is loaded from a script or framed from a chat domain
    if (tag.name === 'script' || tag.name === 'iframe') {
      for (const attr of tag.attrs) {
        if (attr.name !== 'src' && attr.name !== 'data-src') continue;
        if (chatUrlSignal(attr.value, 'asset')) return true;
      }
    }
    // 2) the site links to its own chat / support surface
    if (tag.name === 'a' || tag.name === 'area') {
      const href = tag.map.get('href');
      if (href && chatUrlSignal(href, 'link')) return true;
    }
    if (tag.name === 'form') {
      const action = tag.map.get('action');
      if (action && chatUrlSignal(action, 'link')) return true;
    }
    if (tag.name === 'button' || tag.name === 'input') {
      const action = tag.map.get('formaction');
      if (action && chatUrlSignal(action, 'link')) return true;
    }
    // 3) a chat container element (id/class/name/aria carry the semantics)
    for (const attr of tag.attrs) {
      const structural =
        SEMANTIC_ATTRS.has(attr.name) || attr.name.startsWith('data-');
      if (!structural) continue;
      if (chatAttrSignal(attr.value)) return true;
    }
  }
  // 4) the widget is booted from inline code (not from a JSON payload)
  for (const script of markup.scripts) {
    if (script.isJson) continue;
    if (CHAT_CODE_CALL.test(script.body) || CHAT_CODE_PROP.test(script.body)) return true;
  }
  return false;
}

/* ── ai search ─────────────────────────────────────────────────────────── */

/** Feature phrases: they describe what the site itself offers. */
const AI_SEARCH_FEATURE =
  /\bai[\s_-]*search\b|\bask[\s_-]*ai\b|\bsemantic[\s_-]*search\b|\bvector[\s_-]*search\b|\bgenerative[\s_-]*search\b|\bllm[\s_-]*based\b/i;

/**
 * Model/vendor claims. They are marketing words, not a feature description:
 * "ChatGPT vs. Gemini" (an article title) or "Perplexity logo" (a customer
 * logo) must not count. They are only accepted as a meta generator claim,
 * which is a statement about the page itself.
 */
const AI_SEARCH_VENDOR =
  /\bpowered by (openai|gpt|claude|gemini)\b|\bgpt-[34]\b|\bchatgpt\b|\bperplexity\b/i;

/** Endpoints that serve an AI search */
const AI_SEARCH_URL =
  /\bai[\s_-]*search\b|\bask[\s_-]*ai\b|\bsemantic[\s_-]*search\b|\bvector[\s_-]*search\b|\bgenerative[\s_-]*search\b|\bllm[\s_-]*search\b|\bai\/search\b|\bsearch\/ai\b/i;

function aiSearchAttrSignal(value: string): boolean {
  if (!value || looksLikePayload(value)) return false;
  return AI_SEARCH_FEATURE.test(value);
}

/** True when the document exposes an in-site AI search. */
export function detectAiSearch(markup: Markup): boolean {
  // 1) visible prose that names the feature (script/JSON payloads are excluded
  //    from the visible text, so an embedded catalog can never trigger it)
  if (AI_SEARCH_FEATURE.test(markup.text)) return true;

  for (const tag of markup.tags) {
    // 2) a control that advertises the feature
    for (const attr of tag.attrs) {
      const structural = SEMANTIC_ATTRS.has(attr.name) || attr.name.startsWith('data-');
      if (!structural) continue;
      if (aiSearchAttrSignal(attr.value)) return true;
    }
    // 3) a meta generator claim ("Powered by GPT-4")
    if (tag.name === 'meta') {
      const name = (tag.map.get('name') ?? tag.map.get('property') ?? '').toLowerCase();
      if (name === 'generator' && AI_SEARCH_VENDOR.test(tag.map.get('content') ?? '')) return true;
    }
    // 4) an endpoint that serves the search
    const urls: Array<[string, string]> = [];
    if (tag.name === 'a' || tag.name === 'area') urls.push(['href', tag.map.get('href') ?? '']);
    if (tag.name === 'form') urls.push(['action', tag.map.get('action') ?? '']);
    if (tag.name === 'script' || tag.name === 'iframe') {
      urls.push(['src', tag.map.get('src') ?? '']);
    }
    for (const [, url] of urls) {
      if (!url) continue;
      const parts = splitUrl(url);
      if (AI_SEARCH_URL.test(`${parts.host}${parts.path}${parts.query}`)) return true;
    }
  }

  // 5) inline code that calls an AI search endpoint
  for (const script of markup.scripts) {
    if (script.isJson) continue;
    if (AI_SEARCH_URL.test(script.body)) return true;
  }
  return false;
}

/* ── developer console ─────────────────────────────────────────────────── */

const CONSOLE_PATH = /(^|\/)(console|developers?)(\/|$|[^a-z0-9])/i;
const CONSOLE_PATH_EXTRA = [/\/dev\//i, /\/api\/keys/i, /\/account\/api/i, /\/dashboard[^/]*api/i];
/** Host labels of a developer portal (developer.example.com, console.example.com) */
const CONSOLE_HOSTS = ['console', 'developer', 'developers'];

function consoleUrlSignal(url: string): boolean {
  const parts = splitUrl(url);
  const hostLabels = parts.host ? parts.host.split('.').filter(Boolean) : [];
  if (hostLabels.some((l) => CONSOLE_HOSTS.includes(l))) return true;
  if (!parts.path) return false;
  if (CONSOLE_PATH.test(parts.path)) return true;
  return CONSOLE_PATH_EXTRA.some((re) => re.test(parts.path));
}

/** True when the document links to a developer console / API key surface. */
export function detectDeveloperConsole(markup: Markup): boolean {
  for (const tag of markup.tags) {
    let url = '';
    if (tag.name === 'a' || tag.name === 'area') url = tag.map.get('href') ?? '';
    else if (tag.name === 'form') url = tag.map.get('action') ?? '';
    else if (tag.name === 'button' || tag.name === 'input') url = tag.map.get('formaction') ?? '';
    if (!url) continue;
    if (consoleUrlSignal(url)) return true;
  }
  return false;
}
