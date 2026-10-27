// Bench branch for 07, loaded only with ?bench so it is not part of the page
// a visitor downloads.
import { emit, glRenderer, benchFrames, zoomPath } from '../../harness/page/bench.ts';
import { equalEarth } from '../../tools/geo.ts';
import type { CityMap } from './cities.ts';

// mounted: performance.now() right after mount() resolved, taken in main.ts
// before this file was imported, so the import is not counted as start-up.
export async function run(map: CityMap, tip: HTMLElement, mounted: number): Promise<void> {
  const { gl, cam, n, pos, rad } = map;
  const AY = 1.3174 / 2.7066;
  const W = gl.canvas.width, H = gl.canvas.height, dpr = devicePixelRatio;
  gl.canvas.addEventListener('webglcontextlost', () => emit({ error: 'webgl context lost' }));
  const t = performance.now();
  map.draw();
  gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4));
  emit({ metric: 'first_frame_ms', value: mounted + performance.now() - t });
  emit({ info: { gpu: glRenderer(gl), cities: n, land_vertices: map.landVertices, fan_triangles: map.fanTriangles,
    border_vertices: map.borderVertices, border_segments: map.borderSegments, canvas: [W, H] } });

  const world = (lon: number, lat: number): [number, number] => {
    const [x, y] = equalEarth([lon, lat]);
    return [(x + 2.7066) / (2 * 2.7066), (1.3174 - y) / (2 * 1.3174)];
  };
  const screen = (wx: number, wy: number): [number, number] => [(wx - cam.x) * cam.zoom * W + W / 2, (wy - cam.y) * cam.zoom * W * AY + H / 2];
  const set = (x: number, y: number, zoom: number) => { cam.x = x; cam.y = y; cam.zoom = zoom; };

  // Camera path: whole world into Europe (the densest cluster) at 32x and back.
  const [ex, ey] = world(10, 50);
  const path = zoomPath(300, { cx: ex, cy: ey, z0: 1, z1: 32, pan: 0.002 });
  await benchFrames(gl, path.length, (i) => { set(path[i].cx, path[i].cy, path[i].zoom); map.draw(); });
  // Fixed ends: the whole world (all 7,342 cities and all land on screen) and
  // 32x inside Europe (land fans cover the screen, cities spread out).
  await benchFrames(gl, 120, () => { set(0.5, 0.5, 1); map.draw(); }, { prefix: 'whole_' });
  await benchFrames(gl, 120, () => { set(ex, ey, 32); map.draw(); }, { prefix: 'deep_' });

  // Hover cost: hit test plus tooltip text, at pseudo-random points of the
  // whole-world view. Misses (sea) walk all cities, so they are the worst case.
  set(0.5, 0.5, 1);
  map.draw();
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const hov: number[] = [];
  let hits = 0;
  for (let i = 0; i < 500; i++) {
    const t0 = performance.now();
    const c = map.pick(rnd() * W, rnd() * H);
    map.setHover(c);
    hov.push(performance.now() - t0);
    if (c >= 0) hits++;
  }
  emit({ metric: 'hover_ms', values: hov });
  map.setHover(-1);

  // Every city must be hoverable: centred at 32x, the city under its own
  // centre must be itself. Also count how many already are at 1x.
  const reach = (zoom: number): number => {
    let ok = 0;
    for (let i = 0; i < n; i++) {
      set(pos[2 * i] / 65535, pos[2 * i + 1] / 65535, zoom);
      if (map.pick(W / 2, H / 2) === i) ok++;
    }
    return ok / n;
  };
  const t0 = performance.now();
  const reachable = reach(32);
  emit({ metric: 'reachable_ratio', value: reachable });
  emit({ info: { reachable_at_1x: reach(1), reach_check_ms: performance.now() - t0, hover_hit_ratio: hits / 500 } });

  // Functional checks, read back from the screen.
  // 1. Whole world: the pixel at every city's centre is neither plain land
  //    nor plain sea (it may be another city's white rim in a dense cluster,
  //    so the test is "something was drawn here"), the Greenland ice cap is
  //    land, the central Pacific is sea.
  set(0.5, 0.5, 1);
  map.draw();
  const px = new Uint8Array(W * H * 4);
  gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, px);
  const at = (sx: number, sy: number): number[] => { const o = ((H - 1 - Math.floor(sy)) * W + Math.floor(sx)) * 4; return [px[o], px[o + 1], px[o + 2]]; };
  const near = (c: number[], want: number[]): boolean => c.every((v, k) => Math.abs(v - want[k]) <= 3);
  const LAND = [222, 219, 209], SEA = [204, 224, 237];
  let drawn = 0, orange = 0;
  for (let i = 0; i < n; i++) {
    const c = at(...screen(pos[2 * i] / 65535, pos[2 * i + 1] / 65535));
    if (!near(c, LAND) && !near(c, SEA)) drawn++;
    if (c[0] - c[2] > 60) orange++;
  }
  emit({ check: 'every-centre-drawn', pass: drawn === n, detail: `${drawn} of ${n}` });
  emit({ info: { city_centres_orange: orange / n } });
  const g = at(...screen(...world(-40, 75)));
  emit({ check: 'greenland-is-land', pass: near(g, LAND), detail: g.join(',') });
  const sea = at(...screen(...world(-140, -5)));
  emit({ check: 'pacific-is-sea', pass: near(sea, SEA), detail: sea.join(',') });

  // 2. A real pointermove over Tokyo (at 8x, where it is the top city under
  //    its centre) shows its name and population, and paints it in the
  //    highlight colour. One over the open Pacific shows nothing.
  // The bake always includes Tokyo: its population is the radius scale's POP_MAX.
  const tokyo = Array.from({ length: n }, (_, i) => i).find((i) => map.city(i).name === '東京都')!;
  const move = (sx: number, sy: number) => gl.canvas.dispatchEvent(new PointerEvent('pointermove', { clientX: sx / dpr, clientY: sy / dpr, bubbles: true }));
  const [tx, ty] = [pos[2 * tokyo] / 65535, pos[2 * tokyo + 1] / 65535];
  set(tx, ty, 8);
  move(W / 2, H / 2);
  map.draw();
  const hl = new Uint8Array(4);
  gl.readPixels(W / 2, H / 2, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, hl);
  emit({ check: 'tokyo-highlighted', pass: hl[2] > 150 && hl[0] < 60, detail: [...hl].join(',') });
  emit({ check: 'tokyo-tooltip', pass: /東京都 \(日本\)\s+人口 35,676,000 人/.test(tip.textContent), detail: tip.textContent });
  set(0.5, 0.5, 1);
  move(...screen(...world(-140, -5)));
  emit({ check: 'pacific-no-tooltip', pass: tip.textContent === '', detail: tip.textContent });

  // 3. A country border is drawn. The US-Canada border runs straight along
  //    the 49th parallel at 110°W, far from any city. At 8x, look for a
  //    dark line pixel in a small window: land and sea are both above 200
  //    in every channel, the border is around 120.
  const [bwx, bwy] = world(-110, 49);
  set(bwx, bwy, 8);
  map.draw();
  const bw = 33, bh = 33, bpx = new Uint8Array(bw * bh * 4);
  gl.readPixels(Math.floor((W - bw) / 2), Math.floor((H - bh) / 2), bw, bh, gl.RGBA, gl.UNSIGNED_BYTE, bpx);
  let dark = 0;
  for (let i = 0; i < bpx.length; i += 4) if (bpx[i] < 190 && bpx[i + 1] < 190 && bpx[i + 2] < 190) dark++;
  emit({ check: 'us-canada-border-drawn', pass: dark > 0, detail: `${dark} dark pixels at 49N 110W` });

  // Leave Tokyo hovered over East Asia for the screenshot.
  set(tx, ty, 4);
  move(W / 2, H / 2);
  map.draw();
  emit({ info: { radius_px_tokyo: rad[tokyo] / 10 } });
  emit({ done: true });
}
