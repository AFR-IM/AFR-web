// The page's own title and language, captured at scan time.
//
// Why this file exists
//   The raw homepage body is ~98% of the snapshot corpus, and it is kept only
//   so that the AI-feature signals can be re-judged offline
//   (scripts/rederive-signals.mjs). The site's title and language, on the
//   other hand, are needed by every reader of the corpus — the site cards,
//   the search index, the D1 loader — and until now they existed *only*
//   inside that body. Pruning the body therefore wiped the titles as well:
//   in a body-less corpus 5,564 of 7,948 catalogued sites lost their name.
//
//   So the scanner writes them as first-class fields of the homepage probe:
//   `signals.homepage.title` and `signals.homepage.lang`. The body can then
//   be pruned without losing the face of the catalog.
//
//   The same holds for the site's own self-description — the og:site_name /
//   application-name / description / keywords it publishes — which the
//   category heuristics read. It lives in `signals.homepage.meta` for the
//   same reason: without it, a pruned body would silently downgrade a site
//   from its real vertical to "other".
//
// The rules are the ones the web build already applied
// (apps/web/scripts/fetch-data.mjs) — moved here verbatim, not rewritten.
// A title that the build derives from a body must be reproducible from that
// body alone, otherwise old and new snapshots would disagree about the same
// site. Consumers read the field first and fall back to the body, so a
// snapshot taken before this change keeps working unchanged.

/** Longest title we keep; a longer one is cut and marked with an ellipsis. */
export const TITLE_MAX_CHARS = 120;

/** The homepage probe fields this module reads (a snapshot's `signals.homepage`). */
export interface PageProbeLike {
  body?: unknown;
  title?: unknown;
  lang?: unknown;
  meta?: unknown;
}

/**
 * The site's own self-description, read from the page's own head.
 *
 * These are the four fields the web build reads out of a homepage body: the
 * `og:site_name` / `application-name` the site publishes, its meta
 * description and its keywords list. They are first-party evidence about
 * what the site is — the generalized meta pass in categorize.mjs reads them —
 * and they never touch the score.
 */
export interface PageMetaTags {
  ogSiteName?: string;
  appName?: string;
  description?: string;
  keywords?: string;
}

/** The page metadata captured at scan time (only the keys that were found). */
export interface PageMeta {
  title?: string;
  lang?: string;
  meta?: PageMetaTags;
}

/**
 * The homepage <title> text, normalized.
 *
 * Entities are decoded, whitespace is collapsed, and the text is cut at
 * TITLE_MAX_CHARS. Returns undefined when the body has no usable title —
 * "no title" is a fact, not an error.
 */
export function extractPageTitle(body: unknown): string | undefined {
  if (typeof body !== 'string') return undefined;
  const m = body.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (!m?.[1]) return undefined;
  const text = m[1]
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return undefined;
  return text.length > TITLE_MAX_CHARS ? `${text.slice(0, TITLE_MAX_CHARS - 1)}…` : text;
}

