// Bake the access map to Grand Cinema Sunshine (in Grandscape Ikebukuro):
// a fixed, north-up, 1,000 x 1,000 unit frame around the walk from the east
// exit of Ikebukuro station, cut from the OSM Tokyo 23 wards GeoParquet by
// HTTP Range (only the row groups whose bbox statistics touch the frame).
// Everything the page needs is decided here: layers as one SVG path string
// each, the walking route (shortest path on the OSM footway and street
// graph), the labels with their positions after collision, and the written
// directions. The renderer only hands strings to Path2D and fillText.
import { mkdirSync, writeFileSync } from 'node:fs';
import { rangedSource } from '../../tools/sources.ts';
import { readFooter, readColumns, statDouble, type Value } from '../../tools/parquet.ts';
import { simplify, clipPolyline, type Box } from '../../tools/geo.ts';

type XY = [number, number];
const OUT = 'data/baked/26-ikebukuro-cinema-access';

// The frame: 700 m square (ground metres), centred between the station's
// east exit and the cinema. A 1,040 m frame (v1) left the 460 m walk as a
// thin band across the middle with the cinema building 17 px wide on a phone.
const CENTER: XY = [139.7143, 35.7305];
const SIZE_M = 700;
const GRID = 1000;
const START_NODE = 6225721271;    // railway=train_station_entrance, name:ja 東口(中央)
const DEST_BUILDING = 705716220;  // グランドスケープ池袋, which houses the cinema
const DEST_NODE = 1316303078;     // amenity=cinema "grand cinema sunshine"
const WALK_M_PER_MIN = 80;        // the Japanese real-estate convention (公正競争規約)

// EPSG:3857 metres -> grid units, y down. Mercator stretches ground distance
// by 1/cos(lat); over 1 km the change of that factor is 0.01%, so one scale.
const R = 6378137, cosLat = Math.cos((CENTER[1] * Math.PI) / 180);
const mx = (lon: number) => (lon * Math.PI / 180) * R;
const my = (lat: number) => R * Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360));
const half = SIZE_M / 2 / cosLat;
const X0 = mx(CENTER[0]) - half, Y1 = my(CENTER[1]) + half;
const S = GRID / (2 * half);
const grid = ([x, y]: XY): XY => [(x - X0) * S, (Y1 - y) * S];
const UNIT_M = SIZE_M / GRID;     // ground metres per grid unit
const MARGIN = 150 / cosLat;      // read and route 150 m beyond the frame
const QBOX = [X0 - MARGIN, Y1 - 2 * half - MARGIN, X0 + 2 * half + MARGIN, Y1 + MARGIN];

// ---- Read the rows that touch the frame --------------------------------
const dec = new TextDecoder();
type Row = Record<string, string | number | Uint8Array | null>;
let fetchedBytes = 0, groupsRead = 0, groupsTotal = 0;
async function rows(table: string, cols: string[]): Promise<Row[]> {
  const src = await rangedSource(`osm-tokyo23-${table}`);
  const rgs = await readFooter(src.range, src.size);
  const out: Row[] = [];
  const box = ['bbox.xmin', 'bbox.ymin', 'bbox.xmax', 'bbox.ymax'];
  for (const g of rgs) {
    groupsTotal++;
    const st = (c: string, k: 'min' | 'max') => statDouble(g.columns.get(c)![k]);
    if (st('bbox.xmin', 'min') > QBOX[2] || st('bbox.xmax', 'max') < QBOX[0] ||
        st('bbox.ymin', 'min') > QBOX[3] || st('bbox.ymax', 'max') < QBOX[1]) continue;
    groupsRead++;
    const c = await readColumns(src.range, g, [...box, ...cols]);
    for (let i = 0; i < g.rows; i++) {
      const b = box.map((k) => c[k][i] as number);
      if (b[0] > QBOX[2] || b[2] < QBOX[0] || b[1] > QBOX[3] || b[3] < QBOX[1]) continue;
      const r: Row = {};
      for (const k of cols) {
        const v: Value = c[k][i];
        r[k] = v instanceof Uint8Array && k !== 'way' ? dec.decode(v) : v;
      }
      out.push(r);
    }
  }
  fetchedBytes += src.fetched();
  return out;
}
const tags = (r: Row): Record<string, string> => (r.tags ? JSON.parse(r.tags as string) : {});

// ISO WKB, little or big endian: Point, LineString, Polygon (one per table).
function wkb(b: Uint8Array): XY[][] {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const le = b[0] === 1;
  const type = dv.getUint32(1, le) & 0xffff;
  let p = 5;
  const pts = (n: number): XY[] => {
    const out: XY[] = [];
    for (let i = 0; i < n; i++, p += 16) out.push([dv.getFloat64(p, le), dv.getFloat64(p + 8, le)]);
    return out;
  };
  if (type === 1) return [pts(1)];
  if (type === 2) { const n = dv.getUint32(p, le); p += 4; return [pts(n)]; }
  if (type === 3) {
    const rings: XY[][] = [];
    for (let k = dv.getUint32(p, le), j = (p += 4, 0); j < k; j++) { const n = dv.getUint32(p, le); p += 4; rings.push(pts(n)); }
    return rings;
  }
  throw new Error(`wkb type ${type}`);
}

const polyCols = ['osm_id', 'name', 'building', 'landuse', 'leisure', 'amenity', 'highway', 'railway', 'tags', 'way'];
const lineCols = ['osm_id', 'name', 'highway', 'railway', 'tunnel', 'bridge', 'layer', 'service', 'tags', 'way'];
const polys = await rows('polygon', polyCols);
const lines = await rows('line', lineCols);
const points = await rows('point', ['osm_id', 'name', 'tags', 'way']);
console.log(`read ${polys.length} polygons, ${lines.length} lines, ${points.length} points from ${groupsRead}/${groupsTotal} row groups, ${(fetchedBytes / 1e6).toFixed(1)} MB fetched now`);

const pointOf = (id: number): XY => {
  const r = points.find((p) => p.osm_id === id);
  if (!r) throw new Error(`node ${id} not found`);
  return wkb(r.way as Uint8Array)[0][0];
};

// ---- Geometry helpers in grid units ------------------------------------
const FRAME: Box = [0, 0, GRID, GRID];
const area = (r: XY[]): number => {
  let a = 0;
  for (let i = 0; i < r.length; i++) { const [x1, y1] = r[i], [x2, y2] = r[(i + 1) % r.length]; a += x1 * y2 - x2 * y1; }
  return a / 2;
};
const touches = (r: XY[], [x0, y0, x1, y1]: Box) => {
  let a = Infinity, b = Infinity, c = -Infinity, d = -Infinity;
  for (const [x, y] of r) { a = Math.min(a, x); b = Math.min(b, y); c = Math.max(c, x); d = Math.max(d, y); }
  return a <= x1 && c >= x0 && b <= y1 && d >= y0;
};
const round = (r: XY[]): XY[] => {
  const out: XY[] = [];
  for (const [x, y] of r) {
    const q: XY = [Math.round(x), Math.round(y)];
    const l = out[out.length - 1];
    if (!l || l[0] !== q[0] || l[1] !== q[1]) out.push(q);
  }
  return out;
};
// SVG path data: absolute first point, then relative integer steps.
function pathOf(parts: XY[][], close: boolean): string {
  let d = '';
  for (const g of parts) {
    if (g.length < 2) continue;
    d += `M${g[0][0]} ${g[0][1]}l`;
    for (let j = 1; j < g.length; j++) d += `${g[j][0] - g[j - 1][0]} ${g[j][1] - g[j - 1][1]} `;
    d = d.trimEnd() + (close ? 'z' : '');
  }
  return d;
}

