// L2 Comprehensibility layer (40 points) = llms.txt family 14 + structured data 8 + semantic HTML 8 + sitemap 4 + content signals 6
// Spec §3. Everything is derived purely from signals.homepage.body (HTML) and the corresponding probes.

import type { CheckResult, HttpProbe, LayerScore, ScanSignals } from '../../shared/src/index.ts';
import { round2 } from './l1.ts';

const ok = (p?: HttpProbe): p is HttpProbe => !!p && !p.error && (p.status ?? 0) >= 200 && (p.status ?? 0) < 300;

function html(signals: ScanSignals): string | undefined {
  return ok(signals.homepage) ? (signals.homepage.body ?? '') : undefined;
}

/** Extract visible text and word count (script/style/tags stripped) */
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

/** Extract all application/ld+json blocks verbatim */
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
  if (!p) return `not probed: ${path}`;
  if (p.error) return `GET ${path} network error: ${p.error}`;
  return `GET ${path} → HTTP ${p.status}`;
}

/** Aggregate one combined check's status (all pass / all fail / contains unknown) */
function aggStatus(awarded: number, max: number, anyUnknown: boolean): CheckResult['status'] {
  if (awarded >= max) return 'pass';
  if (awarded <= 0) return anyUnknown ? 'unknown' : 'fail';
  return 'partial';
}

