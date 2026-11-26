import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';

const script = readFileSync(new URL('../apps/web/src/utils/owner-email-exchange.js', import.meta.url), 'utf8');
const token = '1234'.repeat(8);
const manageToken = `manage-${'abcd'.repeat(8)}`;
const success = { verified: true, domain: 'example.com', manageToken };

function landing({ action = 'confirm', fragment = `#token=${token}`, send, storage = true } = {}) {
  const calls = [];
  const replacements = [];
  const stored = new Map([['afr-owner-mail-other.example', 'prior-token']]);
  const copied = [];
  const nodes = new Map();
  function element(name) {
    if (!nodes.has(name)) nodes.set(name, {
      hidden: ['redeem', 'result', 'owner-link', 'copy-fallback'].includes(name),
      addEventListener(_, handler) { this.click = handler; },
      focus() { this.focused = true; },
      select() { this.selected = true; },
    });
    return nodes.get(name);
  }
  const prefix = action === 'recover' ? '/zh-CN' : '';
  const pathname = `${prefix}/owner/email/${action}/`;
  runInNewContext(script, {
    document: { querySelector: () => ({
      dataset: {
        action, ownerPath: `${prefix}/owner/`, invalid: 'invalid', working: 'working',
        failed: 'failed', rateLimited: 'rate limited', saved: 'saved', storageUnavailable: 'copy before leaving',
        copied: 'copied', copyManually: 'copy selected text',
      },
      querySelector: (selector) => element(selector.slice(6, -1)),
    }) },
    location: { hash: fragment, pathname, search: '' },
    history: { replaceState: (_, __, url) => replacements.push(url) },
    fetch: (endpoint, options) => {
      calls.push({ endpoint, ...options });
      return send ? send() : Response.json(success);
    },
    localStorage: { setItem: (key, value) => {
      if (!storage) throw new Error('storage blocked');
      stored.set(key, value);
    } },
    navigator: { clipboard: { writeText: async (text) => copied.push(text) } },
  });
  return { calls, replacements, stored, copied, element };
}

for (const action of ['confirm', 'recover']) {
  test(`${action} only exchanges after a user click and saves the matching owner's token`, async () => {
    const { calls, replacements, stored, element } = landing({ action });
    const prefix = action === 'recover' ? '/zh-CN' : '';
    assert.deepEqual(replacements, [`${prefix}/owner/email/${action}/`]);
    assert.equal(calls.length, 0, 'loading the page does not exchange the token');
    const button = element('redeem');
    assert.equal(button.hidden, false);
    await button.click({ isTrusted: false });
    assert.equal(calls.length, 0, 'scripted clicks do not exchange the token');

    await Promise.all([button.click({ isTrusted: true }), button.click({ isTrusted: true })]);
    assert.equal(calls.length, 1, 'double-click while in flight sends one exchange');
    const [request] = calls;
    assert.equal(request.endpoint, `/api/v1/owners/email/${action === 'recover' ? 'recover/' : ''}verify`);
    assert.equal(request.method, 'POST');
    assert.deepEqual(JSON.parse(request.body), { token });
    assert.equal(request.credentials, 'omit');
    assert.equal(request.mode, 'same-origin');
    assert.equal(request.cache, 'no-store');
    assert.equal(request.redirect, 'error');
    assert.equal(request.referrerPolicy, 'no-referrer');
    assert.deepEqual([...stored.entries()], [['afr-owner-mail-other.example', 'prior-token'], ['afr-owner-mail-example.com', manageToken]]);
    assert.equal(element('copy-fallback').hidden, true);
    assert.equal(element('manage-token').value, undefined);
    assert.equal(element('owner-link').href, `${prefix}/owner/example.com/#owner-mailbox-title`);
    await button.click({ isTrusted: true });
    assert.equal(calls.length, 1, 'successful token is cleared from memory');
  });
}

test('offers a clipboard fallback when browser storage is unavailable', async () => {
  const { element, copied, stored } = landing({ action: 'recover', storage: false });
  await element('redeem').click({ isTrusted: true });
  assert.equal(stored.has('afr-owner-mail-example.com'), false);
  assert.equal(element('status').textContent, 'copy before leaving');
  assert.equal(element('copy-fallback').hidden, false);
  assert.equal(element('manage-token').value, manageToken);
  await element('copy').click();
  assert.deepEqual(copied, [manageToken]);
});

test('malformed, expired and rejected responses do not expose either token', async () => {
  const incomplete = landing({ fragment: `#other=${token}` });
  assert.equal(incomplete.element('redeem').hidden, true);
  assert.equal(incomplete.element('status').textContent, 'invalid');
  assert.equal(incomplete.calls.length, 0);

  for (const [response, expected] of [
    [Response.json({ error: 'invalid_or_expired_token', message: token }, { status: 400 }), 'invalid'],
    [Response.json({ error: 'rate_limited', message: token }, { status: 429 }), 'rate limited'],
    [Response.json({ ...success, domain: '../other.example' }), 'failed'],
    [Response.json({ ...success, manageToken: 'arbitrary-data' }), 'failed'],
    [Response.json({ ...success, verified: false }), 'failed'],
    [Response.json({ error: 'internal', message: manageToken }, { status: 503 }), 'failed'],
  ]) {
    const { element, stored } = landing({ send: () => response });
    await element('redeem').click({ isTrusted: true });
    assert.equal(element('status').textContent, expected);
    assert.equal(element('manage-token').value, undefined);
    assert.equal(element('owner-link').hidden, true);
    assert.equal(stored.size, 1);
  }
});
