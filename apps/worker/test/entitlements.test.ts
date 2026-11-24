// test/entitlements.test.ts — Pro term / renewal / explicit revocation.
//
// The event log (`pro_entitlement_events`) is the only source of truth: the
// current state of a subject is derived by replaying its events.

import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { applyAipayWebhook, type AipayOrderResponse } from '../src/aipay.ts';
import { createSqliteDb, type Db } from '../src/db.ts';
import {
  computeProEntitlement,
  DEFAULT_PRO_TERM_DAYS,
  hasProEntitlement,
  revokeProEntitlement,
  syncEntitlementFromBilling,
} from '../src/entitlements.ts';
import { openSeededDb } from './helpers.ts';

const CREATED = '2026-11-24T00:00:00.000Z';
const CHECKOUT = 'https://aipay.im/en/pay?intent=test';
const REFERENCE = 'ap_12345678901234567890';
const DAY_MS = 86_400_000;
const ADMIN_REF = 'admin:11111111-2222-4333-8444-555555555555';

async function insertOrder(db: Db, orderId: string, subjectId: string, status: string, purpose = 'pro') {
  await db.prepare(`INSERT INTO billing_orders
    (merchant_order_id, subject_id, status, purpose, amount, asset, chain_key, checkout_url, created_at, updated_at)
    VALUES (?, ?, ?, ?, '12', 'USDT', 'base', ?, ?, ?)`)
    .run(orderId, subjectId, status, purpose, CHECKOUT, CREATED, CREATED);
}

interface EventRow {
  id: number;
  source_merchant_order_id: string;
  subject_id: string;
  kind: string;
  term_days: number | null;
  occurred_at: string;
}

function eventsOf(db: Db, subjectId: string): Promise<EventRow[]> {
  return db.prepare(`SELECT id, source_merchant_order_id, subject_id, kind, term_days, occurred_at
    FROM pro_entitlement_events WHERE subject_id = ? ORDER BY id ASC`).all<EventRow>(subjectId);
}

/** Move an event back in time to simulate an aged term. */
async function backdate(db: Db, orderId: string, occurredAt: string) {
  await db.prepare('UPDATE pro_entitlement_events SET occurred_at = ? WHERE source_merchant_order_id = ?')
    .run(occurredAt, orderId);
}

// --- grant -----------------------------------------------------------------

test('a confirmed local Pro order grants one term of the default length', async (t) => {
  const { db, raw } = openSeededDb();
  t.after(() => raw.close());

  await insertOrder(db, 'order-1', 'example.com', 'confirmed');
  assert.equal(await syncEntitlementFromBilling(db, 'order-1'), true);
  const state = await computeProEntitlement(db, 'example.com');
  assert.equal(state.active, true);
  assert.equal(state.kind, 'grant');
  assert.equal(state.revokedAt, null);
  assert.equal(state.sourceOrderId, 'order-1');
  const granted = Date.parse(state.grantedAt!);
  assert.ok(Number.isFinite(granted));
  assert.equal(state.expiresAt, new Date(granted + DEFAULT_PRO_TERM_DAYS * DAY_MS).toISOString());
  assert.equal(await hasProEntitlement(db, 'example.com'), true);

  // The legacy grant table is not written any more — it is not a source of truth.
  assert.equal(raw.prepare('SELECT count(*) AS n FROM pro_entitlements').get()?.n, 0);
});

test('an expired term is inactive, and the subject stays inactive for other subjects', async (t) => {
  const { db, raw } = openSeededDb();
  t.after(() => raw.close());

  await insertOrder(db, 'order-1', 'example.com', 'confirmed');
  assert.equal(await syncEntitlementFromBilling(db, 'order-1'), true);
  const state = await computeProEntitlement(db, 'example.com');
  const expires = Date.parse(state.expiresAt!);

  assert.equal(await hasProEntitlement(db, 'example.com', expires - 1), true);
  assert.equal(await hasProEntitlement(db, 'example.com', expires), false, 'the term ends at expiresAt');
  assert.equal(await hasProEntitlement(db, 'example.com', expires + 1), false);
  assert.equal((await computeProEntitlement(db, 'example.com', expires + 1)).active, false);
  assert.equal(await hasProEntitlement(db, 'coolsite.io'), false, 'subjects do not share terms');
});

