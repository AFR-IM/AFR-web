// @afr/i18n tests — catalog parity, engine check-id coverage, AFR_METHOD math.
// Run: npm test (node --test test/*.test.ts) inside packages/i18n.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { scoreAfr } from '../../afr/src/index.ts';
import { FAMILY_MAX } from '../../afr/src/ua.ts';
import type { AfrResult, ScanSignals } from '../../shared/src/index.ts';
import { AFR_METHOD } from '../src/method.ts';
import { catalogs, getCatalog, type Catalog, type Locale } from '../src/index.ts';

const LOCALES: Locale[] = ['en', 'zh-CN'];
const SECTIONS = ['ui', 'checks', 'layers'] as const;
const OBJECT_SECTIONS = ['grades', 'strategies', 'categories'] as const;

/** Every CheckResult id the engine can produce (source grep of l1/l2/l3.ts). */
const ENGINE_CHECK_IDS = [
  'l1.robots.ai-policy',
  'l1.no-tech-wall',
  'l1.basic-availability',
  'l2.llms-family',
  'l2.structured-data',
  'l2.semantic-html',
  'l2.sitemap',
  'l2.content-signals',
  'l3.public-api',
  'l3.agent-instructions',
  'l3.mcp',
  'l3.site-ai-features',
];

/** Minimal signals: no probes at all — the engine still emits every check (as unknown). */
const MINIMAL: ScanSignals = {
  domain: 'x.test',
  fetchedAt: '2026-01-01T00:00:00Z',
  scannerVersion: 't',
};

/** Richer signals: robots 200 + llms 200 + homepage 200 (HTML) to widen scored paths. */
const RICHER: ScanSignals = {
  ...MINIMAL,
  robots: { status: 200, body: 'User-agent: *\nAllow: /\n' },
  llms: { status: 200, body: '# x.test\n\n> A test site.\n' },
  homepage: {
    status: 200,
    body: '<!doctype html><html lang="en"><head><title>x.test</title></head>' +
      '<body><h1>Hello</h1><p>Some words for the scanner to read on this page.</p></body></html>',
  },
};

function collectIds(result: AfrResult): string[] {
  return result.layers.flatMap((layer) => layer.checks.map((c) => c.id));
}

function keysOf(section: Catalog[(typeof SECTIONS)[number]] | Catalog[(typeof OBJECT_SECTIONS)[number]]): string[] {
  return Object.keys(section).sort();
}

describe('catalog parity', () => {
  it('en and zh-CN have identical key sets in every section', () => {
    for (const section of SECTIONS) {
      assert.deepEqual(
        keysOf(catalogs.en[section]),
        keysOf(catalogs['zh-CN'][section]),
        `section "${section}" key sets differ between en and zh-CN`,
      );
    }
    for (const section of OBJECT_SECTIONS) {
      assert.deepEqual(
        keysOf(catalogs.en[section]),
        keysOf(catalogs['zh-CN'][section]),
        `section "${section}" key sets differ between en and zh-CN`,
      );
      // Nested value shape (label/slogan, label/desc, name/blurb) must match too
      for (const key of Object.keys(catalogs.en[section])) {
        assert.deepEqual(
          Object.keys(catalogs.en[section][key]!).sort(),
          Object.keys(catalogs['zh-CN'][section][key]!).sort(),
          `section "${section}"["${key}"] value shape differs between en and zh-CN`,
        );
      }
    }
  });

  it('every required ui key exists in both locales', () => {
    const required = [
      'siteName', 'tagline', 'navCategories', 'navMethod', 'navSubmit', 'navBot', 'navAbout',
      'searchPlaceholder', 'themeToggle', 'footerPledge', 'footerRights', 'heroSlogan', 'heroSub',
      'distributionTitle', 'leaderboardTitle', 'latestTitle', 'viewAll', 'submitTitle',
      'submitStep1', 'submitStep2', 'submitStep3', 'sortScore', 'sortRank', 'sortNew',
      'filterGrade', 'filterLang', 'filterTag', 'score', 'grade', 'strategy', 'evidence',
      'rescan', 'rescanQueued', 'badgeEmbed', 'copy', 'copied', 'sponsored', 'notFound',
      'submitCta', 'searchEmpty', 'searchSubmitHint',
    ];
    for (const locale of LOCALES) {
      for (const key of required) {
        assert.ok(key in catalogs[locale].ui, `ui.${key} missing in ${locale}`);
      }
    }
  });

  it('categories cover exactly the 14 spec §7.1 slugs', () => {
    const expected = [
      'dev-tools', 'ai-tools', 'news', 'ecommerce', 'education', 'finance', 'social',
      'entertainment', 'health', 'travel', 'government', 'reference', 'docs', 'other',
    ].sort();
    for (const locale of LOCALES) {
      assert.deepEqual(Object.keys(catalogs[locale].categories).sort(), expected, locale);
    }
  });
});

