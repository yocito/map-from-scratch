import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { measureFootprint, checkDependencies, isSoftwareGpu } from '../lib/footprint.mjs';

test('footprint sums raw and gzip bytes of shipped code and data', () => {
  const d = mkdtempSync(join(tmpdir(), 'fp-'));
  writeFileSync(join(d, 'a.js'), 'x'.repeat(1000));
  writeFileSync(join(d, 'b.wgsl'), 'y'.repeat(500));
  writeFileSync(join(d, 'd.bin'), Buffer.alloc(2048));
  const m = measureFootprint(d, { code: ['a.js', 'b.wgsl'], data: ['d.bin'] });
  assert.equal(m.code_bytes, 1500);
  assert.ok(m.code_gzip_bytes > 0 && m.code_gzip_bytes < 200);
  assert.equal(m.data_bytes, 2048);
  assert.ok(m.data_gzip_bytes > 0 && m.data_gzip_bytes < 100);
});

test('a listed file that does not exist is an error, not zero bytes', () => {
  const d = mkdtempSync(join(tmpdir(), 'fp-'));
  assert.throws(() => measureFootprint(d, { code: ['missing.js'] }), /missing.js/);
});

test('earcut is the only allowed external dependency', () => {
  assert.deepEqual(checkDependencies([]), []);
  assert.deepEqual(checkDependencies(['earcut']), []);
  assert.deepEqual(checkDependencies(['earcut', 'three']), ['three']);
});

test('software rasterisers are recognised', () => {
  assert.equal(isSoftwareGpu('ANGLE (NVIDIA, Vulkan 1.4 (NVIDIA GeForce RTX 3060))'), false);
  assert.equal(isSoftwareGpu('ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero)))'), true);
  assert.equal(isSoftwareGpu('llvmpipe (LLVM 19.1.7, 256 bits)'), true);
  assert.equal(isSoftwareGpu(undefined), false);
});
