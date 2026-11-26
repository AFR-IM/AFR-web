// test/charity.test.ts — the append-only donation registry, the pre-vetted
// beneficiary gate and the two-direction public ledger.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import { readCharityLedger, recordCharityDonation } from '../src/charity.ts';
import { openSeededDb } from './helpers.ts';

const migration = readFileSync(new URL('../migrations/paid-boards.sql', import.meta.url), 'utf8');
const now = new Date('2026-11-26T12:00:00.000Z');
const BENEFICIARY = '开源基金会';
const TX_A = '0x' + 'a'.repeat(64);
const TX_B = '0x' + 'b'.repeat(64);

async function fixture({ beneficiaries = true }: { beneficiaries?: boolean } = {}) {
  const { raw, db } = openSeededDb();
  raw.exec(migration);
  raw.exec(migration); // additive and safe to re-apply
  if (beneficiaries) {
    raw.prepare(`INSERT INTO admin_settings (key, value_json, updated_at, updated_by)
                 VALUES ('beneficiaries', ?, ?, 'test')`)
      .run(JSON.stringify([{ name: BENEFICIARY, website: 'https://example.org', direction: '开源基础设施' }]),
        now.toISOString());
  }
  return { raw, db };
}

let seq = 0;
function seedInflow(
  raw: ReturnType<typeof openSeededDb>['raw'],
  { amount, paidAt, tx, status = 'paid' }: { amount: string; paidAt: string; tx: string | null; status?: string },
): void {
  seq += 1;
  raw.prepare(
    `INSERT INTO torch_purchases (domain, binding_code, merchant_order_id, amount, asset, chain_key,
       status, tx_hash, paid_at, source, created_at, updated_at)
     VALUES ('example.com', ?, ?, ?, 'USDC', 'base', ?, ?, ?, 'webhook', ?, ?)`,
  ).run(`CPDE${String(seq).padStart(4, '0')}`,
    `torch-00000000-0000-4000-8000-${String(seq).padStart(12, '0')}`,
    amount, status, tx, status === 'paid' ? paidAt : null, paidAt, paidAt);
}

const record = (db: Awaited<ReturnType<typeof fixture>>['db'], overrides: Record<string, unknown> = {}) =>
  recordCharityDonation(db, {
    requestId: crypto.randomUUID(),
    subject: 'local:ops',
    amount: '4',
    txHash: TX_A,
    beneficiary: BENEFICIARY,
    note: '季度捐赠',
    now,
    ...overrides,
  });

it('applies the migration twice and keeps donations append-only', async () => {
  const { raw, db } = await fixture();
  const id = (await record(db)).result === 'applied'
    ? raw.prepare('SELECT id FROM charity_donations').get<{ id: number }>()?.id
    : undefined;
  assert.ok(id);
  assert.throws(() => raw.prepare('UPDATE charity_donations SET amount = ? WHERE id = ?').run('1', id), /append-only/);
  assert.throws(() => raw.prepare('DELETE FROM charity_donations WHERE id = ?').run(id), /append-only/);
  assert.throws(
    () => raw.prepare(`INSERT INTO charity_donations (id, amount, asset, chain_key, tx_hash, beneficiary,
        funded_in_tx, note, approval_request_id, executed_at, created_at)
      VALUES (?, '1', 'USDC', 'base', ?, 'x', '[]', '', NULL, ?, ?)`)
      .run(id, TX_B, now.toISOString(), now.toISOString()),
    /append-only/,
  );
  assert.equal(raw.prepare('SELECT amount FROM charity_donations').get<{ amount: string }>()?.amount, '4');
});

