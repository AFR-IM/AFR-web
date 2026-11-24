// src/email.ts — owner mailbox crypto, magic-link mail and the score-change
// notification outbox.
//
// Two rules shape this module:
//
//   1. Zero third-party dependencies. Only WebCrypto (`globalThis.crypto.subtle`)
//      and `fetch` are used. The module is bundled into the Worker, where
//      `node:crypto` does not exist — importing it would break the deploy — so
//      the crypto primitives are reached through the global object, which
//      exists both in Node (tests) and in workerd (production).
//
//   2. The owner's mailbox address never touches D1 in plaintext and never
//      appears in a log line or an API response. The database keeps an
//      AES-256-GCM ciphertext plus a keyed HMAC hash used for lookups/dedupe
//      only (an unkeyed hash of an e-mail address is reversible by brute force,
//      a keyed one is not).
//
// The encryption key is derived from a single base64 secret with HKDF-SHA256
// into two purpose-separated keys: `afr-email-enc` (AES-GCM-256) and
// `afr-email-mac` (HMAC-SHA256). One secret, two independent purposes, so the
// MAC key can never be used to decrypt and the AES key never produces a
// comparable digest.

import { USER_AGENT } from '../../../packages/scanner/src/http.ts';
import type { Db, Row } from './db.ts';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** HKDF `info` strings — the purpose separation between the two derived keys */
const ENC_INFO = 'afr-email-enc';
const MAC_INFO = 'afr-email-mac';
/** Fixed HKDF salt: the secret itself is already high-entropy, a static salt
 * keeps the derivation reproducible across isolates (D1 has no per-row salt
 * storage) while the `info` strings keep the two keys apart. */
const HKDF_SALT = 'afr-im/owner-email/v1';

/** Magic links stay valid for 24 hours — long enough for an owner to read the
 * mail, short enough that a leaked link is not a lasting credential. */
export const EMAIL_VERIFY_TTL_MS = 24 * 60 * 60 * 1000;

/** A domain-control challenge stays valid for 24 hours — long enough to
 * publish it (DNS propagation, deploy), short enough that a leaked challenge
 * cannot be replayed forever. */
export const EMAIL_CHALLENGE_TTL_MS = 24 * 60 * 60 * 1000;

/** A management-token recovery link stays valid for 24 hours — the same
 * window as the mailbox confirmation: long enough to read the mail, short
 * enough that a leaked link is not a lasting credential. */
export const EMAIL_RECOVERY_TTL_MS = 24 * 60 * 60 * 1000;

/** Prefix of the opaque domain-control challenge. The value is public by
 * design (it is published on the domain), so only its hash is stored. */
const MAIL_CHALLENGE_PREFIX = 'ch-';
/** Prefix of the management token handed out once the mailbox is confirmed. */
const MANAGE_TOKEN_PREFIX = 'manage-';
/** Key of the DNS TXT record the challenge is published with. */
const MAIL_CHALLENGE_DNS_KEY = 'afr-mail';
/** Path of the well-known file the challenge is published in. */
const MAIL_CHALLENGE_FILE_PATH = '/.well-known/afr-mail.txt';
/** Name of the homepage meta tag the challenge is published in. */
export const MAIL_CHALLENGE_META_NAME = 'afr-mail-verification';
/** Per-probe timeout — one slow site must not stall a registration. */
const MAIL_PROBE_TIMEOUT_MS = 8000;
/** Cloudflare DoH endpoint (JSON API) used for the TXT lookup. */
const DOH_URL = 'https://cloudflare-dns.com/dns-query';

/** Public site used when no PUBLIC_SITE_URL binding is configured */
export const DEFAULT_BASE_URL = 'https://afr.im';
/** Sender address used when no EMAIL_FROM binding is configured */
export const DEFAULT_FROM = 'AFR <notifications@afr.im>';

/** A failed send is retried on the next drain until it reached this many
 * attempts; after that the event is parked as `failed` for manual review. */
export const NOTIFY_MAX_ATTEMPTS = 5;
/** Rows drained per run — the free-tier Worker has a subrequest budget, so a
 * drain must stay small. */
export const NOTIFY_DRAIN_LIMIT = 20;
/** Cooldown after a failed delivery. The sync endpoint runs once per page of
 * the data set (dozens of times per rebuild), so without a cooldown a single
 * provider outage would burn all five attempts within one rebuild and park
 * the event as failed before the provider recovered. */
export const NOTIFY_RETRY_COOLDOWN_MS = 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

