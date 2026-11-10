// test/schema.test.ts — schema.sql must execute cleanly in in-memory SQLite.

import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { describe, it } from 'node:test';
import { SCHEMA_SQL } from './helpers.ts';

function tableNames(db: DatabaseSync): string[] {
  return db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
    .all<{ name: string }>()
    .map((r) => r.name);
}

function indexNames(db: DatabaseSync): string[] {
  return db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_%'")
    .all<{ name: string }>()
    .map((r) => r.name);
}

describe('schema.sql', () => {
  it('creates every table from spec v1.0 §6.1 plus ads (v1.2 §6.1)', () => {
    const db = new DatabaseSync(':memory:');
    db.exec(SCHEMA_SQL);
    const tables = tableNames(db);
    for (const expected of [
      'sites',
      'scans',
      'evidence',
      'owners',
      'submissions',
      'claims',
      'categories',
      'api_keys',
      'ads',
    ]) {
      assert.ok(tables.includes(expected), `missing table: ${expected}`);
    }
    db.close();
  });

  it('creates the documented indexes', () => {
    const db = new DatabaseSync(':memory:');
    db.exec(SCHEMA_SQL);
    const indexes = indexNames(db);
    for (const expected of ['idx_sites_category', 'idx_sites_grade', 'idx_scans_domain', 'idx_ads_slot']) {
      assert.ok(indexes.includes(expected), `missing index: ${expected}`);
    }
    db.close();
  });

  it('is idempotent (CREATE ... IF NOT EXISTS)', () => {
    const db = new DatabaseSync(':memory:');
    db.exec(SCHEMA_SQL);
    assert.doesNotThrow(() => db.exec(SCHEMA_SQL));
    db.close();
  });

  it('supports the directory schema shape (sites columns + FK-style references)', () => {
    const db = new DatabaseSync(':memory:');
    db.exec(SCHEMA_SQL);
    const cols = db
      .prepare('PRAGMA table_info(sites)')
      .all<{ name: string }>()
      .map((c) => c.name);
    for (const expected of [
      'domain',
      'category_id',
      'strategy_tag',
      'grade',
      'score_total',
      'score_l1',
      'score_l2',
      'score_l3',
      'rank_source',
      'rank',
      'status',
      'verified',
      'created_at',
      'updated_at',
      'scanned_at',
    ]) {
      assert.ok(cols.includes(expected), `sites missing column: ${expected}`);
    }
    db.close();
  });
});
