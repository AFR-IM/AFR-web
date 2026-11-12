#!/usr/bin/env node
// make-icons — renders the PWA icon set from the hand-written brand mark.
// Run from apps/web:  node scripts/make-icons.mjs
//
// Sources of truth:
//   src/components/brand/mark.svg — master geometry (spec §15.4: SVG only)
//   FAVICON_SVG below             — chunky simplification of the same
//                                    identity, tuned to survive 16–32px
//
// Outputs (public/icons/): icon-192.png, icon-512.png (navy square bg),
//   maskable-512.png (content inside the 80% safe zone), apple-touch-icon.png
//   (180), favicon.svg.
// Requires sharp (resolves from the workspace root node_modules).

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const webDir = path.resolve(scriptsDir, '..');
const outDir = path.join(webDir, 'public', 'icons');
const markPath = path.join(webDir, 'src', 'components', 'brand', 'mark.svg');

const NAVY = '#0B1220';
const MINT = '#3ECFAD';

/** Strip the outer <svg> wrapper, keep the drawable content of the mark. */
function markInner(svg) {
  const match = svg.match(/<svg[^>]*>([\s\S]*)<\/svg>/);
  if (!match) throw new Error('mark.svg: cannot find <svg> root element');
  return match[1].trim();
}

/**
 * Full-bleed navy square icon embedding the mark.
 * The mark's own navy disc blends into the square background, so only the
 * mint geometry shows. `scale` grows it: non-maskable icons may reach ~81%
 * of the canvas, maskable stays at 77% (< 80% safe zone, spec §15.4-⑤).
 */
function squareIcon(inner, size, scale) {
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 64 64">`,
    `<rect width="64" height="64" fill="${NAVY}"/>`,
    `<g transform="translate(32 32) scale(${scale}) translate(-32 -32)">${inner}</g>`,
    `</svg>`,
  ].join('');
}

// Chunky favicon variant: same identity (continuous outer ring, 3 mid-ring
// segments, five-point spark) with thicker strokes and a slightly stouter
// star so every gap still renders as ≥1px at 32px.
const FAVICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64" role="img" aria-label="afr">
  <circle cx="32" cy="32" r="32" fill="${NAVY}"/>
  <circle cx="32" cy="32" r="22.5" fill="none" stroke="${MINT}" stroke-width="4.2"/>
  <g fill="none" stroke="${MINT}" stroke-width="4.4">
    <path d="M33.95 18.14A14 14 0 0 1 44.98 37.24"/>
    <path d="M19.02 37.24A14 14 0 0 1 30.05 18.14"/>
    <path d="M43.03 40.62A14 14 0 0 1 20.97 40.62"/>
  </g>
  <path fill="${MINT}" d="M32 22.8L34.29 28.84L40.75 29.16L35.71 33.21L37.41 39.44L32 35.9L26.59 39.44L28.29 33.21L23.25 29.16L29.71 28.84Z"/>
</svg>
`;

/** Rasterize an SVG string to PNG at an exact size, then report metadata. */
async function renderPng(svg, size, name) {
  const file = path.join(outDir, name);
  await sharp(Buffer.from(svg), { density: 72 }).resize(size, size).png().toFile(file);
  const meta = await sharp(file).metadata();
  console.log(`  ${name.padEnd(22)} ${meta.width}x${meta.height}  ${meta.format}`);
}

async function main() {
  await mkdir(outDir, { recursive: true });
  const inner = markInner(await readFile(markPath, 'utf8'));

  console.log('rendering icons ->', outDir);
  await renderPng(squareIcon(inner, 192, 1.05), 192, 'icon-192.png');
  await renderPng(squareIcon(inner, 512, 1.05), 512, 'icon-512.png');
  await renderPng(squareIcon(inner, 512, 1.0), 512, 'maskable-512.png');
  await renderPng(squareIcon(inner, 180, 1.0), 180, 'apple-touch-icon.png');

  const faviconPath = path.join(outDir, 'favicon.svg');
  await writeFile(faviconPath, FAVICON_SVG, 'utf8');
  console.log(`  ${'favicon.svg'.padEnd(22)} ${(await readFile(faviconPath)).length} bytes`);

  console.log('done.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
