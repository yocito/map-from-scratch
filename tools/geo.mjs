// Geometry used at bake time. Nothing here ships to a renderer: the point of
// baking is that the renderer receives coordinates already projected,
// simplified and triangulated for exactly the map it draws.
import earcut from '../vendor/earcut/earcut.js';

const RAD = Math.PI / 180;

// Equal Earth (Šavrič, Patterson, Jenny 2018), unit sphere.
// x in [-2.7066, 2.7066], y in [-1.3174, 1.3174], north up.
const A1 = 1.340264, A2 = -0.081106, A3 = 0.000893, A4 = 0.003796;
const M = Math.sqrt(3) / 2;
export function equalEarth([lon, lat]) {
  const t = Math.asin(M * Math.sin(lat * RAD));
  const t2 = t * t, t6 = t2 * t2 * t2;
  const x = (2 * Math.sqrt(3) * lon * RAD * Math.cos(t)) / (3 * (9 * A4 * t6 * t2 + 7 * A3 * t6 + 3 * A2 * t2 + A1));
  const y = t * (A4 * t6 * t2 + A3 * t6 + A2 * t2 + A1);
  return [x + 0, y + 0];
}

// Web Mercator in the unit square: x 0..1 west to east, y 0..1 north to south.
export function mercator([lon, lat]) {
  const s = Math.sin(Math.max(-85.0511, Math.min(85.0511, lat)) * RAD);
  return [lon / 360 + 0.5, 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)];
}

// Douglas–Peucker, iterative. tolerance 0 returns the input.
export function simplify(pts, tolerance) {
  if (tolerance <= 0 || pts.length < 3) return pts;
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  const tol2 = tolerance * tolerance;
  while (stack.length) {
    const [a, b] = stack.pop();
    const [ax, ay] = pts[a], [bx, by] = pts[b];
    const dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy;
    let best = -1, bestD = tol2;
    for (let i = a + 1; i < b; i++) {
      const [px, py] = pts[i];
      let d;
      if (len2 === 0) d = (px - ax) ** 2 + (py - ay) ** 2;
      else {
        const cross = dx * (py - ay) - dy * (px - ax);
        d = (cross * cross) / len2;
      }
      if (d > bestD) { bestD = d; best = i; }
    }
    if (best >= 0) {
      keep[best] = 1;
      stack.push([a, best], [best, b]);
    }
  }
  return pts.filter((_, i) => keep[i]);
}

function openRing(ring) {
  const n = ring.length;
  if (n > 1 && ring[0][0] === ring[n - 1][0] && ring[0][1] === ring[n - 1][1]) return ring.slice(0, -1);
  return ring;
}

// rings: [outer, ...holes] in any planar coordinates (closed or open).
export function triangulatePolygon(rings) {
  const vertices = [];
  const holes = [];
  for (const [i, ring] of rings.entries()) {
    if (i > 0) holes.push(vertices.length / 2);
    for (const [x, y] of openRing(ring)) vertices.push(x, y);
  }
  return { vertices, indices: earcut(vertices, holes) };
}

export function polygonsOf(geometry) {
  if (!geometry) return [];
  if (geometry.type === 'Polygon') return [geometry.coordinates];
  if (geometry.type === 'MultiPolygon') return geometry.coordinates;
  return [];
}