// ---- Areas -----------------------------------------------------------------
const LANDMARKS: Record<number, string> = {
  99289007: '池袋駅',
  715271280: '西武',
  626416423: 'PARCO',
  99293081: 'Hareza Tower',
  250938764: 'サンシャインシティ',
};
// Buildings for the eye-level views: outer ring in EPSG:3857 and a height.
// 59% of the buildings here carry neither height nor building:levels; they
// get 4 storeys, typical of the mid-rise blocks east of the station.
interface Solid { id: number; kind: string; name: string; ring: XY[]; h: number }
const solids: Solid[] = [];
const polys_park: XY[][] = [];   // for the bird's-eye ground, in EPSG:3857
const heightOf = (t: Record<string, string>): number =>
  parseFloat(t.height) || (parseFloat(t['building:levels']) || 4) * 3.3;
const layer: Record<string, XY[][]> = { park: [], plaza: [], building: [], station: [], landmark: [], dest: [] };
let dropped = 0;
let destRing: XY[] = [];
for (const r of polys) {
  const t = tags(r);
  if (t.level && Number(t.level) < 0) continue;
  const id = r.osm_id as number;
  const kind = id === DEST_BUILDING ? 'dest'
    : r.building === 'train_station' || id === 99289007 ? 'station'
    : LANDMARKS[id] ? 'landmark'
    : r.building ? 'building'
    : r.leisure === 'park' || r.leisure === 'garden' || r.landuse === 'grass' || r.landuse === 'village_green' ? 'park'
    : r.highway === 'pedestrian' || r.amenity === 'marketplace' ? 'plaza'
    : null;
  if (!kind) continue;
  if (kind === 'park') polys_park.push(wkb(r.way as Uint8Array)[0].slice(0, -1));
  if (kind !== 'park' && kind !== 'plaza') {
    const outer = wkb(r.way as Uint8Array)[0];
    solids.push({ id, kind, name: LANDMARKS[id] ?? (id === DEST_BUILDING ? 'グランドスケープ池袋' : ''), ring: outer, h: heightOf(t) });
  }
  for (const ring of wkb(r.way as Uint8Array)) {
    const g = round(simplify(ring.map(grid), 0.7));
    if (!touches(g, FRAME)) continue;
    if (g.length < 4 || (kind === 'building' && Math.abs(area(g)) < 30)) { dropped++; continue; }
    layer[kind].push(g);
    if (kind === 'dest' && !destRing.length) destRing = g;
  }
}
if (!destRing.length) throw new Error('destination building not found');

// ---- Lines -------------------------------------------------------------
const ROAD_CLASS: Record<string, string> = {
  motorway: 'expressway', trunk: 'major', primary: 'major', secondary: 'major',
  trunk_link: 'major', primary_link: 'major', secondary_link: 'major',
  tertiary: 'mid', tertiary_link: 'mid',
  unclassified: 'minor', residential: 'minor', living_street: 'minor', pedestrian: 'minor',
};
const WALK = new Set(['primary', 'secondary', 'tertiary', 'unclassified', 'residential', 'living_street', 'pedestrian',
  'footway', 'path', 'steps', 'service', 'primary_link', 'secondary_link', 'tertiary_link', 'cycleway']);
const strokes: Record<string, XY[][]> = { expressway: [], major: [], mid: [], minor: [], rail: [] };
const underground = (r: Row, t: Record<string, string>) =>
  r.tunnel === 'yes' || Number(r.layer ?? 0) < 0 || (t.level !== undefined && Number(t.level.split(';')[0]) < 0) || t.indoor === 'yes' || r.highway === 'corridor';

interface Way { id: number; name: string; hw: string; crossing: boolean; pts: XY[] }
const walkWays: Way[] = [];
const roadLines: [XY[], string][] = [];      // bird's-eye ground, EPSG:3857
const namedRoads: [string, XY[]][] = [];
const roadNames = new Map<string, string>();   // node (3857 "x,y") -> name of a car road through it
const key = ([x, y]: XY) => `${x},${y}`;
for (const r of lines) {
  const t = tags(r), pts = wkb(r.way as Uint8Array)[0];
  const hw = r.highway as string | null, name = (r.name as string | null) ?? '';
  if (hw && WALK.has(hw) && !underground(r, t)) walkWays.push({ id: r.osm_id as number, name, hw, crossing: t.footway === 'crossing', pts });
  if (hw && ROAD_CLASS[hw] && hw !== 'pedestrian' && name && !underground(r, t)) for (const p of pts) roadNames.set(key(p), name);
  const cls = hw ? ROAD_CLASS[hw] : r.railway === 'rail' ? 'rail' : null;
  if (!cls || (r.tunnel === 'yes' || Number(r.layer ?? 0) < 0)) continue;
  if (cls !== 'rail' && cls !== 'expressway') roadLines.push([pts, cls]);
  if (name && cls !== 'rail') namedRoads.push([name, pts]);
  if (cls === 'rail' && (t.service === 'yard' || t.service === 'siding')) continue;
  for (const piece of clipPolyline(pts.map(grid), [-20, -20, GRID + 20, GRID + 20])) {
    const g = round(simplify(piece as XY[], 0.7));
    if (g.length >= 2) strokes[cls].push(g);
  }
}

// ---- Walking route: Dijkstra on the footway and street graph -----------
// Edge weight is ground length, times a small penalty for service roads and
// steps so that the route keeps to the streets a visitor would be told to use.
const adj = new Map<string, { to: string; w: number; way: number }[]>();
const coord = new Map<string, XY>();
const PENALTY: Record<string, number> = { service: 1.4, steps: 1.3, cycleway: 1.2 };
for (let wi = 0; wi < walkWays.length; wi++) {
  const w = walkWays[wi];
  for (let i = 1; i < w.pts.length; i++) {
    const a = key(w.pts[i - 1]), b = key(w.pts[i]);
    coord.set(a, w.pts[i - 1]); coord.set(b, w.pts[i]);
    const len = Math.hypot(w.pts[i][0] - w.pts[i - 1][0], w.pts[i][1] - w.pts[i - 1][1]) * cosLat;
    const wt = len * (PENALTY[w.hw] ?? 1);
    (adj.get(a) ?? adj.set(a, []).get(a)!).push({ to: b, w: wt, way: wi });
    (adj.get(b) ?? adj.set(b, []).get(b)!).push({ to: a, w: wt, way: wi });
  }
}
const nearest = (p: XY): string => {
  let best = '', bd = Infinity;
  for (const [k, c] of coord) { const d = Math.hypot(c[0] - p[0], c[1] - p[1]); if (d < bd) { bd = d; best = k; } }
  if (bd * cosLat > 40) throw new Error(`no walkable node within 40 m of ${p}`);
  return best;
};
const startXY = pointOf(START_NODE);
// The doors of the destination: entrance nodes inside its bounding box.
const destRaw = polys.find((r) => r.osm_id === DEST_BUILDING)!;
const destOuter = wkb(destRaw.way as Uint8Array)[0];
const inside = (p: XY, ring: XY[]) => {
  let c = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > p[1]) !== (yj > p[1]) && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
};
const nearRing = (p: XY, ring: XY[], m: number) => ring.some((q) => Math.hypot(q[0] - p[0], q[1] - p[1]) * cosLat < m) || inside(p, ring);
const doors = points.filter((r) => tags(r).entrance && tags(r).entrance !== 'service' && nearRing(wkb(r.way as Uint8Array)[0][0], destOuter, 3))
  .map((r) => wkb(r.way as Uint8Array)[0][0]);
