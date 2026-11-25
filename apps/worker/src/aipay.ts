import type { Db } from './db.ts';

export type BillingPurpose = 'pro' | 'api' | 'ad' | 'torch' | 'promo';
export type BillingStatus = 'creating' | 'pending' | 'confirmed' | 'expired' | 'cancelled' | 'review';
export interface AipayEnv {
  AIPAY_API_KEY?: string;
  AIPAY_RECONCILE_ENABLED?: string;
  AIPAY_WEBHOOK_SECRET?: string;
  AIPAY_BASE_URL?: string;
}

export interface CreateBillingOrder {
  merchantOrderId: string;
  purpose: BillingPurpose;
  subjectId: string;
  amount: string;
  asset: string;
  chainKey: string;
  returnUrl?: string;
  /** Length of the paid term this order buys, in days (stored in the ledger). */
  termDays?: number;
  /** Description shown at the checkout (the ledger never stores it). */
  description?: string;
  /** Lifetime of the checkout session, in seconds. */
  ttlSeconds?: number;
}

export interface AipayOrderResponse {
  reference: string;
  status: string;
  chainKey?: string;
  asset?: string;
  amount?: string;
  merchantOrderId?: string;
  checkoutUrl?: string;
  expiresAt?: number;
  confirmedAt?: number | null;
  txHash?: string | null;
  lastError?: string | null;
}

const BASE = 'https://api.aipay.im';
/**
 * The User-Agent every AIPAY call carries.
 *
 * A Cloudflare Worker sends **no** User-Agent by default, and the AIPAY
 * service's edge rejects such a request outright (403, Cloudflare error
 * 1010) — the order then dies before the ledger ever sees a reference.
 * The header is the difference between "billing_unavailable" and a real
 * order, so it is set explicitly on every call.
 */
export const AIPAY_USER_AGENT = 'AFR-Billing/1.0 (+https://afr.im)';

/**
 * The redirect mode every AIPAY call uses.
 *
 * `'error'` is a Node/undici option and **not implemented at the edge**:
 * a Worker throws "Invalid redirect value" before the request is even sent,
 * so the order never reaches the provider. `'manual'` is the Workers
 * equivalent of "do not follow" — a redirect comes back as a 3xx, which
 * the caller rejects like any other non-2xx answer.
 */
export const AIPAY_REDIRECT = 'manual' as const;
/** The id charset of the ledger. A dot is allowed so that a merchant order id
 * can carry the domain it was bought for (`pro-example.com-<uuid>`); the id
 * is always compared literally, never interpolated into SQL. */
const ID = /^[A-Za-z0-9._-]{1,64}$/;
const PURPOSES = new Set<BillingPurpose>(['pro', 'api', 'ad', 'torch', 'promo']);
const STATUSES = new Set<BillingStatus>(['creating', 'pending', 'confirmed', 'expired', 'cancelled', 'review']);
const enc = new TextEncoder();

export interface AipayListResponse {
  orders: AipayOrderResponse[];
  nextPageCursor?: string | null;
  nextCursor?: string | number | null;
}

export interface ReconcileOptions {
  cursor?: string | null;
  status?: string;
  pageSize?: number;
  maxPages?: number;
}

export interface ReconcilePage {
  orders: AipayOrderResponse[];
  cursor: string | null;
  filterStatus?: string;
}

function authBase(env: AipayEnv): string {
  if (!env.AIPAY_API_KEY) throw new Error('aipay_not_configured');
  return safeBase(env.AIPAY_BASE_URL);
}

async function aipayFetch<T>(env: AipayEnv, path: string, query: Record<string, string | undefined>, fetchImpl: typeof fetch): Promise<T> {
  const url = new URL(`${authBase(env)}${path}`);
  for (const [key, value] of Object.entries(query)) if (value !== undefined) url.searchParams.set(key, value);
  const response = await fetchImpl(url, { method: 'GET', redirect: AIPAY_REDIRECT, signal: AbortSignal.timeout(8000),
    headers: { Authorization: `Bearer ${env.AIPAY_API_KEY}`, Accept: 'application/json', 'User-Agent': AIPAY_USER_AGENT } });
  const payload = await response.json() as T & { error?: { code?: string } };
  if (!response.ok) throw new Error(`aipay_reconcile_failed:${response.status}:${payload.error?.code ?? 'http_error'}`);
  return payload;
}

