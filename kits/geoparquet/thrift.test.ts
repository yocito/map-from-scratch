import { deepStrictEqual, throws } from 'node:assert/strict';
import { test } from 'node:test';
import { readStruct, Thrift } from './thrift.ts';

test('reads compact fields, binary, and boolean lists', () => {
  const bytes = Uint8Array.from([
    0x15, 0x54,                 // field 1: i32 42
    0x11,                       // field 2: true
    0x18, 0x03, 0x61, 0x62, 0x63, // field 3: binary "abc"
    0x19, 0x21, 0x01, 0x02,     // field 4: list<bool> [true, false]
    0x00,
  ]);
  deepStrictEqual(readStruct(bytes), {
    value: { 1: 42, 2: true, 3: bytes.subarray(5, 8), 4: [true, false] },
    end: bytes.length,
  });
});

test('reads a nested struct and an explicit field id from an offset', () => {
  const bytes = Uint8Array.from([
    0xff,
    0x1c, 0x14, 0x05, 0x00, // field 1: struct {field 1: i16 -3}
    0x05, 0x0e, 0x03,       // field 7: i32 -2 (explicit id)
    0x00,
  ]);
  deepStrictEqual(readStruct(bytes, 1), { value: { 1: { 1: -3 }, 7: -2 }, end: bytes.length });
});

test('rejects truncated fixed-size and boolean-list values', () => {
  throws(() => new Thrift(new Uint8Array()).value(3), /truncated/);
  throws(() => new Thrift(Uint8Array.from([0x11])).value(9), /truncated/);
});
