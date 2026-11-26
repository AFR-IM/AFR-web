// src/torch.ts — Torch Boost: public donations that boost a listed site.
//
// The board is money only. It never imports, writes or reads the scoring
// engine: `sites` is joined read-only to show a grade next to a total, and
// a boost can change nothing but the boost numbers themselves (the rule: paid boosts never touch scoring).
//
// Payments run on the shared AIPAY ledger with `purpose = 'torch'`, but
// under their own merchant — one recipient per merchant is an AIPAY hard
// rule — so the wallet that receives the money must be the wallet the
// settings board publishes as the charity pool. Every order re-checks that
// equality against the merchant profile and fails closed (what we
// publish is what we receive).
//
// Confirmation is two-channel: the signed webhook and the ten-minute poll
// (`pollBillingOrders`). Both funnel into `syncBoardLedgers`, which is
// idempotent and only ever moves rows forward.

import { createBillingOrder, getAipayMerchantProfile, type AipayEnv } from './aipay.ts';
import type { Db } from './db.ts';
import { normalizeDomain } from './domain.ts';

/** The donation pool target: at $1,000 the pool triggers a donation and the
 * pre-vetted beneficiary list is published for seven days. */
export const TORCH_TARGET = 1000;
/** One site, one UTC day, one wallet: at most $1,000 of boosts per UTC day. */
export const TORCH_DAILY_CAP = 1000;
/** The binding code answers for a pending order for 15 minutes. */
export const BINDING_TTL_MS = 15 * 60_000;
/** How long the seven-day beneficiary publication lasts once triggered. */
export const PUBLICATION_WINDOW_MS = 7 * 86_400_000;
/** 32 symbols — `[A-Z2-9]` minus O and I (0 and 1 are not in the digit set).
 * 32 divides 256, so byte-modulo sampling is unbiased. */
const CODE_CHARSET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_RE = /^[ABCDEFGHJKLMNPQRSTUVWXYZ2-9]{8}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const GRADES = new Set(['A', 'B', 'C', 'D', 'E', 'F']);
const PAGE_SIZE = 30;

export interface TorchEnv extends AipayEnv {
  /** Master switch for both paid boards. Off by default: while it is off
   * nothing can be bought, and flipping it off again is the one-click
   * stop-sale of a charity failure. */
  PAID_SALES_OPEN?: string;
  /** AIPAY key of the charity merchant (recipient = CHARITY_POOL). */
  AIPAY_CHARITY_API_KEY?: string;
}

export type TorchTab = 'day' | 'week' | 'month' | 'all';
type Failure = { ok: false; status: 400 | 401 | 403 | 404 | 409 | 502 | 503; error: string };
const fail = (status: Failure['status'], error: string): Failure => ({ ok: false, status, error });

export interface TorchOrder {
  orderId: string;
  bindingCode: string;
  amount: number;
  checkoutUrl: string;
  expiresAt: string;
}

export interface TorchStatusValue {
  status: 'pending' | 'paid' | 'expired' | 'cancelled' | 'review';
  amount: number;
  paidAt: string | null;
}

export interface TorchBoardItem {
  domain: string;
  total: number;
  count: number;
  grade: string | null;
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

export interface TorchPool {
  raised: number;
  target: number;
  crossedAt: string | null;
  publishedUntil: string | null;
}

type OrderResult = { ok: true; status: 200 | 201; order: TorchOrder } | Failure;
type StatusResult = { ok: true; status: 200; value: TorchStatusValue } | Failure;

/** Boost amounts: 1–1000 USDC, at most two decimals. Returns the canonical
 * ledger string (the amount must match the AIPAY order exactly — tolerance
 * zero). */
export function normalizeTorchAmount(raw: unknown): string | null {
  let value: number;
  if (typeof raw === 'number') {
    value = raw;
  } else if (typeof raw === 'string' && /^\d{1,4}(\.\d{1,2})?$/.test(raw.trim())) {
    value = Number(raw.trim());
  } else {
    return null;
  }
  if (!Number.isFinite(value) || value < 1 || value > TORCH_DAILY_CAP) return null;
  if (Math.abs(value * 100 - Math.round(value * 100)) > 1e-6) return null;
  return String(value);
}

function randomBindingCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  let code = '';
  for (const byte of bytes) code += CODE_CHARSET[byte % CODE_CHARSET.length];
  return code;
}

/** The stored value of a settings key as a plain string ('' when absent or
 * not a string). The two receiving addresses are read this way so that the
 * board modules never import the settings board (import cycle). */