/** WebCrypto handle.
 *
 * The worker type bundle declares `crypto` as a global constant rather than a
 * property of `globalThis`, so it is reached through a typed cast. The
 * runtime object is the same in Node (tests) and in workerd (production) —
 * no `node:crypto` import, which would break the worker bundle. */
const webCrypto: Crypto = (globalThis as unknown as { crypto: Crypto }).crypto;

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

function bytesToHex(bytes: Uint8Array): string {
  let hex = '';
  for (const byte of bytes) hex += byte.toString(16).padStart(2, '0');
  return hex;
}

/** Cryptographically random bytes (12 bytes for an AES-GCM IV). */
function randomBytes(length: number): Uint8Array {
  const out = new Uint8Array(length);
  webCrypto.getRandomValues(out);
  return out;
}

/** Cut a message to a fixed length so it can be stored in a TEXT column. */
export function truncate(value: string, max = 200): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

// ---------------------------------------------------------------------------
// Address validation / masking
// ---------------------------------------------------------------------------

/** Normalize a submitted mailbox address to its canonical form (trimmed,
 * lower-cased) or return null when it cannot be a deliverable address.
 *
 * Deliberately strict: the address is stored encrypted and mailed to, so a
 * typo silently becomes a lost notification. `local@domain.tld` is required —
 * exactly one `@`, a dotted domain, no whitespace, RFC-ish length caps. */
export function normalizeEmail(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const value = raw.trim().toLowerCase();
  if (!value || value.length > 254) return null;
  if (/\s/.test(value)) return null;

  const at = value.indexOf('@');
  if (at <= 0) return null;
  if (value.indexOf('@', at + 1) !== -1) return null; // exactly one '@'

  const local = value.slice(0, at);
  const domain = value.slice(at + 1);
  if (!local || local.length > 64) return null;
  if (!/^[a-z0-9!#$%&'*+/=?^_`{|}~.-]+$/.test(local)) return null;
  if (local.startsWith('.') || local.endsWith('.') || local.includes('..')) return null;

  if (!domain.includes('.')) return null; // `a@b` is not a routable mailbox
  if (domain.length > 253) return null;
  const labels = domain.split('.');
  if (labels.some((label) => !label || label.length > 63)) return null;
  if (!labels.every((label) => /^[a-z0-9-]+$/.test(label))) return null;
  const tld = labels[labels.length - 1] ?? '';
  if (!/^[a-z]{2,}$/.test(tld)) return null;
  return value;
}

/** Mask an address for API responses and log lines: keep the first character
 * of the local part and the domain, drop everything else. */
export function maskEmail(email: string): string {
  const value = email.trim().toLowerCase();
  const at = value.indexOf('@');
  if (at <= 0) return '***';
  const local = value.slice(0, at);
  const domain = value.slice(at + 1);
  if (!domain) return '***';
  return `${local[0]}***@${domain}`;
}

// ---------------------------------------------------------------------------
// Key derivation
// ---------------------------------------------------------------------------

/** Decode the configured secret. The production secret is 32 random bytes in
 * base64; a shorter/longer value is still accepted (HKDF stretches any input)
 * so a misconfigured secret fails loudly at crypto time instead of silently
 * deriving a weak key. Base64url input is tolerated as well. */
function secretBytes(secretB64: string): Uint8Array {
  const trimmed = secretB64.trim();
  if (!trimmed) throw new Error('email secret is empty');
  const normalized = trimmed.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
  try {
    const bytes = base64ToBytes(padded);
    if (bytes.length > 0) return bytes;
  } catch {
    // Not base64 at all — fall through to the raw bytes of the string.
  }
  return textEncoder.encode(trimmed);
}

interface DerivedKeys {
  enc: CryptoKey;
  mac: CryptoKey;
}

async function deriveKeys(secretB64: string): Promise<DerivedKeys> {
  const material = await webCrypto.subtle.importKey(
    'raw',
    secretBytes(secretB64),
    'HKDF',
    false,
    ['deriveKey'],
  );
  const salt = textEncoder.encode(HKDF_SALT);
  const enc = await webCrypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt, info: textEncoder.encode(ENC_INFO) },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
  const mac = await webCrypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt, info: textEncoder.encode(MAC_INFO) },
    material,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return { enc, mac };
}

/** HMAC-SHA256 over the normalized address, hex encoded. Keyed, so the value
 * cannot be brute-forced from a public list of addresses. */
async function macHex(macKey: CryptoKey, value: string): Promise<string> {
  const signature = await webCrypto.subtle.sign(
    'HMAC',
    macKey,
    textEncoder.encode(value),
  );
  return bytesToHex(new Uint8Array(signature));
}

