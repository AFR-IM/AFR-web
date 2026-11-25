// src/commercial.ts — the paid side of afr.im: the Pro subscription and the
// machine API key.
//
// Four rules hold everywhere in this module:
//
//  1. The local ledger (`billing_orders`) is the only source of truth for
//     money. A browser return URL proves nothing, and a webhook proves
//     nothing until AIPAY's own order API confirmed the payment facts.
//  2. The owner is the holder of the management token of the confirmed
//     mailbox — the same key as `/api/v1/owners/*`.
//  3. Payment never touches the score. Nothing here reads or writes
//     `sites.grade` or `sites.score_total`: a paid site is not a
//     better-scored site. Pro buys service, never rank.
//  4. The plaintext of a key exists exactly once — in the response that
//     created it. The database only ever holds its SHA-256.

import { createBillingOrder, type AipayEnv } from './aipay.ts';
import { hashApiKey } from './api-key.ts';import { computeProEntitlement, DEFAULT_PRO_TERM_DAYS, syncEntitlementFromBilling } from './entitlements.ts';
import { hashToken } from './email.ts';
import type { Db } from './db.ts';
import { normalizeDomain, registrableDomain } from './domain.ts';

/** The price of one Pro term: 12 USDC on the Base chain. */
export const PRO_PRICE_AMOUNT = '12';
export const PRO_PRICE_ASSET = 'USDC';
export const PRO_PRICE_CHAIN = 'base';
/** How long the checkout session lives (seconds). */
export const PRO_ORDER_TTL_SECONDS = 900;
/** The product page the buyer returns to after the payment. */
export const PRO_RETURN_PATH = '/owner/';

/** The error codes the billing routes answer with. */
export type ProErrorCode =
  | 'invalid_domain'
  | 'invalid_json'
  | 'unauthorized'
  | 'unknown_domain'
  | 'order_pending'
  | 'billing_not_configured'
  | 'billing_unavailable'
  | 'not_found'
  | 'api_keys_unavailable';

/** The HTTP status a failure carries (the codes the contract allows). */
export type ProErrorStatus = 400 | 401 | 404 | 409 | 502 | 503;

export interface ProFailure {
  ok: false;
  error: ProErrorCode;
  status: ProErrorStatus;
}

/** A created Pro order, as the buyer sees it. */
export interface ProOrderView {
  orderId: string;
  reference: string;
  checkoutUrl: string;
  amount: string;
  asset: string;
  chainKey: string;
  expiresAt: string;
}

/** The order row of the local ledger. */
interface LedgerOrder {
  merchant_order_id: string;
  subject_id: string;
  status: string;
  amount: string;
  asset: string;
  chain_key: string;
  term_days: number | null;
  aipay_reference: string | null;
  checkout_url: string | null;
  expires_at: string | null;
  created_at: string;
}

/**
 * The directory key of a domain — the same rule the owner mailbox uses.
 * `www.example.com` is filed under `example.com`, a subdomain keeps its own
 * key (the directory lists it under its own name).
 */
function directoryDomain(domain: string): string {
  return registrableDomain(domain) ?? domain;
}

/** Whether the presented management token owns the domain. */
export async function ownerOwnsDomain(db: Db, domain: string, token: string | null | undefined): Promise<boolean> {
  if (!token || !token.trim()) return false;
  const key = directoryDomain(domain);
  try {
    const row = await db
      .prepare(
        `SELECT 1 AS seen FROM owner_emails
         WHERE domain = ? AND manage_token_hash = ? AND verified_at IS NOT NULL LIMIT 1`,
      )
      .get(key, await hashToken(token.trim()));
    return row !== undefined;
  } catch {
    return false;
  }
}

/**
 * The directory key of a domain, or null when AFR does not list it.
 * Both the requested domain and its registered form are looked up: the
 * directory files a site under the name it was scanned with.
 */
