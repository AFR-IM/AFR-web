// Torch Boost / charity / promotion data — the live API reads for the public
// site. Both afr.im and www.afr.im talk to the canonical API (same rule as
// ads.ts); nothing here is part of the static build, and every payload is
// validated before it can reach the DOM — the API returns data, never markup.

export type TorchTab = 'day' | 'week' | 'month' | 'all';
export type TorchGrade = 'A' | 'B' | 'C' | 'D' | 'E' | 'F';

export interface TorchDetail {
  domain: string;
  total: number;
  count: number;
  rank: number | null;
  lastAt: string | null;
  raised: number;
  target: number;
  salesOpen: boolean;
}

export interface TorchBoardItem {
  domain: string;
  total: number;
  count: number;
  grade: TorchGrade | null;
  score: number | null;
}

export interface TorchBoard {
  tab: TorchTab;
  page: number;
  pages: number;
  total: number;
  salesOpen: boolean;
  items: TorchBoardItem[];
}

export interface TorchOrder {
  orderId: string;
  bindingCode: string;
  amount: number;
  checkoutUrl: string;
  expiresAt: string;
}

export type TorchStatusState = 'pending' | 'paid' | 'expired' | 'cancelled' | 'review';

export interface TorchStatus {
  status: TorchStatusState;
  amount: number;
  paidAt: string | null;
}

export interface Promo {
  domain: string;
  headline: string;
  body: string;
  startsAt: string;
  endsAt: string;
}

export interface CharityBeneficiary {
  name: string;
  website: string;
  direction: string;
}

export interface CharityPublication {
  address: string;
  fingerprint: string;
  published_at: string;
}

export interface CharityTorch {
  raised: number;
  target: number;
  crossedAt: string | null;
  publishedUntil: string | null;
}

export interface CharityData {
  beneficiaries: CharityBeneficiary[];
  promoWallet: string;
  charityPool: string;
  fingerprint: string | null;
  publishedAt: string | null;
  history: CharityPublication[];
  torch: CharityTorch;
}

export type LedgerKind = 'torch_in' | 'donation_out';

export interface LedgerEntry {
  kind: LedgerKind;
  id: string;
  amount: string;
  domain?: string;
  beneficiary?: string;
  txHash: string;
  at: string;
  fundedInTx?: string[];
  anchor: string;
}

export interface CharityLedger {
  generatedAt: string;
  entries: LedgerEntry[];
}

const TORCH_API = 'https://afr.im/api/v1/torch';
const PROMOS_API = 'https://afr.im/api/v1/promos';
const CHARITY_API = 'https://afr.im/api/v1/charity';

const TABS: TorchTab[] = ['day', 'week', 'month', 'all'];
const GRADES: TorchGrade[] = ['A', 'B', 'C', 'D', 'E', 'F'];
const STATUS_STATES: TorchStatusState[] = ['pending', 'paid', 'expired', 'cancelled', 'review'];

const DOMAIN_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const BINDING_CODE_RE = /^[A-Z2-9]{8}$/;
const TX_HASH_RE = /^0x[0-9a-fA-F]{1,128}$/;
const ANCHOR_RE = /^[A-Za-z0-9_-]{1,64}$/;

const requestOptions = {
  cache: 'no-store',
  credentials: 'omit',
  redirect: 'error',
  referrerPolicy: 'no-referrer',
} as const satisfies RequestInit;

/** A host name that is safe to put in a URL or a link. */
export function isDomain(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 253 && DOMAIN_RE.test(value);
}

/** Boost amount: 1–1000 USDC with at most two decimals. */
export function isValidAmount(value: unknown): value is number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return false;
  if (value < 1 || value > 1000) return false;
  return Math.abs(value * 100 - Math.round(value * 100)) < 1e-6;
}

/** Money display: up to two decimals, trailing zeros trimmed ($12.5, $100). */
export function formatUsd(value: number): string {
  const fixed = Number(value).toFixed(2);
  const trimmed = fixed.includes('.') ? fixed.replace(/0+$/, '').replace(/\.$/, '') : fixed;
  return `$${trimmed}`;
}