// ---------------------------------------------------------------------------
// Mailbox encryption
// ---------------------------------------------------------------------------

/** Encrypt a mailbox address and compute its lookup hash.
 * The cipher text is base64(iv || ciphertext) — the IV is stored with the
 * ciphertext because GCM needs it to decrypt and it is not secret. */
export async function encryptEmail(
  email: string,
  secretB64: string,
): Promise<{ cipher: string; hash: string }> {
  const normalized = normalizeEmail(email);
  if (!normalized) throw new Error('invalid email address');
  const { enc, mac } = await deriveKeys(secretB64);

  const iv = randomBytes(12);
  const ciphertext = new Uint8Array(
    await webCrypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      enc,
      textEncoder.encode(normalized),
    ),
  );
  const combined = new Uint8Array(iv.length + ciphertext.length);
  combined.set(iv, 0);
  combined.set(ciphertext, iv.length);

  return {
    cipher: bytesToBase64(combined),
    hash: await macHex(mac, normalized),
  };
}

/** Decrypt a stored mailbox address. Throws when the cipher text is damaged
 * or the secret is wrong — the caller must never treat that as "no address". */
export async function decryptEmail(cipherB64: string, secretB64: string): Promise<string> {
  const { enc } = await deriveKeys(secretB64);
  const combined = base64ToBytes(cipherB64);
  if (combined.length <= 12) throw new Error('cipher text is too short');
  const iv = combined.slice(0, 12);
  const ciphertext = combined.slice(12);
  const plaintext = await webCrypto.subtle.decrypt(
    { name: 'AES-GCM', iv },
    enc,
    ciphertext,
  );
  return textDecoder.decode(plaintext);
}

/** Keyed hash of a mailbox address — used to look up / dedupe owners without
 * storing (or decrypting) the address itself. */
export async function emailHash(email: string, secretB64: string): Promise<string> {
  const normalized = normalizeEmail(email);
  if (!normalized) throw new Error('invalid email address');
  const { mac } = await deriveKeys(secretB64);
  return macHex(mac, normalized);
}

// ---------------------------------------------------------------------------
// Magic tokens
// ---------------------------------------------------------------------------

/** Opaque single-use token embedded in the verification link. 128 bits of
 * randomness from the platform CSPRNG — the token is stored hashed, so a
 * database leak does not hand over live links. */
export function buildMagicToken(): string {
  return webCrypto.randomUUID().replaceAll('-', '');
}

/** SHA-256 of a magic token, hex encoded — the value stored in D1.
 * (WebCrypto's digest is asynchronous, hence the Promise.) */
export async function hashToken(token: string): Promise<string> {
  const digest = await webCrypto.subtle.digest('SHA-256', textEncoder.encode(token));
  return bytesToHex(new Uint8Array(digest));
}

/** Absolute verification link for a magic token. */
export function magicLinkUrl(baseUrl: string, token: string): string {
  const base = baseUrl.replace(/\/+$/, '');
  return `${base}/api/v1/owners/email/verify?token=${encodeURIComponent(token)}`;
}

/** Absolute recovery link for a lost management token.
 *
 * The link lives on its own path: the recovery token is not a mailbox
 * confirmation token and must never unlock that flow. */
export function recoveryLinkUrl(baseUrl: string, token: string): string {
  const base = baseUrl.replace(/\/+$/, '');
  return `${base}/api/v1/owners/email/recover/verify?token=${encodeURIComponent(token)}`;
}

// ---------------------------------------------------------------------------
// Domain-control challenge + management token
// ---------------------------------------------------------------------------

/** Opaque domain-control challenge: 'ch-' + 32 lowercase hex chars.
 *
 * The challenge is published *by the domain itself* (DNS TXT, well-known file
 * or homepage meta tag). Only its SHA-256 hash is stored, so a database leak
 * does not hand out usable challenges — but the value is public anyway, the
 * platform simply has to observe it on the domain before it accepts a
 * mailbox registration. */
export function buildMailChallenge(): string {
  return `${MAIL_CHALLENGE_PREFIX}${webCrypto.randomUUID().replaceAll('-', '')}`;
}

/** Management token: 'manage-' + 32 lowercase hex chars.
 *
 * Handed out exactly once — in the response of the mailbox confirmation — and
 * required by every later read/toggle of that mailbox. Only its SHA-256 hash
 * is stored. */
export function buildManageToken(): string {
  return `${MANAGE_TOKEN_PREFIX}${webCrypto.randomUUID().replaceAll('-', '')}`;
}

