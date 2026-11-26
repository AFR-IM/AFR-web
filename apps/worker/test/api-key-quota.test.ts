// test/api-key-quota.test.ts — the quota of a machine key.
//
// Covered here:
//   * a request without a key, with an unknown key and with a revoked key is
//     never counted and never blocked;
//   * the daily budget of a free key (100 calls a day);
//   * the monthly budget (3,000 calls a month), including a 31-day month;
//   * the Pro budget (10,000 a day, 300,000 a month) while the site's Pro
//     term is live;
//   * the downgrade: the same key falls back to the free budget when the Pro
//     term of its site ends or is revoked;
//   * the degradation: a database without the counter table counts nothing
//     and blocks nothing;
//   * the UTC day and month buckets.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test, type TestContext } from 'node:test';
import {
  API_KEY_MONTHLY_QUOTA_LIMITS,
  API_KEY_QUOTA_LIMITS,
  apiKeyUsagePeriods,
  enforceApiKeyQuota,
  hashApiKey,
  readDomainApiKeyUsage,
  touchApiKeyUsage,
} from '../src/api-key.ts';
import { openSeededDb } from './helpers.ts';

const MIGRATION_SQL = readFileSync(new URL('../migrations/api-key-quota.sql', import.meta.url), 'utf8');

type Fixture = ReturnType<typeof openSeededDb>;

/** A database with the counter table (the migration applied) or without it. */
function openDb(t: TestContext, migrate = true): Fixture {
  const seeded = openSeededDb();
  t.after(() => seeded.raw.close());
  if (migrate) seeded.raw.exec(MIGRATION_SQL);
  else seeded.raw.exec('DROP TABLE IF EXISTS api_key_usage');
  return seeded;
}

/** Store a key. The plaintext never reaches the database. */
async function insertKey(raw: Fixture['raw'], options: {
  plaintext: string;
  domain: string | null;
  tier?: string;
  revoked?: boolean;
}): Promise<string> {
  const keyHash = await hashApiKey(options.plaintext);
  raw
    .prepare(`INSERT INTO api_keys (key_hash, domain, tier, created_at, revoked_at, last_used_at)
              VALUES (?, ?, ?, '2026-11-01T00:00:00.000Z', ?, NULL)`)
    .run(keyHash, options.domain, options.tier ?? 'free', options.revoked ? '2026-11-02T00:00:00.000Z' : null);
  return keyHash;
}

/** Give a subject a Pro term. */
function grantPro(raw: Fixture['raw'], subject: string, occurredAt: string, termDays = 30, reference?: string): void {
  raw
    .prepare(`INSERT INTO pro_entitlement_events
                (source_merchant_order_id, subject_id, kind, term_days, occurred_at, created_at)
              VALUES (?, ?, 'grant', ?, ?, ?)`)
    .run(reference ?? `pro-${subject}-${occurredAt}`, subject, termDays, occurredAt, occurredAt);
}

/** Revoke a subject's Pro term. */
function revokePro(raw: Fixture['raw'], subject: string, occurredAt: string, reference: string): void {
  raw
    .prepare(`INSERT INTO pro_entitlement_events
                (source_merchant_order_id, subject_id, kind, term_days, occurred_at, created_at)
              VALUES (?, ?, 'revoke', NULL, ?, ?)`)
    .run(reference, subject, occurredAt, occurredAt);
}

/** The counters for one quota bucket. */
function usageRows(raw: Fixture['raw'], bucket: string): { period: string; used: number }[] {
  const rows = raw
    .prepare('SELECT period, used FROM api_key_usage WHERE key_hash = ? ORDER BY period')
    .all(bucket) as { period: string; used: number }[];
  // node:sqlite hands out null-prototype rows: copy them into plain objects.
  return rows.map((row) => ({ period: String(row.period), used: Number(row.used) }));
}

function seedUsage(raw: Fixture['raw'], bucket: string, period: string, used: number): void {
  raw.prepare('INSERT INTO api_key_usage (key_hash, period, used, updated_at) VALUES (?, ?, ?, ?)')
    .run(bucket, period, used, '2026-11-20T00:00:00.000Z');
}

// ---------------------------------------------------------------------------
// A key that may not be counted
// ---------------------------------------------------------------------------

