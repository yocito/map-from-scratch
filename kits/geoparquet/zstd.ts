// Zstandard decoder, written from RFC 8878 (https://www.rfc-editor.org/rfc/rfc8878).
// The Parquet pages of every Hugging Face file this kit was made for are ZSTD,
// and browsers have no zstd in DecompressionStream, so this is the one codec a
// renderer cannot get from the platform.
//
// Layout assumed (RFC 8878 section numbers in brackets):
//   input  = frame*                     zstd frames and skippable frames back to back [3.1]
//   frame  = magic 0xFD2FB528 | header | block* | checksum?        [3.1.1]
//   block  = 3-byte header (last, type, size) | content            [3.1.1.2]
//            type 0 raw, 1 RLE (one byte, repeated), 2 compressed
//   compressed block = literals section | sequences section        [3.1.1.3]
//     literals: raw, RLE, Huffman (1 or 4 streams, tree given) or
//               treeless (Huffman, previous tree)                   [3.1.1.3.1, 4.2]
//     sequences: count | modes | FSE tables for literal length,
//                offset, match length | one backward bit stream    [3.1.1.3.2, 4.1]
//   Each sequence copies `ll` literals, then `ml` bytes from `offset` back;
//   offsets 1-3 name the three repeat offsets                      [3.1.1.5]
// Not supported: dictionaries (a frame with a dictionary id throws). The
// content checksum (XXH64) is skipped, not verified. Offsets reach back to
// the start of the frame only, which is all a single-frame page needs.
// The decoded output of the whole input is kept in memory, so the window size
// is not needed.

const LL_BASE = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 18, 20, 22, 24, 28, 32, 40, 48, 64,
  128, 256, 512, 1024, 2048, 4096, 8192, 16384, 32768, 65536];
const LL_BITS = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 3, 3, 4, 6, 7, 8, 9, 10, 11,
  12, 13, 14, 15, 16];
const ML_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28,
  29, 30, 31, 32, 33, 34, 35, 37, 39, 41, 43, 47, 51, 59, 67, 83, 99, 131, 259, 515, 1027, 2051, 4099, 8195,
  16387, 32771, 65539];
const ML_BITS = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  1, 1, 1, 1, 2, 2, 3, 3, 4, 4, 5, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16];
// Predefined distributions [3.1.1.3.2.2]; -1 is "less than 1".
const LL_DEFAULT = [4, 3, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 1, 1, 1, 2, 2, 2, 2, 2, 2, 2, 2, 2, 3, 2, 1, 1, 1, 1, 1,
  -1, -1, -1, -1];
const ML_DEFAULT = [1, 4, 3, 2, 2, 2, 2, 2, 2, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1,
  1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, -1, -1, -1, -1, -1, -1, -1];
const OF_DEFAULT = [1, 1, 1, 1, 1, 1, 2, 2, 2, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, -1, -1, -1, -1, -1];

const fail = (msg: string): never => { throw new Error('zstd: ' + msg); };

// Bits of a backward bit stream [4.1]: the stream is read from its last byte
// towards its first. The highest set bit of the last byte marks the start;
// `p` counts the bits still unread, and the next `n` bits are [p - n, p) of
// the stream seen as one little-endian integer. Reading below bit 0 gives
// zeros, which the format allows at the very end (and p < 0 then tells that
// the stream was overrun).
class BackBits {
  b: Uint8Array;
  s: number;
  p: number;
  constructor(b: Uint8Array, start: number, end: number) {
    if (end <= start || end > b.length) fail('empty or truncated bit stream');
    const last = b[end - 1];
    if (last === 0) fail('bit stream without end mark');
    this.b = b; this.s = start; this.p = (end - 1 - start) * 8 + 31 - Math.clz32(last);
  }
  // n <= 25 bits starting at bit p
  at(p: number, n: number): number {
    if (p < 0) return p + n <= 0 ? 0 : this.at(0, n + p) << -p;
    const b = this.b, k = this.s + (p >>> 3);
    return ((b[k] | (b[k + 1] << 8) | (b[k + 2] << 16) | (b[k + 3] << 24)) >>> (p & 7)) & ((1 << n) - 1);
  }
  read(n: number): number {
    if (n === 0) return 0;
    this.p -= n;
    return this.at(this.p, n);
  }
  readLong(n: number): number {   // up to 32 bits
    if (n <= 25) return this.read(n);
    const hi = this.read(16);
    return hi * 2 ** (n - 16) + this.read(n - 16);
  }
}

