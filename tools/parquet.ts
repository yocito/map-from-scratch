// Bake-time Parquet reader: the footer, row-group pruning by column
// statistics, and flat columns (no repeated fields) of INT32, INT64, DOUBLE
// and BYTE_ARRAY in PLAIN or dictionary encoding, uncompressed or Zstd, data
// pages v1 and v2. That is what DuckDB writes for the osm2pgsql GeoParquet
// files of yuiseki/osm-tokyo23-src-2026-08, read by HTTP Range so a bake
// fetches only the row groups that touch its area. Thrift and Zstd are the
// from-scratch kits in kits/geoparquet. Field ids follow parquet.thrift
// (github.com/apache/parquet-format/blob/master/src/main/thrift/parquet.thrift).
import { readStruct, type TStruct } from '../kits/geoparquet/thrift.ts';
import { zstdDecompress } from '../kits/geoparquet/zstd.ts';

export type Range = (offset: number, length: number) => Promise<Uint8Array>;
export type Value = number | Uint8Array | null;

export interface Column {
  path: string;       // dotted path, e.g. "bbox.xmin"
  type: number;       // physical type: 1 INT32, 2 INT64, 5 DOUBLE, 6 BYTE_ARRAY
  maxDef: number;     // definition level of a present value
  codec: number;      // 0 uncompressed, 6 Zstd
  offset: number;     // first page (dictionary page when there is one)
  length: number;     // compressed bytes of the whole chunk
  min?: Uint8Array;   // statistics min_value / max_value, PLAIN-encoded
  max?: Uint8Array;
}
export interface RowGroup { rows: number; columns: Map<string, Column> }

const dec = new TextDecoder();

/** Read the footer of a Parquet file of `size` bytes. */
export async function readFooter(range: Range, size: number): Promise<RowGroup[]> {
  const tail = await range(size - 8, 8);
  if (dec.decode(tail.subarray(4)) !== 'PAR1') throw new Error('parquet: no PAR1 magic at the end');
  const n = new DataView(tail.buffer, tail.byteOffset).getUint32(0, true);
  const meta = readStruct(await range(size - 8 - n, n)).value;
  // Definition levels: one per optional or repeated element on the path.
  const schema = meta[2] as TStruct[];
  const maxDef = new Map<string, number>();
  let i = 1;
  const walk = (prefix: string, def: number, children: number): void => {
    for (let c = 0; c < children; c++) {
      const s = schema[i++];
      if (s[3] === 2) throw new Error('parquet: repeated fields are not supported');
      const name = prefix + dec.decode(s[4] as Uint8Array), d = def + (s[3] === 1 ? 1 : 0);
      if (s[5]) walk(name + '.', d, s[5] as number);
      else maxDef.set(name, d);
    }
  };
  walk('', 0, schema[0][5] as number);
  return (meta[4] as TStruct[]).map((rg) => {
    const columns = new Map<string, Column>();
    for (const cc of rg[1] as TStruct[]) {
      const m = cc[3] as TStruct, stats = m[12] as TStruct | undefined;
      const path = (m[3] as Uint8Array[]).map((x) => dec.decode(x)).join('.');
      const offset = (m[11] as number | undefined) ?? (m[9] as number);
      columns.set(path, {
        path, type: m[1] as number, maxDef: maxDef.get(path) ?? 0, codec: m[4] as number,
        offset, length: m[7] as number,
        min: stats?.[6] as Uint8Array | undefined, max: stats?.[5] as Uint8Array | undefined,
      });
    }
    return { rows: rg[3] as number, columns };
  });
}

/** A PLAIN-encoded DOUBLE statistic as a number. */
export function statDouble(b: Uint8Array | undefined): number {
  if (!b || b.length !== 8) return NaN;
  return new DataView(b.buffer, b.byteOffset, 8).getFloat64(0, true);
}

// RLE / bit-packed hybrid (parquet Encodings.md), `count` values of `width` bits.
export function readHybrid(b: Uint8Array, pos: number, end: number, width: number, count: number): Int32Array {
  const out = new Int32Array(count);
  const bytes = (width + 7) >> 3;
  let n = 0;
  while (n < count && pos < end) {
    let h = 0, mul = 1, x: number;
    do { x = b[pos++]; h += (x & 0x7f) * mul; mul *= 128; } while (x & 0x80);
    if (h & 1) {                       // bit-packed: (h >> 1) groups of 8, LSB first
      const total = (h >>> 1) * 8;
      let acc = 0, bits = 0;
      for (let k = 0; k < total; k++) {
        while (bits < width) { acc |= b[pos++] << bits; bits += 8; }
        if (n < count) out[n++] = acc & ((1 << width) - 1);
        acc >>>= width; bits -= width;
      }
    } else {                           // run: (h >> 1) copies of one value
      let v = 0;
      for (let k = 0; k < bytes; k++) v |= b[pos++] << (8 * k);
      for (let k = h >>> 1; k > 0 && n < count; k--) out[n++] = v;
    }
  }
  return out;
}