function isTorchTab(value: unknown): value is TorchTab {
  return typeof value === 'string' && (TABS as string[]).includes(value);
}

function isGrade(value: unknown): value is TorchGrade {
  return typeof value === 'string' && (GRADES as string[]).includes(value.toUpperCase() as TorchGrade);
}

function isNonNegInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isUtcStamp(value: unknown): value is string {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value));
}

function str(value: unknown, max = 500): string | null {
  return typeof value === 'string' && value.length <= max ? value : null;
}

/* ── parsers (pure — the tests exercise these directly) ─────────────────── */

export function parseTorchDetail(raw: unknown): TorchDetail | null {
  if (!raw || typeof raw !== 'object') return null;
  const item = raw as Record<string, unknown>;
  if (!isDomain(item.domain)) return null;
  if (typeof item.total !== 'number' || !Number.isFinite(item.total) || item.total < 0) return null;
  if (!isNonNegInt(item.count)) return null;
  if (item.rank !== null && (typeof item.rank !== 'number' || !Number.isSafeInteger(item.rank) || item.rank < 1)) {
    return null;
  }
  if (typeof item.raised !== 'number' || !Number.isFinite(item.raised) || item.raised < 0) return null;
  if (typeof item.target !== 'number' || !Number.isFinite(item.target) || item.target <= 0) return null;
  return {
    domain: item.domain,
    total: item.total,
    count: item.count,
    rank: item.rank as number | null,
    lastAt: isUtcStamp(item.lastAt) ? item.lastAt : null,
    raised: item.raised,
    target: item.target,
    salesOpen: item.salesOpen === true,
  };
}

function parseBoardItem(raw: unknown): TorchBoardItem | null {
  if (!raw || typeof raw !== 'object') return null;
  const item = raw as Record<string, unknown>;
  if (!isDomain(item.domain)) return null;
  if (typeof item.total !== 'number' || !Number.isFinite(item.total) || item.total < 0) return null;
  if (!isNonNegInt(item.count)) return null;
  if (item.grade !== null && !isGrade(item.grade)) return null;
  if (item.score !== null && (typeof item.score !== 'number' || !Number.isFinite(item.score))) return null;
  return {
    domain: item.domain,
    total: item.total,
    count: item.count,
    grade: item.grade === null ? null : (String(item.grade).toUpperCase() as TorchGrade),
    score: item.score as number | null,
  };
}

export function parseTorchBoard(raw: unknown): TorchBoard | null {
  if (!raw || typeof raw !== 'object') return null;
  const board = raw as Record<string, unknown>;
  if (!isTorchTab(board.tab)) return null;
  if (typeof board.page !== 'number' || !Number.isSafeInteger(board.page) || board.page < 1) return null;
  if (typeof board.pages !== 'number' || !Number.isSafeInteger(board.pages) || board.pages < 0) return null;
  if (!isNonNegInt(board.total)) return null;
  if (!Array.isArray(board.items)) return null;
  const items: TorchBoardItem[] = [];
  for (const raw of board.items) {
    const item = parseBoardItem(raw);
    if (item) items.push(item); // one bad row never poisons the page
  }
  return { tab: board.tab, page: board.page, pages: board.pages, total: board.total, salesOpen: board.salesOpen === true, items };
}

function parseTorchOrder(raw: unknown): TorchOrder | null {
  if (!raw || typeof raw !== 'object') return null;
  const order = raw as Record<string, unknown>;
  const orderId = str(order.orderId, 80);
  const bindingCode = str(order.bindingCode, 16);
  const checkoutUrl = str(checkoutUrlTypeGuard(order.checkoutUrl), 2048);
  const expiresAt = str(order.expiresAt, 64);
  if (!orderId || !bindingCode || !checkoutUrl || !expiresAt) return null;
  if (!BINDING_CODE_RE.test(bindingCode)) return null;
  if (!isValidAmount(order.amount)) return null;
  return { orderId, bindingCode, amount: order.amount, checkoutUrl, expiresAt };
}

