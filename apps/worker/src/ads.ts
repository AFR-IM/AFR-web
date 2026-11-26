import { html } from 'hono/html';
import type { HtmlEscapedString } from 'hono/utils/html';
import { requestReserved, reserveRequestStatement } from './admin-audit.ts';
import { adminField, adminForm, adminPanel, adminTable } from './admin-ui.ts';
import { createBillingOrder, type AipayEnv, type BillingStatus } from './aipay.ts';
import { ownerOwnsDomain, resolveSiteKey } from './commercial.ts';
import type { Db, SqlParam } from './db.ts';
import { normalizeDomain } from './domain.ts';

export const ADS_ADMIN_PATH = '/admin/commercial/ads';
export const AD_REPORT_REASONS = ['misleading', 'spam', 'inappropriate', 'other'] as const;
const ASSET = 'USDC';
const CHAIN = 'base';
const DAY = 86_400_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CATEGORY = /^[a-z0-9][a-z0-9-]{0,79}$/;
const OFFERED_SLOTS = ['category-top', 'search-top', 'home-supporter', 'report-sponsor'] as const;
export const CONTROL = /[\p{Cc}\p{Cf}\p{Cs}]/u;
export const MISLEADING = /官方(?:认证|推荐|认可|指定|授权|合作)|权威认证|行业(?:第[一1]|领先)|第[一1]名|排名第[一1]|全网第[一1]|(?:afr|afr\.im)(?:认证|推荐|官方|合作)|#\s*1(?!\d)|\b(?:no\.?\s*1(?!\d)|number\s+one|ranked\s+(?:first|1st)|best[\s-]+in[\s-]+class|official(?:ly)?[\s-]+(?:certified|endorsed|recommended|approved)|(?:certified|endorsed|recommended|approved)\s+by\s+afr)\b/iu;

export type AdSlot = typeof OFFERED_SLOTS[number];
export type AdDecision = 'approve' | 'reject' | 'pause' | 'resume';
type PlacementStatus = 'pending' | 'active' | 'paused' | 'expired' | 'rejected';
type Failure = { ok: false; status: 400 | 401 | 403 | 404 | 409 | 429 | 502 | 503; error: string };
const fail = (status: Failure['status'], error: string): Failure => ({ ok: false, status, error });

export interface PublicAd {
  id: number;
  domain: string;
  slot: AdSlot;
  slot_key: string | null;
  headline: string;
  body: string;
  starts_at: string;
  ends_at: string;
  status: 'active';
  impressions: number;
  clicks: number;
  grade: 'A' | 'B' | 'C' | 'D' | 'E' | 'F';
  score: number;
}

export interface AdOrder {
  orderId: string;
  adId: number;
  domain: string;
  reference: string | null;
  checkoutUrl?: string;
  expiresAt: string | null;
  amount: string;
  asset: string;
  chainKey: string;
  termDays: number;
  status: PlacementStatus | 'paid' | 'scheduled' | 'cancelled' | 'review';
  paid: boolean;
  startsAt: string | null;
  endsAt: string | null;
}

export interface AdOffer {
  slot: AdSlot;
  amount: number;
  term_days: number;
  capacity: number;
  available: number;
}

export function readAdOffers(db: Db): Promise<AdOffer[]> {
  return db.prepare('SELECT slot, amount, term_days, capacity, available FROM ad_offers WHERE available = 1').all<AdOffer>();
}

interface CheckoutRow {
  id: number;
  domain: string;
  slot: AdSlot;
  slot_key: string | null;
  headline: string;
  body: string;
  starts_at: string | null;
  ends_at: string | null;
  status: PlacementStatus;
  created_at: string;
  merchant_order_id: string;
  amount: string;
  asset: string;
  chain_key: string;
  term_days: number;
  billing_status: BillingStatus | null;
  paid: number;
  approved: number;
  eligible_site: number;
  checkout_closed: number;
  aipay_reference: string | null;
  checkout_url: string | null;
  checkout_expires_at: string | null;
  review_note: string | null;
  reviewed_at: string | null;
}

type OrderResult = { ok: true; status: 200 | 201; order: AdOrder } | Failure;

