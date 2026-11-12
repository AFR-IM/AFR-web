// test/badge.test.ts — SVG badge rendering (spec §8.4).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createApp } from '../src/index.ts';
import { badgeSvg } from '../src/badge.ts';
import { openSeededDb } from './helpers.ts';

function app() {
  return createApp({ db: openSeededDb().db });
}

describe('GET /badge/:domain.svg', () => {
  it('serves a colored badge with grade letter, score and label', async () => {
    const res = await app().request('/badge/example.com.svg');
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /image\/svg\+xml/);
    assert.match(res.headers.get('cache-control') ?? '', /max-age=3600/);

    const svg = await res.text();
    assert.ok(svg.includes('>A<'), 'grade letter A missing');
    assert.ok(svg.includes('92'), 'score missing');
    assert.ok(svg.includes('AI-Friendly Rating · AFR.IM'), 'label missing');
    assert.ok(svg.includes('#3ECFAD'), 'grade A color missing');
    assert.ok(svg.startsWith('<svg'), 'not an SVG document');
  });

  it('serves a neutral gray dash badge for unknown domains', async () => {
    const res = await app().request('/badge/ghost.example.svg');
    assert.equal(res.status, 200);
    const svg = await res.text();
    assert.ok(svg.includes('—'), 'neutral dash missing');
    assert.ok(svg.includes('#94A3B8'), 'neutral color missing');
    assert.ok(!svg.includes('#3ECFAD'), 'must not leak a grade color');
  });

  it('404s paths without the .svg suffix', async () => {
    const res = await app().request('/badge/example.com');
    assert.equal(res.status, 404);
  });
});

describe('badgeSvg (pure builder)', () => {
  it('renders pending/declined grades as neutral', () => {
    const pending = badgeSvg({ domain: 'example.com', grade: 'Pending', score: null });
    assert.ok(pending.includes('—'));
    assert.ok(pending.includes('#94A3B8'));

    const f = badgeSvg({ domain: 'example.com', grade: 'F', score: 12 });
    assert.ok(f.includes('>F<'));
    assert.ok(f.includes('#EB5757'));
    assert.ok(f.includes('12'));
  });

  it('escapes markup in the domain shown in aria-label', () => {
    const svg = badgeSvg({ domain: '<script>', grade: null, score: null });
    assert.ok(!svg.includes('<script>'));
    assert.ok(svg.includes('&lt;script&gt;'));
  });
});
