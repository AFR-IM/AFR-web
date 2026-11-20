// In-site AI feature signals — structural detection (no raw-text matching)
// Run: node --test packages/scanner/test/*.test.ts
//
// The engine awards points for an in-site chat widget, an AI search and a
// developer console. These tests pin the rule that a signal needs markup:
// a script/iframe/link or a container element — never a word in the prose and
// never a word inside an embedded JSON catalog.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { scoreAfr } from '../../afr/src/index.ts';
import type { ScanSignals } from '../../shared/src/index.ts';
import { detectAiFeatures } from '../src/scan.ts';

const DOMAIN = 'example.com';
const SCANNED_AT = '2026-11-20T02:00:00Z';

/** A site catalog rendered as JSON — the shape that used to fake a chat widget */
const CATALOG = JSON.stringify([
  { domain: 'hubspot.com', title: 'HubSpot | Software & Tools', href: '/site/hubspot.com' },
  { domain: 'discord.gg', title: 'Discord - Group Chat', href: '/site/discord.gg' },
]);

/** Minimal signals whose only variable is the homepage markup */
function signalsFor(html: string): ScanSignals {
  return {
    domain: DOMAIN,
    fetchedAt: SCANNED_AT,
    scannerVersion: 'scanner-0.2.0',
    robots: { status: 200, body: 'User-agent: *\nAllow: /\n' },
    llms: { status: 404 },
    llmsFull: { status: 404 },
    homepage: { status: 200, body: html },
    sitemap: { status: 404 },
    agentsMd: { status: 404 },
    openapi: { probed: true, found: false },
    apiDocs: { found: false },
    mcp: { probed: true, found: false },
    aiFeatures: detectAiFeatures(html),
  };
}

/** Points the engine gives for the in-site AI features check */
function aiFeaturePoints(html: string): number {
  return scoreAfr(signalsFor(html)).breakdown['l3.site-ai-features'] ?? -1;
}