const goals = doors.length ? doors : destOuter;
console.log(`destination: ${doors.length} entrance nodes`);

const src = nearest(startXY);
const dist = new Map<string, number>([[src, 0]]);
const prev = new Map<string, { from: string; way: number }>();
const done = new Set<string>();
// A binary heap keeps this fast enough for ~20k nodes.
const heap: [number, string][] = [[0, src]];
const push = (e: [number, string]) => { heap.push(e); let i = heap.length - 1; while (i) { const p = (i - 1) >> 1; if (heap[p][0] <= heap[i][0]) break; [heap[p], heap[i]] = [heap[i], heap[p]]; i = p; } };
const pop = (): [number, string] => {
  const top = heap[0], last = heap.pop()!;
  if (heap.length) { heap[0] = last; let i = 0; for (;;) { const l = 2 * i + 1, r = l + 1; let m = i; if (l < heap.length && heap[l][0] < heap[m][0]) m = l; if (r < heap.length && heap[r][0] < heap[m][0]) m = r; if (m === i) break; [heap[m], heap[i]] = [heap[i], heap[m]]; i = m; } }
  return top;
};
while (heap.length) {
  const [d, u] = pop();
  if (done.has(u)) continue;
  done.add(u);
  for (const e of adj.get(u) ?? []) {
    const nd = d + e.w;
    if (nd < (dist.get(e.to) ?? Infinity)) { dist.set(e.to, nd); prev.set(e.to, { from: u, way: e.way }); push([nd, e.to]); }
  }
}
// Pick the door (or outline vertex) reached most cheaply, counting the last
// stretch from the graph to the door as a straight walk.
let goal = '', goalCost = Infinity, goalXY: XY = [0, 0];
for (const g of goals) {
  for (const [k, c] of coord) {
    const step = Math.hypot(c[0] - g[0], c[1] - g[1]) * cosLat;
    if (step > 25) continue;
    const cost = (dist.get(k) ?? Infinity) + step;
    if (cost < goalCost) { goalCost = cost; goal = k; goalXY = g; }
  }
}
if (!goal) throw new Error('route: destination not reachable');
const routeNodes: string[] = [goal];
const routeWays: number[] = [];
for (let k = goal; k !== src;) { const p = prev.get(k)!; routeWays.unshift(p.way); k = p.from; routeNodes.unshift(k); }
const routeRaw: XY[] = [startXY, ...routeNodes.map((k) => coord.get(k)!), goalXY];
const seg = (a: XY, b: XY) => Math.hypot(b[0] - a[0], b[1] - a[1]) * cosLat;
let routeM = 0;
for (let i = 1; i < routeRaw.length; i++) routeM += seg(routeRaw[i - 1], routeRaw[i]);

// Written directions: group the route's edges by street, name the road a
// crossing crosses, and give each leg a compass direction and length.
const DIRS = ['東', '北東', '北', '北西', '西', '南西', '南', '南東'];
const compass = (a: XY, b: XY) => DIRS[((Math.round(Math.atan2(b[1] - a[1], b[0] - a[0]) / (Math.PI / 4)) % 8) + 8) % 8];
interface Leg { label: string; m: number; from: XY; to: XY }
const legs: Leg[] = [];
for (let i = 0; i < routeWays.length; i++) {
  const w = walkWays[routeWays[i]], a = coord.get(routeNodes[i])!, b = coord.get(routeNodes[i + 1])!;
  let label = w.name ? `${w.name}` : '';
  if (w.crossing) {
    const crossed = w.pts.map((p) => roadNames.get(key(p))).find((n) => n);
    // Dual carriageways carry name variants (明治通 / 明治通り): one crossing.
    const name = crossed && [...roadNames.values()].includes(crossed + 'り') ? crossed + 'り' : crossed;
    label = name ? `横断歩道で${name}を渡る` : '横断歩道を渡る';
  }
  const last = legs[legs.length - 1];
  if (last && last.label === label) { last.m += seg(a, b); last.to = b; } else legs.push({ label, m: seg(a, b), from: a, to: b });
}
// Unnamed short legs (sidewalk pieces between named ones) join a neighbour.
for (let i = 0; i < legs.length; i++) {
  const l = legs[i];
  if (l.label || l.m >= 40) continue;
  const nb = legs[i - 1] && !legs[i - 1].label.startsWith('横断') ? legs[i - 1] : legs[i + 1];
  if (!nb) continue;
  nb.m += l.m;
  if (nb === legs[i - 1]) nb.to = l.to; else nb.from = l.from;
  legs.splice(i--, 1);
}
for (let i = 1; i < legs.length; i++) if (legs[i].label === legs[i - 1].label) { legs[i - 1].m += legs[i].m; legs[i - 1].to = legs[i].to; legs.splice(i--, 1); }
const steps = legs.map((l) => {
  const m = Math.max(10, Math.round(l.m / 10) * 10);
  if (l.label.startsWith('横断')) return l.label;
  return l.label ? `${l.label}を${compass(l.from, l.to)}へ 約${m} m` : `${compass(l.from, l.to)}へ 約${m} m`;
});
console.log(`route: ${routeM.toFixed(0)} m, ${routeNodes.length} nodes`);
for (const s of steps) console.log('  ' + s);

const routeGrid = round(simplify(routeRaw.map(grid), 0.5));

