#!/usr/bin/env node
// make-sitemap.mjs — regenerate apps/web/public/sitemap.xml from the current
// build inputs (top-level routes × locales, the 14 category pages, and every
// site detail page in src/data/generated/details/).
//
// Run after scripts/fetch-data.mjs refreshes the data and before `astro build`
// (public/ is copied verbatim into dist/). Node built-ins only, no deps.
//
// Every entry carries <lastmod> plus xhtml:link hreflang alternates (en ↔ zh-CN).

import { readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const webDir = dirname(dirname(fileURLToPath(import.meta.url)));
const detailsDir = join(webDir, 'src/data/generated/details');
const out = join(webDir, 'public/sitemap.xml');

const SITE = 'https://aiapp.im';
const LASTMOD = new Date().toISOString().slice(0, 10); // the day this file is generated
const TOP = ['/', '/method', '/categories', '/search', '/submit', '/about', '/bot', '/badge', '/docs'];

// 14 first-level categories (spec §7.1) — same set the catalog ships.
const CATS = [
  'dev-tools', 'ai-tools', 'news', 'ecommerce', 'education', 'finance', 'social',
  'entertainment', 'health', 'travel', 'government', 'reference', 'docs', 'other',
];

// Site detail pages — mirrors loader.ts's availability gate: the build serves
// generated data only when src/data/generated/index.json (the manifest) is
// present, otherwise it falls back to fixtures.ts.
//   1. manifest + details/*.json present → generated inventory
//   2. otherwise → domains declared in fixtures.ts (fresh clone / pre-fetch)
//   3. last resort → dist/site (auditing an already-built tree)
function siteDomains() {
  const manifest = join(webDir, 'src/data/generated/index.json');
  if (existsSync(manifest) && existsSync(detailsDir)) {
    return readdirSync(detailsDir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => f.slice(0, -'.json'.length))
      .sort();
  }
  const fixtures = readFileSync(join(webDir, 'src/data/fixtures.ts'), 'utf8');
  const fromFixtures = [...new Set([...fixtures.matchAll(/\bdomain:\s*'([^']+)'/g)].map((m) => m[1]))].sort();
  if (fromFixtures.length > 0) return fromFixtures;
  const distSite = join(webDir, 'dist/site');
  if (existsSync(distSite)) {
    return readdirSync(distSite, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();
  }
  return [];
}

const sites = siteDomains();

const paths = [...TOP, ...CATS.map((s) => `/c/${s}`), ...sites.map((d) => `/site/${d}`)];

const enc = (p) => p.split('/').map(encodeURIComponent).join('/');

const entries = [];
for (const p of paths) {
  const enUrl = p === '/' ? `${SITE}/` : `${SITE}${enc(p)}`;
  const zhUrl = p === '/' ? `${SITE}/zh-CN/` : `${SITE}/zh-CN${enc(p)}`;
  entries.push({ loc: enUrl, en: enUrl, zh: zhUrl });
  entries.push({ loc: zhUrl, en: enUrl, zh: zhUrl });
}

const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">
${entries
  .map(
    (e) => `  <url>
    <loc>${e.loc}</loc>
    <xhtml:link rel="alternate" hreflang="en" href="${e.en}"/>
    <xhtml:link rel="alternate" hreflang="zh-CN" href="${e.zh}"/>
    <lastmod>${LASTMOD}</lastmod>
  </url>`,
  )
  .join('\n')}
</urlset>
`;

writeFileSync(out, xml);
console.log(`sitemap.xml: ${entries.length} urls (${paths.length} paths, ${sites.length} site pages) -> ${out}`);