interface Fse { log: number; sym: Uint8Array; bits: Uint8Array; base: Uint16Array }

// Build the decoding table from normalised counts [4.1.1].
function buildFse(norm: ArrayLike<number>, nSym: number, log: number): Fse {
  const size = 1 << log, sym = new Uint8Array(size), bits = new Uint8Array(size), base = new Uint16Array(size);
  const next = new Uint16Array(nSym);
  let high = size - 1;
  for (let s = 0; s < nSym; s++) {
    if (norm[s] === -1) { sym[high--] = s; next[s] = 1; } else next[s] = norm[s];
  }
  const step = (size >> 1) + (size >> 3) + 3, mask = size - 1;
  let p = 0;
  for (let s = 0; s < nSym; s++) {
    for (let i = 0; i < norm[s]; i++) {
      sym[p] = s;
      do p = (p + step) & mask; while (p > high);
    }
  }
  if (p !== 0) fail('bad FSE distribution');
  for (let u = 0; u < size; u++) {
    const x = next[sym[u]]++, nb = log - (31 - Math.clz32(x));
    bits[u] = nb; base[u] = (x << nb) - size;
  }
  return { log, sym, bits, base };
}

// Read an FSE table description (forward bit stream) [4.1.1]. Returns the
// table and the position after the description (rounded up to a byte).
function readFse(src: Uint8Array, pos: number, maxLog: number, maxSym: number): [Fse, number] {
  let bit = pos * 8;
  const get = (n: number): number => {
    const k = bit >>> 3;
    return ((src[k] | (src[k + 1] << 8) | (src[k + 2] << 16) | (src[k + 3] << 24)) >>> (bit & 7)) & ((1 << n) - 1);
  };
  const log = get(4) + 5; bit += 4;
  if (log > maxLog) fail(`FSE accuracy ${log} > ${maxLog}`);
  const norm: number[] = [];
  let remaining = (1 << log) + 1, threshold = 1 << log, nbBits = log + 1;
  while (remaining > 1) {
    if (norm.length > maxSym) fail('too many FSE symbols');
    const max = 2 * threshold - 1 - remaining;
    let v = get(nbBits);
    if ((v & (threshold - 1)) < max) { v &= threshold - 1; bit += nbBits - 1; }
    else { v &= 2 * threshold - 1; if (v >= threshold) v -= max; bit += nbBits; }
    const count = v - 1;   // -1 means "less than 1"
    remaining -= count < 0 ? -count : count;
    norm.push(count);
    if (count === 0) {   // a zero is followed by 2-bit repeat flags of more zeros
      for (;;) {
        const r = get(2); bit += 2;
        for (let i = 0; i < r; i++) norm.push(0);
        if (r !== 3) break;
      }
    }
    while (remaining < threshold) { nbBits--; threshold >>= 1; }
  }
  if (remaining !== 1 || norm.length > maxSym + 1) fail('bad FSE table description');
  return [buildFse(norm, norm.length, log), (bit + 7) >>> 3];
}

const rleFse = (s: number): Fse => ({ log: 0, sym: Uint8Array.of(s), bits: new Uint8Array(1), base: new Uint16Array(1) });

let defaults: [Fse, Fse, Fse] | null = null;   // LL, OF, ML, built on first use
const predefined = (): [Fse, Fse, Fse] =>
  defaults ??= [buildFse(LL_DEFAULT, 36, 6), buildFse(OF_DEFAULT, 29, 5), buildFse(ML_DEFAULT, 53, 6)];

interface Huf { maxBits: number; sym: Uint8Array; bits: Uint8Array }

