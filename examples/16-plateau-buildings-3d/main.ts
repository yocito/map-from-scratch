// Page glue for 16: open the archive, mount the renderer, mouse controls.
import { Archive, Loader, decodeGround, inflate } from './plb.ts';
import { VIEWS, LIMITS, FOVY } from './camera.ts';
import { createView, type View } from './render.ts';

const q = new URLSearchParams(location.search), bench = q.has('bench');
const canvas = document.getElementById('map') as HTMLCanvasElement;
export const ARCHIVE = '../../data/baked/16-plateau-buildings-3d/tokyo-station-2km.v1.plb';
const fit = () => { canvas.width = Math.round(canvas.clientWidth * devicePixelRatio); canvas.height = Math.round(canvas.clientHeight * devicePixelRatio); };
fit();

if (q.has('citygml')) {
  // Local comparison only: the same scene read from the original zips.
  (await import('./citygml.ts')).run(canvas);
} else {
  const ar = new Archive(ARCHIVE);
  const data = ar.open(q.has('whole')).then(async (h) => {
    performance.mark('open');
    const g0 = h.ground[0];
    return { h, ground: decodeGround(await inflate(ar.head!.subarray(g0 + 8, g0 + h.ground[1])), ar.head!.subarray(g0, g0 + 8)) };
  });
  const view = await createView(canvas, data, { sync: bench }), h = view.h;
  performance.mark('view');
  view.cull = q.get('cull') === '1';
  view.loader = new Loader(ar, h, (t, l, m) => view.add(t, l, m));
  Object.assign(view.cam, VIEWS.V1);
  // first / settled: time since navigation, and what had been read by then.
  const marks: Record<string, { t: number; bytes: number; requests: number }> = {};
  view.onMark = (name, t) => {
    marks[name] = { t, bytes: ar.bytes, requests: ar.requests };
    if (name === 'settled' && bench && !marks.bench) {
      marks.bench = marks.settled;
      import('./bench.ts').then((b) => b.run(view, ar, marks));
    }
  };
  controls(view);
  new ResizeObserver(() => { fit(); view.request(); }).observe(canvas);
  view.request();
}

// Left drag: orbit. Right drag or Shift+drag: move the target over the
// ground. Wheel: distance (line-mode wheels scaled to pixels).
function controls(view: View): void {
  const cam = view.cam, D = Math.PI / 180;
  let last: PointerEvent | null = null, pan = false;
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  canvas.addEventListener('pointerdown', (e) => {
    last = e; pan = e.button === 2 || e.shiftKey;
    if (e.isTrusted) canvas.setPointerCapture(e.pointerId);
  });
  canvas.addEventListener('pointerup', () => { last = null; });
  canvas.addEventListener('pointermove', (e) => {
    if (!last) return;
    const dx = e.clientX - last.clientX, dy = e.clientY - last.clientY;
    last = e;
    if (pan) {
      const m = (cam.dist * 2 * Math.tan(FOVY / 2)) / canvas.clientHeight, s = Math.sin(cam.yaw * D), c = Math.cos(cam.yaw * D);
      cam.x = Math.max(-LIMITS.half, Math.min(LIMITS.half, cam.x + (c * dx - s * dy) * m));
      cam.y = Math.max(-LIMITS.half, Math.min(LIMITS.half, cam.y + (-s * dx - c * dy) * m));
    } else {
      cam.yaw = (cam.yaw - dx * 0.3 + 360) % 360;
      cam.pitch = Math.max(LIMITS.pitch[0], Math.min(LIMITS.pitch[1], cam.pitch + dy * 0.2));
    }
    view.request();
  });
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    cam.dist = Math.max(LIMITS.dist[0], Math.min(LIMITS.dist[1], cam.dist * Math.exp(e.deltaY * (e.deltaMode === 1 ? 40 : 1) * 0.0015)));
    view.request();
  }, { passive: false });
}
