// L2 可懂层（40 分）= llms.txt 家族 14 + 结构化数据 8 + 语义 HTML 8 + sitemap 4 + 内容信号 6
// 方案书 §3。全部从 signals.homepage.body（HTML）与对应 probe 纯函数推导。

import type { CheckResult, HttpProbe, LayerScore, ScanSignals } from '../../shared/src/index.ts';
import { round2 } from './l1.ts';

const ok = (p?: HttpProbe): p is HttpProbe => !!p && !p.error && (p.status ?? 0) >= 200 && (p.status ?? 0) < 300;

function html(signals: ScanSignals): string | undefined {
  return ok(signals.homepage) ? (signals.homepage.body ?? '') : undefined;
}

/** 抽取可见文本与词数（去 script/style/标签） */
export function visibleText(doc: string): string {
  return doc
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&[a-z]+;/gi, ' ');
}

export function wordCount(doc: string): number {
  const t = visibleText(doc).trim();
  return t ? t.split(/\s+/).length : 0;
}

/** 抽取全部 application/ld+json 块原文 */
export function jsonLdBlocks(doc: string): string[] {
  const out: string[] = [];
  const re = /<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(doc)) !== null) out.push(m[1]!.trim());
  return out;
}

const KEY_SCHEMA_TYPES =
  /"@type"\s*:\s*"(Organization|WebSite|Product|Article|FAQPage|SoftwareApplication|BreadcrumbList|LocalBusiness|NewsArticle)"/i;

function probeDetail(p: HttpProbe | undefined, path: string): string {
  if (!p) return `未探测 ${path}`;
  if (p.error) return `GET ${path} 网络错误: ${p.error}`;
  return `GET ${path} → HTTP ${p.status}`;
}

/** 汇总一个聚合检查的状态（全 pass / 全 fail / 含 unknown） */
function aggStatus(awarded: number, max: number, anyUnknown: boolean): CheckResult['status'] {
  if (awarded >= max) return 'pass';
  if (awarded <= 0) return anyUnknown ? 'unknown' : 'fail';
  return 'partial';
}

