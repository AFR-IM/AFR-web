import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import { ENGINE_VERSION } from '../../../packages/afr/src/index.ts';
import { AFR_METHOD } from '../../../packages/afr/src/method.ts';
import { readAdminAudit, requestReserved, reserveRequestStatement } from '../src/admin-audit.ts';
import {
  listScoringReleases,
  publishScoringRelease,
  readScoringRelease,
  renderScoringBoard,
} from '../src/admin-scoring.ts';
import { adminDocument } from '../src/admin-ui.ts';
import { openSeededDb } from './helpers.ts';

const migration = readFileSync(new URL('../migrations/scoring-release.sql', import.meta.url), 'utf8');
const first = {
  requestId: 'release-first',
  subject: 'ops-42',
  engineVersion: ENGINE_VERSION,
  notes: '评分规则说明',
};

function openScoringDb() {
  const fixture = openSeededDb();
  fixture.raw.exec(migration);
  return fixture;
}

it('accepts the bundled engine version only and keeps invalid requests unreserved', async () => {
  const { db } = openScoringDb();
  assert.equal(ENGINE_VERSION, AFR_METHOD.engineVersion);
  assert.equal(await readScoringRelease(db), null);
  for (const engineVersion of ['', ENGINE_VERSION.slice(4), `${ENGINE_VERSION}-next`, 'afr-1.0.0']) {
    assert.equal((await publishScoringRelease(db, { ...first, engineVersion })).result, 'conflict', engineVersion);
  }
  for (const notes of ['  ', 'a'.repeat(2001), 'two\u0000lines']) {
    assert.equal((await publishScoringRelease(db, { ...first, notes })).result, 'conflict');
  }
  assert.equal(await requestReserved(db, first.requestId), false);
  assert.deepEqual(await readAdminAudit(db), []);
  assert.deepEqual(await listScoringReleases(db), []);
  assert.equal((await publishScoringRelease(db, first)).result, 'applied');
});

it('appends revisions and exposes only the latest matching release without the operator', async () => {
  const { db, raw } = openScoringDb();
  const scoreSnapshot = () => raw.prepare('SELECT * FROM sites ORDER BY domain').all();
  const scores = scoreSnapshot();
  const scans = raw.prepare('SELECT * FROM scans ORDER BY id').all();
  assert.equal((await publishScoringRelease(db, first)).result, 'applied');
  assert.equal((await publishScoringRelease(db, {
    ...first,
    requestId: 'release-update',
    notes: ' 第二版\r\n新增说明 ',
  })).result, 'applied');

  // Simulate a deployment with a different engine publishing a note before a rollback.
  const otherEngine = `${ENGINE_VERSION}-later`;
  await db.batch([
    reserveRequestStatement({ requestId: 'other-version', action: 'scoring.publish', subject: 'ops-99' }),
    {
      sql: 'INSERT INTO admin_scoring_publish (request_id, subject, engine_version, notes) VALUES (?, ?, ?, ?)',
      params: ['other-version', 'ops-99', otherEngine, 'Later engine'],
    },
  ]);
  const history = await listScoringReleases(db);
  assert.deepEqual(history.map(row => row.notes), ['Later engine', '第二版\n新增说明', first.notes]);
  assert.equal(history[1]?.publishedBy, first.subject);
  const current = await readScoringRelease(db, AFR_METHOD.engineVersion);
  assert.ok(current);
  assert.deepEqual({ ...current }, {
    engineVersion: ENGINE_VERSION,
    notes: '第二版\n新增说明',
    publishedAt: history[1]?.publishedAt,
  });
  assert.equal((await readScoringRelease(db))?.notes, current.notes);
  assert.equal((await readScoringRelease(db, otherEngine))?.notes, 'Later engine');
  assert.equal(await readScoringRelease(db, 'unpublished'), null);

  const [, updated, published] = await readAdminAudit(db);
  assert.equal(updated?.action, 'scoring.publish');
  assert.equal(updated?.subject, first.subject);
  assert.equal(updated?.target, `scoring:${ENGINE_VERSION}`);
  assert.equal(updated?.request_id, 'release-update');
  assert.deepEqual(updated?.after, {
    engine_version: ENGINE_VERSION,
    notes: current.notes,
    published_at: current.publishedAt,
  });
  assert.deepEqual(updated?.before, published?.after);
  assert.equal(published?.before, null);
  assert.deepEqual(scoreSnapshot(), scores);
  assert.deepEqual(raw.prepare('SELECT * FROM scans ORDER BY id').all(), scans);
});

