// Bench branch for 26, loaded only with ?bench so it is not part of the page
// a visitor downloads. Every check reads the canvas pixels that were drawn.
import { emit } from '../../harness/page/bench.ts';
import type { Baked, Views } from './main.ts';

const raf = () => new Promise(requestAnimationFrame);
const FONT = 'system-ui, "Hiragino Sans", "Noto Sans CJK JP", sans-serif';
const WEIGHT = [400, 600, 700, 700];

export async function run(view: { canvas: HTMLCanvasElement; draw: () => void; scale: () => number }, map: Baked): Promise<void> {
  const { canvas } = view;
  canvas.addEventListener('contextlost', () => emit({ error: 'canvas context lost' }));
  // First frame = the second rAF after mount(), marked by main.ts itself so
  // that fetching this bench module is not counted. Time origin is
  // navigation start: it includes fetching the page, main.ts and map.json.
  while (!performance.getEntriesByName('map-shown').length) await raf();
  emit({ metric: 'first_frame_ms', value: performance.getEntriesByName('map-shown')[0].startTime });

  // Resize cost: turning the phone or resizing the window redraws the whole
  // map once. Canvas 2D records the calls and rasterises at composite time,
  // so time from the size change to the end of the frame that shows it:
  // ResizeObserver runs after rAF callbacks and before paint, so the second
  // rAF after the change follows the repainted frame.
  // Start only after the bird's-eye and eye-level views are drawn: they load
  // after the first frame and would otherwise land inside these frames.
  while (!performance.getEntriesByName('views-shown').length) await raf();
  emit({ metric: 'views_shown_ms', value: performance.getEntriesByName('views-shown')[0].startTime });
  await raf(); await raf();
  const el = canvas.parentElement!;
  const resize: number[] = [];
  const redraw: number[] = [];
  for (let i = 0; i < 20; i++) {
    const t0 = performance.now();
    el.style.width = i % 2 ? '' : '300px';
    await raf(); await raf();
    resize.push(performance.now() - t0);
  }
  el.style.width = '';
  await raf(); await raf();
  for (let i = 0; i < 60; i++) { const t = performance.now(); view.draw(); redraw.push(performance.now() - t); await raf(); }
  emit({ metric: 'resize_frame_ms', values: resize });
  emit({ metric: 'redraw_ms', values: redraw });
  emit({ metric: 'idle_frame_interval_ms', values: await (async () => {
    const out: number[] = [];
    let last = performance.now();
    for (let i = 0; i < 60; i++) { await raf(); const t = performance.now(); out.push(t - last); last = t; }
    return out;
  })() });

  const ctx = canvas.getContext('2d')!;
  const k = view.scale();
  const W = canvas.width, H = canvas.height;
  const px = ctx.getImageData(0, 0, W, H).data;
  const at = (x: number, y: number): [number, number, number] => {
    const i = (Math.round(y * k) * W + Math.round(x * k)) * 4;
    return [px[i], px[i + 1], px[i + 2]];
  };
  const isRed = ([r, g, b]: number[]) => r > 190 && g < 110 && b < 100;
  const isBlue = ([r, g, b]: number[]) => r < 90 && g > 90 && g < 160 && b > 200;

  // dest-highlighted: pixels inside the destination outline are red.
  const dest = new Path2D(map.areas.dest);
  let inside = 0, red = 0;
  ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0);
  for (let y = 0; y < map.h; y += 2) for (let x = 0; x < map.w; x += 2) {
    if (!ctx.isPointInPath(dest, x, y)) continue;   // dest is in grid units, identity transform
    inside++;
    if (isRed(at(x, y))) red++;
  }
  ctx.restore();
  emit({ check: 'dest-highlighted', pass: inside > 20 && red / inside > 0.6, detail: { samples: inside, red: +(red / inside).toFixed(3) } });

  // route-drawn: walk the baked route; within 2 units of each sample there
  // must be route blue on the screen.
  const pts: [number, number][] = [];
  let cx = 0, cy = 0;
  for (const m of map.route.matchAll(/([Ml])|(-?\d+) (-?\d+)/g)) {
    if (m[1]) continue;
    const x = Number(m[2]), y = Number(m[3]);
    if (!pts.length) { cx = x; cy = y; } else { cx += x; cy += y; }
    pts.push([cx, cy]);
  }
  let samples = 0, blue = 0;
  for (let i = 1; i < pts.length; i++) {
    const [a, b] = [pts[i - 1], pts[i]];
    const n = Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / 5);
    for (let j = 0; j < n; j++) {
      const x = a[0] + ((b[0] - a[0]) * j) / n, y = a[1] + ((b[1] - a[1]) * j) / n;
      samples++;
      let ok = false;
      for (let dy = -2; dy <= 2 && !ok; dy++) for (let dx = -2; dx <= 2 && !ok; dx++) ok = isBlue(at(x + dx, y + dy));
      if (ok) blue++;
    }
  }
  emit({ check: 'route-drawn', pass: samples > 50 && blue / samples > 0.9, detail: { samples, blue: +(blue / samples).toFixed(3) } });

  // markers: the start dot is blue, the goal dot red.
  emit({ check: 'start-goal-markers', pass: isBlue(at(...map.start)) && isRed(at(...map.goal)), detail: { start: at(...map.start), goal: at(...map.goal) } });

  // Labels: real text boxes from measureText (sizes are grid units, as drawn).
  const boxes = map.labels.map(([text, x, y, size, a, kind]) => {
    ctx.font = `${WEIGHT[kind]} ${size}px ${FONT}`;
    const w = ctx.measureText(text).width / 2, h = size / 2;
    const c = Math.abs(Math.cos(a)), s = Math.abs(Math.sin(a));
    return [x - (w * c + h * s), y - (w * s + h * c), x + (w * c + h * s), y + (w * s + h * c)];
  });
  let overlaps = 0;
  for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
    const [a, b] = [boxes[i], boxes[j]];
    if (a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1]) overlaps++;
  }
  emit({ metric: 'label_overlaps', value: overlaps });
  emit({ metric: 'min_label_px', value: Math.min(...map.labels.map((l) => l[3])) * k / devicePixelRatio });

  // dest-label-drawn: the destination name's box holds its red glyphs (a
  // missing CJK font would leave it empty or tofu-small).
  const di = map.labels.findIndex((l) => l[5] === 2);
  const [x0, y0, x1, y1] = boxes[di];
  let glyph = 0, all = 0;
  for (let y = y0; y < y1; y += 1) for (let x = x0; x < x1; x += 1) { all++; if (isRed(at(x, y))) glyph++; }
  emit({ check: 'dest-label-drawn', pass: glyph / all > 0.08, detail: { text: map.labels[di][0], ink: +(glyph / all).toFixed(3) } });

  // directions: the written steps and the walking time reached the page.
  const steps = document.querySelectorAll('#steps li').length;
  const walk = document.getElementById('walk')!.textContent ?? '';
  emit({ check: 'directions-shown', pass: steps === map.walk.steps.length && steps >= 2 && walk.includes(`徒歩約${map.walk.min}分`), detail: { steps, walk } });

  // views-drawn: every eye-level view has sky, buildings and the route on
  // the screen, and the destination is red where it is labelled.
  const vs: Views = await (await fetch('../../data/baked/26-ikebukuro-cinema-access/views.json')).json();
  const figs = [...document.querySelectorAll<HTMLCanvasElement>('#views canvas')];
  const per = figs.map((c, i) => {
    const vctx = c.getContext('2d')!, d = vctx.getImageData(0, 0, c.width, c.height).data;
    let routeBlue = 0, destRed = 0, n = 0;
    for (let j = 0; j < d.length; j += 4 * 7) { n++; const p = [d[j], d[j + 1], d[j + 2]]; if (isBlue(p)) routeBlue++; else if (p[0] > 180 && p[1] < 90 && p[2] < 80) destRed++; }
    const dest = vs.list[i].labels.some((l) => l[3] === 1);
    return { route: +(routeBlue / n).toFixed(3), dest: +(destRed / n).toFixed(3), labelled: dest };
  });
  emit({ check: 'views-drawn', pass: figs.length === vs.list.length && per.every((v) => v.route > 0.02 && (!v.labelled || v.dest > 0.003)), detail: per });

  // bird-drawn: the bird's-eye canvas shows the destination red and the
  // dashed route blue.
  const bc = document.querySelector<HTMLCanvasElement>('#bird canvas');
  let bird = { route: 0, dest: 0 };
  if (bc) {
    const d = bc.getContext('2d')!.getImageData(0, 0, bc.width, bc.height).data;
    let n = 0, rb = 0, dr = 0;
    for (let j = 0; j < d.length; j += 4 * 5) { n++; const p = [d[j], d[j + 1], d[j + 2]]; if (isBlue(p)) rb++; else if (p[0] > 180 && p[1] < 90 && p[2] < 80) dr++; }
    bird = { route: +(rb / n).toFixed(4), dest: +(dr / n).toFixed(4) };
  }
  emit({ check: 'bird-drawn', pass: !!bc && bird.route > 0.002 && bird.dest > 0.003, detail: bird });

  emit({ info: { labels: map.labels.length, walk_m: map.walk.m, canvas: [W, H], timer_resolution_isolated: crossOriginIsolated } });
  emit({ done: true });
}
