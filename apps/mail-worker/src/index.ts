// src/index.ts — AFR inbound mail Worker (Cloudflare Email Routing → D1).
//
// Why this file exists: afr.im already has Email Routing with MX/SPF/DKIM in
// place, but the catch-all rule only fed an empty handler, so every inbound
// mail was silently discarded. This Worker is the receiving half of the free,
// self-hosted mail loop: it stores the mail in the shared D1 database, offers
// the operator a token-protected read interface, and may perform one
// conservative automatic action per mail.
//
// Rules that shape the module:
//
//   1. Zero dependencies. Only Workers built-ins are used (fetch, streams,
//      TextDecoder, atob, Request/Response). No `node:*` import may appear
//      here — the module is bundled for workerd, where Node builtins do not
//      exist. The tests use node:sqlite, never this file.
//
//   2. Store first, act later. The mail row is written before any automatic
//      action runs, and the action runs inside ctx.waitUntil, so a slow or
//      broken verification request can never interrupt mail delivery.
//
//   3. Nothing sensitive reaches the logs. Bodies, links and their query
//      parameters (verification tokens) never appear in console output — only
//      counters, ids and status codes.
//
//   4. The automatic action is deliberately narrow: a whitelisted sender
//      domain plus a whitelisted link host plus a "/verify" path, and at most
//      one visit per mail. Anything else is recorded as "nothing happened".

// ---------------------------------------------------------------------------
// Structural views of the runtime APIs this module touches.
//
// The package has no dependencies at all, so @cloudflare/workers-types cannot
// be imported (it would also pull in DOM-ish globals the Worker runtime does
// not share with Node). The few shapes that matter are declared locally
// instead; every one of them is satisfied by the real runtime objects.
// ---------------------------------------------------------------------------

/** Structural view of the Response constructor (workerd + Node 22). */
export interface ResponseCtor {
  new (body?: string | null, init?: { status?: number; headers?: Record<string, string> }): ResponseLike;
}

/** Structural view of a Response instance. */
export interface ResponseLike {
  readonly status: number;
  readonly headers: { get(name: string): string | null };
  json(): Promise<unknown>;
  text(): Promise<string>;
}

/**
 * The global Response constructor. Declared (not assigned) so that it is
 * erased at runtime and resolves to the platform global.
 */
declare const Response: ResponseCtor;

/** Structural view of an inbound request. */
export interface RequestLike {
  readonly method: string;
  readonly url: string;
  readonly headers: { get(name: string): string | null };
}

/** Structural view of the D1 prepared statement. */
export interface D1StatementLike {
  bind(...values: unknown[]): D1StatementLike;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  run(): Promise<{ meta?: { last_row_id?: number; changes?: number } }>;
}

/** Structural view of the D1 database binding (`DB`). */
export interface D1Like {
  prepare(sql: string): D1StatementLike;
}

/** Worker bindings (wrangler.toml). */
export interface MailEnv {
  /** D1 database binding — the shared "aiapp" database. */
  DB: D1Like;
  /** Worker secret: token required by the X-Queue-Token header. */
  QUEUE_TOKEN?: string;
  /** Worker secret: comma-separated sender domains allowed to trigger the
   * automatic action. Empty/absent → the automatic action is disabled. */
  TRUSTED_SENDER_DOMAINS?: string;
}

/** Structural view of the incoming mail (Cloudflare Email Routing). */
export interface ForwardableEmailMessageLike {
  readonly from: string;
  readonly to: string;
  readonly headers: { get(name: string): string | null };
  readonly raw: ReadableStream<Uint8Array> | string | ArrayBuffer | Uint8Array;
  readonly rawSize?: number;
}

/** Structural view of the execution context (only waitUntil is needed). */
export interface ExecutionContextLike {
  waitUntil(promise: Promise<unknown>): void;
}

