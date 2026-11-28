import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizeLang } from '../apps/web/src/utils/lang.ts';

test('case duplicates merge into one lowercase code', () => {
  assert.equal(normalizeLang('en-US'), 'en-us');
  assert.equal(normalizeLang('en-us'), 'en-us'); // same chip as above
  assert.equal(normalizeLang('EN'), 'en');
  assert.equal(normalizeLang('zh-CN'), 'zh-cn');
  assert.equal(normalizeLang('zh-Hant-TW'), 'zh-hant-tw');
});

test('codes that are not language tags drop out of the chips', () => {
  for (const bad of [
    'eng', 'zxx', // ISO-639-2 three-letter codes, not 2-letter primary subtags
    'en-EN', // EN is not an ISO 3166 region
    'jp', // not an ISO 639-1 language (Japanese is `ja`)
    'default', 'auto', 'global', // page placeholders
    'zh-cms', 'en-int', 'en-GLOBAL', // malformed subtags
    '', null, undefined, 'EN US', 'zh_CN',
  ]) {
    assert.equal(normalizeLang(bad), '', String(bad));
  }
});

test('real variants stay distinct chips — only the same code merges', () => {
  assert.equal(normalizeLang('zh'), 'zh');
  assert.equal(normalizeLang('zh-CN'), 'zh-cn');
  assert.equal(normalizeLang('zh-Hant'), 'zh-hant');
  assert.notEqual(normalizeLang('zh-Hant'), normalizeLang('zh-cn'));
  assert.equal(normalizeLang('pt-PT'), 'pt-pt'); // a real region — kept
  assert.equal(normalizeLang('en-001'), 'en-001'); // UN M.49 region — kept
});