export function scoreL2(signals: ScanSignals): LayerScore {
  const checks: CheckResult[] = [];
  const doc = html(signals);

  // 1) llms.txt family 14 = llms.txt 9 + llms-full.txt 3 + homepage link 2
  let a = 0;
  let unknownAny = false;
  const details: string[] = [];
  if (ok(signals.llms)) {
    if ((signals.llms.body ?? '').trim()) {
      a += 9;
      details.push('llms.txt 200 and non-empty');
    } else {
      details.push('llms.txt 200 but empty');
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
    details.push('homepage unavailable; cannot check llms.txt link');
  } else if (/llms(-full)?\.txt/i.test(doc)) {
    a += 2;
    details.push('homepage links to llms.txt');
  } else {
    details.push('homepage has no llms.txt link');
  }
  checks.push({
    id: 'l2.llms-family',
    layer: 'L2',
    name: 'llms.txt family',
    awarded: a,
    max: 14,
    status: aggStatus(a, 14, unknownAny),
    evidence: { source: 'GET /llms.txt, /llms-full.txt, homepage HTML', detail: details.join('; ') },
  });

  // 2) Structured data 8 = JSON-LD blocks 4 + key types 2 + parsable 2
  let b = 0;
  let bUnknown = false;
  const bDetails: string[] = [];
  if (doc === undefined) {
    bUnknown = true;
    bDetails.push('homepage unavailable; cannot check JSON-LD');
  } else {
    const blocks = jsonLdBlocks(doc);
    if (blocks.length > 0) {
      b += 4;
      bDetails.push(`JSON-LD blocks ×${blocks.length}`);
      const joined = blocks.join('\n');
      if (KEY_SCHEMA_TYPES.test(joined)) {
        b += 2;
        bDetails.push('contains key schema.org type');
      } else {
        bDetails.push('no key schema.org type');
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
        bDetails.push('JSON-LD parsable');
      } else {
        bDetails.push('no JSON-LD block parsable');
      }
    } else {
      bDetails.push('no JSON-LD blocks');
    }
  }
  checks.push({
    id: 'l2.structured-data',
    layer: 'L2',
    name: 'Structured data (JSON-LD)',
    awarded: b,
    max: 8,
    status: aggStatus(b, 8, bUnknown),
    evidence: { source: 'homepage HTML', detail: bDetails.join('; ') },
  });

  // 3) Semantic HTML 8 = landmarks 3 + single h1 2 + lang 1 + body word count 2
  let c = 0;
  let cUnknown = false;
  const cDetails: string[] = [];
  if (doc === undefined) {
    cUnknown = true;
    cDetails.push('homepage unavailable; cannot check semantic HTML');
  } else {
    const landmarks = (['header', 'nav', 'main', 'footer'] as const).filter((t) =>
      new RegExp(`<${t}[\\s>]`, 'i').test(doc),
    ).length;
    c += (3 * landmarks) / 4;
    cDetails.push(`semantic landmarks ${landmarks}/4`);
    const h1s = (doc.match(/<h1[\s>]/gi) ?? []).length;
    if (h1s === 1) {
      c += 2;
      cDetails.push('single h1');
    } else if (h1s > 1) {
      c += 1;
      cDetails.push(`h1 ×${h1s} (multiple)`);
    } else {
      cDetails.push('no h1');
    }
    if (/<html[^>]*\slang\s*=/i.test(doc)) {
      c += 1;
      cDetails.push('html[lang] present');
    } else {
      cDetails.push('missing html[lang]');
    }
    const wc = wordCount(doc);
    if (wc >= 200) {
      c += 2;
      cDetails.push(`body text ${wc} words`);
    } else if (wc >= 50) {
      c += 1;
      cDetails.push(`body text ${wc} words (low)`);
    } else {
      cDetails.push(`body text ${wc} words (too low)`);
    }
  }
  checks.push({
    id: 'l2.semantic-html',
    layer: 'L2',
    name: 'Semantic HTML',
    awarded: c,
    max: 8,
    status: aggStatus(c, 8, cUnknown),
    evidence: { source: 'homepage HTML', detail: cDetails.join('; ') },
  });

  // 4) Sitemap 4 = sitemap fetchable 2 + robots reference 1 + contains this site 1
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
      dDetails.push('robots.txt references a Sitemap');
    } else {
      dDetails.push('robots.txt does not reference a Sitemap');
    }
  } else {
    dUnknown = true;
    dDetails.push('robots.txt unavailable; cannot check Sitemap reference');
  }
  if (ok(sm)) {
    const host = signals.domain.replace(/^www\./, '');
    if ((sm.body ?? '').includes(host)) {
      d += 1;
      dDetails.push("sitemap contains this site's URL");
    } else {
      dDetails.push("sitemap does not contain this site's URL");
    }
  } else {
    dUnknown = true;
  }
  checks.push({
    id: 'l2.sitemap',
    layer: 'L2',
    name: 'Sitemap',
    awarded: d,
    max: 4,
    status: aggStatus(d, 4, dUnknown),
    evidence: { source: 'GET /sitemap.xml + robots.txt', detail: dDetails.join('; ') },
  });

  // 5) Content signals 6 = title 1 + meta description 2 + date 1 + word count 2
  let e = 0;
  let eUnknown = false;
  const eDetails: string[] = [];
  if (doc === undefined) {
    eUnknown = true;
    eDetails.push('homepage unavailable; cannot check content signals');
  } else {
    const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(doc)?.[1]?.trim() ?? '';
    if (title) {
      e += 1;
      eDetails.push(`title "${title.slice(0, 40)}"`);
    } else {
      eDetails.push('missing title');
    }
    const desc =
      /<meta[^>]*name\s*=\s*["']description["'][^>]*content\s*=\s*["']([^"']*)["']/i.exec(doc)?.[1] ??
      /<meta[^>]*content\s*=\s*["']([^"']*)["'][^>]*name\s*=\s*["']description["']/i.exec(doc)?.[1] ??
      '';
    if (desc.length >= 50) {
      e += 2;
      eDetails.push(`meta description ${desc.length} chars`);
    } else if (desc.length >= 20) {
      e += 1;
      eDetails.push(`meta description ${desc.length} chars (short)`);
    } else {
      eDetails.push('missing/too-short meta description');
    }
    const hasDate =
      /"date(Modified|Published)"\s*:/i.test(doc) || /<time[^>]*datetime\s*=/i.test(doc);
    if (hasDate) {
      e += 1;
      eDetails.push('date signal present');
    } else {
      eDetails.push('no date signal');
    }
    const wc = wordCount(doc);
    if (wc >= 500) {
      e += 2;
      eDetails.push(`body text ${wc} words`);
    } else if (wc >= 200) {
      e += 1;
      eDetails.push(`body text ${wc} words (moderate)`);
    } else {
      eDetails.push(`body text ${wc} words (low)`);
    }
  }
  checks.push({
    id: 'l2.content-signals',
    layer: 'L2',
    name: 'Content signals',
    awarded: e,
    max: 6,
    status: aggStatus(e, 6, eUnknown),
    evidence: { source: 'homepage HTML', detail: eDetails.join('; ') },
  });

  const awarded = round2(checks.reduce((s, c) => s + c.awarded, 0));
  return { layer: 'L2', name: 'Comprehensibility', awarded, max: 40, checks };
}
