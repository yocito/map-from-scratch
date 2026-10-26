// Bake Mapterhorn elevation around Mt Fuji (z12 Terrarium WebP, 15.58 m
// cells) into one file read by HTTP Range:
//
//   fuji.terr   header (64 B, little endian)
//                 0 "MFST", 4 version u16 = 1, 6 CS u16 = 128, 8 border u8 = 1,
//                 9 levels u8 = 4, 10 nChunks u16, 12 X0 u32, 16 Y0 u32 (area
//                 origin in global z12 pixels), 20 riceBlock u8, 24 cell f64 (m),
//                 32 lat0 f64, 40 lon0 f64, 48 q0 f32 (m)
//               index, 8 B per chunk in file order: length u16, hmin u16,
//                 hmax u16 (0.25 m units, over the 129x129 vertices), skirt u8
//                 (2 m units), flags u8
//               chunks: L3 (9), L2 (36), L1 (144), L0 (576), Morton order
//                 within a level. Each: u16 base + Rice bit stream of 131x131
//                 samples (terrain.ts encodeChunk).
//
// Level k sample i is the mean of L0 samples [i*2^k, (i+1)*2^k), which is the
// pixel of the original z(12-k) tile (Mapterhorn builds its pyramid by 2x2
// means), quantised to q_k = 0.25 * 2^k m: v = floor(h / q_k + 0.5).
// Border samples come from real data: the 6x6 tiles of the area plus one
// ring of tiles around them (8x8 = 64 z12 tiles).
//
// Also written, for the bench only (not in datasets.outputs):
//   truth.json       chunk statistics, probe neighbourhoods and area
//                    statistics computed by DuckDB from GDAL's XYZ output,
//                    with arithmetic separate from the Node path below
//   orig-costs.json  per bench view: the chunks the selection wants, our
//                    ranges, and the original PMTiles tiles and directories
//                    the same view needs (bytes counted from the real file)
import { mkdirSync, existsSync, writeFileSync, readFileSync, symlinkSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { gunzipSync } from 'node:zlib';
import { PMTiles, deserializeDirectory, zxyToTileId, type Entry } from '../../tools/pmtiles.ts';
import {
  CS, S, LEVELS, N0, HEADER_BYTES, ENTRY_BYTES, FIRST_BYTES, perSide, fileOrder, encodeChunk, decodeChunk, parseTerr,
  makeView, select, ranges, origTile, groundMax,
} from './terrain.ts';
import { VIEWS, TAU } from './views.ts';

const PLANET = '/sata_hdd_24tb/www/html/static/mapterhorn/2026-01-06/planet.pmtiles';
const RAW = 'data/raw/mapterhorn', TILES = `${RAW}/fuji-z12`, OUT = 'data/baked/17-fuji-terrain-3d';
const TX0 = 3624, TY0 = 1614;          // first z12 tile of the area (6x6 tiles)
const PAD = 16, P = N0 + 2 * PAD;      // L0 samples kept around the area (the L3 border needs 9)
const X0 = TX0 * 512, Y0 = TY0 * 512;
const WORLD = 512 * 2 ** 12;
const latOf = (y: number) => (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / WORLD))) * 180) / Math.PI;
const LAT0 = latOf(Y0 + N0 / 2), LON0 = ((X0 + N0 / 2) / WORLD) * 360 - 180;
const CELL = ((2 * Math.PI * 6378137) / WORLD) * Math.cos((LAT0 * Math.PI) / 180);
const W = 1280, H = 800;
const t0 = Date.now();
const log = (...a: unknown[]) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)} s]`, ...a);
const sh = (cmd: string, args: string[]) => execFileSync(cmd, args, { stdio: ['ignore', 'pipe', 'inherit'], maxBuffer: 1 << 26 }).toString();

mkdirSync(TILES, { recursive: true });
mkdirSync(OUT, { recursive: true });

// 1. The original, by Range: 64 z12 tiles. The symlink lets the bench read
//    the same 664 GB file through the local server (orig stage).
if (!existsSync(`${RAW}/planet.pmtiles`)) symlinkSync(PLANET, `${RAW}/planet.pmtiles`);
const pm = new PMTiles(PLANET);
if (pm.header.tileType !== 4 || pm.header.maxZoom !== 12) throw new Error('expected WebP tiles to z12');
let tileBytes = 0;
for (let ty = TY0 - 1; ty <= TY0 + 6; ty++) for (let tx = TX0 - 1; tx <= TX0 + 6; tx++) {
  const f = `${TILES}/${tx}-${ty}.webp`;
  if (!existsSync(f)) writeFileSync(f, pm.tile(12, tx, ty)!);
  tileBytes += readFileSync(f).length;
}
log(`64 z12 tiles, ${tileBytes} B`);

// 2. Decode with GDAL's WEBP driver (libwebp): a VRT mosaic, cut to the area
//    plus PAD, written as raw bytes (BSQ: R plane, G plane, B plane).
const band = (b: number) => `<VRTRasterBand dataType="Byte" band="${b}">` + Array.from({ length: 64 }, (_, n) => {
  const tx = TX0 - 1 + (n % 8), ty = TY0 - 1 + Math.floor(n / 8);
  return `<SimpleSource><SourceFilename relativeToVRT="1">${tx}-${ty}.webp</SourceFilename><SourceBand>${b}</SourceBand>` +
    `<SrcRect xOff="0" yOff="0" xSize="512" ySize="512"/><DstRect xOff="${(n % 8) * 512}" yOff="${Math.floor(n / 8) * 512}" xSize="512" ySize="512"/></SimpleSource>`;
}).join('') + '</VRTRasterBand>';
writeFileSync(`${TILES}/mosaic.vrt`, `<VRTDataset rasterXSize="4096" rasterYSize="4096">${band(1)}${band(2)}${band(3)}</VRTDataset>`);
const SRCWIN = ['-srcwin', String(512 - PAD), String(512 - PAD), String(P), String(P)];
sh('gdal_translate', ['-q', '-of', 'ENVI', ...SRCWIN, `${TILES}/mosaic.vrt`, `${RAW}/fuji-padded.raw`]);
const rgb = readFileSync(`${RAW}/fuji-padded.raw`);
if (rgb.length !== 3 * P * P) throw new Error(`raw size ${rgb.length}`);
const T = new Int32Array(P * P);          // Terrarium integer: h = T / 256 - 32768
for (let i = 0; i < P * P; i++) T[i] = rgb[i] * 65536 + rgb[P * P + i] * 256 + rgb[2 * P * P + i];
log('decoded', P, 'x', P);

// 3. Mean pyramid (exact in doubles: sums of up to 64 integers < 2^24) and
//    quantisation.
const V: Int32Array[] = [];
for (let k = 0; k < LEVELS; k++) {
  const n = P >> k, s = 2 ** k, q = 0.25 * s, v = new Int32Array(n * n);
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) {
    let sum = 0;
    for (let y = 0; y < s; y++) for (let x = 0; x < s; x++) sum += T[(r * s + y) * P + c * s + x];
    v[r * n + c] = Math.floor((sum / (s * s) / 256 - 32768) / q + 0.5);
  }
  V.push(v);
}

// Lowest L0 height within 16 samples of each sample (separable min filter):
// a lower bound of any level's surface near a chunk edge, for the skirts.
const minFilter = (src: Int32Array, rad: number) => {
  const a = new Int32Array(P * P), b = new Int32Array(P * P);
  for (let r = 0; r < P; r++) for (let c = 0; c < P; c++) {
    let m = Infinity;
    for (let x = Math.max(0, c - rad); x <= Math.min(P - 1, c + rad); x++) m = Math.min(m, src[r * P + x]);
    a[r * P + c] = m;
  }
  for (let r = 0; r < P; r++) for (let c = 0; c < P; c++) {
    let m = Infinity;
    for (let y = Math.max(0, r - rad); y <= Math.min(P - 1, r + rad); y++) m = Math.min(m, a[y * P + c]);
    b[r * P + c] = m;
  }
  return b;
};
const lowT = minFilter(T, 16);
log('pyramid and min filter');

// 4. Chunks.
interface Baked { k: number; i: number; j: number; bytes: Uint8Array; hmin: number; hmax: number; skirt: number; stats: number[] }
const order = fileOrder();
const baked: Baked[] = order.map(([k, i, j]) => {
  const n = P >> k, pad = PAD >> k, s = 2 ** k, q = 0.25 * s, v = V[k];
  const smp = new Int32Array(S * S);
  for (let r = 0; r < S; r++) for (let c = 0; c < S; c++) {
    const x = v[(i * CS - 1 + r + pad) * n + j * CS - 1 + c + pad];
    if (x < 0 || x > 65535) throw new Error(`L${k} ${i},${j}: value ${x} outside u16`);
    smp[r * S + c] = x;
  }
  let lo = Infinity, hi = -Infinity, sum = 0, skirt = 0;
  for (let r = 1; r <= CS + 1; r++) for (let c = 1; c <= CS + 1; c++) {
    const x = smp[r * S + c];
    lo = Math.min(lo, x); hi = Math.max(hi, x); sum += x;
    if (r === 1 || c === 1 || r === CS + 1 || c === CS + 1) {
      // vertex (c-1, r-1) at L0 px ((j*128 + c-1 + 0.5) * 2^k): the L0 sample under it
      const px = Math.floor((j * CS + c - 0.5) * s) + PAD, py = Math.floor((i * CS + r - 0.5) * s) + PAD;
      skirt = Math.max(skirt, x * q - (lowT[py * P + px] / 256 - 32768));
    }
  }
  const bytes = encodeChunk(smp);
  if (bytes.length > 65535) throw new Error(`chunk ${k},${i},${j}: ${bytes.length} B does not fit u16`);
  const back = new Uint16Array(S * S);
  decodeChunk(bytes, back);
  for (let t = 0; t < S * S; t++) if (back[t] !== smp[t]) throw new Error(`chunk ${k},${i},${j}: Rice round trip failed at ${t}`);
  const sk = Math.ceil((skirt + 2) / 2);
  if (sk > 255) throw new Error(`chunk ${k},${i},${j}: skirt ${skirt} m too deep for u8`);
  return { k, i, j, bytes, hmin: lo * s, hmax: hi * s, skirt: sk, stats: [lo, hi, sum] };
});

const head = new Uint8Array(HEADER_BYTES + ENTRY_BYTES * baked.length);
const dv = new DataView(head.buffer);
head.set([77, 70, 83, 84]);   // MFST
dv.setUint16(4, 1, true); dv.setUint16(6, CS, true); head[8] = 1; head[9] = LEVELS; dv.setUint16(10, baked.length, true);
dv.setUint32(12, X0, true); dv.setUint32(16, Y0, true); head[20] = 32;
dv.setFloat64(24, CELL, true); dv.setFloat64(32, LAT0, true); dv.setFloat64(40, LON0, true); dv.setFloat32(48, 0.25, true);
baked.forEach((b, c) => {
  const e = HEADER_BYTES + ENTRY_BYTES * c;
  dv.setUint16(e, b.bytes.length, true); dv.setUint16(e + 2, b.hmin, true); dv.setUint16(e + 4, b.hmax, true); head[e + 6] = b.skirt;
});
const file = Buffer.concat([head, ...baked.map((b) => b.bytes)]);
writeFileSync(`${OUT}/fuji.terr`, file);
const terr = parseTerr(file);
const perLevel = [0, 1, 2, 3].map((k) => baked.filter((b) => b.k === k).reduce((a, b) => a + b.bytes.length, 0));
const l3End = terr.chunks[perSide(3) ** 2 - 1].off + terr.chunks[perSide(3) ** 2 - 1].len;
log(`fuji.terr ${file.length} B; per level L0..L3 ${perLevel.join(' / ')} B; header+index ${head.length} B; header..L3 end ${l3End} B (first request ${FIRST_BYTES})`);
log(`skirts (m): max ${Math.max(...baked.map((b) => b.skirt)) * 2}, median ${baked.map((b) => b.skirt * 2).sort((a, b) => a - b)[baked.length >> 1]}`);
log(`cell ${CELL.toFixed(9)} m, centre ${LAT0.toFixed(4)}N ${LON0.toFixed(4)}E`);
if (l3End > FIRST_BYTES) throw new Error('L3 no longer fits the first request');

// 5. The truth, by DuckDB from GDAL's XYZ text (one band per file). Integer
//    pixel keys by floor(): XYZ writes pixel centres (0.5, 1.5, ...) and a
//    cast rounds half to even, which merges neighbours.
const probes: { name: string; c: number; r: number }[] = [];
let summit = 0;
for (let r = 0; r < N0; r++) for (let c = 0; c < N0; c++) if (T[(r + PAD) * P + c + PAD] > T[summit]) summit = (r + PAD) * P + c + PAD;
probes.push({ name: 'summit', c: (summit % P) - PAD, r: Math.floor(summit / P) - PAD });
const lonlat = (lon: number, lat: number) => {
  const x = ((lon + 180) / 360) * WORLD, y = ((1 - Math.log(Math.tan(((lat * Math.PI) / 180)) + 1 / Math.cos((lat * Math.PI) / 180)) / Math.PI) / 2) * WORLD;
  return { c: Math.floor(x - X0), r: Math.floor(y - Y0) };
};
probes.push({ name: 'kawaguchiko', ...lonlat(138.7553, 35.5148) }, { name: 'yamanakako', ...lonlat(138.8710, 35.4170) }, { name: 'hoei-crater', ...lonlat(138.7130, 35.3500) });
let seed = 17;
const rnd = () => (seed = (seed * 48271) % 2147483647) / 2147483647;
for (let n = 0; n < 60; n++) probes.push({ name: `random-${n}`, c: 2 + Math.floor(rnd() * (N0 - 4)), r: 2 + Math.floor(rnd() * (N0 - 4)) });
// and 60 within 6 km of the summit, so the close view has enough of them
for (let n = 0; n < 60; n++) probes.push({ name: `near-${n}`, c: probes[0].c - 400 + Math.floor(rnd() * 800), r: probes[0].r - 400 + Math.floor(rnd() * 800) });
writeFileSync(`${RAW}/probes.csv`, 'id,name,c,r\n' + probes.map((p, i) => `${i},${p.name},${p.c},${p.r}`).join('\n') + '\n');

for (const b of [1, 2, 3]) {
  const f = `${RAW}/band${b}.xyz`;
  if (!existsSync(f)) sh('gdal_translate', ['-q', '-of', 'XYZ', '-b', String(b), ...SRCWIN, `${TILES}/mosaic.vrt`, f]);
}
log('XYZ written');
const q = (b: number) => `CREATE TABLE b${b} AS SELECT floor(x)::INT AS x, floor(y)::INT AS y, v FROM read_csv('${RAW}/band${b}.xyz', delim=' ', header=false, columns={'x':'DOUBLE','y':'DOUBLE','v':'INTEGER'});`;
const lvl = (k: number) => `SELECT ${k} AS k, floor(c / ${2 ** k})::INT AS c, floor(r / ${2 ** k})::INT AS r, floor(avg(h) / ${0.25 * 2 ** k} + 0.5)::INT AS v FROM L0 GROUP BY 2, 3`;
const sql = `
SET memory_limit='1500MB'; SET threads=2; SET preserve_insertion_order=false; SET temp_directory='${RAW}/duckdb.tmp';
${q(1)} ${q(2)} ${q(3)}
CREATE TABLE L0 AS
  WITH o AS (SELECT min(x) AS x0, min(y) AS y0 FROM b1)
  SELECT b1.x - o.x0 - ${PAD} AS c, b1.y - o.y0 - ${PAD} AS r,
         b1.v * 65536 + b2.v * 256 + b3.v AS t, b1.v * 256 + b2.v + b3.v / 256 - 32768 AS h
  FROM b1 JOIN b2 USING (x, y) JOIN b3 USING (x, y), o;