/** Case-insensitive match of <meta name="afr-mail-verification" content="<challenge>">
 * (either attribute order), mirroring the domain-verification meta tag. */
export function hasMailChallengeMeta(html: string, challenge: string): boolean {
  for (const tag of html.match(/<meta\b[^>]*>/gi) ?? []) {
    if (!/\bname\s*=\s*["']afr-mail-verification["']/i.test(tag)) continue;
    const content = /\bcontent\s*=\s*["']([^"']*)["']/i.exec(tag);
    if (content?.[1] === challenge) return true;
  }
  return false;
}

/** Outcome of one publication method. `detail` never contains remote body
 * content — it is a fixed phrase plus a status code. */
export interface MailChallengeProbe {
  method: MailChallengeMethod;
  ok: boolean;
  detail: string;
}

/** The three ways a domain can publish the challenge. */
export type MailChallengeMethod = 'dns' | 'file' | 'meta';

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function probeMailDns(
  domain: string,
  challenge: string,
  fetchImpl: typeof fetch,
): Promise<MailChallengeProbe> {
  try {
    const res = await fetchImpl(`${DOH_URL}?name=${encodeURIComponent(domain)}&type=TXT`, {
      headers: { accept: 'application/dns-json', 'user-agent': USER_AGENT },
      signal: AbortSignal.timeout(MAIL_PROBE_TIMEOUT_MS),
    });
    if (!res.ok) {
      return { method: 'dns', ok: false, detail: truncate(`dns: DoH HTTP ${res.status}`, 80) };
    }
    const payload = (await res.json()) as {
      Status?: number;
      Answer?: Array<{ type?: number; data?: string }>;
    };
    if (payload.Status !== undefined && payload.Status !== 0) {
      return { method: 'dns', ok: false, detail: truncate(`dns: DoH status ${payload.Status}`, 80) };
    }
    const needle = `${MAIL_CHALLENGE_DNS_KEY}=${challenge}`;
    const ok = (payload.Answer ?? []).some(
      (answer) => answer.type === 16 && (answer.data ?? '').includes(needle),
    );
    return {
      method: 'dns',
      ok,
      detail: ok ? 'dns: TXT record matched' : 'dns: no matching TXT record',
    };
  } catch (err) {
    return { method: 'dns', ok: false, detail: truncate(`dns: ${errorMessage(err)}`, 80) };
  }
}

async function probeMailFile(
  domain: string,
  challenge: string,
  fetchImpl: typeof fetch,
): Promise<MailChallengeProbe> {
  try {
    const res = await fetchImpl(`https://${domain}${MAIL_CHALLENGE_FILE_PATH}`, {
      headers: { 'user-agent': USER_AGENT },
      signal: AbortSignal.timeout(MAIL_PROBE_TIMEOUT_MS),
    });
    if (!res.ok) {
      return { method: 'file', ok: false, detail: truncate(`file: HTTP ${res.status}`, 80) };
    }
    // The challenge file is tiny — cap the read so a huge response cannot stall us
    const body = (await res.text()).slice(0, 4096).trim();
    const ok = body === challenge;
    return {
      method: 'file',
      ok,
      detail: ok ? 'file: challenge matched' : 'file: content does not match challenge',
    };
  } catch (err) {
    return { method: 'file', ok: false, detail: truncate(`file: ${errorMessage(err)}`, 80) };
  }
}

async function probeMailMeta(
  domain: string,
  challenge: string,
  fetchImpl: typeof fetch,
): Promise<MailChallengeProbe> {
  try {
    const res = await fetchImpl(`https://${domain}/`, {
      headers: { 'user-agent': USER_AGENT },
      signal: AbortSignal.timeout(MAIL_PROBE_TIMEOUT_MS),
    });
    if (!res.ok) {
      return { method: 'meta', ok: false, detail: truncate(`meta: HTTP ${res.status}`, 80) };
    }
    // Meta tags live in <head> — cap the read so a huge homepage cannot stall us
    const html = (await res.text()).slice(0, 512_000);
    const ok = hasMailChallengeMeta(html, challenge);
    return {
      method: 'meta',
      ok,
      detail: ok ? 'meta: tag matched' : 'meta: tag missing or content mismatch',
    };
  } catch (err) {
    return { method: 'meta', ok: false, detail: truncate(`meta: ${errorMessage(err)}`, 80) };
  }
}

/** Run the three publication probes in parallel. Every probe catches its own
 * failures, so an unreachable site yields a negative result instead of a
 * thrown error. The order is fixed (dns → file → meta). */
export async function probeMailChallengeAll(
  domain: string,
  challenge: string,
  fetchImpl: typeof fetch,
): Promise<MailChallengeProbe[]> {
  const [dns, file, meta] = await Promise.all([
    probeMailDns(domain, challenge, fetchImpl),
    probeMailFile(domain, challenge, fetchImpl),
    probeMailMeta(domain, challenge, fetchImpl),
  ]);
  return [dns, file, meta];
}

/** Look for the challenge on the domain itself.
 *
 * A hit proves domain control; a miss (including every network error) is
 * simply "not proven" — the caller decides what to do with it. `method` is the
 * publication method that matched, or null when none did. */
export async function probeMailChallenge(
  domain: string,
  challenge: string,
  fetchImpl: typeof fetch,
): Promise<{ ok: boolean; method: MailChallengeMethod | null; detail: string }> {
  const results = await probeMailChallengeAll(domain, challenge, fetchImpl);
  const hit = results.find((result) => result.ok);
  if (hit) return { ok: true, method: hit.method, detail: hit.detail };
  const detail = truncate(results.map((result) => result.detail).join('; '), 80);
  return { ok: false, method: null, detail };
}

// ---------------------------------------------------------------------------
// Mail rendering
// ---------------------------------------------------------------------------

function escapeHtml(value: string): string {
  const map: Record<string, string> = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  };
  return value.replace(/[&<>"']/g, (char) => map[char] ?? char);
}

function gradeLabel(grade: string | null): string {
  return grade ?? 'Pending';
}

function scoreLabel(score: number | null): string {
  return score === null || score === undefined ? '' : ` (${score})`;
}

/** Subject + body of the score-change notification. Both the previous and the
 * new rating must be visible: an owner who only sees "your rating changed"
 * cannot tell whether the site got better or worse. */
export function renderScoreChangeEmail(args: {
  domain: string;
  prevGrade: string | null;
  prevScore: number | null;
  grade: string | null;
  score: number | null;
  reportUrl: string;
}): { subject: string; text: string; html: string } {
  const newGrade = gradeLabel(args.grade);
  const newScore = scoreLabel(args.score);
  const subject = `AFR rating changed: ${args.domain} is now ${newGrade}${newScore}`;

  const prevGrade = args.prevGrade ?? 'not rated yet';
  const prevScore = args.prevScore === null || args.prevScore === undefined ? '' : ` (${args.prevScore})`;
  const reportUrl = args.reportUrl;

  const text = [
    `AFR rating changed: ${args.domain} is now ${newGrade}${newScore}.`,
    '',
    `Previous rating: ${prevGrade}${prevScore}`,
    `New rating: ${newGrade}${newScore}`,
    '',
    `Full report: ${reportUrl}`,
    '',
    'You receive this mail because this address is registered as the owner mailbox',
    `for ${args.domain}.`,
  ].join('\n');

  const html = [
    '<!doctype html>',
    '<html><body style="margin:0;padding:24px;background:#f6f7f9;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#111827;">',
    '<div style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:10px;padding:24px;border:1px solid #e5e7eb;">',
    `<h1 style="margin:0 0 16px;font-size:20px;line-height:1.4;">AFR rating changed: ${escapeHtml(args.domain)} is now ${escapeHtml(newGrade)}${escapeHtml(newScore)}</h1>`,
    '<table style="width:100%;border-collapse:collapse;font-size:15px;">',
    `<tr><td style="padding:8px 0;color:#6b7280;">Previous rating</td><td style="padding:8px 0;font-weight:600;">${escapeHtml(prevGrade)}${escapeHtml(prevScore)}</td></tr>`,
    `<tr><td style="padding:8px 0;color:#6b7280;">New rating</td><td style="padding:8px 0;font-weight:600;">${escapeHtml(newGrade)}${escapeHtml(newScore)}</td></tr>`,
    '</table>',
    `<p style="margin:20px 0;"><a href="${escapeHtml(reportUrl)}" style="display:inline-block;background:#111827;color:#ffffff;text-decoration:none;padding:10px 16px;border-radius:6px;">View the full report</a></p>`,
    `<p style="margin:0;color:#6b7280;font-size:13px;line-height:1.5;">You receive this mail because this address is registered as the owner mailbox for ${escapeHtml(args.domain)}.</p>`,
    '</div></body></html>',
  ].join('');

  return { subject, text, html };
}

/** Subject + body of the mailbox verification mail. */
export function renderVerificationEmail(args: {
  domain: string;
  verifyUrl: string;
}): { subject: string; text: string; html: string } {
  const subject = `Confirm your AFR owner mailbox for ${args.domain}`;
  const text = [
    `Confirm your AFR owner mailbox for ${args.domain}.`,
    '',
    `Open this link to finish the setup: ${args.verifyUrl}`,
    '',
    'The link works once and expires in 24 hours. If you did not request it,',
    'ignore this mail — nothing was changed.',
  ].join('\n');

  const html = [
    '<!doctype html>',
    '<html><body style="margin:0;padding:24px;background:#f6f7f9;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#111827;">',
    '<div style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:10px;padding:24px;border:1px solid #e5e7eb;">',
    `<h1 style="margin:0 0 16px;font-size:20px;line-height:1.4;">Confirm your AFR owner mailbox for ${escapeHtml(args.domain)}</h1>`,
    `<p style="margin:0 0 20px;font-size:15px;line-height:1.6;">Open the link below to finish the setup. It works once and expires in 24 hours.</p>`,
    `<p style="margin:0 0 20px;"><a href="${escapeHtml(args.verifyUrl)}" style="display:inline-block;background:#111827;color:#ffffff;text-decoration:none;padding:10px 16px;border-radius:6px;">Confirm this mailbox</a></p>`,
    `<p style="margin:0;color:#6b7280;font-size:13px;line-height:1.5;">If you did not request this, ignore this mail — nothing was changed.</p>`,
    '</div></body></html>',
  ].join('');

  return { subject, text, html };
}

/** Subject + body of the management-token recovery mail.
 *
 * The mail is the second lock of the recovery: it only ever reaches the
 * confirmed address of the domain, so the link proves mailbox control. The
 * body therefore states what the click does (a new management token, the old
 * one stops working) — an owner has to know that before clicking. */
export function renderRecoveryEmail(args: {
  domain: string;
  url: string;
}): { subject: string; text: string; html: string } {
  const subject = `Recover the AFR owner token for ${args.domain}`;
  const text = [
    `Recover the AFR owner token for ${args.domain}.`,
    '',
    `Open this link to receive a new management token: ${args.url}`,
    '',
    'The link works once and expires in 24 hours. After the click the previous',
    'management token stops working and a new one is handed out.',
    '',
    'If you did not request this, ignore this mail — nothing was changed and',
    'the current management token stays valid.',
  ].join('\n');

  const html = [
    '<!doctype html>',
    '<html><body style="margin:0;padding:24px;background:#f6f7f9;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#111827;">',
    '<div style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:10px;padding:24px;border:1px solid #e5e7eb;">',
    `<h1 style="margin:0 0 16px;font-size:20px;line-height:1.4;">Recover the AFR owner token for ${escapeHtml(args.domain)}</h1>`,
    '<p style="margin:0 0 20px;font-size:15px;line-height:1.6;">Open the link below to receive a new management token. It works once and expires in 24 hours. After the click the previous management token stops working.</p>',
    `<p style="margin:0 0 20px;"><a href="${escapeHtml(args.url)}" style="display:inline-block;background:#111827;color:#ffffff;text-decoration:none;padding:10px 16px;border-radius:6px;">Recover the management token</a></p>`,
    '<p style="margin:0;color:#6b7280;font-size:13px;line-height:1.5;">If you did not request this, ignore this mail — nothing was changed and the current management token stays valid.</p>',
    '</div></body></html>',
  ].join('');

  return { subject, text, html };
}

// ---------------------------------------------------------------------------
// Resend delivery
// ---------------------------------------------------------------------------

/** Redact an error string before it is returned or stored: the API key must
 * never leak, and the recipient address may only appear masked. */
function redactSecrets(value: string, apiKey: string): string {
  let out = value;
  if (apiKey) out = out.split(apiKey).join('[redacted]');
  out = out.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, (match) => maskEmail(match));
  return out;
}

/** Send one mail through Resend.
 *
 * The `Idempotency-Key` header is what makes a retry safe: Resend replays the
 * original response for a repeated key instead of sending a second mail, so a
 * drain that crashed after the provider accepted the request cannot double-send.
 *
 * Errors are redacted (no API key, no full recipient address) and truncated —
 * they end up in `notify_outbox.last_error` and in the API response. */
export async function sendEmailViaResend(
  args: {
    apiKey: string;
    from: string;
    to: string;
    subject: string;
    text: string;
    html: string;
    idempotencyKey: string;
  },
  fetchImpl: typeof fetch,
): Promise<{ ok: boolean; id?: string; error?: string }> {
  const { apiKey, from, to, subject, text, html, idempotencyKey } = args;
  try {
    const res = await fetchImpl('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
        'idempotency-key': idempotencyKey,
      },
      body: JSON.stringify({ from, to, subject, text, html }),
      signal: AbortSignal.timeout(10_000),
    });

    if (res.ok) {
      let id: string | undefined;
      try {
        const payload = (await res.json()) as { id?: unknown };
        if (typeof payload?.id === 'string') id = payload.id;
      } catch {
        // A 2xx without a parsable body is still a success — the mail was accepted.
      }
      return id ? { ok: true, id } : { ok: true };
    }

    let detail = '';
    try {
      detail = await res.text();
    } catch {
      // Body already consumed / unreadable — the status alone is the error.
    }
    const message = `HTTP ${res.status}${detail ? `: ${detail}` : ''}`;
    return { ok: false, error: truncate(redactSecrets(message, apiKey), 200) };
  } catch (err) {
    const message = `network error: ${err instanceof Error ? err.message : String(err)}`;
    return { ok: false, error: truncate(redactSecrets(message, apiKey), 200) };
  }
}

