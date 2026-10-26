// Reading a ZIP (with ZIP64) by byte ranges, as pure functions on bytes.
// The bake (Node, from the local file) and the ?citygml=1 page mode (fetch
// with Range) share it: each step says which range it needs next.
//   1. tail = the last TAIL bytes          -> endRecord(tail, size)
//   2. the central directory (cdOff, cdLen) -> entries(cd)
//   3. per member: header + compressed body -> dataStart(bytes)
// A deflated member cannot be entered in the middle, so one member (one
// 1 km mesh of PLATEAU buildings) is the smallest unit that can be read.
export const TAIL = 65536;

export interface End { cdOff: number; cdLen: number; count: number }
export interface Entry { name: string; method: number; crc: number; compSize: number; size: number; headerOff: number; extraLen: number }

// u64 little-endian as a Number (exact below 2^53, which any file here is).
const u64 = (dv: DataView, o: number): number => dv.getUint32(o, true) + dv.getUint32(o + 4, true) * 2 ** 32;

// The end-of-central-directory record, and its ZIP64 twin when the classic
// fields are saturated. size: the whole file's length; tail: its last bytes.
export function endRecord(tail: Uint8Array, size: number): End {
  const dv = new DataView(tail.buffer, tail.byteOffset, tail.byteLength);
  let i = tail.byteLength - 22;
  while (i >= 0 && dv.getUint32(i, true) !== 0x06054b50) i--;
  if (i < 0) throw new Error('zip: no end of central directory in the tail');
  let end: End = { cdOff: dv.getUint32(i + 16, true), cdLen: dv.getUint32(i + 12, true), count: dv.getUint16(i + 10, true) };
  if (end.cdOff === 0xffffffff || end.cdLen === 0xffffffff || end.count === 0xffff) {
    const loc = i - 20;
    if (loc < 0 || dv.getUint32(loc, true) !== 0x07064b50) throw new Error('zip: ZIP64 locator missing');
    const at = u64(dv, loc + 8) - (size - tail.byteLength);   // the ZIP64 record, inside the tail
    if (at < 0 || dv.getUint32(at, true) !== 0x06064b50) throw new Error('zip: ZIP64 end record outside the tail');
    end = { count: u64(dv, at + 32), cdLen: u64(dv, at + 40), cdOff: u64(dv, at + 48) };
  }
  return end;
}

// Every entry of the central directory, with ZIP64 sizes and offsets.
export function entries(cd: Uint8Array): Entry[] {
  const dv = new DataView(cd.buffer, cd.byteOffset, cd.byteLength);
  const dec = new TextDecoder();
  const out: Entry[] = [];
  for (let p = 0; p + 46 <= cd.byteLength && dv.getUint32(p, true) === 0x02014b50;) {
    const nameLen = dv.getUint16(p + 28, true), extraLen = dv.getUint16(p + 30, true), commentLen = dv.getUint16(p + 32, true);
    const e: Entry = {
      name: dec.decode(cd.subarray(p + 46, p + 46 + nameLen)), method: dv.getUint16(p + 10, true), crc: dv.getUint32(p + 16, true),
      compSize: dv.getUint32(p + 20, true), size: dv.getUint32(p + 24, true), headerOff: dv.getUint32(p + 42, true), extraLen,
    };
    // ZIP64 extra field: the saturated values follow, in this order.
    for (let x = p + 46 + nameLen; x + 4 <= p + 46 + nameLen + extraLen;) {
      const id = dv.getUint16(x, true), len = dv.getUint16(x + 2, true);
      if (id === 1) {
        let q = x + 4;
        if (e.size === 0xffffffff) { e.size = u64(dv, q); q += 8; }
        if (e.compSize === 0xffffffff) { e.compSize = u64(dv, q); q += 8; }
        if (e.headerOff === 0xffffffff) e.headerOff = u64(dv, q);
      }
      x += 4 + len;
    }
    out.push(e);
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

// The local header's own name and extra lengths can differ from the central
// directory's, so a reader asks for SLACK more and finds the body here.
export const SLACK = 1024;
export const memberRange = (e: Entry): [number, number] => [e.headerOff, e.headerOff + 30 + e.name.length * 3 + e.extraLen + SLACK + e.compSize];
export function dataStart(local: Uint8Array): number {
  const dv = new DataView(local.buffer, local.byteOffset, local.byteLength);
  if (dv.getUint32(0, true) !== 0x04034b50) throw new Error('zip: bad local header');
  return 30 + dv.getUint16(26, true) + dv.getUint16(28, true);
}

// The building GML of a third-level mesh, e.g. udx/bldg/53394611_bldg_6697_op.gml.
export const meshOf = (name: string): string | null => name.match(/^udx\/bldg\/(\d{8})_bldg_6697(?:_\w+)?_op\.gml$/)?.[1] ?? null;
