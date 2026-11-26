// scripts/promo-ui.test.mjs — the paid promotion card on a report page
// (apps/web/src/components/detail/PromoCard.astro).
//
// Two things must never regress here:
//   · the block only appears when the API returns a live promotion for
//     exactly this domain (otherwise every report page shows an ad slot),
//   · headline and body are inserted as plain text — a hostile promotion
//     must not be able to inject markup into a trusted page.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';

const require = createRequire(import.meta.url);
const originalEmitWarning = process.emitWarning;
process.emitWarning = () => {};
const { stripTypeScriptTypes } = require('node:module');
process.emitWarning = originalEmitWarning;

const read = (path) => readFileSync(new URL(`../apps/web/src/${path}`, import.meta.url), 'utf8');

const source = read('components/detail/PromoCard.astro');
const script = source.match(/<script>\s*([\s\S]*?)<\/script>/)?.[1];
assert.ok(script, 'PromoCard must carry a client script');

const client = [read('data/torch.ts'), script]
  .map((src) =>
    stripTypeScriptTypes(src, { mode: 'strip' })
      .replace(/^\s*import[\s\S]*?from\s*'[^']+';\s*$/gm, '')
      .replace(/^\s*export /gm, ''),
  )
  .join('\n');

const DOMAIN = 'example.com';

function makeEl(props = {}) {
  return {
    hidden: true,
    textContent: '',
    innerHTML: '',
    dataset: { domain: DOMAIN, locale: 'en' },
    attrs: {},
    children: {},
    getAttribute(name) {
      return name in this.attrs ? this.attrs[name] : null;
    },
    setAttribute(name, value) {
      this.attrs[name] = String(value);
    },
    querySelector(sel) {
      return this.children[sel] ?? null;
    },
    ...props,
  };
}

function loadCard(serve) {
  const calls = [];
  const headline = makeEl({ textContent: '' });
  const body = makeEl({ textContent: '' });
  const cta = makeEl({ attrs: { href: `https://${DOMAIN}`, rel: 'nofollow sponsored', target: '_blank' } });
  const card = makeEl({
    children: {
      '[data-promo-headline]': headline,
      '[data-promo-body]': body,
      '[data-promo-cta]': cta,
    },
  });
  const document = {
    querySelectorAll: (sel) => (sel === '[data-promo="promo"]' ? [card] : []),
    querySelector: () => null,
  };
  runInNewContext(client, {
    document,
    fetch: (url, options) => {
      calls.push({ url: String(url), options: options ?? {} });
      return Promise.resolve(serve(String(url)));
    },
    URLSearchParams,
    AbortController,
    console,
  });
  return { card, headline, body, cta, calls };
}

const ok = (body) => ({ ok: true, status: 200, json: async () => body });

test('a live promotion reveals the card with plain-text copy and a sponsored self-link', async () => {
  const page = loadCard(() =>
    ok({
      promo: {
        domain: DOMAIN,
        headline: 'Ship faster with our SDK',
        body: 'A paid promotion, shown on this site’s own report page.',
        startsAt: '2026-11-01T00:00:00.000Z',
        endsAt: '2026-12-01T00:00:00.000Z',
      },
    }),
  );
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(page.card.hidden, false);
  assert.equal(page.headline.textContent, 'Ship faster with our SDK');
  assert.equal(page.cta.getAttribute('href'), `https://${DOMAIN}`);
  assert.match(page.cta.getAttribute('rel'), /nofollow sponsored/);
  assert.match(page.calls[0].url, /\/api\/v1\/promos\?domain=example\.com$/);
  assert.equal(page.calls[0].options.cache, 'no-store');
});

test('a hostile headline stays text — no markup ever reaches the card', async () => {
  const attack = '<img src=x onerror="alert(1)"><script>evil()</script>';
  const page = loadCard(() =>
    ok({
      promo: { domain: DOMAIN, headline: attack, body: attack, startsAt: 'x', endsAt: 'y' },
    }),
  );
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(page.card.hidden, false);
  // textContent, not innerHTML: the payload is a literal string.
  assert.equal(page.headline.textContent, attack);
  assert.equal(page.body.textContent, attack);
  assert.equal(page.headline.innerHTML, '', 'the card must never write markup');
});

test('no promotion, another domain, or a dead API keeps the card hidden', async () => {
  const none = loadCard(() => ok({ promo: null }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(none.card.hidden, true);

  const other = loadCard(() =>
    ok({ promo: { domain: 'attacker.test', headline: 'Not yours', body: 'x', startsAt: 'x', endsAt: 'y' } }),
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(other.card.hidden, true);

  const down = loadCard(() => {
    throw new Error('offline');
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(down.card.hidden, true);
});

test('the static markup ships hidden with the sponsored rel on the CTA', () => {
  assert.match(source, /<aside class="promo-card" data-promo="promo"[^>]*\bhidden\b/);
  assert.match(source, /data-promo="promo"/);
  assert.match(source, /rel="[^"]*nofollow sponsored[^"]*"/);
  assert.match(source, /never participates in\s+(\/\/\s*)?scoring/); // the no-scoring promise stays in the source
  assert.match(source, /target="_blank"/);
});