export async function listAipayOrders(env: AipayEnv, options: { cursor?: string | null; status?: string; limit?: number } = {}, fetchImpl: typeof fetch = fetch): Promise<AipayListResponse> {
  const limit = Math.max(1, Math.min(100, Math.floor(options.limit ?? 50)));
  const payload = await aipayFetch<AipayListResponse>(env, '/v1/orders', {
    pageCursor: options.cursor ?? undefined, status: options.status, limit: String(limit),
  }, fetchImpl);
  if (!Array.isArray(payload?.orders) || payload.orders.length > limit) throw new Error('aipay_reconcile_failed:invalid_response:orders');
  return payload;
}

export async function getAipayOrder(env: AipayEnv, reference: string, fetchImpl: typeof fetch = fetch): Promise<AipayOrderResponse> {
  if (!/^ap_[A-Za-z0-9_-]{8,64}$/.test(reference)) throw new Error('invalid_aipay_reference');
  const payload = await aipayFetch<{ order?: AipayOrderResponse }>(env, `/v1/orders/${encodeURIComponent(reference)}`, {}, fetchImpl);
  if (!payload.order || payload.order.reference !== reference) throw new Error('aipay_order_invalid_response');
  return payload.order;
}

/**
 * Pull pages in order. Checkpoint only after all page writes succeed; if
 * interrupted before checkpointing, replay the page using idempotent writes.
 */
export async function reconcileAipayOrders(db: Db, env: AipayEnv, options: ReconcileOptions = {},
  applyPage: (page: ReconcilePage) => Promise<void>, fetchImpl: typeof fetch = fetch): Promise<{ pages: number; cursor: string | null }> {
  const maxPages = Math.max(1, Math.min(100, Math.floor(options.maxPages ?? 10)));
  const saved = await db.prepare('SELECT cursor, filter_status FROM billing_reconcile_state WHERE id=1').get<{cursor:string|null;filter_status:string|null}>();
  const filterStatus = options.status;
  let cursor = options.cursor === undefined && saved !== undefined && saved.filter_status === (filterStatus ?? null) ? saved.cursor : options.cursor ?? null;
  let pages = 0;
  while (pages < maxPages) {
    const payload = await listAipayOrders(env, { cursor, status: filterStatus, limit: options.pageSize }, fetchImpl);
    const next = payload.nextPageCursor;
    if (!(next === null || (typeof next === 'string' && next.length > 0 && next.length <= 2048 && next !== cursor))) {
      throw new Error('aipay_invalid_page_cursor');
    }
    await applyPage({ orders: payload.orders ?? [], cursor: next, filterStatus });
    await db.prepare(`INSERT INTO billing_reconcile_state (id,cursor,filter_status,updated_at) VALUES (1,?,?,?)
      ON CONFLICT(id) DO UPDATE SET cursor=excluded.cursor,filter_status=excluded.filter_status,updated_at=excluded.updated_at`)
      .run(next, filterStatus ?? null, new Date().toISOString());
    cursor = next; pages++;
    if (cursor === null) break;
  }
  return { pages, cursor };
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new Uint8Array(bytes));
  return [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join('');
}

function canonicalOrderHash(order: AipayOrderResponse): Promise<string> {
  return sha256(enc.encode(JSON.stringify([order.reference, order.status, order.amount, order.asset,
    order.chainKey, order.confirmedAt, order.txHash, order.lastError, order.expiresAt, order.merchantOrderId])));
}

function safeBase(input?: string): string {
  const url = new URL(input || BASE);
  if (url.protocol !== 'https:' || url.hostname !== 'api.aipay.im' || url.username || url.password || url.port || url.pathname !== '/') {
    throw new Error('invalid AIPAY base URL');
  }
  return url.origin;
}

function sameAmount(a: unknown, b: string): boolean {
  if (typeof a !== 'string' && typeof a !== 'number') return false;
  const parse = (value: string) => {
    if (!/^\d+(?:\.\d{1,18})?$/.test(value)) return null;
    const [whole, fraction] = value.split('.');
    const tail = fraction?.replace(/0+$/, '');
    return `${whole!.replace(/^0+(?=\d)/, '')}${tail ? `.${tail}` : ''}`;
  };
  return parse(String(a)) !== null && parse(String(a)) === parse(b);
}

