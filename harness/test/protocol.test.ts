import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Collector, parseLine } from '../lib/protocol.ts';

test('parseLine ignores ordinary output', () => {
  assert.equal(parseLine('hello'), null);
  assert.equal(parseLine(''), null);
});

test('parseLine reads @mfs lines', () => {
  assert.deepEqual(parseLine('@mfs {"metric":"frame_ms","value":1.5}'), { metric: 'frame_ms', value: 1.5 });
});

test('parseLine rejects a broken @mfs line loudly', () => {
  assert.throws(() => parseLine('@mfs {not json'), /bad @mfs line/);
});

test('collector accumulates samples, info and done', () => {
  const c = new Collector();
  c.add({ metric: 'frame_ms', value: 1 });
  c.add({ metric: 'frame_ms', values: [2, 3] });
  c.add({ info: { gpu: 'NVIDIA' } });
  c.add({ done: true });
  const r = c.result();
  assert.deepEqual(r.metrics.frame_ms, [1, 2, 3]);
  assert.equal(r.info.gpu, 'NVIDIA');
  assert.equal(r.done, true);
});

test('a mark becomes <name>_ms measured by the harness clock', () => {
  const c = new Collector();
  c.add({ mark: 'first_frame' }, 12.5);
  assert.deepEqual(c.result().metrics.first_frame_ms, [12.5]);
});

test('a mark without a harness timestamp is an error', () => {
  const c = new Collector();
  assert.throws(() => c.add({ mark: 'first_frame' }), /needs a timestamp/);
});

test('an error event is kept and makes the run failed', () => {
  const c = new Collector();
  c.add({ error: 'no WebGPU adapter' });
  assert.deepEqual(c.result().errors, ['no WebGPU adapter']);
});

test('check events are collected per id', () => {
  const c = new Collector();
  c.add({ check: 'pick-tokyo', pass: true, detail: 'JPN' });
  c.add({ check: 'pick-tokyo', pass: false, detail: 'IDN' });
  assert.deepEqual(c.result().checks['pick-tokyo'], [{ pass: true, detail: 'JPN' }, { pass: false, detail: 'IDN' }]);
});