test('a request without a key, with an unknown key and with a revoked key is never counted', async (t) => {
  const { db, raw } = openDb(t);
  const revokedHash = await insertKey(raw, { plaintext: 'afr_revoked', domain: 'example.com', revoked: true });

  const none = await enforceApiKeyQuota(db, undefined, null);
  assert.equal(none.allowed, true);
  assert.equal(none.tier, null);
  assert.equal(none.limit, 0);
  assert.equal(none.monthLimit, 0);
  assert.equal(none.counted, false);
  assert.equal(none.quotaScope, null);

  const unknown = await enforceApiKeyQuota(db, undefined, 'afr_unknown');
  assert.equal(unknown.allowed, true);
  assert.equal(unknown.tier, null);
  assert.equal(unknown.keyHash, null, 'an unknown key resolves to nothing');
  assert.equal(unknown.counted, false);

  const revoked = await enforceApiKeyQuota(db, undefined, 'afr_revoked');
  assert.equal(revoked.allowed, true);
  assert.equal(revoked.keyHash, null, 'a revoked key resolves to nothing');
  assert.equal(revoked.counted, false);

  assert.deepEqual(usageRows(raw, revokedHash), []);
  assert.deepEqual(usageRows(raw, 'domain:example.com'), []);
});

// ---------------------------------------------------------------------------
// The daily budget
// ---------------------------------------------------------------------------

test('the free budget of a key is 100 calls a day', async (t) => {
  const { db, raw } = openDb(t);
  await insertKey(raw, { plaintext: 'afr_free', domain: 'example.com', tier: 'free' });
  const now = Date.parse('2026-11-20T12:00:00.000Z');

  for (let call = 1; call <= API_KEY_QUOTA_LIMITS.free; call++) {
    const decision = await enforceApiKeyQuota(db, undefined, 'afr_free', now);
    assert.equal(decision.allowed, true, `call ${call} is within the daily budget`);
    assert.equal(decision.tier, 'free');
    assert.equal(decision.limit, API_KEY_QUOTA_LIMITS.free);
    assert.equal(decision.monthLimit, API_KEY_MONTHLY_QUOTA_LIMITS.free);
    assert.equal(decision.used, call);
    assert.equal(decision.counted, true);
    assert.equal(decision.exhausted, null);
  }

  const over = await enforceApiKeyQuota(db, undefined, 'afr_free', now);
  assert.equal(over.allowed, false, 'the 101st call of the day is rejected');
  assert.equal(over.limit, API_KEY_QUOTA_LIMITS.free);
  assert.equal(over.used, API_KEY_QUOTA_LIMITS.free);
  assert.equal(over.monthUsed, API_KEY_QUOTA_LIMITS.free);
  assert.equal(over.counted, false);
  assert.equal(over.exhausted, 'daily');
  assert.deepEqual(await readDomainApiKeyUsage(db, 'example.com', now), { day: 100, month: 100 });
});

// ---------------------------------------------------------------------------
// The monthly budget
// ---------------------------------------------------------------------------

test('a key is rejected when the month is used up, even with a free day', async (t) => {
  const { db, raw } = openDb(t);
  await insertKey(raw, { plaintext: 'afr_month', domain: 'example.com', tier: 'free' });
  const now = Date.parse('2026-11-20T12:00:00.000Z');
  const periods = apiKeyUsagePeriods(now);

  // The month is used up, the day is not.
  seedUsage(raw, 'domain:example.com', periods.month, API_KEY_MONTHLY_QUOTA_LIMITS.free);

  const decision = await enforceApiKeyQuota(db, undefined, 'afr_month', now);
  assert.equal(decision.allowed, false);
  assert.equal(decision.exhausted, 'monthly');
  assert.equal(decision.monthUsed, API_KEY_MONTHLY_QUOTA_LIMITS.free);
  assert.equal(decision.monthLimit, API_KEY_MONTHLY_QUOTA_LIMITS.free);
  assert.equal(decision.used, 0);
  assert.equal(decision.limit, API_KEY_QUOTA_LIMITS.free);
  assert.equal(decision.counted, false);
  assert.deepEqual(usageRows(raw, 'domain:example.com'), [
    { period: periods.month, used: API_KEY_MONTHLY_QUOTA_LIMITS.free },
  ]);
});

