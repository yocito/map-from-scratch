import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { Collector, parseLine } from '../lib/protocol.mjs';

function ensureExec(root) {
  const src = join(root, 'harness/native/mfs-exec.c');
  const bin = join(root, '.cache/mfs-exec');
  if (!existsSync(bin) || statSync(bin).mtimeMs < statSync(src).mtimeMs) {
    mkdirSync(join(root, '.cache'), { recursive: true });
    execFileSync('cc', ['-O2', '-Wall', '-o', bin, src], { stdio: 'inherit' });
  }
  return bin;
}

function runOnce(root, spec, outDir, i, collector) {
  const exec = ensureExec(root);
  const resultFile = join(outDir, `exec-${i}.json`);
  return new Promise((resolve, reject) => {
    const child = spawn(exec, [resultFile, '--', ...spec.run.cmd], {
      cwd: root,
      env: { ...process.env, MFS_OUT: outDir, MFS_ITERATION: String(i) },
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    const timer = setTimeout(() => child.kill('SIGKILL'), spec.timeoutMs);
    createInterface({ input: child.stdout }).on('line', (raw) => {
      const tab = raw.indexOf('\t');
      const ms = Number(raw.slice(0, tab)) / 1000;
      const ev = parseLine(raw.slice(tab + 1));
      if (ev) collector.add(ev, ms);
    });
    child.on('error', reject);
    child.on('close', () => {
      clearTimeout(timer);
      const r = JSON.parse(readFileSync(resultFile, 'utf8'));
      if (r.exit_code !== 0) collector.add({ error: `exit ${r.exit_code} signal ${r.signal}` });
      collector.add({ metric: 'wall_ms', value: r.wall_ms });
      collector.add({ metric: 'cpu_ms', value: r.user_ms + r.sys_ms });
      collector.add({ metric: 'peak_rss_mb', value: r.maxrss_kb / 1024 });
      resolve();
    });
  });
}

export async function benchNative(root, spec, outDir, { iterations }) {
  const collector = new Collector();
  for (let i = 0; i < iterations; i++) await runOnce(root, spec, outDir, i, collector);
  return collector.result();
}
