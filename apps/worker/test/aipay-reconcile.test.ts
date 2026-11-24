import assert from 'node:assert/strict';
import { test } from 'node:test';
import { listAipayOrders, reconcileAipayOrders, runAipayReconcileCron, type AipayEnv } from '../src/aipay.ts';
import { syncEntitlementFromBilling } from '../src/entitlements.ts';
import { openSeededDb } from './helpers.ts';

const env: AipayEnv = { AIPAY_API_KEY: 'not-real' };
function scripted(pages: unknown[]) {
  const calls: string[] = [];
  const fetchImpl: typeof fetch = async (url) => { calls.push(String(url)); const next = pages.shift();
    if (next instanceof Error) throw next; return Response.json(next); };
  return { fetchImpl, calls };
}

test('reconciles cursor pages and persists checkpoint only after apply succeeds', async () => {
  const { db } = openSeededDb(); const scriptedApi = scripted([
    { orders: [{ reference: 'ap_2' }], nextPageCursor: 'c1' },
    { orders: [{ reference: 'ap_1' }], nextPageCursor: null },
  ]); const seen: string[] = [];
  const first = await reconcileAipayOrders(db, env, { status: 'confirmed', maxPages: 10 }, async page => {
    seen.push(page.orders[0]!.reference);
  }, scriptedApi.fetchImpl);
  assert.deepEqual(seen, ['ap_2', 'ap_1']); assert.equal(first.cursor, null); assert.equal(first.pages, 2);
  assert.match(scriptedApi.calls[0]!, /status=confirmed/);
  assert.equal((await db.prepare('SELECT cursor FROM billing_reconcile_state').get<{cursor:string|null}>())?.cursor, null);
});

test('resumes saved cursor, isolates filter changes, bounds page size and retains cursor on failed apply', async () => {
  const { db } = openSeededDb(); const seeded = scripted([{ orders: [{ reference: 'ap_saved' }], nextPageCursor: 'c2' }]);
  await reconcileAipayOrders(db, env, { status: 'pending', maxPages: 1 }, async () => {}, seeded.fetchImpl);
  const resumed = scripted([{ orders: [{ reference: 'ap_next' }], nextPageCursor: null }]);
  await reconcileAipayOrders(db, env, { status: 'pending', maxPages: 1, pageSize: 999 }, async page => {
    assert.equal(page.orders[0]!.reference, 'ap_next');
  }, resumed.fetchImpl);
  assert.match(resumed.calls[0]!, /pageCursor=c2/); assert.match(resumed.calls[0]!, /limit=100/);
  const failed = scripted([{ orders: [{ reference: 'ap_fail' }], nextPageCursor: 'c3' }]);
  await assert.rejects(reconcileAipayOrders(db, env, { status: 'pending', maxPages: 1 }, async () => { throw new Error('apply failed'); }, failed.fetchImpl));
  assert.equal((await db.prepare('SELECT cursor FROM billing_reconcile_state').get<{cursor:string|null}>())?.cursor, null);
  const freshFilter = scripted([{ orders: [], nextPageCursor: 'other' }]);
  await reconcileAipayOrders(db, env, { status: 'expired', maxPages: 1 }, async () => {}, freshFilter.fetchImpl);
  assert.doesNotMatch(freshFilter.calls[0]!, /pageCursor=c2/);
});

