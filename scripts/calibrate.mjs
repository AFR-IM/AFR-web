// Calibration analysis for the first Tranco Top1000 scan (M1 DoD, spec §3.5).
// Reads AFR-data/scans/YYYY/MM/DD/*.json and prints a markdown report:
// histogram, grade/strategy distribution, per-check hit rates, scan health,
// anomaly lists, and sample evidence chains for spot checks.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.argv[2] ?? 'scans/2026/11/10';
const files = readdirSync(dir).filter((f) => f.endsWith('.json'));

const rows = [];
const errors = [];
for (const f of files) {
  try {
    const j = JSON.parse(readFileSync(join(dir, f), 'utf8'));
    if (!j.afr) { errors.push({ f, why: 'no afr' }); continue; }
    rows.push({ file: f, ...j });
  } catch (e) { errors.push({ f, why: String(e) }); }
}

const n = rows.length;
const grades = { A: 0, B: 0, C: 0, D: 0, F: 0 };
const tags = {};
const hist = Array(11).fill(0); // 0-9 ... 100
const layerSum = { L1: 0, L2: 0, L3: 0 };
const layerMax = { L1: 35, L2: 40, L3: 25 };
const checkAgg = {}; // id -> {sum, max, known, unknown}
let scanFail = 0;      // homepage probe failed entirely
let robotsMissing = 0; // robots.txt 404/absent
let robotsError = 0;   // robots.txt network error
let llmsHit = 0;
let challengeHit = 0;
let uaFallback = 0;
let unconfigured = 0;

for (const r of rows) {
  const a = r.afr;
  grades[a.grade] = (grades[a.grade] ?? 0) + 1;
  tags[a.strategyTag] = (tags[a.strategyTag] ?? 0) + 1;
  hist[Math.min(10, Math.floor(a.score / 10))] += 1;
  for (const l of a.layers) {
    layerSum[l.layer] += l.awarded;
    for (const c of l.checks) {
      const k = checkAgg[c.id] ?? (checkAgg[c.id] = { sum: 0, max: c.max, unknown: 0, n: 0 });
      k.sum += c.awarded; k.n += 1;
      if (c.status === 'unknown') k.unknown += 1;
    }
  }
  const s = r.signals ?? {};
  const hp = s.homepage;
  if (!hp || hp.error || (hp.status ?? 0) >= 400 || hp.status === undefined) scanFail += 1;
  const rp = s.robots;
  if (rp && (rp.status === 404)) robotsMissing += 1;
  if (rp && rp.error) robotsError += 1;
  if (s.llms && !s.llms.error && s.llms.status >= 200 && s.llms.status < 300) llmsHit += 1;
  if (hp && hp.challengedStatus) challengeHit += 1;
  if (hp && hp.uaFallback) uaFallback += 1;
  if (a.strategyTag === 'Unconfigured') unconfigured += 1;
}

const pct = (x) => `${((100 * x) / n).toFixed(1)}%`;
const avg = (x) => (x / n).toFixed(2);

let out = `# First-scan calibration report — ${dir} (n=${n})\n\n`;
out += `## Score histogram (10-point buckets)\n`;
for (let i = 0; i <= 10; i++) {
  const lo = i * 10, hi = i === 10 ? 100 : lo + 9;
  const c = hist[i];
  out += `${String(lo).padStart(3)}–${String(hi).padStart(3)} ${'█'.repeat(Math.round((80 * c) / n))} ${c} (${pct(c)})\n`;
}
out += `\n## Grade distribution (thresholds §3.5: A≥85 B≥70 C≥50 D≥30 F<30)\n`;
for (const g of ['A', 'B', 'C', 'D', 'F']) out += `${g}: ${String(grades[g]).padStart(4)} (${pct(grades[g])})\n`;
out += `\n## StrategyTag distribution\n`;
for (const [k, v] of Object.entries(tags).sort((a, b) => b[1] - a[1])) out += `${k}: ${v} (${pct(v)})\n`;
out += `\n## Layer averages (max L1=35 L2=40 L3=25)\n`;
out += `L1 avg ${avg(layerSum.L1)} / 35 · L2 avg ${avg(layerSum.L2)} / 40 · L3 avg ${avg(layerSum.L3)} / 25\n`;
out += `\n## Per-check score rate (awarded/max, n per check)\n`;
for (const [id, k] of Object.entries(checkAgg).sort((a, b) => a[1].sum / a[1].max - b[1].sum / b[1].max)) {
  out += `${id.padEnd(26)} ${(100 * k.sum / (k.max * k.n)).toFixed(1).padStart(5)}%  unknown ${pct(k.unknown)}\n`;
}
out += `\n## Scan health\n`;
out += `homepage failed/4xx: ${scanFail} (${pct(scanFail)})\n`;
out += `robots.txt 404 (absent): ${robotsMissing} (${pct(robotsMissing)}) · robots network error: ${robotsError}\n`;
out += `llms.txt 200: ${llmsHit} (${pct(llmsHit)})\n`;
out += `transparent-UA challenged: ${challengeHit} (${pct(challengeHit)}) · browser-UA fallback used: ${uaFallback}\n`;
out += `strategy Unconfigured: ${unconfigured} (${pct(unconfigured)})\n`;
if (errors.length) out += `unparseable: ${errors.length} ${JSON.stringify(errors.slice(0, 5))}\n`;

const sorted = [...rows].sort((a, b) => b.afr.score - a.afr.score);
out += `\n## Top 20\n`;
for (const r of sorted.slice(0, 20)) out += `${String(r.afr.score).padStart(3)} ${r.afr.grade} ${r.afr.strategyTag.padEnd(13)} ${r.file.replace('.json', '')}\n`;
out += `\n## Bottom 20\n`;
for (const r of sorted.slice(-20)) out += `${String(r.afr.score).padStart(3)} ${r.afr.grade} ${r.afr.strategyTag.padEnd(13)} ${r.file.replace('.json', '')}\n`;

// Anomaly heuristics
const allUnknown = rows.filter((r) => r.afr.layers.every((l) => l.checks.every((c) => c.status === 'unknown')));
const zeroish = rows.filter((r) => r.afr.score <= 5);
const highNoL2 = rows.filter((r) => r.afr.score >= 70 && r.afr.layers.find((l) => l.layer === 'L2').awarded <= 8);
out += `\n## Anomaly candidates\n`;
out += `all checks unknown (scan dead): ${allUnknown.length} — ${allUnknown.slice(0, 10).map((r) => r.file).join(', ')}\n`;
out += `score <= 5: ${zeroish.length} — ${zeroish.slice(0, 15).map((r) => r.file.replace('.json','')).join(', ')}\n`;
out += `score >= 70 but L2 <= 8: ${highNoL2.length} — ${highNoL2.slice(0, 10).map((r) => r.file.replace('.json','')).join(', ')}\n`;

console.log(out);