DROP TABLE b1; DROP TABLE b2; DROP TABLE b3;
CREATE TABLE L AS SELECT 0 AS k, c, r, floor(h / 0.25 + 0.5)::INT AS v FROM L0
  UNION ALL ${lvl(1)} UNION ALL ${lvl(2)} UNION ALL ${lvl(3)};
COPY (
  WITH m AS (SELECT k, r, v, unnest(CASE WHEN c % 128 = 0 THEN [c // 128 - 1, c // 128] ELSE [c // 128] END) AS j FROM L
             WHERE c BETWEEN 0 AND 128 * (24 >> k) AND r BETWEEN 0 AND 128 * (24 >> k)),
       m2 AS (SELECT k, j, v, unnest(CASE WHEN r % 128 = 0 THEN [r // 128 - 1, r // 128] ELSE [r // 128] END) AS i FROM m)
  SELECT k, i, j, min(v) AS min, max(v) AS max, sum(v)::BIGINT AS sum, count(*) AS n FROM m2
  WHERE i >= 0 AND j >= 0 AND i < (24 >> k) AND j < (24 >> k) GROUP BY ALL ORDER BY ALL
) TO '${RAW}/truth-chunks.json' (FORMAT json, ARRAY true);
CREATE TABLE P AS SELECT * FROM read_csv('${RAW}/probes.csv', header=true);
CREATE TABLE PN AS SELECT * FROM L0 SEMI JOIN (SELECT p.c + d.dc AS c, p.r + d.dr AS r FROM P p,
  (VALUES (0, 0), (1, 0), (-1, 0), (0, 1), (0, -1)) d(dc, dr)) USING (c, r);
COPY (
  WITH b AS (SELECT p.id, lv.k, floor((p.c + 0.5) / 2 ** lv.k - 0.5)::INT - 1 AS c0, floor((p.r + 0.5) / 2 ** lv.k - 0.5)::INT - 1 AS r0
             FROM P p CROSS JOIN (SELECT unnest([0, 1, 2, 3]) AS k) lv),
       g AS (SELECT b.*, b.c0 + d % 4 AS c, b.r0 + d // 4 AS r FROM b CROSS JOIN (SELECT unnest(range(16)) AS d))
  SELECT g.id, g.k, g.c0, g.r0, list(L.v ORDER BY g.r, g.c) AS v FROM g JOIN L USING (k, c, r) GROUP BY ALL ORDER BY 1, 2
) TO '${RAW}/truth-nb.json' (FORMAT json, ARRAY true);
COPY (
  SELECT p.id, p.name, p.c, p.r, z.t, z.h,
         degrees(atan(sqrt(((e.h - w.h) / ${2 * CELL}) ** 2 + ((n.h - s.h) / ${2 * CELL}) ** 2))) AS slope,
         (degrees(atan2(-(e.h - w.h), -(n.h - s.h))) + 360) % 360 AS aspect
  FROM P p JOIN PN z ON z.c = p.c AND z.r = p.r JOIN PN e ON e.c = p.c + 1 AND e.r = p.r JOIN PN w ON w.c = p.c - 1 AND w.r = p.r
       JOIN PN n ON n.c = p.c AND n.r = p.r - 1 JOIN PN s ON s.c = p.c AND s.r = p.r + 1 ORDER BY p.id
) TO '${RAW}/truth-probes.json' (FORMAT json, ARRAY true);
COPY (
  WITH l2 AS (SELECT c, r, v FROM L WHERE k = 2),
       a AS (SELECT z.c, z.r, z.v AS h, degrees(atan(sqrt(((e.v - w.v) / ${8 * CELL}) ** 2 + ((n.v - s.v) / ${8 * CELL}) ** 2))) AS slope,
                    (degrees(atan2(-(e.v - w.v), -(n.v - s.v))) + 360) % 360 AS aspect
             FROM l2 z JOIN l2 e ON e.c = z.c + 1 AND e.r = z.r JOIN l2 w ON w.c = z.c - 1 AND w.r = z.r
                  JOIN l2 n ON n.c = z.c AND n.r = z.r - 1 JOIN l2 s ON s.c = z.c AND s.r = z.r + 1
             WHERE z.c BETWEEN 1 AND 766 AND z.r BETWEEN 1 AND 766 AND z.v BETWEEN 2000 AND 3000)
  SELECT * FROM (
    SELECT 'nw' AS side, * FROM a WHERE slope >= 20 AND aspect BETWEEN 300 AND 330 ORDER BY hash(c, r) LIMIT 8)
  UNION ALL SELECT * FROM (
    SELECT 'se' AS side, * FROM a WHERE slope >= 20 AND aspect BETWEEN 120 AND 150 ORDER BY hash(c, r) LIMIT 8)
) TO '${RAW}/truth-light.json' (FORMAT json, ARRAY true);
COPY (
  SELECT min(h) AS min, max(h) AS max, avg(h) AS mean, count(*) AS n, arg_max(c, h) AS summit_c, arg_max(r, h) AS summit_r
  FROM L0 WHERE c BETWEEN 0 AND ${N0 - 1} AND r BETWEEN 0 AND ${N0 - 1}
) TO '${RAW}/truth-area.json' (FORMAT json, ARRAY true);
`;
writeFileSync(`${RAW}/truth.sql`, sql);
execFileSync('duckdb', ['-c', `.read ${RAW}/truth.sql`], { stdio: 'inherit' });
log('DuckDB done');
rmSync(`${RAW}/duckdb.tmp`, { recursive: true, force: true });
const rd = (f: string) => JSON.parse(readFileSync(`${RAW}/truth-${f}.json`, 'utf8'));
const tChunks: { k: number; i: number; j: number; min: number; max: number; sum: number; n: number }[] = rd('chunks');
const tNb: { id: number; k: number; c0: number; r0: number; v: number[] }[] = rd('nb');
const tProbes: { id: number; name: string; c: number; r: number; t: number; h: number; slope: number; aspect: number }[] = rd('probes');
const tLight: { side: string; c: number; r: number; h: number; slope: number; aspect: number }[] = rd('light');
const [area] = rd('area');
log(`DuckDB: ${tChunks.length} chunks, ${tProbes.length} probes, ${tLight.length} light probes`, area);

// The two paths must agree exactly, or the bake fails.
if (tChunks.length !== baked.length) throw new Error('truth: chunk count');
for (const c of tChunks) {
  const b = baked.find((x) => x.k === c.k && x.i === c.i && x.j === c.j)!;
  if (c.n !== (CS + 1) ** 2 || b.stats.join() !== [c.min, c.max, c.sum].join()) throw new Error(`truth: chunk ${c.k},${c.i},${c.j} ${b.stats} vs ${c.min},${c.max},${c.sum}`);
}
for (const p of tProbes) if (T[(p.r + PAD) * P + p.c + PAD] !== p.t) throw new Error(`truth: probe ${p.name} raw value`);
for (const nb of tNb) {
  const n = P >> nb.k, pad = PAD >> nb.k;
  nb.v.forEach((x, d) => { if (V[nb.k][(nb.r0 + (d >> 2) + pad) * n + nb.c0 + (d & 3) + pad] !== x) throw new Error(`truth: probe ${nb.id} L${nb.k}`); });
}
if (area.summit_c !== probes[0].c || area.summit_r !== probes[0].r) throw new Error('truth: summit position');
writeFileSync(`${OUT}/truth.json`, JSON.stringify({
  area,
  chunks: tChunks.map((c) => [c.k, c.i, c.j, c.min, c.max, c.sum]),
  probes: tProbes.map((p) => ({ name: p.name, c: p.c, r: p.r, t: p.t, slope: +p.slope.toFixed(2), aspect: +p.aspect.toFixed(1), nb: tNb.filter((x) => x.id === p.id).map(({ k, c0, r0, v }) => ({ k, c0, r0, v })) })),
  light: tLight.map((l) => ({ side: l.side, px: [(l.c + 0.5) * 4, (l.r + 0.5) * 4], h: l.h, slope: +l.slope.toFixed(1), aspect: +l.aspect.toFixed(1) })),
}));
for (const b of [1, 2, 3]) rmSync(`${RAW}/band${b}.xyz`);
log('truth.json: Node and DuckDB agree on all chunks and probes');

// 6. What each bench view costs in both formats. Ours: the first request plus
//    merged ranges. Original: the first 16 KiB (header + root directory), the
//    leaf directories, the tiles.
const rootDir = deserializeDirectory(gunzipSync(pm.read(pm.header.rootOff, pm.header.rootLen)));
const find = (entries: Entry[], id: number) => {
  let lo = 0, hi = entries.length - 1, hit = -1;
  while (lo <= hi) { const mid = (lo + hi) >> 1; if (entries[mid].tileId <= id) { hit = mid; lo = mid + 1; } else hi = mid - 1; }
  return entries[hit];
};
const costs: Record<string, unknown> = {};
for (const [name, cam] of Object.entries(VIEWS)) {
  const v = makeView(cam, W, H, (x, y) => groundMax(terr, x, y));
  const want = select(terr, v, TAU, () => true).want;
  const rest = want.filter((id) => terr.chunks[id].off + terr.chunks[id].len > FIRST_BYTES);
  const rs = ranges(terr, rest);
  const tiles = new Map<string, { z: number; x: number; y: number; offset: number; length: number }>(), leaves = new Map<number, number>();
  for (const id of want) {
    const [z, x, y] = origTile(terr, terr.chunks[id]);
    const tid = zxyToTileId(z, x, y), leaf = find(rootDir, tid);
    if (leaf.runLength !== 0) throw new Error('expected a leaf directory');
    const lOff = pm.header.leafOff + leaf.offset;
    leaves.set(lOff, leaf.length);
    const e = find(deserializeDirectory(gunzipSync(pm.read(lOff, leaf.length))), tid);
    tiles.set(`${z}/${x}/${y}`, { z, x, y, offset: pm.header.dataOff + e.offset, length: e.length });
  }
  // The reader's path on the written file: this view's ranges, cut by offset, decoded.
  const smp = new Uint16Array(S * S);
  for (const r of rs) for (const id of r.ids) {
    const c = terr.chunks[id];
    decodeChunk(file.subarray(c.off, c.off + c.len), smp);
    let lo = Infinity, hi = -Infinity, sum = 0;
    for (let y = 1; y <= CS + 1; y++) for (let x = 1; x <= CS + 1; x++) { const h = smp[y * S + x]; lo = Math.min(lo, h); hi = Math.max(hi, h); sum += h; }
    if ([lo, hi, sum].join() !== baked[id].stats.join() || r.start > c.off || r.end < c.off + c.len) throw new Error(`reader: chunk ${id}`);
  }
  const perK = [0, 1, 2, 3].map((k) => want.filter((id) => terr.chunks[id].k === k).length);
  const tileB = [...tiles.values()].reduce((a, t) => a + t.length, 0), leafB = [...leaves.values()].reduce((a, b) => a + b, 0);
  costs[name] = {
    chunks_per_level: perK,
    ours: { requests: 1 + rs.length, bytes: FIRST_BYTES + rs.reduce((a, r) => a + r.end - r.start, 0) },
    orig: { requests: 1 + leaves.size + tiles.size, bytes: 16384 + leafB + tileB, tile_bytes: tileB, leaf_bytes: leafB, tiles: [...tiles.keys()] },
  };
  log(name, JSON.stringify(costs[name]));
}
writeFileSync(`${OUT}/orig-costs.json`, JSON.stringify(costs, null, 1));
pm.close();
