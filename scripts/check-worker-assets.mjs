import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ignore from 'ignore';

export const WORKERS_ASSET_LIMIT = 20_000;

export async function countDeployableAssets(directory) {
  const root = path.resolve(directory);
  const ignoreFile = path.join(root, '.assetsignore');
  let customPatterns = [];
  try {
    const contents = new TextDecoder('utf-8', { fatal: true }).decode(await readFile(ignoreFile));
    if (contents.includes('\0')) throw new Error('contains a null character');
    customPatterns = contents.split('\n');
  } catch (error) {
    if (error.code !== 'ENOENT') throw new Error(`${ignoreFile}: ${error.message}`, { cause: error });
  }

  // Match Wrangler's asset manifest: these defaults are root-only. Astro's
  // _worker.js and _routes.json are excluded by the built .assetsignore,
  // not by this guard, so a missing ignore rule cannot hide deployable files.
  const matcher = ignore().add(['/.assetsignore', '/_redirects', '/_headers', ...customPatterns]);
  let count = 0;
  for (const relative of await readdir(root, { recursive: true })) {
    if (matcher.ignores(relative.split(path.sep).join('/'))) continue;
    // Wrangler stats entries rather than using lstat: a symlink to a file
    // also consumes a manifest slot. The recursive walk does not follow link directories.
    const entry = await stat(path.join(root, relative));
    if (entry.isFile()) count++;
  }
  return count;
}

export function checkAssetCount(name, count, limit = WORKERS_ASSET_LIMIT) {
  if (count >= limit) {
    throw new Error(`${name} has ${count} deployable asset files; must be fewer than ${limit}`);
  }
}

async function main([webDirectory, ogDirectory, ...extra]) {
  if (!webDirectory || !ogDirectory || extra.length) {
    throw new Error('Usage: node scripts/check-worker-assets.mjs <web assets directory> <OG assets directory>');
  }
  for (const [name, directory] of [['afr-web', webDirectory], ['afr-og', ogDirectory]]) {
    try {
      const count = await countDeployableAssets(directory);
      console.log(`${name}: ${count} deployable asset files (must be fewer than ${WORKERS_ASSET_LIMIT})`);
      checkAssetCount(name, count);
    } catch (error) {
      console.error(`::error::${name} (${directory}): ${error.message}`);
      process.exitCode = 1;
    }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(`::error::${error.message}`);
    process.exitCode = 1;
  });
}