export function plainText(value: unknown, max: number): string | null {
  if (typeof value !== 'string' || value.length > max * 2 + 32 || CONTROL.test(value)) return null;
  const text = value.trim();
  return Array.from(text).length <= max ? text : null;
}

/** Unicode default case fold following NFKC, preserving the dotless i. */
function searchKey(value: string): string | null {
  if (value.length > 192 || CONTROL.test(value)) return null;
  const folded = [...value.normalize('NFKC').trim()].map(char => {
    // Cherokee folds to uppercase. Capital sharp S must expand just as ß does.
    if (char === 'ı') return char;
    if (char === 'ẞ') return 'ss';
    if (/[\u13a0-\u13fd\uab70-\uabbf]/u.test(char)) return char.toUpperCase();
    return char.toUpperCase().toLowerCase();
  }).join('');
  return folded && [...folded].length <= 80 ? folded : null;
}

function publicDomain(domain: string): boolean {
  return typeof domain === 'string' && normalizeDomain(domain) === domain;
}

export async function listActiveAds(db: Db, { slot, key, now = new Date() }: {
  slot?: string;
  key?: string;
  now?: Date;
} = {}): Promise<PublicAd[]> {
  let where = '';
  const params: SqlParam[] = [];
  if (slot !== undefined) {
    where = ' AND slot = ?';
    params.push(slot);
    if (slot === 'search-top' || slot === 'category-top') {
      const scoped = slot === 'search-top' && typeof key === 'string' ? searchKey(key) : key;
      if (!scoped || (slot === 'category-top' && !CATEGORY.test(scoped))) return [];
      where += ' AND slot_key = ?';
      params.push(scoped);
    } else if (slot !== 'home-supporter' || (key !== undefined && key !== '')) {
      return [];
    }
  } else {
    if (key !== undefined) return [];
    where = " AND slot <> 'search-top'";
  }
  const stamp = now.toISOString();
  const rows = await db.prepare(`SELECT * FROM approved_ad_placements
    WHERE starts_at <= ? AND ends_at > ?${where} ORDER BY starts_at DESC, id DESC LIMIT 20`)
    .all<PublicAd>(stamp, stamp, ...params);
  const items = rows.filter(item => publicDomain(item.domain));
  if (slot !== 'category-top' || items.length < 2) return items;
  const offset = Math.floor(now.getTime() / 3_600_000) % items.length;
  return [...items.slice(offset), ...items.slice(0, offset)];
}

function orderStatus(row: Pick<CheckoutRow, 'status' | 'checkout_closed' | 'billing_status' | 'paid'
  | 'starts_at' | 'ends_at' | 'approved' | 'eligible_site'>, stamp: string): AdOrder['status'] {
  if (row.status === 'rejected' || row.status === 'expired') return row.status;
  if (row.checkout_closed) return row.billing_status === 'cancelled' ? 'cancelled' : 'expired';
  if (row.billing_status === 'review' || (row.billing_status === 'confirmed' && !row.paid)) return 'review';
  if (row.status === 'pending') return row.paid ? 'paid' : 'pending';
  if (row.ends_at && row.ends_at <= stamp) return 'expired';
  if (!row.paid || !row.approved || !row.eligible_site) return 'review';
  if (row.status === 'active' && row.starts_at && row.starts_at > stamp) return 'scheduled';
  return row.status;
}

function projectOrder(row: CheckoutRow, stamp: string): AdOrder {
  const status = orderStatus(row, stamp);
  return {
    orderId: row.merchant_order_id, adId: row.id, domain: row.domain, reference: row.aipay_reference,
    ...(status === 'pending' && row.billing_status === 'pending' && row.checkout_url ? { checkoutUrl: row.checkout_url } : {}),
    expiresAt: row.checkout_expires_at, amount: row.amount, asset: row.asset, chainKey: row.chain_key,
    termDays: row.term_days, paid: !!row.paid, status, startsAt: row.starts_at, endsAt: row.ends_at,
  };
}

async function checkout(db: Db, orderId: string): Promise<CheckoutRow | undefined> {
  return db.prepare('SELECT * FROM ad_checkout_state WHERE merchant_order_id = ?').get<CheckoutRow>(orderId);
}

