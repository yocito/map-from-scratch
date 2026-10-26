// Bench branch for 03, loaded only with ?bench so it is not part of the page
// a visitor downloads.
import { emit, glRenderer, benchFrames, zoomPath } from '../../harness/page/bench.ts';
import { equalEarth } from '../../tools/geo.ts';
import type { QuakeMap } from './quake.ts';

const T0 = Date.UTC(2025, 0, 1);

// setTime: main.ts's slider setter, so the screenshot shows the caption too.
// mounted: performance.now() right after mount() resolved, taken in main.ts
// before this file was imported, so loading the bench code is not counted.
export async function run(map: QuakeMap, setTime: (t: number) => void, mounted: number): Promise<void> {
  const { gl, state } = map;
  gl.canvas.addEventListener('webglcontextlost', () => emit({ error: 'webgl context lost' }));
  const t0 = performance.now();
  map.draw();
  gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4));
  emit({ metric: 'first_frame_ms', value: mounted + performance.now() - t0 });
  emit({ info: { gpu: glRenderer(gl), events: map.events } });

  // Play the whole year in 600 frames while zooming into Japan and out.
  const world = (lon: number, lat: number): [number, number] => {
    const [x, y] = equalEarth([lon, lat]);
    return [(x + 2.7066) / (2 * 2.7066), (1.3174 - y) / (2 * 1.3174)];
  };
  const [jx, jy] = world(140, 36);
  const path = zoomPath(600, { cx: jx, cy: jy, z0: 1, z1: 8, pan: 0.01 });
  await benchFrames(gl, path.length, (i) => {
    state.x = path[i].cx; state.y = path[i].cy; state.zoom = path[i].zoom;
    state.time = (i / path.length) * 525600;
    map.draw();
  });

  // Functional check on the Myanmar M7.7 (2025-03-28 06:20 UTC): nothing at
  // its epicentre a day before, a red (shallow) mark half an hour after.
  state.x = 0.5; state.y = 0.5; state.zoom = 1;
  const [mx, my] = world(95.9363, 22.011);
  const sx = Math.round((mx - state.x) * state.zoom * gl.canvas.width + gl.canvas.width / 2);
  const sy = Math.round(gl.canvas.height / 2 - (my - state.y) * state.zoom * gl.canvas.width * (1.3174 / 2.7066));
  const at = (minutes: number) => {
    state.time = minutes;
    map.draw();
    const px = new Uint8Array(4);
    gl.readPixels(sx, gl.canvas.height - 1 - Math.round((my - state.y) * state.zoom * gl.canvas.width * (1.3174 / 2.7066) + gl.canvas.height / 2), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
    return [...px];
  };
  const tq = (Date.UTC(2025, 2, 28, 6, 20, 52) - T0) / 60000;
  const before = at(tq - 1440), after = at(tq + 30);
  emit({ info: { myanmar_before: before.join(','), myanmar_after: after.join(',') } });
  emit({ check: 'myanmar-before', pass: before[0] < 230 && Math.abs(before[0] - before[1]) < 20, detail: before.join(',') });
  emit({ check: 'myanmar-after', pass: after[0] > 150 && after[1] < 120, detail: after.join(',') });

  // Leave the Kamchatka M8.8 a few hours old on screen for the screenshot.
  setTime((Date.UTC(2025, 6, 30, 3) - T0) / 60000);
  map.draw();
  emit({ done: true });
}