for (const exhausted of ['daily', 'monthly'] as const) {
  test(`concurrent requests share the last ${exhausted} slot`, async (t) => {
    const { db, raw } = openDb(t);
    const bucket = 'domain:example.com';
    await insertKey(raw, { plaintext: 'afr_concurrent', domain: 'example.com' });
    const now = '2026-11-20T12:00:00.000Z';
    const { day, month } = apiKeyUsagePeriods(now);
    const startingDay = exhausted === 'daily' ? API_KEY_QUOTA_LIMITS.free - 1 : 5;
    const startingMonth = exhausted === 'monthly' ? API_KEY_MONTHLY_QUOTA_LIMITS.free - 1 : 500;
    seedUsage(raw, bucket, day, startingDay);
    seedUsage(raw, bucket, month, startingMonth);
    const changesBefore = raw.prepare('SELECT total_changes() AS count').get()?.count;

    const decisions = await Promise.all(Array.from({ length: 16 }, () =>
      enforceApiKeyQuota(db, undefined, 'afr_concurrent', now)));

    assert.equal(decisions.filter((d) => d.allowed && d.counted).length, 1);
    assert.equal(decisions.filter((d) => !d.allowed && !d.counted && d.exhausted === exhausted).length, 15);
    assert.deepEqual(usageRows(raw, bucket), [
      { period: day, used: startingDay + 1 },
      { period: month, used: startingMonth + 1 },
    ]);
    assert.equal(raw.prepare('SELECT total_changes() AS count').get()?.count, Number(changesBefore) + 2);
  });
}

// ---------------------------------------------------------------------------
// The Pro budget
// ---------------------------------------------------------------------------

test('a key of a site with a live Pro term gets the Pro budget', async (t) => {
  const { db, raw } = openDb(t);
  await insertKey(raw, { plaintext: 'afr_pro', domain: 'example.com', tier: 'pro' });
  grantPro(raw, 'example.com', '2026-11-01T00:00:00.000Z', 30);
  const now = Date.parse('2026-11-20T12:00:00.000Z');

  const decision = await enforceApiKeyQuota(db, undefined, 'afr_pro', now);
  assert.equal(decision.tier, 'pro');
  assert.equal(decision.limit, API_KEY_QUOTA_LIMITS.pro);
  assert.equal(decision.monthLimit, API_KEY_MONTHLY_QUOTA_LIMITS.pro);
  assert.equal(decision.issuedTier, 'pro');
  assert.equal(decision.allowed, true);

  // The free budget of 100 calls a day does not apply to a Pro key.
  for (let call = 1; call <= API_KEY_QUOTA_LIMITS.free + 1; call++) {
    const call2 = await enforceApiKeyQuota(db, undefined, 'afr_pro', now);
    assert.equal(call2.allowed, true, `call ${call} is within the Pro budget`);
    assert.equal(call2.tier, 'pro');
  }
});

test('the Pro budget is not shared with another site', async (t) => {
  const { db, raw } = openDb(t);
  await insertKey(raw, { plaintext: 'afr_other', domain: 'coolsite.io', tier: 'pro' });
  grantPro(raw, 'example.com', '2026-11-01T00:00:00.000Z', 30);

  const decision = await enforceApiKeyQuota(db, undefined, 'afr_other', Date.parse('2026-11-20T12:00:00.000Z'));
  assert.equal(decision.tier, 'free', 'another site\'s Pro term grants nothing');
});

// ---------------------------------------------------------------------------
// The downgrade when the Pro term ends
// ---------------------------------------------------------------------------

test('a Pro key drops back to the free budget when the Pro term ends', async (t) => {
  const { db, raw } = openDb(t);
  await insertKey(raw, { plaintext: 'afr_downgrade', domain: 'example.com', tier: 'pro' });
  grantPro(raw, 'example.com', '2026-11-01T00:00:00.000Z', 30);

  const during = await enforceApiKeyQuota(db, undefined, 'afr_downgrade', Date.parse('2026-11-20T00:00:00.000Z'));
  assert.equal(during.tier, 'pro');
  assert.equal(during.limit, API_KEY_QUOTA_LIMITS.pro);

  // The term ran 30 days from 2026-11-01 and therefore ended on 2026-12-01.
  const after = await enforceApiKeyQuota(db, undefined, 'afr_downgrade', Date.parse('2026-12-01T00:00:01.000Z'));
  assert.equal(after.tier, 'free', 'the key follows the term, not the row');
  assert.equal(after.limit, API_KEY_QUOTA_LIMITS.free);
  assert.equal(after.monthLimit, API_KEY_MONTHLY_QUOTA_LIMITS.free);
  assert.equal(after.issuedTier, 'pro', 'the row still records what it was issued with');
  assert.equal(after.allowed, true);
});

