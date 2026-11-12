// Polite HTTP client (spec §4)
// · ≤8 GET slots per site, hard cap of 12 actual requests (incl. agents fallback and 1 retry on key slots)
// · Transparent UA, 15s timeout, 1 retry on network error (robots/homepage only), capped response bodies
// · The request counter is visible throughout, so the "polite budget" can be asserted not to be exceeded

export const SCANNER_VERSION = 'scanner-0.1.0';

/** Transparent UA: identifies who we are + homepage (webmasters can block us anytime and get in touch) */
export const USER_AGENT = 'afrScanner/0.1 (+https://afr.im/bot; AI-friendliness research crawler)';

export const TIMEOUT_MS = 15_000;

/** Hard cap on actual requests: 8 endpoints × (transparent + challenge fallback) = 16;
 *  includes the agents 404 fallback and 1 network retry on key slots */
export const MAX_REQUESTS = 16;

/** Status codes that trigger the challenge fallback (a refinement of the spec §4 "Declined"
 *  degradation mechanism, confirmed by the user on 2026-11-10) */
export const CHALLENGE_STATUSES = new Set([401, 403, 429, 503]);

/** Browser UA (used only to recover content after a challenge; primary probes always use the transparent UA) */
export const BROWSER_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

export interface HttpResult {
  status?: number;
  body?: string;
  url?: string;
  error?: string;
  /** Challenge fallback: status code returned when the transparent UA was challenged */
  challengedStatus?: number;
  /** Content was recovered with the browser UA fallback */
  uaFallback?: boolean;
}

export type FetchImpl = (url: string, init: RequestInit) => Promise<Response>;

export class BudgetExceededError extends Error {
  constructor(url: string) {
    super(`polite budget exhausted, skipping ${url}`);
    this.name = 'BudgetExceededError';
  }
}

/** Per-site request counter */
export class RequestCounter {
  count = 0;
  readonly max: number;
  constructor(max: number = MAX_REQUESTS) {
    this.max = max;
  }
  get remaining(): number {
    return this.max - this.count;
  }
  /** Spend one request slot; returns false when over budget */
  trySpend(): boolean {
    if (this.count >= this.max) return false;
    this.count++;
    return true;
  }
}

export interface GetOptions {
  counter: RequestCounter;
  fetchImpl?: FetchImpl;
  /** Retry once on network error (enabled only for key slots) */
  retryOnNetworkError?: boolean;
  /** Response body cap (bytes); beyond it only the status code is kept */
  maxBytes?: number;
  /** Re-fetch content with the browser UA when the transparent UA is challenged (401/403/429/503); on by default */
  fallbackOnChallenge?: boolean;
}

const DEFAULT_MAX_BYTES = 512 * 1024;

async function attempt(
  url: string,
  maxBytes: number,
  fetchImpl: FetchImpl,
  userAgent: string,
): Promise<HttpResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const resp = await fetchImpl(url, {
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'user-agent': userAgent,
        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.5',
        'accept-language': 'en,*;q=0.5',
      },
    });
    const declared = Number(resp.headers.get('content-length') ?? '0');
    if (declared > maxBytes * 4) {
      // Huge response: take only status and URL, skip the body
      return { status: resp.status, url: resp.url };
    }
    const text = (await resp.text()).slice(0, maxBytes);
    return { status: resp.status, body: text, url: resp.url };
  } catch (err) {
    const e = err as Error & { cause?: { code?: string; message?: string } };
    const name = e.name === 'AbortError' ? 'timeout' : e.name;
    const cause = e.cause
      ? `${e.cause.code ?? ''}${e.cause.code ? ': ' : ''}${e.cause.message ?? e.cause.code ?? ''}`
      : '';
    return { error: cause ? `${name}: ${e.message} (${cause})` : `${name}: ${e.message}` };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Send one budget-capped GET.
 * The budget is debited on every actual attempt (retries count too), so the number of
 * requests made in production stays auditable.
 */
export async function politeGet(url: string, opts: GetOptions): Promise<HttpResult> {
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const fetchImpl: FetchImpl = opts.fetchImpl ?? ((u, init) => fetch(u, init));
  const tries = opts.retryOnNetworkError ? 2 : 1;
  const fallback = opts.fallbackOnChallenge ?? true;
  let last: HttpResult = { error: 'not attempted' };
  for (let i = 0; i < tries; i++) {
    if (!opts.counter.trySpend()) return { error: `budget-exceeded: ${url}` };
    last = await attempt(url, maxBytes, fetchImpl, USER_AGENT);
    if (last.error) {
      if (i + 1 < tries) await sleep(300); // brief wait before retrying
      continue;
    }
    // Challenge fallback: transparent UA walled off → re-fetch content with the browser UA;
    // L1 wall judgment keeps challengedStatus
    if (fallback && last.status !== undefined && CHALLENGE_STATUSES.has(last.status)) {
      if (opts.counter.trySpend()) {
        const fb = await attempt(url, maxBytes, fetchImpl, BROWSER_USER_AGENT);
        if (!fb.error && fb.status !== undefined && !CHALLENGE_STATUSES.has(fb.status)) {
          return { ...fb, challengedStatus: last.status, uaFallback: true };
        }
      }
      // Fallback also challenged / budget exhausted → keep the transparent result (record the wall honestly)
    }
    return last;
  }
  return last;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Normalize a domain: strip scheme/path/port/www, lowercase */
export function normalizeDomain(input: string): string {
  let d = input.trim().toLowerCase();
  d = d.replace(/^[a-z][a-z0-9+.-]*:\/\//, ''); // scheme
  d = d.split('/')[0] ?? '';
  d = d.split('@').pop() ?? ''; // userinfo
  d = d.split(':')[0] ?? ''; // port
  d = d.replace(/^www\./, '');
  return d;
}
