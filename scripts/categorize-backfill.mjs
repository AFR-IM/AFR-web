// categorize-backfill.mjs — refresh D1 sites.category_id from the current
// keyword rules (append-only categorize.mjs). Only rows whose category
// actually changes are touched; statements are grouped by target slug and
// chunked by domain count to stay under wrangler's command-size limit.
// Usage: CLOUDFLARE_API_TOKEN=… CLOUDFLARE_ACCOUNT_ID=… \
//        node scripts/categorize-backfill.mjs [--dry-run]
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { categorize, CATEGORY_SLUGS } from '../apps/web/src/data/categorize.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const dryRun = process.argv.includes('--dry-run');
const CHUNK = 400; // domains per IN-list

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
const bySlug = new Map(); // slug -> [domains needing change]
let changed = 0;
for (const r of rows) {
  const want = categorize(r.domain, r.title ?? undefined);
  if (want === r.slug) continue;
  if (!CATEGORY_SLUGS.includes(want)) throw new Error(`bad slug ${want}`);
  (bySlug.get(want) ?? bySlug.set(want, []).get(want)).push(r.domain);
  changed++;
}
console.log(`rows to update: ${changed}`);
for (const [slug, list] of [...bySlug].sort((a, b) => b[1].length - a[1].length)) {
  console.log(`  ${slug}: ${list.length}`);
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
