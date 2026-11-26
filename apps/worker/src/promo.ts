// src/promo.ts — the owner promo cards: a paid, reviewed, self-linking
// sponsored block on the promoting site's own detail page.
//
// Rules that live here (not in the UI):
//   - self-serve only for verified sites whose owner token matches;
//   - $19 / $49 / $149 buys 30 / 90 / 365 days, halved while the site
//     holds Pro (the discount is decided when the order is created);
//   - the copy passes the same misleading-claim filter as ads, and the
//     card can only ever link back to the site that bought it;
//   - payment runs on the shared AIPAY ledger with `purpose = 'promo'`
//     under the promo merchant (recipient = PROMO_WALLET) — no second
//     payment stack.
//
// Like every other paid block, a promo can never touch a score or a
// ranking: it reads nothing from the engine and writes only its own rows.

import { MISLEADING, CONTROL, plainText } from './ads.ts';
import { createBillingOrder, type AipayEnv, type BillingStatus } from './aipay.ts';
import { ownerOwnsDomain, resolveSiteKey } from './commercial.ts';
import type { Db } from './db.ts';
import { normalizeDomain } from './domain.ts';
import { computeProEntitlement } from './entitlements.ts';
import { requestReserved, reserveRequestStatement } from './admin-audit.ts';
import { getAipayMerchantProfile } from './aipay.ts';
import { readStoredSettingString, sameWalletAddress } from './torch.ts';

/** Tier → term. Prices are USD, one-time, 30/90/365 days (recorded gap in
 * the source spec: the ladder is this project's decision). */
export const PROMO_TIERS: Record<number, number> = { 19: 30, 49: 90, 149: 365 };
const ASSET = 'USDC';
const CHAIN = 'base';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface PromoEnv extends AipayEnv {
  /** Master switch of both paid boards (see torch.ts). */
  PAID_SALES_OPEN?: string;
  /** AIPAY key of the promo merchant (recipient = PROMO_WALLET). */
  AIPAY_PROMO_API_KEY?: string;
}

export type Failure = { ok: false; status: 400 | 401 | 403 | 404 | 409 | 502 | 503; error: string };
const fail = (status: Failure['status'], error: string): Failure => ({ ok: false, status, error });

export interface PromoOrder {
  orderId: string;
  domain: string;
  tier: number;
  termDays: number;
  amount: number;
  isProHalf: boolean;
  status: 'pending' | 'paid' | 'active' | 'paused' | 'expired' | 'rejected' | 'cancelled';
  paid: boolean;
  checkoutUrl: string | null;
  expiresAt: string | null;
  startsAt: string | null;
  endsAt: string | null;
  reviewNote: string | null;
}

type OrderResult = { ok: true; status: 200 | 201; order: PromoOrder } | Failure;

interface PromoRow {
  id: number;
  domain: string;
  tier: number;
  term_days: number;
  amount: string;
  pro_half: number;
  headline: string;
  body: string;
  status: PromoOrder['status'];
  merchant_order_id: string;
  starts_at: string | null;
  ends_at: string | null;
  review_note: string | null;
  checkout_url: string | null;
  checkout_expires_at: string | null;
  billing_status: BillingStatus | null;
  billing_tx: string | null;
}

const PROMO_SELECT = `SELECT p.id, p.domain, p.tier, p.term_days, p.amount, p.pro_half, p.headline, p.body,
    p.status, p.merchant_order_id, p.starts_at, p.ends_at, p.review_note,
    b.checkout_url, b.expires_at AS checkout_expires_at, b.status AS billing_status, b.tx_hash AS billing_tx
  FROM detail_promos p LEFT JOIN billing_orders b ON b.merchant_order_id = p.merchant_order_id`;

function project(row: PromoRow): PromoOrder {
  return {
    orderId: row.merchant_order_id,
    domain: row.domain,
    tier: row.tier,
    termDays: row.term_days,
    amount: Number(row.amount),
    isProHalf: row.pro_half === 1,
    status: row.status,
    paid: row.billing_status === 'confirmed' && row.billing_tx !== null,
    checkoutUrl: row.checkout_url,
    expiresAt: row.checkout_expires_at,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    reviewNote: row.review_note,
  };
}

/**
 * Create (or resume) the promo order of an owned, verified site.
 *
 * The half price is computed at order time from the site's live Pro state
 * and frozen into the row, so a later Pro change can never re-price an
 * order that already exists.
 */