/** Minimal fetch signature used for the verification visit. */
export type FetchLike = (
  input: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    signal?: AbortSignal;
    redirect?: 'follow' | 'manual' | 'error';
  },
) => Promise<{ status: number }>;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Plain-text body is truncated to this many characters before it is stored. */
export const MAX_BODY_CHARS = 8000;
/** At most this many links are extracted and stored per mail. */
export const MAX_LINKS = 20;
/** Timeout of the single automatic verification visit. */
export const VISIT_TIMEOUT_MS = 10_000;
/** The action result summary is capped so the audit trail stays readable. */
export const MAX_RESULT_CHARS = 200;
/** Default / hard cap of rows returned by the read interface. */
export const DEFAULT_MAIL_LIMIT = 20;
export const MAX_MAIL_LIMIT = 100;
export const ACTIONS_LIMIT = 50;
/**
 * Raw MIME is read at most up to this many bytes. Inbound mail may be up to
 * 25 MiB, and a Workers Free plan invocation only gets a small CPU budget —
 * decoding a huge message would burn it on parsing alone and the delivery
 * would fail with EXCEEDED_CPU. A quarter megabyte is far more than the
 * stored body (8000 chars) and the extracted links ever need.
 */
export const MAX_RAW_BYTES = 256 * 1024;
/** Transparent User-Agent for the verification visit. */
export const MAIL_USER_AGENT = 'afr-im mail worker (+https://afr.im)';

/** Headers kept for every stored mail (lowercase keys). */
export const SELECTED_HEADERS = ['from', 'to', 'subject', 'message-id', 'date', 'reply-to'] as const;

// ---------------------------------------------------------------------------
// Pure helpers — parsing, link extraction, header selection
// ---------------------------------------------------------------------------

/** Header map with lowercase keys; the first occurrence of a header wins. */
export type HeaderMap = Record<string, string>;

/**
 * Split a raw mail into its header block and body.
 * Both CRLF and bare LF line endings are accepted — some mailers emit LF only.
 */
export function splitHeaderAndBody(raw: string): { headerText: string; bodyText: string } {
  const crlf = raw.indexOf('\r\n\r\n');
  const lf = raw.indexOf('\n\n');
  let cut = -1;
  let skip = 0;
  if (crlf !== -1 && (lf === -1 || crlf < lf)) {
    cut = crlf;
    skip = 4;
  } else if (lf !== -1) {
    cut = lf;
    skip = 2;
  }
  if (cut === -1) return { headerText: raw, bodyText: '' };
  return { headerText: raw.slice(0, cut), bodyText: raw.slice(cut + skip) };
}

/**
 * Parse a header block into lowercase-keyed entries; folded lines continue the
 * previous header (RFC 5322 unfolding).
 */
export function parseHeaderBlock(headerText: string): HeaderMap {
  const headers: HeaderMap = {};
  let lastKey: string | null = null;
  for (const line of headerText.split(/\r?\n/)) {
    if (!line) continue;
    if (/^[ \t]/.test(line) && lastKey) {
      headers[lastKey] = `${headers[lastKey]} ${line.trim()}`.trim();
      continue;
    }
    const colon = line.indexOf(':');
    if (colon <= 0) continue;
    const key = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    if (!(key in headers)) headers[key] = value;
    lastKey = key;
  }
  return headers;
}

/** Split a Content-Type value into its type and its parameters. */
export function parseContentType(value: string | undefined): { type: string; params: Record<string, string> } {
  const parts = (value ?? '').split(';');
  const type = (parts[0] ?? '').trim().toLowerCase();
  const params: Record<string, string> = {};
  for (const part of parts.slice(1)) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const key = part.slice(0, eq).trim().toLowerCase();
    let val = part.slice(eq + 1).trim();
    if (val.startsWith('"') && val.endsWith('"') && val.length >= 2) val = val.slice(1, -1);
    params[key] = val;
  }
  return { type, params };
}

/** Decode a body according to its Content-Transfer-Encoding. */
export function decodeTransfer(body: string, encoding: string | undefined, charset: string | undefined): string {
  const enc = (encoding ?? '').trim().toLowerCase();
  if (enc === 'base64') {
    try {
      const bin = atob(body.replace(/\s+/g, ''));
      const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
      return decodeBytes(bytes, charset);
    } catch {
      return '';
    }
  }
  if (enc === 'quoted-printable') {
    return decodeQuotedPrintable(body);
  }
  return body;
}

