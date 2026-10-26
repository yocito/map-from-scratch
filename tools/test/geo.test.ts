import { test } from 'node:test';
import assert from 'node:assert/strict';
import { equalEarth, mercator, simplify, triangulatePolygon, polygonsOf } from '../geo.ts';

const close = (a: number, b: number, eps = 1e-4) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);

test('equal earth: origin, equator edge, pole', () => {
  assert.deepEqual(equalEarth([0, 0]), [0, 0]);
  close(equalEarth([180, 0])[0], 2.70663);
  close(equalEarth([0, 90])[1], 1.31736);
  close(equalEarth([-180, -90])[1], -1.31736);
});

test('mercator maps the world to the unit square, y down', () => {
  assert.deepEqual(mercator([-180, 0]), [0, 0.5]);
  close(mercator([180, 0])[0], 1);
  assert.ok(mercator([0, 60])[1] < 0.5, 'north is up, so smaller y');
});

test('simplify keeps endpoints and drops collinear points', () => {
  const line = [[0, 0], [1, 0.001], [2, 0], [3, 5], [4, 0]];
  assert.deepEqual(simplify(line, 0.01), [[0, 0], [2, 0], [3, 5], [4, 0]]);
  assert.deepEqual(simplify(line, 0), line);
});

test('triangulate a square with a hole', () => {
  const outer = [[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]];
  const hole = [[4, 4], [6, 4], [6, 6], [4, 6], [4, 4]];
  const { vertices, indices } = triangulatePolygon([outer, hole]);
  assert.equal(vertices.length, 16, 'closing points are dropped: 8 vertices');
  assert.equal(indices.length, 8 * 3, 'square with a square hole is 8 triangles');
  let area = 0;
  for (let i = 0; i < indices.length; i += 3) {
    const [a, b, c] = [indices[i], indices[i + 1], indices[i + 2]].map((k) => [vertices[2 * k], vertices[2 * k + 1]]);
    area += Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1])) / 2;
  }
  close(area, 96);
});

test('polygonsOf flattens Polygon and MultiPolygon', () => {
  const p = [[[0, 0], [1, 0], [1, 1], [0, 0]]];
  assert.equal(polygonsOf({ type: 'Polygon', coordinates: p }).length, 1);
  assert.equal(polygonsOf({ type: 'MultiPolygon', coordinates: [p, p] }).length, 2);
  assert.equal(polygonsOf({ type: 'Point', coordinates: [0, 0] }).length, 0);
});

test('clipPolyline keeps what is inside and splits where a line leaves and re-enters', async () => {
  const { clipPolyline } = await import('../geo.ts');
  const box: [number, number, number, number] = [0, 0, 10, 10];
  assert.deepEqual(clipPolyline([[1, 1], [5, 5]], box), [[[1, 1], [5, 5]]]);
  assert.deepEqual(clipPolyline([[-5, 5], [5, 5]], box), [[[0, 5], [5, 5]]]);
  assert.deepEqual(clipPolyline([[20, 20], [30, 30]], box), []);
  // in, out, in again: two pieces
  assert.deepEqual(clipPolyline([[5, 5], [15, 5], [15, 8], [5, 8]], box), [[[5, 5], [10, 5]], [[10, 8], [5, 8]]]);
  // crossing straight through
  assert.deepEqual(clipPolyline([[-10, 5], [20, 5]], box), [[[0, 5], [10, 5]]]);
});
