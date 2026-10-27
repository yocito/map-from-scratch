import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readHybrid, decodeChunk, statDouble, type Column } from '../parquet.ts';

// Thrift compact encoding of the few PageHeader fields decodeChunk reads.
const varint = (v: number): number[] => { const o: number[] = []; do { let b = v & 0x7f; v >>>= 7; if (v) b |= 0x80; o.push(b); } while (v); return o; };
const zz = (v: number) => varint(v >= 0 ? v * 2 : -v * 2 - 1);
const i32 = (delta: number, v: number) => [(delta << 4) | 5, ...zz(v)];
function pageHeader(type: number, size: number, sub: { field: number; values: number[] }): number[] {
  // 1: type, 2: uncompressed size, 3: compressed size, then the sub-header struct.
  const inner = sub.values.flatMap((v, i) => i32(1, v));
  return [...i32(1, type), ...i32(1, size), ...i32(1, size), ((sub.field - 3) << 4) | 12, ...inner, 0, 0];
}
const le32 = (v: number) => [v & 255, (v >> 8) & 255, (v >> 16) & 255, (v >>> 24) & 255];

test('hybrid: a run and a bit-packed group', () => {
  // RLE run of 3 x value 5 (width 3 -> 1 byte), then 8 bit-packed values 0..7.
  const b = new Uint8Array([3 << 1, 5, (1 << 1) | 1, 0b10001000, 0b11000110, 0b11111010]);
  assert.deepEqual([...readHybrid(b, 0, b.length, 3, 11)], [5, 5, 5, 0, 1, 2, 3, 4, 5, 6, 7]);
});

test('decodeChunk: optional INT32, PLAIN, data page v1 with nulls', () => {
  // Rows: 7, null, -2. Definition levels (width 1) as one RLE-hybrid bit-packed group.
  const defs = [(1 << 1) | 1, 0b101];
  const body = [...le32(defs.length), ...defs, ...le32(7), ...le32(-2 >>> 0)];
  const chunk = new Uint8Array([...pageHeader(0, body.length, { field: 5, values: [3, 0, 3, 3] }), ...body]);
  const col: Column = { path: 'x', type: 1, maxDef: 1, codec: 0, offset: 0, length: chunk.length };
  assert.deepEqual(decodeChunk(chunk, col, 3), [7, null, -2]);
});

test('decodeChunk: dictionary page then RLE_DICTIONARY indices', () => {
  const words = ['東口', 'west'].map((s) => new TextEncoder().encode(s));
  const dict = words.flatMap((w) => [...le32(w.length), ...w]);
  const dictPage = [...pageHeader(2, dict.length, { field: 7, values: [2, 0] }), ...dict];
  // Indices 1, 0, 1 at bit width 1: a bit-packed group.
  const idx = [1, (1 << 1) | 1, 0b101];
  const dataPage = [...pageHeader(0, idx.length, { field: 5, values: [3, 8, 3, 3] }), ...idx];
  const chunk = new Uint8Array([...dictPage, ...dataPage]);
  const col: Column = { path: 's', type: 6, maxDef: 0, codec: 0, offset: 0, length: chunk.length };
  const got = decodeChunk(chunk, col, 3).map((v) => new TextDecoder().decode(v as Uint8Array));
  assert.deepEqual(got, ['west', '東口', 'west']);
});

test('statDouble reads a PLAIN double and rejects other widths', () => {
  const b = new Uint8Array(new Float64Array([15559415.5]).buffer);
  assert.equal(statDouble(b), 15559415.5);
  assert.ok(Number.isNaN(statDouble(new Uint8Array(4))));
});
