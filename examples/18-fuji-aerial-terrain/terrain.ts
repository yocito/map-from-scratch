// The .terr format of 17 (see bake.ts for the byte layout), its Rice coder,
// the orbit camera and the LOD selection. Pure functions of bytes and
// numbers, no DOM: bake.ts counts the original format's cost with the same
// selection, and a Node test can drive the reader from the local file
// (data-range-requests skill: keep the format reader a function of bytes).

export const CS = 128;                 // cells per chunk side
export const S = CS + 3;               // samples per chunk side: vertices 0..128 and one border sample each side
export const LEVELS = 4;
export const N0 = 3072;                // L0 samples per side of the area (6x6 z12 tiles of 512)
export const HEADER_BYTES = 64, ENTRY_BYTES = 8;
export const FIRST_BYTES = 98304;      // first request: header, index, all of L3 (95.6 KB) and the start of L2
export const FOV_Y = 40;               // degrees, vertical
export const R_EFF = 6371000 / (1 - 0.13);   // earth radius with standard refraction, for the curvature drop

export interface Chunk { k: number; i: number; j: number; off: number; len: number; hmin: number; hmax: number; skirt: number }
export interface Terr {
  x0: number; y0: number;              // area origin in global z12 pixels (512 px tiles)
  cell: number;                        // L0 sample spacing on the ground, m
  lat0: number; lon0: number; q0: number; block: number;
  chunks: Chunk[];                     // in file order
  ids: Int32Array[];                   // per level: i * perSide + j -> index into chunks
}

export const perSide = (k: number): number => (N0 / CS) >> k;   // 24, 12, 6, 3

function morton(i: number, j: number): number {
  let m = 0;
  for (let b = 0; b < 8; b++) m |= (((j >> b) & 1) << (2 * b)) | (((i >> b) & 1) << (2 * b + 1));
  return m;
}

// Coarse levels first (L3 .. L0), Morton order within a level.
export function fileOrder(): [number, number, number][] {
  const out: [number, number, number][] = [];
  for (let k = LEVELS - 1; k >= 0; k--) {
    const n = perSide(k), cells: number[][] = [];
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) cells.push([morton(i, j), i, j]);
    cells.sort((a, b) => a[0] - b[0]);
    for (const [, i, j] of cells) out.push([k, i, j]);
  }
  return out;
}

// Header (64 B, little endian) and index (8 B per chunk). Offsets are the
// running sum of the lengths in file order, so they are not stored.
export function parseTerr(u8: Uint8Array): Terr {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  if (String.fromCharCode(...u8.subarray(0, 4)) !== 'MFST' || dv.getUint16(4, true) !== 1) throw new Error('not a .terr v1 file');
  if (dv.getUint16(6, true) !== CS || u8[8] !== 1 || u8[9] !== LEVELS) throw new Error('.terr: unexpected chunk layout');
  const n = dv.getUint16(10, true);
  const t: Terr = {
    x0: dv.getUint32(12, true), y0: dv.getUint32(16, true), block: u8[20],
    cell: dv.getFloat64(24, true), lat0: dv.getFloat64(32, true), lon0: dv.getFloat64(40, true), q0: dv.getFloat32(48, true),
    chunks: [], ids: Array.from({ length: LEVELS }, (_, k) => new Int32Array(perSide(k) ** 2)),
  };
  let off = HEADER_BYTES + ENTRY_BYTES * n;
  fileOrder().forEach(([k, i, j], c) => {
    const e = HEADER_BYTES + ENTRY_BYTES * c, len = dv.getUint16(e, true);
    t.chunks.push({ k, i, j, off, len, hmin: dv.getUint16(e + 2, true) / 4, hmax: dv.getUint16(e + 4, true) / 4, skirt: u8[e + 6] * 2 });
    t.ids[k][i * perSide(k) + j] = c;
    off += len;
  });
  if (t.chunks.length !== n) throw new Error('.terr: chunk count mismatch');
  return t;
}