// ---------------------------------------------------------------------------
// Score-change outbox
// ---------------------------------------------------------------------------

interface SiteStateRow extends Row {
  grade: string | null;
  score_total: number | null;
  scanned_at: string | null;
}

interface OutboxStateRow extends Row {
  grade: string | null;
  score_total: number | null;
}

/** The state a domain was last seen in — the baseline a change is measured
 * against. The newest outbox event is that baseline once an owner has one;
 * before that, the previous scan of the domain is the only known earlier
 * state. Without a baseline no change can be proven, so nothing is enqueued. */
async function resolveBaseline(
  db: Db,
  domain: string,
): Promise<{ grade: string | null; score: number | null } | null> {
  const lastEvent = await db
    .prepare('SELECT grade, score_total FROM notify_outbox WHERE domain = ? ORDER BY id DESC LIMIT 1')
    .get<OutboxStateRow>(domain);
  if (lastEvent) {
    return { grade: lastEvent.grade ?? null, score: lastEvent.score_total ?? null };
  }

  const previousScan = await db
    .prepare(
      `SELECT grade, score_total FROM scans WHERE domain = ?
       ORDER BY started_at DESC, id DESC LIMIT 1 OFFSET 1`,
    )
    .get<OutboxStateRow>(domain);
  if (!previousScan) return null;
  return { grade: previousScan.grade ?? null, score: previousScan.score_total ?? null };
}