/** Persist before the API call so retried POSTs reuse AIPAY's merchantOrderId. */
export async function createBillingOrder(db: Db, env: AipayEnv, input: CreateBillingOrder,
  fetchImpl: typeof fetch = fetch): Promise<{ order: AipayOrderResponse; idempotent: boolean }> {
  if (!env.AIPAY_API_KEY || !PURPOSES.has(input.purpose) || !ID.test(input.merchantOrderId) ||
    !input.subjectId.trim() || !/^\d+(?:\.\d{1,18})?$/.test(input.amount) || !/^[A-Z0-9]{2,12}$/.test(input.asset) ||
    !/^[a-z0-9-]{2,32}$/.test(input.chainKey) ||
    (input.termDays !== undefined && (!Number.isSafeInteger(input.termDays) || input.termDays < 1 || input.termDays > 3650)) ||
    (input.ttlSeconds !== undefined && (!Number.isSafeInteger(input.ttlSeconds) || input.ttlSeconds < 60 || input.ttlSeconds > 86_400)) ||
    (input.description !== undefined && (typeof input.description !== 'string' || input.description.length < 1 || input.description.length > 200)) ||
    (input.returnUrl && (() => { try {
      const url = new URL(input.returnUrl); return url.protocol !== 'https:' || !['afr.im', 'www.afr.im'].includes(url.hostname);
    } catch { return true; } })())) throw new Error('invalid billing order');
  const created = new Date().toISOString();
  const insert = await db.prepare(`INSERT OR IGNORE INTO billing_orders
    (merchant_order_id, purpose, subject_id, amount, asset, chain_key, term_days, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'creating', ?, ?)`)
    .run(input.merchantOrderId, input.purpose, input.subjectId, input.amount, input.asset, input.chainKey,
      input.termDays ?? null, created, created);
  const existing = await db.prepare(`SELECT merchant_order_id, purpose, subject_id, amount, asset, chain_key, term_days,
    status, aipay_reference, checkout_url, expires_at, aipay_confirmed_at, tx_hash
    FROM billing_orders WHERE merchant_order_id = ?`).get<Record<string, unknown>>(input.merchantOrderId);
  if (!existing || existing.purpose !== input.purpose || existing.subject_id !== input.subjectId ||
    existing.amount !== input.amount || existing.asset !== input.asset || existing.chain_key !== input.chainKey ||
    (input.termDays !== undefined && existing.term_days !== null && Number(existing.term_days) !== input.termDays)) {
    throw new Error('billing_order_conflict');
  }
  if (existing.aipay_reference && (existing.checkout_url || existing.status !== 'pending')) {
    return { order: { reference: String(existing.aipay_reference), status: String(existing.status),
      merchantOrderId: input.merchantOrderId, amount: input.amount, asset: input.asset,
      chainKey: input.chainKey, ...(existing.checkout_url ? { checkoutUrl: String(existing.checkout_url) } : {}) }, idempotent: true };
  }
  const body = JSON.stringify({ amount: input.amount, asset: input.asset, chainKey: input.chainKey,
    merchantOrderId: input.merchantOrderId, description: input.description ?? `AFR ${input.purpose}`,
    ...(input.ttlSeconds !== undefined ? { ttlSeconds: input.ttlSeconds } : {}),
    ...(input.returnUrl ? { returnUrl: input.returnUrl } : {}) });
  const response = await fetchImpl(`${safeBase(env.AIPAY_BASE_URL)}/v1/orders`, {
    method: 'POST', redirect: AIPAY_REDIRECT, signal: AbortSignal.timeout(8000),
    headers: { Authorization: `Bearer ${env.AIPAY_API_KEY}`, 'Content-Type': 'application/json', Accept: 'application/json', 'User-Agent': AIPAY_USER_AGENT }, body,
  });
  const payload = await response.json() as { order?: AipayOrderResponse; idempotent?: boolean; error?: { code?: string } };
  const returned = payload.order;
  if (!response.ok || !returned || !/^ap_[A-Za-z0-9_-]{8,64}$/.test(returned.reference) ||
    returned.merchantOrderId !== input.merchantOrderId ||
    !sameAmount(returned.amount, input.amount) || returned.asset?.toUpperCase() !== input.asset ||
    returned.chainKey !== input.chainKey ||
    !(returned.status === 'pending' || (insert.changes === 0 && ['confirmed', 'expired', 'cancelled'].includes(returned.status)))) {
    throw new Error(`aipay_order_create_failed:${response.status}:${payload.error?.code ?? 'invalid_response'}`);
  }
  const checkoutUrl = returned.checkoutUrl ?? (typeof existing.checkout_url === 'string' ? existing.checkout_url : null);
  if (checkoutUrl) {
    const checkout = new URL(checkoutUrl);
    if (checkout.protocol !== 'https:' || checkout.hostname !== 'aipay.im' || checkout.username || checkout.password || checkout.port) throw new Error('invalid AIPAY checkout URL');
  } else if (returned.status === 'pending') throw new Error('invalid AIPAY checkout URL');
  const expiresAt = returned.expiresAt && Number.isFinite(returned.expiresAt) ? new Date(returned.expiresAt).toISOString() : null;
  // A POST replay may return a terminal order whose original response was lost.
  // Leave the checkout URL unset for terminal replays so a failed GET can be retried.
  await db.prepare(`UPDATE billing_orders SET status='pending', aipay_reference=?, checkout_url=COALESCE(?,checkout_url), expires_at=?, updated_at=?
    WHERE merchant_order_id=? AND status='creating'`)
    .run(returned.reference, returned.status === 'pending' ? checkoutUrl : null, expiresAt, new Date().toISOString(), input.merchantOrderId);
  if (returned.status !== 'pending' || (existing.aipay_reference && !existing.checkout_url)) {
    const local = await db.prepare(`SELECT merchant_order_id, amount, asset, chain_key, status, aipay_reference, expires_at
      FROM billing_orders WHERE merchant_order_id=?`).get<Record<string, unknown>>(input.merchantOrderId);
    if (!local) throw new Error('billing_order_missing_after_create');
    const readStatus = () => db.prepare(`SELECT status FROM billing_orders WHERE merchant_order_id=? AND aipay_reference=?`)
      .get<{ status: BillingStatus }>(input.merchantOrderId, returned.reference);
    let canonical: AipayOrderResponse;
    try {
      canonical = await getAipayOrder(env, returned.reference, fetchImpl);
    } catch (error) {
      const saved = await readStatus();
      if (!saved || saved.status === 'creating' || saved.status === 'pending') throw error;
      return { order: { reference: returned.reference, status: saved.status, merchantOrderId: input.merchantOrderId,
        amount: input.amount, asset: input.asset, chainKey: input.chainKey }, idempotent: true };
    }
    const hash = await canonicalOrderHash(canonical);
    const outcome = await recordCanonicalOrder(db, local, canonical, `reconcile:${hash}`, hash, 'reconcile', Date.now());
    if (outcome === 'invalid') throw new Error('aipay_terminal_order_invalid');
    const saved = await readStatus();
    if (!saved) throw new Error('billing_order_missing_after_create');
    return { order: { ...canonical, status: saved.status }, idempotent: true };
  }
  return { order: returned, idempotent: payload.idempotent === true || insert.changes === 0 };
}