export async function createPromoOrder(db: Db, { input, manageToken, env, fetchImpl, now = new Date() }: {
  input: unknown;
  manageToken: string | null;
  env: PromoEnv;
  fetchImpl?: typeof fetch;
  now?: Date;
}): Promise<OrderResult> {
  if (env.PAID_SALES_OPEN !== 'true') return fail(403, 'promo_sales_closed');
  if (!input || typeof input !== 'object' || Array.isArray(input)) return fail(400, 'invalid_application');
  const { domain, tier: rawTier, headline, body, requestId } = input as Record<string, unknown>;
  if (typeof requestId !== 'string' || !UUID.test(requestId)) return fail(400, 'invalid_request_id');
  const tier = typeof rawTier === 'number' && Number.isInteger(rawTier) ? rawTier : 0;
  const term = PROMO_TIERS[tier];
  if (!term) return fail(400, 'invalid_tier');
  const requested = typeof domain === 'string' ? normalizeDomain(domain) : null;
  if (!requested) return fail(400, 'invalid_domain');
  if (!await ownerOwnsDomain(db, requested, manageToken)) return fail(401, 'unauthorized');
  const site = await db
    .prepare('SELECT verified FROM sites WHERE domain = ?')
    .get<{ verified: number }>(requested);
  if (!site) return fail(404, 'unknown_domain');
  if (site.verified !== 1) return fail(403, 'not_verified');
  const title = plainText(headline, 40);
  const copy = plainText(body, 90);
  if (!title || !copy) return fail(400, 'invalid_copy');
  const claim = `${title} ${copy}`.normalize('NFKC');
  if (MISLEADING.test(claim) || MISLEADING.test(claim.replace(/\s+/g, '')) || CONTROL.test(claim)) {
    return fail(400, 'disallowed_claim');
  }
  if (!env.AIPAY_PROMO_API_KEY?.trim()) return fail(503, 'billing_not_configured');

  // The wallet we publish as PROMO_WALLET must be the wallet that really
  // receives this money — the same fail-closed check the torch board makes.
  const wallet = await readStoredSettingString(db, 'promo_wallet');
  if (!wallet) return fail(503, 'settings_missing');
  const promoEnv: AipayEnv = { ...env, AIPAY_API_KEY: env.AIPAY_PROMO_API_KEY };
  const profile = await getAipayMerchantProfile(promoEnv, fetchImpl);
  if (!profile || !sameWalletAddress(profile.recipientAddress ?? '', wallet)) return fail(503, 'wallet_mismatch');

  const subject = await resolveSiteKey(db, requested);
  if (!subject) return fail(404, 'unknown_domain');
  const pro = await computeProEntitlement(db, subject, now.getTime());
  const half = pro.active;
  const amount = String(half ? tier / 2 : tier);

  const orderId = `promo-${requestId.toLowerCase()}`;
  const stamp = now.toISOString();
  let row = await db.prepare(`${PROMO_SELECT} WHERE p.merchant_order_id = ?`).get<PromoRow>(orderId);
  const existed = !!row;
  if (!row) {
    try {
      await db.prepare(
        `INSERT INTO detail_promos
           (domain, tier, term_days, amount, pro_half, headline, body, status, merchant_order_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
      ).run(requested, tier, term, amount, half ? 1 : 0, title, copy, orderId, stamp, stamp);
    } catch (error) {
      const message = String(error);
      if (!/UNIQUE constraint failed/i.test(message)) throw error;
      // Either this order id already exists (resume) or the domain already
      // holds a live promo. SQLite names the violated column differently
      // depending on which index fired, so re-read instead of guessing.
      const raced = await db.prepare(`${PROMO_SELECT} WHERE p.merchant_order_id = ?`).get<PromoRow>(orderId);
      if (raced) {
        if (raced.domain !== requested || raced.tier !== tier || raced.amount !== amount) {
          return fail(409, 'request_conflict');
        }
        row = raced;
      } else {
        const live = await db
          .prepare(`SELECT 1 AS seen FROM detail_promos
                     WHERE domain = ? AND status IN ('pending', 'paid', 'active', 'paused')`)
          .get<{ seen: number }>(requested);
        if (live) return fail(409, 'order_pending');
        return fail(409, 'request_conflict');
      }
    }
    if (!row) row = await db.prepare(`${PROMO_SELECT} WHERE p.merchant_order_id = ?`).get<PromoRow>(orderId);
  } else if (row.domain !== requested || row.tier !== tier || row.amount !== amount) {
    return fail(409, 'request_conflict');
  }
  if (!row) return fail(409, 'request_conflict');

  try {
    await createBillingOrder(db, promoEnv, {
      merchantOrderId: orderId,
      purpose: 'promo',
      subjectId: requested,
      amount,
      asset: ASSET,
      chainKey: CHAIN,
      termDays: term,
      description: `AFR promo · ${requested}`.slice(0, 200),
      ttlSeconds: 900,
      returnUrl: `https://afr.im/owner/${requested}/?orderId=${orderId}#owner-promo`,
    }, fetchImpl);
  } catch {
    return fail(502, 'billing_unavailable');
  }
  const saved = await db.prepare(`${PROMO_SELECT} WHERE p.merchant_order_id = ?`).get<PromoRow>(orderId);
  if (!saved) return fail(502, 'billing_unavailable');
  const order = project(saved);
  if (order.status === 'pending' && !order.checkoutUrl) return fail(502, 'billing_unavailable');
  return { ok: true, status: existed ? 200 : 201, order };
}

