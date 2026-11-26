// test/directory-alerts.test.ts — the additions/removals half of the live
// alerts: the published retirement map is the only signal, the directory
// state always flips, and only an active Pro mailbox gets the mail.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  fetchRetirementMap,
  reconcileDirectoryPresence,
  MAX_TRANSITIONS_PER_RUN,
} from '../src/directory-alerts.ts';
import { openSeededDb } from './helpers.ts';

async function seeded() {
  const { db, raw } = openSeededDb();
  const mailbox = async (domain: string, emailHash: string, notify = true) => {
    raw
      .prepare(
        `INSERT INTO owner_emails
           (domain, email_cipher, email_hash, manage_token_hash, verified_at, notify, created_at, updated_at)
         VALUES (?, 'fixture-cipher', ?, 'fixture-token', '2026-11-20', ?, '2026-11-20', '2026-11-20')`,
      )
      .run(domain, emailHash, notify ? 1 : 0);
  };
  const grantPro = (subject: string) => {
    const at = new Date().toISOString();
    raw
      .prepare(
        `INSERT INTO pro_entitlement_events
           (source_merchant_order_id, subject_id, kind, term_days, occurred_at, created_at)
         VALUES (?, ?, 'grant', 30, ?, ?)`,
      )
      .run(`pro-${subject}-fixture`, subject, at, at);
  };
  const status = (domain: string) =>
    (raw.prepare('SELECT status FROM sites WHERE domain = ?').get(domain) as { status: string } | undefined)?.status;
  const outbox = () =>
    raw
      .prepare('SELECT domain, event_key, event_type, status FROM notify_outbox ORDER BY id')
      .all() as { domain: string; event_key: string; event_type: string; status: string }[];
  return { db, raw, mailbox, grantPro, status, outbox };
}

const NOTE = { noteEn: 'Retired', noteZh: '已下线' };

describe('fetchRetirementMap', () => {
  const fetchOf = (impl: () => Response | Promise<Response>) => (() => impl()) as unknown as typeof fetch;

  it('returns the map when the published file is well-formed', async () => {
    const wellFormed = fetchOf(() => Response.json({ 'gone.test': NOTE }));
    const map = await fetchRetirementMap('https://afr.im', wellFormed);
    assert.deepEqual(map, { 'gone.test': NOTE });
  });

  it('returns null for 404, arrays, scalars and foreign shapes', async () => {
    const notFound = fetchOf(() => new Response('nope', { status: 404 }));
    assert.equal(await fetchRetirementMap('https://afr.im', notFound), null);

    const array = fetchOf(() => Response.json([{ name: 'x' }]));
    assert.equal(await fetchRetirementMap('https://afr.im', array), null);

    const scalar = fetchOf(() => Response.json('gone'));
    assert.equal(await fetchRetirementMap('https://afr.im', scalar), null);

    // object values that are not retirement notes must never read as a list
    const foreignObject = fetchOf(() => Response.json({ tree: { name: 'x', type: 'blob' } }));
    assert.equal(await fetchRetirementMap('https://afr.im', foreignObject), null);

    const foreignScalars = fetchOf(() => Response.json({ name: 'x', type: 'blob' }));
    assert.equal(await fetchRetirementMap('https://afr.im', foreignScalars), null);
  });

  it('returns null when the fetch fails', async () => {
    const boom = (() => Promise.reject(new Error('offline'))) as unknown as typeof fetch;
    assert.equal(await fetchRetirementMap('https://afr.im', boom), null);
  });
});

