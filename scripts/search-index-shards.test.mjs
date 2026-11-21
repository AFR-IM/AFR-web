// scripts/search-index-shards.test.mjs — the shard contract.
//
// The shard key decides which file a site lives in, so it must be a pure
// function of the domain: the same domain always lands in the same shard,
// and a shard only changes when a site of its own letter is added. If the
// key moved, every shard would change bytes on every build and the CDN
// cache would miss for nothing.
//
// The manifest is what the browser reads before it fetches anything, so it
// must describe the shards exactly — and it must not carry a timestamp: the
// build has to be reproducible.
//
// Run: node --test scripts/*.test.mjs

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  SEARCH_SHARD_VERSION,
  assignShards,
  buildShardManifest,
  shardFileFor,
  shardKeyFor,
  validateShardManifest,
} from '../apps/web/scripts/search-index-contract.mjs';

test('the shard key is the first character of the domain', () => {
  assert.equal(shardKeyFor('acme.com'), 'a');
  assert.equal(shardKeyFor('ACME.com'), 'a');
  assert.equal(shardKeyFor('  foo.dev'), 'f');
  assert.equal(shardKeyFor('zzz.io'), 'z');
});

test('a domain that starts with no letter shares the fallback shard', () => {
  assert.equal(shardKeyFor('123.net'), '0');
  assert.equal(shardKeyFor('-weird.example'), '0');
  assert.equal(shardKeyFor(''), '0');
});

test('the shard key is a pure function of the domain', () => {
  const domain = 'example.com';
  assert.equal(shardKeyFor(domain), shardKeyFor(domain));
  // a different domain with the same first letter lands in the same shard
  assert.equal(shardKeyFor('example.org'), shardKeyFor('example.com'));
});

test('the entries keep their order inside a shard', () => {
  const entries = [
    { d: 'a-one.test', s: 90 },
    { d: 'b-two.test', s: 80 },
    { d: 'a-three.test', s: 70 },
  ];
  const shards = assignShards(entries);
  assert.deepEqual(
    shards.get('a').map((e) => e.d),
    ['a-one.test', 'a-three.test'],
  );
  assert.deepEqual(
    shards.get('b').map((e) => e.d),
    ['b-two.test'],
  );
});

test('the shards hold every entry exactly once', () => {
  const entries = Array.from({ length: 50 }, (_, i) => ({
    d: `${String.fromCharCode(97 + (i % 26))}-site-${i}.test`,
    s: 50 + (i % 10),
  }));
  const shards = assignShards(entries);
  const flat = [...shards.values()].flat();
  assert.equal(flat.length, entries.length);
  assert.equal(new Set(flat.map((e) => e.d)).size, entries.length);
});

test('the manifest describes the shards it was built from', () => {
  const entries = [
    { d: 'a-one.test', s: 90 },
    { d: 'b-two.test', s: 80 },
  ];
  const shards = assignShards(entries);
  const manifest = buildShardManifest({
    shards,
    top: entries.slice(0, 1),
    entries: entries.length,
    sizes: { a: { raw: 10, wire: 5 }, b: { raw: 20, wire: 7 } },
    topSize: { raw: 30, wire: 9 },
  });
  assert.equal(manifest.v, SEARCH_SHARD_VERSION);
  assert.equal(manifest.entries, 2);
  assert.equal(manifest.shards.length, 2);
  assert.deepEqual(
    manifest.shards.map((s) => s.id),
    ['a', 'b'],
  );
  assert.equal(manifest.shards[0].file, shardFileFor('a'));
  assert.equal(manifest.shards[0].count, 1);
  assert.equal(manifest.shards[0].raw, 10);
  assert.equal(manifest.shards[0].wire, 5);
  assert.deepEqual(validateShardManifest(manifest), []);
});

test('the manifest carries no timestamp — the build must be reproducible', () => {
  const entries = [{ d: 'a-one.test', s: 90 }];
  const shards = assignShards(entries);
  const sizes = { a: { raw: 10, wire: 5 } };
  const first = buildShardManifest({ shards, top: entries, entries: 1, sizes });
  const second = buildShardManifest({ shards, top: entries, entries: 1, sizes });
  assert.equal(JSON.stringify(first), JSON.stringify(second));
  assert.ok(!/time|date|at\b/i.test(JSON.stringify(first)), 'the manifest must not carry a build time');
});

test('a manifest that disagrees with its shards is rejected', () => {
  const entries = [{ d: 'a-one.test', s: 90 }];
  const shards = assignShards(entries);
  const manifest = buildShardManifest({ shards, top: entries, entries: 1, sizes: { a: { raw: 1, wire: 1 } } });
  manifest.entries = 5;
  assert.match(validateShardManifest(manifest).join('\n'), /hold 1 entries, but the manifest says 5/);
});

test('a manifest with an unknown version is rejected', () => {
  const entries = [{ d: 'a-one.test', s: 90 }];
  const shards = assignShards(entries);
  const manifest = buildShardManifest({ shards, top: entries, entries: 1, sizes: { a: { raw: 1, wire: 1 } } });
  manifest.v = 99;
  assert.match(validateShardManifest(manifest).join('\n'), /version 99 is not/);
});

test('merging the shards gives back the whole list in the same order', () => {
  // The browser merges the shards by score desc, then domain asc. That must
  // reproduce the catalog exactly — otherwise a query would rank the sites
  // differently than the server did.
  const entries = Array.from({ length: 120 }, (_, i) => ({
    d: `${String.fromCharCode(97 + (i % 26))}-site-${i}.test`,
    s: 50 + (i % 7),
  })).sort((a, b) => b.s - a.s || (a.d < b.d ? -1 : a.d > b.d ? 1 : 0));
  const merged = [...assignShards(entries).values()].flat();
  merged.sort((a, b) => b.s - a.s || (a.d < b.d ? -1 : a.d > b.d ? 1 : 0));
  assert.deepEqual(merged, entries);
});
