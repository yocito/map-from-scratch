import { test } from 'node:test';
import assert from 'node:assert/strict';
import { zstdCompressSync, constants } from 'node:zlib';
import { zstdDecompress } from './zstd.ts';

// Deterministic generator, so a failure can be reproduced.
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

const kinds: Record<string, (n: number, r: () => number) => Uint8Array> = {
  random: (n, r) => Uint8Array.from({ length: n }, () => (r() * 256) | 0),
  zeros: (n) => new Uint8Array(n),
  repetitive: (n) => { const t = new TextEncoder().encode('the quick brown fox jumps over the lazy dog. '); return Uint8Array.from({ length: n }, (_, i) => t[i % t.length]); },
  // text-like: words from a small vocabulary, so Huffman literals and many short matches
  words: (n, r) => { const w = ['tokyo', 'osaka', 'cell', 'tower', 'GSM', 'LTE', 'UMTS', '139.7', '35.68', ',', '\n', 'building', 'flood']; let s = ''; while (s.length < n) s += w[(r() * w.length) | 0] + ' '; return new TextEncoder().encode(s.slice(0, n)); },
  // Parquet-like: little-endian doubles of a slowly varying series
  doubles: (n, r) => { const f = new Float64Array(Math.ceil(n / 8)); let v = 139.7; for (let i = 0; i < f.length; i++) { v += (r() - 0.5) * 1e-3; f[i] = v; } return new Uint8Array(f.buffer, 0, n); },
  // 40-byte patterns from a pool of 8 with short separators: repeat offset "rep1 - 1" (level 19)
  pool: (n, r) => { const pool = Array.from({ length: 8 }, () => Uint8Array.from({ length: 40 }, () => (r() * 256) | 0)); const o: number[] = []; while (o.length < n) { o.push(...pool[(r() * 8) | 0], ...[1, 1, 1].slice(0, (r() * 3) | 0)); } return Uint8Array.from(o.slice(0, n)); },
  // a stride pattern with few distinct literals: Huffman weights stored directly, not FSE-coded (level 19)
  stride: (n, r) => Uint8Array.from({ length: n }, (_, i) => (i % 17 === 0 ? (r() * 3) | 0 : (i * 31) & 255)),
  // skewed bytes: few symbols with very different frequencies (deep Huffman trees)
  skewed: (n, r) => Uint8Array.from({ length: n }, () => { const x = r(); return x < 0.5 ? 1 : x < 0.75 ? 2 : x < 0.9 ? 3 : (4 + r() * 60) | 0; }),
};

const sizes = [0, 1, 2, 3, 15, 100, 1000, 4096, 65536, 131072, 131073, 300000, 1500000];
const levels = [-5, 1, 3, 9, 19];

for (const [name, make] of Object.entries(kinds)) {
  test(`zstd: ${name} data, ${sizes.length} sizes x ${levels.length} levels`, () => {
    const r = rng(name.length * 7919);
    for (const n of sizes) {
      const data = make(n, r);
      for (const level of levels) {
        if (level === 19 && n > 300000) continue;   // slow to compress, nothing new
        const z = zstdCompressSync(data, { params: { [constants.ZSTD_c_compressionLevel]: level } });
        const back = zstdDecompress(new Uint8Array(z.buffer, z.byteOffset, z.byteLength));
        assert.equal(back.length, n, `${name} n=${n} level=${level}: length`);
        assert.ok(Buffer.compare(back, data) === 0, `${name} n=${n} level=${level}: content`);
      }
    }
  });
}

test('zstd: checksum flag, no content size, small window, multiple and skippable frames', () => {
  const r = rng(42), data = kinds.words(700000, r);
  const opts = [
    { [constants.ZSTD_c_checksumFlag]: 1 },
    { [constants.ZSTD_c_contentSizeFlag]: 0 },
    { [constants.ZSTD_c_windowLog]: 10, [constants.ZSTD_c_compressionLevel]: 12 },
    { [constants.ZSTD_c_compressionLevel]: 22 },
  ];
  for (const params of opts) {
    const z = zstdCompressSync(data, { params });
    assert.ok(Buffer.compare(zstdDecompress(z), data) === 0, JSON.stringify(params));
    assert.ok(Buffer.compare(zstdDecompress(z, 10), data) === 0, 'a short size hint grows the output');
  }
  const a = zstdCompressSync(data.subarray(0, 1000)), b = zstdCompressSync(data.subarray(1000, 5000));
  const skip = Buffer.from([0x50, 0x2a, 0x4d, 0x18, 3, 0, 0, 0, 9, 9, 9]);
  assert.ok(Buffer.compare(zstdDecompress(Buffer.concat([a, skip, b])), data.subarray(0, 5000)) === 0);
});

test('zstd: RLE literals (hand-made frame: one compressed block, literals "x" x5, no sequences)', () => {
  // magic | FHD 0x20 (single segment, 1-byte content size) | size 5 | block header (last, compressed, 3 bytes)
  // | literals header (RLE, 5) | 'x' | 0 sequences
  const frame = Uint8Array.of(0x28, 0xb5, 0x2f, 0xfd, 0x20, 5, 0x1d, 0, 0, (5 << 3) | 1, 0x78, 0);
  assert.equal(new TextDecoder().decode(zstdDecompress(frame)), 'xxxxx');
});

test('zstd: rejects what it cannot read', () => {
  assert.throws(() => zstdDecompress(Uint8Array.of(1, 2, 3, 4, 5)), /magic/);
  const z = zstdCompressSync(kinds.words(5000, rng(1)));
  assert.throws(() => zstdDecompress(z.subarray(0, z.length - 20)));
  // a frame that names a dictionary (dictionary id flag 1, id 7)
  assert.throws(() => zstdDecompress(Uint8Array.of(0x28, 0xb5, 0x2f, 0xfd, 0x21, 7, 0, 1, 0, 0)), /dictionar/);
});
