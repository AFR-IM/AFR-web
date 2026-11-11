// @aiapp/web — Astro 5 config (spec §5.2: SSG + islands, static output)
import { defineConfig } from 'astro/config';
import react from '@astrojs/react';

import cloudflare from "@astrojs/cloudflare";

export default defineConfig({
  site: 'https://aiapp.im',
  output: 'static',
  integrations: [react()],

  // Locale routing is managed by pages/[[locale]]/ + src/i18n/loader.ts:
  // English at /, zh-CN at /zh-CN/ — one template renders both.
  build: {
    inlineStylesheets: 'auto',
  },

  // Allow parallel self-check builds without fighting over dist/ (CI uses default).
  outDir: process.env.ASTRO_OUT_DIR || './dist',

  adapter: cloudflare()
});