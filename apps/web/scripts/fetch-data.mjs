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
//   public/data/search-index.json        compact [{d,s,g,c,t}] client search payload
//
// Pending sites (grade 'Pending': neither homepage nor robots readable) are
// excluded from every card list / distribution / average, but do get a detail
// page and an entry in the search index.

import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CATEGORY_SLUGS, categorize } from '../src/data/categorize.mjs';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIR = path.resolve(SCRIPT_DIR, '..'); // apps/web
const GENERATED_DIR = path.join(WEB_DIR, 'src', 'data', 'generated');
const DETAILS_DIR = path.join(GENERATED_DIR, 'details');
const PUBLIC_DATA_DIR = path.join(WEB_DIR, 'public', 'data');

const LEADERBOARD_SIZE = 50;
const LATEST_SIZE = 24;
const SEARCH_TITLE_MAX = 48; // keep the client index inside the 120KB budget at 10k+ sites
// raw JSON target (~160KB at 2k sites ≈ 45KB gzipped on the wire);
// re-shard/trim before 10k sites (see engineering SSOT roadmap)
const SEARCH_INDEX_BUDGET = 160 * 1024;
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

/** Homepage <title> text, normalized; undefined when the homepage is unreadable. */
function extractTitle(body) {
  if (typeof body !== 'string') return undefined;
  const m = body.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (!m) return undefined;
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
  return text.length > 120 ? `${text.slice(0, 119)}…` : text;
}

/** <html lang="…"> attribute from the homepage snapshot, when present. */
function extractLang(body) {
  if (typeof body !== 'string') return undefined;
  const m = body.match(/<html[^>]*\blang\s*=\s*["']?([A-Za-z][A-Za-z0-9-]{0,15})/i);
  return m ? m[1] : undefined;
}

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
    const homepageBody = raw?.signals?.homepage?.body;
    const title = extractTitle(homepageBody);
    const lang = extractLang(homepageBody);
    const category = categorize(afr.domain ?? name.replace(/\.json$/, ''), title);
    sites.push({ afr, title, lang, category });
  }
  if (sites.length === 0) {
    console.error('No usable snapshots found.');
    process.exit(1);
  }

  const isPendingSite = (s) => s.afr.state === 'pending' || s.afr.grade === 'Pending';
  const domainOf = (s) => s.afr.domain ?? '';
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

  const detailOf = (s) => ({
    ...cardOf(s),
    ...(DELISTED[domainOf(s)] ? { delistedNote: DELISTED[domainOf(s)] } : {}),
    engineVersion: s.afr.engineVersion,
    scannerVersion: s.afr.scannerVersion,
    layers: s.afr.layers,
    breakdown: s.afr.breakdown,
    history: [
      {
        date: String(s.afr.scannedAt).slice(0, 10),
        score: s.afr.score,
        grade: s.afr.grade,
      },
    ],
  });

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

  const home = {
    generatedAt: latestScannedAt,
    total: scored.length,
    avgScore: scored.length > 0 ? Math.round((scoreSum / scored.length) * 10) / 10 : 0,
    distribution,
    pendingCount: pending.length,
    categories,
    leaderboard: scoredCards.slice(0, LEADERBOARD_SIZE),
    latest: [...scoredCards].sort(byScanDesc).slice(0, LATEST_SIZE),
  };

  // ── categories payload (scored only, grouped, score desc) ────────────────
  const grouped = {};
  for (const slug of CATEGORY_SLUGS) grouped[slug] = [];
  for (const c of scoredCards) (grouped[c.category] ??= []).push(c);
  for (const list of Object.values(grouped)) list.sort(byScoreDesc);

  // ── search index (everything, compact keys) ──────────────────────────────
  const searchIndex = sites.filter((s) => !DELISTED[s.afr.domain ?? ''])
    .map((s) => {
      const entry = {
        d: s.afr.domain,
        s: s.afr.score,
        g: s.afr.grade,
        c: s.category,
      };
      if (s.title) entry.t = s.title.slice(0, SEARCH_TITLE_MAX);
      return entry;
    })
    .sort((a, b) => b.s - a.s || a.d.localeCompare(b.d));

  // ── write outputs ────────────────────────────────────────────────────────
  await rm(GENERATED_DIR, { recursive: true, force: true });
  await mkdir(DETAILS_DIR, { recursive: true });
  await mkdir(PUBLIC_DATA_DIR, { recursive: true });

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

  const searchBytes = await writeJson(path.join(PUBLIC_DATA_DIR, 'search-index.json'), searchIndex);

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
  const budget = searchBytes <= SEARCH_INDEX_BUDGET ? 'within' : 'OVER';
  console.log(
    `search idx : public/data/search-index.json ${(searchBytes / 1024).toFixed(1)} KB (${searchIndex.length} entries, ${budget} ${SEARCH_INDEX_BUDGET / 1024} KB budget)`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