/** The owner-facing view of one promo order (the manage token decides). */
export async function readPromoOrder(db: Db, orderId: string, manageToken: string | null): Promise<OrderResult> {
  if (!manageToken?.trim()) return fail(401, 'unauthorized');
  if (!orderId.startsWith('promo-') || !UUID.test(orderId.slice(6))) return fail(404, 'not_found');
  const row = await db.prepare(`${PROMO_SELECT} WHERE p.merchant_order_id = ?`).get<PromoRow>(orderId.toLowerCase());
  if (!row || !await ownerOwnsDomain(db, row.domain, manageToken)) return fail(404, 'not_found');
  return { ok: true, status: 200, order: project(row) };
}

/**
 * The public card payload for one detail page: the site's own live promo,
 * and nothing else. Paid + approved + inside its term, with the payment
 * re-checked live so a ledger regression can never keep a card on sale.
 */
export async function readActivePromo(db: Db, domain: unknown, now = new Date()): Promise<{
  domain: string; headline: string; body: string; startsAt: string; endsAt: string;
} | null> {
  if (typeof domain !== 'string') return null;
  const requested = normalizeDomain(domain);
  if (!requested) return null;
  const row = await db
    .prepare(
      `SELECT p.domain, p.headline, p.body, p.starts_at, p.ends_at
         FROM detail_promos p
         JOIN billing_orders b ON b.merchant_order_id = p.merchant_order_id
        WHERE p.domain = ? AND p.status = 'active' AND p.approval_request_id IS NOT NULL
          AND b.purpose = 'promo' AND b.status = 'confirmed'
        ORDER BY p.id DESC LIMIT 1`,
    )
    .get<{ domain: string; headline: string; body: string; starts_at: string; ends_at: string }>(requested);
  if (!row) return null;
  const start = Date.parse(row.starts_at);
  const end = Date.parse(row.ends_at);
  const nowMs = now.getTime();
  if (!(Number.isFinite(start) && Number.isFinite(end) && start <= nowMs && nowMs < end)) return null;
  return { domain: row.domain, headline: row.headline, body: row.body, startsAt: row.starts_at, endsAt: row.ends_at };
}

/** Close the terms that ran out (daily cron). */
export async function expirePromos(db: Db, now = new Date()): Promise<number> {
  const result = await db.prepare(
    `UPDATE detail_promos SET status = 'expired', updated_at = ?
      WHERE id IN (SELECT id FROM detail_promos
                    WHERE status IN ('active', 'paused') AND ends_at <= ?
                    ORDER BY ends_at ASC LIMIT 100)`,
  ).run(now.toISOString(), now.toISOString());
  return result.changes;
}

export interface ModeratePromoInput {
  requestId: string;
  subject: string;
  id: number;
  decision: string;
  note?: string | null;
  now?: Date;
}

export type ModeratePromoResult = { result: 'applied' | 'replayed' } | { result: 'conflict'; error: string };

/** Approve or reject a paid promo. Business write + audit row in one
 * statement through the `admin_promo_moderate` write view, with the request
 * id reserved in the same batch (replay = same id = "replayed"). */
export async function moderatePromo(db: Db, { requestId, subject, id, decision, note, now = new Date() }: ModeratePromoInput):
  Promise<ModeratePromoResult> {
  if (!UUID.test(requestId) || !subject.trim() || subject.length > 256
    || !Number.isSafeInteger(id) || id < 1 || !['approve', 'reject'].includes(decision)) {
    return { result: 'conflict', error: '推广操作参数无效。' };
  }
  const requestKey = requestId.toLowerCase();
  if (await requestReserved(db, requestKey)) return { result: 'replayed' };
  const text = plainText(note ?? '', 500);
  if (text === null) return { result: 'conflict', error: '审核备注不能超过 500 字。' };
  const stamp = now.toISOString();
  try {
    await db.batch([
      reserveRequestStatement({ requestId: requestKey, action: `promo.${decision}`, subject, createdAt: stamp }),
      {
        sql: `INSERT INTO admin_promo_moderate (request_id, subject, promo_id, decision, note, now)
              VALUES (?, ?, ?, ?, ?, ?)`,
        params: [requestKey, subject, id, decision, text, stamp],
      },
    ]);
  } catch (error) {
    const message = String(error);
    if (/UNIQUE constraint failed:\s*admin_requests\.request_id\b/i.test(message) && await requestReserved(db, requestKey)) {
      return { result: 'replayed' };
    }
    if (message.includes('promo_state_conflict')) {
      return { result: 'conflict', error: '推广或付款状态已变化，请刷新后重试。' };
    }
    if (message.includes('promo_admin_request_required')) {
      return { result: 'conflict', error: '请求标识无效，请刷新页面重试。' };
    }
    throw error;
  }
  return { result: 'applied' };
}