export async function verifyAipayWebhook(raw: Uint8Array, headers: Headers, secret: string,
  now = Date.now()): Promise<{ body: Record<string, unknown>; eventId: string } | null> {
  const timestamp = headers.get('x-aipay-timestamp') ?? '';
  const signature = headers.get('x-aipay-signature') ?? '';
  const eventId = headers.get('x-aipay-delivery') ?? '';
  if (!secret || raw.length > 16_384 || !/^\d{1,12}$/.test(timestamp) ||
    Math.abs(Math.floor(now / 1000) - Number(timestamp)) > 300 ||
    !/^\d{1,16}$/.test(eventId) || !/^sha256=[0-9a-f]{64}$/.test(signature)) return null;
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
  const input = new Uint8Array(enc.encode(`${timestamp}.`).length + raw.length);
  input.set(enc.encode(`${timestamp}.`)); input.set(raw, enc.encode(`${timestamp}.`).length);
  const mac = Uint8Array.from(signature.slice(7).match(/../g)!, byte => parseInt(byte, 16));
  if (!await crypto.subtle.verify('HMAC', key, mac, input)) return null;
  try {
    const body = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(raw)) as Record<string, unknown>;
    return body && typeof body === 'object' && !Array.isArray(body) ? { body, eventId } : null;
  } catch { return null; }
}

