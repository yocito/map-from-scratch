// Bake for 16: PLATEAU CityGML (zip) around Tokyo Station -> PLB1, one file
// read by HTTP Range (format in plb.ts). Also writes truth.json (DuckDB on
// the same GML, for the bench's checks) and citygml-cost.json (what reading
// the original zips by Range would cost for the same views).
//
//   node examples/16-plateau-buildings-3d/bake.ts
import { openSync, readSync, fstatSync, closeSync, createReadStream, mkdirSync, writeFileSync, writeSync, existsSync, statSync, readFileSync, symlinkSync } from 'node:fs';
import { createInflateRaw, deflateRawSync, inflateRawSync, crc32 } from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TAIL, endRecord, entries, dataStart, meshOf, memberRange, type Entry } from './zip.ts';
import { GmlReader, type Building } from './gml.ts';
import { LAT0, LON0, KX, KY, HALF, TILE, NT, place, hilbert, buildTile, encodeBlock, areaMeshes, type Placed, type TileMesh } from './mesh.ts';
import { MAGIC, VERSION, HEAD, ENTRY, FIRST, GAP, crc32 as plbCrc, parseHeader, decodeBlock } from './plb.ts';
import { VIEWS, frame, type Cam } from './camera.ts';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '../..');
const RAW = join(root, 'data/raw/plateau'), OUT = join(root, 'data/baked/16-plateau-buildings-3d');
const ARCHIVE = 'tokyo-station-2km.v1.plb';
const SRC = '/sata_hdd_24tb/hf_data/plateau-citygml-jp/data/raw';
// PLATEAU 2025 (CityGML v5), PDL1.0 / CC BY 4.0 compatible. Chiyoda first:
// a mesh present in both zips (the same file, same CRC) is read from it.
const ZIPS = [
  { ward: '千代田区', file: `${SRC}/13101_chiyoda-ku/2025/13101_chiyoda-ku_pref_2025_citygml_1_op.zip`, link: 'chiyoda.zip' },
  { ward: '中央区', file: `${SRC}/13102_chuo-ku/2025/13102_chuo-ku_pref_2025_citygml_1_op.zip`, link: 'chuo.zip' },
];
const DEM = 'udx/dem/533946_dem_6697_op.gml';
const GROUND_N = 241;                       // 240 cells of 8.33 m; 241^2 vertices fit u16 indices below the restart index

mkdirSync(join(RAW, 'gml'), { recursive: true });
mkdirSync(OUT, { recursive: true });
const t0 = performance.now();
const ms = (t: number) => Math.round(performance.now() - t);

// --- 1. The zips' directories --------------------------------------------
interface Zip { ward: string; file: string; link: string; size: number; cd: [number, number]; list: Entry[] }
const read = (file: string, a: number, n: number): Uint8Array => {
  const fd = openSync(file, 'r'), b = new Uint8Array(n);
  try { readSync(fd, b, 0, n, a); } finally { closeSync(fd); }
  return b;
};
const zips: Zip[] = ZIPS.map((z) => {
  const fd = openSync(z.file, 'r'), size = fstatSync(fd).size;
  closeSync(fd);
  const end = endRecord(read(z.file, size - TAIL, TAIL), size);
  const list = entries(read(z.file, end.cdOff, end.cdLen));
  if (list.length !== end.count) throw new Error(`${z.file}: ${list.length} entries, directory says ${end.count}`);
  // The page's ?citygml=1 mode reads the original zips through these links.
  const link = join(RAW, z.link);
  if (!existsSync(link)) symlinkSync(z.file, link);
  return { ...z, size, cd: [end.cdOff, end.cdLen], list };
});

const meshes = areaMeshes();
const members = meshes.map((mesh) => {
  for (const z of zips) {
    const e = z.list.find((x) => meshOf(x.name) === mesh);
    if (e) return { mesh, zip: z, e };
  }
  throw new Error(`mesh ${mesh}: in neither zip`);
});
console.log(`meshes ${members.map((m) => `${m.mesh}(${m.zip.link})`).join(' ')}`);

