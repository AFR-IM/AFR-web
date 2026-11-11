// d1-load.mjs — one-shot loader: scan snapshots (aiapp-data SSOT) → Cloudflare D1.
// Replaces the need for a first remote sync run; afterwards the daily pipeline
// keeps D1 fresh via the worker's d1-sync. Usage:
//   CLOUDFLARE_API_TOKEN=… CLOUDFLARE_ACCOUNT_ID=… \
//     node scripts/d1-load.mjs [--date YYYY-MM-DD] [--data-dir path] [--dry-run]
// Generates batched compound INSERTs (each statement < 90 KB), executes them
// with `wrangler d1 execute --remote`, then resolves scan ids to load evidence.
import { readFileSync, readdirSync, mkdirSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { catalogs } from '../packages/i18n/src/index.ts';
import { CATEGORY_SLUGS, categorize } from '../apps/web/src/data/categorize.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');

function parseArgs(argv) {
  const out = { date: undefined, dataDir: undefined, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--date') out.date = argv[++i];
    else if (argv[i] === '--data-dir') out.dataDir = argv[++i];
    else if (argv[i] === '--dry-run') out.dryRun = true;
  }
  return out;
}

function latestDate(root) {
  const years = readdirSync(root).filter((y) => /^\d{4}$/.test(y)).sort();
  for (let y = years.length - 1; y >= 0; y--) {
    const months = readdirSync(join(root, years[y])).sort();
    for (let m = months.length - 1; m >= 0; m--) {
      const days = readdirSync(join(root, years[y], months[m])).sort();
      if (days.length) return `${years[y]}/${months[m]}/${days[days.length - 1]}`;
    }
  }
  throw new Error(`no scan dates under ${root}`);
}