it('refuses donations outside the pre-vetted list, malformed money or replayed facts', async () => {
  const { raw, db } = await fixture();
  const noList = await fixture({ beneficiaries: false });
  assert.equal((await record(noList.db)).result, 'conflict');
  assert.equal((await record(db, { beneficiary: '未备案组织' })).result, 'conflict');
  assert.equal((await record(db, { amount: 'abc' })).result, 'conflict');
  assert.equal((await record(db, { amount: '0' })).result, 'conflict');
  assert.equal((await record(db, { amount: '-4' })).result, 'conflict');
  assert.equal((await record(db, { txHash: 'not-a-hash' })).result, 'conflict');
  assert.equal((await record(db, { txHash: '0x' + 'z'.repeat(64) })).result, 'conflict');
  assert.equal((await record(db, { requestId: 'nope' })).result, 'conflict');
  assert.equal(raw.prepare('SELECT count(*) AS n FROM charity_donations').get<{ n: number }>()?.n, 0);
  assert.equal(raw.prepare('SELECT count(*) AS n FROM admin_audit').get<{ n: number }>()?.n, 0);
});

it('records a donation with its audit row, the reserved request and the funding slice', async () => {
  const { raw, db } = await fixture();
  seedInflow(raw, { amount: '4', paidAt: '2026-11-26T09:00:00.000Z', tx: TX_A });
  seedInflow(raw, { amount: '6', paidAt: '2026-11-26T10:00:00.000Z', tx: TX_B });

  const requestId = crypto.randomUUID();
  const result = await record(db, { requestId, amount: '4' });
  assert.equal(result.result, 'applied');

  const row = raw.prepare('SELECT amount, tx_hash, beneficiary, funded_in_tx FROM charity_donations').get<{
    amount: string; tx_hash: string; beneficiary: string; funded_in_tx: string;
  }>();
  assert.equal(row?.amount, '4');
  assert.equal(row?.tx_hash, TX_A);
  assert.equal(row?.beneficiary, BENEFICIARY);
  // $4 of donations cover exactly the earliest $4 inflow — one tx hash.
  assert.deepEqual(JSON.parse(row?.funded_in_tx ?? '[]'), [TX_A]);

  const audit = raw.prepare('SELECT action, target FROM admin_audit WHERE request_id = ?')
    .all<{ action: string; target: string }>(requestId);
  assert.deepEqual(audit.map((entry) => [entry.action, entry.target]), [['charity.record', 'charity:donation']]);
  assert.equal(raw.prepare('SELECT count(*) AS n FROM admin_requests WHERE request_id = ?')
    .get<{ n: number }>(requestId)?.n, 1);

  // Replays and duplicate transactions never land twice.
  assert.equal((await record(db, { requestId })).result, 'replayed');
  assert.equal((await record(db, { txHash: TX_A })).result, 'conflict');
  assert.equal(raw.prepare('SELECT count(*) AS n FROM charity_donations').get<{ n: number }>()?.n, 1);
});

it('publishes both ledger directions newest first, cross-referenced by tx hash', async () => {
  const { raw, db } = await fixture();
  const empty = await readCharityLedger(db, { now });
  assert.deepEqual(empty.entries, []);
  assert.ok(empty.generatedAt);

  seedInflow(raw, { amount: '4', paidAt: '2026-11-26T09:00:00.000Z', tx: TX_A });
  seedInflow(raw, { amount: '6', paidAt: '2026-11-26T10:00:00.000Z', tx: TX_B });
  seedInflow(raw, { amount: '9', paidAt: '2026-11-26T11:00:00.000Z', tx: null }); // no tx → not published
  seedInflow(raw, { amount: '3', paidAt: '2026-11-26T08:00:00.000Z', tx: '0x' + 'c'.repeat(64), status: 'pending' });
  await record(db, { amount: '4', txHash: TX_A });

  const ledger = await readCharityLedger(db, { now });
  assert.deepEqual(ledger.entries.map((entry) => entry.kind), ['donation_out', 'torch_in', 'torch_in']);
  const [donation, inflowB, inflowA] = ledger.entries;
  assert.equal(donation?.anchor, 'donation-1');
  assert.equal(donation?.beneficiary, BENEFICIARY);
  assert.equal(donation?.txHash, TX_A);
  assert.deepEqual(donation?.fundedInTx, [TX_A]); // the chain points back at the inflow it covers
  assert.equal(inflowA?.anchor, 'torch-1');
  assert.equal(inflowA?.domain, 'example.com');
  assert.equal(inflowA?.txHash, TX_A);
  assert.equal(inflowB?.txHash, TX_B);
  assert.equal(ledger.entries.length, 3);
});
