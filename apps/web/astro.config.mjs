// @afr/web — Astro 5 config (SSG + islands, static output)
import { defineConfig } from 'astro/config';
import react from '@astrojs/react';

import cloudflare from "@astrojs/cloudflare";

export default defineConfig({
  site: 'https://afr.im',
  output: 'static',
  integrations: [react()],

  // Locale routing is managed by pages/[[locale]]/ + src/i18n/loader.ts:
  // English at /, zh-CN at /zh-CN/ — one template renders both.
  build: {
    inlineStylesheets: 'always', // inline all CSS: a cached HTML can never arrive without its styles
  },

  // Allow parallel self-check builds without fighting over dist/ (CI uses default).
  outDir: process.env.ASTRO_OUT_DIR || './dist',

  adapter: cloudflare()
});