// src/ad-report-page.ts — the abuse report of a sponsored placement.
//
// Two callers, one handler:
//   · a reader who clicks "Report" next to a placement lands here and gets a
//     plain HTML form (no script, no third-party asset, noindex);
//   · a machine client posts JSON to the same URL and gets a JSON answer.
//
// Discipline: a report never touches a score, a grade or a ranking position —
// it only creates a row the operator reads on the commercial board.

import { html } from 'hono/html';
import type { HtmlEscapedString } from 'hono/utils/html';
import { AD_REPORT_REASONS, reportableAdExists, reportAd } from './ads.ts';
import type { Db } from './db.ts';

const h = (strings: TemplateStringsArray, ...values: unknown[]): HtmlEscapedString =>
  html(strings, ...values) as HtmlEscapedString;

const MAX_BODY_BYTES = 4096;

const COPY = {
  en: {
    lang: 'en',
    title: 'Report a sponsored placement',
    intro: 'Tell us what is wrong with this placement. Every report is read by a person.',
    adId: 'Placement',
    reason: 'What is wrong?',
    reasons: {
      misleading: 'It makes a claim AFR never made',
      spam: 'It is spam or a scam',
      inappropriate: 'The content is inappropriate',
      other: 'Something else',
    },
    detail: 'Details (optional)',
    detailHint: 'Up to 500 characters. Do not include personal data.',
    send: 'Send report',
    done: 'Thank you — your report was recorded.',
    invalid: 'This report could not be accepted. Check the reason and the length of the details.',
    throttled: 'Too many reports today. Try again tomorrow.',
    unknown: 'This placement is not available for reporting.',
    malformed: 'The form could not be read.',
    back: 'Back to the site directory',
  },
  zh: {
    lang: 'zh-CN',
    title: '举报广告位',
    intro: '请告诉我们这个广告位有什么问题。每一条举报都会有人查看。',
    adId: '广告位',
    reason: '问题类型',
    reasons: {
      misleading: '它声称得到 AFR 的认证或推荐',
      spam: '垃圾信息或诈骗',
      inappropriate: '内容不当',
      other: '其他问题',
    },
    detail: '补充说明（可选）',
    detailHint: '最多 500 字。请不要填写个人信息。',
    send: '提交举报',
    done: '已收到举报，谢谢。',
    invalid: '这条举报无法受理：请检查问题类型与说明长度。',
    throttled: '今天收到的举报太多了，请明天再试。',
    unknown: '这个广告位不存在或不可举报。',
    malformed: '无法读取表单内容。',
    back: '返回站点目录',
  },
} as const;

type Copy = (typeof COPY)[keyof typeof COPY];

const HEADERS = {
  'Cache-Control': 'no-store',
  'Cloudflare-CDN-Cache-Control': 'no-store',
  'Referrer-Policy': 'no-referrer',
  'X-Robots-Tag': 'noindex, nofollow',
  'X-Content-Type-Options': 'nosniff',
  'Content-Security-Policy':
    "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
};

function copyFor(lang: string | null): Copy {
  return (lang ?? '').toLowerCase().startsWith('zh') ? COPY.zh : COPY.en;
}

function document(copy: Copy, body: HtmlEscapedString, status = 200): Response {
  const page = h`<!doctype html>
<html lang="${copy.lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<meta name="referrer" content="no-referrer">
<title>${copy.title} · AFR.IM</title>
<style>
:root { color-scheme: dark light; }
body { margin: 0; padding: clamp(1rem, 5vw, 3rem); font: 16px/1.6 system-ui, -apple-system, "Segoe UI", sans-serif; }
main { max-width: 34rem; margin-inline: auto; }
h1 { font-size: 1.4rem; margin: 0 0 .6rem; }
p { margin: 0 0 1rem; }
label { display: block; margin: .8rem 0 .2rem; font-weight: 600; }
input[type="text"], select, textarea { width: 100%; box-sizing: border-box; padding: .5rem; font: inherit; }
textarea { min-height: 6rem; }
button { margin-top: 1rem; padding: .6rem 1rem; font: inherit; font-weight: 600; }
a { font-weight: 600; }
</style>
</head>
<body><main>${body}</main></body>
</html>`;
  return new Response(page, {
    status,
    headers: { ...HEADERS, 'Content-Type': 'text/html; charset=utf-8' },
  });
}

function formPage(copy: Copy, id: string, notice?: string): Response {
  const body = h`<h1>${copy.title}</h1>
<p>${copy.intro}</p>
${notice ? h`<p role="status">${notice}</p>` : ''}
<form method="post" action="/api/v1/ads/report">
  <input type="hidden" name="id" value="${id}">
  <input type="hidden" name="lang" value="${copy.lang}">
  <p><strong>${copy.adId} #${id}</strong></p>
  <label for="reason">${copy.reason}</label>
  <select id="reason" name="reason" required>
    ${AD_REPORT_REASONS.map(reason => h`<option value="${reason}">${copy.reasons[reason]}</option>`)}
  </select>
  <label for="detail">${copy.detail}</label>
  <textarea id="detail" name="detail" maxlength="500" aria-describedby="detail-hint"></textarea>
  <p id="detail-hint"><small>${copy.detailHint}</small></p>
  <button type="submit">${copy.send}</button>
</form>
<p><a href="/">${copy.back}</a></p>`;
  return document(copy, body);
}

