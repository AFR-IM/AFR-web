// Page metadata (title / lang) — the fields the scanner writes next to the
// homepage body, and the rules the consumers fall back to.
//
// Why the rules matter: the corpus prunes the raw bodies (they are 98% of
// its volume and are only needed to re-judge the AI-feature signals offline).
// A title that only existed inside the body is a title that is lost — so the
// scanner captures it, and every reader must reproduce it exactly from the
// body it was derived from.
//
// Run: node --test packages/scanner/test/*.test.ts

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  TITLE_MAX_CHARS,
  capturePageMeta,
  extractPageLang,
  extractPageMeta,
  extractPageTitle,
  resolvePageLang,
  resolvePageMeta,
  resolvePageTitle,
} from '../src/page-meta.ts';
import { scanSite } from '../src/scan.ts';
import type { FetchImpl } from '../src/http.ts';

/** A mock fetch that serves one fixed homepage and 404s everything else. */
function homepageFetch(body: string, status = 200): FetchImpl {
  return async (url) => {
    const isHome = new URL(url).pathname === '/';
    return new Response(isHome ? body : '', {
      status: isHome ? status : 404,
      headers: { 'content-type': 'text/html' },
      url,
    }) as unknown as Response;
  };
}

describe('extractPageTitle', () => {
  it('reads the title text of a page', () => {
    assert.equal(
      extractPageTitle('<html><head><title>Acme — Widgets</title></head></html>'),
      'Acme — Widgets',
    );
  });

  it('returns undefined when the page has no title', () => {
    assert.equal(extractPageTitle('<html><body>no title here</body></html>'), undefined);
  });

  it('returns undefined for an empty title element', () => {
    assert.equal(extractPageTitle('<html><head><title>   </title></head></html>'), undefined);
  });

  it('returns undefined when there is no body to read', () => {
    assert.equal(extractPageTitle(undefined), undefined);
    assert.equal(extractPageTitle(null), undefined);
    assert.equal(extractPageTitle(42), undefined);
  });

  it('decodes the HTML entities a title usually carries', () => {
    assert.equal(
      extractPageTitle('<title>Tom &amp; Jerry &mdash; &quot;fun&quot; &lt;3</title>'),
      'Tom & Jerry &mdash; "fun" <3',
    );
    assert.equal(extractPageTitle('<title>a&nbsp;b</title>'), 'a b');
    assert.equal(extractPageTitle('<title>&#65;&#x42;</title>'), 'AB');
  });

  it('collapses newlines and runs of whitespace', () => {
    assert.equal(
      extractPageTitle('<title>\n  Acme\n  Widgets\t </title>'),
      'Acme Widgets',
    );
  });

  it('cuts an overlong title and marks the cut', () => {
    const long = 'x'.repeat(TITLE_MAX_CHARS + 40);
    const title = extractPageTitle(`<title>${long}</title>`)!;
    assert.equal(title.length, TITLE_MAX_CHARS);
    assert.ok(title.endsWith('…'), 'a cut title is marked with an ellipsis');
    assert.ok(title.startsWith('x'.repeat(10)));
  });

  it('keeps a title that is exactly at the limit untouched', () => {
    const exact = 'y'.repeat(TITLE_MAX_CHARS);
    assert.equal(extractPageTitle(`<title>${exact}</title>`), exact);
  });

  it('reads a title that carries attributes', () => {
    assert.equal(extractPageTitle('<title lang="en">Acme</title>'), 'Acme');
  });
});

describe('extractPageLang', () => {
  it('reads the html lang attribute', () => {
    assert.equal(extractPageLang('<html lang="en"><body>x</body></html>'), 'en');
    assert.equal(extractPageLang("<html lang='de-DE'>"), 'de-DE');
  });

  it('reads an unquoted or spaced lang attribute', () => {
    assert.equal(extractPageLang('<html lang=en>'), 'en');
    assert.equal(extractPageLang('<html lang = "fr">'), 'fr');
  });

  it('returns undefined when the page declares no language', () => {
    assert.equal(extractPageLang('<html><body>x</body></html>'), undefined);
    assert.equal(extractPageLang(undefined), undefined);
  });
});