export async function cancelAipayOrder(env: AipayEnv, reference: string,
  fetchImpl: typeof fetch = fetch): Promise<boolean> {
  if (!/^ap_[A-Za-z0-9_-]{8,64}$/.test(reference)) return false;
  const response = await fetchImpl(`${safeBase(env.AIPAY_BASE_URL)}/v1/orders/${encodeURIComponent(reference)}/cancel`, {
    method: 'POST', redirect: AIPAY_REDIRECT, signal: AbortSignal.timeout(8000),
    headers: { Authorization: `Bearer ${env.AIPAY_API_KEY}`, Accept: 'application/json', 'User-Agent': AIPAY_USER_AGENT },
  });
  return response.ok;
}

/** Apply a signed event only after binding it to the stored merchant order and verifying with AIPAY again. */
export async function applyAipayWebhook(db: Db, raw: Uint8Array, headers: Headers, secret: string,
  verifyOrder: (reference: string) => Promise<AipayOrderResponse>, now = Date.now()): Promise<'applied' | 'duplicate' | 'ignored' | 'invalid'> {
  if (!secret) return 'invalid';
  const verified = await verifyAipayWebhook(raw, headers, secret, now);
  if (!verified) return 'invalid';
  const { body, eventId } = verified;
  if (body.event !== headers.get('x-aipay-event') || !body.order || typeof body.order !== 'object') return 'invalid';
  const order = body.order as Record<string, unknown>;
  const merchantOrderId = order.merchantOrderId;
  const reference = order.reference;
  const status = order.status;
  const delivery = body.delivery as { id?: unknown } | undefined;
  if (typeof merchantOrderId !== 'string' || !ID.test(merchantOrderId) || typeof reference !== 'string' ||
    !['confirmed', 'expired', 'cancelled'].includes(String(status)) || body.event !== `order.${status}` ||
    !Number.isSafeInteger(delivery?.id) || String(delivery?.id) !== eventId) return 'invalid';
  const local = await db.prepare(`SELECT merchant_order_id, amount, asset, chain_key, status, aipay_reference, expires_at
    FROM billing_orders WHERE merchant_order_id=?`).get<Record<string, unknown>>(merchantOrderId);
  if (!local || local.aipay_reference !== reference) return 'ignored';
  // AIPAY regenerates createdAt and delivery.attempt on each send. The signed
  // identity is stable; mutable payment facts are checked via the merchant API.
  const payloadHash = await sha256(enc.encode(JSON.stringify([
    eventId, body.event, merchantOrderId, reference, status, order.amount, order.asset, order.chainKey,
  ])));
  const prior = await db.prepare('SELECT payload_sha256 FROM billing_events WHERE event_key=?').get<{payload_sha256:string}>(eventId);
  if (prior) return prior.payload_sha256 === payloadHash ? 'duplicate' : 'invalid';
  const canonical = await verifyOrder(reference);
  if (canonical.status !== status) return 'invalid';
  return recordCanonicalOrder(db, local, canonical, eventId, payloadHash, 'webhook', now);
}

type RecordResult = 'applied' | 'duplicate' | 'ignored' | 'invalid';

async function recordCanonicalOrder(db: Db, local: Record<string, unknown>, order: AipayOrderResponse,
  eventKey: string, hash: string, source: 'webhook' | 'reconcile', now: number): Promise<RecordResult> {
  const before = local.status as BillingStatus;
  const status = order.status;
  if (!STATUSES.has(before) || order.reference !== local.aipay_reference || order.merchantOrderId !== local.merchant_order_id ||
    !sameAmount(order.amount, String(local.amount)) || order.asset !== local.asset || order.chainKey !== local.chain_key ||
    !['pending', 'confirmed', 'expired', 'cancelled'].includes(status)) return 'invalid';
  if (status === 'pending') {
    if (before === 'confirmed') {
      return persistBillingTransition(db, local, 'review', 'order.confirmation_regressed',
        eventKey, hash, source, now, null, null);
    }
    return 'ignored';
  }
  if (before === 'confirmed' && status !== 'confirmed') {
    return persistBillingTransition(db, local, 'review', 'order.confirmation_regressed',
      eventKey, hash, source, now, null, null);
  }
  const paid = status === 'confirmed';
  const tx = paid ? order.txHash : null;
  if (paid && (typeof tx !== 'string' || !/^[A-Za-z0-9]{32,128}$/.test(tx) ||
    !Number.isSafeInteger(order.confirmedAt) || order.confirmedAt! <= 0 || order.confirmedAt! > now + 300_000)) return 'invalid';
  const paidAt = paid ? new Date(order.confirmedAt!).toISOString() : null;
  const localExpiry = Date.parse(String(local.expires_at ?? ''));
  const remoteExpiry = typeof order.expiresAt === 'number' ? order.expiresAt : NaN;
  const needsReview = paid && (before === 'expired' || before === 'cancelled' ||
    (Number.isFinite(localExpiry) && order.confirmedAt! > localExpiry) ||
    (Number.isFinite(remoteExpiry) && order.confirmedAt! > remoteExpiry) ||
    (typeof order.lastError === 'string' && order.lastError.startsWith('confirmation_regressed:')));
  if (before === 'review' || (before !== 'pending' && !needsReview)) return 'ignored';
  return persistBillingTransition(db, local, needsReview ? 'review' : status, `order.${status}`,
    eventKey, hash, source, now, paidAt, tx ?? null);
}