export async function readAdOrder(db: Db, orderId: string, manageToken: string | null, now = new Date()): Promise<OrderResult> {
  if (!manageToken?.trim()) return fail(401, 'unauthorized');
  if (!orderId.startsWith('ad-') || !UUID.test(orderId.slice(3))) return fail(404, 'not_found');
  const row = await checkout(db, orderId.toLowerCase());
  if (!row || !await ownerOwnsDomain(db, row.domain, manageToken)) return fail(404, 'not_found');
  return { ok: true, status: 200, order: projectOrder(row, now.toISOString()) };
}

export async function createAdOrder(db: Db, { input, manageToken, env, fetchImpl, now = new Date() }: {
  input: unknown;
  manageToken: string | null;
  env: AipayEnv & { ADS_SALES_OPEN?: string };
  fetchImpl?: typeof fetch;
  now?: Date;
}): Promise<OrderResult> {
  if (env.ADS_SALES_OPEN !== 'true') return fail(403, 'ads_sales_closed');
  if (!input || typeof input !== 'object' || Array.isArray(input)) return fail(400, 'invalid_application');
  const { domain, slot, slot_key, headline, body, months = 1, requestId } = input as Record<string, unknown>;
  if (slot === 'report-sponsor') return fail(409, 'slot_unavailable');
  if (slot !== 'category-top' && slot !== 'search-top' && slot !== 'home-supporter') return fail(400, 'invalid_slot');
  if (typeof requestId !== 'string' || !UUID.test(requestId)) return fail(400, 'invalid_request_id');
  if (typeof months !== 'number' || !Number.isInteger(months) || months < 1 || months > 12) return fail(400, 'invalid_term');
  let key: string | null = null;
  if (slot === 'home-supporter') {
    if (slot_key != null) return fail(400, 'invalid_slot_key');
  } else {
    if (typeof slot_key !== 'string') return fail(400, 'invalid_slot_key');
    key = slot === 'search-top' ? searchKey(slot_key) : CATEGORY.test(slot_key) ? slot_key : null;
    if (!key) return fail(400, 'invalid_slot_key');
  }
  const title = plainText(headline, 40);
  const copy = plainText(body, 90);
  if (!title || !copy) return fail(400, 'invalid_copy');
  const claim = `${title} ${copy}`.normalize('NFKC');
  if (MISLEADING.test(claim) || MISLEADING.test(claim.replace(/\s+/g, ''))) return fail(400, 'disallowed_claim');
  const requested = typeof domain === 'string' ? normalizeDomain(domain) : null;
  if (!requested) return fail(400, 'invalid_domain');
  if (!await ownerOwnsDomain(db, requested, manageToken)) return fail(401, 'unauthorized');
  if (!env.AIPAY_API_KEY?.trim()) return fail(503, 'billing_not_configured');
  const subject = await resolveSiteKey(db, requested);
  if (!subject || !publicDomain(subject)) return fail(404, 'unknown_domain');
  const offer = await db.prepare('SELECT * FROM ad_offers WHERE slot = ? AND available = 1').get<AdOffer>(slot);
  if (!offer) return fail(409, 'slot_unavailable');
  const orderId = `ad-${requestId.toLowerCase()}`;
  const stamp = now.toISOString();
  const amount = String(offer.amount * months);
  const termDays = offer.term_days * months;
  let row = await checkout(db, orderId);
  const existed = !!row;
  if (!row) {
    try {
      await db.prepare(`INSERT INTO ad_checkout_apply
        (merchant_order_id, domain, slot, slot_key, headline, body, amount, asset, chain_key, term_days, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(orderId, subject, slot, key, title, copy, amount, ASSET, CHAIN, termDays, stamp);
    } catch (error) {
      const message = String(error);
      if (message.includes('ad_request_conflict')) return fail(409, 'request_conflict');
      if (message.includes('ad_slot_full')) return fail(409, 'slot_full');
      if (message.includes('ad_order_pending')) return fail(409, 'order_pending');
      if (message.includes('ad_checkout_ineligible')) return fail(400, 'ineligible_placement');
      throw error;
    }
    row = await checkout(db, orderId);
  }
  if (!row || row.domain !== subject || row.slot !== slot || row.slot_key !== key || row.headline !== title
    || row.body !== copy || row.amount !== amount || row.term_days !== termDays) return fail(409, 'request_conflict');
  const saved = projectOrder(row, stamp);
  if (saved.checkoutUrl || saved.status !== 'pending') return { ok: true, status: 200, order: saved };
  try {
    await createBillingOrder(db, env, {
      merchantOrderId: orderId, purpose: 'ad', subjectId: subject, amount, asset: ASSET, chainKey: CHAIN,
      termDays, description: `AFR sponsorship · ${slot} · ${subject}`.slice(0, 200), ttlSeconds: 900,
      returnUrl: `https://afr.im/owner/${subject}/?orderId=${orderId}#owner-ads`,
    }, fetchImpl);
    const updated = await checkout(db, orderId);
    if (!updated) return fail(502, 'billing_unavailable');
    const order = projectOrder(updated, stamp);
    if (order.status === 'pending' && !order.checkoutUrl) return fail(502, 'billing_unavailable');
    return { ok: true, status: existed ? 200 : 201, order };
  } catch {
    // The provider may have created a payable order before losing its response.
    // Keep the hold and allow only the same merchant id to retry this order.
    return fail(502, 'billing_unavailable');
  }
}

