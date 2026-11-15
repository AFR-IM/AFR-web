#!/usr/bin/env node
// make-og — renders the 1200×630 Open Graph card from the brand mark.
// Run from apps/web:  node scripts/make-og.mjs
//
// Output: public/og.png, referenced by og:image / twitter:image in
// layouts/Base.astro as the absolute https://afr.im/og.png. Flat brand
// composition (navy canvas, mint mark, AFR+.im wordmark, tagline) — same
// no-gradients identity as the master mark. Text renders through
// librsvg/fontconfig with a system sans, so no webfont is embedded in the
// raster path and the card stays crisp at thumbnail size.
//
// Requires sharp (resolves from the workspace root node_modules).

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const webDir = path.resolve(scriptsDir, '..');
const markPath = path.join(webDir, 'src', 'components', 'brand', 'mark.svg');
const outPath = path.join(webDir, 'public', 'og.png');

const W = 1200;
const H = 630;
const NAVY = '#0B1220';
const MINT = '#3ECFAD';
const WHITE = '#FFFFFF';
const MUTED = '#9AA4B8';
const FONT = 'DejaVu Sans, Ubuntu, sans-serif';

const mark = await readFile(markPath, 'utf8');
const markInner = mark.match(/<svg[^>]*>([\s\S]*)<\/svg>/)?.[1];
if (!markInner) throw new Error('mark.svg: cannot find <svg> root element');

// mark.svg has a 64×64 viewBox with its own navy disc — scale to 300px and
// let the disc blend into the canvas exactly like the PWA icons do.
const MARK_SIZE = 300;
const scale = MARK_SIZE / 64;

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <rect width="${W}" height="${H}" fill="${NAVY}"/>
  <g transform="translate(96 ${(H - MARK_SIZE) / 2}) scale(${scale})">${markInner}</g>
  <text x="472" y="300" font-family="${FONT}" font-size="168" font-weight="bold" fill="${WHITE}">AFR<tspan fill="${MINT}">.im</tspan></text>
  <text x="474" y="384" font-family="${FONT}" font-size="46" font-weight="bold" fill="${MINT}">AI-Friendliness Rating</text>
  <text x="474" y="452" font-family="${FONT}" font-size="30" fill="${MUTED}">afr.im · full evidence chain</text>
</svg>`;

const png = await sharp(Buffer.from(svg), { density: 96 })
  .resize(W, H)
  .png({ compressionLevel: 9 })
  .toBuffer();

await writeFile(outPath, png);
console.log(`written ${path.relative(webDir, outPath)} (${png.length} bytes, ${W}×${H})`);
