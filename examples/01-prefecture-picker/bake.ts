// Bake the 47 prefectures into SVG path strings on a 1000-unit grid.
// The browser's own Path2D parser and isPointInPath then do all the work,
// so the renderer ships no geometry code at all.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { source } from '../../tools/sources.ts';
import { simplify } from '../../tools/geo.ts';

type XY = [number, number];
// The fields of the Natural Earth admin-1 file this bake reads.
interface Prefecture {
  properties: { iso_3166_2: string; name: string; name_ja?: string };
  geometry: { type: 'Polygon'; coordinates: XY[][] } | { type: 'MultiPolygon'; coordinates: XY[][][] };
}

const OUT = 'data/baked/01-prefecture-picker';
const GRID = 1000;
const TOLERANCE = 1.2;  // grid units: ~1 px when the map is 1000 px wide
const MIN_AREA = 12;    // grid units²: islands smaller than this are dropped

const fc: { features: Prefecture[] } = JSON.parse(readFileSync(source('ne-japan-prefectures'), 'utf8'));
if (fc.features.length !== 47) throw new Error(`expected 47 prefectures, got ${fc.features.length}`);

// Equirectangular scaled by cos(36°N): within Japan's latitudes the shapes
// stay recognisable, and the projection is two multiplications.
const k = Math.cos((36 * Math.PI) / 180);
const proj = ([lon, lat]: XY): XY => [lon * k, -lat];

const rings: XY[][][] = fc.features.map((f) => {
  const polys = f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates;
  return polys.flatMap((p) => p).map((r) => r.map(proj));
});
// Fit the main islands; drop the far-flung tiny ones (Ogasawara etc.) first so
// they do not stretch the frame.
const area = (r: XY[]): number => Math.abs(r.reduce((a, [x, y], i) => {
  const [x2, y2] = r[(i + 1) % r.length];
  return a + x * y2 - x2 * y;
}, 0)) / 2;
const all = rings.flat();
const big = all.filter((r) => area(r) > 0.02);
const xs = big.flatMap((r) => r.map((p) => p[0])), ys = big.flatMap((r) => r.map((p) => p[1]));
const [minX, maxX, minY, maxY] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
const s = GRID / Math.max(maxX - minX, maxY - minY);
const W = Math.ceil((maxX - minX) * s), H = Math.ceil((maxY - minY) * s);

let kept = 0, dropped = 0;
const out = fc.features.map((f, i) => {
  let d = '';
  for (const r of rings[i]) {
    const g = simplify(r.map(([x, y]): XY => [(x - minX) * s, (y - minY) * s]), TOLERANCE)
      .map(([x, y]): XY => [Math.round(x), Math.round(y)]);
    const inFrame = g.some(([x, y]) => x >= 0 && x <= W && y >= 0 && y <= H);
    if (g.length < 4 || area(g) < MIN_AREA || !inFrame) { dropped++; continue; }
    kept++;
    // Absolute first point, then relative integer steps: short and gzip-friendly.
    d += `M${g[0][0]} ${g[0][1]}l`;
    for (let j = 1; j < g.length; j++) d += `${g[j][0] - g[j - 1][0]} ${g[j][1] - g[j - 1][1]} `;
    d = d.trimEnd() + 'z';
  }
  return [f.properties.iso_3166_2, f.properties.name_ja ?? f.properties.name, d];
});

mkdirSync(OUT, { recursive: true });
const json = JSON.stringify({ w: W, h: H, p: out });
writeFileSync(`${OUT}/prefectures.json`, json);
console.log(`prefectures.json: ${json.length} bytes, ${kept} rings kept, ${dropped} dropped`);
