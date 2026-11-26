// src/charity.ts — the public donation ledger and the execution registry.
//
// Two directions, one file: every boost that entered the pool (tx hash of
// the AIPAY payment) and every donation that left it (tx hash of the
// operator's transfer), with each donation carrying the inbound hashes it
// was funded by — the ledger and the chain point at each other.
//
// The registry is append-only: `charity_donations` refuses UPDATE and
// DELETE at the trigger level, the write path is a view that also writes
// the audit row, and nothing in this module can remove a line. That is the
// Trust posture — a charity that cannot quietly edit its own book.

import { plainText } from './ads.ts';
import { requestReserved, reserveRequestStatement } from './admin-audit.ts';
import type { Db } from './db.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EVM_TX = /^0x[0-9a-fA-F]{64}$/;
const AMOUNT = /^\d{1,6}(\.\d{1,2})?$/;
/** Page bounds: the public ledger is a recent window, not the whole book. */
const INFLOW_LIMIT = 100;
const DONATION_LIMIT = 100;
const ATTRIBUTION_PAGE = 500;
const ATTRIBUTION_MAX_PAGES = 8;
const FUNDED_CAP = 200;

export interface CharityLedgerEntry {
  kind: 'torch_in' | 'donation_out';
  id: string;
  amount: string;
  domain?: string;
  beneficiary?: string;
  txHash: string;
  at: string;
  fundedInTx?: string[];
  anchor: string;
}

export interface CharityLedger {
  generatedAt: string;
  entries: CharityLedgerEntry[];
}

function parseFunded(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((value): value is string => typeof value === 'string' && value.length <= 100).slice(0, FUNDED_CAP);
  } catch {
    return [];
  }
}

/** Recent inflows and outflows, newest first (both directions interleaved). */
export async function readCharityLedger(db: Db, { now = new Date() }: { now?: Date } = {}): Promise<CharityLedger> {
  const inflows = await db
    .prepare(
      `SELECT id, domain, amount, tx_hash, paid_at
         FROM torch_purchases
        WHERE status = 'paid' AND tx_hash IS NOT NULL AND paid_at IS NOT NULL
        ORDER BY paid_at DESC, id DESC LIMIT ?`,
    )
    .all<{ id: number; domain: string; amount: string; tx_hash: string; paid_at: string }>(INFLOW_LIMIT);
  const donations = await db
    .prepare(
      `SELECT id, amount, tx_hash, beneficiary, funded_in_tx, executed_at
         FROM charity_donations
        ORDER BY executed_at DESC, id DESC LIMIT ?`,
    )
    .all<{ id: number; amount: string; tx_hash: string; beneficiary: string; funded_in_tx: string; executed_at: string }>(
      DONATION_LIMIT,
    );

  const entries: CharityLedgerEntry[] = [];
  for (const row of inflows) {
    entries.push({
      kind: 'torch_in',
      id: String(row.id),
      amount: row.amount,
      domain: row.domain,
      txHash: row.tx_hash,
      at: row.paid_at,
      anchor: `torch-${row.id}`,
    });
  }
  for (const row of donations) {
    const funded = parseFunded(row.funded_in_tx);
    entries.push({
      kind: 'donation_out',
      id: String(row.id),
      amount: row.amount,
      beneficiary: row.beneficiary,
      txHash: row.tx_hash,
      at: row.executed_at,
      anchor: `donation-${row.id}`,
      ...(funded.length ? { fundedInTx: funded } : {}),
    });
  }
  entries.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : a.kind === b.kind ? 0 : a.kind === 'donation_out' ? -1 : 1));
  return { generatedAt: now.toISOString(), entries };
}

/**
 * The inbound transactions not yet attributed to a donation, earliest
 * first. Scanned in pages so an already-attributed prefix never hides the
 * rows behind it.
 */
async function unattributedInflows(db: Db, used: Set<string>, until: string): Promise<{ txHash: string; amount: number }[]> {
  const picked: { txHash: string; amount: number }[] = [];
  let offset = 0;
  for (let page = 0; page < ATTRIBUTION_MAX_PAGES; page += 1) {
    const rows = await db
      .prepare(
        `SELECT tx_hash, amount FROM torch_purchases
          WHERE status = 'paid' AND tx_hash IS NOT NULL AND paid_at IS NOT NULL AND paid_at <= ?
          ORDER BY paid_at ASC, id ASC LIMIT ? OFFSET ?`,
      )
      .all<{ tx_hash: string; amount: string }>(until, ATTRIBUTION_PAGE, offset);
    if (rows.length === 0) break;
    for (const row of rows) {
      if (used.has(row.tx_hash)) continue;
      picked.push({ txHash: row.tx_hash, amount: Number(row.amount) });
    }
    offset += rows.length;
    if (rows.length < ATTRIBUTION_PAGE) break;
  }
  return picked;
}

