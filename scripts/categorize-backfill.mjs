// categorize-backfill.mjs — refresh D1 sites.category_id from the current
// keyword rules (append-only categorize.mjs). Only rows whose category
// actually changes are touched; statements are grouped by target slug and
// chunked by domain count to stay under wrangler's command-size limit.
//
// The rules include a generalized "what does the site say about itself" pass
// (meta description / og:site_name / keywords), so this script has to see
// the same homepage snapshots the static index was built from — otherwise it
// would compute a different, smaller set of categories than afr.im serves.
// The snapshot root defaults to the sibling AFR-data clone and can be
// overridden with --data-dir.
//
// Usage: CLOUDFLARE_API_TOKEN=… CLOUDFLARE_ACCOUNT_ID=… \
//        node scripts/categorize-backfill.mjs [--dry-run] [--data-dir path]
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolvePageMeta } from '../packages/scanner/src/page-meta.ts';
import { categorize, CATEGORY_SLUGS } from '../apps/web/src/data/categorize.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const dryRun = process.argv.includes('--dry-run');
const CHUNK = 400; // domains per IN-list

/** --data-dir <path> → snapshot root (default: the sibling AFR-data clone). */
function parseDataDir(argv) {
  const i = argv.indexOf('--data-dir');
  if (i !== -1 && argv[i + 1]) return resolve(argv[i + 1]);
  return resolve(repoRoot, '..', 'AFR-data', 'scans');
}

/** The site's own self-description, read from the homepage snapshot. */

/**
 * domain → meta, taken from the newest snapshot per domain (same merge rule
 * as fetch-data.mjs: a later date directory wins).
 */
function loadMetaByDomain(root) {
  const out = new Map();
  if (!existsSync(root)) return out;
  for (const y of readdirSync(root)) {
    const yp = join(root, y);
    if (!statSync(yp).isDirectory() || !/^\d{4}$/.test(y)) continue;
    for (const m of readdirSync(yp)) {
      const mp = join(yp, m);
      if (!statSync(mp).isDirectory() || !/^\d{2}$/.test(m)) continue;
      for (const d of readdirSync(mp)) {
        const dp = join(mp, d);
        if (!statSync(dp).isDirectory() || !/^\d{2}$/.test(d)) continue;
        const stamp = `${y}-${m}-${d}`;
        for (const f of readdirSync(dp)) {
          if (!f.endsWith('.json')) continue;
          let raw;
          try {
            raw = JSON.parse(readFileSync(join(dp, f), 'utf8'));
          } catch {
            continue;
          }
          const domain = raw?.afr?.domain ?? raw?.signals?.domain ?? f.replace(/\.json$/, '');
          const meta = resolvePageMeta(raw?.signals?.homepage);
          if (!meta) continue;
          const prev = out.get(domain);
          if (!prev || prev.stamp <= stamp) out.set(domain, { stamp, meta });
        }
      }
    }
  }
  return out;
}

function d1(cmd) {
  const out = execFileSync('npx', ['wrangler', 'd1', 'execute', 'aiapp', '--remote', '--json', '--command', cmd], {
    cwd: repoRoot, env: process.env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
  });
  const m = out.match(/\[[\s\S]*\]/);
  const parsed = JSON.parse(m[0]);
  return parsed[0]?.results ?? [];
}

const q = (v) => `'${String(v).replace(/'/g, "''")}'`;

// 1) current D1 state
const rows = d1(`SELECT s.domain, s.title, c.slug AS slug FROM sites s LEFT JOIN categories c ON c.id = s.category_id`);
console.log(`d1 rows: ${rows.length}`);

// 2) desired state from current rules
const dataDir = parseDataDir(process.argv.slice(2));
const metaByDomain = loadMetaByDomain(dataDir);
if (metaByDomain.size === 0) {
  console.warn(
    `warning: no homepage snapshots under ${dataDir} — categories will be computed ` +
      'from domain + title only, so meta-classified sites stay uncategorized. ' +
      'Pass --data-dir <AFR-data/scans> to sync with the static index.',
  );
}
const bySlug = new Map(); // slug -> [domains needing change]
let changed = 0;
for (const r of rows) {
  const want = categorize(r.domain, r.title ?? undefined, metaByDomain.get(r.domain)?.meta);
  if (want === r.slug) continue;
  if (!CATEGORY_SLUGS.includes(want)) throw new Error(`bad slug ${want}`);
  (bySlug.get(want) ?? bySlug.set(want, []).get(want)).push(r.domain);
  changed++;
}
console.log(`rows to update: ${changed}`);
for (const [slug, list] of [...bySlug].sort((a, b) => b[1].length - a[1].length)) {
  console.log(`  ${slug}: ${list.length}${slug === 'other' ? ` — ${list.join(', ')}` : ''}`);
}
if (dryRun || changed === 0) process.exit(0);

// 3) apply: one UPDATE per slug-chunk
let stmts = 0;
for (const [slug, list] of bySlug) {
  const idSub = `(SELECT id FROM categories WHERE slug = ${q(slug)})`;
  for (let i = 0; i < list.length; i += CHUNK) {
    const part = list.slice(i, i + CHUNK);
    const inList = part.map(q).join(',');
    const sql = `UPDATE sites SET category_id = ${idSub} WHERE domain IN (${inList}) AND category_id IS NOT ${idSub}`;
    execFileSync('npx', ['wrangler', 'd1', 'execute', 'aiapp', '--remote', '--command', sql], {
      cwd: repoRoot, env: process.env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    });
    stmts++;
    console.log(`applied ${slug} chunk ${i / CHUNK + 1}/${Math.ceil(list.length / CHUNK)} (${part.length})`);
  }
}
console.log(`done: ${stmts} statements`);