// Planar prediction a + b - c (left, above, above-left); the first row
// predicts from the left, the first column from above, the first sample is
// the u16 base. Residuals are zigzagged and Rice-coded, with a 4-bit k per
// block of 32 samples.
const predict = (o: ArrayLike<number>, r: number, c: number, base: number): number => {
  const t = r * S + c;
  return r && c ? o[t - 1] + o[t - S] - o[t - S - 1] : r ? o[t - S] : c ? o[t - 1] : base;
};

export function encodeChunk(q: ArrayLike<number>, block = 32): Uint8Array {
  const n = S * S, z = new Uint32Array(n);
  for (let r = 0, t = 0; r < S; r++) for (let c = 0; c < S; c++, t++) {
    const d = q[t] - predict(q, r, c, q[0]);
    z[t] = d >= 0 ? 2 * d : -2 * d - 1;
  }
  const out = new Uint8Array(2 + n * 8);
  out[0] = q[0] & 255; out[1] = q[0] >> 8;
  let pos = 16;
  const put = (v: number, bits: number) => {
    for (let b = bits - 1; b >= 0; b--, pos++) if ((v >> b) & 1) out[pos >> 3] |= 0x80 >> (pos & 7);
  };
  for (let s = 0; s < n; s += block) {
    const e = Math.min(n, s + block);
    let best = 0, cost = Infinity;
    for (let k = 0; k < 15; k++) {
      let c = 0;
      for (let t = s; t < e; t++) c += (z[t] >>> k) + 1 + k;
      if (c < cost) { cost = c; best = k; }
    }
    put(best, 4);
    for (let t = s; t < e; t++) {
      pos += z[t] >>> best;                       // unary: zeros, then a one
      out[pos >> 3] |= 0x80 >> (pos & 7);
      pos++;
      put(z[t] & ((1 << best) - 1), best);
    }
  }
  return out.slice(0, (pos + 7) >> 3);
}

// A 32-bit window refilled a byte at a time; Math.clz32 finds the end of the
// unary part. 0.22 ms per chunk in Node 24 (79 M samples/s).
export function decodeChunk(src: Uint8Array, out: Uint16Array, block = 32): void {
  const base = src[0] | (src[1] << 8);
  let p = 2, win = 0, avail = 0, k = 0;
  for (let r = 0, t = 0; r < S; r++) for (let c = 0; c < S; c++, t++) {
    while (avail <= 24) { win |= (src[p++] | 0) << (24 - avail); avail += 8; }
    if (t % block === 0) { k = win >>> 28; win <<= 4; avail -= 4; }
    let u = 0;
    while (win === 0) {
      u += avail; avail = 0;
      while (avail <= 24) { win |= (src[p++] | 0) << (24 - avail); avail += 8; }
    }
    const lz = Math.clz32(win);
    u += lz;
    win = lz === 31 ? 0 : win << (lz + 1);
    avail -= lz + 1;
    while (avail <= 24) { win |= (src[p++] | 0) << (24 - avail); avail += 8; }
    let zz = u << k;
    if (k) { zz |= win >>> (32 - k); win <<= k; avail -= k; }
    out[t] = predict(out, r, c, base) + ((zz >>> 1) ^ -(zz & 1));
  }
}

// ---- camera ---------------------------------------------------------------
// World: metres from the area centre, x east, y north, z up. The Mercator
// grid is used at the centre's scale (error <= 0.27%, <= 65 m at the corners).
export interface Cam { tx: number; ty: number; tz: number; yaw: number; pitch: number; dist: number }
export interface View {
  eye: number[]; fwd: number[]; right: number[]; up: number[];
  f: number; w: number; h: number; near: number; far: number; m: Float32Array;
}

const sub = (a: number[], b: number[]) => a.map((v, i) => v - b[i]);
const dot = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: number[], b: number[]) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a: number[]) => { const l = Math.hypot(a[0], a[1], a[2]); return a.map((v) => v / l); };