export async function readStoredSettingString(db: Db, key: string): Promise<string> {
  try {
    const row = await db.prepare('SELECT value_json FROM admin_settings WHERE key = ?').get<{ value_json: string }>(key);
    if (!row) return '';
    const parsed = JSON.parse(row.value_json) as unknown;
    return typeof parsed === 'string' ? parsed.trim() : '';
  } catch {
    return '';
  }
}

/** Addresses compare case-insensitively: EVM is case-insensitive and AIPAY
 * stores recipients lowercased. */
export function sameWalletAddress(a: string, b: string): boolean {
  const left = a.trim().toLowerCase();
  const right = b.trim().toLowerCase();
  return left.length > 0 && left === right;
}

/** True when the pre-vetted beneficiary list holds at least one member — a pool
 * that can reach the threshold must have a list to publish. */
async function beneficiariesReady(db: Db): Promise<boolean> {
  try {
    const row = await db.prepare('SELECT value_json FROM admin_settings WHERE key = ?').get<{ value_json: string }>('beneficiaries');
    if (!row) return false;
    const parsed = JSON.parse(row.value_json) as unknown;
    return Array.isArray(parsed) && parsed.length > 0;
  } catch {
    return false;
  }
}

/** UTC midnight of the day `now` belongs to (the cap window). */
function utcDayStart(now: Date): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString();
}

/** First instant at which the pool reached the target, derived from the
 * paid rows themselves — no extra state to disagree with them. */
async function readCrossedAt(db: Db): Promise<string | null> {
  const row = await db
    .prepare(
      `SELECT MIN(paid_at) AS crossed_at FROM (
         SELECT paid_at, SUM(CAST(amount AS REAL)) OVER (ORDER BY paid_at, id) AS running
           FROM torch_purchases
          WHERE status = 'paid' AND paid_at IS NOT NULL
       ) WHERE running >= ?`,
    )
    .get<{ crossed_at: string | null }>(TORCH_TARGET);
  return row?.crossed_at ?? null;
}

/** The pool block of the public charity payload and the detail endpoint. */
export async function readTorchPool(db: Db): Promise<TorchPool> {
  const raisedRow = await db
    .prepare(`SELECT COALESCE(SUM(CAST(amount AS REAL)), 0) AS raised FROM torch_purchases WHERE status = 'paid'`)
    .get<{ raised: number }>();
  const crossedAt = await readCrossedAt(db);
  return {
    raised: Number(raisedRow?.raised ?? 0),
    target: TORCH_TARGET,
    crossedAt,
    publishedUntil: crossedAt ? new Date(Date.parse(crossedAt) + PUBLICATION_WINDOW_MS).toISOString() : null,
  };
}

/**
 * Create (or resume) the boost order of one site.
 *
 * The purchase row is inserted first, atomically guarded by the daily cap —
 * a single INSERT…SELECT decides eligibility, so two concurrent orders can
 * never together exceed $1,000 — and the AIPAY checkout is created after.
 * A failed checkout leaves the row; the ledger sweep cancels it once it is
 * clear no billing row will ever appear (the cap is released then).
 */
