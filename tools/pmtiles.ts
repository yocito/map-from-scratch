// PMTiles v3 reader for bake time: reads byte ranges of a local file, so a
// 664 GB archive costs only the directories and tiles that are asked for.
// Spec: github.com/protomaps/PMTiles/blob/main/spec/v3/spec.md
// The Hilbert tile id and the directory decoding follow ortho-earth
// (packages/geopbf/src/convert/pmtiles.ts, GPL-3.0-or-later).
import { openSync, readSync, closeSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';

export interface Header {
  rootOff: number; rootLen: number; metaOff: number; metaLen: number;
  leafOff: number; leafLen: number; dataOff: number; dataLen: number;
  internalCompression: number; tileCompression: number; tileType: number;
  minZoom: number; maxZoom: number;
  bounds: [number, number, number, number];   // w, s, e, n
  center: [number, number, number];           // lon, lat, zoom
}

export interface Entry { tileId: number; offset: number; length: number; runLength: number }

// tile type codes of the spec
export const TILE_TYPE: Record<number, string> = { 0: 'unknown', 1: 'mvt', 2: 'png', 3: 'jpeg', 4: 'webp', 5: 'avif' };

const TZ = [0, 1, 5, 21, 85, 341, 1365, 5461, 21845, 87381, 349525, 1398101, 5592405, 22369621, 89478485, 357913941,
  1431655765, 5726623061, 22906492245, 91625968981, 366503875925, 1466015503701, 5864062014805, 23456248059221,
  93824992236885, 375299968947541, 1501199875790165];

export function zxyToTileId(z: number, x: number, y: number): number {
  if (z > 26) throw new Error('pmtiles: zoom > 26');
  const n = 2 ** z;
  if (x < 0 || y < 0 || x >= n || y >= n) throw new Error(`pmtiles: tile ${z}/${x}/${y} out of range`);
  let d = 0, xx = x, yy = y;
  for (let s = n / 2; s >= 1; s /= 2) {
    const rx = (xx & s) ? 1 : 0, ry = (yy & s) ? 1 : 0;
    d += s * s * ((3 * rx) ^ ry);
    if (ry === 0) {
      if (rx === 1) { xx = s - 1 - xx; yy = s - 1 - yy; }
      const t = xx; xx = yy; yy = t;
    }
  }
  return TZ[z] + d;
}

function readVarint(u8: Uint8Array, p: { pos: number }): number {
  let v = 0, shift = 1, b: number;
  do {
    b = u8[p.pos++];
    v += (b & 0x7f) * shift;
    shift *= 128;
  } while (b & 0x80);
  return v;
}

export function deserializeDirectory(u8: Uint8Array): Entry[] {
  const p = { pos: 0 }, n = readVarint(u8, p), entries: Entry[] = [];
  let last = 0;
  for (let i = 0; i < n; i++) { last += readVarint(u8, p); entries.push({ tileId: last, offset: 0, length: 0, runLength: 0 }); }
  for (let i = 0; i < n; i++) entries[i].runLength = readVarint(u8, p);
  for (let i = 0; i < n; i++) entries[i].length = readVarint(u8, p);
  for (let i = 0; i < n; i++) {
    const v = readVarint(u8, p);
    entries[i].offset = v === 0 && i > 0 ? entries[i - 1].offset + entries[i - 1].length : v - 1;
  }
  return entries;
}

export class PMTiles {
  readonly header: Header;
  private fd: number;
  private dirs = new Map<number, Entry[]>();   // offset of a directory -> its entries
  bytesRead = 0;                               // what a reader over HTTP would have fetched

  constructor(path: string) {
    this.fd = openSync(path, 'r');
    const h = this.read(0, 127), dv = new DataView(h.buffer, h.byteOffset, 127);
    if (String.fromCharCode(...h.subarray(0, 7)) !== 'PMTiles' || h[7] !== 3) throw new Error(`${path}: not PMTiles v3`);
    const u64 = (o: number) => Number(dv.getBigUint64(o, true));
    const e7 = (o: number) => dv.getInt32(o, true) / 1e7;
    this.header = {
      rootOff: u64(8), rootLen: u64(16), metaOff: u64(24), metaLen: u64(32),
      leafOff: u64(40), leafLen: u64(48), dataOff: u64(56), dataLen: u64(64),
      internalCompression: h[97], tileCompression: h[98], tileType: h[99],
      minZoom: h[100], maxZoom: h[101],
      bounds: [e7(102), e7(106), e7(110), e7(114)],
      center: [e7(119), e7(123), h[118]],
    };
  }

  read(offset: number, length: number): Uint8Array {
    const buf = new Uint8Array(length);
    let got = 0;
    while (got < length) {
      const n = readSync(this.fd, buf, got, length - got, offset + got);
      if (n === 0) throw new Error(`pmtiles: short read at ${offset + got}`);
      got += n;
    }
    this.bytesRead += length;
    return buf;
  }

  // internal compression: 1 none, 2 gzip (the others are not used by our archives)
  private inflate(u8: Uint8Array, code: number): Uint8Array {
    if (code === 1 || code === 0) return u8;
    if (code === 2) return new Uint8Array(gunzipSync(u8));
    throw new Error(`pmtiles: compression ${code} not supported`);
  }

  metadata(): Record<string, unknown> {
    const { metaOff, metaLen, internalCompression } = this.header;
    return JSON.parse(new TextDecoder().decode(this.inflate(this.read(metaOff, metaLen), internalCompression)));
  }

  private directory(offset: number, length: number): Entry[] {
    let d = this.dirs.get(offset);
    if (!d) {
      d = deserializeDirectory(this.inflate(this.read(offset, length), this.header.internalCompression));
      this.dirs.set(offset, d);
    }
    return d;
  }

  // Where tile z/x/y is stored (absolute offset and length), or null when absent.
  locate(z: number, x: number, y: number): { offset: number; length: number } | null {
    const id = zxyToTileId(z, x, y);
    let off = this.header.rootOff, len = this.header.rootLen;
    for (let depth = 0; depth < 4; depth++) {
      const entries = this.directory(off, len);
      let lo = 0, hi = entries.length - 1, hit = -1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (entries[mid].tileId <= id) { hit = mid; lo = mid + 1; } else hi = mid - 1;
      }
      if (hit < 0) return null;
      const e = entries[hit];
      if (e.runLength === 0) { off = this.header.leafOff + e.offset; len = e.length; continue; }   // leaf directory
      if (id - e.tileId >= e.runLength) return null;
      return { offset: this.header.dataOff + e.offset, length: e.length };
    }
    throw new Error('pmtiles: directories nested too deep');
  }

  // The tile as stored (still tile-compressed for vector tiles).
  tile(z: number, x: number, y: number): Uint8Array | null {
    const at = this.locate(z, x, y);
    return at ? this.read(at.offset, at.length) : null;
  }

  close(): void {
    closeSync(this.fd);
  }
}