/** The <html lang="…"> attribute of the homepage, when the page declares one. */
export function extractPageLang(body: unknown): string | undefined {
  if (typeof body !== 'string') return undefined;
  const m = body.match(/<html[^>]*\blang\s*=\s*["']?([A-Za-z][A-Za-z0-9-]{0,15})/i);
  return m ? m[1] : undefined;
}

/**
 * The site's own self-description, read from the head of a fetched page.
 *
 * The rules are the ones the web build already applied
 * (apps/web/scripts/fetch-data.mjs) — moved here verbatim, not rewritten.
 * A description that the build derives from a body must be reproducible from
 * that body alone, otherwise old and new snapshots would disagree about the
 * same site. Consumers read the field first and fall back to the body, so a
 * snapshot taken before this change keeps working unchanged.
 *
 * Returns undefined when the page declares none of the four.
 */
export function extractPageMeta(body: unknown): PageMetaTags | undefined {
  if (typeof body !== 'string') return undefined;
  const head = body.slice(0, 20000);
  const pick = (patterns: RegExp[]): string | undefined => {
    for (const p of patterns) {
      const m = head.match(p);
      if (m && m[1] && m[1].trim()) {
        const text = m[1]
          .replace(/&nbsp;/g, ' ')
          .replace(/&amp;/g, '&')
          .replace(/&lt;/g, '<')
          .replace(/&gt;/g, '>')
          .replace(/&quot;/g, '"')
          .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
          .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
          .replace(/\s+/g, ' ')
          .trim();
        if (text) return text;
      }
    }
    return undefined;
  };
  const meta: PageMetaTags = {};
  const ogSiteName = pick([
    /<meta[^>]+property\s*=\s*["']og:site_name["'][^>]+content\s*=\s*["']([^"']*)["']/i,
    /<meta[^>]+content\s*=\s*["']([^"']*)["'][^>]+property\s*=\s*["']og:site_name["']/i,
  ]);
  const appName = pick([
    /<meta[^>]+name\s*=\s*["']application-name["'][^>]+content\s*=\s*["']([^"']*)["']/i,
    /<meta[^>]+content\s*=\s*["']([^"']*)["'][^>]+name\s*=\s*["']application-name["']/i,
  ]);
  const description = pick([
    /<meta[^>]+name\s*=\s*["']description["'][^>]+content\s*=\s*["']([^"']*)["']/i,
    /<meta[^>]+content\s*=\s*["']([^"']*)["'][^>]+name\s*=\s*["']description["']/i,
    /<meta[^>]+property\s*=\s*["']og:description["'][^>]+content\s*=\s*["']([^"']*)["']/i,
  ]);
  const keywords = pick([
    /<meta[^>]+name\s*=\s*["']keywords["'][^>]+content\s*=\s*["']([^"']*)["']/i,
    /<meta[^>]+content\s*=\s*["']([^"']*)["'][^>]+name\s*=\s*["']keywords["']/i,
  ]);
  // Only the values that were found are kept — a key that is not there says
  // "the page does not publish it", which is what the consumers expect.
  if (ogSiteName) meta.ogSiteName = ogSiteName;
  if (appName) meta.appName = appName;
  if (description) meta.description = description;
  if (keywords) meta.keywords = keywords;
  return Object.keys(meta).length > 0 ? meta : undefined;
}

/**
 * Capture the page metadata of a fetched body.
 *
 * Never throws: a body we cannot parse is a page we know nothing about, and
 * that must not cost the scan its result — the body itself is still stored by
 * the caller, and a missing field simply means "not parsed".
 */
export function capturePageMeta(body: unknown): PageMeta {
  try {
    const meta: PageMeta = {};
    const title = extractPageTitle(body);
    const lang = extractPageLang(body);
    const tags = extractPageMeta(body);
    if (title) meta.title = title;
    if (lang) meta.lang = lang;
    if (tags) meta.meta = tags;
    return meta;
  } catch {
    return {};
  }
}

/**
 * The site's title: the field the scanner wrote, else the body.
 *
 * The field wins because it is the only survivor of a pruned body; the body
 * is the fallback for the snapshots taken before this field existed.
 */
export function resolvePageTitle(probe: PageProbeLike | undefined): string | undefined {
  const field = probe?.title;
  if (typeof field === 'string' && field.trim() !== '') return field;
  return extractPageTitle(probe?.body);
}

/**
 * The site's language: the field the scanner wrote, else the body.
 * Same rule as the title — see resolvePageTitle.
 */
export function resolvePageLang(probe: PageProbeLike | undefined): string | undefined {
  const field = probe?.lang;
  if (typeof field === 'string' && field.trim() !== '') return field;
  return extractPageLang(probe?.body);
}

/**
 * The site's own self-description: the field the scanner wrote, else the body.
 *
 * Same rule as the title and the language — the field is the only survivor of
 * a pruned body, the body is the fallback for the snapshots taken before the
 * field existed. Only the four known keys are read back, so a corrupted
 * field falls through to the body instead of poisoning the classification.
 */
export function resolvePageMeta(probe: PageProbeLike | undefined): PageMetaTags | undefined {
  const field = probe?.meta;
  if (field && typeof field === 'object' && !Array.isArray(field)) {
    const source = field as Record<string, unknown>;
    const out: PageMetaTags = {};
    if (typeof source.ogSiteName === 'string' && source.ogSiteName) out.ogSiteName = source.ogSiteName;
    if (typeof source.appName === 'string' && source.appName) out.appName = source.appName;
    if (typeof source.description === 'string' && source.description) out.description = source.description;
    if (typeof source.keywords === 'string' && source.keywords) out.keywords = source.keywords;
    if (Object.keys(out).length > 0) return out;
  }
  return extractPageMeta(probe?.body);
}
