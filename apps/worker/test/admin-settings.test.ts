// test/admin-settings.test.ts — the settings board of the administrator
// console (SSOT item 18, domain F): the OD9 beneficiary list, the two
// receiving addresses, the audit trail and the charity pool publication.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { it } from 'node:test';
import {
  fingerprintAddress,
  parseBeneficiaryForm,
  readPublicCharity,
  readSettings,
  renderSettingsPage,
  writeSettings,
  type Beneficiary,
} from '../src/admin-settings.ts';
import { openSeededDb } from './helpers.ts';

const SUBJECT = 'ops@afr.im';

const BENEFICIARIES: Beneficiary[] = [
  { name: '开源基金会', website: 'https://oss.example.org/', direction: '开源基础设施' },
  { name: '数字包容计划', website: 'https://incl.example.org/', direction: '数字包容' },
  { name: '普惠教育基金', website: 'http://edu.example.org/', direction: '普惠直接捐赠' },
];

const PROMO_WALLET = '0x9a3f21b7c4d5e6f708192a3b4c5d6e7f80910';
const CHARITY_POOL = '0x1122334455667788990011223344556677889900';

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

interface AuditRow {
  action: string;
  subject: string;
  target: string;
  before_json: string | null;
  after_json: string | null;
}

interface SettingRow {
  key: string;
  value_json: string;
  updated_by: string;
}

interface PublicationRow {
  address: string;
  fingerprint: string;
  request_id: string;
  subject: string;
  published_at: string;
}

function auditRows(raw: DatabaseSync): AuditRow[] {
  return raw
    .prepare('SELECT action, subject, target, before_json, after_json FROM admin_audit ORDER BY id ASC')
    .all() as unknown as AuditRow[];
}

function settingRows(raw: DatabaseSync): SettingRow[] {
  return raw
    .prepare('SELECT key, value_json, updated_by FROM admin_settings ORDER BY key ASC')
    .all() as unknown as SettingRow[];
}

function publicationRows(raw: DatabaseSync): PublicationRow[] {
  return raw
    .prepare('SELECT address, fingerprint, request_id, subject, published_at FROM charity_publications ORDER BY id ASC')
    .all() as unknown as PublicationRow[];
}

it('starts empty: no beneficiary, no address, no fingerprint, no publication', async () => {
  const { db } = openSeededDb();
  const snapshot = await readSettings(db);
  assert.deepEqual(snapshot.beneficiaries, []);
  assert.equal(snapshot.promoWallet, '');
  assert.equal(snapshot.charityPool, '');
  assert.equal(snapshot.updatedAt, null);
  assert.equal(snapshot.updatedBy, null);
  assert.equal(snapshot.poolFingerprint, null);
  assert.equal(snapshot.poolPublishedAt, null);
  assert.deepEqual(snapshot.history, []);
});

it('writes the three settings and audits every changed key', async () => {
  const { db, raw } = openSeededDb();
  const result = await writeSettings(db, {
    requestId: 'req-1',
    subject: SUBJECT,
    beneficiaries: BENEFICIARIES,
    promoWallet: PROMO_WALLET,
    charityPool: CHARITY_POOL,
  });
  assert.equal(result.result, 'applied');
  assert.deepEqual([...result.changed].sort(), ['beneficiaries', 'charity_pool', 'promo_wallet']);
  assert.equal(result.poolChanged, true);
  assert.equal(result.fingerprint, sha256(CHARITY_POOL));

  const snapshot = await readSettings(db);
  assert.deepEqual(snapshot.beneficiaries, BENEFICIARIES);
  assert.equal(snapshot.promoWallet, PROMO_WALLET);
  assert.equal(snapshot.charityPool, CHARITY_POOL);
  assert.equal(snapshot.updatedBy, SUBJECT);
  assert.ok(snapshot.updatedAt);
  assert.equal(snapshot.poolFingerprint, sha256(CHARITY_POOL));
  assert.ok(snapshot.poolPublishedAt);
  assert.equal(snapshot.history.length, 1);
  assert.deepEqual(snapshot.history[0], {
    address: CHARITY_POOL,
    fingerprint: sha256(CHARITY_POOL),
    published_at: snapshot.poolPublishedAt!,
  });

  const audit = auditRows(raw);
  assert.equal(audit.length, 3);
  assert.deepEqual(audit.map(row => row.target), [
    'settings:beneficiaries',
    'settings:promo_wallet',
    'settings:charity_pool',
  ]);
  for (const row of audit) {
    assert.equal(row.action, 'settings.update');
    assert.equal(row.subject, SUBJECT);
  }
  // The audit row carries the value under a "value" key: the trigger reads
  // the old value inside the transaction and writes the new one next to it.
  // All three keys are new, so there is no "before" value to report.
  assert.equal(audit[0]!.before_json, null);
  assert.equal(audit[0]!.after_json, JSON.stringify({ value: BENEFICIARIES }));
  assert.equal(audit[1]!.before_json, null);
  assert.equal(audit[1]!.after_json, JSON.stringify({ value: PROMO_WALLET }));
  assert.equal(audit[2]!.before_json, null);
  assert.equal(audit[2]!.after_json, JSON.stringify({ value: CHARITY_POOL }));

  const settings = settingRows(raw);
  assert.deepEqual(settings.map(row => row.key), ['beneficiaries', 'charity_pool', 'promo_wallet']);
  assert.equal(settings[0]!.value_json, JSON.stringify(BENEFICIARIES));
  assert.equal(settings[1]!.value_json, JSON.stringify(CHARITY_POOL));
  assert.equal(settings[2]!.value_json, JSON.stringify(PROMO_WALLET));
  for (const row of settings) assert.equal(row.updated_by, SUBJECT);
});