// ---- Labels --------------------------------------------------------------
// Fixed scale: sizes are in grid units, so the layout decided here holds at
// every canvas size. Widths are estimated (CJK 1 em, Latin 0.6 em); the bench
// measures the real boxes and counts overlaps.
const em = (s: string) => [...s].reduce((a, c) => a + (c.charCodeAt(0) > 0x2e80 ? 1 : c === ' ' ? 0.3 : 0.62), 0);
const LABEL_PAD = 4;
type Label = [text: string, x: number, y: number, size: number, angle: number, kind: number];
// kind: 0 street, 1 landmark, 2 destination, 3 start
const placed: Label[] = [];
const boxes: Box[] = [];
const boxOf = (text: string, x: number, y: number, size: number, angle: number): Box => {
  const w = em(text) * size / 2 + LABEL_PAD, h = size / 2 + LABEL_PAD;
  const c = Math.abs(Math.cos(angle)), s = Math.abs(Math.sin(angle));
  const hw = w * c + h * s, hh = w * s + h * c;
  return [x - hw, y - hh, x + hw, y + hh];
};
const hit = (a: Box, b: Box) => a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1];
const inFrame = (b: Box) => b[0] >= 4 && b[1] >= 4 && b[2] <= GRID - 4 && b[3] <= GRID - 4;
const ringBox = (r: XY[]): Box => {
  const xs = r.map((p) => p[0]), ys = r.map((p) => p[1]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
};
const destBox = ringBox(destRing);
const startG = grid(startXY);
const blockers: Box[] = [destBox, [startG[0] - 14, startG[1] - 14, startG[0] + 14, startG[1] + 14]];
function place(text: string, cands: [number, number, number][], size: number, kind: number, avoid = blockers): boolean {
  for (const [x, y, a] of cands) {
    const b = boxOf(text, x, y, size, a);
    if (!inFrame(b) || boxes.some((o) => hit(o, b)) || avoid.some((o) => hit(o, b))) continue;
    placed.push([text, Math.round(x), Math.round(y), size, Math.round(a * 1000) / 1000, kind]);
    boxes.push(b);
    return true;
  }
  console.log(`label dropped: ${text} (${cands.length} candidates)`);
  return false;
}
const around = (cx: number, cy: number, rx: number, ry: number, text: string, size: number): [number, number, number][] => {
  const hw = em(text) * size / 2 + LABEL_PAD, hh = size / 2 + LABEL_PAD;
  return [[cx, cy - ry - hh, 0], [cx, cy + ry + hh, 0], [cx + rx + hw, cy, 0], [cx - rx - hw, cy, 0],
    [cx + rx + hw, cy - ry - hh, 0], [cx - rx - hw, cy - ry - hh, 0], [cx + rx + hw, cy + ry + hh, 0], [cx - rx - hw, cy + ry + hh, 0]];
};
// 1. The destination: two lines above (or around) the building.
const [dx0, dy0, dx1, dy1] = destBox;
const dcx = (dx0 + dx1) / 2, dcy = (dy0 + dy1) / 2;
const DEST_SIZE = 44, DEST_SUB = 32;   // 11 px is 31 units on a 358 px map
const DEST_H = DEST_SIZE + DEST_SUB + 6;   // the two lines as one block
const destCands = around(dcx, dcy, (dx1 - dx0) / 2 + 30, (dy1 - dy0) / 2 + DEST_H / 2 - DEST_SIZE / 2 + 30, 'グランドシネマサンシャイン', DEST_SIZE);
let destPlaced = false;
for (const [x, y] of destCands) {
  // Name, then the building under it, moving together.
  const y1 = y - DEST_H / 2 + DEST_SIZE / 2, y2 = y + DEST_H / 2 - DEST_SUB / 2;
  const b1 = boxOf('グランドシネマサンシャイン', x, y1, DEST_SIZE, 0);
  const b2 = boxOf('（グランドスケープ池袋）', x, y2, DEST_SUB, 0);
  if (![b1, b2].every((b) => inFrame(b) && !boxes.some((o) => hit(o, b)) && !blockers.some((o) => hit(o, b)))) continue;
  placed.push(['グランドシネマサンシャイン', Math.round(x), Math.round(y1), DEST_SIZE, 0, 2],
    ['（グランドスケープ池袋）', Math.round(x), Math.round(y2), DEST_SUB, 0, 2]);
  boxes.push(b1, b2);
  destPlaced = true;
  break;
}
if (!destPlaced) throw new Error('destination label could not be placed');
// 2. Start.
place('池袋駅 東口', around(startG[0], startG[1], 18, 18, '池袋駅 東口', 36).slice().sort((a, b) => a[0] - b[0]), 36, 3);
// 3. Streets: along the longest straight run inside the frame, avoiding the
//    route so the blue line stays readable.
// The route as small boxes every 6 units (its drawn half width is 7.5), so a
// label may sit right beside a slanted leg instead of off its bounding box.
const routeBoxes: Box[] = [];
for (let i = 1; i < routeGrid.length; i++) {
  const [a, b] = [routeGrid[i - 1], routeGrid[i]];
  const n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / 6));
  for (let j = 0; j <= n; j++) {
    const x = a[0] + ((b[0] - a[0]) * j) / n, y = a[1] + ((b[1] - a[1]) * j) / n;
    routeBoxes.push([x - 8, y - 8, x + 8, y + 8]);
  }
}
const STREETS = ['サンシャイン通り', '明治通り', 'サンシャイン60通り', 'グリーン大通り', '首都高速5号池袋線', '春日通り', '劇場通り'];
const STREET_SIZE = 32;
for (const name of STREETS) {
  const runs: [number, number, number, number][] = [];   // length, x, y, angle
  // OSM splits a street into many short ways: join the pieces end to end
  // first, or no piece is long enough for its name.
  const pieces: XY[][] = [];
  for (const r of lines) if (r.name === name && !underground(r, tags(r))) pieces.push(wkb(r.way as Uint8Array)[0]);
  const chains: XY[][] = [];
  while (pieces.length) {
    let c = pieces.pop()!;
    for (let grew = true; grew;) {
      grew = false;
      for (let i = 0; i < pieces.length; i++) {
        const q = pieces[i], h = key(c[0]), t = key(c[c.length - 1]);
        if (key(q[0]) === t) c = [...c, ...q.slice(1)];
        else if (key(q[q.length - 1]) === t) c = [...c, ...q.slice(0, -1).reverse()];
        else if (key(q[q.length - 1]) === h) c = [...q, ...c.slice(1)];
        else if (key(q[0]) === h) c = [...q.slice(1).reverse(), ...c];
        else continue;
        pieces.splice(i--, 1); grew = true;
      }
    }
    chains.push(c);
  }
  for (const chain of chains) {
    for (const piece of clipPolyline(chain.map(grid), [40, 40, GRID - 40, GRID - 40])) {
      const g = simplify(piece as XY[], 12);
      for (let i = 1; i < g.length; i++) {
        const [a, b] = [g[i - 1], g[i]];
        let ang = Math.atan2(b[1] - a[1], b[0] - a[0]);
        if (ang > Math.PI / 2) ang -= Math.PI; else if (ang <= -Math.PI / 2) ang += Math.PI;
        const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
        // Several anchors along a long run, so one blocked spot is not fatal.
        // On the road itself, else beside it (the street the route follows
        // is covered by the route line).
        const off = STREET_SIZE / 2 + 30, nx = -Math.sin(ang) * off, ny = Math.cos(ang) * off;
        for (const o of [0, -1, 1]) for (const f of [0.5, 0.4, 0.6, 0.3, 0.7, 0.2, 0.8])
          runs.push([len - Math.abs(o) * 0.01, a[0] + (b[0] - a[0]) * f + o * nx, a[1] + (b[1] - a[1]) * f + o * ny, ang]);
      }
    }
  }
  const need = em(name) * STREET_SIZE + 20;
  const cands = runs.filter((r) => r[0] >= need).sort((p, q) => q[0] - p[0]).map(([, x, y, a]): [number, number, number] => [x, y, a]);
  if (cands.length) place(name, cands, STREET_SIZE, 0, [...blockers, ...routeBoxes]);
  else console.log(`label dropped (no straight run): ${name}`);
}
// 4. Landmarks, at their building, else next to it.
const LM_SIZE = 34;
for (const [id, text] of Object.entries(LANDMARKS)) {
  const r = polys.find((p) => p.osm_id === Number(id));
  if (!r) { console.log(`landmark ${id} missing`); continue; }
  const g = wkb(r.way as Uint8Array)[0].map(grid);
  const [x0, y0, x1, y1] = ringBox(g);
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  place(text, [[cx, cy, 0], ...around(cx, cy, (x1 - x0) / 4, (y1 - y0) / 4, text, LM_SIZE)], LM_SIZE, 1, [...blockers, ...routeBoxes]);
}