describe('reconcileDirectoryPresence', () => {
  it('writes nothing without a signal', async () => {
    const t = await seeded();
    const result = await reconcileDirectoryPresence(t.db, null);
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'no_signal');
    assert.equal(t.status('example.com'), 'active');
    assert.equal(t.outbox().length, 0);
  });

  it('retires a listed domain and mails its Pro owner', async () => {
    const t = await seeded();
    await t.mailbox('example.com', 'hash-a');
    t.grantPro('example.com');

    const result = await reconcileDirectoryPresence(t.db, { 'example.com': NOTE });
    assert.equal(result.ok, true);
    assert.equal(result.delisted, 1);
    assert.equal(result.relisted, 0);
    assert.equal(result.enqueued, 1);
    assert.equal(t.status('example.com'), 'delisted');

    const rows = t.outbox();
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.event_type, 'removed');
    assert.equal(rows[0]!.status, 'pending');
    assert.match(rows[0]!.event_key, /^example\.com\|removed\|/);

    // a replay in the same state changes nothing and mails nothing again
    const again = await reconcileDirectoryPresence(t.db, { 'example.com': NOTE });
    assert.equal(again.delisted, 0);
    assert.equal(t.outbox().length, 1);
  });

  it('retires the directory state but keeps the mail for Pro only', async () => {
    const t = await seeded();
    await t.mailbox('example.com', 'hash-a'); // mailbox, but no Pro term

    const result = await reconcileDirectoryPresence(t.db, { 'example.com': NOTE });
    assert.equal(result.delisted, 1, 'the state change is global and ungated');
    assert.equal(result.enqueued, 0, 'the mail is the Pro benefit');
    assert.equal(t.outbox().length, 0);
    assert.equal(t.status('example.com'), 'delisted');
  });

  it('skips the mail for a free or opted-out mailbox', async () => {
    const free = await seeded();
    await free.mailbox('example.com', 'hash-a');
    free.grantPro('example.com');
    free.raw.prepare('UPDATE owner_emails SET notify = 0 WHERE domain = ?').run('example.com');
    const result = await reconcileDirectoryPresence(free.db, { 'example.com': NOTE });
    assert.equal(result.delisted, 1);
    assert.equal(result.enqueued, 0);

    const noMailbox = await seeded();
    noMailbox.grantPro('example.com');
    const result2 = await reconcileDirectoryPresence(noMailbox.db, { 'example.com': NOTE });
    assert.equal(result2.delisted, 1);
    assert.equal(result2.enqueued, 0);
  });

  it('re-lists a retired domain that fell out of the map and mails its Pro owner', async () => {
    const t = await seeded();
    t.raw.prepare(`UPDATE sites SET status = 'delisted' WHERE domain = ?`).run('example.com');
    await t.mailbox('example.com', 'hash-a');
    t.grantPro('example.com');

    const result = await reconcileDirectoryPresence(t.db, {});
    assert.equal(result.relisted, 1);
    assert.equal(result.enqueued, 1);
    assert.equal(t.status('example.com'), 'active');
    assert.equal(t.outbox()[0]!.event_type, 'added');
  });

  it('leaves a still-retired domain alone', async () => {
    const t = await seeded();
    t.raw.prepare(`UPDATE sites SET status = 'delisted' WHERE domain = ?`).run('example.com');
    const result = await reconcileDirectoryPresence(t.db, { 'example.com': NOTE });
    assert.equal(result.relisted, 0);
    assert.equal(t.status('example.com'), 'delisted');
  });

  it('caps the flips of one run in both directions', async () => {
    const t = await seeded();
    const map: Record<string, unknown> = {};
    for (let i = 0; i < MAX_TRANSITIONS_PER_RUN + 20; i++) {
      const domain = `bulk${i}.test`;
      t.raw
        .prepare(
          `INSERT INTO sites (domain, category_id, grade, score_total, status, created_at, updated_at, scanned_at)
           VALUES (?, NULL, 'C', 50, 'active', '2026-11-01', '2026-11-10', '2026-11-10T10:00:00.000Z')`,
        )
        .run(domain);
      map[domain] = NOTE;
    }
    const result = await reconcileDirectoryPresence(t.db, map);
    assert.equal(result.delisted, MAX_TRANSITIONS_PER_RUN, 'a runaway signal degrades to slow, never to mass');
    const left = t.raw
      .prepare(`SELECT COUNT(*) AS n FROM sites WHERE status = 'active' AND domain LIKE 'bulk%.test'`)
      .get() as { n: number };
    assert.equal(left.n, 20);
  });
});