function plain(b: Uint8Array, pos: number, type: number, count: number): Value[] {
  const dv = new DataView(b.buffer, b.byteOffset);
  const out: Value[] = new Array(count);
  for (let k = 0; k < count; k++) {
    switch (type) {
      case 1: out[k] = dv.getInt32(pos, true); pos += 4; break;
      case 2: out[k] = Number(dv.getBigInt64(pos, true)); pos += 8; break;
      case 5: out[k] = dv.getFloat64(pos, true); pos += 8; break;
      case 6: { const len = dv.getUint32(pos, true); out[k] = b.subarray(pos + 4, pos + 4 + len); pos += 4 + len; break; }
      default: throw new Error(`parquet: physical type ${type} is not supported`);
    }
  }
  return out;
}

const inflate = (codec: number, b: Uint8Array, size: number): Uint8Array => {
  if (codec === 0) return b;
  if (codec === 6) return zstdDecompress(b, size);
  throw new Error(`parquet: codec ${codec} is not supported`);
};

/** Decode one column chunk (all its pages) into one value per row. */
export function decodeChunk(chunk: Uint8Array, col: Column, rows: number): Value[] {
  const out: Value[] = [];
  let dict: Value[] = [];
  const defWidth = 32 - Math.clz32(col.maxDef);
  let pos = 0;
  while (out.length < rows) {
    const { value: h, end } = readStruct(chunk, pos);
    const type = h[1] as number, usize = h[2] as number, csize = h[3] as number;
    const body = chunk.subarray(end, end + csize);
    pos = end + csize;
    if (type === 2) {                  // dictionary page: PLAIN values
      const d = h[7] as TStruct;
      dict = plain(inflate(col.codec, body, usize), 0, col.type, d[1] as number);
      continue;
    }
    let page: Uint8Array, p = 0, n: number, enc: number, defs: Int32Array | null = null;
    if (type === 0) {
      const d = h[5] as TStruct;
      n = d[1] as number; enc = d[2] as number;
      page = inflate(col.codec, body, usize);
      if (col.maxDef) {                // RLE levels with a 4-byte length prefix
        const len = new DataView(page.buffer, page.byteOffset).getUint32(0, true);
        defs = readHybrid(page, 4, 4 + len, defWidth, n);
        p = 4 + len;
      }
    } else if (type === 3) {
      const d = h[8] as TStruct;
      n = d[1] as number; enc = d[4] as number;
      const dl = d[5] as number, rl = d[6] as number;
      if (rl) throw new Error('parquet: repetition levels are not supported');
      if (col.maxDef) defs = readHybrid(body, 0, dl, defWidth, n);
      const compressed = d[7] !== false;
      page = compressed ? inflate(col.codec, body.subarray(dl), usize - dl) : body.subarray(dl);
    } else continue;                   // index pages
    const present = defs ? defs.reduce((a, v) => a + (v === col.maxDef ? 1 : 0), 0) : n;
    let vals: Value[];
    if (enc === 0) vals = plain(page, p, col.type, present);
    else if (enc === 2 || enc === 8) {
      const idx = readHybrid(page, p + 1, page.length, page[p], present);
      vals = Array.from(idx, (k) => dict[k]);
    } else throw new Error(`parquet: encoding ${enc} is not supported`);
    let v = 0;
    for (let k = 0; k < n; k++) out.push(!defs || defs[k] === col.maxDef ? vals[v++] : null);
  }
  return out;
}

/** Read the named columns of one row group: one array of values per column. */
export async function readColumns(range: Range, rg: RowGroup, names: string[]): Promise<Record<string, Value[]>> {
  const out: Record<string, Value[]> = {};
  for (const name of names) {
    const col = rg.columns.get(name);
    if (!col) throw new Error(`parquet: no column ${name}`);
    out[name] = decodeChunk(await range(col.offset, col.length), col, rg.rows);
  }
  return out;
}
