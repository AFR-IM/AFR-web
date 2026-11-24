// Read-only maintenance inventory. Example from AFR-web:
//   node scripts/inventory-snapshots.mjs ../AFR-data c2c9b8c486d392cb0208bd7ce4c66468a0228492 2026-11-24
// Run against a pre-pruning commit with the same as-of date for comparison.
import { execFileSync, spawn } from 'node:child_process';
import { parseArgs } from 'node:util';
import { ENGINE_VERSION } from '../packages/afr/src/index.ts';
import { SCANNER_VERSION } from '../packages/scanner/src/http.ts';
import { BODY_CAP, missingEngineBodies } from './rederive-signals.mjs';

const DAY = 24 * 60 * 60 * 1000;
const SNAPSHOT_PATH = /^scans\/\d{4}\/\d{2}\/\d{2}\/([^/]+)\.json$/;
const gitEnv = { ...process.env, GIT_ALLOW_PROTOCOL: '', GIT_NO_LAZY_FETCH: '1', GIT_NO_REPLACE_OBJECTS: '1' };
const usage = 'Usage: node scripts/inventory-snapshots.mjs DATA_REPO FULL_COMMIT_SHA AS_OF_UTC_DATE';

function git(repo, args) {
  return execFileSync('git', ['-C', repo, ...args], { env: gitEnv, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

// Read each committed blob as bytes. A single batch process keeps memory bounded
// by the size of one snapshot (and avoids a Git invocation per domain).
async function* blobs(repo, paths) {
  const child = spawn('git', ['-C', repo, 'cat-file', '--batch'], { env: gitEnv, stdio: ['pipe', 'pipe', 'inherit'] });
  const closed = new Promise((resolve) => child.on('close', resolve));
  let failure;
  child.on('error', (error) => { failure = error; });
  child.stdin.on('error', (error) => { failure = error; });
  const chunks = child.stdout[Symbol.asyncIterator]();
  let buffer = Buffer.alloc(0);
  async function more() {
    const { value, done } = await chunks.next();
    if (done) throw failure ?? new Error('Unexpected end of git cat-file output');
    buffer = value;
  }
  try {
    for (const entry of paths) {
      child.stdin.write(`${entry.oid}\n`);
      const header = [];
      while (!buffer.includes(10)) {
        header.push(buffer);
        await more();
      }
      const newline = buffer.indexOf(10);
      header.push(buffer.subarray(0, newline));
      buffer = buffer.subarray(newline + 1);
      const [oid, type, size] = Buffer.concat(header).toString().split(' ');
      if (oid !== entry.oid || type !== 'blob' || !/^\d+$/.test(size ?? '')) {
        throw new Error(`Missing or invalid local blob: ${entry.path}`);
      }
      const parts = [];
      let remaining = Number(size);
      while (remaining > buffer.length) {
        parts.push(buffer);
        remaining -= buffer.length;
        await more();
      }
      parts.push(buffer.subarray(0, remaining));
      buffer = buffer.subarray(remaining);
      if (!buffer.length) await more();
      if (buffer[0] !== 10) throw new Error(`Invalid blob separator: ${entry.path}`);
      buffer = buffer.subarray(1);
      yield [entry, Buffer.concat(parts).toString('utf8')];
    }
    child.stdin.end();
    if (await closed !== 0) throw failure ?? new Error('git cat-file failed');
  } finally {
    child.kill();
  }
}

function version(value) {
  return typeof value === 'string' && value.trim() ? value : '(missing)';
}

function inspect(raw, asOf) {
  const snapshot = JSON.parse(raw);
  const { afr, signals } = snapshot ?? {};
  // Keep the same minimum score payload as the site's merged snapshot view.
  if (typeof afr?.score !== 'number' || !Array.isArray(afr.layers)) throw new Error('Missing score payload');
  const scannedAt = afr.scannedAt;
  const date = typeof scannedAt === 'string' && /^\d{4}-\d{2}-\d{2}T.*Z$/.test(scannedAt) && Number.isFinite(Date.parse(scannedAt))
    ? scannedAt.slice(0, 10) : null;
  const midnight = date === null ? NaN : Date.parse(date);
  const scanDay = Number.isFinite(midnight) && new Date(midnight).toISOString().slice(0, 10) === date ? midnight : NaN;
  const ageDays = (asOf - scanDay) / DAY;
  const { body, status } = signals?.homepage ?? {};
  return {
    engine: version(afr.engineVersion),
    scanner: version(signals?.scannerVersion),
    homepage2xx: Number.isInteger(status) && status >= 200 && status < 300,
    homepageAtCap: typeof body === 'string' && body.length === BODY_CAP,
    homepageOverCap: typeof body === 'string' && body.length > BODY_CAP,
    missing: missingEngineBodies(signals),
    ageDays,
  };
}

function summarize(rows) {
  const engine = new Map();
  const scanner = new Map();
  const out = {
    total: 0, valid: 0, invalid: 0,
    homepageAtCap: 0, homepage2xxAtCap: 0, homepageOverCap: 0,
    nonCurrentKnownEngine: 0,
    nonCurrentKnownEngineWithMissing2xxBodies: 0,
    missing2xxEngineBodies: 0,
    missing2xxByProbe: { homepage: 0, robots: 0, llms: 0, sitemap: 0 },
    ageDays: { '0–6': 0, '7–13': 0, '14+': 0, future: 0, unknown: 0 },
  };
  for (const row of rows) {
    out.total++;
    if (!row) { out.invalid++; continue; }
    out.valid++;
    engine.set(row.engine, (engine.get(row.engine) ?? 0) + 1);
    scanner.set(row.scanner, (scanner.get(row.scanner) ?? 0) + 1);
    if (row.homepageAtCap) {
      out.homepageAtCap++;
      if (row.homepage2xx) out.homepage2xxAtCap++;
    }
    if (row.homepageOverCap) out.homepageOverCap++;
    if (row.missing.length) out.missing2xxEngineBodies++;
    if (row.engine !== '(missing)' && row.engine !== ENGINE_VERSION) {
      out.nonCurrentKnownEngine++;
      if (row.missing.length) out.nonCurrentKnownEngineWithMissing2xxBodies++;
    }
    for (const probe of row.missing) out.missing2xxByProbe[probe]++;
    const age = row.ageDays;
    const bucket = !Number.isFinite(age) ? 'unknown' : age < 0 ? 'future' : age < 7 ? '0–6' : age < 14 ? '7–13' : '14+';
    out.ageDays[bucket]++;
  }
  return { ...out, engineVersions: Object.fromEntries([...engine].sort()), scannerVersions: Object.fromEntries([...scanner].sort()) };
}

async function inventory(repo, commit, asOfDate) {
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(commit ?? '') || !/^\d{4}-\d{2}-\d{2}$/.test(asOfDate ?? '')) throw new Error(usage);
  const asOf = Date.parse(asOfDate);
  if (!Number.isFinite(asOf) || new Date(asOf).toISOString().slice(0, 10) !== asOfDate) throw new Error('Invalid AS_OF_UTC_DATE');
  if (git(repo, ['rev-parse', '--verify', `${commit}^{commit}`]).trim() !== commit) throw new Error('Expected a full commit SHA');
  const paths = git(repo, ['ls-tree', '-r', '-z', '--full-tree', commit, '--', 'scans']).split('\0').flatMap((line) => {
    const tab = line.indexOf('\t');
    if (tab < 0) return [];
    const path = line.slice(tab + 1);
    const match = SNAPSHOT_PATH.exec(path);
    if (!match) return [];
    const [mode, type, oid] = line.slice(0, tab).split(' ');
    if (type !== 'blob' || !/^100(?:644|755)$/.test(mode)) throw new Error(`Expected a regular snapshot: ${path}`);
    return [{ path, domain: match[1], oid }];
  });
  if (!paths.length) throw new Error('No dated JSON snapshots at this commit');

  // The catalog picks the newest dated path for each filename before parsing.
  paths.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  const latest = new Map();
  const rows = [];
  const everAtCap = new Set();
  const ever2xxAtCap = new Set();
  const byEngine = new Map();
  const invalidPaths = [];
  for await (const [entry, raw] of blobs(repo, paths)) {
    let row = null;
    try {
      row = inspect(raw, asOf);
    } catch {
      invalidPaths.push(entry.path);
    }
    if (row?.homepageAtCap) {
      everAtCap.add(entry.domain);
      if (row.homepage2xx) ever2xxAtCap.add(entry.domain);
    }
    if (row) {
      if (!byEngine.has(row.engine)) byEngine.set(row.engine, new Set());
      byEngine.get(row.engine).add(entry.domain);
    }
    rows.push(row);
    latest.set(entry.domain, row);
  }
  return {
    commit, asOfUtcDate: asOfDate,
    referenceVersions: { engine: ENGINE_VERSION, scanner: SCANNER_VERSION },
    homepageCapCodeUnits: BODY_CAP,
    confirmedHomepageTruncation: null, // no explicit truncation marker or pre-slice length in the snapshot schema
    snapshots: summarize(rows),
    latestDomains: summarize(latest.values()),
    domainsEverAtHomepageCap: everAtCap.size,
    domainsEverAt2xxHomepageCap: ever2xxAtCap.size,
    domainsEverByEngineVersion: Object.fromEntries([...byEngine].sort().map(([v, domains]) => [v, domains.size])),
    invalidPaths,
  };
}

try {
  const { positionals, values } = parseArgs({ allowPositionals: true, options: { help: { type: 'boolean' } } });
  if (values.help) {
    console.log(`${usage}\nReads local committed blobs and prints JSON. Age uses the UTC date of afr.scannedAt.\n` +
      'At-cap length is only a truncation candidate. Confirmed truncation is unavailable in stored snapshots.\n' +
      'Missing 2xx bodies can reflect pruning or scanner omission. Version counts are exact stored labels.');
  } else {
    if (positionals.length !== 3) throw new Error(usage);
    console.log(JSON.stringify(await inventory(...positionals), null, 2));
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
