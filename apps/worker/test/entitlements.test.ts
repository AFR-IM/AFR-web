import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { applyAipayWebhook, type AipayOrderResponse } from '../src/aipay.ts';
import { createSqliteDb, type Db } from '../src/db.ts';
import { hasProEntitlement, syncEntitlementFromBilling } from '../src/entitlements.ts';
import { openSeededDb } from './helpers.ts';

const CREATED = '2026-11-24T00:00:00.000Z';
const CHECKOUT = 'https://aipay.im/en/pay?intent=test';
const REFERENCE = 'ap_12345678901234567890';

async function insertOrder(db: Db, orderId: string, subjectId: string, status: string, purpose = 'pro') {
  await db.prepare(`INSERT INTO billing_orders
    (merchant_order_id, subject_id, status, purpose, amount, asset, chain_key, checkout_url, created_at, updated_at)
    VALUES (?, ?, ?, ?, '12', 'USDT', 'base', ?, ?, ?)`)
    .run(orderId, subjectId, status, purpose, CHECKOUT, CREATED, CREATED);
}

test('only a confirmed local Pro order qualifies, even when other orders have checkout URLs', async (t) => {
  const { db, raw } = openSeededDb();
  t.after(() => raw.close());

  assert.equal(await syncEntitlementFromBilling(db, 'missing-order'), false);
  for (const status of ['creating', 'pending', 'expired', 'cancelled', 'review']) {
    await insertOrder(db, `order-${status}`, 'example.com', status);
    assert.equal(await syncEntitlementFromBilling(db, `order-${status}`), false, status);
  }
  for (const purpose of ['api', 'ad', 'torch', 'promo']) {
    await insertOrder(db, `order-${purpose}`, 'example.com', 'confirmed', purpose);
    assert.equal(await syncEntitlementFromBilling(db, `order-${purpose}`), false, purpose);
  }
  assert.equal(await syncEntitlementFromBilling(db, CHECKOUT), false);
  assert.equal(await hasProEntitlement(db, 'example.com'), false);

  await db.prepare("UPDATE billing_orders SET status = 'confirmed' WHERE merchant_order_id = ?").run('order-pending');
  assert.equal(await hasProEntitlement(db, 'example.com'), false, 'ledger confirmation is not an access check');
  assert.equal(await syncEntitlementFromBilling(db, 'order-pending'), true);
  assert.equal(await hasProEntitlement(db, 'example.com'), true);
  assert.equal(await hasProEntitlement(db, 'coolsite.io'), false);
});

test('a verified AIPAY webhook can confirm a ledger order but does not write a grant', async (t) => {
  const { db, raw } = openSeededDb();
  t.after(() => raw.close());
  const merchantOrderId = 'order-webhook';
  const now = Date.parse(CREATED);
  const secret = 'test-hook-secret';
  await insertOrder(db, merchantOrderId, 'example.com', 'pending');
  await db.prepare('UPDATE billing_orders SET aipay_reference = ? WHERE merchant_order_id = ?').run(REFERENCE, merchantOrderId);
  const order: AipayOrderResponse = {
    reference: REFERENCE, merchantOrderId, status: 'confirmed', amount: '12', asset: 'USDT', chainKey: 'base',
    checkoutUrl: CHECKOUT, confirmedAt: now, txHash: '0x' + 'a'.repeat(64),
  };
  const event = 'order.confirmed';
  const body = JSON.stringify({ event, delivery: { id: 42 }, order });
  const timestamp = String(now / 1000);
  const headers = new Headers({
    'x-aipay-timestamp': timestamp,
    'x-aipay-signature': 'sha256=' + createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex'),
    'x-aipay-event': event,
    'x-aipay-delivery': '42',
  });
  assert.equal(await applyAipayWebhook(db, new TextEncoder().encode(body), headers, secret, async () => order, now), 'applied');
  assert.equal(await hasProEntitlement(db, 'example.com'), false);
  assert.equal(await syncEntitlementFromBilling(db, merchantOrderId), true);
  assert.equal(await hasProEntitlement(db, 'example.com'), true);
});

test('replay preserves the original grant; ledger rollback, reassignment or deletion does not revoke it', async (t) => {
  const { db, raw } = openSeededDb();
  t.after(() => raw.close());
  const merchantOrderId = 'order-confirmed';
  await insertOrder(db, merchantOrderId, 'example.com', 'confirmed');
  assert.equal(await syncEntitlementFromBilling(db, merchantOrderId), true);
  const grants = db.prepare('SELECT source_merchant_order_id, subject_id, granted_at FROM pro_entitlements');
  const first = await grants.get<{ source_merchant_order_id: string; subject_id: string; granted_at: string }>();
  assert.equal(first?.source_merchant_order_id, merchantOrderId);
  assert.equal(first?.subject_id, 'example.com');
  assert.ok(Number.isFinite(Date.parse(first?.granted_at ?? '')));

  assert.deepEqual(await Promise.all([
    syncEntitlementFromBilling(db, merchantOrderId), syncEntitlementFromBilling(db, merchantOrderId),
  ]), [true, true]);
  assert.deepEqual(await grants.all(), [first]);

  await db.prepare("UPDATE billing_orders SET status = 'review' WHERE merchant_order_id = ?").run(merchantOrderId);
  assert.equal(await syncEntitlementFromBilling(db, merchantOrderId), false);
  assert.equal(await hasProEntitlement(db, 'example.com'), true);

  await db.prepare("UPDATE billing_orders SET status = 'confirmed', subject_id = ? WHERE merchant_order_id = ?")
    .run('coolsite.io', merchantOrderId);
  assert.equal(await syncEntitlementFromBilling(db, merchantOrderId), false);
  assert.equal(await hasProEntitlement(db, 'coolsite.io'), false);

  await db.prepare('DELETE FROM billing_orders WHERE merchant_order_id = ?').run(merchantOrderId);
  assert.equal(await syncEntitlementFromBilling(db, merchantOrderId), false);
  assert.equal(await hasProEntitlement(db, 'example.com'), true);
  assert.deepEqual(await grants.all(), [first]);
});

test('the additive migration is repeatable and does not auto-grant existing orders', async (t) => {
  const raw = new DatabaseSync(':memory:');
  t.after(() => raw.close());
  const migration = (name: string) => readFileSync(new URL(`../migrations/${name}.sql`, import.meta.url), 'utf8');
  raw.exec(migration('aipay-billing'));
  const db = createSqliteDb(raw);
  await insertOrder(db, 'order-existing', 'example.com', 'confirmed');
  raw.exec(migration('pro-entitlements'));
  assert.equal(await hasProEntitlement(db, 'example.com'), false);
  assert.equal(await syncEntitlementFromBilling(db, 'order-existing'), true);
  raw.exec(migration('pro-entitlements'));
  assert.equal(await hasProEntitlement(db, 'example.com'), true);
});
