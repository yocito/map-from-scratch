import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inflateSync } from 'node:zlib';
import { ppmToPng, parsePpm } from '../lib/png.mjs';

const ppm = Buffer.concat([Buffer.from('P6\n2 1\n255\n'), Buffer.from([255, 0, 0, 0, 0, 255])]);

test('parsePpm reads a binary P6 image', () => {
  const { width, height, rgb } = parsePpm(ppm);
  assert.equal(width, 2);
  assert.equal(height, 1);
  assert.deepEqual([...rgb], [255, 0, 0, 0, 0, 255]);
});

test('parsePpm skips comments in the header', () => {
  const withComment = Buffer.concat([Buffer.from('P6\n# made by roads\n2 1\n255\n'), Buffer.from([1, 2, 3, 4, 5, 6])]);
  assert.equal(parsePpm(withComment).width, 2);
});

test('ppmToPng writes a valid RGB PNG with the same pixels', () => {
  const png = ppmToPng(ppm);
  assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.equal(png.toString('ascii', 12, 16), 'IHDR');
  assert.equal(png.readUInt32BE(16), 2);
  assert.equal(png.readUInt32BE(20), 1);
  assert.equal(png[24], 8, 'bit depth');
  assert.equal(png[25], 2, 'colour type RGB');
  const idat = png.indexOf('IDAT');
  const len = png.readUInt32BE(idat - 4);
  const raw = inflateSync(png.subarray(idat + 4, idat + 4 + len));
  assert.deepEqual([...raw], [0, 255, 0, 0, 0, 0, 255], 'filter byte 0 then the row');
  assert.equal(png.toString('ascii', png.length - 8, png.length - 4), 'IEND');
});

test('a non-P6 file is rejected', () => {
  assert.throws(() => parsePpm(Buffer.from('P3\n1 1\n255\n0 0 0')), /P6/);
});
