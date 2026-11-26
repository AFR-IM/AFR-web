// src/admin-ui.ts — the shared HTML building blocks of the administrator
// console. The console is server-rendered plain HTML: no client framework,
// no external asset (no font, no icon, no image), nothing that could phone
// home. Every page is built from these helpers so all sections look alike.
//
// Styling: one inline stylesheet, injected with hono's `raw()` so quotes and
// combinators survive verbatim. The palette is lifted from the public site
// design tokens (deep-space blue-black surfaces, teal brand, AQI-style grade
// accents) and follows `prefers-color-scheme` for a readable light theme.
// Destructive-action confirmation stays a routing concern — no script here.

import { html, raw } from 'hono/html';
import type { HtmlEscapedString } from 'hono/utils/html';

/** hono's `h` is typed as possibly async; the console never nests async
 * components, so the sync result is asserted once here. */
const h = (strings: TemplateStringsArray, ...values: unknown[]): HtmlEscapedString =>
  html(strings, ...values) as HtmlEscapedString;

export type Block = HtmlEscapedString | string;

export interface AdminNavItem {
  href: string;
  label: string;
}

/** The console sections, in the order of the SSOT domains A → B → C → D → F. */
export const ADMIN_NAV: AdminNavItem[] = [
  { href: '/admin/', label: 'A 扫描队列' },
  { href: '/admin/content', label: 'B 内容与社区' },
  { href: '/admin/commercial', label: 'C 商业化' },
  { href: '/admin/monitor', label: 'D 监控看板' },
  { href: '/admin/scoring', label: 'E 评分版本' },
  { href: '/admin/settings', label: 'F 设置' },
];