function validId(id: unknown): id is number {
  return typeof id === 'number' && Number.isSafeInteger(id) && id > 0;
}

async function trackEvent(db: Db, id: number, kind: 'impression' | 'click', stamp: string): Promise<void> {
  await db.prepare('INSERT INTO ad_track_event (ad_id, kind, now) VALUES (?, ?, ?)').run(id, kind, stamp);
}

export async function trackAdImpression(db: Db, id: number, now = new Date()): Promise<void> {
  if (validId(id)) await trackEvent(db, id, 'impression', now.toISOString());
}

export async function clickAd(db: Db, id: number, now = new Date()): Promise<string | null> {
  if (!validId(id)) return null;
  const stamp = now.toISOString();
  const ad = await db.prepare(`SELECT domain FROM approved_ad_placements
    WHERE id = ? AND starts_at <= ? AND ends_at > ?`).get<{ domain: string }>(id, stamp, stamp);
  if (!ad || !publicDomain(ad.domain)) return null;
  try {
    await trackEvent(db, id, 'click', stamp);
  } catch {
    // A counting failure must not break an otherwise eligible ad link.
  }
  return `https://${ad.domain}/?ref=afr-sponsor`;
}

export async function reportAd(db: Db, { id, reason, detail }: { id?: unknown; reason?: unknown; detail?: unknown }, now = new Date()):
  Promise<{ ok: true; status: 201 } | Failure> {
  if (!validId(id) || !AD_REPORT_REASONS.some(value => reason === value)) return fail(400, 'invalid_report');
  const text = plainText(detail ?? '', 500);
  if (text === null) return fail(400, 'invalid_report');
  const stamp = now.toISOString();
  const day = stamp.slice(0, 10);
  const nextDay = new Date(now.getTime() + DAY).toISOString().slice(0, 10);
  const result = await db.prepare(`INSERT INTO ad_reports (ad_id, domain, reason, detail, created_at)
    SELECT a.id, a.domain, ?, ?, ? FROM ads a
    WHERE a.id = ?
      AND (SELECT count(*) FROM ad_reports WHERE created_at >= ? AND created_at < ?) < 100`)
    .run(String(reason), text, stamp, id, day, nextDay);
  if (result.changes > 0) return { ok: true, status: 201 };
  const known = await db.prepare('SELECT 1 AS seen FROM ads WHERE id = ?').get(id);
  return known ? fail(429, 'report_limit') : fail(404, 'not_found');
}

/** Whether a placement exists at all.
 *
 * A reader can be looking at a page rendered a moment before the placement was
 * paused, and a stale page is exactly when a report matters — so the report
 * surface accepts any placement the ledger knows, not only a live one. */
export async function reportableAdExists(db: Db, id: number): Promise<boolean> {
  if (!validId(id)) return false;
  return (await db.prepare('SELECT 1 AS seen FROM ads WHERE id = ? LIMIT 1').get(id)) !== undefined;
}

