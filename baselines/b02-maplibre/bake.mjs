// The same countries as example 02, for MapLibre: simplified with the same
// tolerance in the same projection (Equal Earth), but written back as the
// original lon/lat of the points that were kept, as GeoJSON.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { source } from '../../tools/sources.ts';
import { equalEarth, simplify, polygonsOf } from '../../tools/geo.ts';

const OUT = 'data/baked/b02-maplibre';
const X = 2.7066;
const TOL = (2 * X) / (390 * 3 * 32) * 1.5;   // as in examples/02-world-population-mobile/bake.mjs

const fc = JSON.parse(readFileSync(source('ne-countries'), 'utf8'));
let points = 0;
const features = fc.features.map((f) => {
  const polys = polygonsOf(f.geometry).map((poly) => poly
    .map((r) => simplify(r.map((p) => [...equalEarth(p), p[0], p[1]]), TOL).map((p) => [p[2], p[3]]))
    .filter((r) => r.length >= 4));
  const kept = polys.filter((p) => p.length);
  points += kept.flat(2).length;
  return {
    type: 'Feature',
    properties: { code: f.properties.ADM0_A3, name: f.properties.NAME_JA ?? f.properties.NAME, pop: f.properties.POP_EST },
    geometry: { type: 'MultiPolygon', coordinates: kept },
  };
}).filter((f) => f.geometry.coordinates.length);
mkdirSync(OUT, { recursive: true });
const json = JSON.stringify({ type: 'FeatureCollection', features });
writeFileSync(`${OUT}/countries.geojson`, json);
console.log(`${features.length} countries, ${points} points, ${json.length} bytes`);