/** Enqueue a notification for every verified owner whose domain changed.
 *
 * Three gates decide who gets mail:
 *   1. the mailbox itself is confirmed (`verified_at`) and not opted out
 *      (`notify = 1`),
 *   2. the domain is a *verified site* of AFR (an `owners` row or
 *      `sites.verified = 1`) — a mailbox alone must not pull mail for a site
 *      AFR never confirmed,
 *   3. the rating really changed (a baseline must exist and differ).
 *
 * One row per change event; `event_key` is unique, so a repeated call (cron
 * plus sync endpoint in the same minute) cannot enqueue the same event twice.
 * Returns the number of newly inserted rows. */
export async function enqueueScoreChangeNotifications(
  db: Db,
  opts: { now?: () => Date; limit?: number } = {},
): Promise<number> {
  const now = opts.now?.() ?? new Date();
  const limit = opts.limit ?? 500;

  const owners = await db
    .prepare(
      `SELECT o.domain AS domain FROM owner_emails o
       WHERE o.verified_at IS NOT NULL AND o.notify = 1
         AND (EXISTS (SELECT 1 FROM owners ow WHERE ow.domain = o.domain)
              OR EXISTS (SELECT 1 FROM sites s WHERE s.domain = o.domain AND s.verified = 1))
       ORDER BY o.domain LIMIT ?`,
    )
    .all<{ domain: string }>(limit);

  let inserted = 0;
  for (const owner of owners) {
    const domain = owner.domain;
    const site = await db
      .prepare('SELECT grade, score_total, scanned_at FROM sites WHERE domain = ?')
      .get<SiteStateRow>(domain);
    if (!site) continue; // domain is gone from the directory — nothing to report

    const grade = site.grade ?? null;
    const score = site.score_total === null || site.score_total === undefined ? null : Number(site.score_total);
    const baseline = await resolveBaseline(db, domain);
    if (!baseline) continue; // no known previous state — no provable change
    if (baseline.grade === grade && baseline.score === score) continue; // unchanged

    const eventKey = `${domain}|${site.scanned_at ?? ''}|${grade ?? ''}|${score ?? ''}`;
    const result = await db
      .prepare(
        `INSERT OR IGNORE INTO notify_outbox
           (domain, event_key, grade, score_total, prev_grade, prev_score, status, attempts, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 'pending', 0, ?)`,
      )
      .run(domain, eventKey, grade, score, baseline.grade, baseline.score, now.toISOString());
    inserted += result.changes;
  }
  return inserted;
}

