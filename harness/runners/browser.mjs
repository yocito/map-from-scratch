import { spawn } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync, rmSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CDP } from '../lib/cdp.mjs';
import { serve } from '../lib/serve.mjs';
import { Collector } from '../lib/protocol.mjs';

// GPU flags for headless Chromium on Linux with the NVIDIA driver injected by
// the container runtime. Override with MFS_CHROME_FLAGS when a machine needs
// something else; the GPU the page actually got is recorded in info.gpu, so a
// silent fall back to SwiftShader is visible in every result.
const GPU_FLAGS = [
  '--ignore-gpu-blocklist',
  '--enable-gpu',
  '--use-angle=vulkan',
  '--enable-features=Vulkan,VulkanFromANGLE,DefaultANGLEVulkan',
  '--enable-unsafe-webgpu',
  '--disable-vulkan-surface',
  '--disable-gpu-vsync',
  '--disable-frame-rate-limit',
];

export async function launchChrome(logFile) {
  const userDir = mkdtempSync(join(tmpdir(), 'mfs-chrome-'));
  const flags = process.env.MFS_CHROME_FLAGS ? process.env.MFS_CHROME_FLAGS.split(/\s+/) : GPU_FLAGS;
  const proc = spawn(process.env.CHROME_BIN ?? 'chromium', [
    '--headless=new',
    '--no-sandbox',
    '--no-first-run',
    '--no-default-browser-check',
    '--remote-debugging-port=0',
    `--user-data-dir=${userDir}`,
    ...flags,
    'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  const wsUrl = await new Promise((resolve, reject) => {
    let buf = '';
    const timer = setTimeout(() => reject(new Error(`chromium did not start:\n${buf}`)), 30000);
    proc.stderr.on('data', (d) => {
      buf += d;
      if (logFile) appendFileSync(logFile, d);
      const m = buf.match(/DevTools listening on (ws:\/\/\S+)/);
      if (m) { clearTimeout(timer); resolve(m[1]); }
    });
    proc.on('exit', (code) => reject(new Error(`chromium exited ${code}:\n${buf}`)));
  });
  const cdp = await CDP.connect(wsUrl);
  return {
    cdp,
    pid: proc.pid,
    async close() {
      cdp.close();
      proc.kill('SIGKILL');
      await new Promise((r) => proc.once('exit', r));
      rmSync(userDir, { recursive: true, force: true });
    },
  };
}

// Resident memory of the browser and every process under it, in MB.
function treeRssMb(rootPid) {
  const children = new Map();
  const rss = new Map();
  for (const name of readdirSync('/proc')) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const status = readFileSync(`/proc/${name}/status`, 'utf8');
      const ppid = Number(status.match(/^PPid:\s+(\d+)/m)[1]);
      const kb = Number(status.match(/^VmRSS:\s+(\d+)/m)?.[1] ?? 0);
      rss.set(Number(name), kb);
      if (!children.has(ppid)) children.set(ppid, []);
      children.get(ppid).push(Number(name));
    } catch { /* process went away */ }
  }
  let total = 0;
  const stack = [rootPid];
  while (stack.length) {
    const pid = stack.pop();
    total += rss.get(pid) ?? 0;
    stack.push(...(children.get(pid) ?? []));
  }
  return total / 1024;
}

async function runOnce(chrome, url, spec, outDir, i, collector, screenshot) {
  const { cdp } = chrome;
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  const s = (m, p) => cdp.send(m, p, sessionId);
  const off = [];
  try {
    await s('Runtime.enable');
    await s('Page.enable');
    await s('Performance.enable');
    await s('Network.enable');
    await s('Network.setCacheDisabled', { cacheDisabled: true });
    const v = spec.run.viewport;
    await s('Emulation.setDeviceMetricsOverride', v);
    if (v.mobile) await s('Emulation.setTouchEmulationEnabled', { enabled: true });
    await s('Emulation.setCPUThrottlingRate', { rate: spec.run.cpuThrottle });
    await s('Runtime.addBinding', { name: '__mfsEmit' });

    let bytes = 0;
    off.push(cdp.on('Network.loadingFinished', (p, sid) => { if (sid === sessionId) bytes += p.encodedDataLength; }));
    const done = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout after ${spec.timeoutMs} ms`)), spec.timeoutMs);
      off.push(cdp.on('Runtime.bindingCalled', (p, sid) => {
        if (sid !== sessionId || p.name !== '__mfsEmit') return;
        const ev = JSON.parse(p.payload);
        collector.add(ev);
        if (ev.done || ev.error) { clearTimeout(timer); resolve(); }
      }));
      off.push(cdp.on('Runtime.exceptionThrown', (p, sid) => {
        if (sid !== sessionId) return;
        const d = p.exceptionDetails;
        collector.add({ error: `exception: ${d.exception?.description ?? d.text}` });
        clearTimeout(timer);
        resolve();
      }));
    });
    await s('Page.navigate', { url });
    await done;

    const { metrics } = await s('Performance.getMetrics');
    const m = Object.fromEntries(metrics.map((x) => [x.name, x.value]));
    collector.add({ metric: 'js_heap_mb', value: m.JSHeapUsedSize / 2 ** 20 });
    collector.add({ metric: 'transfer_kb', value: bytes / 1024 });
    collector.add({ metric: 'browser_rss_mb', value: treeRssMb(chrome.pid) });
    if (screenshot) {
      const { data } = await s('Page.captureScreenshot', { format: 'png' });
      writeFileSync(join(outDir, 'screenshot.png'), Buffer.from(data, 'base64'));
    }
  } finally {
    for (const f of off) f();
    await cdp.send('Target.closeTarget', { targetId });
  }
}

export async function benchBrowser(root, spec, outDir, { iterations }) {
  const server = await serve(root);
  const url = `http://127.0.0.1:${server.address().port}/${spec.run.page}?bench=1`;
  const logFile = join(outDir, 'chrome.log');
  writeFileSync(logFile, '');
  const chrome = await launchChrome(logFile);
  const collector = new Collector();
  try {
    const { product } = await chrome.cdp.send('Browser.getVersion');
    collector.add({ info: { browser: product } });
    const warm = new Collector();
    const warmSpec = { run: { viewport: { width: 64, height: 64, deviceScaleFactor: 1, mobile: false }, cpuThrottle: 1 }, timeoutMs: 30000 };
    const base = url.slice(0, url.indexOf('/', 'http://'.length));
    await runOnce(chrome, `${base}/harness/probe/warmup.html`, warmSpec, outDir, -1, warm, false);
    collector.add({ info: warm.info });
    for (const e of warm.errors) collector.add({ error: `warm-up: ${e}` });
    for (let i = 0; i < iterations; i++) {
      await runOnce(chrome, url, spec, outDir, i, collector, i === iterations - 1);
    }
  } finally {
    await chrome.close();
    server.close();
  }
  return collector.result();
}
