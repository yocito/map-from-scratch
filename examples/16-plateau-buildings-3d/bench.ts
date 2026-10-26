// Bench for 16, loaded only with ?bench once the first view has settled, so
// none of it counts in first_frame_ms or settled_ms. Scenarios and checks
// are those of spec.yaml (benchmarks.scenarios, verification.checks).
import { emit, glRenderer, benchFrames } from '../../harness/page/bench.ts';
import { VIEWS, lookAt, ortho, perspective, mul, type Cam } from './camera.ts';
import { Archive, Loader, inflate, decodeBlock, type Header } from './plb.ts';
import { SKY, type View } from './render.ts';

type Marks = Record<string, { t: number; bytes: number; requests: number }>;
const BASE = '../../data/baked/16-plateau-buildings-3d/';
const nextFrame = () => new Promise<number>((r) => requestAnimationFrame(r));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
// Checks go to the harness and, with their details, into info (the
// harness keeps a detail only when the check fails).
const details: Record<string, string> = {};
const check = (id: string, pass: boolean, detail: string) => { details[id] = detail; emit({ check: id, pass, detail }); };

export async function run(view: View, ar: Archive, marks: Marks): Promise<void> {
  const { gl, cam, h } = view;
  const W = gl.canvas.width, H = gl.canvas.height;
  gl.canvas.addEventListener('webglcontextlost', () => emit({ error: 'webgl context lost' }));
  const truth = await (await fetch(BASE + 'truth.json')).json();
  const cost = await (await fetch(BASE + 'citygml-cost.json')).json();

  // --- first-frame and settled (measured by main.ts before this file loaded)
  emit({ metric: 'first_frame_ms', value: marks.first.t });
  emit({ metric: 'first_range_bytes', value: marks.first.bytes });
  emit({ metric: 'first_range_requests', value: marks.first.requests });
  emit({ metric: 'settled_ms', value: marks.settled.t });
  emit({ metric: 'settled_range_bytes', value: marks.settled.bytes });
  emit({ metric: 'settled_range_requests', value: marks.settled.requests });
  emit({ metric: 'range_bytes', value: marks.settled.bytes });
  emit({ metric: 'range_requests', value: marks.settled.requests });
  emit({ metric: 'bytes_vs_citygml_v1', value: cost.V1.citygml.range_bytes / marks.settled.bytes });
  // Requests of the page up to settled: the document plus every resource
  // started before the bench was imported.
  const cold = performance.getEntriesByType('resource').filter((e) => e.startTime < marks.settled.t).length + 1;
  emit({ metric: 'cold_requests', value: cold });
  const timeline = [...performance.getEntriesByType('mark').map((e) => `${e.name}@${e.startTime.toFixed(0)}`),
    ...performance.getEntriesByType('resource').filter((e) => e.startTime < marks.settled.t).map((e) => `${e.name.split('/').pop()}@${e.startTime.toFixed(0)}-${(e as PerformanceResourceTiming).responseEnd.toFixed(0)}`)];
  emit({ info: { gpu: glRenderer(gl), canvas: [W, H], tiles: h.tiles.length, v1_visible: view.last!.visible.length, citygml_v1: cost.V1.citygml, timeline: timeline.join(' '), first_ranges: ar.log.slice(0, marks.first.requests).map((g) => g.want).join(' ') } });

  const read = (): Uint8Array => { const px = new Uint8Array(W * H * 4); gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, px); return px; };
  view.draw();
  const v1Range = read();
  const nearFar: number[][] = [];
  const draw = () => { const f = view.draw(); nearFar.push([f.near, f.far]); };
  const blocksDone = () => view.last!.visible.every((i) => view.has(2 * i) && view.has(2 * i + 1)) && view.loader!.inflight === 0;
  const settle = async (c: Partial<Cam>) => {
    Object.assign(cam, c);
    for (let t0 = performance.now(); ; await nextFrame()) {
      draw();
      if (blocksDone()) return;
      if (performance.now() - t0 > 30000) throw new Error(`no settle at ${JSON.stringify(cam)}`);
    }
  };

  // --- close-cold: everything forgotten, then V3 until settled -------------
  view.reset();
  const r0 = { bytes: ar.bytes, requests: ar.requests };
  const t0 = performance.now();
  const closeT = await new Promise<number>((res) => { view.onMark = (n, t) => { if (n === 'settled') res(t); }; Object.assign(cam, VIEWS.V3); view.request(); });
  view.onMark = null;
  emit({ metric: 'close_settled_ms', value: closeT - t0 });
  emit({ metric: 'close_range_bytes', value: ar.bytes - r0.bytes });
  emit({ metric: 'close_range_requests', value: ar.requests - r0.requests });
  await settle(VIEWS.V3);
  // detail-arrives: L1 present for every visible tile, and it changes the image.
  view.showL1 = false; view.draw();
  const l0Only = read(), callsL0 = view.calls.join('+');
  view.showL1 = true; draw();
  const withL1 = read(), calls = view.calls.join('+');
  let diff = 0;
  for (let i = 0; i < l0Only.length; i += 4) if (l0Only[i] !== withL1[i] || l0Only[i + 1] !== withL1[i + 1] || l0Only[i + 2] !== withL1[i + 2]) diff++;
  const allL1 = view.last!.visible.every((i) => view.has(2 * i + 1));
  check('detail-arrives', allL1 && diff / (W * H) >= 0.01, `L1 in all ${view.last!.visible.length} visible tiles: ${allL1}; draw calls ${callsL0} -> ${calls}; ${(100 * diff / (W * H)).toFixed(1)}% of pixels change`);
  await benchFrames(gl, 120, draw, { prefix: 'close_' });

  // --- orbit: lap 1 cold while loading, lap 2 with everything in memory ----
  view.reset();
  const orbit = (yaw: number): Cam => ({ x: 0, y: 0, z: 20, yaw, pitch: 35, dist: 800 });
  const lap1 = { bytes: ar.bytes, requests: ar.requests, t: performance.now() };
  for (let i = 0; i < 360; i++) { Object.assign(cam, orbit(i)); draw(); await nextFrame(); }
  for (let yaw = 0; yaw < 360; yaw += 10) await settle(orbit(yaw));
  emit({ info: { orbit_lap1_ms: Math.round(performance.now() - lap1.t), orbit_lap1_range_requests: ar.requests - lap1.requests, orbit_lap1_range_bytes: ar.bytes - lap1.bytes } });
  const lap2 = { requests: ar.requests, bytes: ar.bytes, gpu: view.gpuBytes };
  await benchFrames(gl, 360, (i) => { Object.assign(cam, orbit(i)); draw(); });
  await sleep(100);
  emit({ metric: 'orbit_range_requests', value: ar.requests - lap2.requests });
  emit({ metric: 'orbit_range_bytes', value: ar.bytes - lap2.bytes });
  check('no-refetch', ar.requests === lap2.requests && view.gpuBytes === lap2.gpu, `lap 2: ${ar.requests - lap2.requests} requests, GPU buffers ${lap2.gpu} -> ${view.gpuBytes} B`);

  // --- fixed views and the zoom path, with every tile loaded ---------------
  await settle(VIEWS.V2);
  emit({ metric: 'gpu_buffer_bytes', value: view.gpuBytes });
  await benchFrames(gl, 120, draw, { prefix: 'whole_' });
  const zoom = (i: number): Cam => ({ x: 0, y: 0, z: 20, yaw: 135, pitch: 35, dist: 3000 * Math.pow(80 / 3000, 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / 299)) });
  await benchFrames(gl, 300, (i) => { Object.assign(cam, zoom(i)); draw(); }, { prefix: 'zoom_' });
  await settle(VIEWS.V4);
  await benchFrames(gl, 120, draw, { prefix: 'grazing_' });

  // --- drag: synthetic pointer events, event to GPU-complete frame ---------
  await settle(VIEWS.V1);
  const cv = gl.canvas as HTMLCanvasElement, px = new Uint8Array(4);
  const ev = (type: string, x: number) => cv.dispatchEvent(new PointerEvent(type, { clientX: x, clientY: 400, button: 0, buttons: 1, pointerId: 1, bubbles: true }));
  ev('pointerdown', 400);
  const drag: number[] = [];
  for (let i = 1; i <= 120; i++) {
    const t = performance.now();
    ev('pointermove', 400 + 3 * i);
    await nextFrame();                       // the renderer's frame ran just before this callback
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
    drag.push(performance.now() - t);
    nearFar.push([view.last!.near, view.last!.far]);
  }
  ev('pointerup', 760);
  emit({ metric: 'drag_ms', values: drag });

  // --- idle: nothing to draw once settled ----------------------------------
  await settle(VIEWS.V1);
  await nextFrame(); await nextFrame();
  const f0 = view.frames;
  await sleep(500);
  check('idle-no-frames', view.frames === f0, `${view.frames - f0} frames in 500 ms`);
  for (const v of Object.values(VIEWS)) { Object.assign(cam, v); draw(); }
  const badNF = nearFar.filter(([n, f]) => !(Number.isFinite(n) && Number.isFinite(f) && n >= 1 && n < f && f < 10000));
  check('near-far-finite', badNF.length === 0, `${nearFar.length} frames, near ${Math.min(...nearFar.map((x) => x[0])).toFixed(1)}..${Math.max(...nearFar.map((x) => x[0])).toFixed(1)}, far max ${Math.max(...nearFar.map((x) => x[1])).toFixed(0)}, bad ${badNF.length}`);

  // --- range-206: every data response answered the range asked ------------
  const bad = ar.log.filter((g) => g.want && (g.status !== 206 || g.encoding !== null || !g.range || g.range.split('/')[0] !== g.want.replace('=', ' ')));
  check('range-206', bad.length === 0 && ar.log.length > 0, `${ar.log.length} responses, ${bad.length} wrong${bad.length ? ': ' + JSON.stringify(bad[0]) : ''}; magic, version and index CRC32 ok`);

  // --- whole-equals-range: the file read in one request draws the same V1 --
  const whole = new Archive(ar.url);
  await whole.open(true);
  const rangeLoader = view.loader;
  view.reset();
  view.loader = new Loader(whole, h, (t, l, m) => view.add(t, l, m));
  await settle(VIEWS.V1);
  view.draw();
  const v1Whole = read();
  let wdiff = 0;
  for (let i = 0; i < v1Whole.length; i++) if (v1Whole[i] !== v1Range[i]) wdiff++;
  check('whole-equals-range', wdiff === 0, `${wdiff} differing bytes; whole file ${whole.bytes} B in ${whole.requests} request`);
  view.loader = rangeLoader;

  // --- truth: decoded blocks against DuckDB's numbers ----------------------
  await truthChecks(h, whole.whole!, truth);

  // --- screen checks -------------------------------------------------------
  const isSky = (p: Uint8Array, o: number) => Math.abs(p[o] - SKY[0] * 255) <= 3 && Math.abs(p[o + 1] - SKY[1] * 255) <= 3 && Math.abs(p[o + 2] - SKY[2] * 255) <= 3;
  // Ground: green clearly above red (flat ground has G - R = 14). A pixel
  // that mixes roof and ground samples (sub-pixel edges, or a building's
  // floor level with the terrain) is not counted as ground.
  const isGround = (p: Uint8Array, o: number) => p[o + 1] >= p[o] + 4 && p[o + 1] > p[o + 2];
  const all = h.tiles.map((_, i) => i);
  await settle(VIEWS.V2);

  // tallest-on-horizon: eye level with the tallest point, 600 m south of it.
  const T = truth.tallest;
  const horizon = (dz: number) => {
    const eye = [T.x, T.y - 600, T.maxz + dz];
    view.draw({ vp: mul(perspective((45 * Math.PI) / 180, W / H, 1, 5000), lookAt(eye, [T.x, T.y, T.maxz + dz], [0, 0, 1])), eye, fog: false, visible: all });
    const p = read();
    let above = 0;
    for (let row = 0; row < H; row++) {
      const fromTop = H - 1 - row;
      if (fromTop >= H / 2 - 2) continue;
      for (let x = 0; x < W; x++) if (!isSky(p, (row * W + x) * 4)) above++;
    }
    return above;
  };
  const atTop = horizon(0), below = horizon(-2);
  check('tallest-on-horizon', atTop === 0 && below > 0, `eye at ${T.maxz} m: ${atTop} non-sky pixels 2+ px above the horizon; eye 2 m lower: ${below}`);

  // every-building-drawn and ground-covers: orthographic, straight down,
  // one quadrant of the area at a time (1.3 m a pixel).
  let big = 0, bigOk = 0, ok = 0, strict = 0, skyIn = 0;
  const misses: string[] = [];
  for (const cx of [-500, 500]) for (const cy of [-500, 500]) {
    const hh = 520, hw = (hh * W) / H;
    view.draw({ vp: mul(ortho(-hw, hw, -hh, hh, 1, 2000), lookAt([cx, cy, 1000], [cx, cy, 0], [0, 1, 0])), eye: [cx, cy, 1000], fog: false, visible: all });
    const top = read();
    const at = (x: number, y: number) => [Math.floor(((x - cx + hw) / (2 * hw)) * W), Math.floor(((y - cy + hh) / (2 * hh)) * H)];   // y: GL row from bottom
    const drawn = (o: number) => !isSky(top, o) && !isGround(top, o);
    for (const [x, y, area] of truth.points as number[][]) {
      if ((x < 0) !== (cx < 0) || (y < 0) !== (cy < 0)) continue;
      const [c, r] = at(x, y);
      let hit = false;
      for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) if (drawn(((r + dr) * W + c + dc) * 4)) hit = true;
      if (drawn((r * W + c) * 4)) strict++;
      if (hit) ok++; else if (misses.length < 5) misses.push(`${x},${y} (${area} m2, rgb ${top.subarray((r * W + c) * 4, (r * W + c) * 4 + 3).join(',')})`);
      if (area >= 25) { big++; if (hit) bigOk++; }
    }
    const [c0, r0b] = at(cx - 499, cy - 499), [c1, r1b] = at(cx + 499, cy + 499);
    for (let r = r0b; r <= r1b; r++) for (let c = c0; c <= c1; c++) if (isSky(top, (r * W + c) * 4)) skyIn++;
  }
  const n = truth.points.length;
  check('every-building-drawn', bigOk === big && ok / n >= 0.995, `${bigOk}/${big} footprints >= 25 m2, ${ok}/${n} all (centre pixel itself ${strict}); missed ${misses.join(' ')}`);
  check('ground-covers', skyIn === 0, `${skyIn} sky pixels inside the square`);

  // Back-face culling of the shells (?cull=1): pixels it changes per view.
  const cullDiff: Record<string, number> = {};
  for (const name of ['V1', 'V3', 'V4']) {
    Object.assign(cam, VIEWS[name]);
    const was = view.cull;
    view.cull = false; view.draw(); const a = read();
    view.cull = true; view.draw(); const b = read();
    view.cull = was;
    let d = 0;
    for (let i = 0; i < a.length; i += 4) if (a[i] !== b[i] || a[i + 1] !== b[i + 1] || a[i + 2] !== b[i + 2]) d++;
    cullDiff[name] = d;
  }
  emit({ info: { cull_changes_pixels: cullDiff } });

  // wall-luminance-equal: two big south-facing walls in different tiles,
  // each seen from 8 m straight in front; the centre 5 x 5 pixels.
  const lum = truth.walls.map((w: { c: number[]; n: number[] }) => {
    const eye = w.c.map((v, k) => v + w.n[k] * 8);
    view.draw({ vp: mul(perspective((45 * Math.PI) / 180, W / H, 0.5, 3000), lookAt(eye, w.c, [0, 0, 1])), eye, fog: true, visible: all });
    const p = new Uint8Array(100);
    gl.readPixels(W / 2 - 2, H / 2 - 2, 5, 5, gl.RGBA, gl.UNSIGNED_BYTE, p);
    let s = 0;
    for (let i = 0; i < 100; i += 4) s += 0.2126 * p[i] + 0.7152 * p[i + 1] + 0.0722 * p[i + 2];
    return s / 25;
  });
  check('wall-luminance-equal', lum.length === 2 && Math.abs(lum[0] - lum[1]) <= 3, `luminance ${lum.map((v: number) => v.toFixed(1)).join(' / ')} (tiles ${truth.walls.map((w: { tile: number }) => w.tile).join(', ')})`);

  // attribution
  const text = document.body.textContent ?? '';
  const need = ['千代田区', '中央区', 'PLATEAU', 'PDL1.0', '3D都市モデル（Project PLATEAU）千代田区（2025年度）', '3D都市モデル（Project PLATEAU）中央区（2025年度）'];
  const lack = need.filter((s) => !text.includes(s));
  check('attribution', lack.length === 0, lack.length ? `missing ${lack.join(', ')}` : 'all present');

  // Leave V1 (or the view named by ?shot=) on screen for the screenshot.
  Object.assign(cam, VIEWS[new URLSearchParams(location.search).get('shot') ?? 'V1'] ?? VIEWS.V1);
  view.draw();
  emit({ info: { checks: details } });
  emit({ done: true });
}

