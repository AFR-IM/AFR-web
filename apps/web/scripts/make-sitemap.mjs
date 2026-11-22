#!/usr/bin/env node
// make-sitemap.mjs — regenerate the sitemap from the current build inputs
// (top-level routes × locales, the 14 category pages, and every site detail
// page in src/data/generated/details/).
//
// Run after scripts/fetch-data.mjs refreshes the data and before `astro build`
// (public/ is copied verbatim into dist/). Node built-ins only, no deps.
//
// /sitemap.xml is a sitemap *index*; the URLs live in shards under
// /sitemaps/. One file cannot hold the catalog: a sitemap file may hold at
// most 50,000 URLs, and the catalog is heading for 100k sites (two URLs
// each, en + zh-CN). The split rules live in sitemap-contract.mjs — the
// generator and the guardrail share them, so neither can drift.
//
// Every entry carries <lastmod> plus xhtml:link hreflang alternates (en ↔ zh-CN).

import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CATS,
  INDEX_FILE,
  SHARD_DIR,
  TOP,
  planShards,
  renderIndex,
  renderShard,
  shardName,
  siteDomains,
} from './sitemap-contract.mjs';

const webDir = dirname(dirname(fileURLToPath(import.meta.url)));
const publicDir = join(webDir, 'public');
const shardDir = join(publicDir, SHARD_DIR);

const LASTMOD = new Date().toISOString().slice(0, 10); // the day this file is generated

const sites = siteDomains(webDir);
const staticPaths = [...TOP, ...CATS.map((s) => `/c/${s}`)];
const sitePaths = sites.map((d) => `/site/${d}`);

const shards = planShards(staticPaths, sitePaths, LASTMOD);

// A shorter catalog must not leave the shards of a longer one behind:
// an orphan shard is still deployed (and still counted as an asset), and a
// crawler that found it would read URLs the index no longer lists.
mkdirSync(shardDir, { recursive: true });
const wanted = new Set(shards.map((_, i) => `${i}.xml`));
for (const file of readdirSync(shardDir)) {
  if (file.endsWith('.xml') && !wanted.has(file)) rmSync(join(shardDir, file));
}

for (const [i, shard] of shards.entries()) {
  writeFileSync(join(publicDir, shardName(i)), renderShard(shard.paths, LASTMOD));
}
writeFileSync(join(publicDir, INDEX_FILE), renderIndex(shards, LASTMOD));

const urls = shards.reduce((n, s) => n + s.urls, 0);
console.log(
  `sitemap: ${urls} urls in ${shards.length} shards (${staticPaths.length} static paths, ` +
    `${sites.length} site pages) -> ${join(publicDir, INDEX_FILE)} + ${SHARD_DIR}/`,
);