// Huffman tree description [4.2.1]: weights, given directly (4 bits each) or
// FSE-compressed; the last weight is implied. Codes are assigned from the
// smallest weight (longest code) up, by symbol within a weight.
function readHuffman(src: Uint8Array, pos: number): [Huf, number] {
  const h = src[pos++];
  const w: number[] = [];
  if (h < 128) {
    const end = pos + h;
    const [fse, p] = readFse(src, pos, 6, 255);
    const br = new BackBits(src, p, end);
    let s1 = br.read(fse.log), s2 = br.read(fse.log);
    for (;;) {   // two interleaved states; stop when an update overruns the stream
      w.push(fse.sym[s1]); s1 = fse.base[s1] + br.read(fse.bits[s1]);
      if (br.p < 0) { w.push(fse.sym[s2]); break; }
      w.push(fse.sym[s2]); s2 = fse.base[s2] + br.read(fse.bits[s2]);
      if (br.p < 0) { w.push(fse.sym[s1]); break; }
      if (w.length > 255) fail('too many Huffman weights');
    }
    pos = end;
  } else {
    const n = h - 127;
    for (let i = 0; i < n; i++) w.push(i & 1 ? src[pos + (i >> 1)] & 15 : src[pos + (i >> 1)] >> 4);
    pos += (n + 1) >> 1;
  }
  let sum = 0;
  for (const x of w) if (x) sum += 1 << (x - 1);
  if (sum === 0) fail('empty Huffman tree');
  const maxBits = 32 - Math.clz32(sum), rest = (1 << maxBits) - sum;
  if (maxBits > 11 || rest & (rest - 1)) fail('bad Huffman weights');
  w.push(32 - Math.clz32(rest));
  const size = 1 << maxBits, sym = new Uint8Array(size), bits = new Uint8Array(size);
  let p = 0;
  for (let weight = 1; weight <= maxBits; weight++) {
    for (let s = 0; s < w.length; s++) {
      if (w[s] !== weight) continue;
      const len = 1 << (weight - 1);
      sym.fill(s, p, p + len); bits.fill(maxBits + 1 - weight, p, p + len); p += len;
    }
  }
  return [{ maxBits, sym, bits }, pos];
}

function huffStream(huf: Huf, src: Uint8Array, start: number, end: number, out: Uint8Array, o: number, n: number): void {
  const br = new BackBits(src, start, end), mb = huf.maxBits, sym = huf.sym, bits = huf.bits;
  for (let i = 0; i < n; i++) {
    const v = br.at(br.p - mb, mb);
    out[o + i] = sym[v]; br.p -= bits[v];
  }
  if (br.p !== 0) fail('Huffman stream not fully consumed');
}

// Growable output.
class Out {
  buf: Uint8Array;
  n = 0;
  constructor(size: number) { this.buf = new Uint8Array(Math.max(size, 64)); }
  need(k: number): void {
    if (this.n + k <= this.buf.length) return;
    const b = new Uint8Array(Math.max(this.n + k, this.buf.length * 2));
    b.set(this.buf.subarray(0, this.n)); this.buf = b;
  }
}

interface FrameState { reps: [number, number, number]; huf: Huf | null; ll: Fse | null; of: Fse | null; ml: Fse | null; lit: Uint8Array }

function literals(src: Uint8Array, pos: number, st: FrameState): [Uint8Array, number] {
  const b0 = src[pos], type = b0 & 3, sf = (b0 >> 2) & 3;
  if (type < 2) {   // raw or RLE
    let size: number;
    if ((sf & 1) === 0) { size = b0 >> 3; pos += 1; }
    else if (sf === 1) { size = (b0 >> 4) + (src[pos + 1] << 4); pos += 2; }
    else { size = (b0 >> 4) + (src[pos + 1] << 4) + (src[pos + 2] << 12); pos += 3; }
    if (size > st.lit.length) fail('literals larger than a block');
    if (type === 0) {
      if (pos + size > src.length) fail('raw literals past the input');
      return [src.subarray(pos, pos + size), pos + size];
    }
    return [st.lit.subarray(0, size).fill(src[pos]), pos + 1];
  }
  let regen: number, comp: number;
  if (sf < 2) {
    const h = b0 | (src[pos + 1] << 8) | (src[pos + 2] << 16);
    regen = (h >> 4) & 0x3ff; comp = (h >> 14) & 0x3ff; pos += 3;
  } else if (sf === 2) {
    const h = (b0 | (src[pos + 1] << 8) | (src[pos + 2] << 16) | (src[pos + 3] << 24)) >>> 0;
    regen = (h >>> 4) & 0x3fff; comp = h >>> 18; pos += 4;
  } else {
    const h = (b0 | (src[pos + 1] << 8) | (src[pos + 2] << 16) | (src[pos + 3] << 24)) >>> 0;
    regen = (h >>> 4) & 0x3ffff; comp = ((h >>> 22) | (src[pos + 4] << 10)) & 0x3ffff; pos += 5;
  }
  const end = pos + comp;
  if (end > src.length || regen > st.lit.length) fail('compressed literals past the input or larger than a block');
  let p = pos;
  if (type === 2) [st.huf, p] = readHuffman(src, pos);
  else if (!st.huf) fail('treeless literals without a previous tree');
  const huf = st.huf as Huf, out = st.lit;
  if (sf === 0) huffStream(huf, src, p, end, out, 0, regen);
  else {   // four streams behind a 6-byte jump table
    const s1 = src[p] | (src[p + 1] << 8), s2 = src[p + 2] | (src[p + 3] << 8), s3 = src[p + 4] | (src[p + 5] << 8);
    const seg = (regen + 3) >> 2;
    let q = p + 6;
    huffStream(huf, src, q, q + s1, out, 0, seg); q += s1;
    huffStream(huf, src, q, q + s2, out, seg, seg); q += s2;
    huffStream(huf, src, q, q + s3, out, 2 * seg, seg); q += s3;
    huffStream(huf, src, q, end, out, 3 * seg, regen - 3 * seg);
  }
  return [out.subarray(0, regen), end];
}