it('accepts the JSON array string of the form field', async () => {
  const { db } = openSeededDb();
  const result = await writeSettings(db, {
    requestId: 'req-json',
    subject: SUBJECT,
    beneficiaries: JSON.stringify(BENEFICIARIES),
    promoWallet: '',
    charityPool: '',
  });
  assert.equal(result.result, 'applied');
  assert.deepEqual(result.changed, ['beneficiaries']);
  assert.equal(result.poolChanged, false);
  assert.deepEqual((await readSettings(db)).beneficiaries, BENEFICIARIES);
});

it('writes nothing and adds no audit row when no value changed', async () => {
  const { db, raw } = openSeededDb();
  await writeSettings(db, {
    requestId: 'req-1',
    subject: SUBJECT,
    beneficiaries: BENEFICIARIES,
    promoWallet: PROMO_WALLET,
    charityPool: CHARITY_POOL,
  });
  const auditBefore = auditRows(raw).length;
  const publicationsBefore = publicationRows(raw).length;

  const result = await writeSettings(db, {
    requestId: 'req-2',
    subject: SUBJECT,
    beneficiaries: BENEFICIARIES,
    promoWallet: PROMO_WALLET,
    charityPool: CHARITY_POOL,
  });
  assert.equal(result.result, 'applied');
  assert.deepEqual(result.changed, []);
  assert.equal(result.poolChanged, false);
  assert.equal(auditRows(raw).length, auditBefore);
  assert.equal(publicationRows(raw).length, publicationsBefore);
});

it('replays the same request id without writing anything', async () => {
  const { db, raw } = openSeededDb();
  const input = {
    requestId: 'req-1',
    subject: SUBJECT,
    beneficiaries: BENEFICIARIES,
    promoWallet: PROMO_WALLET,
    charityPool: CHARITY_POOL,
  };
  assert.equal((await writeSettings(db, input)).result, 'applied');
  const settingsBefore = settingRows(raw);
  const auditBefore = auditRows(raw).length;
  const publicationsBefore = publicationRows(raw).length;

  const replay = await writeSettings(db, input);
  assert.equal(replay.result, 'replayed');
  assert.deepEqual(replay.changed, []);
  assert.equal(replay.poolChanged, false);
  assert.deepEqual(settingRows(raw), settingsBefore);
  assert.equal(auditRows(raw).length, auditBefore);
  assert.equal(publicationRows(raw).length, publicationsBefore);
});