// ---- Eye-level views -----------------------------------------------------
// Three fixed cameras on the route, 1.6 m above the ground: leaving the
// station, entering the street after the crossing, and 90 m before the
// building. Projection, back-face culling, near-plane and screen clipping and
// the painter's order are all done here; the page fills the polygons in the
// order given. Painter's order is per building (nearest footprint point,
// far to near), then per wall within a building: exact for convex footprints
// at street level, where no roof is visible.
const VW = 1000, VH = 560, HORIZON = 330, EYE = 1.6, NEAR = 1, FAR = 450;
const HFOV = (72 * Math.PI) / 180, FOCAL = VW / 2 / Math.tan(HFOV / 2);
// Wall colours: [base RGB] per kind, darkened by facing away from the light
// (sun from the south-west, as on a printed map).
const BASE: Record<string, [number, number, number]> = {
  building: [222, 216, 205], station: [190, 204, 222], landmark: [206, 193, 172], dest: [232, 71, 61],
};
const SHADES = 4;
const palette: string[] = [];
const colorIndex = (kind: string, lit: number): number => {
  const k = Math.min(SHADES - 1, Math.floor(lit * SHADES));
  const f = 0.68 + 0.32 * (k / (SHADES - 1));
  const hex = '#' + BASE[kind].map((c) => Math.round(c * f).toString(16).padStart(2, '0')).join('');
  let i = palette.indexOf(hex);
  if (i < 0) { i = palette.length; palette.push(hex); }
  return i;
};
const LIGHT = [-Math.SQRT1_2, -Math.SQRT1_2];   // towards the sun, x east y north

// Route distance -> position and heading.
const cum: number[] = [0];
for (let i = 1; i < routeRaw.length; i++) cum.push(cum[i - 1] + seg(routeRaw[i - 1], routeRaw[i]));
const along = (d: number): XY => {
  d = Math.max(0, Math.min(cum[cum.length - 1], d));
  let i = 1;
  while (i < cum.length - 1 && cum[i] < d) i++;
  const t = (d - cum[i - 1]) / Math.max(1e-9, cum[i] - cum[i - 1]);
  return [routeRaw[i - 1][0] + (routeRaw[i][0] - routeRaw[i - 1][0]) * t, routeRaw[i - 1][1] + (routeRaw[i][1] - routeRaw[i - 1][1]) * t];
};
// Where the last named leg (the street to the building) starts, in metres.
let streetStart = 0;
{
  let acc = 0;
  for (const l of legs.slice(0, -1)) acc += l.m;
  streetStart = acc + 15;
}
const destC = destOuter.reduce((a, p) => [a[0] + p[0] / destOuter.length, a[1] + p[1] / destOuter.length], [0, 0]);
const VIEWS: { title: string; at: number; look: XY | number }[] = [
  { title: '東口を出たところ', at: 8, look: 45 },
  { title: `${legs[legs.length - 1].label || '通り'}に入ったところ`, at: streetStart, look: streetStart + 60 },
  { title: '建物の手前', at: cum[cum.length - 1] - 90, look: destC as XY },
];

type V3 = [number, number, number];   // camera space: x right, y up, z forward
function clipNear(poly: V3[]): V3[] {
  const out: V3[] = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    const ina = a[2] >= NEAR, inb = b[2] >= NEAR;
    if (ina) out.push(a);
    if (ina !== inb) {
      const t = (NEAR - a[2]) / (b[2] - a[2]);
      out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, NEAR]);
    }
  }
  return out;
}
function clipRect(poly: XY[], [x0, y0, x1, y1]: Box): XY[] {
  let pts = poly;
  const edges: [(p: XY) => boolean, (a: XY, b: XY) => XY][] = [
    [(p) => p[0] >= x0, (a, b) => [x0, a[1] + ((b[1] - a[1]) * (x0 - a[0])) / (b[0] - a[0])]],
    [(p) => p[0] <= x1, (a, b) => [x1, a[1] + ((b[1] - a[1]) * (x1 - a[0])) / (b[0] - a[0])]],
    [(p) => p[1] >= y0, (a, b) => [a[0] + ((b[0] - a[0]) * (y0 - a[1])) / (b[1] - a[1]), y0]],
    [(p) => p[1] <= y1, (a, b) => [a[0] + ((b[0] - a[0]) * (y1 - a[1])) / (b[1] - a[1]), y1]],
  ];
  for (const [inside, cut] of edges) {
    const out: XY[] = [];
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i], b = pts[(i + 1) % pts.length];
      if (inside(a)) out.push(a);
      if (inside(a) !== inside(b)) out.push(cut(a, b));
    }
    pts = out;
    if (!pts.length) break;
  }
  return pts;
}
const SCREEN: Box = [-4, -4, VW + 4, VH + 4];
const pointInPoly = (p: XY, r: XY[]) => inside(p, r);

