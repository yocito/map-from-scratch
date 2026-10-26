// PLB1 (PLATEAU buildings v1): the archive this page reads by HTTP Range.
//
//   [0]      header, 128 B       magic, version, tile grid, origin and scales, sections, index CRC32
//   [128]    index, 56 B a tile  AABB (cm), per level: offset, length, indices, vertices, dropped
//                                triangles (and how many of those were in polygons under 100 cm2)
//   ground   u32 n, i32 z0 (cm), deflate-raw(zigzag delta u16 cm, n x n, row 0 south)
//   L0       exterior shells, one deflate-raw block per tile, tiles in Hilbert order
//   L1       building installations, same order; added to L0, never replacing it
//
// As in PMTiles, one read at the start (bytes 0-65535) brings the header,
// the index and the ground; blocks are then read by explicit ranges, merged
// when less than 32 KiB apart. A block is the Cesium quantized-mesh layout
// without its header (mesh.ts encodeBlock). The renderer gets it as u16
// positions and u16 indices, ready for the GPU.
export const MAGIC = 0x31424c50, VERSION = 1, HEAD = 128, ENTRY = 56, FIRST = 65536, GAP = 32768, PARALLEL = 6;

export interface Level { off: number; len: number; ni: number; nv: number; dropped: number }
export interface Tile { i: number; tx: number; ty: number; buildings: number; min: number[]; size: number[]; tiny: number; lv: Level[] }
export interface Header {
  nx: number; ny: number; tileSize: number; lat0: number; lon0: number; kx: number; ky: number; half: number;
  ground: [number, number]; sections: [number, number][]; crc: number; tiles: Tile[];
}
export interface Mesh { q: Uint16Array; idx: Uint16Array; nv: number }
export interface Ground { n: number; z0: number; h: Uint16Array }

