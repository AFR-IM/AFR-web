// Regression: the production D1 wrapper must read `changes` from meta —
// reading only the top level made every changes>0 check false in production
// (the queue /done endpoint answered 404 after a successful UPDATE).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createD1Db, type D1Like, type D1StatementLike } from '../src/db.ts';

function fakeD1(runResult: Record<string, unknown>): D1Like {
  const stmt: D1StatementLike = {
    bind: () => stmt,
    all: async () => ({ results: [] }),
    first: async () => null,
    run: async () => runResult as never,
  };
  return {
    prepare: () => stmt,
    exec: async () => undefined,
  };
}

describe('createD1Db run() result mapping', () => {
  it('reads changes from meta (real D1 shape)', async () => {
    const db = createD1Db(fakeD1({ meta: { changes: 3, last_row_id: 7 }, results: [] }));
    const r = await db.prepare('UPDATE x SET y = 1').run();
    assert.equal(r.changes, 3);
    assert.equal(r.lastInsertRowid, 7);
  });

  it('falls back to top-level changes (sqlite / legacy shape)', async () => {
    const db = createD1Db(fakeD1({ changes: 2, lastInsertRowid: 5 }));
    const r = await db.prepare('UPDATE x SET y = 1').run();
    assert.equal(r.changes, 2);
    assert.equal(r.lastInsertRowid, 5);
  });

  it('reports 0 when neither shape carries changes', async () => {
    const db = createD1Db(fakeD1({ results: [] }));
    const r = await db.prepare('UPDATE x SET y = 1').run();
    assert.equal(r.changes, 0);
  });
});
