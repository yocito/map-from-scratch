import { stripTypeScriptTypes } from 'node:module';
import { readFileSync } from 'node:fs';

// What a browser gets for a .ts file: the same code with the types taken
// out by Node's built-in transform. The static server sends this, and
// footprint measures this, so the measured bytes are the served bytes.
export function shippedSource(file: string): Buffer {
  const src = readFileSync(file);
  if (!file.endsWith('.ts')) return src;
  return Buffer.from(stripTypeScriptTypes(src.toString('utf8'), { mode: 'transform', sourceUrl: file }));
}