export function scoreL2(signals: ScanSignals): LayerScore {
  const checks: CheckResult[] = [];
  const doc = html(signals);

  // 1) llms.txt 家族 14 = llms.txt 9 + llms-full.txt 3 + 首页链接 2
  let a = 0;
  let unknownAny = false;
  const details: string[] = [];
  if (ok(signals.llms)) {
    if ((signals.llms.body ?? '').trim()) {
      a += 9;
      details.push('llms.txt 200 且非空');
    } else {
      details.push('llms.txt 200 但为空');
    }
  } else if (signals.llms?.error || !signals.llms) {
    unknownAny = true;
    details.push(probeDetail(signals.llms, '/llms.txt'));
  } else {
    details.push(probeDetail(signals.llms, '/llms.txt'));
  }
  if (ok(signals.llmsFull)) {
    a += 3;
    details.push('llms-full.txt 200');
  } else if (signals.llmsFull?.error || !signals.llmsFull) {
    unknownAny = true;
    details.push(probeDetail(signals.llmsFull, '/llms-full.txt'));
  } else {
    details.push(probeDetail(signals.llmsFull, '/llms-full.txt'));
  }
  if (doc === undefined) {
    unknownAny = true;
    details.push('首页不可用，无法检查 llms.txt 链接');
  } else if (/llms(-full)?\.txt/i.test(doc)) {
    a += 2;
    details.push('首页含 llms.txt 链接');
  } else {
    details.push('首页无 llms.txt 链接');
  }
  checks.push({
    id: 'l2.llms-family',
    layer: 'L2',
    nameEn: 'llms.txt family',
    nameZh: 'llms.txt 家族',
    awarded: a,
    max: 14,
    status: aggStatus(a, 14, unknownAny),
    evidence: { source: 'GET /llms.txt, /llms-full.txt, homepage HTML', detail: details.join('；') },
  });

  // 2) 结构化数据 8 = JSON-LD 块 4 + 关键类型 2 + 可解析 2
  let b = 0;
  let bUnknown = false;
  const bDetails: string[] = [];
  if (doc === undefined) {
    bUnknown = true;
    bDetails.push('首页不可用，无法检查 JSON-LD');
  } else {
    const blocks = jsonLdBlocks(doc);
    if (blocks.length > 0) {
      b += 4;
      bDetails.push(`JSON-LD 块 ×${blocks.length}`);
      const joined = blocks.join('\n');
      if (KEY_SCHEMA_TYPES.test(joined)) {
        b += 2;
        bDetails.push('含关键 schema.org 类型');
      } else {
        bDetails.push('无关键 schema.org 类型');
      }
      const parsable = blocks.some((s) => {
        try {
          JSON.parse(s);
          return true;
        } catch {
          return false;
        }
      });
      if (parsable) {
        b += 2;
        bDetails.push('JSON-LD 可解析');
      } else {
        bDetails.push('JSON-LD 均不可解析');
      }
    } else {
      bDetails.push('无 JSON-LD 块');
    }
  }
  checks.push({
    id: 'l2.structured-data',
    layer: 'L2',
    nameEn: 'Structured data (JSON-LD)',
    nameZh: '结构化数据',
    awarded: b,
    max: 8,
    status: aggStatus(b, 8, bUnknown),
    evidence: { source: 'homepage HTML', detail: bDetails.join('；') },
  });

  // 3) 语义 HTML 8 = 地标 3 + 唯一 h1 2 + lang 1 + 正文词数 2
  let c = 0;
  let cUnknown = false;
  const cDetails: string[] = [];
  if (doc === undefined) {
    cUnknown = true;
    cDetails.push('首页不可用，无法检查语义 HTML');
  } else {
    const landmarks = (['header', 'nav', 'main', 'footer'] as const).filter((t) =>
      new RegExp(`<${t}[\\s>]`, 'i').test(doc),
    ).length;
    c += (3 * landmarks) / 4;
    cDetails.push(`语义地标 ${landmarks}/4`);
    const h1s = (doc.match(/<h1[\s>]/gi) ?? []).length;
    if (h1s === 1) {
      c += 2;
      cDetails.push('唯一 h1');
    } else if (h1s > 1) {
      c += 1;
      cDetails.push(`h1 ×${h1s}（多个）`);
    } else {
      cDetails.push('无 h1');
    }
    if (/<html[^>]*\slang\s*=/i.test(doc)) {
      c += 1;
      cDetails.push('html[lang] 存在');
    } else {
      cDetails.push('缺 html[lang]');
    }
    const wc = wordCount(doc);
    if (wc >= 200) {
      c += 2;
      cDetails.push(`正文 ${wc} 词`);
    } else if (wc >= 50) {
      c += 1;
      cDetails.push(`正文 ${wc} 词（偏少）`);
    } else {
      cDetails.push(`正文 ${wc} 词（过少）`);
    }
  }
  checks.push({
    id: 'l2.semantic-html',
    layer: 'L2',
    nameEn: 'Semantic HTML',
    nameZh: '语义 HTML',
    awarded: c,
    max: 8,
    status: aggStatus(c, 8, cUnknown),
    evidence: { source: 'homepage HTML', detail: cDetails.join('；') },
  });

  // 4) sitemap 4 = sitemap 可取 2 + robots 引用 1 + 含本站 1
  let d = 0;
  let dUnknown = false;
  const dDetails: string[] = [];
  const sm = signals.sitemap;
  if (ok(sm)) {
    d += 2;
    dDetails.push(probeDetail(sm, '/sitemap.xml'));
  } else if (sm?.error || !sm) {
    dUnknown = true;
    dDetails.push(probeDetail(sm, '/sitemap.xml'));
  } else {
    dDetails.push(probeDetail(sm, '/sitemap.xml'));
  }
  const rp = signals.robots;
  if (rp && !rp.error && rp.status !== undefined) {
    if ((rp.body ?? '').match(/sitemap\s*:/i)) {
      d += 1;
      dDetails.push('robots.txt 引用 Sitemap');
    } else {
      dDetails.push('robots.txt 未引用 Sitemap');
    }
  } else {
    dUnknown = true;
    dDetails.push('robots.txt 不可用，无法检查 Sitemap 引用');
  }
  if (ok(sm)) {
    const host = signals.domain.replace(/^www\./, '');
    if ((sm.body ?? '').includes(host)) {
      d += 1;
      dDetails.push('sitemap 含本站 URL');
    } else {
      dDetails.push('sitemap 不含本站 URL');
    }
  } else {
    dUnknown = true;
  }
  checks.push({
    id: 'l2.sitemap',
    layer: 'L2',
    nameEn: 'Sitemap',
    nameZh: 'Sitemap',
    awarded: d,
    max: 4,
    status: aggStatus(d, 4, dUnknown),
    evidence: { source: 'GET /sitemap.xml + robots.txt', detail: dDetails.join('；') },
  });

  // 5) 内容信号 6 = title 1 + meta description 2 + 日期 1 + 词数 2
  let e = 0;
  let eUnknown = false;
  const eDetails: string[] = [];
  if (doc === undefined) {
    eUnknown = true;
    eDetails.push('首页不可用，无法检查内容信号');
  } else {
    const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(doc)?.[1]?.trim() ?? '';
    if (title) {
      e += 1;
      eDetails.push(`title "${title.slice(0, 40)}"`);
    } else {
      eDetails.push('缺 title');
    }
    const desc =
      /<meta[^>]*name\s*=\s*["']description["'][^>]*content\s*=\s*["']([^"']*)["']/i.exec(doc)?.[1] ??
      /<meta[^>]*content\s*=\s*["']([^"']*)["'][^>]*name\s*=\s*["']description["']/i.exec(doc)?.[1] ??
      '';
    if (desc.length >= 50) {
      e += 2;
      eDetails.push(`meta description ${desc.length} 字符`);
    } else if (desc.length >= 20) {
      e += 1;
      eDetails.push(`meta description ${desc.length} 字符（偏短）`);
    } else {
      eDetails.push('缺/过短 meta description');
    }
    const hasDate =
      /"date(Modified|Published)"\s*:/i.test(doc) || /<time[^>]*datetime\s*=/i.test(doc);
    if (hasDate) {
      e += 1;
      eDetails.push('含日期信号');
    } else {
      eDetails.push('无日期信号');
    }
    const wc = wordCount(doc);
    if (wc >= 500) {
      e += 2;
      eDetails.push(`正文 ${wc} 词`);
    } else if (wc >= 200) {
      e += 1;
      eDetails.push(`正文 ${wc} 词（中等）`);
    } else {
      eDetails.push(`正文 ${wc} 词（偏少）`);
    }
  }
  checks.push({
    id: 'l2.content-signals',
    layer: 'L2',
    nameEn: 'Content signals',
    nameZh: '内容信号',
    awarded: e,
    max: 6,
    status: aggStatus(e, 6, eUnknown),
    evidence: { source: 'homepage HTML', detail: eDetails.join('；') },
  });

  const awarded = round2(checks.reduce((s, c) => s + c.awarded, 0));
  return { layer: 'L2', nameEn: 'Comprehensibility', nameZh: '可懂层', awarded, max: 40, checks };
}
