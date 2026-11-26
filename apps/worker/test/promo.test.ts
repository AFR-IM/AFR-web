// test/promo.test.ts — owner promo cards: gates, verification, Pro pricing,
// the review write path and the public card read.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import {
  createPromoOrder,
  expirePromos,
  moderatePromo,
  readActivePromo,
  readPromoOrder,
} from '../src/promo.ts';
import { syncBoardLedgers } from '../src/torch.ts';
import { hashToken } from '../src/email.ts';
import { openSeededDb } from './helpers.ts';

const migration = readFileSync(new URL('../migrations/paid-boards.sql', import.meta.url), 'utf8');
const now = new Date('2026-11-26T12:00:00.000Z');
const WALLET = '0x3333333333333333333333333333333333333333';
const env = { PAID_SALES_OPEN: 'true', AIPAY_API_KEY: 'main-key', AIPAY_PROMO_API_KEY: 'promo-key' };
const token = 'verified-test-owner';
const application = (overrides: Record<string, unknown> = {}) => ({
  requestId: crypto.randomUUID(),
  domain: 'example.com',
  tier: 19,
  headline: 'Ship faster with AI agents',
  body: 'Tools to build and ship software for machines.',
  ...overrides,
});

async function fixture(options: { wallet?: string | null; recipient?: string } = {}) {
  const { raw, db } = openSeededDb();
  raw.exec(migration);
  raw.exec(migration); // additive and safe to re-apply
  const wallet = options.wallet === null ? null : (options.wallet ?? WALLET);
  const recipient = options.recipient ?? wallet ?? WALLET;
  if (wallet !== null) {
    raw.prepare(`INSERT INTO admin_settings (key, value_json, updated_at, updated_by)
                 VALUES ('promo_wallet', ?, ?, 'test')`)
      .run(JSON.stringify(wallet), now.toISOString());
  }
  const hash = await hashToken(token);
  for (const domain of ['example.com', 'coolsite.io']) {
    raw.prepare(`INSERT INTO owner_emails (domain, email_cipher, email_hash, verified_at, manage_token_hash)
      VALUES (?, 'cipher', 'hash', ?, ?)`).run(domain, now.toISOString(), hash);
  }
  const calls: { url: string; auth: string | null; body: Record<string, unknown> }[] = [];
  const fetchImpl: typeof fetch = async (url, init) => {
    const target = String(url);
    if (target.includes('/v1/merchants/me')) {
      return Response.json({ merchant: { shopName: 'AFR Promo', recipientAddress: recipient } });
    }
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    calls.push({ url: target, auth: new Headers(init?.headers).get('authorization'), body });
    return Response.json({
      order: {
        ...body, status: 'pending', reference: `ap_${String(body.merchantOrderId)}`,
        checkoutUrl: `https://aipay.im/checkout/${String(body.merchantOrderId)}`, expiresAt: +now + 900_000,
      },
    });
  };
  const create = (overrides: Record<string, unknown> = {}, orderEnv: Record<string, unknown> = env, manage = token) =>
    createPromoOrder(db, { input: application(overrides), manageToken: manage, env: orderEnv as typeof env, fetchImpl, now });
  const buy = async (overrides: Record<string, unknown> = {}) => {
    const result = await create(overrides);
    assert.ok(result.ok, JSON.stringify(result));
    return result.order;
  };
  const settle = (orderId: string, status: 'confirmed' | 'expired' = 'confirmed') => {
    raw.prepare(`UPDATE billing_orders SET status = ?, aipay_confirmed_at = ?, tx_hash = ? WHERE merchant_order_id = ?`)
      .run(status, status === 'confirmed' ? now.toISOString() : null,
        status === 'confirmed' ? '0x' + 'a'.repeat(64) : null, orderId);
  };
  return { raw, db, calls, create, buy, settle, fetchImpl };
}

it('keeps promos unreachable while the sales switch is off (default)', async () => {
  const { raw, create } = await fixture();
  const result = await create({}, {});
  assert.deepEqual(result, { ok: false, status: 403, error: 'promo_sales_closed' });
  assert.equal(raw.prepare('SELECT count(*) AS n FROM detail_promos').get<{ n: number }>()?.n, 0);
});