function checkoutUrlTypeGuard(value: unknown): unknown {
  if (typeof value !== 'string') return null;
  if (!/^https:\/\//.test(value)) return null;
  return value;
}

export function parseTorchStatus(raw: unknown): TorchStatus | null {
  if (!raw || typeof raw !== 'object') return null;
  const status = raw as Record<string, unknown>;
  if (typeof status.status !== 'string' || !(STATUS_STATES as string[]).includes(status.status)) return null;
  if (typeof status.amount !== 'number' || !Number.isFinite(status.amount) || status.amount < 0) return null;
  return {
    status: status.status as TorchStatusState,
    amount: status.amount,
    paidAt: isUtcStamp(status.paidAt) ? status.paidAt : null,
  };
}

export function parsePromo(raw: unknown, domain: string): Promo | null {
  if (!raw || typeof raw !== 'object') return null;
  const payload = raw as Record<string, unknown>;
  const promo = payload.promo;
  if (!promo || typeof promo !== 'object') return null;
  const item = promo as Record<string, unknown>;
  // Only the site's own promotion may render on its page.
  if (!isDomain(item.domain) || item.domain.toLowerCase() !== domain.toLowerCase()) return null;
  const headline = str(item.headline, 400);
  const body = str(item.body, 1200);
  if (headline === null || body === null) return null;
  return {
    domain: item.domain,
    headline,
    body,
    startsAt: isUtcStamp(item.startsAt) ? item.startsAt : '',
    endsAt: isUtcStamp(item.endsAt) ? item.endsAt : '',
  };
}

export function parseCharity(raw: unknown): CharityData | null {
  if (!raw || typeof raw !== 'object') return null;
  const data = raw as Record<string, unknown>;
  const beneficiaries: CharityBeneficiary[] = [];
  if (Array.isArray(data.beneficiaries)) {
    for (const raw of data.beneficiaries) {
      if (!raw || typeof raw !== 'object') continue;
      const item = raw as Record<string, unknown>;
      const name = str(item.name, 200);
      const website = str(item.website, 500);
      const direction = str(item.direction, 500);
      if (name && website && direction) beneficiaries.push({ name, website, direction });
    }
  }
  const history: CharityPublication[] = [];
  if (Array.isArray(data.history)) {
    for (const raw of data.history) {
      if (!raw || typeof raw !== 'object') continue;
      const item = raw as Record<string, unknown>;
      const address = str(item.address, 200);
      const fingerprint = str(item.fingerprint, 200);
      const publishedAt = str(item.published_at, 64);
      if (address && fingerprint && publishedAt) history.push({ address, fingerprint, published_at: publishedAt });
    }
  }
  // The torch block is additive: a deployment that predates it still renders.
  const torchRaw = data.torch && typeof data.torch === 'object' ? (data.torch as Record<string, unknown>) : null;
  const raised = torchRaw && typeof torchRaw.raised === 'number' && Number.isFinite(torchRaw.raised) && torchRaw.raised >= 0
    ? torchRaw.raised : 0;
  const target = torchRaw && typeof torchRaw.target === 'number' && Number.isFinite(torchRaw.target) && torchRaw.target > 0
    ? torchRaw.target : 1000;
  return {
    beneficiaries,
    promoWallet: str(data.promoWallet, 200) ?? '',
    charityPool: str(data.charityPool, 200) ?? '',
    fingerprint: str(data.fingerprint, 200),
    publishedAt: isUtcStamp(data.publishedAt) ? data.publishedAt : null,
    history,
    torch: {
      raised,
      target,
      crossedAt: torchRaw && isUtcStamp(torchRaw.crossedAt) ? (torchRaw.crossedAt as string) : null,
      publishedUntil: torchRaw && isUtcStamp(torchRaw.publishedUntil) ? (torchRaw.publishedUntil as string) : null,
    },
  };
}

export function parseCharityLedger(raw: unknown): CharityLedger | null {
  if (!raw || typeof raw !== 'object') return null;
  const data = raw as Record<string, unknown>;
  if (!Array.isArray(data.entries)) return null;
  const entries: LedgerEntry[] = [];
  for (const raw of data.entries) {
    if (!raw || typeof raw !== 'object') continue;
    const item = raw as Record<string, unknown>;
    const kind = item.kind;
    const id = str(item.id, 80);
    const amount = str(item.amount, 64);
    const txHash = str(item.txHash, 200);
    const at = str(item.at, 64);
    const anchor = str(item.anchor, 80);
    if (kind !== 'torch_in' && kind !== 'donation_out') continue;
    if (!id || !amount || !txHash || !at) continue;
    const entry: LedgerEntry = { kind, id, amount, txHash, at, anchor: anchor && ANCHOR_RE.test(anchor) ? anchor : `${kind === 'torch_in' ? 'torch' : 'donation'}-${id}` };
    const domain = str(item.domain, 253);
    const beneficiary = str(item.beneficiary, 200);
    if (domain) entry.domain = domain;
    if (beneficiary) entry.beneficiary = beneficiary;
    if (Array.isArray(item.fundedInTx)) {
      const hashes = item.fundedInTx.filter((h): h is string => typeof h === 'string' && TX_HASH_RE.test(h));
      if (hashes.length) entry.fundedInTx = hashes;
    }
    entries.push(entry);
  }
  return { generatedAt: str(data.generatedAt, 64) ?? '', entries };
}

/* ── fetchers ───────────────────────────────────────────────────────────── */

/** One detail payload per domain per page view: the badge and the boost
 *  button ask the same question, and the API must not be asked twice. */
const detailMemo = new Map<string, Promise<TorchDetail | null>>();

export function fetchTorchDetail(domain: string, signal?: AbortSignal): Promise<TorchDetail | null> {
  if (!isDomain(domain)) return Promise.resolve(null);
  let pending = detailMemo.get(domain);
  if (!pending) {
    pending = (async () => {
      try {
        const response = await fetch(`${TORCH_API}/detail?domain=${encodeURIComponent(domain)}`, {
          ...requestOptions,
          headers: { accept: 'application/json' },
          signal,
        });
        if (!response.ok) return null;
        return parseTorchDetail(await response.json());
      } catch {
        return null;
      }
    })();
    // A failure is not an answer: drop it from the memo so a later view on
    // the same page can retry instead of inheriting the miss.
    pending.then((value) => {
      if (value === null && detailMemo.get(domain) === pending) detailMemo.delete(domain);
    });
    detailMemo.set(domain, pending);
  }
  return pending;
}

export async function fetchTorchLeaderboard(tab: TorchTab, page: number, signal?: AbortSignal): Promise<TorchBoard | null> {
  if (!isTorchTab(tab) || !Number.isSafeInteger(page) || page < 1) return null;
  try {
    const query = new URLSearchParams({ tab, page: String(page) });
    const response = await fetch(`${TORCH_API}/leaderboard?${query}`, {
      ...requestOptions,
      headers: { accept: 'application/json' },
      signal,
    });
    if (!response.ok) return null;
    const board = parseTorchBoard(await response.json());
    return board && board.tab === tab ? board : null;
  } catch {
    return null;
  }
}

export interface TorchOrderResult {
  status: number;
  order: TorchOrder | null;
  error: string | null;
}

export async function postTorchOrder(
  input: { domain: string; amount: number; requestId: string },
  signal?: AbortSignal,
): Promise<TorchOrderResult> {
  if (!isDomain(input.domain)) return { status: 400, order: null, error: 'invalid_domain' };
  if (!isValidAmount(input.amount)) return { status: 400, order: null, error: 'invalid_amount' };
  if (!UUID_RE.test(input.requestId)) return { status: 400, order: null, error: 'invalid_request_id' };
  try {
    const response = await fetch(`${TORCH_API}/order`, {
      ...requestOptions,
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(input),
      signal,
    });
    const body: unknown = await response.json().catch(() => null);
    if (response.ok) {
      const order = parseTorchOrder(body);
      return order
        ? { status: response.status, order, error: null }
        : { status: response.status, order: null, error: 'invalid_response' };
    }
    const code = body && typeof body === 'object' && typeof (body as Record<string, unknown>).error === 'string'
      ? ((body as Record<string, unknown>).error as string)
      : 'request_failed';
    return { status: response.status, order: null, error: code };
  } catch {
    return { status: 0, order: null, error: 'network' };
  }
}

export type TorchStatusResult =
  | { ok: true; status: TorchStatus }
  | { ok: false; status: number; error: string };

export async function fetchTorchStatus(order: string, code: string, signal?: AbortSignal): Promise<TorchStatusResult> {
  if (!str(order, 80) || !BINDING_CODE_RE.test(code)) {
    return { ok: false, status: 400, error: 'invalid_request_id' };
  }
  try {
    const query = new URLSearchParams({ order, code });
    const response = await fetch(`${TORCH_API}/status?${query}`, {
      ...requestOptions,
      headers: { accept: 'application/json' },
      signal,
    });
    const body: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const code_ = body && typeof body === 'object' && typeof (body as Record<string, unknown>).error === 'string'
        ? ((body as Record<string, unknown>).error as string)
        : 'request_failed';
      return { ok: false, status: response.status, error: code_ };
    }
    const status = parseTorchStatus(body);
    return status ? { ok: true, status } : { ok: false, status: response.status, error: 'invalid_response' };
  } catch {
    return { ok: false, status: 0, error: 'network' };
  }
}