test('a Pro key drops back to the free budget when the Pro term is revoked', async (t) => {
  const { db, raw } = openDb(t);
  await insertKey(raw, { plaintext: 'afr_revoked_term', domain: 'example.com', tier: 'pro' });
  grantPro(raw, 'example.com', '2026-11-20T00:00:00.000Z', 30);
  const { day } = apiKeyUsagePeriods('2026-11-20');
  seedUsage(raw, 'domain:example.com', day, API_KEY_QUOTA_LIMITS.free);
  const before = await enforceApiKeyQuota(db, undefined, 'afr_revoked_term', '2026-11-20T11:59:59.000Z');
  assert.equal(before.allowed, true);
  assert.equal(before.tier, 'pro');

  revokePro(raw, 'example.com', '2026-11-20T12:00:00.000Z', 'admin:00000000-0000-0000-0000-000000000000');
  const decision = await enforceApiKeyQuota(db, undefined, 'afr_revoked_term', '2026-11-20T12:00:01.000Z');
  assert.equal(decision.tier, 'free');
  assert.equal(decision.limit, API_KEY_QUOTA_LIMITS.free);
  assert.equal(decision.issuedTier, 'pro');
  assert.equal(decision.exhausted, 'daily');
  assert.equal(decision.counted, false);
  assert.equal(decision.used, before.used);
});

test('usage carries over when the tier changes', async (t) => {
  const { db, raw } = openDb(t);
  await insertKey(raw, { plaintext: 'afr_shared', domain: 'example.com', tier: 'pro' });
  // A one-day term: it ends at midnight, so the downgrade happens within the
  // same month and the month counter has to survive it.
  grantPro(raw, 'example.com', '2026-11-20T00:00:00.000Z', 1);

  const during = await enforceApiKeyQuota(db, undefined, 'afr_shared', Date.parse('2026-11-20T23:59:59.000Z'));
  assert.equal(during.tier, 'pro');

  const after = await enforceApiKeyQuota(db, undefined, 'afr_shared', Date.parse('2026-11-21T00:00:01.000Z'));
  assert.equal(after.tier, 'free');
  assert.equal(after.monthUsed, 2, 'the month counter of the key continues across the downgrade');
  assert.deepEqual(await readDomainApiKeyUsage(db, 'example.com', '2026-11-21'), { day: 1, month: 2 });
});

test('a replacement key shares the old key’s UTC usage', async (t) => {
  const { db, raw } = openDb(t);
  const old = await insertKey(raw, { plaintext: 'afr_previous', domain: 'example.com' });
  const now = '2026-11-20T12:00:00.000Z';
  const { day } = apiKeyUsagePeriods(now);
  seedUsage(raw, 'domain:example.com', day, API_KEY_QUOTA_LIMITS.free - 1);
  assert.equal((await enforceApiKeyQuota(db, undefined, 'afr_previous', now)).counted, true);

  raw.prepare('UPDATE api_keys SET revoked_at = ? WHERE key_hash = ?').run(now, old);
  const replacement = await insertKey(raw, { plaintext: 'afr_replacement', domain: 'example.com' });
  const rotated = await enforceApiKeyQuota(db, undefined, 'afr_replacement', now);
  assert.equal(rotated.keyHash, replacement);
  assert.equal(rotated.quotaScope, 'domain');
  assert.equal(rotated.exhausted, 'daily');
  assert.equal(rotated.monthUsed, 1);
  assert.equal((await enforceApiKeyQuota(db, undefined, 'afr_previous', now)).keyHash, null);
});

test('unowned keys have independent hash buckets', async (t) => {
  const { db, raw } = openDb(t);
  const keyHash = await insertKey(raw, { plaintext: 'afr_internal_one', domain: null });
  await insertKey(raw, { plaintext: 'afr_internal_two', domain: null });
  const now = '2026-11-20T12:00:00.000Z';
  seedUsage(raw, keyHash, apiKeyUsagePeriods(now).day, API_KEY_QUOTA_LIMITS.free);
  const first = await enforceApiKeyQuota(db, undefined, 'afr_internal_one', now);
  const second = await enforceApiKeyQuota(db, undefined, 'afr_internal_two', now);
  assert.equal(first.quotaScope, 'key');
  assert.equal(first.exhausted, 'daily');
  assert.equal(second.quotaScope, 'key');
  assert.equal(second.used, 1);
  assert.equal(second.counted, true);
});

test('a failed write rolls both counters back and leaves the request uncounted', async (t) => {
  const { db, raw } = openDb(t);
  await insertKey(raw, { plaintext: 'afr_write_failure', domain: 'example.com' });
  raw.exec(`CREATE TRIGGER fail_monthly_insert BEFORE INSERT ON api_key_usage
    WHEN NEW.period LIKE 'm:%' BEGIN SELECT RAISE(ABORT, 'monthly counter unavailable'); END`);

  const decision = await enforceApiKeyQuota(db, undefined, 'afr_write_failure', '2026-11-20');
  assert.equal(decision.allowed, true);
  assert.equal(decision.counted, false);
  assert.deepEqual(usageRows(raw, 'domain:example.com'), []);
});

