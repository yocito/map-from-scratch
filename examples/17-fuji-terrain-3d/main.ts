// Mt Fuji in 3D for a PC browser: orbit camera over 48 km of Mapterhorn
// elevation, read from one file by HTTP Range. The page fetches the header,
// the index and the coarsest level in one request, draws them, then fetches
// only the chunks the view needs (merged ranges), decodes them in slices of
// at most 4 ms and draws whenever something changed.
import {
  S, LEVELS, FIRST_BYTES, parseTerr, decodeChunk, makeView, select, ranges, groundMax, FOV_Y,
  type Terr, type Cam, type View, type Selection,
} from './terrain.ts';
import { createRenderer, HEIGHT_OURS } from './gl.ts';
import { VIEWS, TAU } from './views.ts';

const FILE = '../../data/baked/17-fuji-terrain-3d/fuji.terr';
const HALF = 1536 * 15.578601873;   // half the area's width, m
// Ranges closer than this are merged into one request (?gap= to compare).
// 8 KiB measured best: 224 ms to the first view in 18 requests, against
// 241 ms in 10 requests at 32 KiB and 363 ms in 3 at 128 KiB (fast network).
const GAP = Number(new URLSearchParams(location.search).get('gap') ?? 8192);

export type FujiMap = Awaited<ReturnType<typeof mount>>;
declare global { interface Window { __fujiFirst?: Promise<Response> } }

