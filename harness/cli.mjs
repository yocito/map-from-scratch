#!/usr/bin/env node
// mfs harness. Normally invoked through bin/mfs, which runs it in Docker.
//   list                       examples and their requests
//   bake  <id|all>             prepare data (spec.bake)
//   build <id|all>             compile (spec.build)
//   bench <id|all> [-n N]      measure and check budgets
//   report                     latest results of every example, as Markdown
//   serve [port]               serve the repo for interactive use
//   test                       harness unit tests
import { readdirSync, existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';
import { cpus, loadavg } from 'node:os';
import { loadSpec } from './lib/spec.mjs';
import { summarize } from './lib/stats.mjs';
import { checkBudgets, checkVerification } from './lib/budget.mjs';
import { serve } from './lib/serve.mjs';
import { measureFootprint, measureElf, checkDependencies, isSoftwareGpu } from './lib/footprint.mjs';
import { benchNative } from './runners/native.mjs';
import { benchBrowser } from './runners/browser.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

// Examples are the purpose-built renderers; baselines are the same requests
// done with a general-purpose engine, kept only to measure against.
const SPEC_DIRS = ['examples', 'baselines'];
const dirOf = new Map();
function allIds() {
  dirOf.clear();
  for (const d of SPEC_DIRS) {
    const base = join(root, d);
    if (!existsSync(base)) continue;
    for (const id of readdirSync(base)) {
      if (['spec.yaml', 'spec.json'].some((f) => existsSync(join(base, id, f)))) dirOf.set(id, join(base, id));
    }
  }
  return [...dirOf.keys()].sort();
}
const specDir = (id) => (dirOf.size ? dirOf : (allIds(), dirOf)).get(id);

function select(arg) {
  if (!arg) throw new Error('example id (or "all") required');
  if (arg === 'all') return allIds();
  const hit = allIds().filter((id) => id === arg || id.startsWith(`${arg}-`));
  if (hit.length !== 1) throw new Error(`no unique example matches "${arg}"`);
  return hit;
}

function runStep(id, key) {
  const spec = loadSpec(specDir(id));
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
  const spec = loadSpec(specDir(id));
  const outDir = join(root, 'results', id);
  mkdirSync(outDir, { recursive: true });
  const n = iterations ?? spec.iterations;
  const runner = spec.runtime === 'browser' ? benchBrowser : benchNative;
  const raw = await runner(root, spec, outDir, { iterations: n });
  for (const [k, v] of Object.entries(measureFootprint(root, spec.footprint))) raw.metrics[k] = [v];
  if (spec.footprint.elf) for (const [k, v] of Object.entries(measureElf(root, spec.footprint.elf))) raw.metrics[k] = [v];
  raw.metrics.dependencies = [spec.dependencies.length];
  if (!spec.baseline) for (const d of checkDependencies(spec.dependencies)) raw.errors.push(`dependency not allowed: ${d}`);
  if (spec.gpu === 'hardware' && !raw.info.gpu) raw.errors.push('renderer did not report info.gpu');
  if (spec.gpu === 'hardware' && isSoftwareGpu(raw.info.gpu)) raw.errors.push(`software GPU: ${raw.info.gpu}`);
  const summaries = Object.fromEntries(Object.entries(raw.metrics).map(([k, v]) => [k, summarize(v)]));
  const budgets = checkBudgets(summaries, spec.budgets);
  const checks = checkVerification(spec.checks, raw.checks ?? {}, n);
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
    checks,
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
  for (const c of checks) {
    console.log(`  check  ${c.pass ? 'PASS' : 'FAIL'}  ${c.id} (${c.reported} runs${c.reason ? `, ${c.reason}` : ''}${c.detail ? `, ${c.detail}` : ''})`);
  }
  return raw.errors.length === 0 && budgets.every((b) => b.pass) && checks.every((c) => c.pass);
}

async function main(argv) {
  const [cmd, arg, ...rest] = argv;
  const nIdx = rest.indexOf('-n');
  const iterations = nIdx >= 0 ? Number(rest[nIdx + 1]) : undefined;
  switch (cmd) {
    case 'list':
      for (const id of allIds()) console.log(`${id}\n  ${loadSpec(specDir(id)).request}`);
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
    case 'report': {
      const kb = (b) => (b === undefined ? '-' : b < 10240 ? `${b} B` : `${(b / 1024).toFixed(0)} KB`);
      const ms = (v) => (v === undefined || v === null ? '-' : `${Number(v.toPrecision(3))} ms`);
      console.log('| 例 | 実行環境 | 配るコード | データ | 初回描画 p50 | フレーム p95 | 予算 |');
      console.log('| --- | --- | --- | --- | --- | --- | --- |');
      for (const id of allIds()) {
        const f = join(root, 'results', id, 'latest.json');
        if (!existsSync(f)) { console.log(`| ${id} | 未計測 | | | | | |`); continue; }
        const r = JSON.parse(readFileSync(f, 'utf8'));
        const s = (k, st = 'p50') => r.summaries[k]?.[st];
        const spec = loadSpec(specDir(id));
        const api = spec.definition?.architecture_selection?.chosen?.api?.split(/[(。]/)[0].trim();
        const env = api && api !== 'なし' ? api
          : (spec.runtime === 'native' ? (spec.gpu === 'none' ? 'C (MCU)' : 'C + EGL/GLES3') : (r.env.gpu ? 'WebGL2' : 'Canvas 2D'));
        const code = s('elf_text_bytes') !== undefined ? `${kb(s('elf_text_bytes'))} (.text)` : spec.runtime === 'native' ? `${kb(s('code_bytes'))} (実行ファイル)` : `${kb(s('code_gzip_bytes'))} gzip`;
        const data = s('elf_rodata_bytes') !== undefined ? `${kb(s('elf_rodata_bytes'))} (.rodata)` : `${kb(s('data_gzip_bytes'))} gzip`;
        const passed = r.budgets.filter((b) => b.pass).length;
        const ok = r.errors.length === 0 && passed === r.budgets.length && (r.checks ?? []).every((c) => c.pass);
        console.log(`| ${id} | ${env} | ${code} | ${data} | ${ms(s('first_frame_ms'))} | ${ms(s('frame_ms', 'p95') ?? s('frame_interval_ms', 'p95'))} | ${ok ? '全部通過' : '未達あり'} ${passed}/${r.budgets.length} |`);
      }
      return 0;
    }
    case 'serve': {
      const port = Number(arg ?? 8080);
      await serve(root, port, '0.0.0.0');
      console.log(`serving ${root} on http://localhost:${port}/examples/`);
      return new Promise(() => {});
    }
    case 'probe': {
      const page = arg === 'lifetime' ? 'harness/probe/lifetime.html' : 'harness/probe/index.html';
      const spec = { run: { page, viewport: { width: 64, height: 64, deviceScaleFactor: 1, mobile: false }, cpuThrottle: 1 }, timeoutMs: 30000 };
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
