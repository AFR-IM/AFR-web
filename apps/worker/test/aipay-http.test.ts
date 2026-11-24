import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { test, type TestContext } from 'node:test';
import { createApp } from '../src/index.ts';
import { openSeededDb } from './helpers.ts';

const endpoint = 'https://afr.im/api/v1/_aipay/webhook';
const env = { AIPAY_API_KEY: 'synthetic-api-key', AIPAY_WEBHOOK_SECRET: 'synthetic-webhook-secret' };
const maxBytes = 16_384;
const delivery = 101;
const confirmed = {
  reference: 'ap_synthetic_order', merchantOrderId: 'synthetic-order',
  status: 'confirmed', amount: '12.00', asset: 'USDT', chainKey: 'base',
  confirmedAt: Date.now(), txHash: '0x' + 'a'.repeat(64),
};
const encode = (body: string) => new TextEncoder().encode(body);

function payload(order: object = confirmed, id = delivery) {
  return JSON.stringify({ event: 'order.confirmed', delivery: { id }, order, note: '\u96ea' }, null, 2);
}

function signed(raw: Uint8Array, timestamp = String(Math.floor(Date.now() / 1000))) {
  const signature = createHmac('sha256', env.AIPAY_WEBHOOK_SECRET).update(`${timestamp}.`).update(raw).digest('hex');
  return new Headers({ 'Content-Type': 'application/json', 'X-Aipay-Event': 'order.confirmed',
    'X-Aipay-Delivery': String(delivery), 'X-Aipay-Timestamp': timestamp, 'X-Aipay-Signature': `sha256=${signature}` });
}

function streamRequest(body: ReadableStream<Uint8Array>, headers?: Headers) {
  const init = { method: 'POST', headers, body, duplex: 'half' } as const;
  return new Request(endpoint, init);
}

function post(app: ReturnType<typeof createApp>, body: string, headers?: Headers) {
  const raw = encode(body);
  return app.request(endpoint, { method: 'POST', body: raw, headers: headers ?? signed(raw) }, env);
}

async function assertJson(response: Response, status: number, body: object) {
  assert.equal(response.status, status);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('cloudflare-cdn-cache-control'), 'no-store');
  assert.deepEqual(await response.json(), body);
}

function mockGet(t: TestContext, result: () => Response) {
  return t.mock.method(globalThis, 'fetch', async (url: URL, init: RequestInit) => {
    assert.equal(url.href, `https://api.aipay.im/v1/orders/${confirmed.reference}`);
    assert.equal(init.method, 'GET');
    assert.equal(new Headers(init.headers).get('authorization'), `Bearer ${env.AIPAY_API_KEY}`);
    return result();
  });
}

function fixture(t: TestContext) {
  const { db, raw } = openSeededDb();
  t.after(() => raw.close());
  raw.prepare(`INSERT INTO billing_orders
    (merchant_order_id, purpose, subject_id, amount, asset, chain_key, status, aipay_reference, created_at, updated_at)
    VALUES (?, 'pro', 'example.com', '12', 'USDT', 'base', 'pending', ?, ?, ?)`)
    .run(confirmed.merchantOrderId, confirmed.reference, '2026-01-01', '2026-01-01');
  return {
    app: createApp({ db }),
    order: () => raw.prepare('SELECT status, aipay_confirmed_at, tx_hash FROM billing_orders').get(),
    eventCount: () => raw.prepare('SELECT count(*) AS n FROM billing_events').get()?.n,
  };
}

test('webhook requires both configured credentials before consuming the body', async (t) => {
  const app = createApp();
  const get = mockGet(t, () => assert.fail('unexpected AIPAY request'));
  let reads = 0;
  for (const bindings of [undefined, { AIPAY_API_KEY: env.AIPAY_API_KEY },
    { AIPAY_WEBHOOK_SECRET: env.AIPAY_WEBHOOK_SECRET }, { ...env, AIPAY_API_KEY: ' ' }]) {
    const body = new ReadableStream<Uint8Array>({ pull() { reads++; } }, { highWaterMark: 0 });
    await assertJson(await app.request(streamRequest(body), undefined, bindings), 503, { error: 'webhook_unavailable' });
  }
  assert.equal(reads, 0);
  assert.equal(get.mock.callCount(), 0);
});

test('webhook rejects oversized declared and actual byte lengths', async (t) => {
  const app = createApp();
  const get = mockGet(t, () => assert.fail('unexpected AIPAY request'));
  let reads = 0;
  const declared = new ReadableStream<Uint8Array>({ pull() { reads++; } }, { highWaterMark: 0 });
  await assertJson(await app.request(streamRequest(declared, new Headers({ 'Content-Length': String(maxBytes + 1) })), undefined, env),
    413, { error: 'payload_too_large' });
  assert.equal(reads, 0);

  for (const statedLength of [undefined, '1']) {
    let pulls = 0;
    let cancelled = false;
    const streamed = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls++;
        // Each chunk is within the cap, but together they are one byte over it.
        controller.enqueue(new Uint8Array(pulls === 1 ? maxBytes : 1));
      },
      cancel() { cancelled = true; },
    }, { highWaterMark: 0 });
    const headers = statedLength ? new Headers({ 'Content-Length': statedLength }) : undefined;
    await assertJson(await app.request(streamRequest(streamed, headers), undefined, env), 413, { error: 'payload_too_large' });
    assert.equal(pulls, 2);
    assert.equal(cancelled, true);
  }
  assert.equal(get.mock.callCount(), 0);
});