// ground(x, y): an upper bound of the terrain under a point; the eye stays
// 150 m above it (animation-and-camera and terrain skills: keep the camera
// above ground, cap the pitch).
export function makeView(c: Cam, w: number, h: number, ground: (x: number, y: number) => number): View {
  const yaw = (c.yaw * Math.PI) / 180, pitch = (c.pitch * Math.PI) / 180;
  const fwd0 = [Math.sin(yaw) * Math.cos(pitch), Math.cos(yaw) * Math.cos(pitch), -Math.sin(pitch)];
  const eye = [c.tx - fwd0[0] * c.dist, c.ty - fwd0[1] * c.dist, c.tz - fwd0[2] * c.dist];
  eye[2] = Math.max(eye[2], ground(eye[0], eye[1]) + 150);
  const fwd = norm(sub([c.tx, c.ty, c.tz], eye));
  const right = norm(cross(fwd, [0, 0, 1])), up = cross(right, fwd);
  const near = Math.min(500, Math.max(30, 0.005 * c.dist)), far = c.dist + 80000;
  const fy = 1 / Math.tan(((FOV_Y / 2) * Math.PI) / 180), fx = fy * h / w;
  // viewProj = P * V, column-major. V rows: right, up, -fwd.
  const rows = [right.map((v) => v * fx), up.map((v) => v * fy)];
  const za = (far + near) / (near - far), zb = (2 * far * near) / (near - far);
  const m = new Float32Array(16);
  for (let col = 0; col < 3; col++) {
    m[col * 4] = rows[0][col]; m[col * 4 + 1] = rows[1][col];
    m[col * 4 + 2] = -fwd[col] * za; m[col * 4 + 3] = fwd[col];
  }
  m[12] = -dot(rows[0], eye); m[13] = -dot(rows[1], eye);
  m[14] = dot(fwd, eye) * za + zb; m[15] = -dot(fwd, eye);
  return { eye, fwd, right, up, f: (h / 2) * fy, w, h, near, far, m };
}

// Upper bound of the terrain at (x, y): hmax of the L0 chunk there (from the
// index, so it is known before any chunk is decoded). Outside the area, the
// nearest chunk.
export function groundMax(t: Terr, x: number, y: number): number {
  const cl = (v: number) => Math.min(N0 / CS - 1, Math.max(0, Math.floor(v / CS)));
  return t.chunks[t.ids[0][cl(N0 / 2 - y / t.cell) * perSide(0) + cl(x / t.cell + N0 / 2)]].hmax;
}

// Screen position (device px, y down) of a world point, or null behind the eye.
export function project(v: View, p: number[]): [number, number] | null {
  const d = sub(p, v.eye), z = dot(d, v.fwd);
  if (z <= v.near) return null;
  return [v.w / 2 + (dot(d, v.right) * v.f) / z, v.h / 2 - (dot(d, v.up) * v.f) / z];
}

// Ground footprint of a chunk: interior vertex u sits at (j*128 + u + 0.5) * 2^k
// L0 px, on a sample centre; the edge vertices sit on j*128 * 2^k and
// (j+1)*128 * 2^k (gl.ts), so the footprint is exactly the chunk's square.
export function vertexPos(u: number): number { return u === 0 ? 0 : u === CS ? CS : u + 0.5; }
function chunkBox(t: Terr, ch: Chunk): number[] {
  const s = 2 ** ch.k, px = (u: number) => (u * s - N0 / 2) * t.cell;
  return [px(ch.j * CS), px(ch.j * CS + CS), -px(ch.i * CS + CS), -px(ch.i * CS)];   // x0, x1, y0, y1
}

// ---- LOD selection ----------------------------------------------------------
// Quadtree from the nine L3 roots. A chunk is culled when all eight corners of
// its box (baked hmin/hmax, lowered by the curvature drop) are outside one
// frustum plane; it is refined while one of its cells, at the distance of its
// box, is wider than tau px (tile-lod-and-overzoom: SSE from the vertical
// FOV, distance to the box). Replacement refinement (3d-tiles-and-hlod): a
// node whose visible wanted descendants are not all loaded is drawn itself,
// so nothing overlaps and nothing is missing. L3 is always loaded.
// uncovered: L3 chunks in view with nothing loaded to draw for them (part
// of the view is empty); 0 once the first request's L3 is decoded.
export interface Selection { draw: number[]; want: number[]; fallback: number; uncovered: number; dist: Float64Array }