function resultPage(copy: Copy, message: string, status: number): Response {
  return document(copy, h`<h1>${copy.title}</h1><p role="status">${message}</p>
<p><a href="/">${copy.back}</a></p>`, status);
}

/** Read at most `MAX_BODY_BYTES` of a request body, or null when it is bigger. */
async function readBody(request: Request): Promise<Uint8Array | null> {
  if (Number(request.headers.get('content-length')) > MAX_BODY_BYTES) return null;
  if (!request.body) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = request.body.getReader();
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) {
        void reader.cancel().catch(() => undefined);
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const out = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/** A report id: a positive integer, as the placement API hands it out. */
function adId(raw: string | null): number | null {
  if (!raw || !/^[1-9]\d{0,15}$/.test(raw.trim())) return null;
  const value = Number(raw.trim());
  return Number.isSafeInteger(value) ? value : null;
}

/**
 * Handle the report surface.
 *
 * A `GET` renders the form, a `POST` records the report. The content type
 * decides the answer: a browser form gets an HTML page, a script gets JSON.
 */
export async function handleAdReport(request: Request, getDb: () => Db): Promise<Response> {
  const url = new URL(request.url);
  const wantsJson = (request.headers.get('accept') ?? '').includes('application/json')
    || (request.headers.get('content-type') ?? '').includes('application/json');

  if (request.method === 'GET') {
    const copy = copyFor(url.searchParams.get('lang'));
    const id = adId(url.searchParams.get('id'));
    if (!id) return wantsJson
      ? Response.json({ error: 'invalid_ad' }, { status: 400, headers: HEADERS })
      : resultPage(copy, copy.unknown, 404);
    if (!(await reportableAdExists(getDb(), id))) return wantsJson
      ? Response.json({ error: 'not_found' }, { status: 404, headers: HEADERS })
      : resultPage(copy, copy.unknown, 404);
    return formPage(copy, String(id));
  }

  const raw = await readBody(request);
  const copy = copyFor(url.searchParams.get('lang'));
  if (!raw) {
    return wantsJson
      ? Response.json({ error: 'payload_too_large' }, { status: 413, headers: HEADERS })
      : resultPage(copy, copy.malformed, 413);
  }

  let id: unknown = url.searchParams.get('id');
  let reason: unknown = url.searchParams.get('reason');
  let detail: unknown = url.searchParams.get('detail');
  let lang = url.searchParams.get('lang');
  const type = (request.headers.get('content-type') ?? '').split(';', 1)[0]?.trim().toLowerCase();
  if (type === 'application/json') {
    let body: unknown;
    try {
      body = JSON.parse(new TextDecoder().decode(raw));
    } catch {
      return needsJson(request) ? Response.json({ error: 'invalid_report' }, { status: 400, headers: HEADERS })
        : resultPage(copy, copy.malformed, 400);
    }
    const fields = (body ?? {}) as Record<string, unknown>;
    id = fields.id ?? id;
    reason = fields.reason ?? reason;
    detail = fields.detail ?? detail;
    lang = typeof fields.lang === 'string' ? fields.lang : lang;
  } else if (type === 'application/x-www-form-urlencoded') {
    const form = new URLSearchParams(new TextDecoder().decode(raw));
    id = form.get('id') ?? id;
    reason = form.get('reason') ?? reason;
    detail = form.get('detail') ?? detail;
    lang = form.get('lang') ?? lang;
  }
  const localized = copyFor(typeof lang === 'string' ? lang : null);
  const result = await reportAd(getDb(), {
    id: typeof id === 'string' ? adId(id) ?? undefined : id,
    reason,
    detail: typeof detail === 'string' ? detail : '',
  });
  if (result.ok) {
    return needsJson(request)
      ? Response.json({ ok: true }, { status: 201, headers: HEADERS })
      : resultPage(localized, localized.done, 200);
  }
  const status = result.status === 429 ? 429 : result.status === 404 ? 404 : 400;
  if (needsJson(request)) {
    return Response.json({ error: result.error }, { status: result.status, headers: HEADERS });
  }
  const message = status === 429 ? localized.throttled : status === 404 ? localized.unknown : localized.invalid;
  return resultPage(localized, message, status);
}

/** Whether the caller asked for a machine-readable answer. */
function needsJson(request: Request): boolean {
  return (request.headers.get('accept') ?? '').includes('application/json')
    || (request.headers.get('content-type') ?? '').includes('application/json');
}
