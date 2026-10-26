import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkBudgets } from '../lib/budget.mjs';

const summaries = {
  frame_ms: { n: 100, p50: 2, p95: 4, max: 9 },
  points_per_s: { n: 10, p50: 5e8 },
};

test('max budget passes and fails on the chosen statistic', () => {
  const [ok] = checkBudgets(summaries, { frame_ms: { stat: 'p95', max: 5 } });
  assert.equal(ok.pass, true);
  assert.equal(ok.actual, 4);
  const [ng] = checkBudgets(summaries, { frame_ms: { stat: 'max', max: 5 } });
  assert.equal(ng.pass, false);
});

test('min budget is for throughput', () => {
  const [r] = checkBudgets(summaries, { points_per_s: { stat: 'p50', min: 1e8 } });
  assert.equal(r.pass, true);
});

test('a budget whose metric was never reported fails', () => {
  const [r] = checkBudgets(summaries, { heap_mb: { stat: 'max', max: 10 } });
  assert.equal(r.pass, false);
  assert.equal(r.actual, null);
  assert.match(r.reason, /not reported/);
});

test('stat defaults to p50', () => {
  const [r] = checkBudgets(summaries, { frame_ms: { max: 3 } });
  assert.equal(r.stat, 'p50');
  assert.equal(r.pass, true);
});

test('checkVerification: every defined check reported in every iteration and passing', async () => {
  const { checkVerification } = await import('../lib/budget.mjs');
  const ok = { a: [{ pass: true }, { pass: true }] };
  assert.deepEqual(checkVerification(['a'], ok, 2), [{ id: 'a', pass: true, reported: 2, failed: 0, detail: undefined }]);
  const [missing] = checkVerification(['b'], ok, 2);
  assert.equal(missing.pass, false);
  assert.match(missing.reason, /not reported/);
  const [short] = checkVerification(['a'], { a: [{ pass: true }] }, 2);
  assert.equal(short.pass, false);
  const [failed] = checkVerification(['a'], { a: [{ pass: true }, { pass: false, detail: 'IDN' }] }, 2);
  assert.equal(failed.pass, false);
  assert.equal(failed.detail, 'IDN');
});
