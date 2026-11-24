import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { checkAssetCount, countDeployableAssets, WORKERS_ASSET_LIMIT } from './check-worker-assets.mjs';

async function fixture(t, files) {
  const root = await mkdtemp(path.join(tmpdir(), 'afr-worker-assets-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const [name, contents] of Object.entries(files)) {
    const destination = path.join(root, name);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, contents);
  }
  return root;
}

const runGuard = (...directories) => spawnSync(process.execPath, [
  fileURLToPath(new URL('./check-worker-assets.mjs', import.meta.url)), ...directories,
], { encoding: 'utf8' });

test('count both complete asset trees, including dotfiles and non-PNG OG assets', async (t) => {
  const web = await fixture(t, {
    '.assetsignore': '# Generated controls\n_worker.js\n_routes.json\n*.map\n!/keep.map\n',
    '_worker.js/index.js': '', '_routes.json': '', '_headers': '', '_redirects': '',
    'en/index.html': '', 'en/_headers': '', '.well-known/mcp': '', 'en/script.js.map': '', 'keep.map': '',
  });
  const og = await fixture(t, {
    '_headers': '', 'og/sites/site.png': '', 'og/sites/alternate.webp': '', 'manifest.json': '',
  });
  await mkdir(path.join(og, 'empty'));
  const result = runGuard(web, og);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /afr-web: 4 deployable asset files/);
  assert.match(result.stdout, /afr-og: 3 deployable asset files/);
});

test('an unignored Worker file or file symlink consumes a manifest slot', async (t) => {
  const root = await fixture(t, { '_worker.js/index.js': '', '_routes.json': '' });
  await symlink('_routes.json', path.join(root, 'alias.json'));
  assert.equal(await countDeployableAssets(root), 3);
});

test('keep the existing strict headroom policy on each Worker', () => {
  assert.equal(WORKERS_ASSET_LIMIT, 20_000);
  for (const name of ['afr-web', 'afr-og']) {
    assert.doesNotThrow(() => checkAssetCount(name, 19_999));
    assert.throws(() => checkAssetCount(name, 20_000), /must be fewer than 20000/);
    assert.throws(() => checkAssetCount(name, 20_001), /must be fewer than 20000/);
  }
});

test('missing trees or invalid ignore data fail closed and still check the other Worker', async (t) => {
  const web = await fixture(t, { '.assetsignore': Buffer.from([0xff]) });
  const og = await fixture(t, { 'card.png': '' });
  for (const directory of [web, path.join(web, 'missing')]) {
    const result = runGuard(directory, og);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /::error::afr-web/);
    assert.match(result.stdout, /afr-og: 1 deployable asset files/);
  }
});
