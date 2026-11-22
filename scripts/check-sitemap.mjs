#!/usr/bin/env node
// scripts/check-sitemap.mjs — guard for the sitemap (the index + its shards).
//
// Why this exists
//   The sitemap is how crawlers find the catalog, and it is built from a
//   moving target (the site list changes with every scan). Three things can
//   break it without any test noticing:
//
//     1. size — a sitemap file may hold at most 50,000 URLs and 50 MB
//        (Google's limit). One file with the whole catalog would be
//        rejected silently: the crawlers would just stop seeing new sites.
//     2. completeness — a shard that is missing or a path that was dropped
//        while chunking removes URLs from the index. Nothing errors; the
//        pages are simply never crawled.
//     3. the alternates — the hreflang pair of a page must point at the
//        other locale of the SAME path. A shard boundary that splits the
//        pair, or a copy-paste mistake, tells the search engines the two
//        locales are translations of different pages.
//
//   So this script asserts: the index is an index, it lists exactly the
//   shards that exist, every shard fits the caps, the shards together hold
//   every URL of the catalog (and only those), the alternates are right,
//   and the files on disk are byte-for-byte what the plan in
//   apps/web/scripts/sitemap-contract.mjs says they should be.
//
// Usage: node scripts/check-sitemap.mjs   (exit code 1 on any failure)

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CATS,
  INDEX_FILE,
  MAX_BYTES_PER_FILE,
  MAX_URLS_PER_FILE,
  SHARD_DIR,
  SITE,
  TOP,
  planShards,
  renderIndex,
  renderShard,
  shardName,
  siteDomains,
  urlsFor,
} from '../apps/web/scripts/sitemap-contract.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, '..');
const WEB_DIR = join(ROOT, 'apps/web');
export const DEFAULT_PUBLIC_DIR = join(WEB_DIR, 'public');

/** Google's own hard limits — the caps we keep a margin under. */
const GOOGLE_MAX_URLS = 50_000;
const GOOGLE_MAX_BYTES = 50 * 1024 * 1024;
const GOOGLE_MAX_INDEX_ENTRIES = 50_000;

/** Pull the <url> blocks out of a urlset. */
function parseUrlset(xml) {
  const out = [];
  for (const m of xml.matchAll(/<url>([\s\S]*?)<\/url>/g)) {
    const block = m[1];
    const loc = /<loc>([^<]*)<\/loc>/.exec(block)?.[1];
    const alts = [...block.matchAll(/hreflang="([^"]+)" href="([^"]+)"/g)].map((a) => [a[1], a[2]]);
    const lastmod = /<lastmod>([^<]*)<\/lastmod>/.exec(block)?.[1];
    if (loc) out.push({ loc, alts, lastmod });
  }
  return out;
}

/** Pull the <sitemap> entries out of the index. */
function parseIndex(xml) {
  const out = [];
  for (const m of xml.matchAll(/<sitemap>([\s\S]*?)<\/sitemap>/g)) {
    const block = m[1];
    const loc = /<loc>([^<]*)<\/loc>/.exec(block)?.[1];
    const lastmod = /<lastmod>([^<]*)<\/lastmod>/.exec(block)?.[1];
    if (loc) out.push({ loc, lastmod });
  }
  return out;
}

/** The path a location stands for (the /zh-CN prefix removed). */
function pathOfLoc(loc) {
  let p = loc.startsWith(SITE) ? loc.slice(SITE.length) : loc;
  if (p.startsWith('/zh-CN')) p = p.slice('/zh-CN'.length);
  return p === '' ? '/' : p;
}

/**
 * Check the sitemap tree.
 *
 * @param {object} opts
 * @param {string} [opts.publicDir] where sitemap.xml and the shards live
 * @param {string[]} [opts.sites] the catalog (defaults to the built one)
 */
