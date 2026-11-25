// test/admin-content.test.ts — the content & community board (SSOT item 18,
// domain B): claim moderation, batch reclassification, correction tickets and
// the verified spot check.

import assert from 'node:assert/strict';
import { it } from 'node:test';
import type { DatabaseSync } from 'node:sqlite';
import {
  closeCorrectionTicket,
  createCorrectionTicket,
  moderateClaims,
  readContentBoard,
  reclassifySites,
  renderContentBoard,
} from '../src/admin-content.ts';
import { openSeededDb } from './helpers.ts';

const OPERATOR = 'access-operator';
const REQUEST = 'c4bc1139-b1c5-4c78-83b9-5d41b75975ed';

function addCategory(raw: DatabaseSync, id: number, slug: string): void {
  raw
    .prepare(`INSERT INTO categories (id, slug, name_en, name_zh, parent) VALUES (?, ?, ?, ?, NULL)`)
    .run(id, slug, slug, slug);
}

function addClaim(
  raw: DatabaseSync,
  domain: string,
  statement: string,
  status = 'pending',
): number {
  const result = raw
    .prepare(
      `INSERT INTO claims (domain, statement, status, created_at)
       VALUES (?, ?, ?, '2026-11-01T00:00:00.000Z')`,
    )
    .run(domain, statement, status);
  return Number(result.lastInsertRowid);
}

function auditRows(raw: DatabaseSync, action: string) {
  return raw
    .prepare(
      `SELECT request_id, action, subject, target, before_json, after_json
       FROM admin_audit WHERE action = ? ORDER BY id`,
    )
    .all(action) as { request_id: string; action: string; subject: string; target: string; before_json: string | null; after_json: string | null }[];
}

function siteRow(raw: DatabaseSync, domain: string) {
  const row = raw
    .prepare(
      `SELECT domain, title, category_id, category_override, grade, rank, verified, status, updated_at
       FROM sites WHERE domain = ?`,
    )
    .get(domain) as Record<string, unknown> | undefined;
  assert.ok(row, `site ${domain} must exist`);
  return row;
}

it('lists only pending claims and decides a batch with one audit row per claim', async () => {
  const { db, raw } = openSeededDb();
  const first = addClaim(raw, 'example.com', '我们提供 GPTBot 接入');
  const second = addClaim(raw, 'coolsite.io', '二手交易市场');
  addClaim(raw, 'neutral.net', '早已发布', 'published');
  addClaim(raw, 'closed.org', '已驳回', 'rejected');

  const board = await readContentBoard(db);
  assert.deepEqual(board.pendingClaims.map(claim => claim.id), [first, second]);
  assert.equal(board.pendingClaims[0].statement, '我们提供 GPTBot 接入');
  assert.equal(board.pendingClaims[0].created_at, '2026-11-01T00:00:00.000Z');

  const published = await moderateClaims(db, {
    requestId: REQUEST,
    subject: OPERATOR,
    claimIds: [first, second],
    decision: 'publish',
  });
  assert.deepEqual(published, { result: 'applied', changed: 2, skipped: 0 });
  assert.equal(
    raw.prepare('SELECT status FROM claims WHERE id = ?').get(first)?.status,
    'published',
  );
  assert.equal(
    raw.prepare('SELECT status FROM claims WHERE id = ?').get(second)?.status,
    'published',
  );

  const rows = auditRows(raw, 'claims.publish');
  assert.equal(rows.length, 2);
  assert.deepEqual(JSON.parse(rows[0]!.before_json!), { status: 'pending' });
  assert.deepEqual(JSON.parse(rows[0]!.after_json!), { status: 'published' });
  assert.equal(rows[0]!.target, `claim:${first}`);
  assert.equal(rows[0]!.subject, OPERATOR);
  assert.equal(rows[1]!.target, `claim:${second}`);

  // A claim that is no longer pending is skipped, not an error.
  const again = await moderateClaims(db, {
    requestId: 'b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e',
    subject: OPERATOR,
    claimIds: [first],
    decision: 'reject',
  });
  assert.deepEqual(again, { result: 'applied', changed: 0, skipped: 1 });
  assert.equal(raw.prepare('SELECT status FROM claims WHERE id = ?').get(first)?.status, 'published');
});