test('daily backstop is opt-in, resumes an unfiltered page, and never grants Pro', async () => {
  const { db, raw } = openSeededDb();
  const enabled = { ...env, AIPAY_RECONCILE_ENABLED: 'true' };
  const now = Date.now();
  const order = { reference: 'ap_reconcile123', merchantOrderId: 'reconcile-order', status: 'confirmed',
    amount: '12.00', asset: 'USDC', chainKey: 'base', confirmedAt: now, txHash: '0x' + 'a'.repeat(64) };
  raw.prepare(`INSERT INTO billing_orders
    (merchant_order_id,purpose,subject_id,amount,asset,chain_key,status,aipay_reference,created_at,updated_at)
    VALUES (?,'pro','example.com','12','USDC','base','pending',?,'2026-01-01','2026-01-01')`)
    .run(order.merchantOrderId, order.reference);
  const corrected = { ...order, expiresAt: now - 1 };
  const api = scripted([{ orders: [], nextPageCursor: 'checkpoint' },
    new Error('upstream unavailable'),
    { orders: [order], nextPageCursor: null }, { orders: [order], nextPageCursor: null },
    { orders: [corrected], nextPageCursor: null }, { orders: [corrected], nextPageCursor: null }]);
  assert.equal(await runAipayReconcileCron(db, env, api.fetchImpl), 0);
  assert.equal(await runAipayReconcileCron(db, { AIPAY_RECONCILE_ENABLED: 'true' }, api.fetchImpl), 0);
  assert.equal(api.calls.length, 0);
  assert.equal(await runAipayReconcileCron(db, enabled, api.fetchImpl), 1);
  await assert.rejects(runAipayReconcileCron(db, enabled, api.fetchImpl), /upstream unavailable/);
  assert.equal(raw.prepare('SELECT cursor FROM billing_reconcile_state').get()?.cursor, 'checkpoint');
  await runAipayReconcileCron(db, enabled, api.fetchImpl);
  await runAipayReconcileCron(db, enabled, api.fetchImpl);
  assert.equal(new URL(api.calls[1]!).searchParams.get('pageCursor'), 'checkpoint');
  assert.equal(new URL(api.calls[2]!).searchParams.get('pageCursor'), 'checkpoint');
  assert.equal(new URL(api.calls[2]!).searchParams.get('limit'), '10');
  assert.equal(raw.prepare('SELECT status FROM billing_orders').get()?.status, 'confirmed');
  assert.equal(raw.prepare('SELECT count(*) AS n FROM billing_events').get()?.n, 1);
  await runAipayReconcileCron(db, enabled, api.fetchImpl);
  await runAipayReconcileCron(db, enabled, api.fetchImpl);
  assert.equal(raw.prepare('SELECT status FROM billing_orders').get()?.status, 'review');
  assert.equal(raw.prepare('SELECT count(*) AS n FROM billing_events').get()?.n, 2);
  assert.equal(raw.prepare('SELECT count(*) AS n FROM pro_entitlements').get()?.n, 0);
  raw.close();
});

test('holds mismatches and regressed confirmations without blocking the next page', async () => {
  const { db, raw } = openSeededDb();
  const insert = raw.prepare(`INSERT INTO billing_orders
    (merchant_order_id,purpose,subject_id,amount,asset,chain_key,status,aipay_reference,created_at,updated_at)
    VALUES (?,'pro','example.com','12','USDC','base',?,?,'2026-01-01','2026-01-01')`);
  const canonical = { status: 'confirmed', amount: '12', asset: 'USDC', chainKey: 'base',
    confirmedAt: Date.now(), txHash: '0x' + 'b'.repeat(64) };
  const order = (id: string, status = 'pending') => {
    const reference = `ap_ref_${id}_12345`;
    insert.run(id, status, reference);
    return { ...canonical, reference, merchantOrderId: id };
  };
  const mismatch = { ...order('mismatch'), amount: '1' };
  const regressed = { ...order('regressed', 'confirmed'), lastError: 'confirmation_regressed: depth' };
  const statusRollback = { ...order('rollback', 'confirmed'), status: 'pending' };
  const expiredRollback = { ...order('expired-rollback', 'confirmed'), status: 'expired' };
  const cancelledRollback = { ...order('cancelled-rollback', 'confirmed'), status: 'cancelled' };
  const remoteExpiry = { ...order('remote-expiry'), expiresAt: Date.now() - 60_000 };
  const valid = order('valid');
  const api = scripted([{ orders: [mismatch, regressed, statusRollback, expiredRollback, cancelledRollback, remoteExpiry], nextPageCursor: 'next' },
    { orders: [valid], nextPageCursor: null }, { orders: [mismatch, regressed, statusRollback, expiredRollback, cancelledRollback, remoteExpiry], nextPageCursor: null }]);
  const enabled = { ...env, AIPAY_RECONCILE_ENABLED: 'true' };
  for (let i = 0; i < 3; i++) await runAipayReconcileCron(db, enabled, api.fetchImpl);
  assert.match(api.calls[1]!, /pageCursor=next/);
  const status = (id: string) => raw.prepare('SELECT status FROM billing_orders WHERE merchant_order_id=?').get(id)?.status;
  assert.equal(status('mismatch'), 'review');
  for (const id of ['regressed', 'rollback', 'expired-rollback', 'cancelled-rollback', 'remote-expiry']) {
    assert.equal(status(id), 'review', id);
    assert.equal(await syncEntitlementFromBilling(db, id), false, id);
  }
  assert.equal(status('valid'), 'confirmed');
  assert.equal(raw.prepare('SELECT count(*) AS n FROM billing_events').get()?.n, 7);
  raw.close();
});

test('fails closed when AIPAY credentials are absent or API answers an error', async () => {
  await assert.rejects(listAipayOrders({}, {}), /not_configured/);
  const broken = scripted([{ error: { code: 'rate_limited' } }]);
  await assert.rejects(listAipayOrders(env, {}, broken.fetchImpl), /aipay_reconcile_failed/);
});