export function runChecks({ publicDir = DEFAULT_PUBLIC_DIR, sites } = {}) {
  const failures = [];
  const notes = [];
  const metrics = {};

  const indexPath = join(publicDir, INDEX_FILE);
  const shardDir = join(publicDir, SHARD_DIR);

  if (!existsSync(indexPath)) {
    failures.push(`${INDEX_FILE} is missing (run apps/web/scripts/make-sitemap.mjs)`);
    return { failures, notes, metrics };
  }
  const indexXml = readFileSync(indexPath, 'utf8');
  if (!/<sitemapindex[\s>]/.test(indexXml)) {
    failures.push(`${INDEX_FILE} is not a sitemap index (<sitemapindex>)`);
  }
  const index = parseIndex(indexXml);
  metrics.indexEntries = index.length;
  if (index.length > GOOGLE_MAX_INDEX_ENTRIES) {
    failures.push(`the index lists ${index.length} sitemaps (Google allows ${GOOGLE_MAX_INDEX_ENTRIES})`);
  }

  // The catalog the sitemap must cover.
  const domains = sites ?? siteDomains(WEB_DIR);
  const staticPaths = [...TOP, ...CATS.map((s) => `/c/${s}`)];
  const sitePaths = domains.map((d) => `/site/${d}`);

  // The lastmod the files were written with — the plan is re-rendered with
  // it, so the check compares bytes and not just shapes.
  const lastmod = index[0]?.lastmod ?? '';
  const shards = planShards(staticPaths, sitePaths, lastmod);

  // 1. the index lists exactly the shards that exist
  const listed = index.map((s) => s.loc);
  const expectedLocs = shards.map((_, i) => `${SITE}/${shardName(i)}`);
  if (listed.length !== expectedLocs.length || listed.some((loc, i) => loc !== expectedLocs[i])) {
    failures.push(
      `the index does not list the planned shards: got ${listed.length}, expected ${expectedLocs.length} (${expectedLocs.slice(0, 3).join(', ')}…)`,
    );
  }
  const onDisk = existsSync(shardDir)
    ? readdirSync(shardDir).filter((f) => f.endsWith('.xml')).sort()
    : [];
  const listedNames = listed.map((loc) => loc.replace(`${SITE}/`, ''));
  for (const file of onDisk) {
    if (!listedNames.includes(`${SHARD_DIR}/${file}`)) {
      failures.push(`${SHARD_DIR}/${file} exists but the index does not list it (orphan shard)`);
    }
  }
  for (const name of listedNames) {
    if (!onDisk.includes(name.replace(`${SHARD_DIR}/`, ''))) {
      failures.push(`the index lists ${name} but the file does not exist`);
    }
  }

  // 2. every shard fits the caps, and the bytes are what the plan says
  let totalUrls = 0;
  const seen = new Map();
  for (const [i, shard] of shards.entries()) {
    const file = join(publicDir, shardName(i));
    if (!existsSync(file)) {
      failures.push(`${shardName(i)} is missing`);
      continue;
    }
    const xml = readFileSync(file, 'utf8');
    const bytes = Buffer.byteLength(xml, 'utf8');
    const entries = parseUrlset(xml);
    totalUrls += entries.length;
    if (entries.length > MAX_URLS_PER_FILE) {
      failures.push(`${shardName(i)} holds ${entries.length} URLs (cap ${MAX_URLS_PER_FILE})`);
    }
    if (entries.length > GOOGLE_MAX_URLS) {
      failures.push(`${shardName(i)} holds ${entries.length} URLs (Google allows ${GOOGLE_MAX_URLS})`);
    }
    if (bytes > MAX_BYTES_PER_FILE) {
      failures.push(`${shardName(i)} is ${bytes} B (cap ${MAX_BYTES_PER_FILE} B)`);
    }
    if (bytes > GOOGLE_MAX_BYTES) {
      failures.push(`${shardName(i)} is ${bytes} B (Google allows ${GOOGLE_MAX_BYTES} B)`);
    }
    const expected = renderShard(shard.paths, lastmod);
    if (xml !== expected) {
      failures.push(`${shardName(i)} does not match the plan (bytes differ from sitemap-contract.mjs)`);
    }
    // 3. the alternates point at the other locale of the same path
    for (const entry of entries) {
      const en = entry.alts.find((a) => a[0] === 'en')?.[1];
      const zh = entry.alts.find((a) => a[0] === 'zh-CN')?.[1];
      if (!en || !zh) {
        failures.push(`${shardName(i)}: ${entry.loc} has no hreflang pair`);
        continue;
      }
      if (en === zh) {
        failures.push(`${shardName(i)}: ${entry.loc} points both locales at ${en}`);
        continue;
      }
      if (seen.has(entry.loc)) {
        failures.push(`${entry.loc} appears in more than one shard`);
      }
      seen.set(entry.loc, entry);
      // Both entries of a pair carry the same alternates: the en URL and
      // the zh URL of the same path.
      const want = urlsFor(pathOfLoc(entry.loc));
      if (en !== want.en || zh !== want.zh) {
        failures.push(
          `${entry.loc}: the alternates are ${en} / ${zh}, expected ${want.en} / ${want.zh}`,
        );
      }
    }
  }

  // 4. the shards together hold every URL of the catalog — and only those
  const expectedUrls = new Set();
  for (const path of [...staticPaths, ...sitePaths]) {
    const { en, zh } = urlsFor(path);
    expectedUrls.add(en);
    expectedUrls.add(zh);
  }
  for (const loc of expectedUrls) {
    if (!seen.has(loc)) failures.push(`${loc} is missing from the sitemap`);
  }
  for (const loc of seen.keys()) {
    if (!expectedUrls.has(loc)) failures.push(`${loc} is in the sitemap but not in the catalog`);
  }

  metrics.urls = totalUrls;
  metrics.shards = shards.length;
  metrics.expectedUrls = expectedUrls.size;
  metrics.sites = domains.length;
  metrics.staticPaths = staticPaths.length;
  if (totalUrls !== expectedUrls.size) {
    failures.push(`the shards hold ${totalUrls} URLs, the catalog has ${expectedUrls.size}`);
  }
  if (lastmod) {
    const expectedIndex = renderIndex(shards, lastmod);
    if (indexXml !== expectedIndex) {
      failures.push(`${INDEX_FILE} does not match the plan (bytes differ from sitemap-contract.mjs)`);
    }
  }
  notes.push(`catalog: ${domains.length} sites + ${staticPaths.length} static paths`);
  return { failures, notes, metrics };
}

// ── CLI ────────────────────────────────────────────────────────────────────
const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) {
  const { failures, notes, metrics } = runChecks();
  for (const note of notes) console.log(`note: ${note}`);
  console.log(
    `sitemap: ${metrics.urls} urls in ${metrics.shards} shards ` +
      `(cap ${MAX_URLS_PER_FILE} urls / ${(MAX_BYTES_PER_FILE / 1024 / 1024).toFixed(0)} MB per file) — ${INDEX_FILE} + ${SHARD_DIR}/`,
  );
  if (failures.length > 0) {
    console.error(`FAIL: ${failures.length} problem(s) with the sitemap:`);
    for (const failure of failures.slice(0, 20)) console.error(`  · ${failure}`);
    if (failures.length > 20) console.error(`  … and ${failures.length - 20} more`);
    process.exit(1);
  }
  console.log('All checks passed');
}
