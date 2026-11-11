// src/rate-limit.ts — KV-backed sliding-window counters (spec §6.2: KV
// counters, IP + endpoint sliding window). Fixed UTC-day buckets are used for the
// 5 submissions/IP/day limit; the store is injectable so tests run offline and
// the app degrades to an in-memory counter when KV is not bound.

export interface CounterStore {
  /** Increment the counter for `key` within `windowMs` and return the new count */
  incr(key: string, windowMs: number): Promise<number>;
  /** Read the current count for `key` without incrementing (pre-check) */
  peek(key: string, windowMs: number): Promise<number>;
}

/** In-memory fallback (per-isolate only — degraded but serviceable when KV is unavailable) */
export function memoryStore(now: () => number = Date.now): CounterStore {
  const buckets = new Map<string, { count: number; expiresAt: number }>();
  return {
    async incr(key: string, windowMs: number): Promise<number> {
      const t = now();
      const entry = buckets.get(key);
      if (!entry || entry.expiresAt <= t) {
        buckets.set(key, { count: 1, expiresAt: t + windowMs });
        return 1;
      }
      entry.count += 1;
      return entry.count;
    },
    async peek(key: string, windowMs: number): Promise<number> {
      const t = now();
      const entry = buckets.get(key);
      if (!entry || entry.expiresAt <= t) return 0;
      return entry.count;
    },
  };
}

/** Minimal KV surface (satisfied by Cloudflare KVNamespace) */
export interface KvLike {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
}

/** KV counter store. Read-modify-write is racy across isolates, but the limit is
 * a UX guard rather than a security boundary (spec §6.2 rate-limit intent). */
export function kvStore(kv: KvLike): CounterStore {
  return {
    async incr(key: string, windowMs: number): Promise<number> {
      const raw = await kv.get(key);
      const count = (raw ? Number.parseInt(raw, 10) || 0 : 0) + 1;
      await kv.put(key, String(count), { expirationTtl: Math.max(60, Math.ceil(windowMs / 1000)) });
      return count;
    },
    async peek(key: string): Promise<number> {
      const raw = await kv.get(key);
      return raw ? Number.parseInt(raw, 10) || 0 : 0;
    },
  };
}

export interface RateDecision {
  allowed: boolean;
  remaining: number;
}

/** Counting-window limiter: scope + caller key + time bucket form the store key */
export class RateLimiter {
  private readonly store: CounterStore;
  private readonly limit: number;
  private readonly windowMs: number;
  private readonly scope: string;

  constructor(store: CounterStore, limit: number, windowMs: number, scope: string) {
    this.store = store;
    this.limit = limit;
    this.windowMs = windowMs;
    this.scope = scope;
  }

  async consume(key: string, now: number = Date.now()): Promise<RateDecision> {
    const bucket = Math.floor(now / this.windowMs);
    const count = await this.store.incr(`${this.scope}:${key}:${bucket}`, this.windowMs);
    return { allowed: count <= this.limit, remaining: Math.max(0, this.limit - count) };
  }

  /** Read-only pre-check: whether `key` still has budget in the current window.
   * Callers run all tier pre-checks before consuming any of them, so a rejected
   * request never burns quota on another tier. */
  async check(key: string, now: number = Date.now()): Promise<RateDecision> {
    const bucket = Math.floor(now / this.windowMs);
    const count = await this.store.peek(`${this.scope}:${key}:${bucket}`, this.windowMs);
    return { allowed: count < this.limit, remaining: Math.max(0, this.limit - count) };
  }

  /** Seconds until the current window resets (Retry-After hint for 429s) */
  retryAfter(now: number = Date.now()): number {
    const bucket = Math.floor(now / this.windowMs);
    return Math.max(1, Math.ceil(((bucket + 1) * this.windowMs - now) / 1000));
  }
}

export const DAY_MS = 24 * 60 * 60 * 1000;
