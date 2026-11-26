import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import {
  clickAd, createAdOrder, expireAds, listActiveAds, moderateAd, readAdOrder, readAdsBoard,
  renderAdsBoard, reportAd, trackAdImpression, type AdDecision, type AdOrder,
} from '../src/ads.ts';
import { hashToken } from '../src/email.ts';
import { openSeededDb } from './helpers.ts';

const migration = readFileSync(new URL('../migrations/ads.sql', import.meta.url), 'utf8');
const now = new Date('2026-11-26T12:30:00.000Z');
const token = 'verified-test-owner';
const env = { ADS_SALES_OPEN: 'true', AIPAY_API_KEY: 'fixture-key' };
const application = (overrides: Record<string, unknown> = {}) => ({
  requestId: crypto.randomUUID(), domain: 'example.com', slot: 'category-top', slot_key: 'dev-tools',
  headline: '面向开发者的工具', body: 'Tools to build and ship software.', ...overrides,
});

async function fixture() {
  const { raw, db } = openSeededDb();
  raw.exec(migration);
  raw.exec(migration);
  const hash = await hashToken(token);
  for (const domain of ['example.com', 'coolsite.io', 'neutral.net', 'closed.org', 'pending.dev']) {
    raw.prepare(`INSERT INTO owner_emails (domain, email_cipher, email_hash, verified_at, manage_token_hash)
      VALUES (?, 'cipher', 'hash', ?, ?)`).run(domain, now.toISOString(), hash);
  }
  const calls: { merchantOrderId: string; amount: string; asset: string; chainKey: string }[] = [];
  const fetchImpl: typeof fetch = async (_url, init) => {
    const order = JSON.parse(String(init?.body)) as typeof calls[number];
    calls.push(order);
    return Response.json({ order: { ...order, status: 'pending', reference: `ap_${order.merchantOrderId}`,
      checkoutUrl: `https://aipay.im/checkout/${order.merchantOrderId}`, expiresAt: +now + 900_000 } });
  };
  const create = (input = application()) => createAdOrder(db, { input, env, manageToken: token, fetchImpl, now });
  const buy = async (input = application()): Promise<AdOrder> => {
    const result = await create(input);
    assert.ok(result.ok, JSON.stringify(result));
    return result.order;
  };
  const settle = (order: AdOrder, status: 'confirmed' | 'expired' | 'cancelled' = 'confirmed') => {
    raw.prepare('UPDATE billing_orders SET status = ?, aipay_confirmed_at = ?, tx_hash = ? WHERE merchant_order_id = ?')
      .run(status, status === 'confirmed' ? now.toISOString() : null, status === 'confirmed' ? 'a'.repeat(64) : null, order.orderId);
    raw.prepare(`INSERT INTO billing_events
      (merchant_order_id, event_key, source, event_type, payload_sha256, before_status, after_status, created_at)
      VALUES (?, ?, 'webhook', ?, 'hash', 'pending', ?, ?)`).run(order.orderId, crypto.randomUUID(), `order.${status}`, status, now.toISOString());
  };
  const decide = (id: number, decision: AdDecision, opts: { startsAt?: string; requestId?: string; now?: Date } = {}) =>
    moderateAd(db, { id, decision, now, requestId: crypto.randomUUID(), subject: 'local:fixture@example.com', note: '审核记录', ...opts });
  return { raw, db, fetchImpl, calls, create, buy, settle, decide };
}

it('leaves ads, billing and network untouched while sales are closed', async () => {
  const { db, raw } = await fixture();
  const result = await createAdOrder(db, { input: application(), manageToken: token, env: {}, now,
    fetchImpl: async () => assert.fail('closed sales must not call AIPAY') });
  assert.deepEqual(result, { ok: false, error: 'ads_sales_closed', status: 403 });
  assert.equal(raw.prepare('SELECT count(*) AS n FROM ad_checkouts').get()?.n, 0);
  assert.equal(raw.prepare('SELECT count(*) AS n FROM billing_orders').get()?.n, 0);
  assert.equal(raw.prepare('SELECT count(*) AS n FROM ads').get()?.n, 4);
});

