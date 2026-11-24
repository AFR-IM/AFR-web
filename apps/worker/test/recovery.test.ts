import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { backup, DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { openSeededDb } from './helpers.ts';

// Isolated fixture: this never connects to Cloudflare or reads real mail.
test('restore preserves scan evidence, owner binding, queue, and mail', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'afr-recovery-'));
  const { raw } = openSeededDb();
  const snapshot = join(dir, 'checkpoint.db');
  try {
    raw.exec(readFileSync(new URL('../../mail-worker/schema.sql', import.meta.url), 'utf8'));
    raw.exec(`
      INSERT INTO owners (domain, verify_method, verified_at) VALUES ('example.com', 'dns-txt', '2026-11-24');
      INSERT INTO owner_emails (domain, email_cipher, email_hash, verified_at, manage_token_hash)
        VALUES ('example.com', 'fixture-cipher', 'fixture-hash', '2026-11-24', 'fixture-manage');
      INSERT INTO submissions (domain, source, status) VALUES ('example.com', 'on_demand', 'queued');
      INSERT INTO inbound_mail (sender, recipient, received_at) VALUES ('sender@example.com', 'recipient@example.com', '2026-11-24');
    `);
    const tables = ['sites', 'scans', 'evidence', 'owners', 'owner_emails', 'submissions', 'inbound_mail'];
    const contents = (db: DatabaseSync) => tables.map((name) => db.prepare(`SELECT * FROM ${name} ORDER BY rowid`).all());
    const expected = contents(raw);
    assert.ok(expected.every((rows) => rows.length > 0));
    await backup(raw, snapshot);
    raw.exec("UPDATE submissions SET status = 'scanned'; DELETE FROM owner_emails; DELETE FROM inbound_mail;");
    assert.notDeepEqual(contents(raw), expected);

    const recovered = new DatabaseSync(snapshot);
    try {
      assert.equal(recovered.prepare('PRAGMA integrity_check').get()?.integrity_check, 'ok');
      assert.deepEqual(contents(recovered), expected);
    } finally {
      recovered.close();
    }
  } finally {
    raw.close();
    await rm(dir, { recursive: true, force: true });
  }
});