export async function resolveSiteKey(db: Db, domain: string): Promise<string | null> {
  const key = directoryDomain(domain);
  const row = await db
    .prepare('SELECT domain FROM sites WHERE domain IN (?, ?) LIMIT 1')
    .get<{ domain: string }>(domain, key);
  return row?.domain ?? null;
}

/** The merchant order id of one Pro order. */
export async function proOrderId(domain: string): Promise<string> {
  const suffix = crypto.randomUUID();
  const full = `pro-${domain}-${suffix}`;
  if (full.length <= 64) return full;
  // The ledger's id field is bounded; a long domain is replaced by a short
  // digest of it (the uuid still makes the id unique).
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(domain));
  const hash = Array.from(new Uint8Array(digest))
    .map(byte => byte.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, 16);
  return `pro-${hash}-${suffix}`;
}

/** The ledger row of an order, addressed by its AIPAY reference or by its
 * merchant order id. */
export async function findLedgerOrder(db: Db, reference: string): Promise<LedgerOrder | null> {
  const value = String(reference ?? '').trim();
  if (!value) return null;
  const row = await db
    .prepare(
      `SELECT merchant_order_id, subject_id, status, amount, asset, chain_key, term_days,
              aipay_reference, checkout_url, expires_at, created_at
       FROM billing_orders
       WHERE purpose = 'pro' AND (aipay_reference = ? OR merchant_order_id = ?)
       ORDER BY id DESC LIMIT 1`,
    )
    .get<LedgerOrder>(value, value);
  return row ?? null;
}

/**
 * Create one Pro order.
 *
 * The ledger is written first (status `creating`), then AIPAY is called. A
 * failed call cancels the ledger row: an order nobody can pay for must not
 * sit in the ledger as a pending order forever.
 */
export async function createProOrder(db: Db, input: {
  domain: string;
  manageToken: string | null;
  env: AipayEnv;
  fetchImpl?: typeof fetch;
}): Promise<{ ok: true; order: ProOrderView } | ProFailure> {
  const requested = normalizeDomain(input.domain);
  if (!requested) return { ok: false, error: 'invalid_domain', status: 400 };
  if (!input.manageToken?.trim()) return { ok: false, error: 'unauthorized', status: 401 };
  if (!(await ownerOwnsDomain(db, requested, input.manageToken))) {
    return { ok: false, error: 'unauthorized', status: 401 };
  }
  if (!input.env?.AIPAY_API_KEY?.trim()) {
    return { ok: false, error: 'billing_not_configured', status: 503 };
  }
  const subject = await resolveSiteKey(db, requested);
  if (!subject) return { ok: false, error: 'unknown_domain', status: 404 };

  // One open order per domain: a second checkout for the same subscription
  // would be a second payment for the same term.
  const open = await db
    .prepare(
      `SELECT merchant_order_id FROM billing_orders
       WHERE purpose = 'pro' AND subject_id = ? AND status IN ('creating', 'pending', 'review')
       LIMIT 1`,
    )
    .get<{ merchant_order_id: string }>(subject);
  if (open) return { ok: false, error: 'order_pending', status: 409 };

  const merchantOrderId = await proOrderId(subject);
  try {
    const { order } = await createBillingOrder(
      db,
      input.env,
      {
        merchantOrderId,
        purpose: 'pro',
        subjectId: subject,
        amount: PRO_PRICE_AMOUNT,
        asset: PRO_PRICE_ASSET,
        chainKey: PRO_PRICE_CHAIN,
        termDays: DEFAULT_PRO_TERM_DAYS,
        description: `AFR Pro · ${subject}`,
        ttlSeconds: PRO_ORDER_TTL_SECONDS,
        returnUrl: `https://afr.im${PRO_RETURN_PATH}${subject}/`,
      },
      input.fetchImpl ?? fetch,
    );
    if (!order.checkoutUrl) throw new Error('aipay_checkout_url_missing');
    const expiresAt = Number.isFinite(order.expiresAt)
      ? new Date(order.expiresAt as number).toISOString()
      : new Date(Date.now() + PRO_ORDER_TTL_SECONDS * 1000).toISOString();
    return {
      ok: true,
      order: {
        orderId: merchantOrderId,
        reference: order.reference,
        checkoutUrl: order.checkoutUrl,
        amount: PRO_PRICE_AMOUNT,
        asset: PRO_PRICE_ASSET,
        chainKey: PRO_PRICE_CHAIN,
        expiresAt,
      },
    };
  } catch (error) {
    // Nobody can pay for this order: it leaves the ledger as cancelled.
    // The reason is logged — a silent 502 is the worst kind of failure.
    console.warn(
      `pro order failed for ${subject}: ${error instanceof Error ? error.message : String(error)}`,
    );
    try {
      await db
        .prepare(
          `UPDATE billing_orders SET status = 'cancelled', updated_at = ?
           WHERE merchant_order_id = ? AND status = 'creating'`,
        )
        .run(new Date().toISOString(), merchantOrderId);
    } catch {
      // The ledger is unavailable too — the caller's answer is the same.
    }
    return { ok: false, error: 'billing_unavailable', status: 502 };
  }
}