it('validates ownership, placement, Unicode copy and server-owned price', async () => {
  const { create, buy, calls, db } = await fixture();
  for (const [input, error] of [
    [application({ slot: 'report-sponsor', months: 12 }), 'slot_unavailable'],
    [application({ slot_key: 'bogus' }), 'ineligible_placement'],
    [application({ domain: 'pending.dev' }), 'ineligible_placement'],
    [application({ slot: 'home-supporter' }), 'invalid_slot_key'],
    [application({ slot: 'search-top', slot_key: '　' }), 'invalid_slot_key'],
    [application({ headline: '官方认证' }), 'disallowed_claim'],
    [application({ headline: 'ＯＦＦＩＣＩＡＬ　ＣＥＲＴＩＦＩＥＤ' }), 'disallowed_claim'],
    [application({ headline: '😀'.repeat(41) }), 'invalid_copy'],
  ] as const) {
    const result = await create(input);
    assert.ok(!result.ok);
    assert.equal(result.error, error);
  }
  const unauthorized = await createAdOrder(db, { input: application(), env, manageToken: 'wrong', now,
    fetchImpl: async () => assert.fail('unauthorized order called AIPAY') });
  assert.deepEqual(unauthorized, { ok: false, status: 401, error: 'unauthorized' });
  assert.equal(calls.length, 0);
  const order = await buy(application({ headline: '😀'.repeat(40), months: 2, amount: '1', asset: 'USD', termDays: 1 }));
  assert.equal(order.amount, '98');
  assert.equal(order.termDays, 60);
  assert.deepEqual([calls[0]?.amount, calls[0]?.asset, calls[0]?.chainKey], ['98', 'USDC', 'base']);
  assert.equal((await readAdOrder(db, order.orderId, 'wrong', now)).ok, false);
});

it('does not adopt a pre-existing ledger order from an unrelated checkout', async () => {
  const { raw, create, calls } = await fixture();
  const input = application();
  raw.prepare(`INSERT INTO billing_orders
    (merchant_order_id, purpose, subject_id, amount, asset, chain_key, term_days, status, created_at, updated_at)
    VALUES (?, 'ad', 'example.com', '49', 'USDC', 'base', 30, 'creating', ?, ?)`)
    .run(`ad-${input.requestId}`, now.toISOString(), now.toISOString());
  assert.deepEqual(await create(input), { ok: false, status: 409, error: 'request_conflict' });
  assert.equal(raw.prepare('SELECT count(*) AS n FROM ad_checkouts').get()?.n, 0);
  assert.equal(calls.length, 0);
});

it('requires a matching verified ledger and moderation; rejects legacy and altered records', async () => {
  const { db, raw, buy, settle, decide } = await fixture();
  const order = await buy();
  assert.deepEqual(await listActiveAds(db, { now }), []);
  assert.equal(await clickAd(db, 1, now), null);
  assert.equal((await decide(order.adId, 'approve')).result, 'conflict');
  raw.prepare("UPDATE billing_orders SET status = 'confirmed', aipay_confirmed_at = ?, tx_hash = 'forged'").run(now.toISOString());
  assert.equal((await decide(order.adId, 'approve')).result, 'conflict');
  settle(order);
  for (const [column, invalid, correct] of [
    ['purpose', 'pro', 'ad'], ['subject_id', 'coolsite.io', 'example.com'], ['amount', '1', '49'],
    ['asset', 'ETH', 'USDC'], ['chain_key', 'ethereum', 'base'], ['term_days', 60, 30],
  ] as const) {
    raw.prepare(`UPDATE billing_orders SET ${column} = ?`).run(invalid);
    assert.equal((await decide(order.adId, 'approve')).result, 'conflict', column);
    raw.prepare(`UPDATE billing_orders SET ${column} = ?`).run(correct);
  }
  assert.deepEqual(await listActiveAds(db, { now }), []);
  assert.equal((await decide(order.adId, 'approve')).result, 'applied');
  const [ad] = await listActiveAds(db, { now });
  assert.equal(ad?.grade, 'A');
  assert.equal(ad?.score, 92);
  assert.ok(!JSON.stringify(ad).includes('checkout'));
  raw.prepare("UPDATE sites SET grade = 'F', score_total = 10 WHERE domain = 'example.com'").run();
  assert.equal((await listActiveAds(db, { now }))[0]?.grade, 'F');
  raw.prepare("UPDATE sites SET score_total = NULL WHERE domain = 'example.com'").run();
  assert.equal((await listActiveAds(db, { now })).length, 0);
  raw.prepare("UPDATE sites SET score_total = 10 WHERE domain = 'example.com'").run();
  raw.prepare("UPDATE sites SET status = 'delisted' WHERE domain = 'example.com'").run();
  assert.equal(await clickAd(db, order.adId, now), null);
  raw.prepare("UPDATE sites SET status = 'active' WHERE domain = 'example.com'").run();
  raw.prepare("UPDATE ads SET headline = 'Replaced after approval' WHERE id = ?").run(order.adId);
  assert.deepEqual(await listActiveAds(db, { now }), []);
});