export async function createTorchOrder(db: Db, { input, env, fetchImpl, now = new Date() }: {
  input: unknown;
  env: TorchEnv;
  fetchImpl?: typeof fetch;
  now?: Date;
}): Promise<OrderResult> {
  if (env.PAID_SALES_OPEN !== 'true') return fail(403, 'torch_sales_closed');
  if (!input || typeof input !== 'object' || Array.isArray(input)) return fail(400, 'invalid_domain');
  const { domain, amount: rawAmount, requestId } = input as Record<string, unknown>;
  if (typeof requestId !== 'string' || !UUID.test(requestId)) return fail(400, 'invalid_request_id');
  const requested = typeof domain === 'string' ? normalizeDomain(domain) : null;
  if (!requested) return fail(400, 'invalid_domain');
  const amount = normalizeTorchAmount(rawAmount);
  if (!amount) return fail(400, 'invalid_amount');
  const site = await db.prepare('SELECT 1 AS seen FROM sites WHERE domain = ?').get<{ seen: number }>(requested);
  if (!site) return fail(404, 'unknown_domain');
  if (!env.AIPAY_CHARITY_API_KEY?.trim()) return fail(503, 'billing_not_configured');

  // Fail closed on the published wallet (publish == receive) and on the beneficiary list:
  // a pool that can hit the threshold must have a list to publish with it.
  const pool = await readStoredSettingString(db, 'charity_pool');
  if (!pool) return fail(503, 'settings_missing');
  if (!await beneficiariesReady(db)) return fail(503, 'settings_missing');
  const merchantEnv: AipayEnv = { ...env, AIPAY_API_KEY: env.AIPAY_CHARITY_API_KEY };
  const profile = await getAipayMerchantProfile(merchantEnv, fetchImpl);
  if (!profile || !sameWalletAddress(profile.recipientAddress ?? '', pool)) return fail(503, 'wallet_mismatch');

  const orderId = `torch-${requestId.toLowerCase()}`;
  const stamp = now.toISOString();
  const existing = await db
    .prepare('SELECT domain, amount, binding_code FROM torch_purchases WHERE merchant_order_id = ?')
    .get<{ domain: string; amount: string; binding_code: string }>(orderId);
  let bindingCode = existing?.binding_code ?? '';
  if (existing) {
    if (existing.domain !== requested || existing.amount !== amount) return fail(409, 'request_conflict');
  } else {
    const dayStart = utcDayStart(now);
    let inserted = false;
    for (let attempt = 0; attempt < 5 && !inserted; attempt += 1) {
      const code = randomBindingCode();
      try {
        const result = await db
          .prepare(
            `INSERT INTO torch_purchases
               (domain, binding_code, merchant_order_id, amount, asset, chain_key, status, created_at, updated_at)
             SELECT ?, ?, ?, ?, 'USDC', 'base', 'pending', ?, ?
             WHERE (SELECT COALESCE(SUM(CAST(amount AS REAL)), 0) FROM torch_purchases
                     WHERE domain = ? AND created_at >= ?
                       AND status IN ('pending', 'paid', 'review')) + ? <= ?`,
          )
          .run(requested, code, orderId, amount, stamp, stamp, requested, dayStart, Number(amount), TORCH_DAILY_CAP);
        if (result.changes === 1) {
          bindingCode = code;
          inserted = true;
        } else {
          return fail(409, 'torch_cap_reached');
        }
      } catch (error) {
        const message = String(error);
        if (message.includes('binding_code')) continue; // collision: new code
        if (message.includes('merchant_order_id')) {
          const raced = await db
            .prepare('SELECT domain, amount, binding_code FROM torch_purchases WHERE merchant_order_id = ?')
            .get<{ domain: string; amount: string; binding_code: string }>(orderId);
          if (!raced || raced.domain !== requested || raced.amount !== amount) return fail(409, 'request_conflict');
          bindingCode = raced.binding_code;
          inserted = true;
          break;
        }
        throw error;
      }
    }
    if (!inserted) return fail(409, 'request_conflict');
  }

  if (!env.AIPAY_CHARITY_API_KEY?.trim()) return fail(503, 'billing_not_configured');
  try {
    await createBillingOrder(db, merchantEnv, {
      merchantOrderId: orderId,
      purpose: 'torch',
      subjectId: requested,
      amount,
      asset: 'USDC',
      chainKey: 'base',
      description: `AFR torch boost · ${requested}`.slice(0, 200),
      ttlSeconds: 900,
      returnUrl: `https://afr.im/site/${requested}/?orderId=${orderId}#torch`,
    }, fetchImpl);
  } catch {
    // The provider may have created a payable order before losing its
    // response: the row stays, and only this merchant order id may retry.
    return fail(502, 'billing_unavailable');
  }
  const row = await db
    .prepare('SELECT checkout_url, expires_at FROM billing_orders WHERE merchant_order_id = ?')
    .get<{ checkout_url: string | null; expires_at: string | null }>(orderId);
  if (!row?.checkout_url) return fail(502, 'billing_unavailable');
  return {
    ok: true,
    status: existing ? 200 : 201,
    order: { orderId, bindingCode, amount: Number(amount), checkoutUrl: row.checkout_url, expiresAt: row.expires_at ?? '' },
  };
}

/**
 * The status of one boost, claimed with its binding code.
 *
 * The code answers for a PENDING order for fifteen minutes (it is the claim
 * token of an open checkout) and forever for a terminal one — a payer who
 * just confirmed must still be able to see the confirmation.
 */