const STYLE = `
:root {
  color-scheme: dark light;
  /* surfaces (deep space blue-black) */
  --bg-ink: #0b1220;
  --bg-surface: #131c2e;
  --bg-elevated: #1b2740;
  --line: #22304c;
  /* text */
  --text-1: #e6edf7;
  --text-2: #8ca0bf;
  --text-3: #8498bd;
  /* brand (teal) */
  --brand: #3ecfad;
  --brand-dim: #2a9e80;
  --brand-link: #3ecfad;
  --brand-on: #06231c; /* text on a brand-filled surface */
  /* status accents */
  --ok: #3ecfad;
  --ok-bg: rgba(62, 207, 173, .12);
  --warn: #f2994a;
  --warn-bg: rgba(242, 153, 74, .12);
  --danger: #eb5757;
  --danger-bg: rgba(235, 87, 87, .12);
  /* radii */
  --r-sm: 6px;
  --r-md: 10px;
  --r-lg: 14px;
}
@media (prefers-color-scheme: light) {
  :root {
    --bg-ink: #f6f8fc;
    --bg-surface: #ffffff;
    --bg-elevated: #eef2f9;
    --line: #d7dfee;
    --text-1: #101726;
    --text-2: #4c5c78;
    --text-3: #5a6c8d;
    --brand-link: #17705e;
    --ok: #17705e;
    --ok-bg: rgba(23, 112, 94, .10);
    --warn: #b45f06;
    --warn-bg: rgba(180, 95, 6, .10);
    --danger: #c62828;
    --danger-bg: rgba(198, 40, 40, .10);
  }
}
*, *::before, *::after { box-sizing: border-box; }
body {
  font: 15px/1.6 system-ui, -apple-system, "Segoe UI", "Noto Sans CJK SC", sans-serif;
  margin: 0 auto; padding: 1.25rem clamp(1rem, 4vw, 3rem) 3rem; max-width: 78rem;
  color: var(--text-1);
  background: radial-gradient(1200px 480px at 50% -10%, rgba(62, 207, 173, .10), transparent 60%), var(--bg-ink);
}
a { color: var(--brand-link); }
h1 { font-size: 1.35rem; margin: .9rem 0 .3rem; }
h2 { font-size: 1.08rem; margin: 1.8rem 0 .6rem; padding-left: .55rem; border-left: 3px solid var(--brand); }
h3 { font-size: 1rem; margin: 1.2rem 0 .4rem; }
/* brand strip above the title */
.topbar { display: flex; align-items: baseline; gap: .6rem; padding-bottom: .55rem;
  border-bottom: 2px solid var(--brand); }
.topbar .mark { font-weight: 800; font-size: 1.05rem; letter-spacing: .04em; }
.topbar .dot { color: var(--brand); }
.topbar .sub { font-size: .72rem; letter-spacing: .18em; color: var(--text-3); }
nav { display: flex; flex-wrap: wrap; gap: .5rem; margin: .9rem 0 1.4rem; padding-bottom: .8rem;
  border-bottom: 1px solid var(--line); }
nav a { text-decoration: none; padding: .35rem .8rem; border-radius: 999px;
  border: 1px solid var(--line); background: var(--bg-surface); color: var(--text-2); font-size: .92rem;
  transition: background-color .12s ease, border-color .12s ease, color .12s ease; }
nav a:hover { color: var(--text-1); border-color: var(--brand-dim); }
nav a[aria-current="page"] { font-weight: 700; background: var(--brand);
  border-color: var(--brand); color: var(--brand-on); }
:focus-visible { outline: 2px solid var(--brand); outline-offset: 2px; }
.table-wrap { overflow-x: auto; margin: .5rem 0 1.2rem; border: 1px solid var(--line);
  border-radius: var(--r-md); }
table { border-collapse: collapse; width: 100%; font-size: .9rem; font-variant-numeric: tabular-nums; }
th, td { border: 1px solid var(--line); padding: .45rem .6rem; text-align: left;
  vertical-align: top; overflow-wrap: break-word; }
thead th { background: var(--bg-elevated); color: var(--text-2); font-size: .8rem;
  white-space: nowrap; position: sticky; top: 0; }
tbody tr:nth-child(even) { background: rgba(128, 128, 128, .05); }
tbody tr:hover { background: rgba(62, 207, 173, .07); }
caption.muted { text-align: left; padding: .35rem .6rem; }
form { margin: .4rem 0 1rem; }
fieldset { border: 1px solid var(--line); border-radius: var(--r-md); margin: .8rem 0;
  padding: .9rem; background: var(--bg-surface); }
legend { font-weight: 600; padding: 0 .3rem; }
label { display: inline-block; margin: .2rem .6rem .2rem 0; color: var(--text-2); }
input, select, textarea { font: inherit; padding: .35rem .5rem; max-width: 100%;
  color: var(--text-1); background: var(--bg-elevated); border: 1px solid var(--line);
  border-radius: var(--r-sm); }
input:hover, select:hover, textarea:hover { border-color: var(--brand-dim); }
textarea { width: 100%; min-height: 5rem; }
button { font: inherit; padding: .38rem .95rem; cursor: pointer; border-radius: var(--r-sm);
  border: 1px solid var(--line); background: var(--bg-elevated); color: var(--text-1);
  transition: background-color .12s ease, border-color .12s ease; }
button:hover { border-color: var(--brand-dim); }
.btn-primary { background: var(--brand); border-color: var(--brand);
  color: var(--brand-on); font-weight: 600; }
.btn-primary:hover { background: var(--brand-dim); border-color: var(--brand-dim); }
.btn-neutral { background: var(--bg-elevated); border-color: var(--line); color: var(--text-1); }
.btn-danger { background: transparent; border-color: var(--danger);
  color: var(--danger); font-weight: 600; }
.btn-danger:hover { background: var(--danger-bg); }
.ok, .warn, .error { border-left: .3rem solid; padding: .5rem .7rem;
  border-radius: 0 var(--r-sm) var(--r-sm) 0; }
.ok { border-color: var(--ok); background: var(--ok-bg); }
.warn { border-color: var(--warn); background: var(--warn-bg); }
.error { border-color: var(--danger); background: var(--danger-bg); }
.alert-icon { margin-right: .4rem; }
.stats { display: flex; flex-wrap: wrap; gap: .8rem; margin: .6rem 0 1.2rem; }
.stat { border: 1px solid var(--line); border-radius: var(--r-md); padding: .6rem .9rem;
  min-width: 9.5rem; background: var(--bg-surface); color: var(--text-2); font-size: .9rem; }
.stat b { display: block; font-size: 1.4rem; line-height: 1.25; color: var(--text-1);
  font-variant-numeric: tabular-nums; }
.stat .muted { font-size: .8rem; margin-top: .15rem; }
.muted { color: var(--text-3); font-size: .88rem; }
code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .9em;
  background: var(--bg-elevated); padding: 0 .3em; border-radius: 4px; }
/* login: the form in admin.ts is a direct child of main — centre it as a card */
main:has(> form[action="/admin/login"]) { max-width: 23rem; margin: 7vh auto 3rem;
  padding: 2rem 2rem 1.7rem; background: var(--bg-surface); border: 1px solid var(--line);
  border-radius: var(--r-lg); box-shadow: 0 18px 40px rgba(11, 18, 32, .28); }
main:has(> form[action="/admin/login"])::before { content: "AFR.IM"; display: block;
  text-align: center; color: var(--brand); font-weight: 800; letter-spacing: .12em;
  font-size: .95rem; margin-bottom: .35rem; }
main:has(> form[action="/admin/login"]) h1 { text-align: center; font-size: 1.15rem; margin: 0 0 .9rem; }
main:has(> form[action="/admin/login"]) p { margin: 0 0 .9rem; }
main:has(> form[action="/admin/login"]) form p { margin: 0 0 .9rem; }
main:has(> form[action="/admin/login"]) label { display: block; margin: 0; font-size: .88rem; }
main:has(> form[action="/admin/login"]) input { display: block; width: 100%; margin-top: .3rem;
  padding: .5rem .65rem; }
main:has(> form[action="/admin/login"]) button { width: 100%; padding: .55rem; font-weight: 700; }
@media (prefers-reduced-motion: reduce) { * { transition: none !important; } }
`;