/** The state of one order, as the buyer's status page shows it. */
export interface ProOrderStatus {
  reference: string;
  orderId: string;
  status: string;
  paid: boolean;
  amount: string;
  asset: string;
  chainKey: string;
  expiresAt: string | null;
  checkoutUrl?: string;
  pro: { active: boolean; expiresAt: string | null };
}

/** Read one order (and the Pro state it produced). */
export async function readProOrder(db: Db, reference: string,
  manageToken: string | null): Promise<{ ok: true; order: ProOrderStatus } | ProFailure> {
  if (!manageToken?.trim()) return { ok: false, error: 'unauthorized', status: 401 };
  const row = await findLedgerOrder(db, reference);
  if (!row) return { ok: false, error: 'not_found', status: 404 };
  if (!(await ownerOwnsDomain(db, row.subject_id, manageToken))) {
    return { ok: false, error: 'unauthorized', status: 401 };
  }
  const pro = await computeProEntitlement(db, row.subject_id);
  const view: ProOrderStatus = {
    reference: row.aipay_reference ?? row.merchant_order_id,
    orderId: row.merchant_order_id,
    status: row.status,
    paid: row.status === 'confirmed',
    amount: row.amount,
    asset: row.asset,
    chainKey: row.chain_key,
    expiresAt: row.expires_at,
    pro: { active: pro.active, expiresAt: pro.expiresAt },
  };
  if (row.checkout_url) view.checkoutUrl = row.checkout_url;
  return { ok: true, order: view };
}

/** Cancel one open order. A paid order cannot be cancelled. */
export async function cancelProOrder(db: Db, reference: string,
  manageToken: string | null): Promise<{ ok: true; cancelled: boolean } | ProFailure> {
  if (!manageToken?.trim()) return { ok: false, error: 'unauthorized', status: 401 };
  const row = await findLedgerOrder(db, reference);
  if (!row) return { ok: false, error: 'not_found', status: 404 };
  if (!(await ownerOwnsDomain(db, row.subject_id, manageToken))) {
    return { ok: false, error: 'unauthorized', status: 401 };
  }
  if (row.status === 'cancelled') return { ok: true, cancelled: true };
  if (row.status === 'confirmed') return { ok: true, cancelled: false };

  const stamp = new Date().toISOString();
  const eventKey = `local:cancel:${row.merchant_order_id}:${Date.now()}`;
  const hash = await sha256Hex(`${eventKey}:${row.merchant_order_id}`);
  const [, changed] = await db.batch([
    {
      sql: `INSERT INTO billing_events
              (merchant_order_id, event_key, source, event_type, payload_sha256, before_status, after_status, created_at)
            VALUES (?, ?, 'local', 'order.cancelled', ?, ?, 'cancelled', ?)`,
      params: [row.merchant_order_id, eventKey, hash, row.status, stamp],
    },
    {
      sql: `UPDATE billing_orders SET status = 'cancelled', updated_at = ?
            WHERE merchant_order_id = ? AND status IN ('creating', 'pending')`,
      params: [stamp, row.merchant_order_id],
    },
  ]);
  return { ok: true, cancelled: Number(changed) > 0 };
}

