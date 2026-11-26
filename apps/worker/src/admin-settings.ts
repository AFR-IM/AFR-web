// src/admin-settings.ts — the settings board of the administrator console
// (SSOT item 18, domain F).
//
// Three operator-editable settings live here, none of them hard-coded:
//   - `beneficiaries` — the OD9 beneficiary list (name / website / direction),
//   - `promo_wallet`  — the promo (Torch Boost) receiving address,
//   - `charity_pool`  — the charity pool receiving address.
//
// Every change is written to the shared append-only audit trail
// (src/admin-audit.ts): one row per changed setting, action `settings.update`,
// target `settings:<key>`, carrying the old and the new value. The business
// write and its audit row go into ONE `db.batch([...])`, which D1 executes
// inside a single transaction: a setting is never changed without its audit
// row, and an audit row never claims a change that did not happen.
//
// The charity pool address is published with a fingerprint (sha256 of the
// trimmed, lower-cased address). Every change of the pool appends one row to
// `charity_publications`, which is append-only (DB triggers block updates and
// deletes). The publication row is written in the SAME batch as the setting
// write and its audit row, so "published but not audited" cannot happen. The
// old addresses stay in the table and in the audit trail, so a fingerprint
// that was published once can always be traced back to the change that
// produced it (X12).
//
// The public charity endpoint of M10 (`GET /api/v1/charity`) reads the same
// data through `readPublicCharity()`; that function exposes no operator
// identity, no request id and no other internal field.

import { html } from 'hono/html';
import type { HtmlEscapedString } from 'hono/utils/html';
import { requestReserved, reserveRequestStatement } from './admin-audit.ts';
import { adminAlert, adminField, adminForm, adminNav, adminPanel, adminStat, adminTable } from './admin-ui.ts';
import type { Db } from './db.ts';
import { readTorchPool } from './torch.ts';

/** hono's `h` is typed as possibly async; this module never nests async
 * components, so the sync result is asserted once here. */
const h = (strings: TemplateStringsArray, ...values: unknown[]): HtmlEscapedString =>
  html(strings, ...values) as HtmlEscapedString;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** The three setting keys, each stored in its own `admin_settings` row. */
export const SETTING_BENEFICIARIES = 'beneficiaries';
export const SETTING_PROMO_WALLET = 'promo_wallet';
export const SETTING_CHARITY_POOL = 'charity_pool';

/** The audit action of every settings change. */
const AUDIT_ACTION = 'settings.update';

/** OD9 asks for 3..5 beneficiaries; fewer are allowed while the list is
 * still being confirmed. */
const BENEFICIARY_MAX = 5;
const NAME_MAX = 60;
const WEBSITE_MAX = 200;
const DIRECTION_MAX = 120;
/** An EVM (0x…), a base58 or a bech32 address — letters, digits, `:`, `_` and
 * `-` only. No spaces, no control characters. */
const ADDRESS_MAX = 120;
const ADDRESS_PATTERN = /^[A-Za-z0-9:_-]*$/;

/** How many published addresses the board shows. */
const HISTORY_LIMIT = 20;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Beneficiary {
  name: string;
  website: string;
  direction: string;
}

export interface SettingsSnapshot {
  beneficiaries: Beneficiary[];
  promoWallet: string;
  charityPool: string;
  updatedAt: string | null;
  updatedBy: string | null;
  poolFingerprint: string | null;
  poolPublishedAt: string | null;
  history: { address: string; fingerprint: string; published_at: string }[];
}

export interface SettingsResult {
  result: 'applied' | 'replayed' | 'conflict';
  /** The setting keys that really changed: 'beneficiaries' | 'promo_wallet' | 'charity_pool'. */
  changed: string[];
  poolChanged: boolean;
  /** The fingerprint of the charity pool address after the call. */
  fingerprint: string | null;
  /** A short Chinese reason, set when the result is 'conflict'. */
  error?: string;
}