export async function expireAds(db: Db, now = new Date()): Promise<number> {
  const stamp = now.toISOString();
  const cutoff = new Date(now.getTime() - 7 * DAY).toISOString().slice(0, 10);
  const [expired] = await db.batch([
    { sql: `UPDATE ads SET status = 'expired' WHERE id IN (
      SELECT a.id FROM ads a JOIN ad_checkouts c ON c.ad_id = a.id
      WHERE a.status IN ('active', 'paused') AND a.ends_at <= ? ORDER BY a.ends_at ASC LIMIT 100)`, params: [stamp] },
    { sql: 'DELETE FROM ad_event_days WHERE day IN (SELECT day FROM ad_event_days WHERE day < ? ORDER BY day LIMIT 30)', params: [cutoff] },
  ]);
  return expired ?? 0;
}

export interface ModerateAdInput {
  requestId: string;
  subject: string;
  id: number;
  decision: string;
  startsAt?: string | null;
  note?: string | null;
  now?: Date;
}

export type ModerateAdResult = { result: 'applied' | 'replayed' } | { result: 'conflict'; error: string };

export async function moderateAd(db: Db, { requestId, subject, id, decision, startsAt, note, now = new Date() }: ModerateAdInput):
  Promise<ModerateAdResult> {
  if (!UUID.test(requestId) || !subject.trim() || subject.length > 256 || !validId(id)
    || !['approve', 'reject', 'pause', 'resume'].includes(decision)) return { result: 'conflict', error: '广告操作参数无效。' };
  const requestKey = requestId.toLowerCase();
  if (await requestReserved(db, requestKey)) return { result: 'replayed' };
  const text = plainText(note ?? '', 500);
  if (text === null) return { result: 'conflict', error: '审核备注不能超过 500 字。' };
  const stamp = now.toISOString();
  const start = decision === 'approve' && startsAt ? new Date(startsAt) : now;
  if (!Number.isFinite(start.getTime()) || start < now
    || (decision === 'approve' && startsAt && (startsAt.length !== 24 || start.toISOString() !== startsAt))) {
    return { result: 'conflict', error: '请输入当前或未来的 UTC ISO 投放开始时间。' };
  }
  const action = `ads.${decision}`;
  try {
    await db.batch([
      reserveRequestStatement({ requestId: requestKey, action, subject, createdAt: stamp }),
      { sql: `INSERT INTO admin_ad_moderate (request_id, subject, ad_id, decision, starts_at, note, now)
        VALUES (?, ?, ?, ?, ?, ?, ?)`, params: [requestKey, subject, id, decision, start.toISOString(), text, stamp] },
    ]);
  } catch (error) {
    const message = String(error);
    if (/UNIQUE constraint failed:\s*admin_requests\.request_id\b/i.test(message) && await requestReserved(db, requestKey)) {
      return { result: 'replayed' };
    }
    if (message.includes('ad_slot_full')) return { result: 'conflict', error: '该广告位已满。' };
    if (message.includes('ad_state_conflict')) return { result: 'conflict', error: '广告或付款状态已变化，请刷新后重试。' };
    throw error;
  }
  return { result: 'applied' };
}

interface ReviewRow extends Pick<CheckoutRow, 'id' | 'domain' | 'slot' | 'slot_key' | 'headline' | 'body' | 'starts_at'
  | 'ends_at' | 'status' | 'paid' | 'approved' | 'eligible_site' | 'review_note' | 'reviewed_at' | 'billing_status'
  | 'amount' | 'term_days' | 'checkout_closed' | 'created_at'> {
  impressions: number;
  clicks: number;
  displayStatus: AdOrder['status'];
}

interface ReportRow {
  id: number;
  ad_id: number;
  domain: string;
  reason: typeof AD_REPORT_REASONS[number];
  detail: string;
  status: string;
  created_at: string;
}

export interface AdsBoard {
  offers: AdOffer[];
  ads: ReviewRow[];
  reports: ReportRow[];
  now: string;
}