/** The Pro state of a domain, plus the metadata of its machine key. */
export interface ProStatusView {
  domain: string;
  pro: {
    active: boolean;
    expiresAt: string | null;
    termDays: number;
    source: string | null;
  };
  apiKey: {
    issued: boolean;
    createdAt: string | null;
    lastUsedAt: string | null;
    tier: string;
  } | null;
}

/** The newest live key of a domain (metadata only — never the plaintext). */
async function latestApiKey(db: Db, domain: string): Promise<ProStatusView['apiKey']> {
  try {
    const row = await db
      .prepare(
        `SELECT tier, created_at, last_used_at FROM api_keys
         WHERE domain = ? AND revoked_at IS NULL ORDER BY created_at DESC LIMIT 1`,
      )
      .get<{ tier: string | null; created_at: string | null; last_used_at: string | null }>(domain);
    if (!row) return null;
    return {
      issued: true,
      createdAt: row.created_at ?? null,
      lastUsedAt: row.last_used_at ?? null,
      tier: row.tier ?? 'free',
    };
  } catch {
    // The metadata columns are missing (migration not applied yet).
    const row = await db
      .prepare('SELECT tier, created_at FROM api_keys WHERE domain = ? AND revoked_at IS NULL ORDER BY created_at DESC LIMIT 1')
      .get<{ tier: string | null; created_at: string | null }>(domain);
    if (!row) return null;
    return { issued: true, createdAt: row.created_at ?? null, lastUsedAt: null, tier: row.tier ?? 'free' };
  }
}

/** The Pro status of the owner's domain. */
export async function readProStatus(db: Db, domain: string,
  manageToken: string | null): Promise<{ ok: true; status: ProStatusView } | ProFailure> {
  const requested = normalizeDomain(domain);
  if (!requested) return { ok: false, error: 'invalid_domain', status: 400 };
  if (!manageToken?.trim()) return { ok: false, error: 'unauthorized', status: 401 };
  if (!(await ownerOwnsDomain(db, requested, manageToken))) {
    return { ok: false, error: 'unauthorized', status: 401 };
  }
  const subject = (await resolveSiteKey(db, requested)) ?? directoryDomain(requested);
  const pro = await computeProEntitlement(db, subject);
  return {
    ok: true,
    status: {
      domain: subject,
      pro: {
        active: pro.active,
        expiresAt: pro.expiresAt,
        termDays: pro.termDays ?? DEFAULT_PRO_TERM_DAYS,
        source: pro.sourceOrderId,
      },
      apiKey: await latestApiKey(db, subject),
    },
  };
}

/** The hexadecimal SHA-256 of a text (the digest of a ledger event). */
async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest)).map(byte => byte.toString(16).padStart(2, '0')).join('');
}

/** The plaintext of a new key: `afr_` plus 32 hex characters. */
export function newApiKeyPlaintext(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  const hex = Array.from(bytes).map(byte => byte.toString(16).padStart(2, '0')).join('');
  return `afr_${hex}`;
}

/**
 * Issue (or rotate) the machine key of a domain.
 *
 * A new key replaces the previous one: the old key is revoked in the same
 * transaction, so a domain never has two live keys. The plaintext is
 * returned once and never stored.
 */
