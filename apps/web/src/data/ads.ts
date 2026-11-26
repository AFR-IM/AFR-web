// Live ads use AFR's canonical API on both afr.im and www.afr.im.
// Placement data belongs in browser memory only, never in the static build.
export type AdSlot = 'category-top' | 'search-top' | 'home-supporter';
export type AdGrade = 'A' | 'B' | 'C' | 'D' | 'E' | 'F';

export interface ActiveAd {
  id: number;
  domain: string;
  headline: string;
  body: string;
  grade: AdGrade;
  score: number;
  startsAt: number;
  endsAt: number;
}

const ADS_API = 'https://afr.im/api/v1/ads';
const GRADES = new Set<AdGrade>(['A', 'B', 'C', 'D', 'E', 'F']);
const MAX_SUPPORTERS = 8;
const requestOptions = {
  cache: 'no-store',
  credentials: 'omit',
  redirect: 'error',
  referrerPolicy: 'no-referrer',
} as const satisfies RequestInit;

export function adClickUrl(id: number): string {
  return `${ADS_API}/go?id=${id}`;
}

export function adReportUrl(id: number, locale: 'en' | 'zh-CN'): string {
  return `${ADS_API}/report?id=${id}&lang=${locale}`;
}

export function adImpressionKey(id: number, day: string): string {
  return `afr-ad-imp:${id}:${day}`;
}

export function searchAdKey(value: string): string | undefined {
  // Send the whole term. The API owns Unicode normalization and exact matching.
  if (value.length > 192 || /[\p{Cc}\p{Cf}\p{Cs}]/u.test(value)) return undefined;
  return value.trim() || undefined;
}

function utcStamp(value: unknown): number {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)
    ? Date.parse(value) : NaN;
}

function activeAd(raw: unknown, slot: AdSlot, key: string | undefined, now: number): ActiveAd | undefined {
  if (!raw || typeof raw !== 'object') return;
  const item = raw as Record<string, unknown>;
  const { id, domain, headline, body, grade, score } = item;
  if (item.slot !== slot || item.status !== 'active') return;
  if (slot === 'category-top' && item.slot_key !== key) return;
  // The search slot key in the response is canonicalized by the service.
  if (slot === 'search-top' && (typeof item.slot_key !== 'string' || !item.slot_key)) return;
  if (slot === 'home-supporter' && item.slot_key !== null) return;
  if (typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0) return;
  if (typeof domain !== 'string' || !domain.trim()) return;
  if (typeof headline !== 'string' || typeof body !== 'string') return;
  if (slot !== 'home-supporter' && (!headline.trim() || !body.trim())) return;
  if (!GRADES.has(grade as AdGrade) || typeof score !== 'number' || !Number.isFinite(score) || score < 0 || score > 100) return;
  const startsAt = utcStamp(item.starts_at);
  const endsAt = utcStamp(item.ends_at);
  if (!(startsAt <= now && now < endsAt)) return;
  return { id, domain, headline, body, grade: grade as AdGrade, score, startsAt, endsAt };
}

export async function fetchActiveAds(slot: AdSlot, key: string | undefined, signal: AbortSignal): Promise<ActiveAd[]> {
  if (slot !== 'home-supporter' && !key) return [];
  const query = new URLSearchParams({ slot });
  if (slot !== 'home-supporter' && key) query.set('key', key);
  const response = await fetch(`${ADS_API}?${query}`, {
    ...requestOptions,
    headers: { accept: 'application/json' },
    signal,
  });
  if (!response.ok) return [];
  const payload = await response.json();
  if (!Array.isArray(payload?.items)) return [];
  const now = Date.now();
  const items = new Map<number, ActiveAd>();
  const limit = slot === 'home-supporter' ? MAX_SUPPORTERS : 1;
  for (const raw of payload.items) {
    const ad = activeAd(raw, slot, key, now);
    if (ad && !items.has(ad.id)) items.set(ad.id, ad);
    if (items.size === limit) break; // Preserve the service's rotation order.
  }
  return [...items.values()];
}

export async function postAdImpression(id: number, signal: AbortSignal): Promise<boolean> {
  const response = await fetch(`${ADS_API}/event`, {
    ...requestOptions,
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id }),
    keepalive: true,
    signal,
  });
  return response.ok;
}