it('rejects a batch of claims', async () => {
  const { db, raw } = openSeededDb();
  const claim = addClaim(raw, 'example.com', '冒名声明');
  const result = await moderateClaims(db, {
    requestId: REQUEST,
    subject: OPERATOR,
    claimIds: [claim],
    decision: 'reject',
  });
  assert.deepEqual(result, { result: 'applied', changed: 1, skipped: 0 });
  assert.equal(raw.prepare('SELECT status FROM claims WHERE id = ?').get(claim)?.status, 'rejected');
  const rows = auditRows(raw, 'claims.reject');
  assert.equal(rows.length, 1);
  assert.deepEqual(JSON.parse(rows[0]!.after_json!), { status: 'rejected' });
});

it('refuses malformed claim input', async () => {
  const { db, raw } = openSeededDb();
  const claim = addClaim(raw, 'example.com', '声明');
  const conflict = { result: 'conflict', changed: 0, skipped: 0 };
  assert.deepEqual(
    await moderateClaims(db, { requestId: REQUEST, subject: OPERATOR, claimIds: [], decision: 'publish' }),
    conflict,
  );
  assert.deepEqual(
    await moderateClaims(db, {
      requestId: REQUEST,
      subject: OPERATOR,
      claimIds: [0],
      decision: 'publish',
    }),
    conflict,
  );
  assert.deepEqual(
    await moderateClaims(db, {
      requestId: REQUEST,
      subject: OPERATOR,
      claimIds: [1.5],
      decision: 'publish',
    }),
    conflict,
  );
  assert.deepEqual(
    await moderateClaims(db, {
      requestId: REQUEST,
      subject: OPERATOR,
      claimIds: Array.from({ length: 101 }, (_, index) => index + 1),
      decision: 'publish',
    }),
    conflict,
  );
  assert.deepEqual(
    await moderateClaims(db, {
      requestId: '',
      subject: OPERATOR,
      claimIds: [claim],
      decision: 'publish',
    }),
    conflict,
  );
  assert.deepEqual(
    await moderateClaims(db, {
      requestId: REQUEST,
      subject: '  ',
      claimIds: [claim],
      decision: 'publish',
    }),
    conflict,
  );
  assert.equal(raw.prepare('SELECT status FROM claims WHERE id = ?').get(claim)?.status, 'pending');
  assert.equal(auditRows(raw, 'claims.publish').length, 0);
});

it('reclassifies a batch of sites and audits every change', async () => {
  const { db, raw } = openSeededDb();
  addCategory(raw, 4, 'other');
  addCategory(raw, 5, 'ecommerce');
  raw.prepare('UPDATE sites SET category_id = 4 WHERE domain = ?').run('coolsite.io');
  const before = siteRow(raw, 'coolsite.io');

  const result = await reclassifySites(db, {
    requestId: REQUEST,
    subject: OPERATOR,
    // A URL, an upper-case host and a `www.` prefix are the same site.
    domains: ['https://www.Example.com/path', 'coolsite.io'],
    categorySlug: 'ecommerce',
  });
  assert.deepEqual(result, { result: 'applied', changed: 2, skipped: [] });

  const moved = siteRow(raw, 'coolsite.io');
  // The manual decision lands in category_override; the rule-derived
  // category_id stays what the keyword rules produced.
  assert.equal(moved.category_override, 5);
  assert.equal(moved.category_id, 4);
  // Nothing but the category (and the update timestamp) may change.
  assert.equal(moved.title, before.title);
  assert.equal(moved.verified, before.verified);
  assert.equal(moved.rank, before.rank);
  assert.equal(moved.grade, before.grade);
  assert.equal(moved.status, before.status);
  assert.notEqual(moved.updated_at, before.updated_at);
  assert.equal(siteRow(raw, 'example.com').category_override, 5);

  // The audit rows follow the order of the requested domains.
  const rows = auditRows(raw, 'reclassify');
  assert.equal(rows.length, 2);
  assert.deepEqual(JSON.parse(rows[0]!.before_json!), {
    category_id: 2,
    category_slug: 'dev-tools',
  });
  assert.deepEqual(JSON.parse(rows[0]!.after_json!), {
    category_id: 5,
    category_slug: 'ecommerce',
  });
  assert.equal(rows[0]!.target, 'site:example.com');
  assert.deepEqual(JSON.parse(rows[1]!.before_json!), {
    category_id: 4,
    category_slug: 'other',
  });
  assert.equal(rows[1]!.target, 'site:coolsite.io');
});