export interface PublicCharity {
  beneficiaries: Beneficiary[];
  promoWallet: string;
  charityPool: string;
  fingerprint: string | null;
  publishedAt: string | null;
  history: { address: string; fingerprint: string; published_at: string }[];
  /** The boost pool block: raised against the $1,000 target, the moment the
   * target was first reached and the seven-day publication it triggers. */
  torch: { raised: number; target: number; crossedAt: string | null; publishedUntil: string | null };
}

/** The write input. `beneficiaries` accepts the array or the JSON array
 * string of the form field `beneficiaries_json` — the caller may hand over
 * the raw form value. */
export interface SettingsInput {
  requestId: string;
  subject: string;
  beneficiaries: Beneficiary[] | string;
  promoWallet: string;
  charityPool: string;
}

interface SettingRow {
  key: string;
  value_json: string;
  updated_at: string;
  updated_by: string;
}

interface PublicationRow {
  address: string;
  fingerprint: string;
  published_at: string;
}

// ---------------------------------------------------------------------------
// Normalisation and validation
// ---------------------------------------------------------------------------

/** The replay key. Empty when the caller sent nothing usable. */
function normalizeRequestId(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  const id = raw.trim();
  return id.length > 0 && id.length <= 128 ? id : '';
}

/** The authenticated operator. Never taken from the request body. */
function normalizeSubject(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  const subject = raw.trim();
  return subject.length > 0 && subject.length <= 256 ? subject : '';
}

type Checked<T> = { ok: true; value: T } | { ok: false; error: string };

/** One beneficiary row: a name, an http(s) website and a free direction. */
function normalizeBeneficiary(raw: unknown, index: number): Checked<Beneficiary> {
  const source = (raw ?? {}) as Record<string, unknown>;
  const name = typeof source.name === 'string' ? source.name.trim() : '';
  const website = typeof source.website === 'string' ? source.website.trim() : '';
  const direction = typeof source.direction === 'string' ? source.direction.trim() : '';

  if (name.length < 1 || name.length > NAME_MAX) {
    return { ok: false, error: `第 ${index + 1} 家受益人名称需为 1–${NAME_MAX} 字。` };
  }
  if (website.length < 1 || website.length > WEBSITE_MAX) {
    return { ok: false, error: `第 ${index + 1} 家受益人官网需为 1–${WEBSITE_MAX} 字。` };
  }
  let parsed: URL;
  try {
    parsed = new URL(website);
  } catch {
    return { ok: false, error: `第 ${index + 1} 家受益人官网不是合法 URL。` };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, error: `第 ${index + 1} 家受益人官网必须以 http:// 或 https:// 开头。` };
  }
  // A published link must not carry a login: the page is public.
  if (parsed.username || parsed.password) {
    return { ok: false, error: `第 ${index + 1} 家受益人官网不能包含账号或密码。` };
  }
  if (direction.length > DIRECTION_MAX) {
    return { ok: false, error: `第 ${index + 1} 家受益人方向最多 ${DIRECTION_MAX} 字。` };
  }
  return { ok: true, value: { name, website, direction } };
}

/** The beneficiary list of the write input. */
function normalizeBeneficiaries(raw: Beneficiary[] | string): Checked<Beneficiary[]> {
  let list: unknown = raw;
  if (typeof raw === 'string') {
    const text = raw.trim();
    if (text.length === 0) list = [];
    else {
      try {
        list = JSON.parse(text);
      } catch {
        return { ok: false, error: '受益人名单不是合法的 JSON 数组。' };
      }
    }
  }
  if (!Array.isArray(list)) return { ok: false, error: '受益人名单必须是数组。' };
  if (list.length > BENEFICIARY_MAX) {
    return { ok: false, error: `受益人名单最多 ${BENEFICIARY_MAX} 家。` };
  }
  const out: Beneficiary[] = [];
  for (let index = 0; index < list.length; index += 1) {
    const checked = normalizeBeneficiary(list[index], index);
    if (!checked.ok) return checked;
    out.push(checked.value);
  }
  return { ok: true, value: out };
}

/** A receiving address: trimmed, at most 120 characters, no space and no
 * control character. An empty address is legal — it means "not set yet". */
