import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHmac } from 'node:crypto';
import { applyAipayWebhook, createBillingOrder, verifyAipayWebhook, type AipayEnv } from '../src/aipay.ts';
import { openSeededDb } from './helpers.ts';

const env: AipayEnv = { AIPAY_API_KEY: 'test_secret_not_real', AIPAY_WEBHOOK_SECRET: 'test-hook-secret' };
const order = { reference: 'ap_12345678901234567890', status: 'pending', merchantOrderId: 'afr-pro-example-20261124',
  amount: '12', asset: 'USDC', chainKey: 'base', checkoutUrl: 'https://aipay.im/en/pay?intent=abc', expiresAt: Date.now()+600000 };
function signed(body: string, timestamp = String(Math.floor(Date.now()/1000)), delivery = '42') {
  const signature = 'sha256=' + createHmac('sha256', env.AIPAY_WEBHOOK_SECRET!).update(`${timestamp}.${body}`).digest('hex');
  return new Headers({ 'x-aipay-timestamp': timestamp, 'x-aipay-signature': signature, 'x-aipay-event': 'order.confirmed', 'x-aipay-delivery': delivery });
}

test('persists business ID before order creation and reuses AIPAY idempotency after uncertain errors', async () => {
  const { db } = openSeededDb(); let calls = 0;
  const input = { merchantOrderId: order.merchantOrderId!, purpose: 'pro' as const, subjectId: 'example.com', amount: '12', asset: 'USDC', chainKey: 'base' };
  const fetchImpl: typeof fetch = async (_url, init) => {
    calls++;
    const body = JSON.parse(String(init?.body)); assert.equal(body.merchantOrderId, input.merchantOrderId);
    assert.equal(body.amount, input.amount);
    return Response.json({ order }, { status: 201 });
  };
  const first = await createBillingOrder(db, env, input, fetchImpl);
  const again = await createBillingOrder(db, env, input, fetchImpl);
  assert.equal(first.order.reference, order.reference); assert.equal(again.idempotent, true); assert.equal(calls, 1);
  await assert.rejects(createBillingOrder(db, env, { ...input, amount: '13.00' }, fetchImpl), /conflict/);
});

test('recovers an upstream order that became terminal before the first response was saved', async () => {
  const { db } = openSeededDb();
  const input = { merchantOrderId: 'lost-response-terminal', purpose: 'pro' as const, subjectId: 'owner', amount: '1', asset: 'USDC', chainKey: 'ethereum' };
  await assert.rejects(createBillingOrder(db, env, input, async () => { throw new Error('response lost'); }));
  const confirmed = { ...order, merchantOrderId: input.merchantOrderId, status: 'confirmed', amount: '1', asset: 'USDC',
    chainKey: 'ethereum', confirmedAt: Date.now(), txHash: '0x' + 'c'.repeat(64), expiresAt: Date.now() + 60000 };
  let calls = 0;
  const recovered = await createBillingOrder(db, env, input, async () => {
    calls++;
    return calls === 1
      ? Response.json({ order: confirmed, idempotent: true }, { status: 200 })
      : Response.json({ order: confirmed });
  });
  assert.equal(calls, 2);
  assert.equal(recovered.order.status, 'confirmed');
  const saved = await db.prepare('SELECT aipay_reference,status FROM billing_orders').get<{aipay_reference:string;status:string}>();
  assert.equal(saved?.aipay_reference, confirmed.reference);
  assert.equal(saved?.status, 'confirmed');
});

test('a failed terminal GET remains retryable and a concurrent webhook wins the transition', async t => {
  const { db, raw } = openSeededDb();
  t.after(() => raw.close());
  const input = { merchantOrderId: order.merchantOrderId, purpose: 'pro' as const,
    subjectId: 'owner', amount: order.amount, asset: order.asset, chainKey: order.chainKey };
  const confirmed = { ...order, status: 'confirmed', confirmedAt: Date.now(), txHash: '0x' + 'c'.repeat(64) };
  await assert.rejects(createBillingOrder(db, env, input, async () => { throw new Error('POST response lost'); }), /POST response lost/);
  await assert.rejects(createBillingOrder(db, env, input, async (_url, init) => {
    if (init?.method === 'POST') return Response.json({ order: confirmed, idempotent: true });
    throw new Error('GET unavailable');
  }), /GET unavailable/);
  assert.equal(raw.prepare('SELECT status FROM billing_orders').get()?.status, 'pending');
  const body = JSON.stringify({ event: 'order.confirmed', delivery: { id: 73 }, order: confirmed });
  const methods: (string | undefined)[] = [];
  const replay = await createBillingOrder(db, env, input, async (_url, init) => {
    methods.push(init?.method);
    if (init?.method === 'POST') return Response.json({ order: confirmed, idempotent: true });
    assert.equal(await applyAipayWebhook(db, new TextEncoder().encode(body), signed(body, undefined, '73'),
      env.AIPAY_WEBHOOK_SECRET!, async () => confirmed), 'applied');
    throw new Error('GET failed after webhook committed');
  });
  assert.deepEqual(methods, ['POST', 'GET']);
  assert.equal(replay.order.status, 'confirmed');
  assert.equal(raw.prepare('SELECT status FROM billing_orders').get()?.status, 'confirmed');
  assert.deepEqual(raw.prepare('SELECT source FROM billing_events').all().map(row => row.source), ['webhook']);
});