it('skips unknown sites and rejects an unusable reclassification input', async () => {
  const { db, raw } = openSeededDb();
  addCategory(raw, 4, 'other');
  addCategory(raw, 5, 'ecommerce');

  const result = await reclassifySites(db, {
    requestId: REQUEST,
    subject: OPERATOR,
    domains: ['example.com', 'missing.example'],
    categorySlug: 'ecommerce',
  });
  assert.deepEqual(result, { result: 'applied', changed: 1, skipped: ['missing.example'] });
  assert.equal(siteRow(raw, 'example.com').category_override, 5);

  const conflict = { result: 'conflict', changed: 0, skipped: [] };
  assert.deepEqual(
    await reclassifySites(db, {
      requestId: 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d',
      subject: OPERATOR,
      domains: ['example.com'],
      categorySlug: 'does-not-exist',
    }),
    conflict,
  );
  assert.deepEqual(
    await reclassifySites(db, {
      requestId: 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d',
      subject: OPERATOR,
      domains: ['not a domain'],
      categorySlug: 'ecommerce',
    }),
    conflict,
  );
  assert.deepEqual(
    await reclassifySites(db, {
      requestId: 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d',
      subject: OPERATOR,
      domains: ['192.168.0.1'],
      categorySlug: 'ecommerce',
    }),
    conflict,
  );
  assert.deepEqual(
    await reclassifySites(db, {
      requestId: 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d',
      subject: OPERATOR,
      domains: Array.from({ length: 41 }, (_, index) => `s${index}.example`),
      categorySlug: 'ecommerce',
    }),
    conflict,
  );
  // The rejected batch left the site alone.
  assert.equal(siteRow(raw, 'example.com').category_override, 5);
  assert.equal(siteRow(raw, 'example.com').category_id, 2);
  assert.equal(auditRows(raw, 'reclassify').length, 1);
});

it('replays a reclassification request id instead of writing twice', async () => {
  const { db, raw } = openSeededDb();
  addCategory(raw, 4, 'other');
  addCategory(raw, 5, 'ecommerce');

  const first = await reclassifySites(db, {
    requestId: REQUEST,
    subject: OPERATOR,
    domains: ['example.com'],
    categorySlug: 'ecommerce',
  });
  assert.deepEqual(first, { result: 'applied', changed: 1, skipped: [] });

  raw.prepare('UPDATE sites SET category_id = 4 WHERE domain = ?').run('example.com');
  const replay = await reclassifySites(db, {
    requestId: REQUEST,
    subject: OPERATOR,
    domains: ['example.com'],
    categorySlug: 'ecommerce',
  });
  assert.deepEqual(replay, { result: 'replayed', changed: 0, skipped: [] });
  // The replay wrote nothing: the site keeps the value it had.
  assert.equal(siteRow(raw, 'example.com').category_id, 4);
  assert.equal(siteRow(raw, 'example.com').category_override, 5);
  assert.equal(auditRows(raw, 'reclassify').length, 1);

  // A different request id is a new decision and writes another audit row.
  // It has to be a decision that changes something: the site is already in
  // ecommerce (the manual label wins over the rule value), so the new
  // decision moves it to another category.
  const again = await reclassifySites(db, {
    requestId: 'b1c2d3e4-f5a6-4b7c-8d9e-0f1a2b3c4d5e',
    subject: OPERATOR,
    domains: ['example.com'],
    categorySlug: 'news',
  });
  assert.deepEqual(again, { result: 'applied', changed: 1, skipped: [] });
  assert.equal(auditRows(raw, 'reclassify').length, 2);
  assert.equal(siteRow(raw, 'example.com').category_override, 3);
});