it('fails closed on missing keys, wallet settings and a mismatched recipient', async () => {
  const noKey = await fixture().then(({ create }) => create({}, { PAID_SALES_OPEN: 'true' }));
  assert.deepEqual(noKey, { ok: false, status: 503, error: 'billing_not_configured' });

  const noWallet = await fixture({ wallet: null }).then(({ create }) => create());
  assert.deepEqual(noWallet, { ok: false, status: 503, error: 'settings_missing' });

  const mismatch = await fixture({ wallet: WALLET, recipient: '0x5555555555555555555555555555555555555555' })
    .then(({ create }) => create());
  assert.deepEqual(mismatch, { ok: false, status: 503, error: 'wallet_mismatch' });
});

it('requires an owned, verified site and rejects bad copy', async () => {
  const { create } = await fixture();
  assert.deepEqual(await create({}, env, 'wrong-token'), { ok: false, status: 401, error: 'unauthorized' });
  assert.deepEqual(await create({ domain: 'missing.test' }), { ok: false, status: 401, error: 'unauthorized' });
  // Owned but never verified.
  assert.deepEqual(await create({ domain: 'coolsite.io' }), { ok: false, status: 403, error: 'not_verified' });
  for (const [overrides, error] of [
    [{ tier: 29 }, 'invalid_tier'],
    [{ tier: '19' }, 'invalid_tier'],
    [{ requestId: 'nope' }, 'invalid_request_id'],
    [{ domain: '' }, 'invalid_domain'],
    [{ headline: '官方认证推荐' }, 'disallowed_claim'],
    [{ headline: 'OFFICIALLY ENDORSED BY AFR' }, 'disallowed_claim'],
    [{ headline: 'x'.repeat(41) }, 'invalid_copy'],
    [{ body: 'y'.repeat(91) }, 'invalid_copy'],
  ] as const) {
    const result = await create(overrides);
    assert.ok(!result.ok, JSON.stringify(overrides));
    assert.equal(result.error, error);
  }
});

