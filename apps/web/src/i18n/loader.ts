// @afr/web i18n loader — resolves locale catalogs for pages/components.
// Catalog CONTENT lives in packages/i18n (en default / zh-CN, keyed by check id per spec);
// this module only wires Astro routing to it.

import {
  catalogs,
  getCatalog as getBaseCatalog,
  type Catalog,
  type Locale,
} from '../../../../packages/i18n/src/index.ts';

export { catalogs };
export type { Catalog, Locale };

export const LOCALES: Locale[] = ['en', 'zh-CN'];
export const DEFAULT_LOCALE: Locale = 'en';

/** Normalize anything Astro gives us (currentLocale / path segment) to a supported Locale. */
export function toLocale(value: string | undefined | null): Locale {
  if (value && value in catalogs) return value as Locale;
  if (value?.startsWith('zh')) return 'zh-CN';
  return DEFAULT_LOCALE;
}

export function getCatalog(locale: string | undefined | null): Catalog {
  return getBaseCatalog(toLocale(locale));
}

/** Localized path helper: pathFor('zh-CN', '/site/x.com') -> '/zh-CN/site/x.com' */
export function pathFor(locale: Locale, path: string): string {
  const p = path.startsWith('/') ? path : `/${path}`;
  if (locale === DEFAULT_LOCALE) return p;
  return `/${locale}${p}`;
}

/** Toggle the "other" locale for the current URL (used by the language switch in nav). */
export function alternatePath(current: Locale, pathname: string): string {
  const stripped =
    current === DEFAULT_LOCALE ? pathname : pathname.replace(new RegExp(`^/${current}`), '') || '/';
  const target = current === DEFAULT_LOCALE ? 'zh-CN' : DEFAULT_LOCALE;
  return pathFor(target, stripped === '' ? '/' : stripped);
}
