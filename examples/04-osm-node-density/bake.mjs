// Bake every OSM node of Tokyo's 23 wards as a point.
//   nodes.bin  u32 n, f64 west, south, east, north,
//              u16 dx[n], u16 dy[n]   Morton-ordered, each the difference from
//                                     the previous point mod 2^16
// Points are quantised to 16 bits over the bounding box (~0.5 m) on a local
// equirectangular grid (x scaled by cos of the mid latitude), so a square on
// screen is a square on the ground.
import { writeFileSync, mkdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { source } from '../../tools/sources.ts';

const OUT = 'data/baked/04-osm-node-density';
const pbf = source('osm-tokyo23');

let lon = new Float64Array(1 << 24), lat = new Float64Array(1 << 24), n = 0;
const osmium = spawn('osmium', ['cat', '-t', 'node', '-f', 'opl,add_metadata=false', pbf], { stdio: ['ignore', 'pipe', 'inherit'] });
for await (const line of createInterface({ input: osmium.stdout })) {
  const x = line.indexOf(' x'), y = line.indexOf(' y', x);
  if (x < 0 || y < 0) continue;
  const end = line.indexOf(' ', y + 2);
  lon[n] = Number(line.slice(x + 2, y));
  lat[n] = Number(line.slice(y + 2, end < 0 ? undefined : end));
  if (Number.isNaN(lon[n]) || Number.isNaN(lat[n])) continue;
  n++;
}
lon = lon.subarray(0, n);
lat = lat.subarray(0, n);

// The extract also carries nodes far outside the wards (members of relations
// that reach out to sea and to the islands); 1,500 km of bounding box would
// make one quantisation step ~13 m. Keep the wards' frame and count the rest.
const [w, s, e, nn] = [139.55, 35.50, 139.93, 35.83];
let kept = 0;
for (let i = 0; i < n; i++) {
  if (lon[i] < w || lon[i] > e || lat[i] < s || lat[i] > nn) continue;
  lon[kept] = lon[i];
  lat[kept++] = lat[i];
}
const dropped = n - kept;
n = kept;
// Square grid in ground units: the longer side spans 0..65535.
const k = Math.cos((((s + nn) / 2) * Math.PI) / 180);
const span = Math.max((e - w) * k, nn - s);

// Morton code of the quantised point carries both coordinates, so sorting the
// codes sorts the points.
const part = (v) => {
  v &= 0xffff;
  v = (v | (v << 8)) & 0x00ff00ff;
  v = (v | (v << 4)) & 0x0f0f0f0f;
  v = (v | (v << 2)) & 0x33333333;
  return (v | (v << 1)) & 0x55555555;
};
const unpart = (v) => {
  v &= 0x55555555;
  v = (v | (v >>> 1)) & 0x33333333;
  v = (v | (v >>> 2)) & 0x0f0f0f0f;
  v = (v | (v >>> 4)) & 0x00ff00ff;
  return (v | (v >>> 8)) & 0xffff;
};
const codes = new Uint32Array(n);
for (let i = 0; i < n; i++) {
  const qx = Math.round((((lon[i] - w) * k) / span) * 65535);
  const qy = Math.round(((nn - lat[i]) / span) * 65535);
  codes[i] = (part(qx) | (part(qy) << 1)) >>> 0;
}
codes.sort();

const dx = new Uint16Array(n), dy = new Uint16Array(n);
for (let i = 0, px = 0, py = 0; i < n; i++) {
  const x = unpart(codes[i]), y = unpart(codes[i] >>> 1);
  dx[i] = (x - px) & 0xffff;
  dy[i] = (y - py) & 0xffff;
  px = x; py = y;
}
const head = Buffer.alloc(40);
head.writeUInt32LE(n, 0);
[w, s, e, nn].forEach((v, i) => head.writeDoubleLE(v, 8 + i * 8));
mkdirSync(OUT, { recursive: true });
writeFileSync(`${OUT}/nodes.bin`, Buffer.concat([head, Buffer.from(dx.buffer), Buffer.from(dy.buffer)]));
console.log(`${n} nodes (${dropped} outside the frame dropped), nodes.bin ${40 + n * 4} bytes`);
