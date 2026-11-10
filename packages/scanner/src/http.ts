// 礼貌 HTTP 客户端（方案书 §4）
// · 每站 ≤8 槽位 GET，硬上限 12 次实际请求（含 agents 回退与关键槽位重试 1 次）
// · UA 透明、超时 15s、网络错误重试 1 次（仅 robots/homepage）、响应体限长
// · 请求计数器全程可见，可断言"礼貌预算"不被突破

export const SCANNER_VERSION = 'scanner-0.1.0';

/** 透明 UA：表明身份 + 主页（站长可随时拉黑并联系我们） */
export const USER_AGENT = 'aiappScanner/0.1 (+https://aiapp.im/bot; AI-friendliness research crawler)';

export const TIMEOUT_MS = 15_000;

/** 实际请求硬上限: 8 端点 ×（透明 + 挑战回退）= 16；含 agents 404 回退与关键槽位网络重试 */
export const MAX_REQUESTS = 16;

/** 触发挑战回退的状态码（方案书 §4 Declined 降级机制的细化，用户 2026-11-10 确认） */
export const CHALLENGE_STATUSES = new Set([401, 403, 429, 503]);

/** 浏览器 UA（仅用于挑战回退取内容；主探测始终用透明 UA） */
export const BROWSER_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

export interface HttpResult {
  status?: number;
  body?: string;
  url?: string;
  error?: string;
  /** 挑战回退: 透明 UA 被挑战的状态码 */
  challengedStatus?: number;
  /** 内容经浏览器 UA 回退获取 */
  uaFallback?: boolean;
}

export type FetchImpl = (url: string, init: RequestInit) => Promise<Response>;

export class BudgetExceededError extends Error {
  constructor(url: string) {
    super(`礼貌预算耗尽，跳过 ${url}`);
    this.name = 'BudgetExceededError';
  }
}

/** 每站请求计数器 */
export class RequestCounter {
  count = 0;
  readonly max: number;
  constructor(max: number = MAX_REQUESTS) {
    this.max = max;
  }
  get remaining(): number {
    return this.max - this.count;
  }
  /** 消耗一次请求额度；超限返回 false */
  trySpend(): boolean {
    if (this.count >= this.max) return false;
    this.count++;
    return true;
  }
}

export interface GetOptions {
  counter: RequestCounter;
  fetchImpl?: FetchImpl;
  /** 网络错误时重试 1 次（仅关键槽位开启） */
  retryOnNetworkError?: boolean;
  /** 响应体上限（字节）；超出则只保留状态码 */
  maxBytes?: number;
  /** 透明 UA 被挑战（401/403/429/503）时用浏览器 UA 重取内容（默认开） */
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
      // 巨型响应：只取状态与 URL，不下载正文
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
 * 发送一次受预算约束的 GET。
 * 预算在【每次实际尝试】上扣减（重试也占用），保证线上请求数可审计。
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
      if (i + 1 < tries) await sleep(300); // 重试前短暂等待
      continue;
    }
    // 挑战回退: 透明 UA 被墙 → 浏览器 UA 重取内容；L1 墙判定保留 challengedStatus
    if (fallback && last.status !== undefined && CHALLENGE_STATUSES.has(last.status)) {
      if (opts.counter.trySpend()) {
        const fb = await attempt(url, maxBytes, fetchImpl, BROWSER_USER_AGENT);
        if (!fb.error && fb.status !== undefined && !CHALLENGE_STATUSES.has(fb.status)) {
          return { ...fb, challengedStatus: last.status, uaFallback: true };
        }
      }
      // 回退也被挑战/预算耗尽 → 保留透明结果（如实记墙）
    }
    return last;
  }
  return last;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** 归一化域名: 去协议/路径/端口/www、小写 */
export function normalizeDomain(input: string): string {
  let d = input.trim().toLowerCase();
  d = d.replace(/^[a-z][a-z0-9+.-]*:\/\//, ''); // scheme
  d = d.split('/')[0] ?? '';
  d = d.split('@').pop() ?? ''; // userinfo
  d = d.split(':')[0] ?? ''; // port
  d = d.replace(/^www\./, '');
  return d;
}