export async function readTorchStatus(db: Db, { order, code, now = new Date() }: {
  order: unknown;
  code: unknown;
  now?: Date;
}): Promise<StatusResult> {
  if (typeof order !== 'string' || !order.startsWith('torch-') || !UUID.test(order.slice(6))) {
    return fail(400, 'invalid_request_id');
  }
  if (typeof code !== 'string' || !CODE_RE.test(code)) return fail(400, 'invalid_request_id');
  const row = await db
    .prepare(
      `SELECT t.amount, t.created_at, b.status AS billing_status, b.aipay_confirmed_at
         FROM torch_purchases t
         LEFT JOIN billing_orders b ON b.merchant_order_id = t.merchant_order_id
        WHERE t.merchant_order_id = ? AND t.binding_code = ?`,
    )
    .get<{ amount: string; created_at: string; billing_status: string | null; aipay_confirmed_at: string | null }>(
      order.toLowerCase(), code,
    );
  if (!row) return fail(404, 'not_found');
  let status: TorchStatusValue['status'];
  switch (row.billing_status) {
    case 'confirmed': status = 'paid'; break;
    case 'review': status = 'review'; break;
    case 'expired': status = 'expired'; break;
    case 'cancelled': status = 'cancelled'; break;
    default: status = 'pending';
  }
  if (status === 'pending' && now.getTime() - Date.parse(row.created_at) > BINDING_TTL_MS) {
    return fail(403, 'binding_expired');
  }
  return {
    ok: true,
    status: 200,
    value: { status, amount: Number(row.amount), paidAt: row.aipay_confirmed_at ?? null },
  };
}

/** The window start of a leaderboard tab (UTC; week starts Monday), or null
 * for the all-time tab. */
function tabStart(tab: TorchTab, now: Date): string | null {
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  const day = now.getUTCDate();
  if (tab === 'day') return new Date(Date.UTC(year, month, day)).toISOString();
  if (tab === 'week') return new Date(Date.UTC(year, month, day - ((now.getUTCDay() + 6) % 7))).toISOString();
  if (tab === 'month') return new Date(Date.UTC(year, month, 1)).toISOString();
  return null;
}

/**
 * One leaderboard page: 30 rows, ranked by boosted amount inside the window.
 * The grade and score columns are read-only decoration — the ordering is
 * the boost money and nothing else (the board never feeds the
 * score, and the score never feeds the board).
 */
export async function readTorchLeaderboard(db: Db, { tab, page, now, salesOpen }: {
  tab: unknown;
  page: unknown;
  now?: Date;
  salesOpen: boolean;
}): Promise<TorchBoard | null> {
  if (tab !== 'day' && tab !== 'week' && tab !== 'month' && tab !== 'all') return null;
  const requestedPage = typeof page === 'number' && Number.isSafeInteger(page) && page >= 1 ? page : 1;
  const start = tabStart(tab, now ?? new Date());
  const window_ = start ? ' AND t.paid_at >= ?' : '';
  const params: (string | number)[] = start ? [start] : [];
  const grouped = `FROM torch_purchases t LEFT JOIN sites s ON s.domain = t.domain
     WHERE t.status = 'paid' AND t.paid_at IS NOT NULL${window_}
     GROUP BY t.domain`;
  // The GROUP BY belongs to the inner query: without the wrapper the outer
  // COUNT would be computed per group and `.get()` would read a single row.
  const totals = await db
    .prepare(`SELECT COUNT(*) AS groups FROM (SELECT t.domain ${grouped})`)
    .get<{ groups: number }>(...params);
  const groups = Number(totals?.groups ?? 0);
  const pages = Math.max(1, Math.ceil(groups / PAGE_SIZE));
  const page_ = Math.min(requestedPage, pages);
  const rows = await db
    .prepare(
      `SELECT t.domain AS domain, SUM(CAST(t.amount AS REAL)) AS boosted, COUNT(*) AS hits,
              s.grade AS grade, s.score_total AS score
         ${grouped}
        ORDER BY boosted DESC, hits DESC, t.domain ASC
        LIMIT ? OFFSET ?`,
    )
    .all<{ domain: string; boosted: number; hits: number; grade: string | null; score: number | null }>(
      ...params, PAGE_SIZE, (page_ - 1) * PAGE_SIZE,
    );
  return {
    tab,
    page: page_,
    pages,
    total: groups,
    salesOpen,
    items: rows.map((row) => ({
      domain: row.domain,
      total: Number(row.boosted),
      count: Number(row.hits),
      grade: row.grade && GRADES.has(row.grade) ? row.grade : null,
      score: typeof row.score === 'number' && Number.isFinite(row.score) ? row.score : null,
    })),
  };
}

/** The badge payload for one site. An unknown domain is a zeroed answer
 * (the badge hides on total = 0), not an error. */