/** Decode bytes with the declared charset, falling back to UTF-8. */
export function decodeBytes(bytes: Uint8Array, charset: string | undefined): string {
  if (charset && charset.toLowerCase() !== 'utf-8' && charset.toLowerCase() !== 'utf8') {
    try {
      return new TextDecoder(charset).decode(bytes);
    } catch {
      // unknown charset → UTF-8
    }
  }
  return new TextDecoder('utf-8').decode(bytes);
}

/**
 * RFC 2045 quoted-printable decoding (soft line breaks + =XX escapes).
 *
 * The body is encoded to bytes once and the escapes are resolved on the byte
 * array: encoding character by character would be far slower, and the email
 * handler has a small CPU budget.
 */
export function decodeQuotedPrintable(input: string): string {
  const bytes = new TextEncoder().encode(input.replace(/=\r?\n/g, ''));
  const out = new Uint8Array(bytes.length);
  let length = 0;
  for (let i = 0; i < bytes.length; i++) {
    const byte = bytes[i] as number;
    if (byte === 0x3d /* '=' */ && i + 2 < bytes.length) {
      const hex = String.fromCharCode(bytes[i + 1] as number, bytes[i + 2] as number);
      if (/^[0-9A-Fa-f]{2}$/.test(hex)) {
        out[length++] = parseInt(hex, 16);
        i += 2;
        continue;
      }
    }
    out[length++] = byte;
  }
  return decodeBytes(out.subarray(0, length), 'utf-8');
}

/** Split a multipart body into its parts. */
export function splitMultipart(body: string, boundary: string): string[] {
  const delimiter = `--${boundary}`;
  const parts: string[] = [];
  for (const chunk of body.split(delimiter).slice(1)) {
    if (chunk.startsWith('--')) break; // closing delimiter
    parts.push(chunk.replace(/^\r?\n/, '').replace(/\r?\n$/, ''));
  }
  return parts;
}

/** Very small HTML → text fallback, used when a mail has no text/plain part. */
export function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#3?9;/gi, "'")
    .replace(/&amp;/gi, '&')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** A parsed mail: the header map plus the best available text/html bodies. */
export interface ParsedMail {
  headers: HeaderMap;
  text: string;
  html: string | null;
}

/**
 * Parse a raw mail into headers plus the text/plain and text/html parts.
 * Multipart bodies are walked recursively; the first text/plain and the first
 * text/html part win. The parser is intentionally forgiving — a malformed
 * mail yields whatever could be read instead of throwing.
 */
export function parseRawMail(raw: string): ParsedMail {
  const { headerText, bodyText } = splitHeaderAndBody(raw);
  const headers = parseHeaderBlock(headerText);
  const parsed = parseEntity(headers, bodyText, 0);
  return { headers, text: parsed.text, html: parsed.html };
}

/** Walk one MIME entity (headers + body), descending into multiparts. */
function parseEntity(
  headers: HeaderMap,
  body: string,
  depth: number,
): { text: string; html: string | null } {
  const { type, params } = parseContentType(headers['content-type']);
  const encoding = headers['content-transfer-encoding'];
  const charset = params.charset;

  if (type.startsWith('multipart/') && params.boundary && depth < 5) {
    let text = '';
    let html: string | null = null;
    for (const part of splitMultipart(body, params.boundary)) {
      const { headerText, bodyText } = splitHeaderAndBody(part);
      const child = parseEntity(parseHeaderBlock(headerText), bodyText, depth + 1);
      if (!text && child.text) text = child.text;
      if (html === null && child.html) html = child.html;
      if (text && html) break;
    }
    return { text, html };
  }

  const decoded = decodeTransfer(body, encoding, charset);
  if (type === 'text/html') return { text: '', html: decoded };
  if (type === 'text/plain' || type === '') return { text: decoded, html: null };
  // Unknown type (application/*, …): keep the decoded bytes as text so that
  // the operator still sees something useful.
  return { text: decoded, html: null };
}

/**
 * Decode the HTML entities that appear inside URLs.
 *
 * A verification link in an HTML mail is usually written as
 * `href="https://x.test/verify?a=1&amp;b=2"`. Without decoding, the stored
 * link would carry `&amp;` and the automatic visit would hit the wrong URL.
 * Only the entities that can legitimately appear inside a URL are decoded;
 * everything else is left alone.
 */
export function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&amp;/gi, '&')
    .replace(/&#38;/g, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>');
}