export function select(t: Terr, v: View, tau: number, loaded: (id: number) => boolean): Selection {
  const sel: Selection = { draw: [], want: [], fallback: 0, uncovered: 0, dist: new Float64Array(t.chunks.length) };
  const tanY = Math.tan(((FOV_Y / 2) * Math.PI) / 180), tanX = (tanY * v.w) / v.h;
  const corner = [0, 0, 0];
  const visit = (k: number, i: number, j: number): number[] | null => {
    const id = t.ids[k][i * perSide(k) + j], ch = t.chunks[id];
    const [x0, x1, y0, y1] = chunkBox(t, ch);
    const dx = Math.max(Math.abs(x0 - v.eye[0]), Math.abs(x1 - v.eye[0])), dy = Math.max(Math.abs(y0 - v.eye[1]), Math.abs(y1 - v.eye[1]));
    const z0 = ch.hmin - ch.skirt - (dx * dx + dy * dy) / (2 * R_EFF), z1 = ch.hmax;
    let out = [0, 0, 0, 0, 0];   // corners behind the near plane, left, right, below, above
    for (let c = 0; c < 8; c++) {
      corner[0] = (c & 1 ? x1 : x0) - v.eye[0]; corner[1] = (c & 2 ? y1 : y0) - v.eye[1]; corner[2] = (c & 4 ? z1 : z0) - v.eye[2];
      const zc = dot(corner, v.fwd), xc = dot(corner, v.right), yc = dot(corner, v.up);
      if (zc < v.near) out[0]++;
      if (xc < -tanX * zc) out[1]++;
      if (xc > tanX * zc) out[2]++;
      if (yc < -tanY * zc) out[3]++;
      if (yc > tanY * zc) out[4]++;
    }
    if (out.includes(8)) return [];
    const cx = Math.min(Math.max(v.eye[0], x0), x1) - v.eye[0], cy = Math.min(Math.max(v.eye[1], y0), y1) - v.eye[1];
    const cz = Math.min(Math.max(v.eye[2], z0), z1) - v.eye[2];
    const d = Math.max(Math.hypot(cx, cy, cz), 1);
    sel.dist[id] = d;
    if (k > 0 && (t.cell * 2 ** k * v.f) / d > tau) {
      const parts: number[][] = [];
      let missing = false;
      for (let c = 0; c < 4; c++) {
        const p = visit(k - 1, 2 * i + (c >> 1), 2 * j + (c & 1));
        if (p) parts.push(p); else missing = true;
      }
      if (!missing) return parts.flat();
      sel.fallback++;
      return loaded(id) ? [id] : null;
    }
    sel.want.push(id);
    return loaded(id) ? [id] : null;
  };
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
    const d = visit(LEVELS - 1, i, j);
    if (d) sel.draw.push(...d); else sel.uncovered++;
  }
  sel.draw.sort((a, b) => sel.dist[a] - sel.dist[b]);   // near to far, for early depth rejection
  return sel;
}

// Byte ranges for the chunks to fetch: sorted by offset, merged across gaps
// of up to `gap` bytes (the bytes in a gap are fetched and thrown away).
export function ranges(t: Terr, ids: number[], gap = 8192): { start: number; end: number; ids: number[] }[] {
  const out: { start: number; end: number; ids: number[] }[] = [];
  for (const id of [...ids].sort((a, b) => a - b)) {
    const { off, len } = t.chunks[id], last = out[out.length - 1];
    if (last && off - last.end <= gap) { last.end = Math.max(last.end, off + len); last.ids.push(id); }
    else out.push({ start: off, end: off + len, ids: [id] });
  }
  return out;
}

// The tile of the original Mapterhorn pyramid that holds a chunk's samples:
// level k is zoom 12 - k, and a 512 px tile holds 4x4 chunks exactly.
export function origTile(t: Terr, ch: Chunk): [number, number, number] {
  return [12 - ch.k, ((t.x0 >> ch.k) + ch.j * CS) >> 9, ((t.y0 >> ch.k) + ch.i * CS) >> 9];
}