export async function fetchPromo(domain: string, signal?: AbortSignal): Promise<Promo | null> {
  if (!isDomain(domain)) return null;
  try {
    const response = await fetch(`${PROMOS_API}?domain=${encodeURIComponent(domain)}`, {
      ...requestOptions,
      headers: { accept: 'application/json' },
      signal,
    });
    if (!response.ok) return null;
    return parsePromo(await response.json(), domain);
  } catch {
    return null;
  }
}

export async function fetchCharity(signal?: AbortSignal): Promise<CharityData | null> {
  try {
    const response = await fetch(CHARITY_API, {
      ...requestOptions,
      headers: { accept: 'application/json' },
      signal,
    });
    if (!response.ok) return null;
    return parseCharity(await response.json());
  } catch {
    return null;
  }
}

export async function fetchCharityLedger(signal?: AbortSignal): Promise<CharityLedger | null> {
  try {
    const response = await fetch(`${CHARITY_API}/ledger`, {
      ...requestOptions,
      headers: { accept: 'application/json' },
      signal,
    });
    if (!response.ok) return null;
    return parseCharityLedger(await response.json());
  } catch {
    return null;
  }
}

/* ── badge painting (shared by the detail page and the payment flow) ────── */

/** Paint `[data-torch-badge]` from its data attributes. Hidden while the
 *  total is zero — a site nobody boosted must not show an empty badge. */
export function paintTorchBadge(el: { dataset: DOMStringMap; hidden: boolean; querySelector: (sel: string) => { textContent: string } | null }): void {
  const total = Number(el.dataset.torchTotal ?? 0);
  if (!(total > 0)) {
    el.hidden = true;
    return;
  }
  const count = Number(el.dataset.torchCount ?? 0);
  const rank = el.dataset.torchRank ?? '';
  const out = el.querySelector('[data-torch-badge-text]');
  let text = (el.dataset.torchTplTotal ?? '{amount} · {count} boosts')
    .replace('{amount}', formatUsd(total))
    .replace('{count}', String(count));
  if (rank) text += (el.dataset.torchTplRank ?? ' · #{rank} all time').replace('{rank}', rank);
  if (out) out.textContent = text;
  el.hidden = false;
}
