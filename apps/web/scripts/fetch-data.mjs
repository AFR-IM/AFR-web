#!/usr/bin/env node
// @afr/web — fetch-data: turns AFR-data scan snapshots into the build-time
// JSON payloads that src/data/loader.ts serves to pages.
//
// Usage (from anywhere inside the repo):
//   node apps/web/scripts/fetch-data.mjs [--date YYYY-MM-DD] [--data-dir PATH]
//
//   --date      publish one date only (debug); default = merged view, newest wins
//   --allow-shrink  bypass the >20% drop guard
//               under the scans root
//   --data-dir  explicit scans root (…/AFR-data/scans); otherwise resolved
//               from a few well-known relative locations
//
// Outputs (generated artifacts — gitignored; the scan repo stays the SSOT):
//   src/data/generated/index.json        manifest {date, sites, scored, pending}
//   src/data/generated/home.json         HomeData — scored sites only + pendingCount
//   src/data/generated/categories.json   {slug: SiteCard[]} — scored, score desc
//   src/data/generated/details/<domain>.json  SiteDetail, scored AND pending
//   public/data/search-index.json        the legacy single index (while it fits)
//   public/data/search-index/<id>.json   one index shard per first character
//   public/data/search-index-top.json    the leaderboard slice (the browse case)
//   public/data/search-index-manifest.json  what the browser reads first
//
// Pending sites (grade 'Pending': neither homepage nor robots readable) are
// excluded from every card list / distribution / average, but do get a detail
// page. They are not in the search index either: the browser dropped them
// from the results anyway, so they only cost wire bytes.

import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { brotliCompressSync, constants } from 'node:zlib';
import { CATEGORY_SLUGS, categorize } from '../src/data/categorize.mjs';
import { CATEGORY_OVERRIDES_FILE, CLAIMS_FILE, SITE_PATHS_FILE, buildDetail, resolveCategorySlug } from '../src/data/detail.ts';
import { fetchCategoryOverrides } from './fetch-category-overrides.mjs';
import { fetchPublishedClaims } from './fetch-claims.mjs';
import { CHARITY_LEDGER_FILE, fetchCharityLedger } from './fetch-charity-ledger.mjs';
import { resolvePageLang, resolvePageMeta, resolvePageTitle } from '../../../packages/scanner/src/page-meta.ts';
import {
  SEARCH_INDEX_RAW_PER_ENTRY,
  SEARCH_INDEX_WIRE_BUDGET,
  SEARCH_LEGACY_FILE,
  SEARCH_MANIFEST_FILE,
  SEARCH_SHARD_DIR,
  SEARCH_TOP_FILE,
  SEARCH_TOP_SLICE_SIZE,
  assignShards,
  buildSearchEntry,
  buildShardManifest,
  gradeFor,
  shardFileFor,
} from './search-index-contract.mjs';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIR = path.resolve(SCRIPT_DIR, '..'); // apps/web
const GENERATED_DIR = path.join(WEB_DIR, 'src', 'data', 'generated');
const DETAILS_DIR = path.join(GENERATED_DIR, 'details');
const PUBLIC_DATA_DIR = path.join(WEB_DIR, 'public', 'data');
// The published copy of the retirement list (src/data/delisted.json). The
// Worker's directory reconcile fetches exactly this file, so the
// "no longer listed" owner mail and the retirement note on the page can
// never disagree.
const DELISTED_FILE = 'delisted.json';

const LEADERBOARD_SIZE = 50;
const LATEST_SIZE = 24;
// The index is served with brotli by Cloudflare, so the cost a visitor pays is
// the wire size, not the raw JSON. Budgets (SSOT §7b/T7):
//  - wire budget: 160 KB compressed — measured with brotli, not estimated;
//  - raw guard: 96 B/entry — linear headroom, not a fixed ceiling, so growth
//    does not warn before it actually matters.
// Re-shard before 10k sites regardless (SSOT item 20: on-demand detail pages
// + sitemap sharding make the client index a leaderboard/search slice only).
// The payload rules themselves live in scripts/search-index-contract.mjs.
const STATS_API_URL = process.env.AFR_STATS_API_URL ?? 'https://afr.im/api/v1/stats';