// --- 2. Inflate (CRC checked) and parse ----------------------------------
async function stream(z: Zip, e: Entry, onText: (s: string) => void, save?: string): Promise<{ inflateParseMs: number }> {
  const t = performance.now();
  const start = e.headerOff + dataStart(read(z.file, e.headerOff, 30 + 65535 * 2));
  const src = createReadStream(z.file, { start, end: start + e.compSize - 1, highWaterMark: 1 << 20 }).pipe(createInflateRaw({ chunkSize: 1 << 20 }));
  const dec = new TextDecoder();
  const out = save && !(existsSync(save) && statSync(save).size === e.size) ? openSync(save + '.part', 'w') : null;
  let crc = 0, n = 0;
  for await (const chunk of src as AsyncIterable<Buffer>) {
    crc = crc32(chunk, crc);
    n += chunk.length;
    if (out !== null) writeSync(out, chunk);
    onText(dec.decode(chunk, { stream: true }));
  }
  onText(dec.decode());
  if (out !== null) { closeSync(out); execFileSync('mv', [save + '.part', save!]); }
  if (crc >>> 0 !== e.crc || n !== e.size) throw new Error(`${e.name}: CRC or size mismatch`);
  return { inflateParseMs: ms(t) };
}

const placed: (Placed & { mesh: string })[] = [];
const posLists: Record<string, number> = {}, parseMs: Record<string, number> = {};
let seen = 0;
for (const m of members) {
  const reader = new GmlReader((b: Building) => {
    seen++;
    const p = place(b);
    if (p) placed.push({ ...p, mesh: m.mesh });
  });
  const r = await stream(m.zip, m.e, (s) => reader.push(s), join(RAW, 'gml', `${m.mesh}.gml`));
  reader.end();
  posLists[m.mesh] = reader.posLists;
  parseMs[m.mesh] = r.inflateParseMs;
  console.log(`${m.mesh}: ${(m.e.size / 1e6).toFixed(0)} MB, ${reader.posLists} posLists, ${r.inflateParseMs} ms`);
}
console.log(`buildings: ${seen} read, ${placed.length} in the area (${placed.filter((p) => !p.b.lod2.length).length} LOD1 only)`);

// --- 3. Ground: both wards' DEM TINs burnt into a grid --------------------
// Grid point (c, r) is at (-HALF + c*step, -HALF + r*step). For each TIN
// triangle, the grid points in its bounding box are interpolated with
// barycentric weights (ortho-earth qmesh.ts qmBake does the same).
const step = (2 * HALF) / (GROUND_N - 1), grid = new Float64Array(GROUND_N * GROUND_N).fill(NaN);
let demTris = 0;
for (const z of zips) {
  const e = z.list.find((x) => x.name === DEM);
  if (!e) continue;
  const reader = new GmlReader(undefined, (p) => {
    demTris++;
    const X = [0, 1, 2].map((i) => (p[3 * i + 1] - LON0) * KX), Y = [0, 1, 2].map((i) => (p[3 * i] - LAT0) * KY), Z = [p[2], p[5], p[8]];
    const det = (Y[1] - Y[2]) * (X[0] - X[2]) + (X[2] - X[1]) * (Y[0] - Y[2]);
    if (Math.abs(det) < 1e-12) return;
    const c0 = Math.max(0, Math.ceil((Math.min(...X) + HALF) / step - 1e-9)), c1 = Math.min(GROUND_N - 1, Math.floor((Math.max(...X) + HALF) / step + 1e-9));
    const r0 = Math.max(0, Math.ceil((Math.min(...Y) + HALF) / step - 1e-9)), r1 = Math.min(GROUND_N - 1, Math.floor((Math.max(...Y) + HALF) / step + 1e-9));
    for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) {
      const px = -HALF + c * step, py = -HALF + r * step;
      const l0 = ((Y[1] - Y[2]) * (px - X[2]) + (X[2] - X[1]) * (py - Y[2])) / det, l1 = ((Y[2] - Y[0]) * (px - X[2]) + (X[0] - X[2]) * (py - Y[2])) / det, l2 = 1 - l0 - l1;
      if (l0 < -1e-9 || l1 < -1e-9 || l2 < -1e-9) continue;
      grid[r * GROUND_N + c] = l0 * Z[0] + l1 * Z[1] + l2 * Z[2];
    }
  });
  const r = await stream(z, e, (s) => reader.push(s));
  reader.end();
  console.log(`DEM ${z.link}: ${r.inflateParseMs} ms`);
}
// Points no TIN covers (outside both wards) take the mean of their filled
// neighbours, repeated until none is left.
let missing = 0;
for (let i = 0; i < grid.length; i++) if (Number.isNaN(grid[i])) missing++;
for (let left = missing; left > 0;) {
  const next = grid.slice();
  left = 0;
  for (let r = 0; r < GROUND_N; r++) for (let c = 0; c < GROUND_N; c++) {
    const i = r * GROUND_N + c;
    if (!Number.isNaN(grid[i])) continue;
    let s = 0, n = 0;
    for (const [dr, dc] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
      const rr = r + dr, cc = c + dc;
      if (rr >= 0 && rr < GROUND_N && cc >= 0 && cc < GROUND_N && !Number.isNaN(grid[rr * GROUND_N + cc])) { s += grid[rr * GROUND_N + cc]; n++; }
    }
    if (n) next[i] = s / n; else left++;
  }
  grid.set(next);
}
const gmin = grid.reduce((a, b) => Math.min(a, b), Infinity), gmax = grid.reduce((a, b) => Math.max(a, b), -Infinity);
const gz0 = Math.floor(gmin * 100);
const gq = new Uint8Array(2 * grid.length), gdv = new DataView(gq.buffer);
for (let i = 0, prev = 0; i < grid.length; i++) {
  const v = Math.round(grid[i] * 100) - gz0, d = ((v - prev) << 16) >> 16;
  gdv.setUint16(2 * i, ((d << 1) ^ (d >> 31)) & 0xffff, true);
  prev = v;
}
const groundHead = new Uint8Array(8);
new DataView(groundHead.buffer).setUint32(0, GROUND_N, true);
new DataView(groundHead.buffer).setInt32(4, gz0, true);
const ground = Buffer.concat([groundHead, deflateRawSync(gq, { level: 9 })]);
console.log(`ground: ${GROUND_N}^2, ${demTris} TIN triangles, ${missing} points filled from neighbours, z ${gmin.toFixed(2)}..${gmax.toFixed(2)} m, ${ground.length} B`);

