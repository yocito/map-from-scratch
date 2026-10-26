import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { zxyToTileId, deserializeDirectory, PMTiles } from '../pmtiles.ts';

test('tile ids follow the spec (Hilbert order per zoom)', () => {
  assert.equal(zxyToTileId(0, 0, 0), 0);
  assert.equal(zxyToTileId(1, 0, 0), 1);
  assert.equal(zxyToTileId(1, 0, 1), 2);
  assert.equal(zxyToTileId(1, 1, 1), 3);
  assert.equal(zxyToTileId(1, 1, 0), 4);
  assert.equal(zxyToTileId(2, 0, 0), 5);
  // values from the reference implementation (protomaps pmtiles, tileid.test)
  assert.equal(zxyToTileId(12, 3423, 1763), 19078479);
});

test('directory varints decode, including the offset shorthand', () => {
  // 2 entries: ids 5, 7; run lengths 1, 1; lengths 10, 20; offsets 0 (stored +1), then contiguous (0)
  const u8 = Uint8Array.from([2, 5, 2, 1, 1, 10, 20, 1, 0]);
  assert.deepEqual(deserializeDirectory(u8), [
    { tileId: 5, offset: 0, length: 10, runLength: 1 },
    { tileId: 7, offset: 10, length: 20, runLength: 1 },
  ]);
});

// A real archive when this machine has it (yuisekin-z); skipped elsewhere.
const AERIAL = '/sata_hdd_24tb/www/html/static/planetarble/planet_tokyo23_seamlessphoto.pmtiles';
test('reads a tile from a local raster archive', { skip: !existsSync(AERIAL) }, () => {
  const pm = new PMTiles(AERIAL);
  const h = pm.header;
  assert.ok(h.maxZoom >= h.minZoom);
  // The centre of the bounds: this archive's header centre is wrong
  // (-75.008, 35.675, outside its own bounds).
  const lon = (h.bounds[0] + h.bounds[2]) / 2, lat = (h.bounds[1] + h.bounds[3]) / 2;
  const z = h.maxZoom - 2;
  const n = 2 ** z;
  const x = Math.floor(((lon + 180) / 360) * n);
  const s = Math.sin((lat * Math.PI) / 180);
  const y = Math.floor((0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * n);
  const t = pm.tile(z, x, y);
  assert.ok(t && t.length > 100, `tile ${z}/${x}/${y} present`);
  const magic = Array.from(t!.subarray(0, 4));
  const isImage = (magic[0] === 0xff && magic[1] === 0xd8) || (magic[0] === 0x89 && magic[1] === 0x50) || String.fromCharCode(...magic) === 'RIFF';
  assert.ok(isImage, `image magic, got ${magic}`);
  pm.close();
});