test('terminal recovery returns the local review status for a late confirmation', async t => {
  const { db, raw } = openSeededDb();
  t.after(() => raw.close());
  const input = { merchantOrderId: order.merchantOrderId, purpose: 'pro' as const,
    subjectId: 'owner', amount: order.amount, asset: order.asset, chainKey: order.chainKey };
  const late = { ...order, status: 'confirmed', confirmedAt: Date.now(), expiresAt: Date.now() - 60_000,
    txHash: '0x' + 'e'.repeat(64) };
  await assert.rejects(createBillingOrder(db, env, input, async () => { throw new Error('POST response lost'); }), /POST response lost/);
  const recovered = await createBillingOrder(db, env, input, async () => Response.json({ order: late, idempotent: true }));
  assert.equal(recovered.order.status, 'review');
  const repeated = await createBillingOrder(db, env, input, async () => assert.fail('unexpected AIPAY request'));
  assert.equal(repeated.order.status, 'review');
});

test('keeps uncertain create failures recoverable by stable retry ID', async () => {
  const { db } = openSeededDb();
  const input = { merchantOrderId: 'order-lost-response', purpose: 'api' as const, subjectId: 'owner', amount: '1.5', asset: 'USDC', chainKey: 'ethereum' };
  await assert.rejects(createBillingOrder(db, env, input, async () => { throw new Error('lost response'); }));
  const row = await db.prepare('SELECT status,merchant_order_id FROM billing_orders').get<{status:string;merchant_order_id:string}>();
  assert.equal(row?.status, 'creating'); assert.equal(row?.merchant_order_id, input.merchantOrderId);
  await createBillingOrder(db, env, input, async () => Response.json({ order: { ...order, merchantOrderId: input.merchantOrderId, amount: '1.5', asset: 'USDC', chainKey: 'ethereum' } }, { status: 200 }));
  assert.equal((await db.prepare('SELECT status FROM billing_orders').get<{status:string}>())?.status, 'pending');
});

test('verifies raw bytes, event ID and freshness before JSON parsing', async () => {
  const bytes = new TextEncoder().encode('{ "hello" : "world" }'); const body = new TextDecoder().decode(bytes); const timestamp = String(Math.floor(Date.now()/1000));
  assert.ok(await verifyAipayWebhook(bytes, signed(body,timestamp), env.AIPAY_WEBHOOK_SECRET!));
  assert.equal(await verifyAipayWebhook(bytes, new Headers({ 'x-aipay-timestamp': timestamp, 'x-aipay-signature':'sha256='+'0'.repeat(64), 'x-aipay-delivery':'x' }), env.AIPAY_WEBHOOK_SECRET!), null);
  assert.equal(await verifyAipayWebhook(bytes, signed(body, String(Number(timestamp)-301)), env.AIPAY_WEBHOOK_SECRET!), null);
  const wrong = new TextEncoder().encode(body.replaceAll(' ','')); assert.equal(await verifyAipayWebhook(wrong, signed(body,timestamp), env.AIPAY_WEBHOOK_SECRET!), null);
});