test('a renewal extends the current expiry instead of wasting the remaining time', async (t) => {
  const { db, raw } = openSeededDb();
  t.after(() => raw.close());

  await insertOrder(db, 'order-1', 'example.com', 'confirmed');
  await insertOrder(db, 'order-2', 'example.com', 'confirmed');
  assert.equal(await syncEntitlementFromBilling(db, 'order-1'), true);
  const first = await computeProEntitlement(db, 'example.com');

  assert.equal(await syncEntitlementFromBilling(db, 'order-2'), true);
  const second = await computeProEntitlement(db, 'example.com');
  assert.equal(second.kind, 'renew');
  assert.equal(second.grantedAt, first.grantedAt, 'the term keeps its start');
  assert.equal(second.expiresAt, new Date(Date.parse(first.expiresAt!) + DEFAULT_PRO_TERM_DAYS * DAY_MS).toISOString());
  assert.equal(second.active, true);
});

test('a renewal after the term expired starts a new term', async (t) => {
  const { db, raw } = openSeededDb();
  t.after(() => raw.close());

  await insertOrder(db, 'order-1', 'example.com', 'confirmed');
  assert.equal(await syncEntitlementFromBilling(db, 'order-1'), true);
  await backdate(db, 'order-1', '2024-01-01T00:00:00.000Z');

  const expired = await computeProEntitlement(db, 'example.com');
  assert.equal(expired.active, false);
  assert.equal(expired.expiresAt, new Date(Date.parse('2024-01-01T00:00:00.000Z') + DEFAULT_PRO_TERM_DAYS * DAY_MS).toISOString());

  await insertOrder(db, 'order-2', 'example.com', 'confirmed');
  assert.equal(await syncEntitlementFromBilling(db, 'order-2'), true);
  const renewed = await computeProEntitlement(db, 'example.com');
  assert.equal(renewed.active, true);
  assert.ok(renewed.grantedAt! > expired.grantedAt!, 'a new term starts after the old one');
  assert.ok(renewed.grantedAt! > expired.expiresAt!, 'the expired term is not extended');
  assert.equal(renewed.expiresAt, new Date(Date.parse(renewed.grantedAt!) + DEFAULT_PRO_TERM_DAYS * DAY_MS).toISOString());
});

test('replaying the same order never extends the term twice', async (t) => {
  const { db, raw } = openSeededDb();
  t.after(() => raw.close());

  await insertOrder(db, 'order-1', 'example.com', 'confirmed');
  assert.equal(await syncEntitlementFromBilling(db, 'order-1'), true);
  const first = await computeProEntitlement(db, 'example.com');

  assert.deepEqual(await Promise.all([
    syncEntitlementFromBilling(db, 'order-1'), syncEntitlementFromBilling(db, 'order-1'),
  ]), [true, true]);
  assert.equal(await syncEntitlementFromBilling(db, 'order-1'), true);

  const after = await computeProEntitlement(db, 'example.com');
  assert.equal(after.expiresAt, first.expiresAt, 'the term is unchanged');
  assert.equal(after.grantedAt, first.grantedAt);
  const events = await eventsOf(db, 'example.com');
  assert.equal(events.length, 1);
  assert.equal(events[0]!.kind, 'grant');
  assert.equal(events[0]!.term_days, DEFAULT_PRO_TERM_DAYS);
});

test('the event log holds one event per order and kind', async (t) => {
  const { db, raw } = openSeededDb();
  t.after(() => raw.close());

  await insertOrder(db, 'order-1', 'example.com', 'confirmed');
  await syncEntitlementFromBilling(db, 'order-1');
  assert.throws(() => raw.prepare(`INSERT INTO pro_entitlement_events
      (source_merchant_order_id, subject_id, kind, term_days, occurred_at, created_at)
      VALUES ('order-1', 'example.com', 'grant', 365, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`).run());
  // A different kind for the same order is allowed (a revoke may reuse the order id).
  raw.prepare(`INSERT INTO pro_entitlement_events
      (source_merchant_order_id, subject_id, kind, term_days, occurred_at, created_at)
      VALUES ('order-1', 'example.com', 'revoke', NULL, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`).run();
  assert.equal((await eventsOf(db, 'example.com')).length, 2);
});

