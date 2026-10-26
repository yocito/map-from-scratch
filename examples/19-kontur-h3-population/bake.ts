// Convert the Kontur GeoParquet H3 polygons into a compact Canvas-ready file.
// DuckDB's spatial extension only reads the source at bake time.
import { mkdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { source } from '../../tools/sources.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const out = join(root, 'data/baked/19-kontur-h3-population');
const input = source('kontur-population-r4');
const sql = `LOAD spatial; SELECT h3,CAST(population AS BIGINT),hex(ST_AsWKB(geometry)) FROM read_parquet('${input}') ORDER BY h3;`;
const rows = execFileSync('duckdb', ['-noheader', '-csv', '-c', sql], { encoding: 'utf8', maxBuffer: 40 << 20 }).trimEnd().split('\n');
const HALF = 20037508.342789244;
type Point = [number, number];

function ringsOf(hex: string): Point[][] {
  const bytes = Buffer.from(hex, 'hex');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let pos = 0;
  const u8 = () => view.getUint8(pos++);
  const u32 = (little: boolean) => { const n = view.getUint32(pos, little); pos += 4; return n; };
  const f64 = (little: boolean) => { const n = view.getFloat64(pos, little); pos += 8; return n; };
  const polygon = (): Point[][] => {
    const little = u8() === 1;
    if (u32(little) !== 3) throw new Error('Expected WKB Polygon');
    const rings: Point[][] = [];
    const n = u32(little);
    for (let r = 0; r < n; r++) {
      const count = u32(little);
      const points: Point[] = [];
      for (let i = 0; i < count; i++) {
        const x = f64(little), y = f64(little);
        points.push([
          Math.max(0, Math.min(65535, Math.round((x + HALF) / (2 * HALF) * 65535))),
          Math.max(0, Math.min(65535, Math.round((HALF - y) / (2 * HALF) * 65535))),
        ]);
      }
      points.pop(); // the closing coordinate repeats the first
      if (r === 0) rings.push(points); // H3 cells have no holes
    }
    return rings;
  };
  const type = view.getUint32(1, view.getUint8(0) === 1);
  if (type === 3) return polygon();
  if (type !== 6) throw new Error(`Unexpected WKB type ${type}`);
  pos = 5;
  const count = u32(view.getUint8(0) === 1);
  return Array.from({ length: count }, () => polygon()).flat();
}

const records: Buffer[] = [];
let total = 0, parts = 0;
for (const row of rows) {
  const [h3, populationText, geometry] = row.split(',');
  const population = Number(populationText);
  const rings = ringsOf(geometry);
  if (!h3 || !Number.isSafeInteger(population) || rings.length < 1 || rings.length > 255) throw new Error(`Invalid source row: ${h3}`);
  const size = 13 + rings.reduce((n, ring) => n + 1 + ring.length * 4, 0);
  const bytes = Buffer.allocUnsafe(size);
  bytes.writeBigUInt64LE(BigInt(`0x${h3}`), 0);
  bytes.writeUInt32LE(population, 8);
  bytes.writeUInt8(rings.length, 12);
  let offset = 13;
  for (const ring of rings) {
    if (ring.length < 3 || ring.length > 255) throw new Error(`${h3}: invalid ring length`);
    bytes.writeUInt8(ring.length, offset++);
    for (const [x, y] of ring) {
      bytes.writeUInt16LE(x, offset); bytes.writeUInt16LE(y, offset + 2); offset += 4;
    }
    parts++;
  }
  records.push(bytes);
  total += population;
}
if (rows.length !== 71283 || total !== 8031924024) throw new Error(`Unexpected source: ${rows.length} cells, ${total} people`);
const header = Buffer.alloc(8);
header.write('H3P1', 0);
header.writeUInt32LE(rows.length, 4);
mkdirSync(out, { recursive: true });
const file = join(out, 'cells.bin');
writeFileSync(file, Buffer.concat([header, ...records]));
console.log(`${rows.length} H3 cells, ${parts} polygons, ${total} people; ${file}`);
