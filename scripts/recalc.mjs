// Re-score existing scan snapshots with the current engine (pure function —
// no re-scan needed; spec §3.6/§4.4 versioned recomputation).
// Usage: node scripts/recalc.mjs <scans-dir> [--write]
// Prints a before/after calibration summary; --write updates the JSON files
// (idempotent same-day overwrite per spec §5.6).
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { scoreAfr } from '../packages/afr/src/index.ts';

const dir = process.argv[2];
const write = process.argv.includes('--write');
if (!dir) {
  console.error('usage: node scripts/recalc.mjs <scans-dir> [--write]');
  process.exit(1);
}

const gradeFor = (s) => (s >= 85 ? 'A' : s >= 70 ? 'B' : s >= 50 ? 'C' : s >= 30 ? 'D' : 'F');
const dist = (rows) => {
  const d = { A: 0, B: 0, C: 0, D: 0, F: 0, Pending: 0 };
  let sum = 0;
  let n = 0;
  for (const r of rows) {
    d[r.afr.grade] += 1;
    if (r.afr.state === 'scored') {
      sum += r.afr.score;
      n += 1;
    }
  }
  return { d, avg: n ? (sum / n).toFixed(1) : '—', n };
};

const files = readdirSync(dir).filter((f) => f.endsWith('.json'));
const rows = [];
const changed = [];
for (const f of files) {
  const path = join(dir, f);
  const j = JSON.parse(readFileSync(path, 'utf8'));
  const before = { grade: j.afr.grade, score: j.afr.score, engine: j.afr.engineVersion };
  const afr = scoreAfr(j.signals);
  const after = { grade: afr.grade, score: afr.score, engine: afr.engineVersion };
  if (before.grade !== after.grade || before.score !== after.score || before.engine !== after.engine) {
    changed.push({ f, before, after });
  }
  rows.push({ f, afr });
  if (write) writeFileSync(path, JSON.stringify({ signals: j.signals, afr }, null, 1) + '\n');
}

const d = dist(rows);
const pct = (x, base) => `${((100 * x) / base).toFixed(1)}%`;

console.log(`# Recalc with ${rows[0]?.afr.engineVersion} over ${rows.length} snapshots (${dir}${write ? ', WRITTEN' : ', dry-run'})`);
console.log(`graded ${d.n} · pending ${d.d.Pending} (${pct(d.d.Pending, rows.length)}) · avg ${d.avg}`);
console.log(`A ${d.d.A} (${pct(d.d.A, d.n)})  B ${d.d.B} (${pct(d.d.B, d.n)})  C ${d.d.C} (${pct(d.d.C, d.n)})  D ${d.d.D} (${pct(d.d.D, d.n)})  F ${d.d.F} (${pct(d.d.F, d.n)})`);

const hist = Array(11).fill(0);
for (const r of rows) if (r.afr.state === 'scored') hist[Math.min(10, Math.floor(r.afr.score / 10))] += 1;
for (let i = 0; i <= 10; i++) {
  const lo = i * 10;
  const hi = i === 10 ? 100 : lo + 9;
  console.log(`${String(lo).padStart(3)}–${String(hi).padStart(3)} ${'█'.repeat(Math.round((60 * hist[i]) / d.n))} ${hist[i]}`);
}

const tags = {};
for (const r of rows) if (r.afr.state === 'scored') tags[r.afr.strategyTag] = (tags[r.afr.strategyTag] ?? 0) + 1;
console.log('tags (scored):', JSON.stringify(tags));

const gradeMoves = { up: 0, down: 0 };
for (const c of changed) {
  const order = { F: 0, D: 1, C: 2, B: 3, A: 4 };
  const a = order[c.before.grade];
  const b = order[c.after.grade];
  if (a !== undefined && b !== undefined && a !== b) b > a ? gradeMoves.up++ : gradeMoves.down++;
}
console.log(`changed: ${changed.length} snapshots (${gradeMoves.up} upgraded, ${gradeMoves.down} downgraded grades, rest score/engine-only)`);
