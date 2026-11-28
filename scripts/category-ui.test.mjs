import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';

const source = readFileSync(new URL('../apps/web/src/pages/[...locale]/c/[slug].astro', import.meta.url), 'utf8');
const script = source.match(/<script is:inline>\s*([\s\S]*?)<\/script>/)?.[1];
assert.ok(script);

function run(query) {
  const sites = Array.from({ length: 51 }, (_, i) => ({
    domain: `site-${i + 1}.example`, score: 100 - i, grade: 'B',
    rankSource: 51 - i, scannedAt: i === 50 ? '2026-11-25' : '2026-11-24',
    tags: i === 50 ? ['research'] : [], lang: i === 50 ? 'ja' : 'en',
  }));
  const grid = { getAttribute: () => null, replaceChildren(fragment) { this.cards = fragment.cards; } };
  const count = {
    getAttribute(name) {
      if (name === 'data-count-filtered') return '{n} of {m} sites';
      if (name === 'data-count-template') return '{n} sites';
      return null;
    },
  };
  const empty = {};
  const nodes = { '[data-grid]': grid, '[data-count]': count, '[data-empty]': empty,
    '[data-category-index]': { textContent: JSON.stringify(sites) },
    '[data-card-tpl]': { content: { firstElementChild: { cloneNode() {
      return { style: { setProperty() {} }, setAttribute(name, value) { this[name] = value; }, querySelector: () => null };
    } } } },
  };
  runInNewContext(script, { URLSearchParams, location: { search: query }, document: {
    querySelector: (selector) => nodes[selector] ?? null,
    querySelectorAll: () => [],
    createDocumentFragment: () => ({ cards: [], appendChild(card) { this.cards.push(card); } }),
  } });
  return { cards: grid.cards, count: count.textContent, empty: empty.hidden };
}

test('category links filter the entire catalog before rendering the first page', () => {
  for (const query of ['?tag=research', '?lang=ja', '?lang=JA', '?grade=B&lang=ja']) {
    const result = run(query);
    assert.equal(result.count, '1 of 51 sites');
    assert.equal(result.empty, true);
    assert.equal(result.cards[0].href, '/site/site-51.example');
  }
});

test('category links sort across pages and keep the initial DOM bounded', () => {
  for (const query of ['?sort=new', '?sort=rank']) {
    const result = run(query);
    // no filter active → the header count already says it; the list row stays silent
    assert.equal(result.count, '');
    assert.equal(result.cards.length, 50);
    assert.equal(result.cards[0].href, '/site/site-51.example');
  }
});

test('an unusable ?lang= is dropped instead of filtering the list to zero', () => {
  for (const query of ['?lang=en-EN', '?lang=eng', '?lang=jp']) {
    const result = run(query);
    assert.equal(result.count, undefined); // render() never ran — no filter state
    assert.equal(result.empty, undefined);
  }
});
