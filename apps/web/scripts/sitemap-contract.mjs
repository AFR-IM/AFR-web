// @afr/web — the sitemap contract.
//
// One place that knows what goes into the sitemap and how it is split into
// files. The generator writes what this says; the guardrail checks what
// the generator wrote. Neither may invent a rule of its own.
//
// Why a split at all: one sitemap file may hold at most 50,000 URLs and
// 50 MB (Google's limit). The catalog is heading for 100k sites, and every
// site has two copies (en + zh-CN) → 200k URLs in a single file would break
// the limit. So /sitemap.xml is a sitemap *index* and the URLs live in
// shards under /sitemaps/.
//
// How the split is made:
//   · the static pages (top-level routes + the 14 category pages) get
//     their own shard, so adding sites does not move them;
//   · the site pages are chunked, keeping a path and its zh-CN copy in the
//     same file — the hreflang alternates then never point across files;
//   · a chunk closes when the next path would push the file past the URL
//     cap or the byte cap. Both caps are far below Google's limits, so a
//     shard can never be rejected.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** The canonical origin (the canonical URLs point here, never at www). */
export const SITE = 'https://afr.im';

/** Google's limit is 50,000 URLs per file; we keep a 5× margin. */
export const MAX_URLS_PER_FILE = 10_000;

/** Google's limit is 50 MB per file; we keep a 10× margin. */
export const MAX_BYTES_PER_FILE = 5 * 1024 * 1024;

/** The shards live here; the index lives at /sitemap.xml. */
export const SHARD_DIR = 'sitemaps';
export const INDEX_FILE = 'sitemap.xml';

/** The top-level routes (the same set the site builds). */
export const TOP = [
  '/', '/method', '/categories', '/search', '/submit', '/about', '/bot', '/badges', '/docs', '/pro',
];

/** 14 first-level categories — same set the catalog ships. */
export const CATS = [
  'dev-tools', 'ai-tools', 'news', 'ecommerce', 'education', 'finance', 'social',
  'entertainment', 'health', 'travel', 'government', 'reference', 'docs', 'other',
];

/**
 * The domains the catalog holds.
 *
 * Mirrors loader.ts's availability gate: the build serves generated data
 * only when src/data/generated/index.json (the manifest) is present,
 * otherwise it falls back to fixtures.ts.
 *   1. manifest + details/*.json present → generated inventory
 *   2. otherwise → domains declared in fixtures.ts (fresh clone / pre-fetch)
 *   3. last resort → dist/site (auditing an already-built tree)
 */
export function siteDomains(webDir, { required = false } = {}) {
  const detailsDir = join(webDir, 'src/data/generated/details');
  const manifest = join(webDir, 'src/data/generated/index.json');
  if (existsSync(manifest) && existsSync(detailsDir)) {
    const domains = readdirSync(detailsDir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => f.slice(0, -'.json'.length))
      .sort();
    if (required) {
      const { sites } = JSON.parse(readFileSync(manifest, 'utf8'));
      if (!domains.length || sites !== domains.length) {
        throw new Error(`Incomplete generated catalog: ${domains.length} details, manifest expects ${sites}`);
      }
    }
    return domains;
  }
  if (required) throw new Error('Release sitemap requires a generated catalog; run fetch-data.mjs first.');
  const fixturesPath = join(webDir, 'src/data/fixtures.ts');
  if (existsSync(fixturesPath)) {
    const fixtures = readFileSync(fixturesPath, 'utf8');
    const fromFixtures = [
      ...new Set([...fixtures.matchAll(/\bdomain:\s*'([^']+)'/g)].map((m) => m[1])),
    ].sort();
    if (fromFixtures.length > 0) return fromFixtures;
  }
  const distSite = join(webDir, 'dist/site');
  if (existsSync(distSite)) {
    return readdirSync(distSite, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();
  }
  return [];
}

/** Astro builds every route as a directory; production serves the slash form. */
export const withSlash = (p) => (p === '/' || p.endsWith('/') ? p : `${p}/`);

/** Percent-encode a path, keeping the slashes. */
export const enc = (p) => p.split('/').map(encodeURIComponent).join('/');

/** The two canonical URLs of one path (en + zh-CN). */
export function urlsFor(path) {
  const p = withSlash(path);
  const en = `${SITE}${enc(p)}`;
  const zh = p === '/' ? `${SITE}/zh-CN/` : `${SITE}/zh-CN${enc(p)}`;
  return { en, zh };
}

/** One <url> entry: its own location plus the pair's hreflang alternates. */
export function urlEntry(loc, en, zh, lastmod) {
  return `  <url>
    <loc>${loc}</loc>
    <xhtml:link rel="alternate" hreflang="en" href="${en}"/>
    <xhtml:link rel="alternate" hreflang="zh-CN" href="${zh}"/>
    <lastmod>${lastmod}</lastmod>
  </url>`;
}

/**
 * The XML of one path: both locales, each pointing at the other.
 *
 * The zh entry lists the en URL as its "en" alternate (and vice versa) —
 * the alternates are the pair, not the file, so they never point across
 * shards.
 */
export function pathBlock(path, lastmod) {
  const { en, zh } = urlsFor(path);
  return `${urlEntry(en, en, zh, lastmod)}\n${urlEntry(zh, en, zh, lastmod)}`;
}

/** The whole <urlset> of one shard. */
export function renderShard(paths, lastmod) {
  const entries = paths.map((p) => pathBlock(p, lastmod));
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">
${entries.join('\n')}
</urlset>
`;
}

/**
 * The shards, in order.
 *
 * The first shard holds the static pages; the rest hold the site pages in
 * chunks. A chunk closes when the next path would push the file past the
 * URL cap or the byte cap.
 */
export function planShards(staticPaths, sitePaths, lastmod) {
  const shards = [];

  const staticBlock = staticPaths.map((p) => pathBlock(p, lastmod)).join('\n');
  shards.push({
    paths: [...staticPaths],
    urls: staticPaths.length * 2,
    bytes: staticBlock.length + 120,
  });

  let current = { paths: [], urls: 0, bytes: 0 };
  const flush = () => {
    if (current.paths.length > 0) shards.push({ ...current });
    current = { paths: [], urls: 0, bytes: 0 };
  };
  for (const path of sitePaths) {
    const bytes = pathBlock(path, lastmod).length + 1;
    if (
      current.paths.length > 0 &&
      (current.urls + 2 > MAX_URLS_PER_FILE || current.bytes + bytes > MAX_BYTES_PER_FILE)
    ) {
      flush();
    }
    current.paths.push(path);
    current.urls += 2;
    current.bytes += bytes;
  }
  flush();
  return shards;
}

/** The sitemap index that points at the shards. */
export function renderIndex(shards, lastmod) {
  const items = shards
    .map(
      (_, i) => `  <sitemap>
    <loc>${SITE}/${SHARD_DIR}/${i}.xml</loc>
    <lastmod>${lastmod}</lastmod>
  </sitemap>`,
    )
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${items}
</sitemapindex>
`;
}

/** The name of shard i (relative to the public directory). */
export const shardName = (i) => `${SHARD_DIR}/${i}.xml`;
