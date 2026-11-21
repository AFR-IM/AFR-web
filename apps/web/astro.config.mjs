// @afr/web — Astro 5 config (SSG + islands, static output)
import { defineConfig } from 'astro/config';
import react from '@astrojs/react';

import cloudflare from "@astrojs/cloudflare";

export default defineConfig({
  site: 'https://afr.im',
  // Server output: the detail pages are rendered on demand (SSOT item 20 —
// 详情页按需生成). A static page per site cost two asset files per domain
  // (EN + zh-CN), and the Worker Free plan allows 20,000 files per version
  // — the catalog is the product, the pages must not be the limit. Every
  // other route sets `export const prerender = true`, so it stays a static
  // asset; only /site/* is rendered per request.
  output: 'server',
  // The static build wrote /site/<domain>/ with a trailing slash, and the
  // sitemap lists that form — keep the two the same, so a rendered page and
  // a prerendered one have the same canonical URL.
  trailingSlash: 'always',
  integrations: [react()],

  // Locale routing is managed by pages/[[locale]]/ + src/i18n/loader.ts:
  // English at /, zh-CN at /zh-CN/ — one template renders both.
  build: {
    inlineStylesheets: 'always', // inline all CSS: a cached HTML can never arrive without its styles
  },

  // Allow parallel self-check builds without fighting over dist/ (CI uses default).
  outDir: process.env.ASTRO_OUT_DIR || './dist',

  // The prerendered pages stay plain assets: the Worker Free plan bills a
  // request against the Worker (and its 10 ms CPU limit) as soon as the
  // request reaches the script. Only the detail pages need the Worker, so
  // every other route is excluded from the Worker's route list — the
  // assets handler answers them straight from the CDN.
  adapter: cloudflare({
    routes: {
      extend: {
        exclude: [
          '/',
          '/zh-CN/',
          '/about/',
          '/badges/',
          '/bot/',
          '/categories/',
          '/docs/',
          '/method/',
          '/offline/',
          '/search/',
          '/submit/',
          '/zh-CN/about/',
          '/zh-CN/badges/',
          '/zh-CN/bot/',
          '/zh-CN/categories/',
          '/zh-CN/docs/',
          '/zh-CN/method/',
          '/zh-CN/offline/',
          '/zh-CN/search/',
          '/zh-CN/submit/',
          '/c/*',
          '/zh-CN/c/*',
        ].map((pattern) => ({ pattern })),
      },
    },
  })
});