export async function issueApiKey(db: Db, domain: string,
  manageToken: string | null): Promise<{ ok: true; key: string; tier: string; createdAt: string } | ProFailure> {
  const requested = normalizeDomain(domain);
  if (!requested) return { ok: false, error: 'invalid_domain', status: 400 };
  if (!manageToken?.trim()) return { ok: false, error: 'unauthorized', status: 401 };
  if (!(await ownerOwnsDomain(db, requested, manageToken))) {
    return { ok: false, error: 'unauthorized', status: 401 };
  }
  const subject = (await resolveSiteKey(db, requested)) ?? directoryDomain(requested);
  const pro = await computeProEntitlement(db, subject);
  const tier = pro.active ? 'pro' : 'free';
  const plaintext = newApiKeyPlaintext();
  const keyHash = await hashApiKey(plaintext);
  const createdAt = new Date().toISOString();
  try {
    await db.batch([
      {
        sql: `UPDATE api_keys SET revoked_at = ? WHERE domain = ? AND revoked_at IS NULL`,
        params: [createdAt, subject],
      },
      {
        sql: `INSERT INTO api_keys (key_hash, domain, tier, created_at, revoked_at, last_used_at)
              VALUES (?, ?, ?, ?, NULL, NULL)`,
        params: [keyHash, subject, tier, createdAt],
      },
    ]);
  } catch {
    return { ok: false, error: 'api_keys_unavailable', status: 503 };
  }
  return { ok: true, key: plaintext, tier, createdAt };
}

/** Revoke the machine key of a domain. */
export async function revokeApiKeys(db: Db, domain: string,
  manageToken: string | null): Promise<{ ok: true; revoked: true } | ProFailure> {
  const requested = normalizeDomain(domain);
  if (!requested) return { ok: false, error: 'invalid_domain', status: 400 };
  if (!manageToken?.trim()) return { ok: false, error: 'unauthorized', status: 401 };
  if (!(await ownerOwnsDomain(db, requested, manageToken))) {
    return { ok: false, error: 'unauthorized', status: 401 };
  }
  const subject = (await resolveSiteKey(db, requested)) ?? directoryDomain(requested);
  const stamp = new Date().toISOString();
  try {
    await db.prepare('UPDATE api_keys SET revoked_at = ? WHERE domain = ? AND revoked_at IS NULL')
      .run(stamp, subject);
  } catch {
    return { ok: false, error: 'api_keys_unavailable', status: 503 };
  }
  return { ok: true, revoked: true };
}

/**
 * Grant Pro for a webhook-confirmed order.
 *
 * The webhook body is the *signed* event AIPAY delivered; the grant itself
 * is still derived from the local ledger (the order row must say
 * `confirmed`), never from the body. A replayed webhook finds the grant
 * event already there and cannot extend the term twice.
 */
export async function grantProForWebhook(db: Db, raw: Uint8Array): Promise<boolean> {
  try {
    const body = JSON.parse(new TextDecoder().decode(raw)) as { order?: { merchantOrderId?: unknown } };
    const merchantOrderId = body?.order?.merchantOrderId;
    if (typeof merchantOrderId !== 'string' || !merchantOrderId) return false;
    const row = await db
      .prepare('SELECT status FROM billing_orders WHERE merchant_order_id = ?')
      .get<{ status: string }>(merchantOrderId);
    if (row?.status !== 'confirmed') return false;
    return syncEntitlementFromBilling(db, merchantOrderId);
  } catch {
    // A grant that cannot be written is picked up by the daily sweep.
    return false;
  }
}

/**
 * Grant Pro for every confirmed order that has no grant event yet.
 *
 * The webhook is the normal path; this sweep is the safety net for an order
 * that AIPAY confirmed while the local ledger did not know it yet (the
 * webhook was ignored, the reconcile cron found it later).
 */
export async function grantProForConfirmedOrders(db: Db, limit = 20): Promise<number> {
  const rows = await db
    .prepare(
      `SELECT o.merchant_order_id FROM billing_orders o
       WHERE o.purpose = 'pro' AND o.status = 'confirmed'
         AND NOT EXISTS (SELECT 1 FROM pro_entitlement_events e
                         WHERE e.source_merchant_order_id = o.merchant_order_id)
       ORDER BY o.updated_at DESC LIMIT ?`,
    )
    .all<{ merchant_order_id: string }>(limit);
  let granted = 0;
  for (const row of rows) {
    if (await syncEntitlementFromBilling(db, row.merchant_order_id)) granted += 1;
  }
  return granted;
}
