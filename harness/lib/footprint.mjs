import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';

// What the renderer costs to ship: the code a user downloads (or the binary
// that gets installed) and the data it loads. spec.footprint lists the files,
// relative to the repository root.
export function measureFootprint(root, { code = [], data = [] }) {
  const read = (f) => {
    try {
      return readFileSync(join(root, f));
    } catch {
      throw new Error(`footprint file not found: ${f} (build/bake first?)`);
    }
  };
  const codeBufs = code.map(read);
  const all = Buffer.concat(codeBufs);
  return {
    code_bytes: all.length,
    code_gzip_bytes: code.length ? gzipSync(all, { level: 9 }).length : 0,
    data_bytes: data.map(read).reduce((a, b) => a + b.length, 0),
  };
}

export const ALLOWED_DEPENDENCIES = ['earcut'];

export function checkDependencies(deps) {
  return deps.filter((d) => !ALLOWED_DEPENDENCIES.includes(d));
}

// A frame time measured on SwiftShader or llvmpipe is a CPU number dressed up
// as a GPU number. Runs that land there are reported as errors.
export function isSoftwareGpu(name) {
  return /swiftshader|llvmpipe|softpipe|software/i.test(name ?? '');
}
