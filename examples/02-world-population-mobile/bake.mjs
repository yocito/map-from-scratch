// Bake Natural Earth countries for a phone choropleth:
//   world.bin       counts, then delta-coded streams (see the layout below)
//   countries.json  [[iso_a3, name_ja, population], ...] indexed by country id
// Coordinates are Equal Earth, so area on screen is area on the ground, which
// is what a choropleth needs. They are quantised to 16 bits over the world's
// bounding box: one step is ~0.3 km, below the simplification tolerance.
//
// Layout (little endian), sized for gzip:
//   u32 nVerts, u32 nTriIdx, u32 nRings
//   u16 x[nVerts], u16 y[nVerts]   each the difference from the previous, mod 2^16
//   u16 country[nVerts]            long runs
//   u32 ringLen[nRings]            borders are each ring's consecutive vertices,
//                                  so no line indices are stored
//   u32 tri[nTriIdx]               difference from the previous index, mod 2^32
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { source } from '../../tools/sources.mjs';
import { equalEarth, simplify, triangulatePolygon, polygonsOf } from '../../tools/geo.mjs';

const OUT = 'data/baked/02-world-population-mobile';
const X = 2.7066, Y = 1.3174;           // Equal Earth extent
const MAX_ZOOM = 32;                     // world width = 32 screens at max zoom
const SCREEN_PX = 390 * 3;               // phone width in device pixels
const TOL = (2 * X) / (SCREEN_PX * MAX_ZOOM) * 1.5;  // 1.5 device px at max zoom

const fc = JSON.parse(readFileSync(source('ne-countries'), 'utf8'));
const q = ([x, y]) => [Math.round(((x + X) / (2 * X)) * 65535), Math.round(((Y - y) / (2 * Y)) * 65535)];

const verts = [], tris = [], ringLens = [], countries = [];
let rawPts = 0;
for (const f of fc.features) {
  const id = countries.length;
  countries.push([f.properties.ADM0_A3, f.properties.NAME_JA ?? f.properties.NAME, f.properties.POP_EST]);
  for (const poly of polygonsOf(f.geometry)) {
    const rings = poly.map((r) => {
      rawPts += r.length;
      return simplify(r.map(equalEarth), TOL).map(q);
    }).filter((r) => r.length >= 4);
    if (rings.length === 0) continue;
    const base = verts.length / 3;
    const { vertices, indices } = triangulatePolygon(rings);
    for (let i = 0; i < vertices.length; i += 2) verts.push(vertices[i], vertices[i + 1], id);
    for (const i of indices) tris.push(base + i);
    for (const r of rings) ringLens.push(r.length - 1); // closing point dropped
  }
}

const nv = verts.length / 3;
const delta16 = (a) => a.map((v, i) => (v - (i ? a[i - 1] : 0)) & 0xffff);
const xs = verts.filter((_, i) => i % 3 === 0), ys = verts.filter((_, i) => i % 3 === 1);
const ids = verts.filter((_, i) => i % 3 === 2);
const triDelta = tris.map((v, i) => (v - (i ? tris[i - 1] : 0)) >>> 0);
const parts = [
  Uint32Array.of(nv, tris.length, ringLens.length),
  Uint16Array.from(delta16(xs)), Uint16Array.from(delta16(ys)), Uint16Array.from(ids),
];
const pad = (nv * 3 * 2) % 4 ? [new Uint16Array(1)] : [];
parts.push(...pad, Uint32Array.from(ringLens), Uint32Array.from(triDelta));
const buf = Buffer.concat(parts.map((p) => Buffer.from(p.buffer)));
if (ringLens.reduce((a, b) => a + b, 0) !== nv) throw new Error('ring lengths do not add up to the vertex count');

mkdirSync(OUT, { recursive: true });
writeFileSync(`${OUT}/world.bin`, buf);
writeFileSync(`${OUT}/countries.json`, JSON.stringify(countries));
console.log(`${countries.length} countries, ${rawPts} source points -> ${nv} vertices, ` +
  `${tris.length / 3} triangles, ${ringLens.length} rings, world.bin ${buf.length} bytes`);