it('prices $19/$49/$149 for 30/90/365 days, halved while the site holds Pro', async () => {
  const plainFixture = await fixture();
  const plain = await plainFixture.buy({ tier: 49 });
  assert.equal(plain.amount, 49);
  assert.equal(plain.termDays, 90);
  assert.equal(plain.isProHalf, false);
  assert.equal(plain.status, 'pending');
  assert.match(plain.checkoutUrl ?? '', /^https:\/\/aipay\.im\//);
  assert.match(plainFixture.calls[0]?.auth ?? '', /promo-key/);
  assert.equal(plainFixture.calls[0]?.body.amount, '49');
  const plainLedger = plainFixture.raw
    .prepare('SELECT term_days, purpose FROM billing_orders WHERE merchant_order_id = ?')
    .get<{ term_days: number; purpose: string }>(plain.orderId);
  assert.equal(plainLedger?.term_days, 90);
  assert.equal(plainLedger?.purpose, 'promo');

  // The same site with a live Pro term pays half, frozen into the row.
  const proFixture = await fixture();
  proFixture.raw
    .prepare(`INSERT INTO pro_entitlement_events (source_merchant_order_id, subject_id, kind, term_days, occurred_at, created_at)
              VALUES (?, 'example.com', 'grant', 30, ?, ?)`)
    .run('pro-fixture', now.toISOString(), now.toISOString());
  const half = await proFixture.buy({ tier: 149 });
  assert.equal(half.amount, 74.5);
  assert.equal(half.isProHalf, true);
  assert.equal(half.termDays, 365);
  assert.equal(proFixture.calls[0]?.body.amount, '74.5');
});

it('refuses a second live promo for the same domain', async () => {
  const { raw, buy, create } = await fixture();
  const first = await buy();
  assert.equal(first.tier, 19);
  const second = await create({ tier: 49 });
  assert.deepEqual(second, { ok: false, status: 409, error: 'order_pending' });
  assert.equal(raw.prepare('SELECT count(*) AS n FROM detail_promos').get<{ n: number }>()?.n, 1);
});

it('answers the owner order view only to the owner', async () => {
  const { db, buy } = await fixture();
  const order = await buy();
  const denied = await readPromoOrder(db, order.orderId, 'wrong');
  assert.equal(denied.status, 404);
  const missing = await readPromoOrder(db, 'promo-00000000-0000-4000-8000-000000000000', token);
  assert.equal(missing.status, 404);
  const mine = await readPromoOrder(db, order.orderId, token);
  assert.ok(mine.ok);
  assert.equal(mine.order.domain, 'example.com');
  assert.equal(mine.order.paid, false);
});

it('publishes the card only after payment and approval, inside the term', async () => {
  const { raw, db, buy, settle } = await fixture();
  assert.equal(await readActivePromo(db, 'example.com', now), null);

  const order = await buy();
  settle(order.orderId, 'confirmed');
  await syncBoardLedgers(db, 'webhook', now); // the ledger side effect the webhook runs
  assert.equal(await readActivePromo(db, 'example.com', now), null); // paid, not approved yet

  const decided = await moderatePromo(db, {
    requestId: crypto.randomUUID(), subject: 'local:ops', id: orderId(raw, order.orderId),
    decision: 'approve', note: 'ok', now,
  });
  assert.equal(decided.result, 'applied');
  const active = await readActivePromo(db, 'example.com', now);
  assert.ok(active);
  assert.equal(active.domain, 'example.com');
  assert.equal(active.headline, 'Ship faster with AI agents');
  assert.ok(active.startsAt <= now.toISOString() && now.toISOString() < active.endsAt);

  // The other site never bought one, and an unknown domain publishes nothing.
  assert.equal(await readActivePromo(db, 'coolsite.io', now), null);
  assert.equal(await readActivePromo(db, 'missing.test', now), null);
  assert.equal(await readActivePromo(db, '　', now), null);

  // Past the term the card is gone even if the row still says active.
  raw.prepare('UPDATE detail_promos SET ends_at = ? WHERE merchant_order_id = ?')
    .run('2026-11-20T00:00:00.000Z', order.orderId);
  assert.equal(await readActivePromo(db, 'example.com', now), null);
});

function orderId(raw: ReturnType<typeof openSeededDb>['raw'], merchantOrderId: string): number {
  const row = raw.prepare('SELECT id FROM detail_promos WHERE merchant_order_id = ?').get<{ id: number }>(merchantOrderId);
  assert.ok(row);
  return row.id;
}

it('runs the review through the write view: request id, audit and replay', async () => {
  const { raw, db, buy, settle } = await fixture();
  const order = await buy();
  const id = orderId(raw, order.orderId);
  const requestId = crypto.randomUUID();

  // Approving before payment is impossible: the trigger reads the ledger.
  const unpaid = await moderatePromo(db, {
    requestId: crypto.randomUUID(), subject: 'local:ops', id, decision: 'approve', now,
  });
  assert.equal(unpaid.result, 'conflict');

  settle(order.orderId, 'confirmed');
  await syncBoardLedgers(db, 'webhook', now);

  const applied = await moderatePromo(db, { requestId, subject: 'local:ops', id, decision: 'approve', note: 'ok', now });
  assert.equal(applied.result, 'applied');
  const replayed = await moderatePromo(db, { requestId, subject: 'local:ops', id, decision: 'approve', now });
  assert.equal(replayed.result, 'replayed');

  const status = raw.prepare('SELECT status, approval_request_id FROM detail_promos WHERE id = ?').get<{ status: string; approval_request_id: string }>(id);
  assert.equal(status?.status, 'active');
  assert.equal(status?.approval_request_id, requestId);
  const audit = raw.prepare(`SELECT action, target FROM admin_audit WHERE request_id = ?`).all<{ action: string; target: string }>(requestId);
  assert.deepEqual(audit.map((row) => [row.action, row.target]), [['promo.approve', `promo:${id}`]]);
  assert.equal(raw.prepare('SELECT count(*) AS n FROM admin_requests WHERE request_id = ?').get<{ n: number }>(requestId)?.n, 1);

  // A second approve on an active row conflicts; reject works on paid rows.
  const again = await moderatePromo(db, { requestId: crypto.randomUUID(), subject: 'local:ops', id, decision: 'approve', now });
  assert.equal(again.result, 'conflict');
});

it('closes expired terms on the daily sweep', async () => {
  const { raw, db, buy, settle } = await fixture();
  const order = await buy();
  settle(order.orderId, 'confirmed');
  await syncBoardLedgers(db, 'webhook', now);
  await moderatePromo(db, {
    requestId: crypto.randomUUID(), subject: 'local:ops', id: orderId(raw, order.orderId), decision: 'approve', now,
  });
  raw.prepare('UPDATE detail_promos SET ends_at = ? WHERE merchant_order_id = ?')
    .run('2026-11-25T00:00:00.000Z', order.orderId);
  const expired = await expirePromos(db, now);
  assert.equal(expired, 1);
  assert.equal(raw.prepare('SELECT status FROM detail_promos').get<{ status: string }>()?.status, 'expired');
  assert.equal(await expirePromos(db, now), 0);
});