// --- 4. Tiles and blocks ----------------------------------------------------
const byTile = new Map<number, (Placed & { mesh: string })[]>();
for (const p of placed) byTile.set(p.tile, [...(byTile.get(p.tile) ?? []), p]);
const order = [...byTile.keys()].sort((a, b) => hilbert(a % NT, Math.floor(a / NT)) - hilbert(b % NT, Math.floor(b / NT)));
const tm = performance.now();
const tiles: TileMesh[] = order.map((t) => buildTile(t, byTile.get(t)!));
const triMs = ms(tm);
const blocks = tiles.map((t) => t.levels.map((l) => (l.idx.length ? deflateRawSync(encodeBlock(l), { level: 9 }) : Buffer.alloc(0))));

// --- 5. Write the archive ---------------------------------------------------
const indexLen = tiles.length * ENTRY, groundOff = HEAD + indexLen, l0Off = groundOff + ground.length;
const l0Len = blocks.reduce((s, b) => s + b[0].length, 0), l1Off = l0Off + l0Len, l1Len = blocks.reduce((s, b) => s + b[1].length, 0);
const file = Buffer.alloc(l1Off + l1Len), dv = new DataView(file.buffer, file.byteOffset, file.byteLength);
let off = [l0Off, l1Off];
tiles.forEach((t, i) => {
  const o = HEAD + i * ENTRY;
  file[o] = t.tile % NT; file[o + 1] = Math.floor(t.tile / NT);
  dv.setUint16(o + 2, t.buildings, true);
  for (let k = 0; k < 3; k++) { dv.setInt32(o + 4 + 4 * k, t.min[k], true); dv.setUint16(o + 16 + 2 * k, t.size[k], true); }
  dv.setUint16(o + 22, t.levels[0].tiny + t.levels[1].tiny, true);
  t.levels.forEach((l, li) => {
    const p = o + 24 + 16 * li, b = blocks[i][li];
    if (l.dropped < 0 || l.dropped > 65535) throw new Error(`tile ${t.tile}: dropped ${l.dropped}`);
    dv.setUint32(p, off[li], true); dv.setUint32(p + 4, b.length, true); dv.setUint32(p + 8, l.idx.length, true);
    dv.setUint16(p + 12, l.nv, true); dv.setUint16(p + 14, l.dropped, true);
    b.copy(file, off[li]);
    off[li] += b.length;
  });
});
file.set(ground, groundOff);
dv.setUint32(0, MAGIC, true); dv.setUint32(4, VERSION, true); dv.setUint32(8, tiles.length, true);
dv.setUint16(12, NT, true); dv.setUint16(14, NT, true);
[TILE, LAT0, LON0, KX, KY, HALF].forEach((v, k) => dv.setFloat64(16 + 8 * k, v, true));
[HEAD, indexLen, groundOff, ground.length, l0Off, l0Len, l1Off, l1Len].forEach((v, k) => dv.setUint32(64 + 4 * k, v, true));
dv.setUint32(96, plbCrc(file.subarray(HEAD, HEAD + indexLen)), true);
writeFileSync(join(OUT, ARCHIVE), file);