describe('engine check id coverage', () => {
  it('minimal-scan check ids are covered by both catalogs', () => {
    const ids = collectIds(scoreAfr(MINIMAL));
    for (const locale of LOCALES) {
      for (const id of ids) {
        assert.ok(id in catalogs[locale].checks, `engine id "${id}" missing in ${locale}.checks`);
      }
    }
  });

  it('richer-scan union (plus source-grep list) is covered and matches the engine', () => {
    const union = new Set([
      ...collectIds(scoreAfr(MINIMAL)),
      ...collectIds(scoreAfr(RICHER)),
      ...ENGINE_CHECK_IDS,
    ]);
    for (const locale of LOCALES) {
      for (const id of union) {
        assert.ok(id in catalogs[locale].checks, `id "${id}" missing in ${locale}.checks`);
      }
    }
    // Both runs push all 12 checks unconditionally, so engine output == source grep list.
    // A new engine id fails here → add it to ENGINE_CHECK_IDS and both catalogs.
    assert.deepEqual([...union].sort(), [...ENGINE_CHECK_IDS].sort());
    // And the catalogs hold exactly those ids (no stale entries).
    assert.deepEqual(Object.keys(catalogs.en.checks).sort(), [...ENGINE_CHECK_IDS].sort());
  });
});

describe('AFR_METHOD (spec §3 transcription)', () => {
  it('layer weights sum to 100 and match 35 / 40 / 25', () => {
    const total = AFR_METHOD.layers.reduce((sum, l) => sum + l.weight, 0);
    assert.equal(total, 100);
    const byId = Object.fromEntries(AFR_METHOD.layers.map((l) => [l.id, l.weight]));
    assert.deepEqual(byId, { L1: 35, L2: 40, L3: 25 });
  });

  it('layer point totals match their weights', () => {
    for (const layer of AFR_METHOD.layers) {
      const points = layer.checks.reduce((sum, c) => sum + c.points, 0);
      assert.equal(points, layer.weight, `${layer.id} sub-check points != weight`);
    }
  });

  it('check ids are unique and A1 family totals cross-check against ua.ts', () => {
    const ids = AFR_METHOD.layers.flatMap((l) => l.checks.map((c) => c.id));
    assert.equal(new Set(ids).size, ids.length, 'duplicate MethodCheck ids');

    const l1 = AFR_METHOD.layers.find((l) => l.id === 'L1')!;
    const familyTotals: Record<string, number> = {};
    for (const check of l1.checks) {
      if (!check.family) continue;
      familyTotals[check.family] = (familyTotals[check.family] ?? 0) + check.points;
    }
    assert.deepEqual(familyTotals, { ...FAMILY_MAX }); // search 9 / hybrid 6 / training 10
    const a1Total = l1.checks.filter((c) => c.family).reduce((s, c) => s + c.points, 0);
    assert.equal(a1Total, 25);
  });

  it('grades follow spec §3.5 thresholds (calibrated 2026-11-10) and §10.2 colors', () => {
    assert.deepEqual(
      AFR_METHOD.grades.map((g) => g.min),
      [75, 60, 42, 25, 0],
    );
    assert.deepEqual(
      AFR_METHOD.grades.map((g) => g.color),
      ['#3ECFAD', '#8BD450', '#F2C94C', '#F2994A', '#EB5757'],
    );
    assert.equal(AFR_METHOD.standard, 'AFR');
    assert.equal(AFR_METHOD.version, '1.1');
  });
});

describe('getCatalog fallback', () => {
  it('falls back to en for unsupported locales', () => {
    assert.strictEqual(getCatalog('xx'), catalogs.en);
    assert.strictEqual(getCatalog('de'), catalogs.en);
    assert.strictEqual(getCatalog(''), catalogs.en);
    assert.strictEqual(getCatalog(undefined), catalogs.en);
  });

  it('returns the requested locale when supported', () => {
    assert.strictEqual(getCatalog('en'), catalogs.en);
    assert.strictEqual(getCatalog('zh-CN'), catalogs['zh-CN']);
  });
});
