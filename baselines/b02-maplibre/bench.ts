// Bench mode for this page, imported by main.ts only under ?bench.
import { emit, glRenderer, benchFrames, zoomPath } from '../../harness/page/bench.ts';
import type { CameraStep } from '../../harness/page/bench.ts';
import type { Country } from './main.ts';

// idle: performance.now() when MapLibre first went idle (everything drawn),
// taken in main.ts before this file was imported.
export async function run(map: maplibregl.Map, Z0: number, idle: number): Promise<void> {
  // MapLibre 5 draws with WebGL2, so the canvas already holds that context.
  const gl = map.getCanvas().getContext('webgl2')!;
  emit({ metric: 'first_frame_ms', value: idle });
  emit({ info: { gpu: glRenderer(gl), maplibre: maplibregl.getVersion() } });

  // The same camera path as 02: 32x into Japan and back (5 zoom levels).
  const path = zoomPath(300, { cx: 138, cy: 37, z0: 0, z1: 5, pan: 0.5 });
  const cam = (p: CameraStep): maplibregl.CameraOptions => ({ center: [p.cx, p.cy], zoom: Z0 + p.zoom });
  // Pass 1, as a user would see it: tiles for new zoom levels are still
  // being cut in workers while frames are drawn.
  await benchFrames(gl, path.length, (i) => { map.jumpTo(cam(path[i])); map.redraw(); }, { prefix: 'cold_' });
  // Pass 2: every tile on the path is cut by now; only drawing is left.
  await benchFrames(gl, path.length, (i) => { map.jumpTo(cam(path[i])); map.redraw(); });

  // How long until a jump to a new zoom level is fully drawn.
  const settle: number[] = [];
  for (const z of [0.5, 1.5, 2.5, 3.5, 4.5]) {
    map.jumpTo({ center: [0, 0], zoom: Z0 });
    await new Promise((r) => map.once('idle', r));
    const t0 = performance.now();
    map.jumpTo({ center: [138, 37], zoom: Z0 + z });
    await new Promise((r) => map.once('idle', r));
    settle.push(performance.now() - t0);
  }
  emit({ metric: 'settle_ms', values: settle });

  map.jumpTo({ center: [0, 0], zoom: Z0 });
  await new Promise((r) => map.once('idle', r));
  const tap: number[] = [];
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < 200; i++) {
    const t0 = performance.now();
    map.queryRenderedFeatures([rnd() * innerWidth, rnd() * innerHeight], { layers: ['fill'] });
    tap.push(performance.now() - t0);
  }
  emit({ metric: 'pick_ms', values: tap });
  const jp = map.queryRenderedFeatures<Country>(map.project([139.7, 35.7]), { layers: ['fill'] })[0];
  emit({ check: 'pick-tokyo', pass: jp?.properties.code === 'JPN', detail: String(jp?.properties.code) });
  map.jumpTo({ center: [138, 37], zoom: Z0 + Math.log2(6) });
  await new Promise((r) => map.once('idle', r));
  emit({ done: true });
}
