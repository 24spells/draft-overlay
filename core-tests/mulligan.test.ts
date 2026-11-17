// Parity: the overlay's mulligan features and tree evaluation match the Python that trained the model
// (draft-trainer/scripts/statcast/export_mull.py writes sample hands with Python's answers into each model file).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { mullFeatures, predict, type MullModel } from '../core/mulligan.ts';

const FILE = process.env.MULL_MODEL ?? 'C:/Users/taway/draft-trainer/public/sets/FRA-mull.json';

test('mulligan model: features and win chances match Python', { skip: !existsSync(FILE) }, () => {
  const model = JSON.parse(readFileSync(FILE, 'utf8')) as MullModel & { samples: { hand: number[]; deck: number[]; onPlay: boolean; x: Record<string, number>; keep: number; ship: number }[] };
  assert.ok(model.samples.length > 0);
  for (const s of model.samples) {
    const { x } = mullFeatures(model, s.hand, s.deck, s.onPlay, 0.55);
    for (const [k, v] of Object.entries(s.x)) assert.ok(Math.abs(x[k] - v) < 1e-6, `${k}: ${x[k]} vs ${v}`);
    assert.ok(Math.abs(predict(model.keep, x) - s.keep) < 1e-5, `keep ${predict(model.keep, x)} vs ${s.keep}`);
    assert.ok(Math.abs(predict(model.ship, x) - s.ship) < 1e-5, `ship ${predict(model.ship, x)} vs ${s.ship}`);
  }
});