export async function readAdsBoard(db: Db, now = new Date()): Promise<AdsBoard> {
  const stamp = now.toISOString();
  const [offers, rows, reports] = await Promise.all([
    db.prepare('SELECT * FROM ad_offers').all<AdOffer>(),
    db.prepare(`SELECT id, domain, slot, slot_key, headline, body, starts_at, ends_at, status, paid, approved,
      eligible_site, review_note, reviewed_at, billing_status, amount, term_days, checkout_closed, created_at, impressions, clicks
      FROM ad_checkout_state ORDER BY (status = 'pending' AND paid = 1) DESC, id DESC LIMIT 50`).all<ReviewRow>(),
    db.prepare('SELECT * FROM ad_reports ORDER BY id DESC LIMIT 50').all<ReportRow>(),
  ]);
  return { offers, ads: rows.map(row => ({ ...row, displayStatus: orderStatus(row, stamp) })), reports, now: stamp };
}

const h = (strings: TemplateStringsArray, ...values: unknown[]): HtmlEscapedString =>
  html(strings, ...values) as HtmlEscapedString;
const DECISION_LABEL = { approve: '批准', reject: '拒绝', pause: '暂停', resume: '恢复' } satisfies Record<AdDecision, string>;
const SLOT_LABEL = { 'category-top': '分类', 'search-top': '搜索', 'home-supporter': '首页', 'report-sponsor': '年报' };
const STATE_LABEL = { pending: '待付款', paid: '待审核', scheduled: '已排期', active: '投放中', paused: '已暂停',
  rejected: '已拒绝', review: '待核验', cancelled: '已取消', expired: '已过期' } satisfies Record<AdOrder['status'], string>;

function moderationForm(row: ReviewRow, now: string): HtmlEscapedString | '' {
  const decisions: AdDecision[] = [];
  if (row.status === 'pending' && row.paid) {
    if (row.eligible_site) decisions.push('approve');
    decisions.push('reject');
  } else if (row.approved && row.ends_at && row.ends_at > now) {
    if (row.status === 'active') decisions.push('pause');
    if (row.status === 'paused' && row.paid && row.eligible_site) decisions.push('resume');
  }
  if (!decisions.length) return '';
  const decision = adminField('操作', h`<select name="decision">${decisions.map(value =>
    h`<option value="${value}">${DECISION_LABEL[value]}</option>`)}</select>`);
  const starts = decisions.includes('approve') ? adminField('批准生效时间（UTC ISO，留空立即）',
    h`<input name="starts_at" type="text" maxlength="24" placeholder="${now}">`) : '';
  return adminForm(ADS_ADMIN_PATH, crypto.randomUUID(), h`<input type="hidden" name="id" value="${row.id}">
    ${decision}${starts}${adminField('审核备注', h`<input name="note" maxlength="500">`)}`, '保存');
}

export function renderAdsBoard(board: AdsBoard, canWrite: boolean): HtmlEscapedString {
  const offers = board.offers.map(row => h`<tr><th scope="row">${SLOT_LABEL[row.slot]}</th>
    <td>${row.amount} USDC / ${row.term_days} 天</td><td>${row.capacity}</td><td>${row.available ? '可开售' : '未开放'}</td></tr>`);
  const ads = board.ads.map(row => h`<tr><th scope="row">#${row.id} ${row.domain}</th>
    <td>${SLOT_LABEL[row.slot]} ${row.slot_key ?? ''}<br>${row.headline}<br>${row.body}</td>
    <td>${STATE_LABEL[row.displayStatus]}<br>${row.amount} USDC / ${row.term_days} 天</td>
    <td>${row.starts_at ?? '—'}<br>${row.ends_at ?? '—'}</td><td>${row.impressions} / ${row.clicks}</td>
    <td>${row.review_note ?? ''}${canWrite ? moderationForm(row, board.now) : ''}</td></tr>`);
  const reports = board.reports.map(row => h`<tr><th scope="row">#${row.id}</th><td>#${row.ad_id} ${row.domain}</td>
    <td>${row.reason}</td><td>${row.detail}</td><td>${row.created_at}</td><td>${row.status}</td></tr>`);
  return h`${adminPanel('广告位规格', adminTable(['广告位', '价格', '容量', '状态'], offers))}
    ${adminPanel('广告审核与排期', h`<p class="muted">仅已确认付款的申请可审核。当前没有退款通道。</p>
      ${adminTable(['广告', '内容', '状态', '档期（UTC）', '曝光 / 点击', '审核'], ads)}`)}
    ${adminPanel('广告举报', adminTable(['编号', '广告', '原因', '详情', '时间（UTC）', '状态'], reports))}`;
}