// Read it back the way the page does and compare every block.
const h = parseHeader(file);
h.tiles.forEach((t, i) => t.lv.forEach((l, li) => {
  if (!l.len) return;
  const m = decodeBlock(inflateRawSync(file.subarray(l.off, l.off + l.len)));
  const src = tiles[i].levels[li];
  if (m.nv !== src.nv || m.q.some((v, k) => v !== src.q[k]) || m.idx.some((v, k) => v !== src.idx[k])) throw new Error(`tile ${t.tx},${t.ty} level ${li}: round trip differs`);
}));

const sum = (f: (l: TileMesh['levels'][number]) => number, li: number) => tiles.reduce((s, t) => s + f(t.levels[li]), 0);
const stats = {
  tiles: tiles.length, buildings: placed.length,
  vertices: [sum((l) => l.nv, 0), sum((l) => l.nv, 1)], triangles: [sum((l) => l.idx.length / 3, 0), sum((l) => l.idx.length / 3, 1)],
  dropped: [sum((l) => l.dropped, 0), sum((l) => l.dropped, 1)], dropped_in_tiny_polygons: [sum((l) => l.tiny, 0), sum((l) => l.tiny, 1)], bytes: { head_index_ground: l0Off, l0: l0Len, l1: l1Len, total: file.length },
  largest_block: Math.max(...blocks.flat().map((b) => b.length)), max_block_vertices: Math.max(...tiles.flatMap((t) => t.levels.map((l) => l.nv))),
};
console.log(JSON.stringify(stats));
// The design's prototype (fan triangulation, same welding): L0 1.15 MB,
// L1 2.74 MB, 513k vertices, 934k triangles. Far from it means a bake bug.
const off5 = (a: number, b: number) => Math.abs(a / b - 1) > 0.05;
if (off5(l0Len, 1.15e6) || off5(l1Len, 2.74e6) || off5(stats.vertices[0] + stats.vertices[1], 513e3) || off5(stats.triangles[0] + stats.triangles[1] + stats.dropped[0] + stats.dropped[1], 934e3)) {
  console.log('WARNING: more than 5% away from the prototype; look at the bake before trusting the numbers');
}

// --- 6. Truth from DuckDB (truth.sql), per GML file -------------------------
const truthDir = join(RAW, 'truth');
mkdirSync(truthDir, { recursive: true });
const rows: Record<string, string>[] = [];
const sqlChecks: Record<string, string> = {};
const tt = performance.now();
for (const m of members) {
  const csv = join(truthDir, `${m.mesh}.csv`);
  const vars = { f: join(RAW, 'gml', `${m.mesh}.gml`), out: csv, mesh: m.mesh };
  const sql = Object.entries(vars).map(([k, v]) => `SET VARIABLE ${k} = '${v}';`).join('\n') + '\n'
    + Object.entries({ lat0: LAT0, lon0: LON0, kx: KX, ky: KY, half: HALF, tile: TILE }).map(([k, v]) => `SET VARIABLE ${k} = ${v.toPrecision(17)}::double;`).join('\n') + '\n'
    + readFileSync(join(here, 'truth.sql'), 'utf8');
  const out = execFileSync('duckdb', ['-csv'], { input: sql, encoding: 'utf8', maxBuffer: 1 << 26 });
  const [open, close, both] = out.trim().split('\n')[1].split(',').map(Number);
  if (open !== close || open !== both || open !== posLists[m.mesh]) throw new Error(`${m.mesh}: posList lines ${open}/${close}/${both}, reader saw ${posLists[m.mesh]}`);
  sqlChecks[m.mesh] = `${open} posList lines`;
  const [head, ...lines] = readFileSync(csv, 'utf8').trim().split('\n');
  const keys = head.split(',');
  for (const line of lines) if (line) rows.push(Object.fromEntries(line.split(',').map((v, k) => [keys[k], v])));
}
console.log(`truth: ${rows.length} buildings from DuckDB in ${ms(tt)} ms`);
{
  const mine = new Map(placed.map((p) => [p.b.id, p])), theirs = new Map(rows.map((r) => [r.id, r]));
  for (const [id, p] of mine) if (!theirs.has(id)) console.log(`only in the bake: ${id} ${p.x} ${p.y}`);
  for (const [id, r] of theirs) if (!mine.has(id)) console.log(`only in truth.sql: ${id} ${r.x} ${r.y} (mesh ${r.mesh})`);
}