it('keeps capacity on ambiguous or locally expired orders and reuses the same merchant id', async () => {
  const { db, raw, create, fetchImpl, calls, settle } = await fixture();
  const input = application({ slot: 'search-top', slot_key: 'ＡＩ 工具' });
  const failed = await createAdOrder(db, { input, env, manageToken: token, now, fetchImpl: async (_url, init) => {
    assert.equal(JSON.parse(String(init?.body)).merchantOrderId, `ad-${input.requestId}`);
    assert.equal(raw.prepare('SELECT count(*) AS n FROM billing_orders').get()?.n, 1);
    assert.equal(raw.prepare('SELECT count(*) AS n FROM ad_checkouts').get()?.n, 1);
    throw new Error('response lost');
  } });
  assert.deepEqual(failed, { ok: false, status: 502, error: 'billing_unavailable' });
  const sameSeat = application({ domain: 'neutral.net', slot: 'search-top', slot_key: ' ai 工具 ' });
  assert.deepEqual(await create(sameSeat), { ok: false, status: 409, error: 'slot_full' });
  assert.deepEqual(await create({ ...input, headline: 'Different copy' }), { ok: false, status: 409, error: 'request_conflict' });
  const retry = await createAdOrder(db, { input, env, manageToken: token, now, fetchImpl });
  assert.ok(retry.ok);
  assert.equal(retry.order.orderId, `ad-${input.requestId}`);
  assert.equal(calls.length, 1);
  assert.ok((await create(input)).ok);
  assert.equal(calls.length, 1);
  raw.prepare("UPDATE billing_orders SET expires_at = '2020-01-01T00:00:00.000Z'").run();
  assert.deepEqual(await create(sameSeat), { ok: false, status: 409, error: 'slot_full' });
  raw.prepare("UPDATE billing_orders SET status = 'expired'").run();
  assert.deepEqual(await create(sameSeat), { ok: false, status: 409, error: 'slot_full' });
  settle(retry.order, 'expired');
  assert.ok((await create(sameSeat)).ok);
});

it('uses exact case-folded search scopes and rotates the three available category seats', async () => {
  const { db, create, buy, settle, decide } = await fixture();
  const keyword = await buy(application({ slot: 'search-top', slot_key: '　Straẞe　' }));
  settle(keyword);
  assert.equal((await decide(keyword.adId, 'approve')).result, 'applied');
  assert.equal((await listActiveAds(db, { slot: 'search-top', key: 'ＳＴＲＡＳＳＥ', now }))[0]?.id, keyword.adId);
  assert.deepEqual(await listActiveAds(db, { now }), []);
  for (const key of [undefined, 'strass', 'strasse tool', 'xstrasse']) {
    assert.deepEqual(await listActiveAds(db, { slot: 'search-top', key, now }), []);
  }
  const attempts = await Promise.all(['example.com', 'coolsite.io', 'neutral.net', 'closed.org'].map(domain =>
    create(application({ domain }))));
  const opened = attempts.flatMap(result => result.ok ? [result.order] : []);
  assert.equal(opened.length, 3);
  assert.ok(attempts.some(result => !result.ok && result.error === 'slot_full'));
  for (const order of opened) {
    settle(order);
    assert.equal((await decide(order.adId, 'approve')).result, 'applied');
  }
  const first = await listActiveAds(db, { slot: 'category-top', key: 'dev-tools', now });
  const next = await listActiveAds(db, { slot: 'category-top', key: 'dev-tools', now: new Date(+now + 3_600_000) });
  assert.equal(first.length, 3);
  assert.deepEqual(next.map(ad => ad.id), [first[1]?.id, first[2]?.id, first[0]?.id]);
});

it('audits approval once and serves only inside its UTC schedule while active', async () => {
  const { db, raw, buy, settle, decide } = await fixture();
  const order = await buy();
  settle(order);
  const starts = new Date(+now + 60_000);
  const ends = new Date(+starts + 30 * 86_400_000);
  const requestId = crypto.randomUUID();
  raw.exec(`CREATE TRIGGER block_ad_audit BEFORE INSERT ON admin_audit BEGIN SELECT RAISE(ABORT, 'audit blocked'); END;`);
  await assert.rejects(decide(order.adId, 'approve', { requestId, startsAt: starts.toISOString() }), /audit blocked/);
  assert.equal(raw.prepare('SELECT status FROM ads WHERE id = ?').get(order.adId)?.status, 'pending');
  raw.exec('DROP TRIGGER block_ad_audit');
  const approvals = await Promise.all([
    decide(order.adId, 'approve', { requestId, startsAt: starts.toISOString() }),
    decide(order.adId, 'approve', { requestId, startsAt: starts.toISOString() }),
  ]);
  assert.deepEqual(approvals.map(result => result.result).sort(), ['applied', 'replayed']);
  assert.equal(raw.prepare('SELECT count(*) AS n FROM admin_audit WHERE request_id = ?').get(requestId)?.n, 1);
  const audit = raw.prepare('SELECT * FROM admin_audit WHERE request_id = ?').get(requestId);
  assert.equal(audit?.target, `ad:${order.adId}`);
  assert.ok(String(audit?.after_json).includes(ends.toISOString()));
  assert.ok(!JSON.stringify(audit).includes(order.checkoutUrl!));
  const owner = await readAdOrder(db, order.orderId, token, now);
  assert.ok(owner.ok && owner.order.status === 'scheduled');
  assert.equal(await clickAd(db, order.adId, now), null);
  assert.equal(await clickAd(db, order.adId, starts), 'https://example.com/?ref=afr-sponsor');
  assert.equal((await decide(order.adId, 'pause', { now: starts })).result, 'applied');
  assert.equal(await clickAd(db, order.adId, starts), null);
  assert.equal((await decide(order.adId, 'resume', { now: starts })).result, 'applied');
  assert.equal((await listActiveAds(db, { now: new Date(+ends - 1) })).length, 1);
  assert.equal((await listActiveAds(db, { now: ends })).length, 0);
  assert.equal(await expireAds(db, ends), 1);
  assert.equal((await decide(order.adId, 'resume', { now: ends })).result, 'conflict');
});