/**
 * Extract http/https links from the given sources.
 *
 * Rules: absolute http(s) only (relative links are ignored), first-seen order
 * is preserved, duplicates are dropped and the list is capped at MAX_LINKS.
 */
export function extractLinks(...sources: (string | null | undefined)[]): string[] {
  const found: string[] = [];
  const seen = new Set<string>();
  for (const source of sources) {
    if (!source) continue;
    const matches = source.match(/https?:\/\/[^\s<>"'`]+/gi);
    if (!matches) continue;
    for (const raw of matches) {
      const url = cleanUrl(raw);
      if (!url || seen.has(url)) continue;
      seen.add(url);
      found.push(url);
      if (found.length >= MAX_LINKS) return found;
    }
  }
  return found;
}

/** Trim trailing punctuation that sentence punctuation leaves on a URL. */
export function cleanUrl(raw: string): string {
  let url = raw.trim();
  while (url.length > 0) {
    const last = url.charAt(url.length - 1);
    if ('.,;:!?\'"'.includes(last)) {
      url = url.slice(0, -1);
      continue;
    }
    if (last === ')' && !url.includes('(')) {
      url = url.slice(0, -1);
      continue;
    }
    break;
  }
  return url;
}

/** Keep only the operational headers, keyed by lowercase name. */
export function selectHeaders(headers: HeaderMap): HeaderMap {
  const selected: HeaderMap = {};
  for (const key of SELECTED_HEADERS) {
    const value = headers[key];
    if (typeof value === 'string' && value.length > 0) selected[key] = value;
  }
  return selected;
}

/** Truncate the plain-text body to MAX_BODY_CHARS characters. */
export function truncateBody(text: string): string {
  if (text.length <= MAX_BODY_CHARS) return text;
  return text.slice(0, MAX_BODY_CHARS);
}

/** Parse the comma-separated TRUSTED_SENDER_DOMAINS secret. */
export function parseTrustedDomains(value: string | undefined): string[] {
  if (!value) return [];
  const domains = value
    .split(',')
    .map((d) => d.trim().toLowerCase())
    .filter((d) => d.length > 0);
  return Array.from(new Set(domains));
}

/** Extract the domain of a sender ("Name <user@example.com>" → "example.com"). */
export function senderDomain(sender: string): string {
  const match = sender.match(/@([^\s>,;]+)/);
  const domain = (match?.[1] ?? sender).trim().toLowerCase();
  return domain.replace(/[.)>]+$/, '');
}

/**
 * Is this sender domain covered by the trusted list?
 * A trusted domain also covers its own subdomains ("mail.example.com" is
 * covered by "example.com"), but nothing else — "notexample.com" is not.
 */
export function isTrustedSender(domain: string, trustedDomains: string[]): boolean {
  return trustedDomains.some(
    (trusted) => domain === trusted || domain.endsWith(`.${trusted}`),
  );
}

/**
 * Pick the single link the automatic action may visit.
 *
 * The link host must be exactly one of the trusted domains and its path must
 * contain "/verify" — everything else is left alone. HTML entities inside
 * the link are decoded first, because a link written in an HTML mail as
 * `?a=1&amp;b=2` must be visited as `?a=1&b=2`.
 */
export function pickVerificationLink(links: string[], trustedDomains: string[]): string | null {
  if (trustedDomains.length === 0) return null;
  for (const raw of links) {
    const link = decodeHtmlEntities(raw);
    let url: URL;
    try {
      url = new URL(link);
    } catch {
      continue;
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') continue;
    // The host must be *exactly* a trusted domain — a subdomain of it is not
    // trusted, because the trusted list names the hosts that may be visited.
    if (!trustedDomains.includes(url.host.toLowerCase())) continue;
    if (!url.pathname.toLowerCase().includes('/verify')) continue;
    return link;
  }
  return null;
}

/** Cap an action result summary to MAX_RESULT_CHARS characters. */
export function summarize(text: string): string {
  if (text.length <= MAX_RESULT_CHARS) return text;
  return `${text.slice(0, MAX_RESULT_CHARS - 1)}…`;
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

/** The mail as it is written to D1. */
export interface MailRecord {
  sender: string;
  recipient: string;
  subject: string | null;
  body: string;
  links: string[];
  headers: HeaderMap;
  messageId: string | null;
  receivedAt: string;
}

/**
 * Write one mail to `inbound_mail` and return its row id.
 * The links and headers are stored as JSON strings so the table stays a plain
 * SQLite table (D1 has no JSON column type worth relying on).
 */
export async function storeInboundMail(db: D1Like, mail: MailRecord): Promise<number> {
  const result = await db
    .prepare(
      `INSERT INTO inbound_mail (sender, recipient, subject, body, links, headers, message_id, received_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      mail.sender,
      mail.recipient,
      mail.subject,
      mail.body,
      JSON.stringify(mail.links),
      JSON.stringify(mail.headers),
      mail.messageId,
      mail.receivedAt,
    )
    .run();
  return Number(result?.meta?.last_row_id ?? 0);
}

/** Mark a mail as processed and store the reason. */
export async function markProcessed(
  db: D1Like,
  mailId: number,
  processedAt: string,
  note: string,
): Promise<void> {
  await db
    .prepare('UPDATE inbound_mail SET processed_at = ?, processed_note = ? WHERE id = ?')
    .bind(processedAt, summarize(note), mailId)
    .run();
}

/** Append one entry to the automatic-action audit trail. */
export async function recordAction(
  db: D1Like,
  mailId: number,
  action: string,
  targetUrl: string | null,
  result: string,
  createdAt: string,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO inbound_actions (mail_id, action, target_url, result, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .bind(mailId, action, targetUrl, summarize(result), createdAt)
    .run();
}

// ---------------------------------------------------------------------------
// Automatic action
// ---------------------------------------------------------------------------

/** The mail fields the automatic action needs. */
export interface AutoProcessInput {
  id: number;
  sender: string;
  links: string[];
}

/**
 * Run the (single, whitelisted) automatic action for one mail.
 *
 * The action only fires when all of the following hold:
 *   - TRUSTED_SENDER_DOMAINS is configured and the sender's domain is covered
 *     by it;
 *   - one of the mail links has a host that is exactly one of those domains;
 *   - that link's path contains "/verify";
 *   - at most one link is ever visited.
 *
 * Everything else is recorded as "nothing happened" on the mail row — no
 * request is made and no action row is written.
 */
export async function runAutoProcessing(
  db: D1Like,
  env: MailEnv,
  mail: AutoProcessInput,
  fetchImpl: FetchLike = globalThis.fetch as unknown as FetchLike,
  now: () => Date = () => new Date(),
): Promise<void> {
  const trustedDomains = parseTrustedDomains(env.TRUSTED_SENDER_DOMAINS);
  if (trustedDomains.length === 0) return; // automatic action disabled

  const timestamp = now().toISOString();

  if (!isTrustedSender(senderDomain(mail.sender), trustedDomains)) {
    await markProcessed(db, mail.id, timestamp, 'skipped: sender domain is not trusted');
    return;
  }

  const link = pickVerificationLink(mail.links, trustedDomains);
  if (!link) {
    await markProcessed(db, mail.id, timestamp, 'skipped: no trusted verification link');
    return;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), VISIT_TIMEOUT_MS);
  let result: string;
  try {
    const response = await fetchImpl(link, {
      method: 'GET',
      headers: { 'User-Agent': MAIL_USER_AGENT, Accept: '*/*' },
      signal: controller.signal,
      redirect: 'follow',
    });
    result = `status=${response.status}`;
  } catch (error) {
    const name = error instanceof Error ? error.name : 'Error';
    result = name === 'AbortError' ? 'error: timeout' : 'error: request failed';
  } finally {
    clearTimeout(timer);
  }

  // The visited URL is kept in the audit trail (operators need to see what was
  // opened); it never reaches the logs.
  await recordAction(db, mail.id, 'visit_link', link, result, timestamp);
  await markProcessed(db, mail.id, timestamp, `visit_link ${result}`);
}

// ---------------------------------------------------------------------------
// Read interface (fetch handler)
// ---------------------------------------------------------------------------

/** Parse the `limit` query parameter, clamped to [1, MAX_MAIL_LIMIT]. */
export function parseLimit(raw: string | null): number {
  if (!raw) return DEFAULT_MAIL_LIMIT;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value < 1) return DEFAULT_MAIL_LIMIT;
  return Math.min(value, MAX_MAIL_LIMIT);
}

/** Constant-time-ish token comparison (no early exit on the first mismatch). */
export function tokensMatch(provided: string, expected: string): boolean {
  if (provided.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < provided.length; i++) {
    diff |= provided.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return diff === 0;
}

/** JSON response helper. */
function jsonResponse(
  status: number,
  payload: unknown,
  headers: Record<string, string> = {},
): ResponseLike {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
  });
}

/**
 * The operator read interface.
 *
 *   GET /mail?limit=20  → recent mails without their body
 *   GET /mail/:id       → one mail in full (body, links, headers)
 *   GET /actions        → the automatic-action audit trail (last 50)
 *
 * Only GET is allowed (anything else → 405). Every GET must carry
 * `X-Queue-Token: <QUEUE_TOKEN>`; a missing or wrong token is answered with
 * 401 and the token is never echoed back. An unset secret means "no access at
 * all" — the interface fails closed.
 */
export async function handleOpsRequest(request: RequestLike, env: MailEnv): Promise<ResponseLike> {
  if (request.method !== 'GET') {
    return jsonResponse(405, { error: 'method_not_allowed', allow: 'GET' }, { Allow: 'GET' });
  }

  const expected = env.QUEUE_TOKEN;
  const provided = request.headers.get('x-queue-token') ?? '';
  if (!expected || !tokensMatch(provided, expected)) {
    return jsonResponse(401, { error: 'unauthorized' });
  }

  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, '') || '/';

  if (path === '/actions') {
    const rows = await env.DB
      .prepare(
        `SELECT id, mail_id, action, target_url, result, created_at
         FROM inbound_actions ORDER BY id DESC LIMIT ?`,
      )
      .bind(ACTIONS_LIMIT)
      .all<Record<string, unknown>>();
    return jsonResponse(200, { items: rows.results });
  }

  if (path === '/mail') {
    const limit = parseLimit(url.searchParams.get('limit'));
    const rows = await env.DB
      .prepare(
        `SELECT id, sender, recipient, subject, received_at, links
         FROM inbound_mail ORDER BY received_at DESC, id DESC LIMIT ?`,
      )
      .bind(limit)
      .all<Record<string, unknown>>();
    const items = rows.results.map((row) => ({
      id: row.id,
      sender: row.sender,
      recipient: row.recipient,
      subject: row.subject,
      received_at: row.received_at,
      links: parseJsonArray(row.links),
    }));
    return jsonResponse(200, { items });
  }

  const detail = /^\/mail\/(\d+)$/.exec(path);
  if (detail) {
    const row = await env.DB
      .prepare(
        `SELECT id, sender, recipient, subject, body, links, headers, message_id,
                received_at, processed_at, processed_note
         FROM inbound_mail WHERE id = ?`,
      )
      .bind(Number.parseInt(detail[1] ?? '0', 10))
      .first<Record<string, unknown>>();
    if (!row) return jsonResponse(404, { error: 'not_found' });
    // Flat object, like the other read endpoints of the AFR API: the operator
    // gets the mail itself, not a wrapper.
    return jsonResponse(200, {
      id: row.id,
      sender: row.sender,
      recipient: row.recipient,
      subject: row.subject,
      body: row.body,
      links: parseJsonArray(row.links),
      headers: parseJsonObject(row.headers),
      message_id: row.message_id,
      received_at: row.received_at,
      processed_at: row.processed_at,
      processed_note: row.processed_note,
    });
  }

  return jsonResponse(404, { error: 'not_found' });
}

/** Parse a stored JSON array column, tolerating legacy/garbage values. */
export function parseJsonArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string') return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** Parse a stored JSON object column, tolerating legacy/garbage values. */
export function parseJsonObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value !== 'string') return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

/** Read the raw mail bytes as text, bounded by MAX_RAW_BYTES. */
export async function readRawMail(raw: ForwardableEmailMessageLike['raw']): Promise<string> {
  if (typeof raw === 'string') return raw.slice(0, MAX_RAW_BYTES);
  if (raw instanceof Uint8Array) return new TextDecoder('utf-8').decode(raw.slice(0, MAX_RAW_BYTES));
  if (raw instanceof ArrayBuffer) {
    return new TextDecoder('utf-8').decode(new Uint8Array(raw).slice(0, MAX_RAW_BYTES));
  }
  const reader = (raw as ReadableStream<Uint8Array>).getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    chunks.push(value);
    total += value.length;
    if (total >= MAX_RAW_BYTES) {
      try {
        await reader.cancel();
      } catch {
        // the stream may already be closed — nothing to do
      }
      break;
    }
  }
  const merged = new Uint8Array(Math.min(total, MAX_RAW_BYTES));
  let offset = 0;
  for (const chunk of chunks) {
    if (offset >= merged.length) break;
    const slice = chunk.subarray(0, merged.length - offset);
    merged.set(slice, offset);
    offset += slice.length;
  }
  return new TextDecoder('utf-8').decode(merged);
}

/**
 * Inbound mail handler.
 *
 * The mail is stored first — a parse failure still produces a row (with the
 * body prefixed "PARSE_ERROR:") so nothing is lost. The automatic action runs
 * afterwards inside ctx.waitUntil and can never throw into the delivery path.
 */
export async function email(
  message: ForwardableEmailMessageLike,
  env: MailEnv,
  ctx: ExecutionContextLike,
): Promise<void> {
  const receivedAt = new Date().toISOString();

  let raw = '';
  let parseError: string | null = null;
  try {
    raw = await readRawMail(message.raw);
  } catch (error) {
    parseError = error instanceof Error ? error.message : 'unknown error';
  }

  let parsed: ParsedMail = { headers: {}, text: '', html: null };
  if (!parseError) {
    try {
      parsed = parseRawMail(raw);
    } catch (error) {
      parseError = error instanceof Error ? error.message : 'unknown error';
    }
  }

  // The routing headers as Cloudflare saw them are the authoritative copy;
  // the parsed ones only fill the gaps.
  const headers: HeaderMap = { ...parsed.headers };
  for (const key of SELECTED_HEADERS) {
    const value = message.headers.get(key);
    if (value) headers[key] = value;
  }

  const text = parsed.text || (parsed.html ? htmlToText(parsed.html) : '');
  const body = parseError ? `PARSE_ERROR: ${parseError}` : truncateBody(text);
  // The HTML part is decoded before the links are taken out of it: a link
  // written as `?a=1&amp;b=2` must be visited as `?a=1&b=2`.
  const links = parseError ? [] : extractLinks(text, parsed.html ? decodeHtmlEntities(parsed.html) : '');

  const mail: MailRecord = {
    sender: message.from || headers.from || '',
    recipient: message.to || headers.to || '',
    subject: headers.subject ?? null,
    body,
    links,
    headers: selectHeaders(headers),
    messageId: headers['message-id'] ?? null,
    receivedAt,
  };

  let mailId = 0;
  try {
    mailId = await storeInboundMail(env.DB, mail);
  } catch (error) {
    // Storage failures must not reject the mail; log the failure class only.
    const name = error instanceof Error ? error.name : 'Error';
    console.error('[afr-mail] failed to store inbound mail', { error: name });
    return;
  }

  console.log('[afr-mail] stored inbound mail', { id: mailId, links: links.length });

  // The automatic action runs in the background and can never break delivery.
  // The promise is deferred by one microtask so that every side effect of the
  // action (the D1 writes, the outbound request) starts only after
  // ctx.waitUntil has taken ownership of it.
  const guarded = Promise.resolve()
    .then(() =>
      runAutoProcessing(env.DB, env, {
        id: mailId,
        sender: mail.sender,
        links,
      }),
    )
    .catch((error: unknown) => {
      const name = error instanceof Error ? error.name : 'Error';
      console.error('[afr-mail] auto processing failed', { error: name });
    });
  try {
    ctx.waitUntil(guarded);
  } catch {
    // A missing/invalid ctx must not break delivery either.
  }
}

/** HTTP handler — the operator read interface. */
export async function fetch(
  request: RequestLike,
  env: MailEnv,
  _ctx?: ExecutionContextLike,
): Promise<ResponseLike> {
  return handleOpsRequest(request, env);
}

/** Workers entrypoint. */
export default {
  email,
  fetch,
};
