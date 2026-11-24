import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

export async function syncRelease({ dates, dataSha, requestPage, log = console.log, pause = delay }) {
  if (!/^[0-9a-f]{40}$/.test(dataSha ?? '')) throw new Error('Expected the checked-out data commit');
  for (const date of dates) {
    let offset = 0;
    for (;;) {
      let page;
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          page = await requestPage({ date, dataSha, offset });
          if (page?.dataSha !== dataSha || page.date !== date || page.offset !== offset) {
            throw new Error('sync response does not match requested commit/date/offset');
          }
          if (page.errors !== 0 || page.ok !== true) {
            throw new Error(`snapshot failures: ${JSON.stringify(page.failedPaths ?? [])}`);
          }
          if (page.nextOffset !== null && (!Number.isSafeInteger(page.nextOffset) || page.nextOffset <= offset)) {
            throw new Error('sync cursor did not advance');
          }
          break;
        } catch (err) {
          const message = `${dataSha} ${date}@${offset}, attempt ${attempt}/3: ${err.message}`;
          if (attempt === 3) throw new Error(message, { cause: err });
          log(message);
          await pause(5_000 * attempt);
        }
      }
      log(`${date}@${offset}: ${page.scans} synced, ${page.skipped} skipped, next=${page.nextOffset ?? 'done'}`);
      if (page.nextOffset === null) break;
      offset = page.nextOffset;
    }
  }
}

async function snapshotDates(root) {
  const files = await readdir(root, { recursive: true });
  return [...new Set(files.filter((file) => /^\d{4}\/\d{2}\/\d{2}\/[^/]+\.json$/.test(file))
    .map((file) => file.slice(0, 10)))].sort().reverse();
}

async function main() {
  const { DATA_SHA: dataSha, QUEUE_TOKEN: token } = process.env;
  if (!token) throw new Error('QUEUE_TOKEN is required');
  const dates = await snapshotDates(join(process.cwd(), 'data', 'scans'));
  if (!dates.length) throw new Error('No scan dates in release checkout');
  await syncRelease({ dates, dataSha, async requestPage(body) {
    const response = await fetch('https://afr.im/api/v1/_internal/sync', {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(120_000),
      headers: { 'X-Queue-Token': token, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
  } });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => { console.error(err.message); process.exitCode = 1; });
}
