#!/usr/bin/env node
// mfs harness. Normally invoked through bin/mfs, which runs it in Docker.
//   list                       examples and their requests
//   bake  <id|all>             prepare data (spec.bake)
//   build <id|all>             compile (spec.build)
//   bench <id|all> [-n N]      measure and check budgets
//   serve [port]               serve the repo for interactive use
//   test                       harness unit tests
import { readdirSync, existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';
import { cpus, loadavg } from 'node:os';
import { loadSpec } from './lib/spec.mjs';
import { summarize } from './lib/stats.mjs';
import { checkBudgets } from './lib/budget.mjs';
import { serve } from './lib/serve.mjs';
import { measureFootprint, checkDependencies, isSoftwareGpu } from './lib/footprint.mjs';
import { benchNative } from './runners/native.mjs';
import { benchBrowser } from './runners/browser.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const examplesDir = join(root, 'examples');

function allIds() {
  return readdirSync(examplesDir).filter((d) => existsSync(join(examplesDir, d, 'spec.json'))).sort();
}

function select(arg) {
  if (!arg) throw new Error('example id (or "all") required');
  if (arg === 'all') return allIds();
  const hit = allIds().filter((id) => id === arg || id.startsWith(`${arg}-`));
  if (hit.length !== 1) throw new Error(`no unique example matches "${arg}"`);
  return hit;
}

function runStep(id, key) {
  const spec = loadSpec(join(examplesDir, id));
  if (!spec[key]) return;
  console.log(`[${id}] ${key}: ${spec[key].join(' ')}`);
  const r = spawnSync(spec[key][0], spec[key].slice(1), { cwd: root, stdio: 'inherit' });
  if (r.status !== 0) throw new Error(`[${id}] ${key} failed (exit ${r.status})`);
}

function gitRev() {
  try {
    return execFileSync('git', ['-C', root, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
}

function fmt(x) {
  if (x === null || x === undefined) return '-';
  if (Math.abs(x) >= 1e6) return x.toExponential(2);
  return Number(x.toPrecision(4)).toString();
}

async function bench(id, iterations) {
  const spec = loadSpec(join(examplesDir, id));
  const outDir = join(root, 'results', id);
  mkdirSync(outDir, { recursive: true });
  const n = iterations ?? spec.iterations;
  const runner = spec.runtime === 'browser' ? benchBrowser : benchNative;
  const raw = await runner(root, spec, outDir, { iterations: n });
  for (const [k, v] of Object.entries(measureFootprint(root, spec.footprint))) raw.metrics[k] = [v];
  raw.metrics.dependencies = [spec.dependencies.length];
  for (const d of checkDependencies(spec.dependencies)) raw.errors.push(`dependency not allowed: ${d}`);
  if (spec.gpu === 'hardware' && !raw.info.gpu) raw.errors.push('renderer did not report info.gpu');
  if (spec.gpu === 'hardware' && isSoftwareGpu(raw.info.gpu)) raw.errors.push(`software GPU: ${raw.info.gpu}`);
  const summaries = Object.fromEntries(Object.entries(raw.metrics).map(([k, v]) => [k, summarize(v)]));
  const budgets = checkBudgets(summaries, spec.budgets);
  const prevFile = join(outDir, 'latest.json');
  const prev = existsSync(prevFile) ? JSON.parse(readFileSync(prevFile, 'utf8')) : null;
  const result = {
    id,
    at: new Date().toISOString(),
    git: gitRev(),
    iterations: n,
    env: { cpu: cpus()[0]?.model, loadavg: loadavg(), ...raw.info },
    errors: raw.errors,
    summaries,
    budgets,
    samples: raw.metrics,
  };
  writeFileSync(join(outDir, `${result.at.replace(/[:.]/g, '-')}.json`), JSON.stringify(result, null, 1));
  writeFileSync(prevFile, JSON.stringify(result, null, 1));

  console.log(`\n== ${id}  (${n} iterations, gpu: ${raw.info.gpu ?? 'n/a'})`);
  for (const e of raw.errors) console.log(`  ERROR ${e}`);
  console.log('  metric                  n      p50       p95       max     prev p50');
  for (const [k, s] of Object.entries(summaries)) {
    const p = prev?.summaries?.[k]?.p50;
    console.log(`  ${k.padEnd(20)} ${String(s.n).padStart(4)} ${fmt(s.p50).padStart(9)} ${fmt(s.p95).padStart(9)} ${fmt(s.max).padStart(9)} ${fmt(p).padStart(9)}`);
  }
  for (const b of budgets) {
    const lim = b.max !== null ? `<= ${b.max}` : `>= ${b.min}`;
    console.log(`  budget ${b.pass ? 'PASS' : 'FAIL'}  ${b.name} ${b.stat} ${fmt(b.actual)} ${lim}${b.reason ? ` (${b.reason})` : ''}`);
  }
  return raw.errors.length === 0 && budgets.every((b) => b.pass);
}

async function main(argv) {
  const [cmd, arg, ...rest] = argv;
  const nIdx = rest.indexOf('-n');
  const iterations = nIdx >= 0 ? Number(rest[nIdx + 1]) : undefined;
  switch (cmd) {
    case 'list':
      for (const id of allIds()) console.log(`${id}\n  ${loadSpec(join(examplesDir, id)).request}`);
      return 0;
    case 'bake':
    case 'build':
      for (const id of select(arg)) runStep(id, cmd);
      return 0;
    case 'bench': {
      let ok = true;
      for (const id of select(arg)) ok = (await bench(id, iterations)) && ok;
      return ok ? 0 : 1;
    }
    case 'serve': {
      const port = Number(arg ?? 8080);
      await serve(root, port, '0.0.0.0');
      console.log(`serving ${root} on http://localhost:${port}/examples/`);
      return new Promise(() => {});
    }
    case 'probe': {
      const spec = { run: { page: 'harness/probe/index.html', viewport: { width: 64, height: 64, deviceScaleFactor: 1, mobile: false }, cpuThrottle: 1 }, timeoutMs: 30000 };
      const outDir = join(root, 'results', '_probe');
      mkdirSync(outDir, { recursive: true });
      const r = await benchBrowser(root, spec, outDir, { iterations: 1 });
      console.log(JSON.stringify({ ...r.info, errors: r.errors }, null, 1));
      return r.errors.length ? 1 : 0;
    }
    case 'test': {
      const tests = ['harness/test', 'tools/test'].flatMap((d) =>
        readdirSync(join(root, d)).filter((f) => f.endsWith('.test.mjs')).map((f) => join(root, d, f)));
      return spawnSync(process.execPath, ['--test', ...tests], { stdio: 'inherit' }).status;
    }
    default:
      console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 9).join('\n'));
      return cmd ? 2 : 0;
  }
}

main(process.argv.slice(2)).then((code) => process.exit(code), (e) => {
  console.error(e.message);
  process.exit(1);
});