it('opens, lists and closes a correction ticket', async () => {
  const { db, raw } = openSeededDb();
  const created = await createCorrectionTicket(db, {
    requestId: REQUEST,
    subject: OPERATOR,
    domain: 'https://www.Example.com/',
    kind: 'category',
    detail: '这是一个开发者工具站',
  });
  assert.equal(created.result, 'applied');
  assert.ok(created.ticketId > 0);

  const board = await readContentBoard(db);
  assert.equal(board.tickets.length, 1);
  assert.deepEqual(board.tickets[0], {
    id: created.ticketId,
    domain: 'example.com',
    kind: 'category',
    detail: '这是一个开发者工具站',
    status: 'open',
    subject: OPERATOR,
    created_at: board.tickets[0]!.created_at,
    updated_at: board.tickets[0]!.updated_at,
    closed_at: null,
  });
  assert.ok(board.tickets[0]!.created_at);
  const createdRows = auditRows(raw, 'ticket.create');
  assert.equal(createdRows.length, 1);
  assert.equal(createdRows[0]!.target, `ticket:${created.ticketId}`);
  assert.deepEqual(JSON.parse(createdRows[0]!.after_json!), {
    domain: 'example.com',
    kind: 'category',
    detail: '这是一个开发者工具站',
  });

  // A replayed create returns the ticket of the first attempt.
  const replay = await createCorrectionTicket(db, {
    requestId: REQUEST,
    subject: OPERATOR,
    domain: 'example.com',
    kind: 'category',
    detail: '这是一个开发者工具站',
  });
  assert.deepEqual(replay, { result: 'replayed', ticketId: created.ticketId });
  assert.equal(auditRows(raw, 'ticket.create').length, 1);

  const closed = await closeCorrectionTicket(db, {
    requestId: 'd4e5f6a7-b8c9-4d0e-8f1a-2b3c4d5e6f7a',
    subject: OPERATOR,
    ticketId: created.ticketId,
    status: 'resolved',
  });
  assert.deepEqual(closed, { result: 'applied' });
  const row = raw
    .prepare('SELECT status, closed_at FROM admin_correction_tickets WHERE id = ?')
    .get(created.ticketId) as { status: string; closed_at: string | null };
  assert.equal(row.status, 'resolved');
  assert.ok(row.closed_at);
  const closeRows = auditRows(raw, 'ticket.close');
  assert.equal(closeRows.length, 1);
  assert.deepEqual(JSON.parse(closeRows[0]!.before_json!), { status: 'open' });
  assert.deepEqual(JSON.parse(closeRows[0]!.after_json!), { status: 'resolved' });

  // The board keeps the ticket and shows its new state.
  const after = await readContentBoard(db);
  assert.equal(after.tickets.length, 1);
  assert.equal(after.tickets[0]?.status, 'resolved');
  assert.ok(after.tickets[0]?.closed_at);

  // Closing twice conflicts.
  assert.deepEqual(
    await closeCorrectionTicket(db, {
      requestId: 'e5f6a7b8-c9d0-4e1f-9a2b-3c4d5e6f7a8b',
      subject: OPERATOR,
      ticketId: created.ticketId,
      status: 'dismissed',
    }),
    { result: 'conflict' },
  );
  assert.equal(auditRows(raw, 'ticket.close').length, 1);
});