function normalizeAddress(raw: unknown, label: string): Checked<string> {
  if (typeof raw !== 'string') return { ok: false, error: `${label}必须是字符串。` };
  const value = raw.trim();
  if (value.length > ADDRESS_MAX) return { ok: false, error: `${label}最多 ${ADDRESS_MAX} 字。` };
  if (!ADDRESS_PATTERN.test(value)) {
    return { ok: false, error: `${label}只能包含字母、数字与 : _ - 符号。` };
  }
  return { ok: true, value };
}

/**
 * The beneficiary list of the rendered form.
 *
 * The form carries fifteen fields — `beneficiary_name_N`, `beneficiary_website_N`
 * and `beneficiary_direction_N` for N = 1..5 — and one hidden mirror,
 * `beneficiaries_json`, holding the JSON array of the list as stored.
 *
 * The caller SHOULD read the table rows (this helper) and fall back to
 * `beneficiaries_json` only when the form carries no row field at all: the
 * mirror is a snapshot of the stored list, so reading it alone would silently
 * drop the operator's edits.
 */
export function parseBeneficiaryForm(form: { get(name: string): string | null }): Beneficiary[] {
  const out: Beneficiary[] = [];
  for (let index = 0; index < BENEFICIARY_MAX; index += 1) {
    const position = index + 1;
    const name = (form.get(`beneficiary_name_${position}`) ?? '').trim();
    const website = (form.get(`beneficiary_website_${position}`) ?? '').trim();
    const direction = (form.get(`beneficiary_direction_${position}`) ?? '').trim();
    if (!name && !website && !direction) continue;
    out.push({ name, website, direction });
  }
  return out;
}

/**
 * The fingerprint of an address: sha256 of its canonical form.
 *
 * A hex address (0x…) is case-insensitive, so it is lower-cased. A base58 or
 * bech32 address is case-SENSITIVE — two addresses that differ only in case
 * are two different destinations, so their fingerprints must differ too.
 */