function table(mode: number, src: Uint8Array, pos: number, def: Fse, prev: Fse | null, maxLog: number, maxSym: number): [Fse, number] {
  if (mode === 0) return [def, pos];
  if (mode === 1) return [rleFse(src[pos]), pos + 1];
  if (mode === 2) return readFse(src, pos, maxLog, maxSym);
  if (!prev) fail('repeat mode without a previous table');
  return [prev as Fse, pos];
}

function block(src: Uint8Array, pos: number, end: number, st: FrameState, out: Out, frameStart: number): void {
  let lit: Uint8Array;
  [lit, pos] = literals(src, pos, st);
  let nSeq = src[pos++];
  if (nSeq >= 128) {
    if (nSeq < 255) nSeq = ((nSeq - 128) << 8) + src[pos++];
    else { nSeq = src[pos] + (src[pos + 1] << 8) + 0x7f00; pos += 2; }
  }
  if (nSeq === 0) {
    if (pos !== end) fail('bytes after an empty sequences section');
    out.need(lit.length); out.buf.set(lit, out.n); out.n += lit.length;
    return;
  }
  const modes = src[pos++];
  if (modes & 3) fail('reserved bits in sequence modes');
  const [dLL, dOF, dML] = predefined();
  let LL: Fse, OF: Fse, ML: Fse;
  [LL, pos] = table(modes >> 6, src, pos, dLL, st.ll, 9, 35);
  [OF, pos] = table((modes >> 4) & 3, src, pos, dOF, st.of, 8, 31);
  [ML, pos] = table((modes >> 2) & 3, src, pos, dML, st.ml, 9, 52);
  st.ll = LL; st.of = OF; st.ml = ML;
  const br = new BackBits(src, pos, end), reps = st.reps;
  let sLL = br.read(LL.log), sOF = br.read(OF.log), sML = br.read(ML.log), lp = 0;
  for (let i = 0; i < nSeq; i++) {
    const ofCode = OF.sym[sOF], mlCode = ML.sym[sML], llCode = LL.sym[sLL];
    if (ofCode > 31 || mlCode > 52 || llCode > 35) fail('bad sequence code');
    const ofValue = 2 ** ofCode + br.readLong(ofCode);
    const ml = ML_BASE[mlCode] + br.read(ML_BITS[mlCode]);
    const ll = LL_BASE[llCode] + br.read(LL_BITS[llCode]);
    let offset: number;
    if (ofValue > 3) { offset = ofValue - 3; reps[2] = reps[1]; reps[1] = reps[0]; reps[0] = offset; }
    else {   // repeat offsets, shifted by one when there are no literals [3.1.1.5]
      const idx = ofValue - 1 + (ll === 0 ? 1 : 0);
      if (idx === 0) offset = reps[0];
      else {
        offset = idx === 3 ? reps[0] - 1 : reps[idx];
        if (idx !== 1) reps[2] = reps[1];
        reps[1] = reps[0]; reps[0] = offset;
      }
    }
    if (i < nSeq - 1) {
      sLL = LL.base[sLL] + br.read(LL.bits[sLL]);
      sML = ML.base[sML] + br.read(ML.bits[sML]);
      sOF = OF.base[sOF] + br.read(OF.bits[sOF]);
    }
    if (lp + ll > lit.length) fail('sequence takes more literals than there are');
    out.need(ll + ml);
    const buf = out.buf;
    buf.set(lit.subarray(lp, lp + ll), out.n); out.n += ll; lp += ll;
    let o = out.n, s = o - offset;
    if (offset === 0 || s < frameStart) fail('match offset before the start of the frame');
    if (offset >= ml) buf.copyWithin(o, s, s + ml);
    else for (let k = 0; k < ml; k++) buf[o++] = buf[s++];   // overlapping: byte by byte
    out.n += ml;
  }
  if (br.p !== 0) fail('sequence bit stream not fully consumed');
  const rest = lit.length - lp;
  out.need(rest); out.buf.set(lit.subarray(lp), out.n); out.n += rest;
}