it('refuses an unusable correction ticket and an unknown ticket id', async () => {
  const { db, raw } = openSeededDb();
  const conflict = { result: 'conflict', ticketId: 0 };
  assert.deepEqual(
    await createCorrectionTicket(db, {
      requestId: REQUEST,
      subject: OPERATOR,
      domain: 'example.com',
      kind: 'nonsense',
      detail: '说明',
    }),
    conflict,
  );
  assert.deepEqual(
    await createCorrectionTicket(db, {
      requestId: REQUEST,
      subject: OPERATOR,
      domain: 'not a domain',
      kind: 'category',
      detail: '说明',
    }),
    conflict,
  );
  assert.deepEqual(
    await createCorrectionTicket(db, {
      requestId: REQUEST,
      subject: OPERATOR,
      domain: 'example.com',
      kind: 'category',
      detail: '   ',
    }),
    conflict,
  );
  assert.deepEqual(
    await createCorrectionTicket(db, {
      requestId: REQUEST,
      subject: OPERATOR,
      domain: 'example.com',
      kind: 'category',
      detail: 'x'.repeat(501),
    }),
    conflict,
  );
  assert.deepEqual(
    await closeCorrectionTicket(db, {
      requestId: REQUEST,
      subject: OPERATOR,
      ticketId: 4242,
      status: 'resolved',
    }),
    { result: 'conflict' },
  );
  assert.equal(
    raw.prepare('SELECT COUNT(*) AS n FROM admin_correction_tickets').get()?.n,
    0,
  );
});

it('spot checks the verified sites with the mailbox flag', async () => {
  const { db, raw } = openSeededDb();
  raw
    .prepare(
      `INSERT INTO owners (domain, verify_method, verified_at, email_hash, display_name, notify)
       VALUES (?, ?, ?, ?, ?, 1)`,
    )
    .run('example.com', 'dns-txt', '2026-11-02T00:00:00.000Z', 'hash-1', 'Example Inc');
  raw
    .prepare(
      `INSERT INTO owner_emails (domain, email_cipher, email_hash, verified_at, manage_token_hash, notify, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 1, ?, ?)`,
    )
    .run(
      'example.com',
      'cipher',
      'email-hash',
      '2026-11-03T00:00:00.000Z',
      'manage-hash',
      '2026-11-03T00:00:00.000Z',
      '2026-11-03T00:00:00.000Z',
    );
  raw.prepare('UPDATE sites SET verified = 1 WHERE domain = ?').run('coolsite.io');

  const board = await readContentBoard(db);
  assert.equal(board.verifiedSites.length, 2);
  const example = board.verifiedSites.find(site => site.domain === 'example.com');
  assert.deepEqual(example, {
    domain: 'example.com',
    title: 'Example',
    grade: 'A',
    verified_at: '2026-11-02T00:00:00.000Z',
    verify_method: 'dns-txt',
    mailbox_registered: 1,
  });
  const cool = board.verifiedSites.find(site => site.domain === 'coolsite.io');
  assert.equal(cool?.mailbox_registered, 0);
  assert.equal(cool?.verify_method, null);
  // The page never carries an address or a hash.
  const rendered = renderContentBoard(board).toString();
  assert.ok(!rendered.includes('email-hash'));
  assert.ok(!rendered.includes('manage-hash'));
  assert.ok(!rendered.includes('cipher'));
});

it('lists the sites in the other category for the reclassification tool', async () => {
  const { db, raw } = openSeededDb();
  addCategory(raw, 4, 'other');
  raw.prepare('UPDATE sites SET category_id = 4 WHERE domain = ?').run('coolsite.io');
  raw.prepare('UPDATE sites SET category_id = 4 WHERE domain = ?').run('neutral.net');
  raw.prepare('UPDATE sites SET title = NULL WHERE domain = ?').run('pending.dev');
  raw.prepare('UPDATE sites SET category_id = 4 WHERE domain = ?').run('pending.dev');

  const board = await readContentBoard(db);
  assert.equal(board.otherCount, 3);
  // Only the sites with a title are offered for a manual move.
  assert.deepEqual(board.otherSites.map(site => site.domain), ['coolsite.io', 'neutral.net']);
  assert.equal(board.otherSites[0]?.rank, 500);
  assert.deepEqual(board.categories.map(category => category.slug), [
    'tech',
    'dev-tools',
    'news',
    'other',
  ]);
});

