// d1-load.mjs — one-shot loader: scan snapshots (AFR-data SSOT) → Cloudflare D1.
// Replaces the need for a first remote sync run; afterwards the daily pipeline
// keeps D1 fresh via the worker's d1-sync. Usage:
//   CLOUDFLARE_API_TOKEN=… CLOUDFLARE_ACCOUNT_ID=… \
//     node scripts/d1-load.mjs --date YYYY/MM/DD [--data-dir path] [--dry-run]
//
// --date is REQUIRED. Defaulting to the newest scans/ directory used to load a
// partial day the moment a new UTC day started (a handful of files on disk ⇒ a
// handful of rows in D1), silently replacing a full load with partial data.
// Always name a completed day explicitly; the loader refuses to guess.
//
// Writes are upserts, not INSERT OR IGNORE, so re-running after a re-score
// refreshes stale rows instead of leaving them until the 04:30 UTC sync:
//   sites      ON CONFLICT(domain)
//   categories ON CONFLICT(id)
//   scans      ON CONFLICT(snapshot_path)        (idx_scans_snapshot unique index)
//   evidence   ON CONFLICT(scan_id, check_id)    (idx_evidence_scan_check)
// Only scanner-owned columns are updated on conflict — category_id/title/lang
// stay human-curated, mirroring apps/worker/src/d1-sync.ts.
// Statements are batched to stay under 90 KB each; execution uses
// `wrangler d1 execute --remote` (retry-until-success remains the caller's).
import { readFileSync, readdirSync, mkdirSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { catalogs } from '../packages/i18n/src/index.ts';
import { CATEGORY_SLUGS, categorize } from '../apps/web/src/data/categorize.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');

/** YYYY/MM/DD (the AFR-data scans/ layout); --date must use this shape. */
const DATE_RE = /^\d{4}\/\d{2}\/\d{2}$/;

export function parseArgs(argv) {
  const out = { date: undefined, dataDir: undefined, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--date') out.date = argv[++i];
    else if (argv[i] === '--data-dir') out.dataDir = argv[++i];
    else if (argv[i] === '--dry-run') out.dryRun = true;
    else if (argv[i] === '--max-rows') out.maxRows = Number(argv[++i]);
  }
  return out;
}

