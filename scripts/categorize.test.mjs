// scripts/categorize.test.mjs — the category heuristics must stay
// conservative: a wrong category misleads the site directory, so the
// generalized "what does the site say about itself" pass may only fire on
// decisive evidence from the site's own name fields.
//
// Fully offline: no network, no snapshots, no D1.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CATEGORY_SLUGS, categorize, META_MARKERS } from '../apps/web/src/data/categorize.mjs';

// ── the existing rules keep priority ───────────────────────────────────────

test('exact-domain table still wins over the meta pass', () => {
  // github.com is dev-tools in the table — a news-ish description must not move it
  assert.equal(
    categorize('github.com', 'GitHub', { description: 'Breaking news for developers' }),
    'dev-tools',
  );
  assert.equal(categorize('github.com', 'GitHub'), 'dev-tools');
});

test('TLD hints (.gov / .edu) still win', () => {
  assert.equal(categorize('example.gov', undefined), 'government');
  assert.equal(categorize('example.edu', undefined), 'education');
  assert.equal(categorize('example.gov.uk', undefined), 'government');
});

test('existing title rules still work', () => {
  assert.equal(categorize('stackoverflow.com', 'Questions'), 'dev-tools');
  assert.equal(categorize('example.com', 'The Verge — Tech'), 'news');
});

test('unknown sites without evidence stay other', () => {
  assert.equal(categorize('mystery-site.example', 'Welcome home'), 'other');
  assert.equal(categorize('mystery-site.example', undefined), 'other');
  assert.equal(categorize('mystery-site.example', undefined, {}), 'other');
  assert.equal(categorize('', 'anything'), 'other');
});

// ── the generalized meta pass ──────────────────────────────────────────────

test('a decisive phrase in the title classifies the site', () => {
  assert.equal(categorize('x.example', 'Breaking News - Daily Report'), 'news');
  assert.equal(categorize('x.example', 'Online Shop - Buy Now'), 'ecommerce');
  assert.equal(categorize('x.example', 'Online Courses for Everyone'), 'education');
  assert.equal(categorize('x.example', 'API Documentation for Developers'), 'docs');
  assert.equal(categorize('x.example', 'The Free Dictionary of English'), 'reference');
  assert.equal(categorize('x.example', 'Book Flights Online - Air Company'), 'travel');
  assert.equal(categorize('x.example', 'Personal Finance and Investment Advice'), 'finance');
  assert.equal(categorize('x.example', 'Clinical Guidelines for Patient Care'), 'health');
  assert.equal(categorize('x.example', 'Ministry of Foreign Affairs'), 'government');
  assert.equal(categorize('x.example', 'Community Forum - Talk to Members'), 'social');
  assert.equal(categorize('x.example', 'Large Language Model Playground'), 'ai-tools');
});

test('the meta description may corroborate a title marker', () => {
  assert.equal(
    categorize('x.example', 'News Daily Report', { description: 'Breaking news from around the world' }),
    'news',
  );
});

test('a strong-but-shared topic word alone is not enough', () => {
  // "bank" is shared between a retail bank, a fintech and a casino payout
  // desk: it needs a second, independent marker before it decides.
  assert.equal(categorize('x.example', 'Bank of the Future'), 'other');
  assert.equal(
    categorize('x.example', 'Bank of the Future', { description: 'Online Banking, Loans and Credit Cards' }),
    'finance',
  );
});

test('og:site_name may initiate a category', () => {
  assert.equal(
    categorize('x.example', undefined, { ogSiteName: 'Breaking News Daily' }),
    'news',
  );
});

test('a description-only marker may not initiate a category', () => {
  // "breaking news" in a marketing blurb is not enough on its own: the site
  // has to name itself that way (title / og:site_name).
  assert.equal(
    categorize('x.example', 'Welcome', { description: 'Sign up for breaking news' }),
    'other',
  );
});

test('keywords alone never initiate a category', () => {
  assert.equal(
    categorize('x.example', 'Welcome', { keywords: 'breaking news, sports, business' }),
    'other',
  );
});

test('two verticals that tie stay other', () => {
  // "streaming" (entertainment) and "api" (dev-tools) are both plausible here
  assert.equal(
    categorize('x.example', 'Streaming API for Live Video', { description: 'A streaming API platform' }),
    'other',
  );
});

test('matching folds diacritics', () => {
  assert.equal(categorize('x.example', 'Ultimas Noticias de España'), 'news');
  assert.equal(categorize('x.example', 'Últimas Noticias de España'), 'news');
});

test('latin markers respect word boundaries', () => {
  // "ai" must not fire inside "email", "said" or "chain"
  assert.equal(categorize('x.example', 'The Email Chain Manager'), 'other');
  assert.equal(categorize('x.example', 'Said Said Said'), 'other');
});

test('CJK topic words stay weak, compounds are decisive', () => {
  // a bare 新闻 in the middle of a real-estate blurb is not a news site
  assert.equal(categorize('x.example', '全国房地产门户', { description: '提供房地产新闻资讯内容' }), 'other');
  // …but the compound 新闻网 names the vertical outright
  assert.equal(categorize('x.example', '中国新闻网_梳理天下新闻'), 'news');
});

test('the score is never derived from the scan result', () => {
  // categorize() has no score input at all — the classification only ever
  // sees the site's own words. This test documents that contract.
  assert.equal(categorize('x.example', 'Breaking News'), 'news');
});

// ── invariants ─────────────────────────────────────────────────────────────

test('every marker category is a real category slug', () => {
  for (const [slug] of META_MARKERS) {
    assert.ok(CATEGORY_SLUGS.includes(slug), `unknown category slug in META_MARKERS: ${slug}`);
  }
});

test('categorize only ever returns a known slug', () => {
  const samples = [
    ['x.example', 'Breaking News'],
    ['x.example', 'Online Shop'],
    ['x.example', undefined],
    ['x.example', 'nothing special'],
    ['', ''],
  ];
  for (const [domain, title] of samples) {
    const slug = categorize(domain, title, { description: 'Buy now, add to cart' });
    assert.ok(CATEGORY_SLUGS.includes(slug), `unexpected slug: ${slug}`);
  }
});

test('classification is deterministic', () => {
  const meta = { description: 'Breaking news and analysis', keywords: 'news' };
  const first = categorize('x.example', 'Daily Report', meta);
  for (let i = 0; i < 5; i++) {
    assert.equal(categorize('x.example', 'Daily Report', meta), first);
  }
});
