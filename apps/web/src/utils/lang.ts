// @afr/web — language-tag normalization for the category filter chips.
//
// The scanner records whatever the page declared (`<html lang="…">`), and the
// raw corpus contains case duplicates (`en-US` / `en-us`), tags that are not
// language codes at all (`eng` — ISO-639-2, `default`, `auto`), a repeated
// pseudo-region (`en-EN`) and plain junk (`jp`, `zh-cms`). Rendering those
// raw values as filter chips exposes the data hygiene straight to the user
// (c-news showed `en-US/en-us` side by side).
//
// One normalization, three consumers:
//   · the build (src/pages/[...locale]/c/[slug].astro) derives the chips and
//     the serialized category index from it,
//   · the page's inline script re-applies it to an incoming `?lang=` value
//     (an is:inline script cannot import this module — it carries a mirrored
//     copy and must stay in sync),
//   · scripts/lang-normalize.test.mjs pins the rules.
//
// Rules:
//   1. lowercase — merges case duplicates into one chip (`zh-CN` + `zh-cn`);
//   2. strict shape — a 2-letter primary subtag (ISO-639-1) plus optional
//      2-letter region / 4-letter script / 3-digit UN M.49 subtags. This
//      drops `eng`, `default`, `auto`, `zh-cms`, `en-int`, `en-GLOBAL`…;
//   3. a tiny denylist for tags that pass the shape but are not what they
//      claim to be.
// Real variants stay distinct: `zh`, `zh-cn`, `zh-hant`, `zh-hant-tw` are
// different codes and each keeps its own chip — only the same code merges.

/** Tags that pass the shape but are not valid language tags. */
const LANG_DENYLIST = new Set([
  'en-en', // EN is not an ISO 3166 region — the page repeated the language
  'jp', // not an ISO 639-1 language code (Japanese is `ja`)
]);

const LANG_SHAPE = /^[a-z]{2}(-([a-z]{2}|[a-z]{4}|[0-9]{3}))*$/;

/** Normalize one raw lang value → lowercase BCP-47, or '' when unusable. */
export function normalizeLang(value: unknown): string {
  const raw = String(value ?? '').trim().toLowerCase();
  if (!LANG_SHAPE.test(raw)) return '';
  if (LANG_DENYLIST.has(raw)) return '';
  return raw;
}