const q = (v) => (v === null || v === undefined ? 'NULL' : `'${String(v).replace(/'/g, "''")}'`);
const n = (v) => (v === null || v === undefined || Number.isNaN(Number(v)) ? 'NULL' : String(Number(v)));
const extractTitle = (body) => {
  const m = (body ?? '').match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return m ? m[1].replace(/\s+/g, ' ').trim().slice(0, 200) : undefined;
};
const extractLang = (body) => {
  const m = (body ?? '').match(/<html[^>]*\slang=["']?([a-zA-Z-]+)/i);
  return m ? m[1].toLowerCase().slice(0, 12) : undefined;
};

/** Split rows into compound INSERTs whose text stays under maxBytes per statement. */
function compoundInsert(table, columns, rows, maxBytes = 80_000) {
  const stmts = [];
  let buf = '';
  const head = `INSERT OR IGNORE INTO ${table} (${columns.join(', ')}) VALUES`;
  for (const row of rows) {
    const tuple = `(${row.join(', ')})`;
    if (buf && (head.length + buf.length + tuple.length + 2) > maxBytes) {
      stmts.push(`${head}${buf};`);
      buf = '';
    }
    buf += (buf ? ',' : '') + tuple;
  }
  if (buf) stmts.push(`${head}${buf};`);
  return stmts;
}

function d1(sql) {
  const out = execFileSync(
    'npx',
    ['wrangler', 'd1', 'execute', 'aiapp', '--remote', '--json', '--command', sql],
    { cwd: join(repoRoot, 'apps/worker'), encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );
  const jsonStart = out.indexOf('[');
  const parsed = JSON.parse(out.slice(jsonStart));
  return parsed?.[0]?.results ?? [];
}

function d1File(file) {
  execFileSync('npx', ['wrangler', 'd1', 'execute', 'aiapp', '--remote', '--file', file], {
    cwd: join(repoRoot, 'apps/worker'),
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

const args = parseArgs(process.argv.slice(2));
const scansRoot =
  args.dataDir ?? join(repoRoot, '..', 'aiapp-data', 'scans');
const date = args.date ?? latestDate(scansRoot);
const dir = join(scansRoot, date);
if (!existsSync(dir)) throw new Error(`missing ${dir}`);
const files = readdirSync(dir).filter((f) => f.endsWith('.json'));
console.log(`loading ${files.length} snapshots from ${date}`);

// --- categories seed (id 1..14, names from the language pack) ---
const en = catalogs['en'].categories;
const zh = catalogs['zh-CN'].categories;
const catRows = CATEGORY_SLUGS.map((slug, i) => [
  String(i + 1),
  q(slug),
  q(en[slug]?.name ?? slug),
  q(zh[slug]?.name ?? slug),
  'NULL',
]);

// --- sites + scans ---
const siteRows = [];
const scanRows = [];
let pending = 0;
for (const f of files) {
  const { signals, afr } = JSON.parse(readFileSync(join(dir, f), 'utf8'));
  const domain = afr.domain || signals.domain;
  if (!domain) continue;
  if (afr.grade === 'Pending') pending++;
  const layer = (id) => {
    const l = afr.layers.find((x) => x.layer === id);
    return l ? n(l.awarded) : 'NULL';
  };
  const title = extractTitle(signals.homepage?.body);
  const lang = extractLang(signals.homepage?.body);
  const catSlug = categorize(domain, title);
  const catId = CATEGORY_SLUGS.indexOf(catSlug) + 1;
  const now = new Date().toISOString();
  siteRows.push([
    q(domain),
    catId > 0 ? String(catId) : 'NULL',
    q(title ?? null),
    q(lang ?? null),
    q(afr.strategyTag ?? null),
    q(afr.grade ?? null),
    n(afr.score),
    layer('L1'),
    layer('L2'),
    layer('L3'),
    "'active'",
    q(now),
    q(now),
    q(afr.scannedAt ?? signals.fetchedAt ?? now),
  ]);
  scanRows.push([
    q(domain),
    q(afr.engineVersion ?? null),
    n(afr.score),
    layer('L1'),
    layer('L2'),
    layer('L3'),
    q(afr.grade ?? null),
    q(`scans/${date}/${domain}.json`),
    q(afr.scannedAt ?? signals.fetchedAt ?? now),
    q(signals.fetchedAt ?? now),
  ]);
}

const batches = [
  compoundInsert(
    'categories',
    ['id', 'slug', 'name_en', 'name_zh', 'parent'],
    catRows,
  ),
  compoundInsert(
    'sites',
    ['domain', 'category_id', 'title', 'lang', 'strategy_tag', 'grade', 'score_total', 'score_l1', 'score_l2', 'score_l3', 'status', 'created_at', 'updated_at', 'scanned_at'],
    siteRows,
  ),
  compoundInsert(
    'scans',
    ['domain', 'engine_version', 'score_total', 'score_l1', 'score_l2', 'score_l3', 'grade', 'snapshot_path', 'started_at', 'finished_at'],
    scanRows,
  ),
];

const tmp = join(repoRoot, 'scripts', '.d1-batches');
rmSync(tmp, { recursive: true, force: true });
mkdirSync(tmp, { recursive: true });
let batchNo = 0;
const allFiles = [];
for (const stmts of batches) {
  for (const st of stmts) {
    const f = join(tmp, `batch_${String(++batchNo).padStart(3, '0')}.sql`);
    writeFileSync(f, st);
    allFiles.push(f);
  }
}

if (args.dryRun) {
  console.log(`dry-run: ${allFiles.length} SQL files in ${tmp}`);
  process.exit(0);
}

for (const f of allFiles) {
  process.stdout.write(`executing ${f.split('/').pop()} … `);
  d1File(f);
  console.log('ok');
}

// --- evidence: resolve snapshot_path → scan id, then insert with literal ids ---
const idRows = d1('SELECT id, snapshot_path FROM scans');
const idByPath = new Map(idRows.map((r) => [r.snapshot_path, r.id]));
const evRows = [];
for (const f of files) {
  const { afr } = JSON.parse(readFileSync(join(dir, f), 'utf8'));
  const domain = afr.domain || '';
  const path = `scans/${date}/${domain}.json`;
  const scanId = idByPath.get(path);
  if (!scanId) continue;
  for (const layer of afr.layers) {
    for (const c of layer.checks) {
      evRows.push([
        String(scanId),
        q(c.id),
        q(c.status ?? null),
        n(c.awarded),
        n(c.max),
        q(c.evidence?.source ?? null),
        q((c.evidence?.detail ?? '').slice(0, 2000)),
      ]);
    }
  }
}
const evFiles = compoundInsert(
  'evidence',
  ['scan_id', 'check_id', 'status', 'points', 'max_points', 'evidence_type', 'evidence_ref'],
  evRows,
).map((s, i) => {
  const f = join(tmp, `evidence_${String(i + 1).padStart(3, '0')}.sql`);
  writeFileSync(f, s);
  return f;
});

for (const f of evFiles) {
  process.stdout.write(`executing ${f.split('/').pop()} … `);
  d1File(f);
  console.log('ok');
}

const summary = {
  date,
  sites: siteRows.length,
  pending,
  scans: scanRows.length,
  evidence: evRows.length,
  categories: catRows.length,
};
console.log(JSON.stringify(summary, null, 2));