test('last-used writes are guarded for 15 minutes and stop at revocation', async (t) => {
  const { db, raw } = openDb(t);
  const keyHash = await insertKey(raw, { plaintext: 'afr_active', domain: 'example.com' });
  const readLastUsed = () => raw.prepare('SELECT last_used_at FROM api_keys WHERE key_hash = ?').get(keyHash)?.last_used_at;
  const first = '2026-11-20T12:00:00.000Z';
  await touchApiKeyUsage(db, keyHash, first);
  await touchApiKeyUsage(db, keyHash, '2026-11-20T12:14:59.999Z');
  assert.equal(readLastUsed(), first);

  const next = '2026-11-20T12:15:00.000Z';
  const changesBefore = raw.prepare('SELECT total_changes() AS count').get()?.count;
  await Promise.all(Array.from({ length: 16 }, () => touchApiKeyUsage(db, keyHash, next)));
  assert.equal(readLastUsed(), next);
  assert.equal(raw.prepare('SELECT total_changes() AS count').get()?.count, Number(changesBefore) + 1);

  raw.prepare('UPDATE api_keys SET revoked_at = ? WHERE key_hash = ?').run(next, keyHash);
  await touchApiKeyUsage(db, keyHash, '2026-11-20T12:31:00.000Z');
  assert.equal(readLastUsed(), next);
});

// ---------------------------------------------------------------------------
// The degradation without a counter table
// ---------------------------------------------------------------------------

test('a database without the counter table counts nothing and blocks nothing', async (t) => {
  const { db, raw } = openDb(t, false);
  await insertKey(raw, { plaintext: 'afr_notable', domain: 'example.com', tier: 'free' });

  const decision = await enforceApiKeyQuota(db, undefined, 'afr_notable');
  assert.equal(decision.allowed, true, 'a missing counter table must not fail the call');
  assert.equal(decision.counted, false, 'the decision says that nothing was counted');
  assert.equal(decision.used, 0);
  assert.equal(decision.monthUsed, 0);
  assert.equal(decision.limit, API_KEY_QUOTA_LIMITS.free);
  assert.equal(decision.monthLimit, API_KEY_MONTHLY_QUOTA_LIMITS.free);
  assert.equal(decision.exhausted, null);
  assert.equal(await readDomainApiKeyUsage(db, 'example.com'), null);
});

test('the migration carries old D1 usage across rotations and is idempotent', async (t) => {
  const { db, raw } = openDb(t, false);
  raw.exec(MIGRATION_SQL);
  const old = await insertKey(raw, { plaintext: 'afr_old_usage', domain: 'example.com', revoked: true });
  const live = await insertKey(raw, { plaintext: 'afr_live_usage', domain: 'example.com' });
  const now = '2026-11-20T12:00:00.000Z';
  const { day, month } = apiKeyUsagePeriods(now);
  seedUsage(raw, old, day, 90);
  seedUsage(raw, live, day, 9);
  seedUsage(raw, old, month, 200);
  seedUsage(raw, live, month, 25);

  raw.exec(MIGRATION_SQL);
  assert.deepEqual(await readDomainApiKeyUsage(db, 'example.com', now), { day: 99, month: 225 });
  const decision = await enforceApiKeyQuota(db, undefined, 'afr_live_usage', now);
  assert.equal(decision.counted, true);
  raw.exec(MIGRATION_SQL);
  assert.deepEqual(await readDomainApiKeyUsage(db, 'example.com', now), { day: 100, month: 226 });
});

// ---------------------------------------------------------------------------
// The buckets
// ---------------------------------------------------------------------------

test('the counters are bucketed by UTC day and UTC month', async (t) => {
  const { db, raw } = openDb(t);
  const keyHash = await insertKey(raw, { plaintext: 'afr_buckets', domain: null, tier: 'free' });

  await enforceApiKeyQuota(db, undefined, 'afr_buckets', Date.parse('2026-11-20T23:59:59.999Z'));
  await enforceApiKeyQuota(db, undefined, 'afr_buckets', Date.parse('2026-11-21T00:00:00.000Z'));
  await enforceApiKeyQuota(db, undefined, 'afr_buckets', Date.parse('2026-11-21T12:00:00.000Z'));
  await enforceApiKeyQuota(db, undefined, 'afr_buckets', Date.parse('2026-12-01T00:00:00.000Z'));

  assert.deepEqual(usageRows(raw, keyHash), [
    { period: 'd:2026-11-20', used: 1 },
    { period: 'd:2026-11-21', used: 2 },
    { period: 'd:2026-12-01', used: 1 },
    { period: 'm:2026-11', used: 3 },
    { period: 'm:2026-12', used: 1 },
  ]);
});