/**
 * The whole document of one console page: brand strip, stylesheet, body.
 *
 * `body` must be an escaped fragment (an `HtmlEscapedString`), never a plain
 * string: a plain string would be escaped a second time here and the browser
 * would show the markup as text instead of rendering it.
 */
export function adminDocument(title: string, body: HtmlEscapedString): string {
  return h`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${title} · AFR 管理后台</title>
    <style>${raw(STYLE)}</style>
    </head><body><header class="topbar"><span class="mark">AFR<span class="dot">.IM</span></span>
    <span class="sub">管理后台</span></header><main><h1>${title}</h1>${body}</main></body></html>`.toString();
}

/** The section switcher. The current page is marked for assistive tech. */
export function adminNav(current: string): HtmlEscapedString {
  return h`<nav aria-label="管理后台分区">${ADMIN_NAV.map(item =>
    h`<a href="${item.href}"${item.href === current ? h` aria-current="page"` : ''}>${item.label}</a>`,
  )}</nav>`;
}

/** A titled block. */
export function adminPanel(title: string, body: Block): HtmlEscapedString {
  return h`<section><h2>${title}</h2>${body}</section>`;
}

const ALERT_ICON: Record<'ok' | 'warn' | 'error', string> = { ok: '✅', warn: '⚠️', error: '❌' };

/** A message line. `kind` picks the colour and the (decorative) icon only. */
export function adminAlert(kind: 'ok' | 'warn' | 'error', text: Block): HtmlEscapedString {
  return h`<p class="${kind}" role="${kind === 'error' ? 'alert' : 'status'}"><span class="alert-icon" aria-hidden="true">${ALERT_ICON[kind]}</span>${text}</p>`;
}

/** A labelled form control. */
export function adminField(label: string, control: Block): HtmlEscapedString {
  return h`<label>${label} ${control}</label>`;
}

/** A single number with its label (and an optional secondary note). */
export function adminStat(label: string, value: Block, hint?: string): HtmlEscapedString {
  return h`<div class="stat"><b>${value}</b>${label}${hint ? h`<div class="muted">${hint}</div>` : ''}</div>`;
}

/** A table in a horizontally scrollable wrapper. `rows` already contains the cell markup. */
export function adminTable(headers: string[], rows: Block[], caption?: string): HtmlEscapedString {
  return h`<div class="table-wrap"><table>${caption ? h`<caption class="muted">${caption}</caption>` : ''}
    <thead><tr>${headers.map(head => h`<th scope="col">${head}</th>`)}</tr></thead>
    <tbody>${rows.length ? rows : h`<tr><td colspan="${headers.length}">暂无记录。</td></tr>`}</tbody>
    </table></div>`;
}

/** Button tone for {@link adminForm}. `danger` renders a red outline. */
export type AdminButtonVariant = 'primary' | 'neutral' | 'danger';

/** Labels that mark a submit as destructive when no variant is given. */
const DANGER_WORDS = ['撤销', '吊销', '删除', '移除', '清除', '重置', '驳回', '下架', '封禁'];

/**
 * A form that posts to `action` with a replay-safe request id.
 *
 * `variant` is optional and last: without it the submit is styled primary,
 * except that destructive labels (撤销 / 吊销 / …) are detected and styled
 * danger, so existing callers get the right hierarchy unchanged.
 */
export function adminForm(
  action: string,
  requestId: string,
  fields: Block,
  submit: string,
  legend?: string,
  variant?: AdminButtonVariant,
): HtmlEscapedString {
  const tone = variant ?? (DANGER_WORDS.some(word => submit.includes(word)) ? 'danger' : 'primary');
  const body = h`${fields}
    <input type="hidden" name="request_id" value="${requestId}">
    <button type="submit" class="btn-${tone}">${submit}</button>`;
  return legend
    ? h`<form method="post" action="${action}"><fieldset><legend>${legend}</legend>${body}</fieldset></form>`
    : h`<form method="post" action="${action}">${body}</form>`;
}

/** A CSRF-safe same-origin check helper for the caller. */
export function isSameOrigin(request: Request, url: URL): boolean {
  return request.headers.get('Origin') === url.origin;
}
