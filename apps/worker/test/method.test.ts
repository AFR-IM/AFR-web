// test/method.test.ts — GET /api/v1/method machine-readable AFR schema
// (spec v1.0 §14-D shape, checks per §3, weights/thresholds from packages/shared).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { GRADE_THRESHOLDS, LAYER_MAX } from '../../../packages/shared/src/index.ts';
import { LAYER_NAMES } from '../src/method-checks.ts';
import { createApp } from '../src/index.ts';

async function fetchMethod() {
  const app = createApp({});
  const res = await app.request('/api/v1/method');
  assert.equal(res.status, 200);
  return res.json();
}

describe('GET /api/v1/method', () => {
  it('declares standard AFR with a version', async () => {
    const body = await fetchMethod();
    assert.equal(body.standard, 'AFR');
    assert.equal(body.version, '1.1.0');
    assert.equal(body.layers.length, 3);
    assert.equal(body.grades.length, 5);
  });

  it('uses the shared layer weights 35/40/25 and check points that sum to them', async () => {
    const body = await fetchMethod();
    const weights: Record<string, number> = {};
    for (const layer of body.layers) {
      weights[layer.id] = layer.weight;
      const sum = layer.checks.reduce((n: number, c: { points: number }) => n + c.points, 0);
      assert.equal(sum, layer.weight, `${layer.id} checks must sum to its weight`);
      assert.ok(layer.checks.length > 0, `${layer.id} must enumerate checks`);
    }
    assert.deepEqual(weights, { ...LAYER_MAX });
    assert.equal(body.layers[0].name.en, 'Reachable');
    assert.equal(body.layers[0].name.zh, LAYER_NAMES.L1.zh);
    assert.equal(body.layers[1].name.en, 'Legible');
    assert.equal(body.layers[2].name.en, 'Actionable');
  });

  it('enumerates the L1 robots.txt checks per crawler family (spec §3.2)', async () => {
    const body = await fetchMethod();
    const l1 = body.layers.find((l: { id: string }) => l.id === 'L1');
    const familySum = (family: string) =>
      l1.checks
        .filter((c: { family?: string }) => c.family === family)
        .reduce((n: number, c: { points: number }) => n + c.points, 0);
    assert.equal(familySum('search'), 9);
    assert.equal(familySum('mixed'), 6);
    assert.equal(familySum('training'), 10);
    assert.equal(l1.checks.filter((c: { family?: string }) => c.family).length, 13);

    const gptbot = l1.checks.find((c: { id: string }) => c.id === 'A1.gptbot');
    assert.ok(gptbot, 'A1.gptbot check missing (spec §14-D example)');
    assert.equal(gptbot.ua, 'GPTBot');
    assert.equal(gptbot.family, 'training');
    assert.equal(gptbot.points, 3);
  });

  it('emits grade thresholds with the spec §14-D colors', async () => {
    const body = await fetchMethod();
    assert.deepEqual(
      body.grades,
      GRADE_THRESHOLDS.map((t) => ({
        min: t.min,
        grade: t.grade,
        color: { A: '#3ECFAD', B: '#8BD450', C: '#F2C94C', D: '#F2994A', F: '#EB5757' }[t.grade],
      })),
    );
  });
});
