// Thrift compact protocol reader, enough for Parquet's footer, page headers
// and page index (all of them are Thrift structs in the compact protocol).
// Spec: github.com/apache/thrift/blob/master/doc/specs/thrift-compact-protocol.md
//
// Layout assumed:
//   struct = field* 0x00
//   field  = header byte (high nibble: field id delta 1-15, or 0 and a zigzag
//            varint id follows; low nibble: type) | value
//   types  = 1 true, 2 false (in a field the value is the type itself),
//            3 i8, 4 i16, 5 i32, 6 i64 (zigzag varints), 7 double (8 bytes LE),
//            8 binary (varint length | bytes), 9 list, 10 set, 11 map, 12 struct
//   list   = header byte (high nibble size, 15 = varint size follows; low
//            nibble element type) | elements. A bool element is one byte,
//            1 = true (unlike a bool field, which has no value byte).
// A struct is returned as {fieldId: value} without a schema: the caller knows
// what each Parquet field id means. i64 values become Numbers, exact up to
// 2^53, which covers every offset and count of a file below 8 PiB.
// The approach (generic struct of field ids) follows ortho-earth's
// packages/geopbf/src/convert/parquet-read.ts (GPL-3.0-or-later), which
// however reads list<bool> without the element byte; ColumnIndex.null_pages
// is such a list.

export type TValue = number | boolean | Uint8Array | TValue[] | TStruct | Map<TValue, TValue>;
export type TStruct = { [field: number]: TValue };

export class Thrift {
  b: Uint8Array;
  pos: number;
  constructor(b: Uint8Array, pos = 0) { this.b = b; this.pos = pos; }

  byte(): number {
    if (this.pos >= this.b.length) throw new Error('thrift: truncated byte');
    return this.b[this.pos++];
  }

  varint(): number {
    let v = 0, mul = 1, x: number;
    do {
      if (this.pos >= this.b.length) throw new Error('thrift: truncated varint');
      x = this.b[this.pos++];
      v += (x & 0x7f) * mul; mul *= 128;
    } while (x & 0x80);
    return v;
  }
  zigzag(): number { const v = this.varint(); return v % 2 ? -(v + 1) / 2 : v / 2; }

  value(type: number): TValue {
    switch (type) {
      case 1: return true;
      case 2: return false;
      case 3: return (this.byte() << 24) >> 24;
      case 4: case 5: case 6: return this.zigzag();
      case 7: {
        if (this.pos + 8 > this.b.length) throw new Error('thrift: truncated double');
        const v = new DataView(this.b.buffer, this.b.byteOffset + this.pos, 8).getFloat64(0, true);
        this.pos += 8;
        return v;
      }
      case 8: {
        const n = this.varint();
        if (this.pos + n > this.b.length) throw new Error('thrift: binary past the end');
        const v = this.b.subarray(this.pos, this.pos + n); this.pos += n; return v;
      }
      case 9: case 10: {
        const h = this.byte(), et = h & 15;
        const n = (h >> 4) === 15 ? this.varint() : h >> 4;
        const out: TValue[] = new Array(n);
        for (let i = 0; i < n; i++) out[i] = et === 1 || et === 2 ? this.byte() === 1 : this.value(et);
        return out;
      }
      case 11: {
        const n = this.varint(), m = new Map<TValue, TValue>();
        if (!n) return m;
        const kv = this.byte();
        for (let i = 0; i < n; i++) m.set(this.value(kv >> 4), this.value(kv & 15));
        return m;
      }
      case 12: return this.struct();
      default: throw new Error(`thrift: unknown type ${type} at byte ${this.pos}`);
    }
  }

  struct(): TStruct {
    const out: TStruct = {};
    let id = 0;
    for (;;) {
      if (this.pos >= this.b.length) throw new Error('thrift: truncated struct');
      const h = this.b[this.pos++];
      if (h === 0) return out;
      id = h >> 4 ? id + (h >> 4) : this.zigzag();
      out[id] = this.value(h & 15);
    }
  }
}

/** Read one struct at `pos`; `end` is the position after it. */
export function readStruct(b: Uint8Array, pos = 0): { value: TStruct; end: number } {
  const t = new Thrift(b, pos);
  return { value: t.struct(), end: t.pos };
}