// Per tile: buildings, triangle formula per level, extent of every drawn point.
const truthTiles: Record<string, { buildings: number; tri: number[]; min: number[]; max: number[] }> = {};
for (const r of rows) {
  const k = `${r.tx},${r.ty}`;
  const t = truthTiles[k] ??= { buildings: 0, tri: [0, 0], min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
  t.buildings++;
  t.tri[0] += +r.tri0; t.tri[1] += +r.tri1;
  ['minx', 'miny', 'minz'].forEach((f, i) => { t.min[i] = Math.min(t.min[i], +r[f]); });
  ['maxx', 'maxy', 'maxz'].forEach((f, i) => { t.max[i] = Math.max(t.max[i], +r[f]); });
}
const tallest = rows.reduce((a, b) => (+b.maxz > +a.maxz ? b : a));

// Two large south-facing walls in different tiles, for the lighting check:
// vertical quads whose Newell normal is within 2.5 degrees of south.
const walls: { tile: number; id: string; c: number[]; n: number[]; area: number; w: number; hgt: number }[] = [];
for (const p of placed) {
  if (!p.b.lod2.length) continue;
  for (const poly of p.b.lod2) {
    const r = poly[0], n = r.length / 3 - 1;
    if (poly.length !== 1 || n !== 4) continue;
    const P = Array.from({ length: n }, (_, i) => [(r[3 * i + 1] - LON0) * KX, (r[3 * i] - LAT0) * KY, r[3 * i + 2]]);
    let nx = 0, ny = 0, nz = 0;
    for (let i = 0; i < n; i++) {
      const a = P[i], b = P[(i + 1) % n];
      nx += (a[1] - b[1]) * (a[2] + b[2]); ny += (a[2] - b[2]) * (a[0] + b[0]); nz += (a[0] - b[0]) * (a[1] + b[1]);
    }
    const len = Math.hypot(nx, ny, nz), area = len / 2;
    if (area < 300 || ny / len > -0.999) continue;
    const xs = P.map((q) => q[0]), zs = P.map((q) => q[2]);
    walls.push({ tile: p.tile, id: p.b.id, c: [0, 1, 2].map((k) => P.reduce((s, q) => s + q[k], 0) / n), n: [nx / len, ny / len, nz / len], area, w: Math.max(...xs) - Math.min(...xs), hgt: Math.max(...zs) - Math.min(...zs) });
  }
}
walls.sort((a, b) => b.area - a.area);
let pair: typeof walls = [];
for (let i = 0; i < Math.min(walls.length, 40) && !pair.length; i++) {
  const j = walls.findIndex((w, k) => k > i && w.tile !== walls[i].tile && Math.abs(w.n[0] - walls[i].n[0]) < 0.01);
  if (j > 0) pair = [walls[i], walls[j]];
}

const v3 = rows.find((r) => r.id === 'bldg_6af58cef-669e-4aca-bc01-355e870d1ad5');   // Tokyo Station Marunouchi building
const truth = {
  source: 'DuckDB 1.5.5 on the GML lines (truth.sql); walls and views from the bake',
  buildings: rows.length,
  tiles: truthTiles,
  tallest: { id: tallest.id, x: +tallest.x, y: +tallest.y, maxz: +tallest.maxz },
  points: rows.filter((r) => r.px !== '').map((r) => [+(+r.px).toFixed(2), +(+r.py).toFixed(2), Math.round(+r.area)]),
  station: v3 && { id: v3.id, x: +v3.px, y: +v3.py },
  walls: pair,
  sql_checks: sqlChecks,
};
writeFileSync(join(OUT, 'truth.json'), JSON.stringify(truth));
console.log(`truth.json: ${rows.length} buildings, tallest ${tallest.id} ${tallest.maxz} m, station point ${v3?.px},${v3?.py}, walls ${pair.map((w) => `${w.id}@${w.tile} ${w.area.toFixed(0)} m2`).join(' / ')}`);

// --- 7. What reading the original zips by Range costs for the same views ---
// The same frame() as the page, at its canvas; a view needs a mesh when one
// of its buildings is in a visible tile. Per zip: the 64 KiB tail and the
// central directory, then one request per member (header + deflate body).
const boxes = [{ lo: [-HALF, -HALF, gz0 / 100], hi: [HALF, HALF, gmax] }, ...h.tiles.map((t) => ({
  lo: t.min.map((v) => v / 100), hi: t.min.map((v, k) => (v + t.size[k]) / 100),
}))];
const meshOfTile = new Map<number, Set<string>>();
for (const p of placed) { if (!meshOfTile.has(p.tile)) meshOfTile.set(p.tile, new Set()); meshOfTile.get(p.tile)!.add(p.mesh); }
const views: Record<string, Cam> = { ...VIEWS };
for (const yaw of [0, 90, 180, 270]) views[`orbit${yaw}`] = { x: 0, y: 0, z: 20, yaw, pitch: 35, dist: 800 };
const NET = { latency_ms: 20, bytes_per_ms: 50e6 / 8 / 1000 };
const cost: Record<string, unknown> = {};
for (const [name, cam] of Object.entries(views)) {
  const f = frame(cam, 1280 / 800, boxes);
  const vis = f.visible.map((i) => h.tiles[i]);
  const need = new Set<string>();
  for (const t of vis) for (const m of meshOfTile.get(t.ty * NT + t.tx) ?? []) need.add(m);
  const used = members.filter((m) => need.has(m.mesh));
  const zipsUsed = [...new Set(used.map((m) => m.zip))];
  const memberBytes = used.reduce((s, m) => { const [a, b] = memberRange(m.e); return s + (b - a); }, 0);
  const bytes = zipsUsed.reduce((s, z) => s + TAIL + z.cd[1], 0) + memberBytes;
  const requests = zipsUsed.length * 2 + used.length;
  // PLB for the same view: first read, then each level's blocks merged by the GAP rule.
  const runs = (li: number) => {
    const ls = vis.map((t) => t.lv[li]).filter((l) => l.len).sort((a, b) => a.off - b.off);
    let n = 0, end = -Infinity, b = 0;
    for (const l of ls) { if (l.off - end >= GAP) n++; b += l.len; end = l.off + l.len; }
    return { requests: n, bytes: b };
  };
  const r0 = runs(0), r1 = runs(1);
  cost[name] = {
    visible_tiles: vis.length, meshes: [...need].sort(), zips: zipsUsed.map((z) => z.link),
    citygml: { range_bytes: bytes, range_requests: requests, xml_bytes: used.reduce((s, m) => s + m.e.size, 0), transfer_model_ms: Math.round(requests * NET.latency_ms + bytes / NET.bytes_per_ms), node_inflate_parse_ms: used.reduce((s, m) => s + parseMs[m.mesh], 0) },
    plb: { range_bytes: FIRST + r0.bytes + r1.bytes, range_requests: 1 + r0.requests + r1.requests, l0_bytes: r0.bytes, l1_bytes: r1.bytes, triangles: vis.reduce((s, t) => s + (t.lv[0].ni + t.lv[1].ni) / 3, 0) },
  };
}
cost.node_triangulate_weld_ms_all_tiles = triMs;
cost.central_directory_bytes = Object.fromEntries(zips.map((z) => [z.link, z.cd[1]]));
writeFileSync(join(RAW, 'citygml-cost.json'), JSON.stringify(cost, null, 1));
// The page's ?citygml=1 mode and its bench need these too (local only, not published).
writeFileSync(join(OUT, 'citygml-cost.json'), JSON.stringify(cost));
for (const [k, v] of Object.entries(cost)) if (typeof v === 'object' && v && 'citygml' in v) {
  const c = v as { visible_tiles: number; citygml: { range_bytes: number; range_requests: number; transfer_model_ms: number }; plb: { range_bytes: number; range_requests: number } };
  console.log(`${k}: ${c.visible_tiles} tiles; CityGML ${(c.citygml.range_bytes / 1e6).toFixed(1)} MB / ${c.citygml.range_requests} req / ${c.citygml.transfer_model_ms} ms; PLB ${(c.plb.range_bytes / 1e6).toFixed(2)} MB / ${c.plb.range_requests} req`);
}
console.log(`done in ${ms(t0)} ms`);