/** Decompress every frame of `src`. `sizeHint` (e.g. Parquet's uncompressed
 *  page size) pre-sizes the output; it grows when the hint is short. */
export function zstdDecompress(src: Uint8Array, sizeHint = 0): Uint8Array {
  const out = new Out(sizeHint || src.length * 4);
  const lit = new Uint8Array(1 << 17);   // literals of one block: at most 128 KiB
  let pos = 0;
  while (pos < src.length) {
    if (pos + 4 > src.length) fail('truncated frame');
    const magic = (src[pos] | (src[pos + 1] << 8) | (src[pos + 2] << 16) | (src[pos + 3] << 24)) >>> 0;
    if ((magic & 0xfffffff0) >>> 0 === 0x184d2a50) {   // skippable frame
      pos += 8 + ((src[pos + 4] | (src[pos + 5] << 8) | (src[pos + 6] << 16) | (src[pos + 7] << 24)) >>> 0);
      continue;
    }
    if (magic !== 0xfd2fb528) fail('bad magic number');
    const fhd = src[pos + 4];
    pos += 5;
    if (fhd & 8) fail('reserved bit set in frame header');
    const fcsFlag = fhd >> 6, single = (fhd >> 5) & 1, checksum = (fhd >> 2) & 1, dictFlag = fhd & 3;
    if (!single) pos++;   // window descriptor: not needed, the whole output is kept
    const dictBytes = [0, 1, 2, 4][dictFlag];
    let dictId = 0;
    for (let i = 0; i < dictBytes; i++) dictId += src[pos + i] * 2 ** (8 * i);
    if (dictId) fail('dictionaries are not supported');
    pos += dictBytes;
    const fcsBytes = fcsFlag === 0 ? single : [0, 2, 4, 8][fcsFlag];
    let fcs = 0;
    for (let i = 0; i < fcsBytes; i++) fcs += src[pos + i] * 2 ** (8 * i);
    if (fcsBytes === 2) fcs += 256;
    pos += fcsBytes;
    if (fcsBytes) out.need(fcs);
    const frameStart = out.n;
    const st: FrameState = { reps: [1, 4, 8], huf: null, ll: null, of: null, ml: null, lit };
    for (let last = 0; !last;) {
      if (pos + 3 > src.length) fail('truncated block header');
      const bh = src[pos] | (src[pos + 1] << 8) | (src[pos + 2] << 16);
      pos += 3;
      last = bh & 1;
      const type = (bh >> 1) & 3, size = bh >>> 3;
      if (type === 0) {
        if (pos + size > src.length) fail('truncated raw block');
        out.need(size); out.buf.set(src.subarray(pos, pos + size), out.n); out.n += size; pos += size;
      } else if (type === 1) {
        out.need(size); out.buf.fill(src[pos], out.n, out.n + size); out.n += size; pos += 1;
      } else if (type === 2) {
        if (pos + size > src.length) fail('truncated compressed block');
        block(src, pos, pos + size, st, out, frameStart); pos += size;
      } else fail('reserved block type');
    }
    if (fcsBytes && out.n - frameStart !== fcs) fail(`frame decoded to ${out.n - frameStart} bytes, header says ${fcs}`);
    if (checksum) pos += 4;   // XXH64 of the content: not verified
  }
  return out.n === out.buf.length ? out.buf : out.buf.subarray(0, out.n);
}