test('applies only canonical AIPAY-re-read confirmation and deduplicates signed delivery', async () => {
  const { db } = openSeededDb();
  await db.prepare(`INSERT INTO billing_orders (merchant_order_id,purpose,subject_id,amount,asset,chain_key,status,aipay_reference,checkout_url,created_at,updated_at)
    VALUES (?,?,?,?,?,?,'pending',?,?,?,?)`).run(order.merchantOrderId!,'pro','example.com','12.00','USDC','base',order.reference,order.checkoutUrl,new Date().toISOString(),new Date().toISOString());
  const confirmed = { ...order, status:'confirmed', confirmedAt:Date.now(), txHash:'0x'+'a'.repeat(64) };
  const body=JSON.stringify({event:'order.confirmed',delivery:{id:44},order:confirmed}); const headers=signed(body,undefined,'44');
  let rereads=0; const reread=async (reference:string) => { rereads++; assert.equal(reference,order.reference); return confirmed; };
  assert.equal(await applyAipayWebhook(db,new TextEncoder().encode(body),headers,env.AIPAY_WEBHOOK_SECRET!,reread),'applied');
  assert.equal(await applyAipayWebhook(db,new TextEncoder().encode(body),headers,env.AIPAY_WEBHOOK_SECRET!,reread),'duplicate');
  const retried = JSON.parse(body) as { event: string; delivery: { id: number; attempt?: number }; order: object };
  retried.delivery.attempt = 2;
  const changed = { ...(retried.order as object), amount: '99' };
  retried.order = changed;
  const changedBody = JSON.stringify(retried);
  const retryHeaders = signed(changedBody, undefined, '44');
  assert.equal(await applyAipayWebhook(db,new TextEncoder().encode(changedBody),retryHeaders,env.AIPAY_WEBHOOK_SECRET!,reread),'invalid');
  assert.equal(rereads,1);
  assert.equal((await db.prepare('SELECT status FROM billing_orders').get<{status:string}>())?.status,'confirmed');
  assert.equal((await db.prepare('SELECT count(*) AS n FROM billing_events').get<{n:number}>())?.n,1);
  assert.equal((await db.prepare('SELECT before_status,after_status FROM billing_events').get<{before_status:string;after_status:string}>())?.after_status, 'confirmed');
});

test('concurrent distinct confirmation deliveries produce one transition and one ignored result', async () => {
  const { db, raw } = openSeededDb();
  await db.prepare(`INSERT INTO billing_orders (merchant_order_id,purpose,subject_id,amount,asset,chain_key,status,aipay_reference,checkout_url,created_at,updated_at)
    VALUES (?,?,?,?,?,?,'pending',?,?,?,?)`).run(order.merchantOrderId!,'pro','example.com','12.00','USDC','base',order.reference,order.checkoutUrl,new Date().toISOString(),new Date().toISOString());
  const confirmed = { ...order, status:'confirmed', confirmedAt:Date.now(), txHash:'0x'+'d'.repeat(64) };
  const makeDelivery = (id: number) => {
    const body = JSON.stringify({event:'order.confirmed',delivery:{id},order:confirmed});
    return { raw: new TextEncoder().encode(body), headers: signed(body, undefined, String(id)) };
  };
  const first = makeDelivery(71);
  const second = makeDelivery(72);
  let reads = 0;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const verifyOrder = async () => {
    if (++reads === 2) release();
    await gate;
    return confirmed;
  };
  const results = await Promise.all([
    applyAipayWebhook(db, first.raw, first.headers, env.AIPAY_WEBHOOK_SECRET!, verifyOrder),
    applyAipayWebhook(db, second.raw, second.headers, env.AIPAY_WEBHOOK_SECRET!, verifyOrder),
  ]);
  assert.deepEqual([...results].sort(), ['applied','ignored']);
  assert.equal(raw.prepare('SELECT status FROM billing_orders').get()?.status, 'confirmed');
  assert.equal(raw.prepare('SELECT count(*) AS n FROM billing_events').get()?.n, 1);
  raw.close();
});

test('ignores unrelated refs, refuses unsigned or mismatched merchant orders', async () => {
  const { db } = openSeededDb();
  await db.prepare(`INSERT INTO billing_orders (merchant_order_id,purpose,subject_id,amount,asset,chain_key,status,aipay_reference,created_at,updated_at)
    VALUES (?,?,?,?,?,?,'pending',?,?,?)`).run(order.merchantOrderId!,'pro','example.com','12.00','USDC','base',order.reference,new Date().toISOString(),new Date().toISOString());
  const body=JSON.stringify({event:'order.confirmed',delivery:{id:42},order:{...order,status:'confirmed'}});
  const noSecret={ ...env, AIPAY_WEBHOOK_SECRET: '' };
  assert.equal(await applyAipayWebhook(db,new TextEncoder().encode(body),signed(body),noSecret.AIPAY_WEBHOOK_SECRET!,async()=>order),'invalid');
  assert.equal(await applyAipayWebhook(db,new TextEncoder().encode(body),signed(body),env.AIPAY_WEBHOOK_SECRET!,async()=>({...order,merchantOrderId:'another-order'})),'invalid');
  const altered=JSON.stringify({event:'order.confirmed',delivery:{id:42},order:{...order,reference:'ap_00000000000000000000',status:'confirmed'}});
  assert.equal(await applyAipayWebhook(db,new TextEncoder().encode(altered),signed(altered),env.AIPAY_WEBHOOK_SECRET!,async()=>order),'ignored');
  assert.equal((await db.prepare('SELECT status FROM billing_orders').get<{status:string}>())?.status,'pending');
});
