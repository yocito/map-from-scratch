import { readFileSync } from 'node:fs';
import { join, basename } from 'node:path';

const RUNTIMES = ['browser', 'native'];
const STATS = ['min', 'p50', 'p95', 'p99', 'max', 'mean'];

export function loadSpec(dir) {
  const spec = JSON.parse(readFileSync(join(dir, 'spec.json'), 'utf8'));
  return validateSpec(spec, basename(dir));
}

export function validateSpec(spec, dirName) {
  const fail = (msg) => { throw new Error(`${dirName}/spec.json: ${msg}`); };
  if (spec.id !== dirName) fail(`id "${spec.id}" must equal the directory name`);
  if (typeof spec.request !== 'string' || !spec.request) fail('request (the fictional instruction) is required');
  if (!RUNTIMES.includes(spec.runtime)) fail(`runtime must be one of ${RUNTIMES.join(', ')}`);
  spec.run ??= {};
  if (spec.runtime === 'browser') {
    if (!spec.run.page) fail('run.page is required for a browser renderer');
    spec.run.viewport = { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false, ...spec.run.viewport };
    spec.run.cpuThrottle ??= 1;
  } else if (!Array.isArray(spec.run.cmd)) {
    fail('run.cmd (argv array) is required for a native renderer');
  }
  // Code that ships: files (footprint.code), or for a microcontroller the
  // object files whose sections are measured (footprint.elf).
  const shipped = [...(spec.footprint?.code ?? []), ...(spec.footprint?.elf ?? [])];
  if (shipped.length === 0) fail('footprint.code or footprint.elf (what ships) is required');
  spec.footprint.code ??= [];
  spec.footprint.data ??= [];
  spec.dependencies ??= [];
  spec.gpu ??= 'hardware';
  if (!['hardware', 'none'].includes(spec.gpu)) fail('gpu must be "hardware" or "none"');
  spec.iterations ??= 5;
  spec.timeoutMs ??= 120000;
  spec.budgets ??= {};
  for (const [name, b] of Object.entries(spec.budgets)) {
    if (b.max === undefined && b.min === undefined) fail(`budget ${name} needs max or min`);
    if (b.stat !== undefined && !STATS.includes(b.stat)) fail(`budget ${name}: stat must be one of ${STATS.join(', ')}`);
  }
  return spec;
}