describe('chat signal — an embedded catalog is not a chat widget', () => {
  it('JSON inside a script tag does not create a chat widget', () => {
    const html = `<html><body><script type="application/json">${CATALOG}</script></body></html>`;
    assert.equal(detectAiFeatures(html).chatWidget, false);
    assert.equal(aiFeaturePoints(html), 0);
  });

  it('JSON-LD does not create a chat widget', () => {
    const html = `<html><head><script type="application/ld+json">{"name":"Discord - Group Chat"}</script></head><body></body></html>`;
    assert.equal(detectAiFeatures(html).chatWidget, false);
    assert.equal(aiFeaturePoints(html), 0);
  });

  it('a JSON catalog parked in a data attribute does not create a chat widget', () => {
    const escaped = CATALOG.replace(/&/g, '&amp;').replace(/"/g, '&#34;');
    const html = `<html><body><div class="sb" data-items="${escaped}"></div></body></html>`;
    assert.equal(detectAiFeatures(html).chatWidget, false);
    assert.equal(aiFeaturePoints(html), 0);
  });

  it('the same words in visible prose do not create a chat widget', () => {
    const html = `<html><body><p>HubSpot | Software &amp; Tools</p><p>Discord - Group Chat</p></body></html>`;
    assert.equal(detectAiFeatures(html).chatWidget, false);
    assert.equal(aiFeaturePoints(html), 0);
  });

  it('a directory that links to other sites does not create a chat widget', () => {
    const html = `<html><body><a href="/site/discord.gg">discord.gg</a><a href="/site/hubspot.com">hubspot.com</a></body></html>`;
    assert.equal(detectAiFeatures(html).chatWidget, false);
  });
});

describe('chat signal — a real chat surface counts', () => {
  it('a chat widget script counts', () => {
    const html = `<html><body><script src="https://embed.tawk.to/abc123/chat.js" async></script></body></html>`;
    assert.equal(detectAiFeatures(html).chatWidget, true);
    assert.equal(aiFeaturePoints(html), 4);
  });

  it('a chat widget script from a known vendor counts', () => {
    const html = `<html><body><script src="https://widget.intercom.io/w.js"></script></body></html>`;
    assert.equal(detectAiFeatures(html).chatWidget, true);
    assert.equal(aiFeaturePoints(html), 4);
  });

  it('an iframe pointing at a chat domain counts', () => {
    const html = `<html><body><iframe src="https://chat.example.com/widget" title="Support chat"></iframe></body></html>`;
    assert.equal(detectAiFeatures(html).chatWidget, true);
    assert.equal(aiFeaturePoints(html), 4);
  });

  it('a chat container element counts', () => {
    assert.equal(detectAiFeatures(`<html><body><div id="chat-widget"></div></body></html>`).chatWidget, true);
    assert.equal(
      detectAiFeatures(`<html><body><div class="intercom-lightweight-app"></div></body></html>`).chatWidget,
      true,
    );
  });

  it('a link to the chat provider domain counts', () => {
    const html = `<html><body><a href="https://intercom.com/help">Contact support</a></body></html>`;
    assert.equal(detectAiFeatures(html).chatWidget, true);
    assert.equal(aiFeaturePoints(html), 4);
  });

  it('the same provider name in prose does not count', () => {
    const html = `<html><body><p>We use Intercom for customer support.</p></body></html>`;
    assert.equal(detectAiFeatures(html).chatWidget, false);
    assert.equal(aiFeaturePoints(html), 0);
  });

  it('the widget booted from inline code counts', () => {
    const html = `<html><body><script>window.intercomSettings = { app_id: "x" }; Intercom('boot', {});</script></body></html>`;
    assert.equal(detectAiFeatures(html).chatWidget, true);
  });
});

describe('AI search signal', () => {
  it('a control that offers AI search counts', () => {
    const html = `<html><body><form action="/search"><input name="q" placeholder="Ask AI anything"></form></body></html>`;
    assert.equal(detectAiFeatures(html).aiSearch, true);
    assert.equal(aiFeaturePoints(html), 2);
  });

  it('visible prose that names the feature counts', () => {
    const html = `<html><body><p>Ask AI about our documentation.</p></body></html>`;
    assert.equal(detectAiFeatures(html).aiSearch, true);
  });

  it('an AI search endpoint counts', () => {
    const html = `<html><body><form action="/api/ai-search"></form></body></html>`;
    assert.equal(detectAiFeatures(html).aiSearch, true);
  });

  it('a catalog payload does not count', () => {
    const html = `<html><body><script type="application/json">[{"title":"AI search tools","href":"/site/x.com"}]</script></body></html>`;
    assert.equal(detectAiFeatures(html).aiSearch, false);
    assert.equal(aiFeaturePoints(html), 0);
  });
});

describe('developer console signal', () => {
  it('a link to a console path counts', () => {
    const html = `<html><body><a href="/console/api-keys">API keys</a></body></html>`;
    assert.equal(detectAiFeatures(html).developerConsole, true);
    assert.equal(aiFeaturePoints(html), 1);
  });

  it('a link to a developers path counts', () => {
    assert.equal(detectAiFeatures(`<html><body><a href="/developers">Developers</a></body></html>`).developerConsole, true);
  });

  it('a catalog payload that carries a console href does not count', () => {
    const html = `<html><body><script type="application/json">[{"name":"API","href":"/console/api-keys"}]</script></body></html>`;
    assert.equal(detectAiFeatures(html).developerConsole, false);
    assert.equal(aiFeaturePoints(html), 0);
  });
});

describe('plain pages', () => {
  it('carry no AI feature signal', () => {
    const html = `<html><head><title>Example</title></head><body><main><h1>Hello</h1><p>Ordinary page.</p></main></body></html>`;
    assert.deepEqual(detectAiFeatures(html), {
      chatWidget: false,
      aiSearch: false,
      developerConsole: false,
    });
    assert.equal(aiFeaturePoints(html), 0);
  });
});
