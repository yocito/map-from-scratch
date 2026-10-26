// Bake Natural Earth populated places (7,342) for a laptop hover map:
//   land.bin    land rings, Equal Earth, 16-bit, delta-coded, no triangles:
//               u32 nVerts, u32 nRings, u16 dx[nVerts], u16 dy[nVerts],
//               u32 ringLen[nRings]. The renderer fills them with a stencil
//               (even-odd), so neither indices nor holes need shipping.
//   cities.bin  u32 n, u16 dx[n], u16 dy[n], u8 radius*10[n], u8 country[n],
//               u32 pop[n]       (records in draw order, planar)
//   names.bin   UTF-16LE text: country names, a blank line, city names, one
//               per line, cities in the same order as cities.bin
// Positions are differences from the previous value, mod 2^16.
// Draw order: bigger symbols first, so a small city is never hidden under a
// big one. Within one radius class order does not show, so cities are sorted
// there by Morton code: neighbours become neighbours in the file and the
// position deltas shrink for gzip.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { source } from '../../tools/sources.ts';
import { equalEarth, simplify, polygonsOf } from '../../tools/geo.ts';

// The fields of the Natural Earth files this bake reads.
interface LandCollection { features: { geometry: Parameters<typeof polygonsOf>[0] }[] }
interface CountryCollection { features: { properties: { ADM0_A3: string; NAME_JA: string | null } }[] }
interface PlaceCollection {
  features: {
    properties: { ADM0_A3: string; ADM0NAME: string; POP_MAX: number; NAME: string; NAME_JA: string | null };
    geometry: { coordinates: [number, number] };
  }[];
}

const OUT = 'data/baked/07-world-cities-hover';
const X = 2.7066, Y = 1.3174;
// Land is a backdrop: 1.5 px at 4x zoom on a 1280 px wide window (DPR 1).
// Deeper zooms show coarser coasts; the cities stay exact.
const LAND_TOL = (2 * X) / (1280 * 4) * 1.5;
const q = ([x, y]: number[]): [number, number] => [Math.round(((x + X) / (2 * X)) * 65535), Math.round(((Y - y) / (2 * Y)) * 65535)];
const delta16 = (a: number[]): number[] => a.map((v, i) => (v - (i ? a[i - 1] : 0)) & 0xffff);
const gz = (b: Uint8Array): number => gzipSync(b, { level: 9 }).length;
const bytes = (...arrays: ArrayBufferView[]): Buffer => Buffer.concat(arrays.map((a) => Buffer.from(a.buffer, a.byteOffset, a.byteLength)));

// Symbol radius in CSS px: area proportional to population, Tokyo (35.7 M)
// gets R_MAX. Stored as radius * 10 in a byte. Places without a population
// (POP_MAX <= 0) get the minimum.
export const R_MAX = 18, R_MIN = 1.5, POP_MAX = 35676000;
const radius10 = (pop: number): number => Math.round(10 * Math.max(R_MIN, R_MAX * Math.sqrt(Math.max(0, pop) / POP_MAX)));

// --- land
// Countries dissolved into land first: shared borders would otherwise be
// shipped twice (62 KB -> 43 KB gzip at this tolerance).
mkdirSync(OUT, { recursive: true });
const landSrc = `${OUT}/land.geojson`;
if (!existsSync(landSrc)) {
  execFileSync('ogr2ogr', ['-f', 'GeoJSON', landSrc, source('ne-countries'), '-dialect', 'sqlite', '-sql',
    'SELECT ST_Union(ST_MakeValid(geometry)) AS geometry FROM ne_10m_admin_0_countries'], { stdio: 'inherit' });
}
const lx: number[] = [], ly: number[] = [], lens: number[] = [];
for (const f of (JSON.parse(readFileSync(landSrc, 'utf8')) as LandCollection).features) {
  for (const poly of polygonsOf(f.geometry)) {
    for (const r of poly) {
      let g = simplify(r.map(equalEarth), LAND_TOL).map(q);
      g = g.filter((p, i) => i === 0 || p[0] !== g[i - 1][0] || p[1] !== g[i - 1][1]);
      if (g.length < 4) continue;
      g.pop(); // closing point
      lens.push(g.length);
      for (const [x, y] of g) { lx.push(x); ly.push(y); }
    }
  }
}
if (lx.length > 65536) throw new Error(`${lx.length} land vertices do not fit 16-bit indices`);
const land = bytes(Uint32Array.of(lx.length, lens.length), Uint16Array.from(delta16(lx)), Uint16Array.from(delta16(ly)),
  ...(lx.length % 2 ? [new Uint16Array(1)] : []), Uint32Array.from(lens));