export function latestDate(root) {
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

// --- table shapes -----------------------------------------------------------
// conflict keys are the tables' natural keys; update lists are the columns a
// reload is allowed to overwrite (scanner-owned only).

export const CATEGORY_COLUMNS = ['id', 'slug', 'name_en', 'name_zh', 'parent'];
export const CATEGORY_CONFLICT = ['id'];
export const CATEGORY_UPDATES = ['slug', 'name_en', 'name_zh', 'parent'];

export const SITE_COLUMNS = [
  'domain', 'category_id', 'title', 'lang', 'strategy_tag', 'grade',
  'score_total', 'score_l1', 'score_l2', 'score_l3', 'status',
  'created_at', 'updated_at', 'scanned_at',
];
// Mirrors d1-sync.ts: category_id/title/lang are human-curated (and rank/verified
// are not written here at all), so a reload must not clobber them.
export const SITE_CONFLICT = ['domain'];
export const SITE_UPDATES = [
  'strategy_tag', 'grade', 'score_total', 'score_l1', 'score_l2', 'score_l3',
  'status', 'updated_at', 'scanned_at',
];

export const SCAN_COLUMNS = [
  'domain', 'engine_version', 'score_total', 'score_l1', 'score_l2', 'score_l3',
  'grade', 'snapshot_path', 'started_at', 'finished_at',
];
export const SCAN_CONFLICT = ['snapshot_path'];
export const SCAN_UPDATES = [
  'engine_version', 'score_total', 'score_l1', 'score_l2', 'score_l3', 'grade',
  'started_at', 'finished_at',
];

export const EVIDENCE_COLUMNS = [
  'scan_id', 'check_id', 'status', 'points', 'max_points', 'evidence_type', 'evidence_ref',
];
export const EVIDENCE_CONFLICT = ['scan_id', 'check_id'];
export const EVIDENCE_UPDATES = ['status', 'points', 'max_points', 'evidence_type', 'evidence_ref'];

/**
 * Split rows into compound upsert statements whose text stays under maxBytes.
 * Each statement: INSERT INTO t (cols) VALUES (…), (…) ON CONFLICT(keys) DO UPDATE SET col = excluded.col, …
 */
export function compoundUpsert(table, columns, conflictKeys, updateCols, rows, maxBytes = 80_000) {
  const head = `INSERT INTO ${table} (${columns.join(', ')}) VALUES`;
  const tail =
    ` ON CONFLICT(${conflictKeys.join(', ')}) DO UPDATE SET ` +
    `${updateCols.map((c) => `${c} = excluded.${c}`).join(', ')};`;
  const stmts = [];
  let buf = '';
  for (const row of rows) {
    const tuple = `(${row.join(', ')})`;
    if (buf && head.length + buf.length + tuple.length + tail.length + 2 > maxBytes) {
      stmts.push(`${head}${buf}${tail}`);
      buf = '';
    }
    buf += (buf ? ',' : '') + tuple;
  }
  if (buf) stmts.push(`${head}${buf}${tail}`);
  return stmts;
}

/** categories seed (id 1..14, names from the language pack) */
export function categoryRows() {
  const en = catalogs['en'].categories;
  const zh = catalogs['zh-CN'].categories;
  return CATEGORY_SLUGS.map((slug, i) => [
    String(i + 1),
    q(slug),
    q(en[slug]?.name ?? slug),
    q(zh[slug]?.name ?? slug),
    'NULL',
  ]);
}

/** Read one day's snapshots and build the sites/scans row values. */
export function collectRows(dir, date, files) {
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
  return { siteRows, scanRows, pending };
}

/** All day statements: categories + sites + scans (batched upserts). */
export function buildDayStatements({ dir, date }) {
  const files = readdirSync(dir).filter((f) => f.endsWith('.json'));
  const { siteRows, scanRows, pending } = collectRows(dir, date, files);
  const catRows = categoryRows();
  const batches = [
    compoundUpsert('categories', CATEGORY_COLUMNS, CATEGORY_CONFLICT, CATEGORY_UPDATES, catRows),
    compoundUpsert('sites', SITE_COLUMNS, SITE_CONFLICT, SITE_UPDATES, siteRows),
    compoundUpsert('scans', SCAN_COLUMNS, SCAN_CONFLICT, SCAN_UPDATES, scanRows),
  ];
  return { files, catRows, siteRows, scanRows, pending, batches };
}

/** Evidence row values for the day. `idRows` is `SELECT id, snapshot_path FROM scans`
 * (remote loader passes the D1 response; tests pass a local query), so scan ids
 * must already exist — run the day statements first.
 */
export function collectEvidenceRows(idRows, dir, date, files) {
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
  return evRows;
}

/** Evidence upsert statements; run after the day statements created the scans. */
export function evidenceStatements(idRows, dir, date, files) {
  return compoundUpsert(
    'evidence',
    EVIDENCE_COLUMNS,
    EVIDENCE_CONFLICT,
    EVIDENCE_UPDATES,
    collectEvidenceRows(idRows, dir, date, files),
  );
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

/** Print one generated statement's shape (head + tuple count + conflict clause). */
export function statementShape(sql) {
  const valuesAt = sql.indexOf(' VALUES');
  const conflictAt = sql.indexOf(' ON CONFLICT');
  const body = sql.slice(valuesAt + ' VALUES'.length, conflictAt === -1 ? sql.length - 1 : conflictAt);
  const tuples = body.trim() ? body.split('),(').length : 0;
  const head = valuesAt === -1 ? sql.slice(0, 120) : sql.slice(0, valuesAt + ' VALUES'.length);
  const tail = conflictAt === -1 ? sql.slice(-1) : sql.slice(conflictAt);
  return `${head} … (${tuples} tuple${tuples === 1 ? '' : 's'})${tail}`;
}

function refuseWithoutDate(scansRoot) {
  console.error('ERROR: --date YYYY/MM/DD is required.');
  console.error('The loader must not default to the newest scans/ directory: right after a');
  console.error('new UTC day starts that directory holds only a few snapshots, so a default');
  console.error('run would silently replace a full load with partial data.');
  try {
    const latest = latestDate(scansRoot);
    const count = readdirSync(join(scansRoot, latest)).filter((f) => f.endsWith('.json')).length;
    console.error(`Newest directory: ${latest} (${count} snapshot file(s)) — pass --date ${latest}`);
    console.error('only once that day is complete (or pass an older, complete day).');
  } catch {
    // no scans tree at all — the usage line below is the only hint needed
  }
  console.error('Usage: node scripts/d1-load.mjs --date YYYY/MM/DD [--data-dir path] [--dry-run]');
  process.exit(2);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const scansRoot = args.dataDir ?? join(repoRoot, '..', 'AFR-data', 'scans');

  if (!args.date) refuseWithoutDate(scansRoot);
  if (!DATE_RE.test(args.date)) {
    console.error(`ERROR: --date must be YYYY/MM/DD (got "${args.date}").`);
    console.error('Usage: node scripts/d1-load.mjs --date YYYY/MM/DD [--data-dir path] [--dry-run]');
    process.exit(2);
  }

  const date = args.date;
  const dir = join(scansRoot, date);
  if (!existsSync(dir)) throw new Error(`missing ${dir}`);

  const { files, batches, siteRows, scanRows, pending, catRows } = buildDayStatements({ dir, date });
  console.log(`loading ${files.length} snapshots from ${date}`);

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

  const totalRows = batches.reduce((n, stmts) => n + stmts.length, 0);
const rowBudget = args.maxRows ?? 35_000;
if (totalRows > rowBudget) {
  console.error(
    `REFUSING to load: ${totalRows} statements exceed the ${rowBudget} row budget. ` +
      'Full reloads burn the daily D1 write quota — use the upsert (default) for refreshes, ' +
      'or pass --max-rows N deliberately.',
  );
  process.exit(1);
}

if (args.dryRun) {
    console.log(`dry-run: ${allFiles.length} SQL files in ${tmp}`);
    for (const f of allFiles) {
      console.log(`  ${f.split('/').pop()}: ${statementShape(readFileSync(f, 'utf8'))}`);
    }
    const sample = compoundUpsert(
      'evidence',
      EVIDENCE_COLUMNS,
      EVIDENCE_CONFLICT,
      EVIDENCE_UPDATES,
      [['<scan_id>', q('A1.gptbot'), q('pass'), n(3), n(3), q('robots.txt'), q('…')]],
    );
    console.log(`  evidence (generated after scan ids resolve): ${statementShape(sample[0])}`);
    process.exit(0);
  }

  for (const f of allFiles) {
    process.stdout.write(`executing ${f.split('/').pop()} … `);
    d1File(f);
    console.log('ok');
  }

  // --- evidence: resolve snapshot_path → scan id, then upsert with literal ids ---
  const idRows = d1('SELECT id, snapshot_path FROM scans');
  const evRows = collectEvidenceRows(idRows, dir, date, files);
  const evFiles = evidenceStatements(idRows, dir, date, files).map((st, i) => {
    const f = join(tmp, `evidence_${String(i + 1).padStart(3, '0')}.sql`);
    writeFileSync(f, st);
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
    evidenceFiles: evFiles.length,
    categories: catRows.length,
  };
  console.log(JSON.stringify(summary, null, 2));
}

// Run only when executed directly (`node scripts/d1-load.mjs`), not on import
// (scripts/d1-load.test.mjs imports the statement builders above).
const invokedDirectly =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) main();
