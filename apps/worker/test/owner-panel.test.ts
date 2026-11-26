// test/owner-panel.test.ts — the multi-domain panel (GET /api/v1/owners/domains)
// and the competitor comparison (GET /api/v1/compare): token expansion by
// mailbox address, the Pro gate on the comparison, the category ranking and
// the window that shows the owner's neighbourhood.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createApp } from '../src/index.ts';
import { COMPARE_WINDOW } from '../src/owner-panel.ts';
import { openSeededDb } from './helpers.ts';
import { hashToken } from '../src/email.ts';

async function freshApp() {
  const { db, raw } = openSeededDb();
  const app = createApp({ db });

  const mailbox = async (domain: string, token: string, emailHash: string, verified = true) => {
    raw
      .prepare(
        `INSERT INTO owner_emails
           (domain, email_cipher, email_hash, manage_token_hash, verified_at, created_at, updated_at)
         VALUES (?, 'fixture-cipher', ?, ?, ?, '2026-11-20', '2026-11-20')`,
      )
      .run(domain, emailHash, await hashToken(token), verified ? '2026-11-20T00:00:00.000Z' : null);
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

  return { app, raw, mailbox, grantPro };
}

function get(app: ReturnType<typeof createApp>, url: string, token?: string) {
  return app.request(url, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
}

describe('GET /api/v1/owners/domains', () => {
  it('answers 401 without a token and for an unknown token', async () => {
    const { app } = await freshApp();
    assert.equal((await get(app, '/api/v1/owners/domains')).status, 401);
    assert.equal((await get(app, '/api/v1/owners/domains', 'not-a-token')).status, 401);
  });

  it('answers 401 for a token whose mailbox is not confirmed', async () => {
    const { app, mailbox } = await freshApp();
    await mailbox('example.com', 'pending-token', 'hash-a', false);
    assert.equal((await get(app, '/api/v1/owners/domains', 'pending-token')).status, 401);
  });

  it('expands one token to every domain confirmed under the same address', async () => {
    const { app, raw, mailbox, grantPro } = await freshApp();
    await mailbox('example.com', 'token-a', 'hash-a');
    await mailbox('coolsite.io', 'token-b', 'hash-a'); // same address, other domain
    await mailbox('neutral.net', 'token-other', 'hash-b'); // different address
    grantPro('example.com');

    const res = await get(app, '/api/v1/owners/domains', 'token-a');
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      primary: string;
      domains: { domain: string; grade: string | null; score: number | null; notify: boolean; pro: { active: boolean } }[];
    };
    assert.equal(body.primary, 'example.com');
    assert.deepEqual(
      body.domains.map((d) => d.domain),
      ['coolsite.io', 'example.com'],
      'the shared mailbox wins, ordered by domain; other addresses stay out',
    );
    const own = body.domains.find((d) => d.domain === 'example.com')!;
    assert.equal(own.grade, 'A');
    assert.equal(own.score, 92);
    assert.equal(own.notify, true);
    assert.equal(own.pro.active, true, 'the Pro term rides along per domain');
    const other = body.domains.find((d) => d.domain === 'coolsite.io')!;
    assert.equal(other.pro.active, false);
    void raw;
  });

  it('marks an opted-out mailbox as notify=false without hiding the domain', async () => {
    const { app, raw, mailbox } = await freshApp();
    await mailbox('example.com', 'token-a', 'hash-a');
    await mailbox('coolsite.io', 'token-b', 'hash-a');
    raw.prepare('UPDATE owner_emails SET notify = 0 WHERE domain = ?').run('coolsite.io');

    const body = (await (await get(app, '/api/v1/owners/domains', 'token-a')).json()) as {
      domains: { domain: string; notify: boolean }[];
    };
    const row = body.domains.find((d) => d.domain === 'coolsite.io')!;
    assert.equal(row.notify, false);
    assert.equal(body.domains.length, 2);
  });
});

describe('GET /api/v1/compare', () => {
  it('validates the domain and the credential before anything else', async () => {
    const { app, mailbox } = await freshApp();
    await mailbox('example.com', 'token-a', 'hash-a');
    assert.equal((await get(app, '/api/v1/compare?domain=', 'token-a')).status, 400);
    assert.equal((await get(app, '/api/v1/compare?domain=example.com')).status, 401);
    assert.equal((await get(app, '/api/v1/compare?domain=example.com', 'wrong')).status, 401);
    // the token of another domain may not open this domain's comparison
    await mailbox('coolsite.io', 'token-b', 'hash-b');
    assert.equal((await get(app, '/api/v1/compare?domain=example.com', 'token-b')).status, 401);
  });

  it('requires an active Pro term (403 pro_required)', async () => {
    const { app, mailbox } = await freshApp();
    await mailbox('example.com', 'token-a', 'hash-a');
    const res = await get(app, '/api/v1/compare?domain=example.com', 'token-a');
    assert.equal(res.status, 403);
    assert.deepEqual(await res.json(), { error: 'pro_required' });
  });

  it('returns the owner inside the category ranking once Pro is active', async () => {
    const { app, mailbox, grantPro } = await freshApp();
    await mailbox('example.com', 'token-a', 'hash-a');
    grantPro('example.com');

    const res = await get(app, '/api/v1/compare?domain=example.com', 'token-a');
    assert.equal(res.status, 200);
    const view = (await res.json()) as {
      domain: string;
      category: { slug: string | null } | null;
      you: { grade: string | null; score: number | null; rank: number; total: number };
      peers: { domain: string; grade: string | null; score: number | null; you: boolean }[];
    };
    assert.equal(view.domain, 'example.com');
    assert.equal(view.category?.slug, 'dev-tools');
    // dev-tools holds example.com (92) and coolsite.io (78); pending.dev has
    // no grade and never enters the ranking.
    assert.deepEqual(view.you, { grade: 'A', score: 92, rank: 1, total: 2 });
    assert.deepEqual(
      view.peers.map((p) => p.domain),
      ['example.com', 'coolsite.io'],
    );
    assert.equal(view.peers[0]!.you, true);
    assert.equal(view.peers[1]!.you, false);
  });

  it('shows the owner neighbourhood when the site sits below the top window', async () => {
    const { app, raw, mailbox, grantPro } = await freshApp();
    await mailbox('example.com', 'token-a', 'hash-a');
    grantPro('example.com');
    // 12 sites clearly stronger than example.com (92) in the same category:
    // the owner falls to rank 13 of 14.
    for (let i = 0; i < 12; i++) {
      raw
        .prepare(
          `INSERT INTO sites (domain, title, category_id, grade, score_total, status, created_at, updated_at, scanned_at)
           VALUES (?, ?, 2, 'B', ?, 'active', '2026-11-01', '2026-11-10', '2026-11-10T10:00:00.000Z')`,
        )
        .run(`strong${i}.test`, `Strong ${i}`, 93 + i);
    }

    const view = (await (await get(app, '/api/v1/compare?domain=example.com', 'token-a')).json()) as {
      you: { rank: number; total: number };
      peers: { domain: string }[];
    };
    assert.equal(view.you.rank, 13);
    assert.equal(view.you.total, 14);
    assert.ok(view.peers.length <= COMPARE_WINDOW, 'the window never exceeds its cap');
    assert.ok(
      view.peers.some((p) => p.domain === 'example.com'),
      'the owner is inside the window',
    );
    assert.equal(
      view.peers[view.peers.length - 1]!.domain,
      'coolsite.io',
      'the window runs past the owner to the next site below',
    );
  });

  it('respects the manual category override', async () => {
    const { app, raw, mailbox, grantPro } = await freshApp();
    await mailbox('example.com', 'token-a', 'hash-a');
    grantPro('example.com');
    // neutral.net (news) is manually re-labelled into dev-tools.
    raw.prepare('UPDATE sites SET category_override = 2 WHERE domain = ?').run('neutral.net');

    const view = (await (await get(app, '/api/v1/compare?domain=example.com', 'token-a')).json()) as {
      you: { rank: number; total: number };
      peers: { domain: string }[];
    };
    assert.equal(view.you.total, 3, 'example.com, coolsite.io and the overridden neutral.net');
    assert.ok(view.peers.some((p) => p.domain === 'neutral.net'));
  });
});