// The archive against truth.json: buildings per tile, triangles per tile and
// level (decoded indices + dropped = the formula on the text), and the
// extent of the decoded vertices against every point of the text (1 cm).
async function truthChecks(h: Header, file: Uint8Array, truth: { buildings: number; tiles: Record<string, { buildings: number; tri: number[]; min: number[]; max: number[] }>; tallest: { maxz: number } }): Promise<void> {
  const tb = h.tiles.map((t) => ({ t, want: truth.tiles[`${t.tx},${t.ty}`] }));
  const wrongB = tb.filter(({ t, want }) => !want || want.buildings !== t.buildings);
  const total = h.tiles.reduce((s, t) => s + t.buildings, 0);
  check('truth-buildings', wrongB.length === 0 && total === truth.buildings && h.tiles.length === Object.keys(truth.tiles).length, `${total} in the index, ${truth.buildings} in truth; ${wrongB.length} tiles differ`);
  let triBad = 0, extBad = 0, emitted = 0, dropped = 0, tiny = 0, maxz = -Infinity, worst = 0;
  for (const { t, want } of tb) {
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (let l = 0; l < 2; l++) {
      const lv = t.lv[l];
      const m = lv.len ? decodeBlock(await inflate(file.subarray(lv.off, lv.off + lv.len))) : null;
      const ni = m ? m.idx.length : 0;
      if (ni / 3 + lv.dropped !== want?.tri[l]) triBad++;
      emitted += ni / 3; dropped += lv.dropped;
      if (m) for (let i = 0; i < m.nv; i++) for (let k = 0; k < 3; k++) {
        const v = (t.min[k] + m.q[3 * i + k]) / 100;
        if (v < lo[k]) lo[k] = v;
        if (v > hi[k]) hi[k] = v;
      }
    }
    tiny += t.tiny;
    maxz = Math.max(maxz, hi[2]);
    for (let k = 0; k < 3; k++) {
      const e = Math.max(Math.abs(lo[k] - want.min[k]), Math.abs(hi[k] - want.max[k]));
      worst = Math.max(worst, e);
      if (e > 0.01 + 1e-6) extBad++;
    }
  }
  const ratio = (dropped - tiny) / (emitted + dropped);
  emit({ metric: 'dropped_ratio', value: ratio });
  emit({ info: { triangles_emitted: emitted, triangles_dropped: dropped, dropped_in_polygons_under_100cm2: tiny } });
  check('truth-triangles', triBad === 0 && ratio <= 0.001, `${triBad} tile levels differ; ${emitted} triangles drawn, ${dropped} dropped (${tiny} of them in polygons under 100 cm2), the rest ${(ratio * 100).toFixed(3)}%`);
  check('truth-extent', extBad === 0 && Math.abs(maxz - truth.tallest.maxz) <= 0.01, `${extBad} tile axes off by more than 1 cm (worst ${(worst * 100).toFixed(2)} cm); top ${maxz.toFixed(2)} m vs ${truth.tallest.maxz} m`);
}
