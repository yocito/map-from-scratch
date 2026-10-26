import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summarize, percentile } from '../lib/stats.mjs';

test('percentile uses nearest-rank on sorted copy', () => {
  const v = [5, 1, 4, 2, 3];
  assert.equal(percentile(v, 50), 3);
  assert.equal(percentile(v, 100), 5);
  assert.equal(percentile(v, 0), 1);
  assert.deepEqual(v, [5, 1, 4, 2, 3], 'input must not be mutated');
});

test('p95 of 1..100 is 95', () => {
  const v = Array.from({ length: 100 }, (_, i) => i + 1);
  assert.equal(percentile(v, 95), 95);
});

test('summarize reports the usual statistics', () => {
  const s = summarize([2, 4, 4, 4, 5, 5, 7, 9]);
  assert.equal(s.n, 8);
  assert.equal(s.min, 2);
  assert.equal(s.max, 9);
  assert.equal(s.mean, 5);
  assert.equal(s.stdev, 2);
  assert.equal(s.p50, 4);
});

test('summarize of nothing is n=0, not zeros', () => {
  const s = summarize([]);
  assert.equal(s.n, 0);
  assert.equal(s.p50, null);
  assert.equal(s.mean, null);
});