export async function fingerprintAddress(address: string): Promise<string> {
  const trimmed = address.trim();
  const canonical = trimmed.startsWith('0x') || trimmed.startsWith('0X') ? trimmed.toLowerCase() : trimmed;
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/** The stored rows of the three setting keys. */
async function readSettingRows(db: Db): Promise<Map<string, SettingRow>> {
  const rows = await db
    .prepare(
      `SELECT key, value_json, updated_at, updated_by FROM admin_settings
       WHERE key IN (?, ?, ?)`,
    )
    .all<SettingRow>(SETTING_BENEFICIARIES, SETTING_PROMO_WALLET, SETTING_CHARITY_POOL);
  const map = new Map<string, SettingRow>();
  for (const row of rows) map.set(row.key, row);
  return map;
}

/** The beneficiaries stored in one row. A broken value reads as an empty list
 * instead of breaking the whole board. */
function parseStoredBeneficiaries(valueJson: string | undefined): Beneficiary[] {
  if (valueJson === undefined) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(valueJson);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: Beneficiary[] = [];
  for (const item of parsed) {
    if (!item || typeof item !== 'object') continue;
    const source = item as Record<string, unknown>;
    const name = typeof source.name === 'string' ? source.name.trim() : '';
    const website = typeof source.website === 'string' ? source.website.trim() : '';
    const direction = typeof source.direction === 'string' ? source.direction.trim() : '';
    if (!name) continue;
    out.push({ name, website, direction });
  }
  return out;
}

/** A stored string setting. A broken value reads as an empty string. */
function parseStoredString(valueJson: string | undefined): string {
  if (valueJson === undefined) return '';
  try {
    const parsed = JSON.parse(valueJson);
    return typeof parsed === 'string' ? parsed.trim() : '';
  } catch {
    return valueJson.trim();
  }
}

/** The published pool addresses: the newest 20, oldest first. */
async function readPublications(db: Db): Promise<{ address: string; fingerprint: string; published_at: string }[]> {
  const rows = await db
    .prepare(
      `SELECT address, fingerprint, published_at FROM charity_publications
       ORDER BY published_at DESC, id DESC LIMIT ?`,
    )
    .all<PublicationRow>(HISTORY_LIMIT);
  return rows
    .map(row => ({ address: row.address, fingerprint: row.fingerprint, published_at: row.published_at }))
    .reverse();
}

/**
 * The settings board.
 *
 * `updatedAt` / `updatedBy` are the newest update of ANY of the three keys
 * (the row with the greatest `updated_at`; on a tie the charity pool wins,
 * then the promo wallet, then the beneficiary list). `poolFingerprint` and
 * `poolPublishedAt` come from the newest `charity_publications` row — they
 * are null while the pool address was never published.
 */
export async function readSettings(db: Db): Promise<SettingsSnapshot> {
  const [rows, history] = await Promise.all([readSettingRows(db), readPublications(db)]);
  const beneficiaryRow = rows.get(SETTING_BENEFICIARIES);
  const promoRow = rows.get(SETTING_PROMO_WALLET);
  const poolRow = rows.get(SETTING_CHARITY_POOL);

  const priority: Record<string, number> = {
    [SETTING_CHARITY_POOL]: 0,
    [SETTING_PROMO_WALLET]: 1,
    [SETTING_BENEFICIARIES]: 2,
  };
  const newest = [...rows.values()].sort((a, b) => {
    if (a.updated_at !== b.updated_at) return a.updated_at < b.updated_at ? 1 : -1;
    return (priority[a.key] ?? 9) - (priority[b.key] ?? 9);
  })[0];

  const latest = history.length ? history[history.length - 1] : undefined;
  return {
    beneficiaries: parseStoredBeneficiaries(beneficiaryRow?.value_json),
    promoWallet: parseStoredString(promoRow?.value_json),
    charityPool: parseStoredString(poolRow?.value_json),
    updatedAt: newest?.updated_at ?? null,
    updatedBy: newest?.updated_by ?? null,
    poolFingerprint: latest?.fingerprint ?? null,
    poolPublishedAt: latest?.published_at ?? null,
    history,
  };
}

/**
 * The public payload of `GET /api/v1/charity` — the single source of the
 * M10 charity page. It carries the beneficiary list, the two receiving
 * addresses, the fingerprint of the pool address and the published history.
 * No operator identity, no request id, no other internal field.
 */
export async function readPublicCharity(db: Db): Promise<PublicCharity> {
  const [snapshot, torch] = await Promise.all([readSettings(db), readTorchPool(db)]);
  return {
    beneficiaries: snapshot.beneficiaries,
    promoWallet: snapshot.promoWallet,
    charityPool: snapshot.charityPool,
    fingerprint: snapshot.poolFingerprint,
    publishedAt: snapshot.poolPublishedAt,
    history: snapshot.history,
    torch,
  };
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

/** True when the failure was the replay key rather than a bug. */
function isReplayViolation(error: unknown): boolean {
  const message = String((error as { message?: unknown } | null)?.message ?? error);
  return /UNIQUE constraint failed|append-only/i.test(message);
}

/** A rejected write: nothing was written, the fingerprint stays as it was. */
async function conflict(db: Db, error: string): Promise<SettingsResult> {
  return {
    result: 'conflict',
    changed: [],
    poolChanged: false,
    fingerprint: await currentFingerprint(db),
    error,
  };
}

/**
 * Write the three settings.
 *
 * Only the keys whose value really changed are written; a key with the same
 * value produces no row in `admin_settings` and no audit row, so a repeated
 * save does not add noise to the trail. The write, its audit rows and — when
 * the charity pool changed — the publication row go into one `db.batch`.
 *
 * Replaying the same request id (same action) is detected before the write
 * and returns 'replayed' without touching anything. A concurrent request with
 * the same id loses the race on the audit unique index; its whole batch rolls
 * back and it is reported as a replay as well.
 */
export async function writeSettings(db: Db, input: SettingsInput): Promise<SettingsResult> {
  const requestId = normalizeRequestId(input.requestId);
  const subject = normalizeSubject(input.subject);
  if (!requestId) return conflict(db, '缺少请求标识。');
  if (!subject) return conflict(db, '缺少操作人。');

  const beneficiaries = normalizeBeneficiaries(input.beneficiaries);
  if (!beneficiaries.ok) return conflict(db, beneficiaries.error);
  const promoWallet = normalizeAddress(input.promoWallet, '推广收款地址');
  if (!promoWallet.ok) return conflict(db, promoWallet.error);
  const charityPool = normalizeAddress(input.charityPool, '公益池收款地址');
  if (!charityPool.ok) return conflict(db, charityPool.error);

  // The replay key: a request id may claim the (action) only once.
  if (await requestReserved(db, requestId)) {
    const current = await readSettings(db);
    return { result: 'replayed', changed: [], poolChanged: false, fingerprint: current.poolFingerprint };
  }

  const rows = await readSettingRows(db);
  const beforeBeneficiaries = parseStoredBeneficiaries(rows.get(SETTING_BENEFICIARIES)?.value_json);
  const beforePromo = parseStoredString(rows.get(SETTING_PROMO_WALLET)?.value_json);
  const beforePool = parseStoredString(rows.get(SETTING_CHARITY_POOL)?.value_json);

  const changed: string[] = [];
  if (JSON.stringify(beneficiaries.value) !== JSON.stringify(beforeBeneficiaries)) changed.push(SETTING_BENEFICIARIES);
  if (promoWallet.value !== beforePromo) changed.push(SETTING_PROMO_WALLET);
  if (charityPool.value !== beforePool) changed.push(SETTING_CHARITY_POOL);

  const poolChanged = changed.includes(SETTING_CHARITY_POOL);
  const fingerprint = poolChanged ? await fingerprintAddress(charityPool.value) : null;

  // Nothing to do: the request is still claimed, so the same form cannot
  // act later on a value that changed in the meantime.
  if (changed.length === 0) {
    try {
      await db
        .prepare('INSERT INTO admin_requests (request_id, action, subject, created_at) VALUES (?, ?, ?, ?)')
        .run(requestId, AUDIT_ACTION, subject, new Date().toISOString());
    } catch (error) {
      if (isReplayViolation(error)) {
        const current = await readSettings(db);
        return { result: 'replayed', changed: [], poolChanged: false, fingerprint: current.poolFingerprint };
      }
      throw error;
    }
    const current = await readSettings(db);
    return { result: 'applied', changed: [], poolChanged: false, fingerprint: current.poolFingerprint };
  }

  // The view trigger reads the old value inside the transaction, writes the
  // audit row only when the value really changes, publishes the new pool
  // address with its fingerprint and stores the value — all in one statement.
  const writes: { sql: string; params: (string | number | null)[] }[] = [
    reserveRequestStatement({ requestId, action: AUDIT_ACTION, subject }),
  ];

  for (const key of changed) {
    let value: unknown;
    if (key === SETTING_BENEFICIARIES) value = beneficiaries.value;
    else if (key === SETTING_PROMO_WALLET) value = promoWallet.value;
    else value = charityPool.value;
    writes.push({
      sql: `INSERT INTO admin_setting_save (request_id, subject, key, value_json, fingerprint)
            VALUES (?, ?, ?, ?, ?)`,
      params: [requestId, subject, key, JSON.stringify(value), key === SETTING_CHARITY_POOL ? fingerprint : null],
    });
  }

  try {
    await db.batch(writes);
  } catch (error) {
    // A concurrent request with the same id won the race: it claimed the
    // (action) first, so this attempt — rolled back as a whole — is a replay.
    if (isReplayViolation(error) && (await requestReserved(db, requestId))) {
      const current = await readSettings(db);
      return { result: 'replayed', changed: [], poolChanged: false, fingerprint: current.poolFingerprint };
    }
    throw error;
  }

  return { result: 'applied', changed, poolChanged, fingerprint: poolChanged ? fingerprint : await currentFingerprint(db) };
}

/** The fingerprint of the newest published pool address. */
async function currentFingerprint(db: Db): Promise<string | null> {
  const history = await readPublications(db);
  return history.length ? history[history.length - 1]!.fingerprint : null;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/**
 * The F domain page. The caller wraps it into the console document.
 *
 * Wire contract of the form (the caller parses the fields and hands the
 * structure to `writeSettings`):
 *   - `beneficiaries_json` — the JSON array string of the beneficiary list.
 *     The editable table below is the operator's view of that list: it
 *     carries the fifteen fields `beneficiary_name_N`, `beneficiary_website_N`
 *     and `beneficiary_direction_N` (N = 1..5, the rows nobody uses stay
 *     empty). The caller should read the table rows first — `parseBeneficiaryForm(form)`
 *     does exactly that — and fall back to `beneficiaries_json` only when the
 *     form carries no row field at all; the hidden field is the machine-readable
 *     mirror of the stored list.
 *   - `promo_wallet` — the promo receiving address.
 *   - `charity_pool` — the charity pool receiving address.
 */
export function renderSettingsPage(
  snapshot: SettingsSnapshot,
  notice?: { kind: 'ok' | 'error'; text: string },
): HtmlEscapedString {
  const rows: HtmlEscapedString[] = [];
  for (let index = 0; index < BENEFICIARY_MAX; index += 1) {
    const beneficiary = snapshot.beneficiaries[index];
    const position = index + 1;
    rows.push(h`<tr>
      <th scope="row">${position}</th>
      <td><input name="beneficiary_name_${position}" value="${beneficiary?.name ?? ''}" maxlength="${NAME_MAX}"
        aria-label="第 ${position} 家受益人名称"></td>
      <td><input name="beneficiary_website_${position}" value="${beneficiary?.website ?? ''}" maxlength="${WEBSITE_MAX}"
        aria-label="第 ${position} 家受益人官网"></td>
      <td><input name="beneficiary_direction_${position}" value="${beneficiary?.direction ?? ''}" maxlength="${DIRECTION_MAX}"
        aria-label="第 ${position} 家受益人方向"></td>
    </tr>`);
  }
  const beneficiaryTable = adminTable(
    ['序号', '名称', '官网', '方向'],
    rows,
    '公益受益人名单：最多 5 家，未使用的行留空即可。',
  );
  const beneficiaryMirror = JSON.stringify(snapshot.beneficiaries);

  const fields = h`${beneficiaryTable}
    <input type="hidden" name="beneficiaries_json" value="${beneficiaryMirror}">
    ${adminField('推广收款地址 PROMO_WALLET', h`<input name="promo_wallet" value="${snapshot.promoWallet}" maxlength="${ADDRESS_MAX}" placeholder="未设置">`)}
    ${adminField('公益池收款地址 CHARITY_POOL', h`<input name="charity_pool" value="${snapshot.charityPool}" maxlength="${ADDRESS_MAX}" placeholder="未设置">`)}`;

  const form = adminForm('/admin/settings', crypto.randomUUID(), fields, '保存设置', '公益受益人名单与收款地址');

  const historyRows = snapshot.history.map(entry =>
    h`<tr>
      <td><code>${entry.address || '（未设置）'}</code></td>
      <td><code>${entry.fingerprint}</code></td>
      <td>${entry.published_at}</td>
    </tr>`,
  );
  const historyTable = adminTable(
    ['公益池地址', '地址指纹', '公示时间'],
    historyRows,
    '公益池地址的公示记录：只追加，不修改，历史地址永久可追溯。',
  );

  return h`${adminNav('/admin/settings')}
    ${notice ? adminAlert(notice.kind, notice.text) : ''}
    ${adminPanel('公益受益人名单与收款地址', h`${adminStat('受益人数量', String(snapshot.beneficiaries.length), `最多 ${BENEFICIARY_MAX} 家`)}
      ${adminStat('公示记录', String(snapshot.history.length))}
      <p class="muted">名单以表格为准，留空表示不用；保存后每次变更都会记入审计日志。</p>
      ${form}`)}
    ${adminPanel('公益地址指纹公示', h`${adminStat('当前公益池地址', snapshot.charityPool || '未设置')}
      ${adminStat('地址指纹', snapshot.poolFingerprint ?? '尚未公示')}
      ${adminStat('最近公示时间', snapshot.poolPublishedAt ?? '尚未公示')}
      ${historyTable}`)}`;
}