it('writes the site change and its audit row in one transaction', async () => {
  const { db, raw } = openSeededDb();
  addCategory(raw, 4, 'other');
  addCategory(raw, 5, 'ecommerce');
  raw.exec(`CREATE TRIGGER fail_audit BEFORE INSERT ON admin_audit BEGIN
    SELECT RAISE(ABORT, 'audit insert required');
  END;`);

  // The audit row cannot be written, so neither can the site change.
  await assert.rejects(
    reclassifySites(db, {
      requestId: REQUEST,
      subject: OPERATOR,
      domains: ['example.com', 'coolsite.io'],
      categorySlug: 'ecommerce',
    }),
    /audit insert required/,
  );
  assert.equal(siteRow(raw, 'example.com').category_id, 2);
  assert.equal(siteRow(raw, 'example.com').category_override, null);
  assert.equal(siteRow(raw, 'coolsite.io').category_id, 2);
  assert.equal(siteRow(raw, 'coolsite.io').category_override, null);
  assert.equal(auditRows(raw, 'reclassify').length, 0);

  raw.exec('DROP TRIGGER fail_audit');
  const applied = await reclassifySites(db, {
    requestId: 'e6f7a8b9-c0d1-4f2a-8b3c-4d5e6f7a8b9c',
    subject: OPERATOR,
    domains: ['example.com', 'coolsite.io'],
    categorySlug: 'ecommerce',
  });
  assert.deepEqual(applied, { result: 'applied', changed: 2, skipped: [] });
  // Two sites moved, two audit rows — the site change and its trail agree.
  const moved = raw
    .prepare(`SELECT COUNT(*) AS n FROM sites WHERE COALESCE(category_override, category_id) = 5`)
    .get()?.n;
  assert.equal(moved, 2);
  assert.equal(auditRows(raw, 'reclassify').length, 2);
});

it('keeps a manual category when the rule-driven backfill rewrites the rules value', async () => {
  const { db, raw } = openSeededDb();
  addCategory(raw, 4, 'other');
  addCategory(raw, 5, 'ecommerce');

  const result = await reclassifySites(db, {
    requestId: REQUEST,
    subject: OPERATOR,
    domains: ['example.com'],
    categorySlug: 'ecommerce',
  });
  assert.deepEqual(result, { result: 'applied', changed: 1, skipped: [] });

  // This is what scripts/categorize-backfill.mjs does: it rewrites
  // category_id from the keyword rules. The manual label must survive it.
  raw.prepare('UPDATE sites SET category_id = 4 WHERE domain = ?').run('example.com');
  assert.equal(siteRow(raw, 'example.com').category_id, 4);
  assert.equal(siteRow(raw, 'example.com').category_override, 5);

  const effective = raw
    .prepare(
      `SELECT c.slug AS slug FROM sites s
       LEFT JOIN categories c ON c.id = COALESCE(s.category_override, s.category_id)
       WHERE s.domain = ?`,
    )
    .get('example.com') as { slug: string };
  assert.equal(effective.slug, 'ecommerce');

  // The board counts the effective category: the site is not in 'other' any more.
  const board = await readContentBoard(db);
  assert.equal(board.otherCount, 0);
});

it('renders the board with the shared console components', async () => {
  const { db, raw } = openSeededDb();
  addCategory(raw, 4, 'other');
  raw.prepare('UPDATE sites SET category_id = 4 WHERE domain = ?').run('coolsite.io');
  addClaim(raw, 'example.com', '<script>alert(1)</script>');
  await createCorrectionTicket(db, {
    requestId: REQUEST,
    subject: OPERATOR,
    domain: 'example.com',
    kind: 'other',
    detail: '分类不对',
  });

  const board = await readContentBoard(db);
  const html = renderContentBoard(board).toString();
  assert.ok(html.includes('href="/admin/content"'), 'the nav marks the current section');
  assert.ok(html.includes('name="claim_ids"'), 'the claim batch is a multi select');
  assert.ok(html.includes('name="decision"'), 'the claim decision is selected');
  assert.ok(html.includes('批准'));
  assert.ok(html.includes('驳回'));
  assert.ok(html.includes('name="domains"'), 'the reclassification batch is a multi select');
  assert.ok(html.includes('name="category"'), 'the target category is selected');
  assert.ok(html.includes('纠错工单'));
  assert.ok(html.includes('ticket.create'), 'the audit trail is shown');
  // The statement of a site owner is untrusted text and must be escaped.
  assert.ok(!html.includes('<script>alert(1)</script>'));
  assert.ok(html.includes('&lt;script&gt;'));
});