/** Brotli-compressed size of a payload — what the browser actually downloads. */
function brotliBytes(text) {
  return brotliCompressSync(Buffer.from(text, 'utf8'), {
    params: { [constants.BROTLI_PARAM_QUALITY]: 4 },
  }).length;
}

async function readPublicStats() {
  try {
    const response = await fetch(STATS_API_URL, { signal: AbortSignal.timeout(8000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const stats = await response.json();
    if (!Number.isSafeInteger(stats.verified) || !Number.isSafeInteger(stats.total_views)) {
      throw new Error('unexpected stats payload');
    }
    return stats;
  } catch (error) {
    console.warn(`Public stats snapshot unavailable; continuing without runtime stats: ${error.message}`);
    return null;
  }
}
// Entries retired from public listings (kept in git history / detail pages,
// excluded from every ranking, category, and search payload).
const DELISTED = JSON.parse(
  await readFile(new URL('../src/data/delisted.json', import.meta.url), 'utf8'),
);

function parseArgs(argv) {
  const args = { date: undefined, dataDir: undefined };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--allow-shrink') {
      args.allowShrink = true;
    } else if (a === '--date') {
      args.date = argv[++i];
    } else if (a.startsWith('--date=')) {
      args.date = a.slice('--date='.length);
    } else if (a === '--data-dir') {
      args.dataDir = argv[++i];
    } else if (a.startsWith('--data-dir=')) {
      args.dataDir = a.slice('--data-dir='.length);
    } else if (a === '--help' || a === '-h') {
      console.log('Usage: fetch-data.mjs [--date YYYY-MM-DD] [--data-dir PATH] [--allow-shrink]');
      process.exit(0);
    } else {
      console.error(`Unknown argument: ${a}`);
      process.exit(2);
    }
  }
  if (args.date && !/^\d{4}-\d{2}-\d{2}$/.test(args.date)) {
    console.error(`--date must be YYYY-MM-DD, got: ${args.date}`);
    process.exit(2);
  }
  return args;
}

async function isDir(p) {
  try {
    return (await stat(p)).isDirectory();
  } catch {
    return false;
  }
}

async function resolveScansRoot(explicit) {
  if (explicit) {
    if (!(await isDir(explicit))) {
      console.error(`--data-dir is not a directory: ${explicit}`);
      process.exit(1);
    }
    return path.resolve(explicit);
  }
  const candidates = [
    path.resolve(process.cwd(), '../../AFR-data/scans'), // as documented (cwd-relative)
    path.resolve(process.cwd(), '../AFR-data/scans'), // repo root cwd → sibling repo
    path.resolve(process.cwd(), 'AFR-data/scans'), // parent-of-both cwd
    path.resolve(SCRIPT_DIR, '../../../../AFR-data/scans'), // script-relative, cwd-independent
  ];
  for (const c of candidates) {
    if (await isDir(c)) return c;
  }
  console.error('Could not locate the AFR-data scans directory. Tried:');
  for (const c of candidates) console.error(`  ${c}`);
  console.error('Pass --data-dir /path/to/AFR-data/scans');
  process.exit(1);
}

/** Latest YYYY-MM-DD that contains at least one .json snapshot. */
async function latestDate(scansRoot) {
  const years = (await readdir(scansRoot, { withFileTypes: true }))
    .filter((d) => d.isDirectory() && /^\d{4}$/.test(d.name))
    .map((d) => d.name)
    .sort()
    .reverse();
  for (const y of years) {
    const months = (await readdir(path.join(scansRoot, y), { withFileTypes: true }))
      .filter((d) => d.isDirectory() && /^\d{2}$/.test(d.name))
      .map((d) => d.name)
      .sort()
      .reverse();
    for (const m of months) {
      const days = (await readdir(path.join(scansRoot, y, m), { withFileTypes: true }))
        .filter((d) => d.isDirectory() && /^\d{2}$/.test(d.name))
        .map((d) => d.name)
        .sort()
        .reverse();
      for (const d of days) {
        const dir = path.join(scansRoot, y, m, d);
        const files = await readdir(dir);
        if (files.some((f) => f.endsWith('.json'))) return `${y}-${m}-${d}`;
      }
    }
  }
  return null;
}

/** All date directories (YYYY-MM-DD), oldest first — for the merged view. */
async function listAllDates(scansRoot) {
  const out = [];
  const years = (await readdir(scansRoot, { withFileTypes: true }))
    .filter((d) => d.isDirectory() && /^\d{4}$/.test(d.name))
    .map((d) => d.name)
    .sort();
  for (const y of years) {
    const months = (await readdir(path.join(scansRoot, y), { withFileTypes: true }))
      .filter((d) => d.isDirectory() && /^\d{2}$/.test(d.name))
      .map((d) => d.name)
      .sort();
    for (const m of months) {
      const days = (await readdir(path.join(scansRoot, y, m), { withFileTypes: true }))
        .filter((d) => d.isDirectory() && /^\d{2}$/.test(d.name))
        .map((d) => d.name)
        .sort();
      for (const d of days) out.push({ date: `${y}-${m}-${d}`, dir: path.join(scansRoot, y, m, d) });
    }
  }
  return out;
}

// The title, the language and the self-description of a site come from the
// scanner's own fields (`signals.homepage.title` / `.lang` / `.meta`), with
// the homepage body as the fallback for the snapshots taken before those
// fields existed. Both paths apply the same rules — see
// packages/scanner/src/page-meta.ts.

const byScoreDesc = (a, b) => b.score - a.score || a.domain.localeCompare(b.domain);
const byScanDesc = (a, b) =>
  b.scannedAt.localeCompare(a.scannedAt) || a.domain.localeCompare(b.domain);

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const scansRoot = await resolveScansRoot(args.dataDir);

  // Merged view (default): every snapshot dir, one file per domain — the
  // newest date wins. A single partial date (e.g. two queue scans on a new
  // day) must never overwrite the full catalog again (2026-11-12 incident).
  // --date keeps the old single-day behavior for targeted rebuilds.
  let plan; // [{dir, names[]}] or [{dir, names[]}]
  let mode = 'merged';
  if (args.date) {
    mode = 'date';
    const [y, m, d] = args.date.split('-');
    const dateDir = path.join(scansRoot, y, m, d);
    if (!(await isDir(dateDir))) {
      console.error(`Scan date not found: ${args.date} (${dateDir})`);
      process.exit(1);
    }
    const names = (await readdir(dateDir)).filter((f) => f.endsWith('.json')).sort();
    if (names.length === 0) {
      console.error(`No .json snapshots in ${dateDir}`);
      process.exit(1);
    }
    plan = [{ dir: dateDir, names }];
  } else {
    const dates = await listAllDates(scansRoot);
    const byDomain = new Map(); // domain -> {dir, name} (later dates overwrite)
    for (const { dir } of dates) {
      const names = (await readdir(dir)).filter((f) => f.endsWith('.json'));
      for (const name of names) byDomain.set(name, { dir, name });
    }
    if (byDomain.size === 0) {
      console.error(`No dated scan directories with .json files under ${scansRoot}`);
      process.exit(1);
    }
    const grouped = new Map();
    for (const entry of byDomain.values()) {
      if (!grouped.has(entry.dir)) grouped.set(entry.dir, []);
      grouped.get(entry.dir).push(entry.name);
    }
    plan = [...grouped.entries()].map(([dir, names]) => ({ dir, names: names.sort() }));
    console.log(`merged view: ${byDomain.size} domains across ${plan.length} date dir(s)`);
  }

  // shrink guard: a big drop vs the previous build almost always means a
  // partial dataset, never an intentional purge (data lives in git history).
  if (!args.allowShrink) {
    try {
      const prev = JSON.parse(await readFile(new URL('./generated/index.json', import.meta.url), 'utf8'));
      const planned = plan.reduce((n, p) => n + p.names.length, 0);
      const floor = Math.floor((prev.sites ?? 0) * 0.8);
      if (prev.sites > 0 && planned < floor) {
        console.error(
          `REFUSING to build: ${planned} snapshots vs ${prev.sites} in the previous build ` +
            `(drop > 20%). Data is never deleted — check the scan dirs, or pass --allow-shrink ` +
            `if this is intentional.`,
        );
        process.exit(1);
      }
    } catch {
      /* no previous manifest — first build */
    }
  }

  // ── read + normalize snapshots ────────────────────────────────────────────
  const sites = [];
  let skipped = 0;
  const entries = plan.flatMap((p) => p.names.map((name) => ({ dir: p.dir, name })));
  for (const { dir, name } of entries) {
    let raw;
    try {
      raw = JSON.parse(await readFile(path.join(dir, name), 'utf8'));
    } catch (err) {
      skipped++;
      console.warn(`skip ${name}: ${err.message}`);
      continue;
    }
    const afr = raw?.afr;
    if (!afr || typeof afr.score !== 'number' || !Array.isArray(afr.layers)) {
      skipped++;
      console.warn(`skip ${name}: missing afr payload`);
      continue;
    }
    const homepage = raw?.signals?.homepage;
    // Field first, body second: the title/lang/meta the scanner captured
    // survive a pruned body, and the body covers the snapshots taken before
    // the fields existed. Both paths apply the same rules, so a site reads
    // the same either way.
    const title = resolvePageTitle(homepage);
    const lang = resolvePageLang(homepage);
    const meta = resolvePageMeta(homepage);
    const category = categorize(afr.domain ?? name.replace(/\.json$/, ''), title, meta);
    sites.push({ afr, title, lang, category, probe: homepage });
  }

  // The on-demand detail pages need to know where a domain's snapshot
  // lives: the newest date directory that holds it — the same merge rule
  // the site build uses (a later date wins). One map, one asset.
  const sitePaths = {};
  for (const { dir, name } of entries) {
    const domain = name.replace(/\.json$/, '');
    sitePaths[domain] = path.relative(scansRoot, dir).split(path.sep).join('/');
  }
  if (sites.length === 0) {
    console.error('No usable snapshots found.');
    process.exit(1);
  }

  const isPendingSite = (s) => s.afr.state === 'pending' || s.afr.grade === 'Pending';
  const domainOf = (s) => s.afr.domain ?? '';

  // A human label from the console beats the keyword table. The API publishes
  // only the sites that were labelled by hand; an unreachable endpoint yields
  // an empty map, so the build falls back to exactly what it shipped before.
  const overrides = await fetchCategoryOverrides();
  const claims = await fetchPublishedClaims();
  // The append-only ledger is an asset as well: the repo carries a mirror so
  // the trail stays verifiable even when the live endpoint is unreachable.
  const ledger = await fetchCharityLedger();
  let overridden = 0;
  for (const s of sites) {
    const resolved = resolveCategorySlug(domainOf(s), s.category, overrides);
    if (resolved !== s.category) {
      s.category = resolved;
      overridden += 1;
    }
  }
  if (overridden > 0) {
    console.log(`categories : ${overridden} site(s) use a manual label from the console`);
  }

  const scored = sites.filter((s) => !isPendingSite(s) && !DELISTED[domainOf(s)]);
  const pending = sites.filter(isPendingSite);

  // ── card / detail builders ────────────────────────────────────────────────
  const cardOf = (s) => {
    const card = { domain: s.afr.domain };
    if (s.title) card.title = s.title;
    card.score = s.afr.score;
    card.grade = s.afr.grade;
    card.strategyTag = s.afr.strategyTag;
    card.category = s.category;
    if (s.lang) card.lang = s.lang;
    card.scannedAt = s.afr.scannedAt;
    return card;
  };

  // The detail payload comes from the shared builder (src/data/detail.ts) —
  // the same one the on-demand detail pages use, so the two cannot drift.
  const detailOf = (s) => buildDetail({ afr: s.afr, signals: { homepage: s.probe } }, domainOf(s), DELISTED, overrides, claims);

  // ── home payload (scored only) ────────────────────────────────────────────
  const scoredCards = scored.map(cardOf).sort(byScoreDesc);
  const distribution = { A: 0, B: 0, C: 0, D: 0, F: 0 };
  let scoreSum = 0;
  for (const s of scored) {
    if (s.afr.grade in distribution) distribution[s.afr.grade] += 1;
    scoreSum += s.afr.score;
  }
  const latestScannedAt = sites.reduce(
    (max, s) => (s.afr.scannedAt > max ? s.afr.scannedAt : max),
    '',
  );

  const countsByCategory = new Map(CATEGORY_SLUGS.map((slug) => [slug, 0]));
  for (const c of scoredCards) {
    countsByCategory.set(c.category, (countsByCategory.get(c.category) ?? 0) + 1);
  }
  const categories = CATEGORY_SLUGS.map((slug) => ({ slug, count: countsByCategory.get(slug) ?? 0 }))
    .filter((c) => c.count > 0)
    .sort((a, b) => b.count - a.count || a.slug.localeCompare(b.slug));

  const stats = await readPublicStats();
  const home = {
    generatedAt: latestScannedAt,
    total: scored.length,
    avgScore: scored.length > 0 ? Math.round((scoreSum / scored.length) * 10) / 10 : 0,
    distribution,
    pendingCount: pending.length,
    ...(stats ? {
      verifiedCount: stats.verified,
      totalViews: stats.total_views,
      statsCapturedAt: new Date().toISOString(),
    } : {}),
    categories,
    leaderboard: scoredCards.slice(0, LEADERBOARD_SIZE),
    latest: [...scoredCards].sort(byScanDesc).slice(0, LATEST_SIZE),
  };

  // ── categories payload (scored only, grouped, score desc) ────────────────
  const grouped = {};
  for (const slug of CATEGORY_SLUGS) grouped[slug] = [];
  for (const c of scoredCards) (grouped[c.category] ??= []).push(c);
  for (const list of Object.values(grouped)) list.sort(byScoreDesc);

  // ── search index (rated sites, compact keys) ─────────────────────────────
  // The client search payload. The rules live in
  // scripts/search-index-contract.mjs:
  //   · pending (unratable) sites are not listed — the browser filtered them
  //     out of the results anyway, so they only cost wire bytes;
  //   · the grade is not carried — the browser derives it from the score with
  //     the engine's own thresholds (packages/shared GRADE_THRESHOLDS), which
  //     the page serializes into the DOM;
  //   · 'other' renders no chip, so the category key is omitted;
  //   · the title is cut on a word boundary (SEARCH_TITLE_MAX characters).
  //
  // The grade rule is checked here, at build time: if the thresholds moved
  // after a snapshot was taken, the derived grade and the snapshot grade
  // disagree and the build stops instead of publishing a card that says
  // something else than the site's own report.
  const searchIndex = [];
  for (const s of scored) {
    const grade = gradeFor(s.afr.score);
    if (grade !== s.afr.grade) {
      console.error(
        `REFUSING to build: ${s.afr.domain} scored ${s.afr.score} → grade ${grade}, ` +
          `but its snapshot says ${s.afr.grade}. The grade thresholds changed after ` +
          `this snapshot was taken — re-scan the site before publishing it.`,
      );
      process.exit(1);
    }
    searchIndex.push(
      buildSearchEntry({
        domain: s.afr.domain,
        score: s.afr.score,
        category: s.category,
        title: s.title,
      }),
    );
  }
  searchIndex.sort((a, b) => b.s - a.s || a.d.localeCompare(b.d));

  // ── write outputs ────────────────────────────────────────────────────────
  await rm(GENERATED_DIR, { recursive: true, force: true });
  await mkdir(DETAILS_DIR, { recursive: true });
  await mkdir(PUBLIC_DATA_DIR, { recursive: true });
  await rm(path.join(PUBLIC_DATA_DIR, SEARCH_SHARD_DIR), { recursive: true, force: true });
  await mkdir(path.join(PUBLIC_DATA_DIR, SEARCH_SHARD_DIR), { recursive: true });

  const writeJson = async (file, data) => {
    await writeFile(file, `${JSON.stringify(data)}\n`, 'utf8');
    return (await stat(file)).size;
  };

  const manifest = { date: mode === 'date' ? args.date : 'merged', mode, sites: sites.length, scored: scored.length, pending: pending.length };
  await writeJson(path.join(GENERATED_DIR, 'index.json'), manifest);
  const homeBytes = await writeJson(path.join(GENERATED_DIR, 'home.json'), home);
  const catBytes = await writeJson(path.join(GENERATED_DIR, 'categories.json'), grouped);

  let detailBytes = 0;
  for (const s of sites) {
    detailBytes += await writeJson(path.join(DETAILS_DIR, `${s.afr.domain}.json`), detailOf(s));
  }

  // ── the search index: shards + manifest + the legacy single file ────────
  // The browser reads the manifest first, then fetches the shard(s) it
  // needs. The legacy single file stays as long as the whole catalog fits
  // the wire budget: a page cached from before the shards existed asks for
  // /data/search-index.json by name and must find it.
  const searchJson = `${JSON.stringify(searchIndex)}\n`;
  const searchBytes = Buffer.byteLength(searchJson, 'utf8');
  // The browser pays the compressed size — measure it, do not estimate it.
  const wireBytes = brotliBytes(searchJson);

  const shards = assignShards(searchIndex);
  const sizes = {};
  let shardWireMax = 0;
  let shardRawMax = 0;
  let shardRawBudget = 0;
  for (const [id, shardEntries] of shards) {
    const text = `${JSON.stringify(shardEntries)}\n`;
    const raw = Buffer.byteLength(text, 'utf8');
    const wire = brotliBytes(text);
    sizes[id] = { raw, wire };
    if (wire > shardWireMax) shardWireMax = wire;
    if (raw > shardRawMax) shardRawMax = raw;
    if (raw > shardEntries.length * SEARCH_INDEX_RAW_PER_ENTRY) shardRawBudget = id;
    await writeFile(path.join(PUBLIC_DATA_DIR, shardFileFor(id)), text, 'utf8');
  }

  // The leaderboard slice: the browse case must not download the catalog.
  const topEntries = searchIndex.slice(0, SEARCH_TOP_SLICE_SIZE);
  const topJson = `${JSON.stringify(topEntries)}\n`;
  const topSize = { raw: Buffer.byteLength(topJson, 'utf8'), wire: brotliBytes(topJson) };
  await writeFile(path.join(PUBLIC_DATA_DIR, SEARCH_TOP_FILE), topJson, 'utf8');

  const shardManifest = buildShardManifest({
    shards,
    top: topEntries,
    entries: searchIndex.length,
    sizes,
    topSize,
  });
  await writeFile(
    path.join(PUBLIC_DATA_DIR, SEARCH_MANIFEST_FILE),
    `${JSON.stringify(shardManifest)}\n`,
    'utf8',
  );

  // The manual labels are an asset as well: the on-demand detail page reads
  // exactly this file, so a rendered page and the built one agree.
  await writeFile(
    path.join(PUBLIC_DATA_DIR, CATEGORY_OVERRIDES_FILE),
    `${JSON.stringify(overrides)}\n`,
    'utf8',
  );

  // The published owner statements, same rule: the on-demand page reads
  // this file, so a statement the moderation queue published shows up on
  // both the built report and the rendered one.
  await writeFile(
    path.join(PUBLIC_DATA_DIR, CLAIMS_FILE),
    `${JSON.stringify(claims)}\n`,
    'utf8',
  );

  // The charity ledger mirror — the endpoint stays the source of truth; a
  // failed fetch already warned above and ships the honest empty ledger.
  await writeFile(
    path.join(PUBLIC_DATA_DIR, CHARITY_LEDGER_FILE),
    `${JSON.stringify(ledger)}\n`,
    'utf8',
  );

  // The snapshot index of the on-demand detail pages: domain → the date
  // directory that holds its newest snapshot (see src/data/runtime-detail.ts).
  await writeFile(
    path.join(PUBLIC_DATA_DIR, SITE_PATHS_FILE),
    `${JSON.stringify(sitePaths)}\n`,
    'utf8',
  );

  // The retirement list, published as data as well: the Worker reconciles
  // the directory state against this exact file (additions/removals alerts).
  await writeFile(
    path.join(PUBLIC_DATA_DIR, DELISTED_FILE),
    `${JSON.stringify(DELISTED)}\n`,
    'utf8',
  );

  // A shard that outgrows the budget is the signal that the shard key needs
  // another level — the build must not publish a payload the browser cannot
  // afford.
  if (shardWireMax > SEARCH_INDEX_WIRE_BUDGET) {
    console.error(
      `REFUSING to build: the largest search shard is ${shardWireMax} B on the wire ` +
        `(budget ${SEARCH_INDEX_WIRE_BUDGET} B) — the shard key needs another level ` +
        '(SSOT item 20)',
    );
    process.exit(1);
  }
  if (shardRawBudget) {
    console.error(
      `REFUSING to build: search shard "${shardRawBudget}" is ${shardRawMax} B raw, over the ` +
        `${SEARCH_INDEX_RAW_PER_ENTRY} B/entry guard — the shard key needs another level`,
    );
    process.exit(1);
  }

  const legacyPath = path.join(PUBLIC_DATA_DIR, SEARCH_LEGACY_FILE);
  const legacyFits = wireBytes <= SEARCH_INDEX_WIRE_BUDGET;
  if (legacyFits) {
    await writeFile(legacyPath, searchJson, 'utf8');
  } else {
    await rm(legacyPath, { force: true });
  }

  // ── summary ───────────────────────────────────────────────────────────────
  const mapped = sites.filter((s) => s.category !== 'other').length;
  const coverage = ((mapped / sites.length) * 100).toFixed(1);
  const distStr = Object.entries(distribution)
    .map(([g, n]) => `${g} ${n}`)
    .join(' ');

  console.log(`scans root : ${scansRoot}`);
  console.log(`view       : ${mode === 'date' ? args.date : 'merged (newest per domain)'}`);
  console.log(`sites      : ${sites.length} (scored ${scored.length}, pending ${pending.length}${skipped ? `, skipped ${skipped}` : ''})`);
  console.log(`avg score  : ${home.avgScore} (scored only)`);
  console.log(`distribution: ${distStr}`);
  console.log(`categories : ${categories.length} non-empty, coverage ${mapped}/${sites.length} (${coverage}%) by keyword/TLD, rest → other`);
  console.log(`written    : src/data/generated/index.json, home.json, categories.json, details/*.json (${(detailBytes / 1024).toFixed(0)} KB)`);
  console.log(`             home.json ${(homeBytes / 1024).toFixed(1)} KB · categories.json ${(catBytes / 1024).toFixed(1)} KB`);
  const rawBudget = searchIndex.length * SEARCH_INDEX_RAW_PER_ENTRY;
  const wireOk = wireBytes <= SEARCH_INDEX_WIRE_BUDGET;
  const rawOk = searchBytes <= rawBudget;
  const verdict = wireOk && rawOk ? 'within' : 'OVER';
  console.log(
    `search idx : ${searchIndex.length} entries in ${shards.size} shards · ` +
      `raw ${(searchBytes / 1024).toFixed(1)} KB (budget ${(rawBudget / 1024).toFixed(0)} KB = ` +
      `${searchIndex.length}×${SEARCH_INDEX_RAW_PER_ENTRY}B) · wire ${(wireBytes / 1024).toFixed(1)} KB br ` +
      `(budget ${SEARCH_INDEX_WIRE_BUDGET / 1024} KB) — ${verdict}`,
  );
  console.log(
    `             largest shard ${(shardWireMax / 1024).toFixed(1)} KB br · ` +
      `top slice ${topEntries.length} entries ${(topSize.wire / 1024).toFixed(1)} KB br · ` +
      `legacy file ${legacyFits ? 'kept' : 'dropped (the catalog outgrew the wire budget)'}`,
  );
  if (!wireOk) {
    console.warn(
      'search idx OVER wire budget: the browser now reads the shards, so this only means the ' +
        'legacy single file was dropped',
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