it('rolls back the audit and request reservation when the release fails and accepts a retry', async () => {
  const { db, raw } = openScoringDb();
  raw.exec(`CREATE TRIGGER block_scoring_release BEFORE INSERT ON scoring_releases
    BEGIN SELECT RAISE(ABORT, 'release blocked'); END;`);
  await assert.rejects(publishScoringRelease(db, first), /release blocked/);
  assert.deepEqual(await readAdminAudit(db), []);
  assert.equal(await readScoringRelease(db), null);
  assert.equal(await requestReserved(db, first.requestId), false);

  raw.exec('DROP TRIGGER block_scoring_release');
  assert.equal((await publishScoringRelease(db, first)).result, 'applied');
  assert.equal((await readAdminAudit(db)).length, 1);
  assert.ok(await readScoringRelease(db));
  assert.equal(await requestReserved(db, first.requestId), true);
});

it('blocks writes without request reservations and guards the ledger from edits, deletion and replacement', async () => {
  const { db, raw } = openScoringDb();
  assert.throws(() => raw.prepare('INSERT INTO admin_scoring_publish VALUES (?, ?, ?, ?)')
    .run(first.requestId, first.subject, ENGINE_VERSION, first.notes), /requires its admin request/);
  raw.exec(migration);
  assert.equal((await publishScoringRelease(db, first)).result, 'applied');
  assert.throws(() => raw.exec("UPDATE scoring_releases SET notes = 'rewrite'"), /append-only/);
  assert.throws(() => raw.exec('DELETE FROM scoring_releases'), /append-only/);
  assert.throws(() => raw.exec(`INSERT OR REPLACE INTO scoring_releases
    (engine_version, notes, published_at, published_by, request_id)
    SELECT engine_version, 'replace', published_at, published_by, request_id FROM scoring_releases`), /append-only/);
  assert.equal((await readScoringRelease(db))?.notes, first.notes);
});

it('commits only one release for concurrent submissions and later replays of a request id', async () => {
  const { db } = openScoringDb();
  const attempts = await Promise.all([
    publishScoringRelease(db, first),
    publishScoringRelease(db, first),
  ]);
  assert.deepEqual(attempts.map(attempt => attempt.result).sort(), ['applied', 'replayed']);
  assert.equal((await publishScoringRelease(db, { ...first, notes: 'different input' })).result, 'replayed');
  await db.batch([reserveRequestStatement({ requestId: 'other-action', action: 'settings.update', subject: first.subject })]);
  assert.equal((await publishScoringRelease(db, { ...first, requestId: 'other-action' })).result, 'replayed');
  assert.equal((await listScoringReleases(db)).length, 1);
  assert.equal((await readAdminAudit(db)).length, 1);
});

it('renders the working console form and escapes release notes as plain text', async () => {
  const { db } = openScoringDb();
  await publishScoringRelease(db, { ...first, notes: '<script>alert(1)</script>\n第二行' });
  const page = adminDocument('评分规则', renderScoringBoard(await listScoringReleases(db), { kind: 'ok', text: '已发布。' }));
  assert.ok(page.includes('<form method="post" action="/admin/scoring">'));
  assert.ok(page.includes('name="request_id"'));
  assert.ok(page.includes(`name="engine_version" value="${ENGINE_VERSION}"`));
  assert.ok(page.includes('<textarea name="notes"'));
  assert.ok(page.includes('已发布。'));
  assert.ok(page.includes(first.subject));
  assert.ok(page.includes('&lt;script&gt;alert(1)&lt;/script&gt;<br>第二行'));
  assert.ok(!page.includes('<script>'));
});
