// src/verification.ts — domain-verification helpers: opaque token minting and
// the three probe methods (well-known file, DNS TXT over DoH, homepage meta).
// Pure logic with an injectable fetch; route wiring lives in src/index.ts.

import { USER_AGENT } from '../../../packages/scanner/src/http.ts';

/** Token validity window (7 days from issue) */
export const VERIFY_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Per-probe timeout — one slow site must not stall the whole check */
export const PROBE_TIMEOUT_MS = 8000;

/** Cloudflare DoH endpoint (JSON API), used for the TXT lookup */
const DOH_URL = 'https://cloudflare-dns.com/dns-query';

const WELL_KNOWN_PATH = '/.well-known/aiapp-verify.txt';

/** Probe methods exposed by GET /api/v1/verify/check */
export type VerifyMethod = 'file' | 'dns' | 'meta';

export interface ProbeResult {
  method: VerifyMethod;
  ok: boolean;
  /** Short reason for the outcome; never contains remote body content */
  detail: string;
}

export type FetchLike = typeof fetch;

/** Opaque single-use token: 'av-' + 32 lowercase hex chars (from crypto.randomUUID) */
export function createVerifyToken(): string {
  return 'av-' + crypto.randomUUID().replaceAll('-', '');
}

/** Spelling used by owners.verify_method (the schema documents dns-txt for the DNS method) */
export function ownerVerifyMethod(method: VerifyMethod): string {
  return method === 'dns' ? 'dns-txt' : method;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Probe details are user-visible: keep them short and never echo remote bodies */
function clip(detail: string): string {
  return detail.length > 80 ? `${detail.slice(0, 79)}…` : detail;
}

async function probeFile(domain: string, token: string, fetchImpl: FetchLike): Promise<ProbeResult> {
  try {
    const res = await fetchImpl(`https://${domain}${WELL_KNOWN_PATH}`, {
      headers: { 'user-agent': USER_AGENT },
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (!res.ok) return { method: 'file', ok: false, detail: clip(`file: HTTP ${res.status}`) };
    // The token file is tiny — cap the read so a huge response cannot stall us
    const body = (await res.text()).slice(0, 4096).trim();
    const ok = body === token;
    return {
      method: 'file',
      ok,
      detail: ok ? 'file: token matched' : 'file: content does not match token',
    };
  } catch (err) {
    return { method: 'file', ok: false, detail: clip(`file: ${errorMessage(err)}`) };
  }
}

async function probeDns(domain: string, token: string, fetchImpl: FetchLike): Promise<ProbeResult> {
  try {
    const res = await fetchImpl(`${DOH_URL}?name=${encodeURIComponent(domain)}&type=TXT`, {
      headers: { accept: 'application/dns-json', 'user-agent': USER_AGENT },
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (!res.ok) return { method: 'dns', ok: false, detail: clip(`dns: DoH HTTP ${res.status}`) };
    const payload = (await res.json()) as {
      Status?: number;
      Answer?: Array<{ type?: number; data?: string }>;
    };
    if (payload.Status !== undefined && payload.Status !== 0) {
      return { method: 'dns', ok: false, detail: clip(`dns: DoH status ${payload.Status}`) };
    }
    const needle = `aiapp-verify=${token}`;
    const ok = (payload.Answer ?? []).some(
      (answer) => answer.type === 16 && (answer.data ?? '').includes(needle),
    );
    return {
      method: 'dns',
      ok,
      detail: ok ? 'dns: TXT record matched' : 'dns: no matching TXT record',
    };
  } catch (err) {
    return { method: 'dns', ok: false, detail: clip(`dns: ${errorMessage(err)}`) };
  }
}

/** Case-insensitive match of <meta name="aiapp-verification" content="<token>">
 * (either attribute order) */
export function hasVerificationMeta(html: string, token: string): boolean {
  for (const tag of html.match(/<meta\b[^>]*>/gi) ?? []) {
    if (!/\bname\s*=\s*["']aiapp-verification["']/i.test(tag)) continue;
    const content = /\bcontent\s*=\s*["']([^"']*)["']/i.exec(tag);
    if (content?.[1] === token) return true;
  }
  return false;
}

async function probeMeta(domain: string, token: string, fetchImpl: FetchLike): Promise<ProbeResult> {
  try {
    const res = await fetchImpl(`https://${domain}/`, {
      headers: { 'user-agent': USER_AGENT },
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (!res.ok) return { method: 'meta', ok: false, detail: clip(`meta: HTTP ${res.status}`) };
    // Meta tags live in <head> — cap the read so a huge homepage cannot stall us
    const html = (await res.text()).slice(0, 512_000);
    const ok = hasVerificationMeta(html, token);
    return {
      method: 'meta',
      ok,
      detail: ok ? 'meta: tag matched' : 'meta: tag missing or content mismatch',
    };
  } catch (err) {
    return { method: 'meta', ok: false, detail: clip(`meta: ${errorMessage(err)}`) };
  }
}

/** Run the three probes in parallel. Each probe catches its own failures, so
 * an unreachable site yields verified:false with per-method details — never a
 * thrown error. Results keep a fixed file → dns → meta order. */
export async function probeAll(
  domain: string,
  token: string,
  fetchImpl: FetchLike,
): Promise<ProbeResult[]> {
  const [file, dns, meta] = await Promise.all([
    probeFile(domain, token, fetchImpl),
    probeDns(domain, token, fetchImpl),
    probeMeta(domain, token, fetchImpl),
  ]);
  return [file, dns, meta];
}
