// Only the three OpenMapTiles layers this viewer draws are decoded.
// Geometry commands follow https://github.com/mapbox/vector-tile-spec/tree/master/2.1
export const SELECTED_LAYERS = new Set(['water', 'transportation', 'place']);
export interface Feature { type: number; properties: Record<string, string>; paths: [number, number][][] }
export interface Layer { name: string; extent: number; features: Feature[] }

class Pbf {
  pos = 0;
  readonly bytes: Uint8Array;
  constructor(bytes: Uint8Array) { this.bytes = bytes; }
  get done() { return this.pos >= this.bytes.length; }
  varint(): number {
    let value = 0, multiplier = 1;
    for (let i = 0; i < 10; i++) {
      if (this.done) throw new Error('MVT の varint が途中で終わりました');
      const byte = this.bytes[this.pos++];
      value += (byte & 127) * multiplier;
      if (!(byte & 128)) return value;
      multiplier *= 128;
    }
    throw new Error('MVT の varint が長すぎます');
  }
  block(): Uint8Array {
    const length = this.varint(), end = this.pos + length;
    if (end > this.bytes.length) throw new Error('MVT のフィールドが途中で終わりました');
    const value = this.bytes.subarray(this.pos, end); this.pos = end; return value;
  }
  skip(wire: number) {
    if (wire === 0) { this.varint(); return; }
    if (wire === 2) { this.block(); return; }
    const length = wire === 1 ? 8 : wire === 5 ? 4 : -1;
    if (length < 0 || this.pos + length > this.bytes.length) throw new Error('MVT のフィールド形式が不正です');
    this.pos += length;
  }
}
const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
const zigzag = (n: number) => n % 2 ? -(n + 1) / 2 : n / 2;

function value(bytes: Uint8Array): string {
  const p = new Pbf(bytes);
  while (!p.done) {
    const tag = p.varint(), field = tag >> 3, wire = tag & 7;
    if (field === 1 && wire === 2) return text(p.block());
    p.skip(wire);
  }
  return '';
}
function geometry(bytes: Uint8Array, type: number): [number, number][][] {
  const p = new Pbf(bytes), paths: [number, number][][] = [];
  let x = 0, y = 0, path: [number, number][] = [];
  while (!p.done) {
    const command = p.varint(), id = command & 7, count = Math.floor(command / 8);
    if (count < 1) throw new Error('MVT の空の geometry command');
    if (id === 7) { if (path.length) { paths.push(path); path = []; } continue; }
    if (id !== 1 && id !== 2) throw new Error('MVT の geometry command が不正です');
    for (let i = 0; i < count; i++) {
      x += zigzag(p.varint()); y += zigzag(p.varint());
      if (id === 1 && path.length) { paths.push(path); path = []; }
      path.push([x, y]);
    }
  }
  if (path.length) paths.push(path);
  if (type === 3) for (const ring of paths) if (ring.length < 3) throw new Error('MVT の polygon ring が短すぎます');
  return paths;
}
function feature(bytes: Uint8Array, keys: string[], values: string[]): Feature {
  const p = new Pbf(bytes);
  let type = 0;
  let shape: Uint8Array = new Uint8Array(0), tags: Uint8Array = new Uint8Array(0);
  while (!p.done) {
    const tag = p.varint(), field = tag >> 3, wire = tag & 7;
    if (field === 2 && wire === 2) tags = p.block();
    else if (field === 3 && wire === 0) type = p.varint();
    else if (field === 4 && wire === 2) shape = p.block();
    else p.skip(wire);
  }
  const properties: Record<string, string> = {};
  const pairs = new Pbf(tags);
  while (!pairs.done) {
    const key = keys[pairs.varint()], val = values[pairs.varint()];
    if ((key === 'class' || key === 'name' || key === 'name:ja') && val !== undefined) properties[key] = val;
  }
  return { type, properties, paths: geometry(shape, type) };
}
function layer(bytes: Uint8Array): Layer | null {
  const p = new Pbf(bytes), features: Uint8Array[] = [], keys: string[] = [], values: string[] = [];
  let name = '', extent = 4096;
  while (!p.done) {
    const tag = p.varint(), field = tag >> 3, wire = tag & 7;
    if (field === 1 && wire === 2) name = text(p.block());
    else if (name && !SELECTED_LAYERS.has(name)) p.skip(wire);
    else if (field === 2 && wire === 2) features.push(p.block());
    else if (field === 3 && wire === 2) keys.push(text(p.block()));
    else if (field === 4 && wire === 2) values.push(value(p.block()));
    else if (field === 5 && wire === 0) extent = p.varint();
    else p.skip(wire);
  }
  if (!SELECTED_LAYERS.has(name)) return null;
  return { name, extent, features: features.map(raw => feature(raw, keys, values)) };
}
export function decodeMvt(bytes: Uint8Array): Layer[] {
  const p = new Pbf(bytes), result: Layer[] = [];
  while (!p.done) {
    const tag = p.varint(), field = tag >> 3, wire = tag & 7;
    if (field === 3 && wire === 2) {
      const decoded = layer(p.block());
      if (decoded) result.push(decoded);
    } else p.skip(wire);
  }
  return result;
}