const views = VIEWS.map((v) => {
  const cam = along(v.at);
  const tgt = typeof v.look === 'number' ? along(v.look) : v.look;
  const yaw = Math.atan2(tgt[1] - cam[1], tgt[0] - cam[0]);   // 3857 axes: x east, y north
  const fx = Math.cos(yaw), fy = Math.sin(yaw);               // forward
  const rx = fy, ry = -fx;                                    // right
  // Ground metres around the camera -> camera space.
  const toCam = ([x, y]: XY, h: number): V3 => {
    const dx = (x - cam[0]) * cosLat, dy = (y - cam[1]) * cosLat;
    return [dx * rx + dy * ry, h - EYE, dx * fx + dy * fy];
  };
  const project = (p: V3): XY => [VW / 2 + (FOCAL * p[0]) / p[2], HORIZON - (FOCAL * p[1]) / p[2]];
  const polys: { c: number; b: number; pts: XY[] }[] = [];
  const emitPoly = (c: number, b: number, poly3: V3[]) => {
    const n = clipNear(poly3);
    if (n.length < 3) return;
    const scr = clipRect(n.map(project), SCREEN);
    if (scr.length >= 3) polys.push({ c, b, pts: scr });
  };
  // Ground: the route ahead of the camera as a 3 m wide ribbon, drawn first.
  const ribbon: { pts: XY[] }[] = [];
  for (let i = 1; i < routeRaw.length; i++) {
    if (cum[i] <= v.at) continue;
    const a = cum[i - 1] < v.at ? cam : routeRaw[i - 1], b = routeRaw[i];
    const len = seg(a, b);
    if (!len) continue;
    const nx = (-(b[1] - a[1]) / (len / cosLat)) * 1.5 / cosLat, ny = ((b[0] - a[0]) / (len / cosLat)) * 1.5 / cosLat;
    const quad: V3[] = [toCam([a[0] + nx, a[1] + ny], 0.02), toCam([b[0] + nx, b[1] + ny], 0.02), toCam([b[0] - nx, b[1] - ny], 0.02), toCam([a[0] - nx, a[1] - ny], 0.02)];
    const n = clipNear(quad);
    if (n.length < 3) continue;
    const scr = clipRect(n.map(project), SCREEN);
    if (scr.length >= 3) ribbon.push({ pts: scr });
  }
  // Buildings, far to near.
  const near: { s: Solid; d: number; si: number }[] = [];
  solids.forEach((s, si) => {
    let d = Infinity;
    for (let i = 0; i < s.ring.length - 1; i++) {
      const [a, b] = [s.ring[i], s.ring[i + 1]];
      const ex = b[0] - a[0], ey = b[1] - a[1], l2 = ex * ex + ey * ey || 1;
      const t = Math.max(0, Math.min(1, ((cam[0] - a[0]) * ex + (cam[1] - a[1]) * ey) / l2));
      d = Math.min(d, Math.hypot(a[0] + ex * t - cam[0], a[1] + ey * t - cam[1]) * cosLat);
    }
    if (d < FAR) near.push({ s, d, si });
  });
  near.sort((p, q) => q.d - p.d);
  for (const { s, si } of near) {
    const ccw = area(s.ring) > 0;   // in 3857 (y north): positive area is counter-clockwise
    const walls: { d: number; c: number; q: V3[] }[] = [];
    for (let i = 0; i < s.ring.length - 1; i++) {
      const [a, b] = [s.ring[i], s.ring[i + 1]];
      const ex = b[0] - a[0], ey = b[1] - a[1], el = Math.hypot(ex, ey);
      if (!el) continue;
      const nx = (ccw ? ey : -ey) / el, ny = (ccw ? -ex : ex) / el;   // outward normal
      if (nx * (cam[0] - a[0]) + ny * (cam[1] - a[1]) <= 0) continue;  // facing away
      const lit = Math.max(0, nx * LIGHT[0] + ny * LIGHT[1]);
      const q: V3[] = [toCam(a, 0), toCam(b, 0), toCam(b, s.h), toCam(a, s.h)];
      walls.push({ d: Math.hypot((a[0] + b[0]) / 2 - cam[0], (a[1] + b[1]) / 2 - cam[1]), c: colorIndex(s.kind, lit), q });
    }
    walls.sort((p, q) => q.d - p.d);
    for (const w of walls) emitPoly(w.c, si, w.q);
  }
  // Names of the destination and landmarks that are actually visible: the
  // topmost polygon at sampled screen points must belong to the building.
  const labels: [string, number, number, number][] = [];
  const taken: Box[] = [];
  const named = [...new Set(polys.map((p) => p.b))].filter((b) => solids[b].name);
  named.sort((p, q) => (solids[q].kind === 'dest' ? 1 : 0) - (solids[p].kind === 'dest' ? 1 : 0));
  for (const b of named) {
    const mine = polys.filter((p) => p.b === b);
    const xs = mine.flatMap((p) => p.pts.map((q) => q[0])), ys = mine.flatMap((p) => p.pts.map((q) => q[1]));
    const [bx0, by0, bx1, by1] = [Math.max(0, Math.min(...xs)), Math.max(0, Math.min(...ys)), Math.min(VW, Math.max(...xs)), Math.min(VH, Math.max(...ys))];
    let vis = 0, sx = 0, top = Infinity;
    for (let y = by0; y <= by1; y += 8) for (let x = bx0; x <= bx1; x += 8) {
      let owner = -1;
      for (let i = polys.length - 1; i >= 0; i--) if (pointInPoly([x, y], polys[i].pts)) { owner = polys[i].b; break; }
      if (owner === b) { vis++; sx += x; top = Math.min(top, y); }
    }
    if (vis < 6) continue;
    const text = solids[b].kind === 'dest' ? 'グランドスケープ池袋（映画館）' : solids[b].name;
    const size = solids[b].kind === 'dest' ? 40 : 34;
    const x = Math.min(VW - em(text) * size / 2 - 8, Math.max(em(text) * size / 2 + 8, sx / vis));
    const y = Math.max(size / 2 + 8, top - size / 2 - 10);
    const box: Box = [x - em(text) * size / 2, y - size / 2, x + em(text) * size / 2, y + size / 2];
    if (taken.some((o) => hit(o, box))) continue;
    taken.push(box);
    labels.push([text, Math.round(x), Math.round(y), solids[b].kind === 'dest' ? 1 : 0]);
  }
  // Consecutive polygons of one colour share one path.
  const runs: [number, string][] = [];
  for (const p of polys) {
    const d = pathOf([round(p.pts)], true);
    const last = runs[runs.length - 1];
    if (last && last[0] === p.c) last[1] += d; else runs.push([p.c, d]);
  }
  console.log(`view "${v.title}": ${near.length} buildings within ${FAR} m, ${polys.length} wall polygons, ${runs.length} runs, labels ${labels.map((l) => l[0]).join(', ') || '-'}`);
  return { title: v.title, at: grid(cam).map(Math.round), yaw: Math.round((yaw * 1000)) / 1000, ground: pathOf(ribbon.map((r) => round(r.pts)), true), walls: runs, labels };
});