test('webhook verifies exact streamed bytes at the limit, re-reads the order, and deduplicates', async (t) => {
  const { app, order, eventCount } = fixture(t);
  const get = mockGet(t, () => Response.json({ order: confirmed }));
  const json = payload();
  const body = json + ' '.repeat(maxBytes - encode(json).byteLength);
  const raw = encode(body);
  // Split within a multi-byte character to exercise raw, rather than per-chunk text, handling.
  const marker = encode('\u96ea')[0]!;
  const split = raw.indexOf(marker) + 1;
  assert.ok(split > 0);
  const streamed = new ReadableStream<Uint8Array>({ start(controller) {
    controller.enqueue(raw.subarray(0, split));
    controller.enqueue(raw.subarray(split));
    controller.close();
  } });
  await assertJson(await app.request(streamRequest(streamed, signed(raw)), undefined, env), 200, { ok: true, result: 'applied' });
  await assertJson(await post(app, body), 200, { ok: true, result: 'duplicate' });
  const retry = JSON.stringify({ ...JSON.parse(json), createdAt: Math.floor(Date.now() / 1000),
    delivery: { id: delivery, attempt: 2 } });
  await assertJson(await post(app, retry), 200, { ok: true, result: 'duplicate' });
  assert.equal(get.mock.callCount(), 1);
  assert.equal(order()?.status, 'confirmed');
  assert.equal(order()?.aipay_confirmed_at, new Date(confirmed.confirmedAt).toISOString());
  assert.equal(order()?.tx_hash, confirmed.txHash);
  assert.equal(eventCount(), 1);
});

test('webhook rejects unauthentic and malformed requests without calling AIPAY', async (t) => {
  const { app, order, eventCount } = fixture(t);
  const get = mockGet(t, () => assert.fail('unexpected AIPAY request'));
  const body = payload();
  const headers = signed(encode(body));
  const missingSignature = new Headers(headers);
  missingSignature.delete('X-Aipay-Signature');
  const stale = signed(encode(body), String(Math.floor(Date.now() / 1000) - 600));
  for (const [badBody, badHeaders] of [[body, missingSignature], [body + ' ', headers], [body, stale], ['{']] as const) {
    await assertJson(await post(app, badBody, badHeaders), 400, { error: 'invalid_webhook' });
  }
  await assertJson(await app.request(endpoint, { method: 'POST' }, env), 400, { error: 'invalid_webhook' });
  const broken = new ReadableStream<Uint8Array>({ pull(controller) { controller.error(new Error('private stream failure')); } });
  await assertJson(await app.request(streamRequest(broken, headers), undefined, env), 400, { error: 'invalid_webhook' });
  assert.equal(get.mock.callCount(), 0);
  assert.equal(order()?.status, 'pending');
  assert.equal(eventCount(), 0);
});

test('webhook rejects signed delivery and event-status mismatches without calling AIPAY', async (t) => {
  const { app, order, eventCount } = fixture(t);
  const get = mockGet(t, () => assert.fail('unexpected AIPAY request'));
  await assertJson(await post(app, payload(confirmed, delivery + 1)), 400, { error: 'invalid_webhook' });
  await assertJson(await post(app, payload({ ...confirmed, status: 'expired' })), 400, { error: 'invalid_webhook' });
  assert.equal(get.mock.callCount(), 0);
  assert.equal(order()?.status, 'pending');
  assert.equal(eventCount(), 0);
});

test('webhook ignores unrelated orders and hides upstream failures without writing', async (t) => {
  const { app, order, eventCount } = fixture(t);
  const get = mockGet(t, () => Response.json({ error: { code: 'private_upstream_detail' } }, { status: 502 }));
  await assertJson(await post(app, payload({ ...confirmed, merchantOrderId: 'unrelated-order' })), 202, { ok: true, ignored: true });
  assert.equal(get.mock.callCount(), 0);
  await assertJson(await post(app, payload()), 503, { error: 'webhook_unavailable' });
  assert.equal(get.mock.callCount(), 1);
  assert.equal(order()?.status, 'pending');
  assert.equal(eventCount(), 0);
});

test('webhook does not trust signed confirmation if canonical payment facts are absent or mismatched', async (t) => {
  const { app, order, eventCount } = fixture(t);
  let canonical: object = confirmed;
  const get = mockGet(t, () => Response.json({ order: canonical }));
  for (const patch of [{ confirmedAt: null }, { txHash: null }, { amount: '9.00' }]) {
    canonical = { ...confirmed, ...patch };
    await assertJson(await post(app, payload()), 400, { error: 'invalid_webhook' });
  }
  assert.equal(get.mock.callCount(), 3);
  assert.equal(order()?.status, 'pending');
  assert.equal(eventCount(), 0);
});
