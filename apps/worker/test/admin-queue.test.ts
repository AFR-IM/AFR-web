import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { it } from 'node:test';
import { readAdminQueue, retryAdminSubmission } from '../src/admin-queue.ts';
import { createSqliteDb } from '../src/db.ts';
import { openSeededDb, SCHEMA_SQL } from './helpers.ts';

const migration = readFileSync(new URL('../migrations/admin-queue.sql', import.meta.url), 'utf8');
const CREATED_AT = '2026-11-01T00:00:00.000Z';
const DONE_AT = '2026-11-02T00:00:00.000Z';
const request = { id: 1, requestId: 'c4bc1139-b1c5-4c78-83b9-5d41b75975ed', subject: 'access-operator' };

function addSubmission(raw: DatabaseSync, status: string, domain = 'example.com') {
  return raw.prepare(`
    INSERT INTO submissions (domain, submitter_note, source, status, created_at, done_at)
    VALUES (?, 'private submitter note', 'public', ?, ?, ?)
  `).run(domain, status, CREATED_AT, status === 'scanned' ? DONE_AT : null);
}

it('lists only bounded board rows, with oldest active backlog and joined site status', async () => {
  const { db, raw } = openSeededDb();
  addSubmission(raw, 'pending');
  addSubmission(raw, 'scanning', 'missing.example');
  for (let i = 3; i <= 60; i++) addSubmission(raw, 'queued', `q${i}.test`);
  for (let i = 0; i < 53; i++) {
    const id = Number(addSubmission(raw, 'rejected', `done${i}.test`).lastInsertRowid);
    assert.equal(await retryAdminSubmission(db, { ...request, id, requestId: crypto.randomUUID() }), 'queued');
  }
  const { recent, backlog, audit } = await readAdminQueue(db);
  assert.equal(recent.length, 50);
  assert.equal(backlog.length, 50);
  assert.equal(audit.length, 50);
  assert.equal(recent[0].domain, 'done52.test');
  assert.equal(backlog[49].domain, 'q50.test');
  assert.deepEqual({ ...backlog[0] }, {
    id: 1, domain: 'example.com', status: 'pending', source: 'public',
    created_at: CREATED_AT, done_at: null, site_status: 'active',
  });
  assert.equal(backlog[1].site_status, null);
  assert.ok(!JSON.stringify({ recent, backlog, audit }).includes('private submitter note'));
});

it('queues once with before/after snapshots and distinguishes replay from changed input', async () => {
  const { db, raw } = openSeededDb();
  addSubmission(raw, 'scanned');
  addSubmission(raw, 'done', 'coolsite.io');
  const outcomes = await Promise.all([
    retryAdminSubmission(db, request),
    retryAdminSubmission(db, request),
    retryAdminSubmission(db, { ...request, requestId: crypto.randomUUID() }),
  ]);
  assert.deepEqual(outcomes, ['queued', 'replayed', 'conflict']);
  assert.equal(await retryAdminSubmission(db, { ...request, id: 2 }), 'conflict');
  assert.equal(await retryAdminSubmission(db, { ...request, subject: 'another-operator' }), 'conflict');
  const { backlog, audit } = await readAdminQueue(db);
  assert.equal(backlog.length, 1);
  assert.equal(audit.length, 1);
  const { site_status, ...after } = backlog[0];
  assert.equal(site_status, 'active');
  assert.ok(Number.isFinite(Date.parse(after.created_at!)));
  assert.deepEqual(after, {
    id: 3, domain: 'example.com', status: 'queued', source: 'on_demand', created_at: after.created_at, done_at: null,
  });
  assert.deepEqual(audit[0], {
    request_id: request.requestId, action: 'retry', subject: request.subject, created_at: after.created_at,
    before: { id: 1, domain: 'example.com', status: 'scanned', source: 'public', created_at: CREATED_AT, done_at: DONE_AT },
    after,
  });
  raw.exec("UPDATE submissions SET status = 'scanned' WHERE id = 3");
  assert.equal(await retryAdminSubmission(db, { ...request, requestId: crypto.randomUUID() }), 'conflict');
  raw.exec('DELETE FROM submissions WHERE id IN (1, 3)');
  assert.equal(await retryAdminSubmission(db, { ...request, requestId: request.requestId.toUpperCase() }), 'replayed');
  assert.equal(await retryAdminSubmission(db, { ...request, id: 2, requestId: crypto.randomUUID() }), 'queued');
});

it('rejects nonexistent and active source IDs and refuses domains with any active row', async () => {
  const { db, raw } = openSeededDb();
  addSubmission(raw, 'rejected');
  const activeId = Number(addSubmission(raw, 'queued').lastInsertRowid);
  for (const status of ['queued', 'pending', 'scanning']) {
    raw.prepare('UPDATE submissions SET status = ? WHERE id = ?').run(status, activeId);
    assert.equal(await retryAdminSubmission(db, request), 'conflict');
    assert.equal(await retryAdminSubmission(db, { ...request, id: activeId }), 'conflict');
  }
  assert.equal(await retryAdminSubmission(db, { ...request, id: 500 }), 'conflict');
  assert.equal(await retryAdminSubmission(db, { ...request, requestId: 'invalid' }), 'conflict');
  assert.equal(await retryAdminSubmission(db, { ...request, subject: ' ' }), 'conflict');
  assert.equal((await readAdminQueue(db)).audit.length, 0);
  raw.exec('DELETE FROM submissions WHERE id = 2');
  assert.equal(await retryAdminSubmission(db, request), 'queued');
});

it('rolls back the queue insert when the audit fails and safely retries the same UUID', async () => {
  const { db, raw } = openSeededDb();
  addSubmission(raw, 'scanned');
  raw.exec(`CREATE TRIGGER fail_audit BEFORE INSERT ON admin_queue_audit BEGIN
    SELECT RAISE(IGNORE);
  END;`);
  await assert.rejects(retryAdminSubmission(db, request), /audit insert required/);
  assert.equal(raw.prepare('SELECT COUNT(*) AS n FROM submissions').get()?.n, 1);
  assert.deepEqual((await readAdminQueue(db)).audit, []);
  raw.exec('DROP TRIGGER fail_audit');
  assert.equal(await retryAdminSubmission(db, request), 'queued');
  assert.equal(await retryAdminSubmission(db, request), 'replayed');
});

it('applies the additive migration twice and blocks audit updates, deletes and replaces', async () => {
  assert.ok(SCHEMA_SQL.endsWith(migration), 'fresh schema must match the production migration');
  const raw = new DatabaseSync(':memory:');
  const db = createSqliteDb(raw);
  raw.exec(SCHEMA_SQL.slice(0, -migration.length));
  addSubmission(raw, 'rejected');
  addSubmission(raw, 'queued', 'legacy.test');
  addSubmission(raw, 'pending', 'legacy.test'); // Existing duplicate active rows are tolerated.
  raw.exec(migration);
  assert.equal(await retryAdminSubmission(db, request), 'queued');
  raw.exec(migration);
  assert.equal(await retryAdminSubmission(db, request), 'replayed');
  const { audit } = await readAdminQueue(db);
  for (const sql of [
    `UPDATE admin_queue_audit SET subject = 'other'`,
    `DELETE FROM admin_queue_audit`,
    `INSERT OR REPLACE INTO admin_queue_audit SELECT * FROM admin_queue_audit`,
  ]) assert.throws(() => raw.exec(sql), /append-only/);
  assert.deepEqual((await readAdminQueue(db)).audit, audit);
  raw.close();
});