// --- revoke ----------------------------------------------------------------

test('an explicit revoke ends the term immediately', async (t) => {
  const { db, raw } = openSeededDb();
  t.after(() => raw.close());

  await insertOrder(db, 'order-1', 'example.com', 'confirmed');
  await syncEntitlementFromBilling(db, 'order-1');
  assert.equal(await hasProEntitlement(db, 'example.com'), true);

  const revokedAt = '2026-12-01T00:00:00.000Z';
  assert.equal(await revokeProEntitlement(db, 'example.com', ADMIN_REF, revokedAt), true);
  const state = await computeProEntitlement(db, 'example.com');
  assert.equal(state.active, false);
  assert.equal(state.revokedAt, revokedAt);
  assert.equal(state.expiresAt, revokedAt, 'the term stops at the revocation');
  assert.equal(state.kind, 'revoke');
  assert.equal(state.sourceOrderId, ADMIN_REF);
  assert.equal(await hasProEntitlement(db, 'example.com'), false);

  // Replaying the same revocation is idempotent.
  assert.equal(await revokeProEntitlement(db, 'example.com', ADMIN_REF, revokedAt), true);
  assert.equal((await eventsOf(db, 'example.com')).filter(e => e.kind === 'revoke').length, 1);
});

test('a revoke can reference the order that paid for the term', async (t) => {
  const { db, raw } = openSeededDb();
  t.after(() => raw.close());

  await insertOrder(db, 'order-1', 'example.com', 'confirmed');
  await syncEntitlementFromBilling(db, 'order-1');
  assert.equal(await revokeProEntitlement(db, 'example.com', 'order-1'), true);
  assert.equal(await hasProEntitlement(db, 'example.com'), false);
});

test('a subject without a grant cannot be revoked', async (t) => {
  const { db, raw } = openSeededDb();
  t.after(() => raw.close());

  assert.equal(await revokeProEntitlement(db, 'example.com', ADMIN_REF), false);
  assert.equal((await eventsOf(db, 'example.com')).length, 0);
  assert.equal(await hasProEntitlement(db, 'example.com'), false);
});

test('a malformed revoke reference is rejected', async (t) => {
  const { db, raw } = openSeededDb();
  t.after(() => raw.close());

  await insertOrder(db, 'order-1', 'example.com', 'confirmed');
  await syncEntitlementFromBilling(db, 'order-1');
  await assert.rejects(() => revokeProEntitlement(db, 'example.com', 'not a reference'), /invalid_pro_revoke_reference/);
  await assert.rejects(() => revokeProEntitlement(db, 'example.com', 'admin:nope'), /invalid_pro_revoke_reference/);
});

test('a grant after a revoke restores Pro with a new term', async (t) => {
  const { db, raw } = openSeededDb();
  t.after(() => raw.close());

  await insertOrder(db, 'order-1', 'example.com', 'confirmed');
  await insertOrder(db, 'order-2', 'example.com', 'confirmed');
  await syncEntitlementFromBilling(db, 'order-1');
  await backdate(db, 'order-1', '2020-01-01T00:00:00.000Z');
  const first = await computeProEntitlement(db, 'example.com');

  assert.equal(await revokeProEntitlement(db, 'example.com', ADMIN_REF, '2026-01-01T00:00:00.000Z'), true);
  assert.equal(await hasProEntitlement(db, 'example.com'), false);

  assert.equal(await syncEntitlementFromBilling(db, 'order-2'), true);
  const restored = await computeProEntitlement(db, 'example.com');
  assert.equal(restored.active, true);
  assert.equal(restored.revokedAt, null, 'the subject is restored');
  assert.ok(restored.grantedAt! > first.grantedAt!, 'a new term starts');
  assert.ok(restored.grantedAt! >= '2026-01-01T00:00:00.000Z', 'the new term starts after the revocation');
  assert.equal(restored.expiresAt, new Date(Date.parse(restored.grantedAt!) + DEFAULT_PRO_TERM_DAYS * DAY_MS).toISOString());
});