// ---- Bird's-eye view -----------------------------------------------------
// One fixed camera above the south-west, looking down at the walk. Same
// approach as the eye-level views, plus roofs, the ground (block, parks,
// main roads, the route) and a hidden-surface pass: every polygon is
// rasterised into an id buffer here, in painter's order, and polygons that
// end up with no visible pixel are not shipped.
const BW = 1000, BH = 760, BIRD_REGION = 430;     // half-size of the ground square, metres
const BIRD_PITCH = (52 * Math.PI) / 180, BIRD_DIST = 900, BIRD_HFOV = (42 * Math.PI) / 180;
const BIRD_HEADING = (62 * Math.PI) / 180;        // looking towards east-north-east..north
const bpalette: string[] = [];
const bcolor = (hex: string) => { let i = bpalette.indexOf(hex); if (i < 0) { i = bpalette.length; bpalette.push(hex); } return i; };
const shadeHex = (rgb: [number, number, number], f: number) => '#' + rgb.map((c) => Math.round(Math.min(255, c * f)).toString(16).padStart(2, '0')).join('');
const startM: XY = routeRaw[0];
const target: XY = [(startM[0] + destC[0]) / 2, (startM[1] + destC[1]) / 2];
const bird = (() => {
  // Camera in ground metres relative to the target, z up.
  const fwdH: XY = [Math.cos(BIRD_HEADING), Math.sin(BIRD_HEADING)];
  const camG: V3 = [-fwdH[0] * BIRD_DIST * Math.cos(BIRD_PITCH), -fwdH[1] * BIRD_DIST * Math.cos(BIRD_PITCH), BIRD_DIST * Math.sin(BIRD_PITCH)];
  const f: V3 = [fwdH[0] * Math.cos(BIRD_PITCH), fwdH[1] * Math.cos(BIRD_PITCH), -Math.sin(BIRD_PITCH)];
  const r: V3 = [fwdH[1], -fwdH[0], 0];
  const u: V3 = [r[1] * f[2] - r[2] * f[1], r[2] * f[0] - r[0] * f[2], r[0] * f[1] - r[1] * f[0]];
  const focal = BW / 2 / Math.tan(BIRD_HFOV / 2);
  const local = ([x, y]: XY): XY => [(x - target[0]) * cosLat, (y - target[1]) * cosLat];
  const toCam = (p: XY, h: number): V3 => {
    const [x, y] = local(p), d: V3 = [x - camG[0], y - camG[1], h - camG[2]];
    return [d[0] * r[0] + d[1] * r[1] + d[2] * r[2], d[0] * u[0] + d[1] * u[1] + d[2] * u[2], d[0] * f[0] + d[1] * f[1] + d[2] * f[2]];
  };
  const project = (p: V3): XY => [BW / 2 + (focal * p[0]) / p[2], BH / 2 - (focal * p[1]) / p[2]];
  const box: Box = [-4, -4, BW + 4, BH + 4];
  const polys: { c: number; b: number; pts: XY[] }[] = [];
  const add = (c: number, b: number, ring: V3[]) => {
    const n = clipNear(ring);
    if (n.length < 3) return;
    const scr = clipRect(n.map(project), box);
    if (scr.length >= 3) polys.push({ c, b, pts: scr });
  };
  const inRegion = (p: XY) => { const [x, y] = local(p); return Math.abs(x) <= BIRD_REGION && Math.abs(y) <= BIRD_REGION; };
  const fromLocal = (x: number, y: number): XY => [target[0] + x / cosLat, target[1] + y / cosLat];
  // Ground: the square, parks, main roads as 3D ribbons, the route on top.
  const G = BIRD_REGION;
  add(bcolor('#ebe7df'), -1, [fromLocal(-G, -G), fromLocal(G, -G), fromLocal(G, G), fromLocal(-G, G)].map((p) => toCam(p, 0)));
  for (const r0 of polys_park) if (r0.some(inRegion)) add(bcolor('#cfe5c1'), -1, r0.map((p) => toCam(p, 0)));
  const ribbon = (pts: XY[], halfW: number, h: number, c: number, b: number) => {
    for (let i = 1; i < pts.length; i++) {
      const [a, q] = [pts[i - 1], pts[i]];
      if (!inRegion(a) && !inRegion(q)) continue;
      const len = Math.hypot(q[0] - a[0], q[1] - a[1]);
      if (!len) continue;
      // Extend each piece by half a width so consecutive quads overlap at bends.
      const ux = (q[0] - a[0]) / len, uy = (q[1] - a[1]) / len, w = halfW / cosLat;
      const nx = -uy * w, ny = ux * w, ex = ux * w, ey = uy * w;
      add(c, b, [[a[0] - ex + nx, a[1] - ey + ny], [q[0] + ex + nx, q[1] + ey + ny], [q[0] + ex - nx, q[1] + ey - ny], [a[0] - ex - nx, a[1] - ey - ny]].map((p) => toCam(p as XY, h)));
    }
  };
  for (const [pts, cls] of roadLines) ribbon(pts, cls === 'major' ? 9 : cls === 'mid' ? 6 : 3.5, 0, bcolor('#fbfaf7'), -1);
  ribbon(routeRaw, 4, 0.5, bcolor('#1a73e8'), -2);
  // Buildings, far to near (nearest footprint point from the camera's ground
  // position); within one building the walls far to near, then the roof.
  const camXY = fromLocal(camG[0], camG[1]);
  const order = solids.map((s, si) => ({ s, si, d: Math.min(...s.ring.map((p) => Math.hypot(p[0] - camXY[0], p[1] - camXY[1]))) }))
    .filter(({ s }) => s.ring.some(inRegion) && Math.abs(area(s.ring)) * cosLat * cosLat >= 30).sort((p, q) => q.d - p.d);
  for (const { s, si } of order) {
    const ccw = area(s.ring) > 0;
    const walls: { d: number; c: number; q: V3[] }[] = [];
    for (let i = 0; i < s.ring.length - 1; i++) {
      const [a, b] = [s.ring[i], s.ring[i + 1]];
      const ex = b[0] - a[0], ey = b[1] - a[1], el = Math.hypot(ex, ey);
      if (!el) continue;
      const nx = (ccw ? ey : -ey) / el, ny = (ccw ? -ex : ex) / el;
      if (nx * (camXY[0] - a[0]) + ny * (camXY[1] - a[1]) <= 0) continue;
      const lit = Math.max(0, nx * LIGHT[0] + ny * LIGHT[1]);
      walls.push({ d: Math.hypot((a[0] + b[0]) / 2 - camXY[0], (a[1] + b[1]) / 2 - camXY[1]), c: bcolor(shadeHex(BASE[s.kind], 0.62 + 0.25 * lit)), q: [toCam(a, 0), toCam(b, 0), toCam(b, s.h), toCam(a, s.h)] });
    }
    walls.sort((p, q) => q.d - p.d);
    for (const w of walls) add(w.c, si, w.q);
    add(bcolor(shadeHex(BASE[s.kind], 1.04)), si, s.ring.slice(0, -1).map((p) => toCam(p, s.h)));
  }
  // Hidden-surface pass: an id buffer at half resolution, even-odd scanline fill.
  const IW = BW / 2, IH = BH / 2, ids = new Int32Array(IW * IH).fill(-1);
  polys.forEach((p, pi) => {
    const pts = p.pts.map(([x, y]) => [x / 2, y / 2]);
    const ys = pts.map((q) => q[1]);
    for (let y = Math.max(0, Math.floor(Math.min(...ys))); y <= Math.min(IH - 1, Math.ceil(Math.max(...ys))); y++) {
      const sy = y + 0.5, xs: number[] = [];
      for (let i = 0; i < pts.length; i++) {
        const [a, b] = [pts[i], pts[(i + 1) % pts.length]];
        if ((a[1] > sy) !== (b[1] > sy)) xs.push(a[0] + ((sy - a[1]) * (b[0] - a[0])) / (b[1] - a[1]));
      }
      xs.sort((m, n) => m - n);
      for (let k = 0; k + 1 < xs.length; k += 2)
        for (let x = Math.max(0, Math.ceil(xs[k] - 0.5)); x <= Math.min(IW - 1, Math.floor(xs[k + 1] - 0.5)); x++) ids[y * IW + x] = pi;
    }
  });
  const seen = new Uint32Array(polys.length);
  for (const id of ids) if (id >= 0) seen[id]++;
  const kept = polys.filter((_, i) => seen[i] > 0);
  const s0 = project(toCam(startM, 0));
  // Street names keep off the route line, which is drawn over everything.
  const routeScr = round(routeRaw.map((p) => project(toCam(p, 0.5))));
  const routeAvoid: Box[] = [];
  for (let i = 1; i < routeScr.length; i++) {
    const [a, b] = [routeScr[i - 1], routeScr[i]], n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / 6));
    for (let j = 0; j <= n; j++) { const x = a[0] + ((b[0] - a[0]) * j) / n, y = a[1] + ((b[1] - a[1]) * j) / n; routeAvoid.push([x - 8, y - 8, x + 8, y + 8]); }
  }
  // Labels on what is visible: buildings at their topmost visible pixel,
  // streets on visible ground near their middle, the start at the route.
  const owner = (x: number, y: number) => { const i = ids[Math.floor(y / 2) * IW + Math.floor(x / 2)]; return i >= 0 ? polys[i].b : -9; };
  const labels: [string, number, number, number, number][] = [];   // text, x, y, angle, kind (0 street, 1 landmark, 2 dest, 3 start)
  const taken: Box[] = [];
  const tryLabel = (text: string, x: number, y: number, a: number, size: number, kind: number) => {
    const b = boxOf(text, x, y, size, a);
    if (b[0] < 4 || b[1] < 4 || b[2] > BW - 4 || b[3] > BH - 4 || taken.some((o) => hit(o, b))) return false;
    if (kind === 0 && routeAvoid.some((o) => hit(o, b))) return false;
    taken.push(b); labels.push([text, Math.round(x), Math.round(y), Math.round(a * 1000) / 1000, kind]);
    return true;
  };
  const visibleTop = (si: number): XY | null => {
    for (let y = 0; y < IH; y++) {
      let n = 0, sx = 0;
      for (let x = 0; x < IW; x++) { const i = ids[y * IW + x]; if (i >= 0 && polys[i].b === si) { n++; sx += x; } }
      if (n >= 3) return [(sx / n) * 2, y * 2];
    }
    return null;
  };
  const destIdx = solids.findIndex((s) => s.id === DEST_BUILDING);
  const dt = visibleTop(destIdx);
  if (!dt) throw new Error("bird's-eye: destination not visible");
  tryLabel('グランドシネマサンシャイン', dt[0], dt[1] - 72, 0, 40, 2);
  tryLabel('（グランドスケープ池袋）', dt[0], dt[1] - 22, 0, 30, 2);
  tryLabel('池袋駅 東口', s0[0] - 20, s0[1] + 34, 0, 34, 3) || tryLabel('池袋駅 東口', s0[0] - 20, s0[1] - 34, 0, 34, 3);
  solids.forEach((s, si) => {
    if (!s.name || si === destIdx) return;
    const t = visibleTop(si);
    if (t) tryLabel(s.name, t[0], t[1] - 22, 0, 32, 1);
  });
  const named = new Set<string>();
  const byDist = namedRoads.filter(([n]) => STREETS.includes(n))
    .map(([n, pts]) => ({ n, pts, d: Math.min(...pts.map((p) => Math.hypot(...local(p)))) })).sort((m, q) => m.d - q.d);
  for (const { n: name, pts } of byDist) {
    if (named.has(name)) continue;
    // The visible stretch of the road nearest the target, labelled along its screen direction.
    const cands = pts.filter(inRegion).map((p) => ({ p, d: Math.hypot(...local(p)) })).sort((m, n) => m.d - n.d);
    for (const { p } of cands.slice(0, 40)) {
      const i = pts.indexOf(p), q = pts[Math.min(pts.length - 1, i + 1)] === p ? pts[Math.max(0, i - 1)] : pts[i + 1];
      const [a, b] = [project(toCam(p, 0)), project(toCam(q, 0))];
      let ang = Math.atan2(b[1] - a[1], b[0] - a[0]);
      if (ang > Math.PI / 2) ang -= Math.PI; else if (ang <= -Math.PI / 2) ang += Math.PI;
      if (a[0] < 0 || a[0] > BW || a[1] < 0 || a[1] > BH || owner(a[0], a[1]) !== -1) continue;
      if (tryLabel(name, a[0], a[1], ang, 30, 0)) { named.add(name); break; }
    }
  }
  const runs: [number, string][] = [];
  for (const p of kept) {
    const d = pathOf([round(p.pts)], true);
    const last = runs[runs.length - 1];
    if (last && last[0] === p.c) last[1] += d; else runs.push([p.c, d]);
  }
  console.log(`bird's-eye: ${order.length} buildings, ${polys.length} polygons, ${kept.length} visible, ${runs.length} runs, labels ${labels.map((l) => l[0]).join(', ')}`);
  // The route again, on top of everything as a dashed line, because buildings
  // south of the street hide most of it from any view from the south.
  const end = project(toCam(goalXY, 0.5));
  return { w: BW, h: BH, palette: bpalette, polys: runs, labels, route: pathOf([routeScr], false), start: s0.map(Math.round), goal: end.map(Math.round) };
})();