describe('extractPageMeta', () => {
  it('reads the self-description a page publishes', () => {
    const html =
      '<head>' +
      '<meta property="og:site_name" content="Acme Widgets">' +
      '<meta name="application-name" content="Acme">' +
      '<meta name="description" content="Widgets for everyone">' +
      '<meta name="keywords" content="widgets, gadgets">' +
      '</head>';
    assert.deepEqual(extractPageMeta(html), {
      ogSiteName: 'Acme Widgets',
      appName: 'Acme',
      description: 'Widgets for everyone',
      keywords: 'widgets, gadgets',
    });
  });

  it('reads the attributes in either order', () => {
    const html = '<meta content="Acme Widgets" property="og:site_name">';
    assert.equal(extractPageMeta(html)?.ogSiteName, 'Acme Widgets');
  });

  it('falls back to og:description when there is no description', () => {
    const html = '<meta property="og:description" content="Widgets for everyone">';
    assert.equal(extractPageMeta(html)?.description, 'Widgets for everyone');
  });

  it('decodes the entities and collapses the whitespace', () => {
    const html = '<meta name="description" content="Widgets &amp; gadgets\n  for everyone">';
    assert.equal(extractPageMeta(html)?.description, 'Widgets & gadgets for everyone');
  });

  it('returns undefined when the page declares none of them', () => {
    assert.equal(extractPageMeta('<html><body>x</body></html>'), undefined);
    assert.equal(extractPageMeta(undefined), undefined);
    assert.equal(extractPageMeta('<meta name="description" content="   ">'), undefined);
  });

  it('looks at the head of the page only', () => {
    const html = `<head>${'x'.repeat(25000)}<meta name="description" content="late"></head>`;
    assert.equal(extractPageMeta(html), undefined, 'the tag is past the 20 000 character head');
  });
});

describe('capturePageMeta', () => {
  it('captures the meta block next to the title and the lang', () => {
    const html =
      '<html lang="en"><head><title>Acme</title>' +
      '<meta property="og:site_name" content="Acme Widgets"></head></html>';
    assert.deepEqual(capturePageMeta(html), {
      title: 'Acme',
      lang: 'en',
      meta: { ogSiteName: 'Acme Widgets' },
    });
  });

  it('leaves the meta key out when the page publishes nothing', () => {
    assert.deepEqual(capturePageMeta('<html lang="en"><title>Acme</title></html>'), {
      title: 'Acme',
      lang: 'en',
    });
  });

  it('captures both fields and leaves out what the page does not declare', () => {
    assert.deepEqual(capturePageMeta('<html lang="en"><title>Acme</title></html>'), {
      title: 'Acme',
      lang: 'en',
    });
    assert.deepEqual(capturePageMeta('<html><title>Acme</title></html>'), { title: 'Acme' });
    assert.deepEqual(capturePageMeta('<html lang="en"></html>'), { lang: 'en' });
    assert.deepEqual(capturePageMeta('<html></html>'), {});
  });

  it('never throws on a body it cannot parse', () => {
    const original = String.prototype.match;
    String.prototype.match = () => {
      throw new Error('boom');
    };
    try {
      assert.deepEqual(capturePageMeta('<title>Acme</title>'), {});
    } finally {
      String.prototype.match = original;
    }
  });
});

describe('resolvePageTitle / resolvePageLang (field first, body second)', () => {
  it('prefers the field the scanner wrote', () => {
    assert.equal(
      resolvePageTitle({ title: 'From the field', body: '<title>From the body</title>' }),
      'From the field',
    );
    assert.equal(
      resolvePageLang({ lang: 'en', body: '<html lang="de">' }),
      'en',
    );
  });

  it('falls back to the body for the snapshots taken before the field existed', () => {
    assert.equal(
      resolvePageTitle({ body: '<title>From the body</title>' }),
      'From the body',
    );
    assert.equal(resolvePageLang({ body: '<html lang="de">' }), 'de');
  });

  it('falls back to the body when the field is empty or not a string', () => {
    assert.equal(resolvePageTitle({ title: '   ', body: '<title>From the body</title>' }), 'From the body');
    assert.equal(resolvePageTitle({ title: 7 as unknown as string, body: '<title>Body</title>' }), 'Body');
    assert.equal(resolvePageLang({ lang: '', body: '<html lang="de">' }), 'de');
  });

  it('returns undefined when neither the field nor the body has it', () => {
    assert.equal(resolvePageTitle({}), undefined);
    assert.equal(resolvePageTitle(undefined), undefined);
    assert.equal(resolvePageLang({}), undefined);
    assert.equal(resolvePageLang(undefined), undefined);
  });

  it('gives the same answer for a field and for the body it came from', () => {
    const body = '<html lang="en"><title>Acme &amp; Co</title></html>';
    const meta = capturePageMeta(body);
    assert.equal(resolvePageTitle({ ...meta, body }), resolvePageTitle({ body }));
    assert.equal(resolvePageLang({ ...meta, body }), resolvePageLang({ body }));
  });
});