test('subjects are independent: revoking one leaves the other active', async (t) => {
  const { db, raw } = openSeededDb();
  t.after(() => raw.close());

  await insertOrder(db, 'order-1', 'example.com', 'confirmed');
  await insertOrder(db, 'order-2', 'coolsite.io', 'confirmed');
  await syncEntitlementFromBilling(db, 'order-1');
  await syncEntitlementFromBilling(db, 'order-2');
  assert.equal(await hasProEntitlement(db, 'example.com'), true);
  assert.equal(await hasProEntitlement(db, 'coolsite.io'), true);

  assert.equal(await revokeProEntitlement(db, 'example.com', ADMIN_REF), true);
  assert.equal(await hasProEntitlement(db, 'example.com'), false);
  assert.equal(await hasProEntitlement(db, 'coolsite.io'), true);
});

// --- ledger boundary -------------------------------------------------------

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
  assert.equal((await eventsOf(db, 'example.com')).length, 0, 'no event for an ineligible order');

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
  assert.equal((await eventsOf(db, 'example.com')).length, 0, 'the webhook grants nothing');
  assert.equal(await syncEntitlementFromBilling(db, merchantOrderId), true);
  assert.equal(await hasProEntitlement(db, 'example.com'), true);
});

test('replay preserves the original grant; ledger rollback, reassignment or deletion does not revoke it', async (t) => {
  const { db, raw } = openSeededDb();
  t.after(() => raw.close());
  const merchantOrderId = 'order-confirmed';
  await insertOrder(db, merchantOrderId, 'example.com', 'confirmed');
  assert.equal(await syncEntitlementFromBilling(db, merchantOrderId), true);
  const events = await eventsOf(db, 'example.com');
  assert.equal(events.length, 1);
  assert.equal(events[0]!.source_merchant_order_id, merchantOrderId);
  assert.equal(events[0]!.subject_id, 'example.com');
  assert.ok(Number.isFinite(Date.parse(events[0]!.occurred_at)));

  assert.deepEqual(await Promise.all([
    syncEntitlementFromBilling(db, merchantOrderId), syncEntitlementFromBilling(db, merchantOrderId),
  ]), [true, true]);
  assert.deepEqual(await eventsOf(db, 'example.com'), events);

  await db.prepare("UPDATE billing_orders SET status = 'review' WHERE merchant_order_id = ?").run(merchantOrderId);
  assert.equal(await syncEntitlementFromBilling(db, merchantOrderId), false);
  assert.equal(await hasProEntitlement(db, 'example.com'), true);

  await db.prepare("UPDATE billing_orders SET status = 'confirmed', subject_id = ? WHERE merchant_order_id = ?")
    .run('coolsite.io', merchantOrderId);
  assert.equal(await syncEntitlementFromBilling(db, merchantOrderId), false);
  assert.equal(await hasProEntitlement(db, 'coolsite.io'), false, 'a reassigned order grants nothing');
  assert.equal(await hasProEntitlement(db, 'example.com'), true);

  await db.prepare('DELETE FROM billing_orders WHERE merchant_order_id = ?').run(merchantOrderId);
  assert.equal(await syncEntitlementFromBilling(db, merchantOrderId), false);
  assert.equal(await hasProEntitlement(db, 'example.com'), true);
  assert.deepEqual(await eventsOf(db, 'example.com'), events);
});

test('the additive migrations are repeatable and do not auto-grant existing orders', async (t) => {
  const raw = new DatabaseSync(':memory:');
  t.after(() => raw.close());
  const migration = (name: string) => readFileSync(new URL(`../migrations/${name}.sql`, import.meta.url), 'utf8');
  raw.exec(migration('aipay-billing'));
  const db = createSqliteDb(raw);
  await insertOrder(db, 'order-existing', 'example.com', 'confirmed');
  raw.exec(migration('pro-subscriptions'));
  assert.equal(await hasProEntitlement(db, 'example.com'), false);
  assert.equal(await syncEntitlementFromBilling(db, 'order-existing'), true);
  raw.exec(migration('pro-subscriptions'));
  raw.exec(migration('pro-entitlements'));
  assert.equal(await hasProEntitlement(db, 'example.com'), true);
  assert.equal((await eventsOf(db, 'example.com')).length, 1);
});