export async function readTorchDetail(db: Db, { domain, salesOpen }: {
  domain: unknown;
  salesOpen: boolean;
}): Promise<TorchDetail | null> {
  if (typeof domain !== 'string') return null;
  const requested = normalizeDomain(domain);
  if (!requested) return null;
  const stats = await db
    .prepare(
      `SELECT COUNT(*) AS hits, COALESCE(SUM(CAST(amount AS REAL)), 0) AS boosted, MAX(paid_at) AS last_at
         FROM torch_purchases WHERE domain = ? AND status = 'paid'`,
    )
    .get<{ hits: number; boosted: number; last_at: string | null }>(requested);
  const total = Number(stats?.boosted ?? 0);
  let rank: number | null = null;
  if (total > 0) {
    const ahead = await db
      .prepare('SELECT COUNT(*) AS ahead FROM torch_totals WHERE total_amount > ?')
      .get<{ ahead: number }>(total);
    rank = Number(ahead?.ahead ?? 0) + 1;
  }
  const pool = await readTorchPool(db);
  return {
    domain: requested,
    total,
    count: Number(stats?.hits ?? 0),
    rank,
    lastAt: stats?.last_at ?? null,
    raised: pool.raised,
    target: pool.target,
    salesOpen,
  };
}

/**
 * Move the board rows that the ledger has already decided.
 *
 * Idempotent and forward-only: a purchase follows its `billing_orders` row
 * (confirmed → paid, expired/cancelled → cancelled, review → review), a
 * purchase whose billing row never materialised releases the daily cap
 * after 30 minutes, and `torch_totals` is rebuilt from the paid rows. Run
 * after every webhook application, every ten-minute poll and the daily
 * reconcile — whichever channel confirmed first, the result is the same.
 */
export async function syncBoardLedgers(db: Db, source: 'webhook' | 'scan' | 'reconcile', now = new Date()): Promise<void> {
  const stamp = now.toISOString();
  const orphanCutoff = new Date(now.getTime() - 30 * 60_000).toISOString();
  await db.batch([
    {
      sql: `UPDATE torch_purchases SET
              status = 'paid',
              tx_hash = COALESCE((SELECT b.tx_hash FROM billing_orders b
                                   WHERE b.merchant_order_id = torch_purchases.merchant_order_id), tx_hash),
              paid_at = COALESCE((SELECT b.aipay_confirmed_at FROM billing_orders b
                                   WHERE b.merchant_order_id = torch_purchases.merchant_order_id), paid_at),
              source = COALESCE(source, ?),
              updated_at = ?
            WHERE status = 'pending'
              AND merchant_order_id IN (SELECT merchant_order_id FROM billing_orders
                                         WHERE purpose = 'torch' AND status = 'confirmed')`,
      params: [source, stamp],
    },
    {
      sql: `UPDATE torch_purchases SET status = 'review', updated_at = ?
            WHERE status = 'pending'
              AND merchant_order_id IN (SELECT merchant_order_id FROM billing_orders
                                         WHERE purpose = 'torch' AND status = 'review')`,
      params: [stamp],
    },
    {
      sql: `UPDATE torch_purchases SET status = 'cancelled', updated_at = ?
            WHERE status = 'pending'
              AND merchant_order_id IN (SELECT merchant_order_id FROM billing_orders
                                         WHERE purpose = 'torch' AND status IN ('expired', 'cancelled'))`,
      params: [stamp],
    },
    {
      sql: `UPDATE torch_purchases SET status = 'cancelled', updated_at = ?
            WHERE status = 'pending' AND created_at < ?
              AND NOT EXISTS (SELECT 1 FROM billing_orders b
                               WHERE b.merchant_order_id = torch_purchases.merchant_order_id)`,
      params: [stamp, orphanCutoff],
    },
    {
      sql: `UPDATE detail_promos SET status = 'paid', updated_at = ?
            WHERE status = 'pending'
              AND merchant_order_id IN (SELECT merchant_order_id FROM billing_orders
                                         WHERE purpose = 'promo' AND status = 'confirmed')`,
      params: [stamp],
    },
    {
      sql: `UPDATE detail_promos SET status = 'cancelled', updated_at = ?
            WHERE status = 'pending'
              AND merchant_order_id IN (SELECT merchant_order_id FROM billing_orders
                                         WHERE purpose = 'promo' AND status IN ('expired', 'cancelled'))`,
      params: [stamp],
    },
    {
      sql: `INSERT INTO torch_totals (domain, total_amount, total_count, first_at, last_at)
            SELECT domain, SUM(CAST(amount AS REAL)), COUNT(*), MIN(paid_at), MAX(paid_at)
              FROM torch_purchases WHERE status = 'paid' AND paid_at IS NOT NULL
             GROUP BY domain
            ON CONFLICT(domain) DO UPDATE SET
              total_amount = excluded.total_amount,
              total_count = excluded.total_count,
              first_at = excluded.first_at,
              last_at = excluded.last_at`,
      params: [],
    },
  ]);
}