// --- cities
const countries = (JSON.parse(readFileSync(source('ne-countries'), 'utf8')) as CountryCollection).features;
const jaCountry = new Map<string, string | null>(countries.map((f) => [f.properties.ADM0_A3, f.properties.NAME_JA]));
// Codes the admin-0 layer does not have.
Object.entries({ SSD: '南スーダン', SJM: 'スヴァールバル諸島およびヤンマイエン島', TKL: 'トケラウ' })
  .forEach(([k, v]) => jaCountry.set(k, v));
const places = (JSON.parse(readFileSync(source('ne-populated-places'), 'utf8')) as PlaceCollection).features;
const cnames: string[] = [], cindex = new Map<string, number>();
const morton = (x: number, y: number): bigint => {
  let m = 0n;
  for (let b = 15; b >= 0; b--) m = (m << 2n) | BigInt(((y >> b) & 1) << 1 | ((x >> b) & 1));
  return m;
};
const cities = places.map((f) => {
  const p = f.properties;
  const country = jaCountry.get(p.ADM0_A3) ?? p.ADM0NAME;
  if (!cindex.has(country)) { cindex.set(country, cnames.length); cnames.push(country); }
  const [x, y] = q(equalEarth(f.geometry.coordinates));
  return { x, y, m: morton(x, y), r: radius10(p.POP_MAX), c: cindex.get(country)!, pop: Math.max(0, p.POP_MAX), name: p.NAME_JA || p.NAME };
});
if (cnames.length > 256) throw new Error(`${cnames.length} countries do not fit a byte`);
cities.sort((a, b) => b.r - a.r || (a.m < b.m ? -1 : a.m > b.m ? 1 : 0));

const n = cities.length;
type City = (typeof cities)[number];
const col = <K extends keyof City>(k: K): City[K][] => cities.map((c) => c[k]);
const cityBin = bytes(Uint32Array.of(n), Uint16Array.from(delta16(col('x'))), Uint16Array.from(delta16(col('y'))),
  Uint8Array.from(col('r')), Uint8Array.from(col('c')), ...(n % 2 ? [new Uint16Array(1)] : []), Uint32Array.from(col('pop')));
const text = `${cnames.join('\n')}\n\n${col('name').join('\n')}`;
if (/\n\n/.test(col('name').join('\n')) || cnames.some((c) => !c)) throw new Error('empty name would break the format');
const names = Buffer.from(text, 'utf16le');

writeFileSync(`${OUT}/land.bin`, land);
writeFileSync(`${OUT}/cities.bin`, cityBin);
writeFileSync(`${OUT}/names.bin`, names);

// Counts to look at: bounding box, radius classes, sizes.
const xs = col('x'), ys = col('y');
console.log(`land: ${lx.length} vertices, ${lens.length} rings, ${land.length} B, gzip ${gz(land)} B`);
console.log(`cities: ${n}, ${cnames.length} countries, x ${Math.min(...xs)}..${Math.max(...xs)}, y ${Math.min(...ys)}..${Math.max(...ys)}, ` +
  `radius classes ${new Set(col('r')).size}, at minimum ${cities.filter((c) => c.r === R_MIN * 10).length}`);
console.log(`cities.bin ${cityBin.length} B, gzip ${gz(cityBin)} B; names.bin ${names.length} B, gzip ${gz(names)} B`);
console.log(`data gzip total ${gz(land) + gz(cityBin) + gz(names)} B`);