async function persistBillingTransition(db: Db, local: Record<string, unknown>, after: string, eventType: string,
  eventKey: string, hash: string, source: 'webhook' | 'reconcile', now: number,
  paidAt: string | null, tx: string | null): Promise<RecordResult> {
  const before = String(local.status);
  const id = String(local.merchant_order_id);
  const reference = String(local.aipay_reference);
  const stamp = new Date(now).toISOString();
  const prior = () => db.prepare('SELECT payload_sha256 FROM billing_events WHERE event_key=?').get<{payload_sha256:string}>(eventKey);
  try {
    const [logged, updated] = await db.batch([
      { sql: `INSERT INTO billing_events (merchant_order_id,event_key,source,event_type,payload_sha256,before_status,after_status,created_at)
          SELECT merchant_order_id,?,?,?,?,status,?,? FROM billing_orders WHERE merchant_order_id=? AND aipay_reference=? AND status=?`,
        params: [eventKey, source, eventType, hash, after, stamp, id, reference, before] },
      { sql: `UPDATE billing_orders SET status=?,aipay_confirmed_at=COALESCE(?,aipay_confirmed_at),tx_hash=COALESCE(?,tx_hash),updated_at=?
          WHERE merchant_order_id=? AND aipay_reference=? AND status=? AND EXISTS
          (SELECT 1 FROM billing_events WHERE event_key=? AND payload_sha256=? AND before_status=? AND after_status=?)`,
        params: [after, paidAt, tx, stamp, id, reference, before, eventKey, hash, before, after] },
    ]);
    if (logged === 1 && updated === 1) return 'applied';
  } catch (error) {
    const row = await prior();
    if (row) return row.payload_sha256 === hash ? 'duplicate' : 'invalid';
    throw error;
  }
  const row = await prior();
  if (row) return row.payload_sha256 === hash ? 'duplicate' : 'invalid';
  const current = await db.prepare(`SELECT status FROM billing_orders
    WHERE merchant_order_id=? AND aipay_reference=?`).get<{status:string}>(id, reference);
  if (current?.status === after) return 'ignored';
  throw new Error('billing_order_concurrent_update');
}

/** Bounded daily backstop: only existing AFR orders, never grants entitlements. */
export async function runAipayReconcileCron(db: Db, env: AipayEnv, fetchImpl: typeof fetch = fetch): Promise<number> {
  if (env.AIPAY_RECONCILE_ENABLED !== 'true' || !env.AIPAY_API_KEY?.trim()) return 0;
  const result = await reconcileAipayOrders(db, env, { pageSize: 10, maxPages: 1 }, async ({ orders }) => {
    for (const order of orders) {
      if (!order || typeof order.reference !== 'string') throw new Error('aipay_invalid_order_row');
      if (!order.merchantOrderId) continue;
      const local = await db.prepare(`SELECT merchant_order_id, amount, asset, chain_key, status, aipay_reference, expires_at
        FROM billing_orders WHERE merchant_order_id=?`).get<Record<string, unknown>>(order.merchantOrderId);
      if (!local || !local.aipay_reference) continue;
      const hash = await canonicalOrderHash(order);
      const outcome = await recordCanonicalOrder(db, local, order, `reconcile:${hash}`, hash, 'reconcile', Date.now());
      if (outcome === 'invalid' && local.status !== 'review') {
        const held = await persistBillingTransition(db, local, 'review', 'order.reconcile_mismatch',
          `mismatch:${local.merchant_order_id}:${hash}`, hash, 'reconcile', Date.now(), null, null);
        if (held === 'invalid') throw new Error('aipay_review_write_failed');
      }
    }
  }, fetchImpl);
  return result.pages;
}