// ---- Write ---------------------------------------------------------------
const minutes = Math.ceil(routeM / WALK_M_PER_MIN);
const out = {
  w: GRID, h: GRID,
  // Ground metres per grid unit, for the scale bar.
  m: Math.round(UNIT_M * 10000) / 10000,
  areas: Object.fromEntries(Object.entries(layer).map(([k, v]) => [k, pathOf(v, true)])),
  lines: Object.fromEntries(Object.entries(strokes).map(([k, v]) => [k, pathOf(v, false)])),
  route: pathOf([routeGrid], false),
  start: startG.map(Math.round),
  goal: grid(goalXY).map(Math.round),
  labels: placed,
  walk: { m: Math.round(routeM / 10) * 10, min: minutes, steps },
  // Where the views stand, for the numbered markers; the views themselves go
  // to views.json, fetched after the map is on screen.
  marks: views.map((v) => [...v.at, v.yaw]),
};
mkdirSync(OUT, { recursive: true });
const json = JSON.stringify(out);
writeFileSync(`${OUT}/map.json`, json);
const vjson = JSON.stringify({ w: VW, h: VH, horizon: HORIZON, palette, list: views.map(({ at: _a, yaw: _y, ...v }) => v) });
writeFileSync(`${OUT}/views.json`, vjson);
console.log(`views.json: ${vjson.length} bytes`);
const bjson = JSON.stringify(bird);
writeFileSync(`${OUT}/birdseye.json`, bjson);
console.log(`birdseye.json: ${bjson.length} bytes`);
const cinema = grid(pointOf(DEST_NODE));
console.log(`map.json: ${json.length} bytes; buildings ${layer.building.length} (${dropped} tiny dropped), labels ${placed.length}, walk ${out.walk.m} m / ${minutes} min, cinema node at ${cinema.map(Math.round)}`);