describe('resolvePageMeta (field first, body second)', () => {
  it('prefers the field the scanner wrote', () => {
    const probe = {
      meta: { ogSiteName: 'From the field' },
      body: '<meta property="og:site_name" content="From the body">',
    };
    assert.equal(resolvePageMeta(probe)?.ogSiteName, 'From the field');
  });

  it('falls back to the body for the snapshots taken before the field existed', () => {
    const probe = { body: '<meta property="og:site_name" content="From the body">' };
    assert.equal(resolvePageMeta(probe)?.ogSiteName, 'From the body');
  });

  it('returns undefined when neither the field nor the body has it', () => {
    assert.equal(resolvePageMeta({}), undefined);
    assert.equal(resolvePageMeta(undefined), undefined);
  });

  it('ignores a corrupted field and reads the body instead', () => {
    const probe = { meta: 'not an object', body: '<meta name="description" content="Body">' };
    assert.equal(resolvePageMeta(probe)?.description, 'Body');
    const empty = { meta: {}, body: '<meta name="description" content="Body">' };
    assert.equal(resolvePageMeta(empty)?.description, 'Body');
  });

  it('gives the same answer for a field and for the body it came from', () => {
    const body =
      '<head><meta property="og:site_name" content="Acme Widgets">' +
      '<meta name="description" content="Widgets for everyone"></head>';
    assert.deepEqual(resolvePageMeta(capturePageMeta(body)), resolvePageMeta({ body }));
  });
});

describe('the scanner writes the page metadata', () => {
  it('stores the title, the lang and the meta next to the homepage body', async () => {
    const body =
      '<html lang="en"><head><title>Acme — Widgets</title>' +
      '<meta property="og:site_name" content="Acme Widgets"></head><body>hi</body></html>';
    const signals = await scanSite('acme.example', { fetchImpl: homepageFetch(body), gapMs: 0 });
    assert.equal(signals.homepage?.title, 'Acme — Widgets');
    assert.equal(signals.homepage?.lang, 'en');
    assert.deepEqual(signals.homepage?.meta, { ogSiteName: 'Acme Widgets' });
    assert.equal(signals.homepage?.body, body, 'the body is still stored');
  });

  it('reproduces the title exactly as the body alone gives it', async () => {
    const body = '<html lang="pt-BR"><title>  Caf\u00e9 &amp; Co\n  Ltd  </title></html>';
    const signals = await scanSite('cafe.example', { fetchImpl: homepageFetch(body), gapMs: 0 });
    assert.equal(signals.homepage?.title, extractPageTitle(body));
    assert.equal(signals.homepage?.lang, extractPageLang(body));
  });

  it('omits the keys when the page declares neither a title nor a language', async () => {
    const signals = await scanSite('bare.example', {
      fetchImpl: homepageFetch('<html><body>plain</body></html>'),
      gapMs: 0,
    });
    assert.ok(!('title' in (signals.homepage ?? {})));
    assert.ok(!('lang' in (signals.homepage ?? {})));
    assert.ok(!('meta' in (signals.homepage ?? {})));
    assert.equal(signals.homepage?.body, '<html><body>plain</body></html>');
  });

  it('keeps the body when the page metadata cannot be parsed', async () => {
    const body = '<html lang="en"><title>Acme</title></html>';
    const original = String.prototype.match;
    String.prototype.match = () => {
      throw new Error('boom');
    };
    try {
      const signals = await scanSite('boom.example', { fetchImpl: homepageFetch(body), gapMs: 0 });
      assert.equal(signals.homepage?.body, body, 'a failed parse must not cost us the body');
      assert.equal(signals.homepage?.title, undefined);
      assert.equal(signals.homepage?.lang, undefined);
    } finally {
      String.prototype.match = original;
    }
  });

  it('stores no metadata when the homepage could not be fetched', async () => {
    const signals = await scanSite('down.example', {
      fetchImpl: homepageFetch('', 503),
      gapMs: 0,
    });
    assert.equal(signals.homepage?.status, 503);
    assert.ok(!('title' in (signals.homepage ?? {})));
    assert.ok(!('lang' in (signals.homepage ?? {})));
    assert.ok(!('meta' in (signals.homepage ?? {})));
  });
});