it('publishes the pool address with its fingerprint and keeps the old addresses', async () => {
  const { db, raw } = openSeededDb();
  await writeSettings(db, {
    requestId: 'req-1',
    subject: SUBJECT,
    beneficiaries: [],
    promoWallet: PROMO_WALLET,
    charityPool: CHARITY_POOL,
  });
  const first = publicationRows(raw);
  assert.equal(first.length, 1);
  assert.equal(first[0]!.address, CHARITY_POOL);
  assert.equal(first[0]!.fingerprint, sha256(CHARITY_POOL));
  assert.equal(first[0]!.request_id, 'req-1');
  assert.equal(first[0]!.subject, SUBJECT);

  // The same address under another request id is not a change: no new row.
  const same = await writeSettings(db, {
    requestId: 'req-2',
    subject: SUBJECT,
    beneficiaries: [],
    promoWallet: PROMO_WALLET,
    charityPool: CHARITY_POOL,
  });
  assert.equal(same.poolChanged, false);
  assert.equal(publicationRows(raw).length, 1);

  // A new address publishes a new row; the old address stays in the history.
  const changed = await writeSettings(db, {
    requestId: 'req-3',
    subject: SUBJECT,
    beneficiaries: [],
    promoWallet: PROMO_WALLET,
    charityPool: '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  });
  assert.equal(changed.poolChanged, true);
  assert.equal(changed.fingerprint, sha256('0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'));
  const publications = publicationRows(raw);
  assert.equal(publications.length, 2);
  assert.equal(publications[1]!.fingerprint, sha256('0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'));

  const snapshot = await readSettings(db);
  assert.equal(snapshot.history.length, 2);
  assert.equal(snapshot.history[0]!.address, CHARITY_POOL);
  assert.equal(snapshot.history[1]!.address, '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');
  assert.equal(snapshot.poolFingerprint, snapshot.history[1]!.fingerprint);
  assert.equal(snapshot.poolPublishedAt, snapshot.history[1]!.published_at);
  assert.equal(snapshot.charityPool, '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');
});

it('fingerprintAddress hashes the trimmed, lower-cased address', async () => {
  assert.equal(await fingerprintAddress('  0xAbC  '), sha256('0xabc'));
  assert.equal(await fingerprintAddress(''), sha256(''));
});

it('rejects invalid input without touching a single row', async () => {
  const { db, raw } = openSeededDb();
  await writeSettings(db, {
    requestId: 'req-1',
    subject: SUBJECT,
    beneficiaries: BENEFICIARIES,
    promoWallet: PROMO_WALLET,
    charityPool: CHARITY_POOL,
  });
  const settingsBefore = settingRows(raw);
  const auditBefore = auditRows(raw).length;
  const publicationsBefore = publicationRows(raw).length;

  const base = {
    requestId: 'req-bad',
    subject: SUBJECT,
    beneficiaries: BENEFICIARIES,
    promoWallet: PROMO_WALLET,
    charityPool: CHARITY_POOL,
  };
  const cases: { label: string; input: Partial<typeof base> & Record<string, unknown> }[] = [
    { label: 'too many beneficiaries', input: { beneficiaries: [...BENEFICIARIES, ...BENEFICIARIES, ...BENEFICIARIES] } },
    { label: 'illegal website', input: { beneficiaries: [{ name: 'A', website: 'not a url', direction: '' }] } },
    { label: 'non http website', input: { beneficiaries: [{ name: 'A', website: 'ftp://a.example', direction: '' }] } },
    { label: 'empty name', input: { beneficiaries: [{ name: '   ', website: 'https://a.example', direction: '' }] } },
    { label: 'long name', input: { beneficiaries: [{ name: 'x'.repeat(61), website: 'https://a.example', direction: '' }] } },
    { label: 'long direction', input: { beneficiaries: [{ name: 'A', website: 'https://a.example', direction: 'x'.repeat(121) }] } },
    { label: 'long website', input: { beneficiaries: [{ name: 'A', website: `https://a.example/${'x'.repeat(200)}`, direction: '' }] } },
    { label: 'address with a space', input: { charityPool: '0x1234 5678' } },
    { label: 'address with a control character', input: { promoWallet: '0x1234\n5678' } },
    { label: 'too long address', input: { charityPool: '0x' + 'a'.repeat(120) } },
    { label: 'empty request id', input: { requestId: '  ' } },
    { label: 'empty subject', input: { subject: '' } },
    { label: 'broken json', input: { beneficiaries: '{oops' } },
  ];

  for (const testCase of cases) {
    const result = await writeSettings(db, { ...base, ...testCase.input } as typeof base);
    assert.equal(result.result, 'conflict', testCase.label);
    assert.deepEqual(result.changed, [], testCase.label);
    assert.equal(result.poolChanged, false, testCase.label);
    assert.ok(result.error && result.error.length > 0, testCase.label);
    assert.deepEqual(settingRows(raw), settingsBefore, testCase.label);
    assert.equal(auditRows(raw).length, auditBefore, testCase.label);
    assert.equal(publicationRows(raw).length, publicationsBefore, testCase.label);
  }
});

it('parses the beneficiary rows of the rendered form', () => {
  const form = new FormData();
  form.set('beneficiary_name_1', ' 开源基金会 ');
  form.set('beneficiary_website_1', ' https://a.example/ ');
  form.set('beneficiary_direction_1', '');
  form.set('beneficiary_name_3', 'B');
  form.set('beneficiary_website_3', 'https://b.example');
  form.set('beneficiary_direction_3', '普惠');
  assert.deepEqual(parseBeneficiaryForm(form), [
    { name: '开源基金会', website: 'https://a.example/', direction: '' },
    { name: 'B', website: 'https://b.example', direction: '普惠' },
  ]);
});

it('the public payload carries no operator, request id or subject', async () => {
  const { db } = openSeededDb();
  await writeSettings(db, {
    requestId: 'req-secret',
    subject: SUBJECT,
    beneficiaries: BENEFICIARIES,
    promoWallet: PROMO_WALLET,
    charityPool: CHARITY_POOL,
  });
  const payload = await readPublicCharity(db);
  assert.deepEqual(Object.keys(payload).sort(), [
    'beneficiaries',
    'charityPool',
    'fingerprint',
    'history',
    'promoWallet',
    'publishedAt',
  ]);
  assert.deepEqual(payload.beneficiaries, BENEFICIARIES);
  assert.equal(payload.promoWallet, PROMO_WALLET);
  assert.equal(payload.charityPool, CHARITY_POOL);
  assert.equal(payload.fingerprint, sha256(CHARITY_POOL));
  assert.ok(payload.publishedAt);
  assert.equal(payload.history.length, 1);
  const serialized = JSON.stringify(payload);
  assert.ok(!serialized.includes(SUBJECT));
  assert.ok(!serialized.includes('req-secret'));
  assert.ok(!serialized.includes('updatedBy'));
  assert.ok(!serialized.includes('requestId'));
  assert.ok(!serialized.includes('subject'));
});

it('rolls the whole batch back when one statement fails', async () => {
  const { db, raw } = openSeededDb();
  await writeSettings(db, {
    requestId: 'req-1',
    subject: SUBJECT,
    beneficiaries: BENEFICIARIES,
    promoWallet: PROMO_WALLET,
    charityPool: CHARITY_POOL,
  });
  const settingsBefore = settingRows(raw);
  const auditBefore = auditRows(raw).length;
  const publicationsBefore = publicationRows(raw).length;

  raw.exec(`CREATE TRIGGER fail_publication BEFORE INSERT ON charity_publications
    BEGIN SELECT RAISE(ABORT, 'publication blocked'); END;`);

  await assert.rejects(
    writeSettings(db, {
      requestId: 'req-2',
      subject: SUBJECT,
      beneficiaries: [],
      promoWallet: PROMO_WALLET,
      charityPool: '0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
    }),
    /publication blocked/,
  );
  assert.deepEqual(settingRows(raw), settingsBefore);
  assert.equal(auditRows(raw).length, auditBefore);
  assert.equal(publicationRows(raw).length, publicationsBefore);

  raw.exec('DROP TRIGGER fail_publication');
  const retry = await writeSettings(db, {
    requestId: 'req-3',
    subject: SUBJECT,
    beneficiaries: [],
    promoWallet: PROMO_WALLET,
    charityPool: '0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
  });
  assert.equal(retry.result, 'applied');
  assert.equal(publicationRows(raw).length, publicationsBefore + 1);
});

it('renders the settings page with the form, the notice and the publication trail', async () => {
  const { db } = openSeededDb();
  await writeSettings(db, {
    requestId: 'req-1',
    subject: SUBJECT,
    beneficiaries: BENEFICIARIES,
    promoWallet: PROMO_WALLET,
    charityPool: CHARITY_POOL,
  });
  const snapshot = await readSettings(db);
  const page = renderSettingsPage(snapshot, { kind: 'ok', text: '设置已保存。' }).toString();
  assert.ok(page.includes('href="/admin/settings"'));
  assert.ok(page.includes('aria-current="page"'));
  assert.ok(page.includes('action="/admin/settings"'));
  assert.ok(page.includes('name="beneficiaries_json"'));
  assert.ok(page.includes('name="promo_wallet"'));
  assert.ok(page.includes('name="charity_pool"'));
  assert.ok(page.includes('name="beneficiary_name_1"'));
  assert.ok(page.includes('name="beneficiary_name_5"'));
  assert.ok(page.includes('name="beneficiary_website_1"'));
  assert.ok(page.includes('name="beneficiary_direction_1"'));
  assert.ok(page.includes('设置已保存。'));
  assert.ok(page.includes(sha256(CHARITY_POOL)));
  assert.ok(page.includes(CHARITY_POOL));
  assert.ok(!page.includes('<style>'), 'the page must not carry its own CSS');
});