it('caps shared impression and click writes, still redirects on counter failure and rejects unsafe domains', async () => {
  const { raw, db, buy, settle, decide } = await fixture();
  const order = await buy();
  settle(order);
  await decide(order.adId, 'approve');
  await trackAdImpression(db, 1, now);
  assert.equal(raw.prepare('SELECT count(*) AS n FROM ad_event_days').get()?.n, 0);
  raw.prepare('INSERT INTO ad_event_days VALUES (?, 1999)').run('2026-11-26');
  await Promise.all([trackAdImpression(db, order.adId, now), trackAdImpression(db, order.adId, now)]);
  assert.equal(await clickAd(db, order.adId, now), 'https://example.com/?ref=afr-sponsor');
  assert.equal(raw.prepare('SELECT events FROM ad_event_days').get()?.events, 2000);
  assert.equal(raw.prepare('SELECT impressions FROM ads WHERE id = ?').get(order.adId)?.impressions, 1);
  assert.equal(raw.prepare('SELECT clicks FROM ads WHERE id = ?').get(order.adId)?.clicks, 0);
  raw.exec(`CREATE TRIGGER block_counter BEFORE INSERT ON ad_event_days BEGIN SELECT RAISE(ABORT, 'counter failure'); END;`);
  assert.equal(await clickAd(db, order.adId, now), 'https://example.com/?ref=afr-sponsor');
  assert.equal(await clickAd(db, Number.NaN, now), null);
  assert.equal(await clickAd(db, 'https://evil.test' as unknown as number, now), null);
  assert.equal(await clickAd({
    ...db, prepare: () => ({
      get: async <T>() => ({ domain: 'example.com@evil.test' }) as T,
      all: async () => assert.fail('unexpected read'), run: async () => assert.fail('unexpected write'),
    }),
  }, order.adId, now), null);
});

it('accepts reports for a known placement within the day limit and escapes dashboard markup', async () => {
  const { raw, db, buy, settle, decide } = await fixture();
  const order = await buy(application({ headline: '<b>广告</b>' }));
  const submit = (id: number, reason = 'misleading', detail = '<img src=x>') => reportAd(db, { id, reason, detail }, now);
  assert.deepEqual(await submit(999999), { ok: false, status: 404, error: 'not_found' });
  // A reader can be looking at a page from before a pause or a term end, and
  // that stale page is exactly when a report matters — a known placement is
  // always reportable.
  assert.deepEqual(await submit(order.adId), { ok: true, status: 201 });
  raw.prepare('DELETE FROM ad_reports').run();
  settle(order);
  const board = await readAdsBoard(db, now);
  assert.match(renderAdsBoard(board, true).toString(), /<form method="post" action="\/admin\/commercial\/ads">/);
  assert.doesNotMatch(renderAdsBoard(board, false).toString(), /<form/);
  assert.equal((await decide(order.adId, 'approve')).result, 'applied');
  assert.equal((await submit(order.adId, 'unknown')).status, 400);
  assert.equal((await submit(order.adId, 'spam', '😀'.repeat(501))).status, 400);
  const insert = raw.prepare(`INSERT INTO ad_reports (ad_id, domain, reason, detail, created_at)
    VALUES (?, 'example.com', 'spam', '', ?)`);
  for (let count = 0; count < 99; count++) insert.run(order.adId, now.toISOString());
  const statuses = await Promise.all([submit(order.adId), submit(order.adId)]);
  assert.deepEqual(statuses.map(result => result.status).sort(), [201, 429]);
  const markup = renderAdsBoard(await readAdsBoard(db, now), true).toString();
  assert.match(markup, /&lt;img src=x&gt;/);
  assert.match(markup, /&lt;b&gt;广告&lt;\/b&gt;/);
  assert.doesNotMatch(markup, /<img src=x>/);
});
