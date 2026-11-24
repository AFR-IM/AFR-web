import { strict as assert } from 'node:assert';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { ENGINE_VERSION } from '../packages/afr/src/index.ts';
import { BODY_CAP } from './rederive-signals.mjs';

const script = fileURLToPath(new URL('./inventory-snapshots.mjs', import.meta.url));

function fixture(t) {
  const repo = mkdtempSync(join(tmpdir(), 'afr-inventory-'));
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
  git('init', '-q');
  function write(path, value) {
    const fullPath = join(repo, path);
    mkdirSync(dirname(fullPath), { recursive: true });
    writeFileSync(fullPath, value);
  }
  function save(path, { date, engine = ENGINE_VERSION, homepage = { status: 200, body: '' }, robots } = {}) {
    write(path, JSON.stringify({
      afr: { score: 0, layers: [], scannedAt: date, engineVersion: engine },
      signals: { scannerVersion: 'scanner-0.1.0', homepage, robots },
    }));
  }
  function commit(message) {
    git('add', '.');
    git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.com', '-c', 'commit.gpgsign=false', 'commit', '-qm', message);
    return git('rev-parse', 'HEAD');
  }
  return { repo, write, save, commit, git };
}

function run(repo, sha, date = '2026-11-24') {
  return spawnSync(process.execPath, [script, repo, sha, date], { encoding: 'utf8' });
}

test('inventory reads a pinned commit and deduplicates by newest dated path', (t) => {
  const { repo, write, save, commit, git } = fixture(t);
  // Emoji uses two UTF-16 code units and four UTF-8 bytes. The cap is on code units.
  const atCap = '🐈'.repeat(BODY_CAP / 2);
  const old = 'afr-1.4.0';
  for (const day of ['10', '11']) {
    save(`scans/2026/11/${day}/a.example.json`, {
      date: `2026-11-${day}T00:00:00.000Z`, engine: old, homepage: { status: day === '10' ? 403 : 200, body: atCap },
    });
  }
  const latest = 'scans/2026/11/20/a.example.json';
  save(latest, { date: '2026-11-20T23:59:00.000Z', homepage: { status: 200 }, robots: { status: 403 } });
  save('scans/2026/11/17/b.example.json', { date: '2026-11-17T23:55:00.000Z', engine: old, robots: { status: 200 } });
  save('scans/2026/11/18/c.example.json', { date: '2026-11-18T23:55:00.000Z', engine: null });
  write('scans/not-a-snapshot.json', '{}');
  const sha = commit('pinned');
  write(latest, 'malformed');
  const later = commit('newer');
  write(latest, 'dirty');
  const status = git('status', '--porcelain');

  const result = run(repo, sha);
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.commit, sha);
  assert.equal(report.confirmedHomepageTruncation, null);
  assert.equal(report.snapshots.total, 5);
  assert.equal(report.snapshots.homepageAtCap, 2);
  assert.equal(report.snapshots.homepage2xxAtCap, 1);
  assert.equal(report.snapshots.homepageOverCap, 0);
  assert.equal(report.domainsEverAtHomepageCap, 1);
  assert.equal(report.domainsEverAt2xxHomepageCap, 1);
  assert.equal(report.domainsEverByEngineVersion[old], 2);
  assert.equal(report.latestDomains.total, 3);
  assert.equal(report.latestDomains.homepageAtCap, 0);
  assert.equal(report.latestDomains.engineVersions['(missing)'], 1);
  assert.equal(report.latestDomains.nonCurrentKnownEngine, 1);
  assert.equal(report.latestDomains.nonCurrentKnownEngineWithMissing2xxBodies, 1);
  assert.equal(report.latestDomains.missing2xxEngineBodies, 2);
  assert.deepEqual(report.latestDomains.missing2xxByProbe, { homepage: 1, robots: 1, llms: 0, sitemap: 0 });
  assert.deepEqual(report.snapshots.ageDays, { '0–6': 2, '7–13': 2, '14+': 1, future: 0, unknown: 0 });
  assert.deepEqual(report.latestDomains.ageDays, { '0–6': 2, '7–13': 1, '14+': 0, future: 0, unknown: 0 });
  const laterResult = run(repo, later);
  assert.equal(laterResult.status, 0, laterResult.stderr);
  const laterReport = JSON.parse(laterResult.stdout);
  assert.deepEqual(laterReport.invalidPaths, [latest]);
  assert.equal(laterReport.latestDomains.valid, 2);
  assert.equal(laterReport.latestDomains.invalid, 1);
  assert.equal(git('status', '--porcelain'), status);
});

test('inventory requires a full commit and valid UTC date', (t) => {
  const { repo, save, commit } = fixture(t);
  save('scans/2026/11/20/a.example.json');
  const sha = commit('pinned');
  assert.match(run(repo, 'HEAD').stderr, /FULL_COMMIT_SHA/);
  assert.match(run(repo, sha, '2026-02-30').stderr, /Invalid AS_OF_UTC_DATE/);
  const result = run(repo, sha);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).latestDomains.ageDays.unknown, 1);
});