export interface DrainOptions {
  /** base64 secret used to decrypt the stored mailbox addresses */
  secretB64: string;
  /** Resend API key — without it the drain is a no-op (mail is not a
   * prerequisite for the rest of the pipeline) */
  resendApiKey?: string;
  /** sender address */
  from?: string;
  /** public base URL used to build report links */
  baseUrl?: string;
  /** injectable clock */
  now?: () => Date;
  /** maximum number of events drained per call */
  limit?: number;
}

/** Send the pending notification events.
 *
 * A row is only picked up while it is `pending` and below the attempt cap, so
 * an event that was already delivered is never sent twice — and the
 * idempotency key (the event key) protects the provider side as well. */
export async function drainNotifyOutbox(
  db: Db,
  opts: DrainOptions,
  fetchImpl: typeof fetch,
): Promise<{ sent: number; failed: number; skipped: number }> {
  const result = { sent: 0, failed: 0, skipped: 0 };
  if (!opts.resendApiKey) return result; // nothing configured — not an error

  const now = opts.now?.() ?? new Date();
  const limit = opts.limit ?? NOTIFY_DRAIN_LIMIT;
  const baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
  const from = opts.from ?? DEFAULT_FROM;

  const rows = await db
    .prepare(
      `SELECT id, domain, event_key, grade, score_total, prev_grade, prev_score, attempts
       FROM notify_outbox
       WHERE status = 'pending' AND attempts < ?
         AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
       ORDER BY id LIMIT ?`,
    )
    .all<Row>(NOTIFY_MAX_ATTEMPTS, now.toISOString(), limit);

  for (const row of rows) {
    const id = Number(row.id);
    const domain = String(row.domain);
    const eventKey = String(row.event_key);

    const mailbox = await db
      .prepare(
        `SELECT email_cipher FROM owner_emails
         WHERE domain = ? AND verified_at IS NOT NULL AND notify = 1`,
      )
      .get<{ email_cipher: string }>(domain);
    if (!mailbox) {
      // The owner unsubscribed or the row vanished — leave the event alone
      // instead of guessing a recipient.
      result.skipped += 1;
      continue;
    }

    let to: string;
    try {
      to = await decryptEmail(mailbox.email_cipher, opts.secretB64);
    } catch (err) {
      // A wrong key is an operator problem, not a transport problem: skip
      // without burning an attempt so a fixed key can still deliver the event.
      console.warn(
        `notify: cannot decrypt mailbox for ${domain} (${err instanceof Error ? err.message : String(err)})`,
      );
      result.skipped += 1;
      continue;
    }

    const mail = renderScoreChangeEmail({
      domain,
      prevGrade: (row.prev_grade as string | null) ?? null,
      prevScore: row.prev_score === null || row.prev_score === undefined ? null : Number(row.prev_score),
      grade: (row.grade as string | null) ?? null,
      score: row.score_total === null || row.score_total === undefined ? null : Number(row.score_total),
      reportUrl: `${baseUrl}/site/${encodeURIComponent(domain)}`,
    });

    const sent = await sendEmailViaResend(
      {
        apiKey: opts.resendApiKey,
        from,
        to,
        subject: mail.subject,
        text: mail.text,
        html: mail.html,
        idempotencyKey: eventKey,
      },
      fetchImpl,
    );

    if (sent.ok) {
      await db
        .prepare(
          `UPDATE notify_outbox SET status = 'sent', sent_at = ?, last_error = NULL WHERE id = ?`,
        )
        .run(now.toISOString(), id);
      result.sent += 1;
    } else {
      const attempts = Number(row.attempts ?? 0) + 1;
      const status = attempts >= NOTIFY_MAX_ATTEMPTS ? 'failed' : 'pending';
      // Cool down before the next try: a provider outage must not burn all
      // attempts inside one rebuild (the sync endpoint runs per page).
      const nextAttemptAt = new Date(
        now.getTime() + NOTIFY_RETRY_COOLDOWN_MS * attempts,
      ).toISOString();
      await db
        .prepare(
          `UPDATE notify_outbox
           SET attempts = ?, status = ?, last_error = ?, next_attempt_at = ?
           WHERE id = ?`,
        )
        .run(attempts, status, truncate(sent.error ?? 'unknown error', 200), nextAttemptAt, id);
      result.failed += 1;
    }
  }

  return result;
}