export interface RecordDonationInput {
  requestId: string;
  subject: string;
  amount: string;
  txHash: string;
  beneficiary: string;
  note?: string | null;
  now?: Date;
}

export type RecordDonationResult = { result: 'applied' | 'replayed' } | { result: 'conflict'; error: string };

/**
 * Register one executed donation: amount, outbound tx hash and a member of
 * the pre-vetted beneficiary list, plus the inbound hashes that funded it (the
 * chain↔ledger cross-reference). Business write + audit row happen in one
 * statement through `admin_charity_record`, with the request id reserved in
 * the same batch.
 */
export async function recordCharityDonation(db: Db, input: RecordDonationInput): Promise<RecordDonationResult> {
  const requestId = input.requestId?.trim().toLowerCase() ?? '';
  const subject = input.subject?.trim() ?? '';
  if (!UUID.test(requestId) || !subject || subject.length > 256) {
    return { result: 'conflict', error: '登记参数无效。' };
  }
  const amount = input.amount?.trim() ?? '';
  if (!AMOUNT.test(amount) || !(Number(amount) > 0)) return { result: 'conflict', error: '捐赠金额不合法。' };
  const txHash = input.txHash?.trim() ?? '';
  if (!EVM_TX.test(txHash)) return { result: 'conflict', error: '交易哈希须为 0x 开头的 64 位十六进制。' };
  const beneficiary = input.beneficiary?.trim() ?? '';
  if (!beneficiary || beneficiary.length > 200) return { result: 'conflict', error: '请选择受益人。' };
  const note = plainText(input.note ?? '', 500);
  if (note === null) return { result: 'conflict', error: '备注不能超过 500 字。' };

  // The beneficiary must be a member of the published pre-vetted list —
  // the same check the write view repeats inside the transaction.
  const settings = await db
    .prepare(`SELECT value_json FROM admin_settings WHERE key = 'beneficiaries'`)
    .get<{ value_json: string }>();
  let listed = false;
  try {
    const parsed: unknown = JSON.parse(settings?.value_json ?? '[]');
    listed = Array.isArray(parsed) && parsed.some((item) =>
      !!item && typeof item === 'object' && (item as { name?: unknown }).name === beneficiary);
  } catch {
    listed = false;
  }
  if (!listed) return { result: 'conflict', error: '受益人不在预审名单中。' };

  if (await requestReserved(db, requestId)) return { result: 'replayed' };

  const stamp = (input.now ?? new Date()).toISOString();
  const used = new Set<string>();
  for (const row of await db.prepare('SELECT funded_in_tx FROM charity_donations').all<{ funded_in_tx: string }>()) {
    for (const hash of parseFunded(row.funded_in_tx)) used.add(hash);
  }
  const candidates = await unattributedInflows(db, used, stamp);
  const funded: string[] = [];
  let remaining = Number(amount);
  for (const row of candidates) {
    if (funded.length >= FUNDED_CAP || remaining <= 0) break;
    funded.push(row.txHash);
    remaining -= row.amount;
  }

  try {
    await db.batch([
      reserveRequestStatement({ requestId, action: 'charity.record', subject, createdAt: stamp }),
      {
        sql: `INSERT INTO admin_charity_record (request_id, subject, amount, tx_hash, beneficiary, funded_in_tx, note, now)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        params: [requestId, subject, amount, txHash, beneficiary, JSON.stringify(funded), note, stamp],
      },
    ]);
  } catch (error) {
    const message = String(error);
    if (/UNIQUE constraint failed:\s*admin_requests\.request_id\b/i.test(message) && await requestReserved(db, requestId)) {
      return { result: 'replayed' };
    }
    if (message.includes('charity_tx_duplicate')) return { result: 'conflict', error: '该交易哈希已登记过。' };
    if (message.includes('charity_beneficiary_unknown')) return { result: 'conflict', error: '受益人不在预审名单中。' };
    if (message.includes('charity_amount_invalid') || message.includes('charity_tx_invalid')) {
      return { result: 'conflict', error: '登记内容不合法。' };
    }
    if (message.includes('charity_admin_request_required')) {
      return { result: 'conflict', error: '请求标识无效，请刷新页面重试。' };
    }
    throw error;
  }
  return { result: 'applied' };
}