export async function mount(canvas: HTMLCanvasElement, { prefetch = true } = {}) {
  const mountAt = performance.now();
  // Counters of the Range reads (range_requests, range_bytes in the bench).
  // stale: bytes of an older generation that still arrived; aborted:
  // requests cancelled by reset() (both kept across resets, for the bench)
  const net = { requests: 0, bytes: 0, start: 0, stale: 0, aborted: 0 };
  // reset() bumps the generation and aborts the requests still in flight, so
  // an older generation's bytes neither count nor share the bandwidth.
  let gen = 0, abort = new AbortController();
  const body = async (r: Response, g: number): Promise<Uint8Array> => {
    if (r.status !== 206) throw new Error(`fuji.terr: HTTP ${r.status} for a Range request`);
    const u8 = new Uint8Array(await r.arrayBuffer());
    if (g === gen) net.bytes += u8.length; else net.stale += u8.length;
    return u8;
  };
  const read = (start: number, end: number, priority: RequestPriority = 'high'): Promise<Uint8Array> => {
    if (!net.requests) net.start = performance.now();
    net.requests++;
    const g = gen;
    return fetch(FILE, { headers: { Range: `bytes=${start}-${end - 1}` }, priority, signal: abort.signal }).then((r) => body(r, g));
  };
  // index.html starts the first request before this module loads, when it can.
  const early = window.__fujiFirst;
  if (early) { net.requests++; net.start = performance.now(); }
  const first = early ? early.then((r) => body(r, 0)) : read(0, FIRST_BYTES);

  const gl = canvas.getContext('webgl2', { antialias: true, alpha: false, powerPreference: 'high-performance' })!;
  if (!gl) throw new Error('WebGL2 is not available');
  const size = () => {
    canvas.width = Math.round(canvas.clientWidth * devicePixelRatio);
    canvas.height = Math.round(canvas.clientHeight * devicePixelRatio);
  };
  size();
  const tex = gl.createTexture();
  // The program is compiled while the first request is in flight.
  const renderer = createRenderer(gl, HEIGHT_OURS, (p) => {
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, tex);
    gl.uniform1i(gl.getUniformLocation(p, 'u_h'), 0);
  });
  const rendererAt = performance.now();
  let terr: Terr = parseTerr(await first);
  const firstAt = performance.now();
  const n = terr.chunks.length;
  // One layer per chunk, allocated once (26.3 MB for 765 chunks); nothing is evicted.
  gl.bindTexture(gl.TEXTURE_2D_ARRAY, tex);
  gl.texStorage3D(gl.TEXTURE_2D_ARRAY, 1, gl.R16UI, S, S, n);
  gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 2);   // rows of 131 x 2 bytes

  const loaded = new Uint8Array(n), inflight = new Uint8Array(n), wanted = new Uint8Array(n);
  const samples = new Uint16Array(S * S);
  const queue: [number, Uint8Array][] = [];
  const stats = { mountAt, rendererAt, firstBytes: firstAt, l3Decoded: 0, coarseDrawAt: 0, coarse: 0, coarseDraw: [] as number[], complete: 0, completeNet: { requests: 0, bytes: 0 }, frames: 0, selectMs: 0, decodeMs: 0 };
  const hooks: { decoded?: (id: number, s: Uint16Array) => void } = {};

  // Decode queued chunks for at most 4 ms, then yield (MessageChannel, not
  // setTimeout, which is clamped to 4 ms when nested). The 9 chunks of L3
  // (about 5 ms, once) are decoded in one slice, so that the first frame
  // drawn after them covers the whole view.
  const mc = new MessageChannel();
  let pumping = false;
  mc.port1.onmessage = () => {
    const t0 = performance.now();
    let changed = false;
    while (queue.length && (performance.now() - t0 < 4 || terr.chunks[queue[0][0]].k === LEVELS - 1)) {
      const [id, src] = queue.shift()!;
      decodeChunk(src, samples, terr.block);
      if (hooks.decoded) hooks.decoded(id, samples);
      gl.bindTexture(gl.TEXTURE_2D_ARRAY, tex);
      gl.texSubImage3D(gl.TEXTURE_2D_ARRAY, 0, 0, 0, id, S, S, 1, gl.RED_INTEGER, gl.UNSIGNED_SHORT, samples);
      loaded[id] = 1;
      // a wanted chunk, or any chunk while part of the view is still empty
      if (wanted[id] || !sel || sel.uncovered > 0) changed = true;
    }
    // (L3 is the first 9 chunks in file order)
    if (!stats.l3Decoded && changed && loaded.subarray(0, 9).every((l) => l)) stats.l3Decoded = performance.now();
    stats.decodeMs += performance.now() - t0;
    pumping = queue.length > 0;
    if (pumping) mc.port2.postMessage(0);
    if (changed) render();
  };
  // A response covering [start, start + bytes.length): queue every chunk it holds whole.
  const ingest = (start: number, bytes: Uint8Array, g: number) => {
    if (g !== gen) return;
    for (let id = 0; id < n; id++) {
      const c = terr.chunks[id];
      if (loaded[id] || c.off < start || c.off + c.len > start + bytes.length) continue;
      queue.push([id, bytes.subarray(c.off - start, c.off - start + c.len)]);
      inflight[id] = 1;
    }
    if (!pumping) { pumping = true; mc.port2.postMessage(0); }
  };
  const fetchChunks = (ids: number[], gap = GAP, priority: RequestPriority = 'high') => {
    const todo = ids.filter((id) => !loaded[id] && !inflight[id]);
    const g = gen;
    for (const r of ranges(terr, todo, gap)) {
      for (const id of r.ids) inflight[id] = 1;
      read(r.start, r.end, priority).then((b) => ingest(r.start, b, g), () => { if (g === gen) for (const id of r.ids) inflight[id] = 0; else net.aborted++; });   // retried by a later frame
    }
  };
  // Once the view is complete and the camera has rested for 300 ms: every
  // chunk a full turn around the same target at the same pitch and distance
  // needs (180 selections, 2 degrees apart, about 10 ms), at low priority.
  // The request is to turn the view, so a turn never waits.
  let orbitKey = '', orbitIds: number[] = [], restTimer = 0;
  const prefetchOrbit = (): number[] => {
    const key = [cam.tx, cam.ty, cam.tz, cam.pitch, cam.dist, tau].map(Math.round).join();
    if (key === orbitKey) return orbitIds;
    const ids = new Set<number>();
    for (let a = 0; a < 360; a += 2) {
      const v = makeView({ ...cam, yaw: a }, canvas.width, canvas.height, ground);
      for (const id of select(terr, v, tau, () => true).want) ids.add(id);
    }
    orbitKey = key;
    orbitIds = [...ids];
    fetchChunks(orbitIds, GAP, 'low');
    return orbitIds;
  };

  const cam: Cam = { ...VIEWS.default };
  let tau = TAU, pending = false, view: View, sel: Selection;
  let settle: (() => void)[] = [];
  const ground = (x: number, y: number) => groundMax(terr, x, y);
  // Inertia after a drag: the last angular velocity, fading out over 300 ms.
  const spin = { vy: 0, vp: 0, t0: 0, last: 0 };

  // While the camera moves, also fetch what the view will need LEAD ms
  // ahead at the current velocity (yaw, pitch, log distance, target), so a
  // turn that starts before the orbit prefetch finds its chunks loaded.
  // One more selection per moving frame (about 0.05 ms).
  const LEAD = Number(new URLSearchParams(location.search).get('lead') ?? 250);
  const motion = { t: 0, c: null as Cam | null, v: [0, 0, 0, 0, 0] };
  const lookAhead = (now: number) => {
    const prev = motion.c, dt = now - motion.t;
    motion.c = { ...cam };
    motion.t = now;
    if (!prev || dt <= 0 || dt > 200 || !LEAD) { motion.v.fill(0); return; }
    const d = [cam.yaw - prev.yaw, cam.pitch - prev.pitch, Math.log(cam.dist / prev.dist), cam.tx - prev.tx, cam.ty - prev.ty];
    for (let i = 0; i < 5; i++) motion.v[i] = 0.5 * motion.v[i] + 0.5 * (d[i] / dt);
    if (motion.v.every((v) => v === 0)) return;
    const [vy, vp, vd, vx, vt] = motion.v.map((v) => v * LEAD);
    const ahead: Cam = {
      ...cam, yaw: cam.yaw + vy, pitch: Math.min(89, Math.max(8, cam.pitch + vp)),
      dist: Math.min(100000, Math.max(6000, cam.dist * Math.exp(vd))),
      tx: Math.min(HALF, Math.max(-HALF, cam.tx + vx)), ty: Math.min(HALF, Math.max(-HALF, cam.ty + vt)),
    };
    fetchChunks(select(terr, makeView(ahead, canvas.width, canvas.height, ground), tau, () => true).want, GAP, 'low');
  };

  function frame() {
    pending = false;
    const now = performance.now();
    if (spin.t0) {
      const f = 1 - (now - spin.t0) / 300, dt = now - spin.last;
      spin.last = now;
      if (f <= 0) spin.t0 = 0;
      else { cam.yaw += spin.vy * dt * f; cam.pitch = Math.min(89, Math.max(8, cam.pitch + spin.vp * dt * f)); }
    }
    const t0 = performance.now();
    view = makeView(cam, canvas.width, canvas.height, ground);
    sel = select(terr, view, tau, (id) => loaded[id] === 1);
    wanted.fill(0);
    for (const id of sel.want) wanted[id] = 1;
    fetchChunks(sel.want);
    lookAhead(now);
    stats.selectMs = performance.now() - t0;
    renderer.draw(terr, view, sel.draw);
    stats.frames++;
    const sync = () => gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4));
    // the coarse picture: the first frame that covers the whole view (L3 at least)
    if (!stats.coarse && sel.uncovered === 0 && sel.draw.length) {
      stats.coarseDrawAt = t0;
      sync();
      stats.coarse = performance.now();
      stats.coarseDraw = sel.draw.map((id) => terr.chunks[id].k);
    }
    if (sel.want.every((id) => loaded[id])) {
      if (!stats.complete) {
        sync();
        stats.complete = performance.now();
        stats.completeNet = { requests: net.requests, bytes: net.bytes };
      }
      clearTimeout(restTimer);
      if (prefetch) restTimer = setTimeout(prefetchOrbit, 300);
      const s = settle;
      settle = [];
      for (const f of s) f();
    }
    if (spin.t0) render();
  }
  const render = () => { if (!pending) { pending = true; requestAnimationFrame(frame); } };

  // ---- input: left drag orbits, right or shift drag pans, wheel zooms ----
  let drag: { x: number; y: number; t: number; pan: boolean } | null = null;
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  canvas.addEventListener('pointerdown', (e) => {
    drag = { x: e.clientX, y: e.clientY, t: e.timeStamp, pan: e.button === 2 || e.shiftKey };
    spin.t0 = 0; spin.vy = spin.vp = 0;
    try { canvas.setPointerCapture(e.pointerId); } catch { /* a synthetic pointer */ }
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y, dt = Math.max(1, e.timeStamp - drag.t);
    if (drag.pan) {
      const m = (cam.dist * 2 * Math.tan((FOV_Y * Math.PI) / 360)) / canvas.clientHeight, a = (cam.yaw * Math.PI) / 180;
      const cl = (v: number) => Math.min(HALF, Math.max(-HALF, v));
      cam.tx = cl(cam.tx - (dx * Math.cos(a) - dy * Math.sin(a)) * m);
      cam.ty = cl(cam.ty + (dx * Math.sin(a) + dy * Math.cos(a)) * m);
    } else {
      const dYaw = -dx * 0.3, p = Math.min(89, Math.max(8, cam.pitch + dy * 0.2));
      spin.vy = 0.5 * spin.vy + 0.5 * (dYaw / dt);
      spin.vp = 0.5 * spin.vp + 0.5 * ((p - cam.pitch) / dt);
      cam.yaw += dYaw;
      cam.pitch = p;
    }
    drag = { ...drag, x: e.clientX, y: e.clientY, t: e.timeStamp };
    render();
  });
  canvas.addEventListener('pointerup', (e) => {
    if (drag && !drag.pan && e.timeStamp - drag.t < 50 && (spin.vy || spin.vp)) { spin.t0 = spin.last = performance.now(); render(); }
    drag = null;
  });
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    cam.dist = Math.min(100000, Math.max(6000, cam.dist * Math.exp(e.deltaY * 0.0015 * (e.deltaMode === 1 ? 40 : 1))));
    render();
  }, { passive: false });
  new ResizeObserver(() => { size(); render(); }).observe(canvas);

  // (Re)open the file: the first request, then the view's chunks.
  async function open() {
    const g = gen, b = await read(0, FIRST_BYTES);
    terr = parseTerr(b);
    ingest(0, b, g);
  }
  ingest(0, await first, gen);
  await new Promise<void>((r) => { settle.push(r); render(); });   // the first complete view

  return {
    gl, canvas, cam, net, stats, hooks, renderer, loaded,
    get terr() { return terr; }, get view() { return view; }, get sel() { return sel; },
    set tau(v: number) { tau = v; }, get tau() { return tau; },
    get spinning() { return spin.t0 !== 0; },
    render, frame, open, prefetchOrbit, fetchChunks,
    // Resolves at the next frame that draws every wanted chunk at its level.
    settled: () => new Promise<void>((r) => { settle.push(r); render(); }),
    // Forget everything loaded (the texture stays allocated) and count anew.
    reset() {
      gen++; abort.abort(); abort = new AbortController();
      loaded.fill(0); inflight.fill(0); queue.length = 0; net.requests = net.bytes = 0; orbitKey = ''; motion.c = null;
    },
  };
}

const map = await mount(document.getElementById('map') as HTMLCanvasElement, { prefetch: !location.search.includes('bench') });
if (location.search.includes('bench')) (await import('./bench.ts')).run(map);