let table: Int32Array | null = null;
export function crc32(b: Uint8Array): number {
  if (!table) {
    table = new Int32Array(256);
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; table[n] = c; }
  }
  let c = -1;
  for (let i = 0; i < b.length; i++) c = table[(c ^ b[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

export function parseHeader(b: Uint8Array): Header {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  if (dv.getUint32(0, true) !== MAGIC || dv.getUint32(4, true) !== VERSION) throw new Error('not a PLB1 archive');
  const n = dv.getUint32(8, true), u = (o: number) => dv.getUint32(o, true);
  const h: Header = {
    nx: dv.getUint16(12, true), ny: dv.getUint16(14, true), tileSize: dv.getFloat64(16, true),
    lat0: dv.getFloat64(24, true), lon0: dv.getFloat64(32, true), kx: dv.getFloat64(40, true), ky: dv.getFloat64(48, true), half: dv.getFloat64(56, true),
    ground: [u(72), u(76)], sections: [[u(80), u(84)], [u(88), u(92)]], crc: u(96), tiles: [],
  };
  if (crc32(b.subarray(HEAD, HEAD + n * ENTRY)) !== h.crc) throw new Error('PLB1 index CRC mismatch');
  for (let i = 0; i < n; i++) {
    const o = HEAD + i * ENTRY;
    const lv = (p: number): Level => ({ off: u(p), len: u(p + 4), ni: u(p + 8), nv: dv.getUint16(p + 12, true), dropped: dv.getUint16(p + 14, true) });
    h.tiles.push({
      i, tx: b[o], ty: b[o + 1], buildings: dv.getUint16(o + 2, true),
      min: [dv.getInt32(o + 4, true), dv.getInt32(o + 8, true), dv.getInt32(o + 12, true)],
      size: [dv.getUint16(o + 16, true), dv.getUint16(o + 18, true), dv.getUint16(o + 20, true)], tiny: dv.getUint16(o + 22, true),
      lv: [lv(o + 24), lv(o + 40)],
    });
  }
  return h;
}

export async function inflate(b: Uint8Array): Promise<Uint8Array> {
  const s = new ReadableStream<Uint8Array<ArrayBuffer>>({ start(c) { c.enqueue(b as Uint8Array<ArrayBuffer>); c.close(); } })
    .pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(s).arrayBuffer());
}

// Undo mesh.ts encodeBlock: positions back to interleaved u16 x, y, z.
export function decodeBlock(b: Uint8Array): Mesh {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const nv = dv.getUint32(0, true), ni = dv.getUint32(4, true);
  const q = new Uint16Array(3 * nv), idx = new Uint16Array(ni);
  let p = 8;
  for (let k = 0; k < 3; k++) {
    for (let i = 0, v = 0; i < nv; i++, p += 2) {
      const z = dv.getUint16(p, true);
      v = (v + ((z >>> 1) ^ -(z & 1))) & 0xffff;
      q[3 * i + k] = v;
    }
  }
  for (let i = 0, hi = 0; i < ni; i++, p += 2) {
    const c = dv.getUint16(p, true);
    idx[i] = hi - c;
    if (c === 0) hi++;
  }
  return { q, idx, nv };
}

export function decodeGround(raw: Uint8Array, head: Uint8Array): Ground {
  const dv = new DataView(head.buffer, head.byteOffset, 8), n = dv.getUint32(0, true), h = new Uint16Array(n * n);
  const z = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  for (let i = 0, v = 0; i < n * n; i++) { const c = z.getUint16(2 * i, true); v = (v + ((c >>> 1) ^ -(c & 1))) & 0xffff; h[i] = v; }
  return { n, z0: dv.getInt32(4, true), h };
}

// One logged response, for the range-206 check.
export interface Got { want: string; status: number; range: string | null; encoding: string | null; bytes: number }

// The archive over HTTP. Counts its own requests and bytes as they arrive
// (the page's range_requests / range_bytes). A server that answers a Range request with
// 200 has sent the whole file: it is then used from memory.
export class Archive {
  url: string;
  whole: Uint8Array | null = null;
  head: Uint8Array | null = null;
  requests = 0;
  bytes = 0;
  log: Got[] = [];
  constructor(url: string) { this.url = url; }

  private async get(a: number, b: number | null): Promise<Uint8Array> {
    const want = b === null ? '' : `bytes=${a}-${b}`;
    const r = await fetch(this.url, want ? { headers: { Range: want } } : {});
    const body = new Uint8Array(await r.arrayBuffer());
    this.requests++;
    this.bytes += body.byteLength;
    this.log.push({ want, status: r.status, range: r.headers.get('content-range'), encoding: r.headers.get('content-encoding'), bytes: body.byteLength });
    if (!r.ok) throw new Error(`${this.url}: HTTP ${r.status}`);
    if (r.status === 200) { this.whole = body; return want ? body.subarray(a, b! + 1) : body; }
    return body;
  }

  // whole: read the file in one request instead (the ?whole=1 comparison).
  async open(whole = false): Promise<Header> {
    this.head = whole ? await this.get(0, null) : await this.get(0, FIRST - 1);
    const h = parseHeader(this.head);
    if (h.ground[0] + h.ground[1] > this.head.byteLength) this.head = await this.range(0, h.ground[0] + h.ground[1]);
    return h;
  }

  // Bytes [a, b) from memory when they are there, else by one Range request.
  async range(a: number, b: number): Promise<Uint8Array> {
    if (this.whole) return this.whole.subarray(a, b);
    const head = this.head?.byteLength ?? 0;
    if (b <= head) return this.head!.subarray(a, b);
    if (a >= head) return this.get(a, b - 1);
    const out = new Uint8Array(b - a);          // starts inside the first read
    out.set(this.head!.subarray(a));
    out.set(await this.get(head, b - 1), head - a);
    return out;
  }
}

// Which blocks to read next. want() gets the blocks the view needs, in
// priority order (all L0 nearest first, then L1); the queue is replaced, so
// blocks that left the view are dropped before they are sent. Up to PARALLEL
// requests at once; neighbours in the file closer than GAP join the range,
// and every block wholly inside a range is decoded.
export class Loader {
  ar: Archive;
  h: Header;
  state: Uint8Array;        // per block (tile * 2 + level): 0 not asked, 1 in flight, 2 decoded
  queue: number[] = [];
  inflight = 0;
  private busy0 = 0;        // L0 requests in flight: L1 waits for them, so the shells come first
  onBlock: (tile: number, level: number, m: Mesh) => void;
  constructor(ar: Archive, h: Header, onBlock: (tile: number, level: number, m: Mesh) => void) {
    this.ar = ar; this.h = h; this.onBlock = onBlock;
    this.state = new Uint8Array(h.tiles.length * 2);
    this.reset();
  }
  reset(): void {
    this.state.fill(0);
    this.h.tiles.forEach((t, i) => { for (let l = 0; l < 2; l++) if (t.lv[l].len === 0) this.state[2 * i + l] = 2; });
    this.queue = [];
  }
  want(blocks: number[]): void {
    this.queue = blocks.filter((k) => this.state[k] === 0);
    this.pump();
  }
  private pump(): void {
    while (this.inflight < PARALLEL && this.queue.length) {
      if ((this.queue[0] & 1) === 1 && this.busy0 > 0) return;
      const first = this.queue.shift()!;
      const lvOf = (k: number) => this.h.tiles[k >> 1].lv[k & 1];
      // Blocks of the same level in file order; grow the range both ways.
      const same = this.h.tiles.map((_, i) => 2 * i + (first & 1)).sort((a, b) => lvOf(a).off - lvOf(b).off);
      let i0 = same.indexOf(first), i1 = i0;
      const queued = (k: number) => this.state[k] === 0 && this.queue.includes(k);
      const near = (a: number, b: number) => lvOf(b).off - (lvOf(a).off + lvOf(a).len) < GAP;
      for (let j = i1 + 1; j < same.length; j++) {
        if (!near(same[i1], same[j])) break;
        if (queued(same[j])) i1 = j; else if (this.state[same[j]] !== 0 && lvOf(same[j]).len) break;
      }
      for (let j = i0 - 1; j >= 0; j--) {
        if (!near(same[j], same[i0])) break;
        if (queued(same[j])) i0 = j; else if (this.state[same[j]] !== 0 && lvOf(same[j]).len) break;
      }
      const run = same.slice(i0, i1 + 1).filter((k) => this.state[k] === 0);
      for (const k of run) this.state[k] = 1;
      this.queue = this.queue.filter((k) => this.state[k] === 0);
      const a = lvOf(same[i0]).off, b = lvOf(same[i1]).off + lvOf(same[i1]).len;
      this.inflight++;
      const l0 = (first & 1) === 0;
      if (l0) this.busy0++;
      this.ar.range(a, b).then(async (bytes) => {
        await Promise.all(run.map(async (k) => {
          const l = lvOf(k);
          this.onBlock(k >> 1, k & 1, decodeBlock(await inflate(bytes.subarray(l.off - a, l.off - a + l.len))));
          this.state[k] = 2;
        }));
      }).finally(() => { this.inflight--; if (l0) this.busy0--; this.pump(); });
    }
  }
}
