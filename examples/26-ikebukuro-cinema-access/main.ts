// Access map to Grand Cinema Sunshine: baked path strings drawn with
// Canvas 2D at one fixed scale, labels at baked positions, directions in the
// DOM. Hands over to bench.ts only under ?bench.
type XY = [number, number];
type Label = [text: string, x: number, y: number, size: number, angle: number, kind: number];
export interface Baked {
  w: number; h: number; m: number;
  areas: Record<string, string>; lines: Record<string, string>; route: string;
  start: XY; goal: XY; labels: Label[];
  walk: { m: number; min: number; steps: string[] };
  marks: [x: number, y: number, yaw: number][];
}
// The bird's-eye view: polygons as [palette index, path] in painter's order
// (ground, route, then buildings), labels [text, x, y, angle, kind].
export interface Bird { w: number; h: number; palette: string[]; polys: [number, string][]; labels: [string, number, number, number, number][]; route: string; start: XY; goal: XY }
export interface Views { w: number; h: number; horizon: number; palette: string[]; list: View[] }
// An eye-level view: walls as [palette index, path] in painter's order,
// the route ribbon on the ground, and visible building names.
export interface View { title: string; ground: string; walls: [number, string][]; labels: [string, number, number, number][] }

const FONT = 'system-ui, "Hiragino Sans", "Noto Sans CJK JP", sans-serif';
const AREA: [string, string][] = [['park', '#cfe5c1'], ['plaza', '#fbf9f4'], ['building', '#ddd7cd'], ['station', '#c4cfdd'], ['landmark', '#cbc1b1']];
// Road casing and fill widths in grid units (1 unit ~ 1 m on the ground).
const ROAD: [string, number, string, string][] = [
  ['minor', 7, '#cdc6bb', '#fff'], ['mid', 12, '#c3bbaf', '#fff'], ['major', 17, '#b9b0a3', '#fff'], ['expressway', 15, '#c99f4f', '#f3d898'],
];
// [fill, halo, weight] per label kind: street, landmark, destination, start.
const LABEL: [string, string, number][] = [['#6b6459', '#fff', 400], ['#3a3631', '#fff', 600], ['#c41d12', '#fff', 700], ['#1557c0', '#fff', 700]];

export function mount(el: HTMLElement, map: Baked): { canvas: HTMLCanvasElement; draw: () => void; scale: () => number } {
  const canvas = document.createElement('canvas');
  canvas.setAttribute('role', 'img');
  canvas.setAttribute('aria-label', `池袋駅東口からグランドシネマサンシャインまでの地図。徒歩約${map.walk.min}分`);
  el.append(canvas);
  const ctx = canvas.getContext('2d')!;
  const P = (d: string) => new Path2D(d);
  const areas = AREA.map(([k, c]) => [P(map.areas[k]), c] as const);
  const roads = ROAD.map(([k, w, c, f]) => [P(map.lines[k]), w, c, f] as const);
  const rail = P(map.lines.rail), dest = P(map.areas.dest), route = P(map.route);
  let k = 1;

  function draw() {
    ctx.setTransform(k, 0, 0, k, 0, 0);
    ctx.fillStyle = '#f2efe8';
    ctx.fillRect(0, 0, map.w, map.h);
    ctx.lineJoin = ctx.lineCap = 'round';
    for (const [p, c] of areas.slice(0, 2)) { ctx.fillStyle = c; ctx.fill(p); }
    for (const [p, w, c] of roads) { ctx.strokeStyle = c; ctx.lineWidth = w + 3; ctx.stroke(p); }
    for (const [p, w, , f] of roads) { ctx.strokeStyle = f; ctx.lineWidth = w; ctx.stroke(p); }
    // Solid, not the classic dashed rail: on a software-rastered canvas the
    // dash pass alone cost 17 ms of a 150 ms frame (4x throttle).
    ctx.strokeStyle = '#a7a39b'; ctx.lineWidth = 4; ctx.stroke(rail);
    for (const [p, c] of areas.slice(2)) { ctx.fillStyle = c; ctx.fill(p); }
    ctx.fillStyle = '#e8473d'; ctx.fill(dest);
    ctx.strokeStyle = '#a51c13'; ctx.lineWidth = 2.5; ctx.stroke(dest);
    ctx.strokeStyle = '#fff'; ctx.lineWidth = 15; ctx.stroke(route);
    ctx.strokeStyle = '#1a73e8'; ctx.lineWidth = 9; ctx.stroke(route);
    dot(map.start, '#1a73e8'); dot(map.goal, '#c41d12');
    // Where each eye-level view stands, and which way it looks.
    map.marks.forEach(([x, y, yaw], i) => {
      const dx = Math.cos(yaw), dy = -Math.sin(yaw);
      ctx.beginPath(); ctx.moveTo(x + dx * 40, y + dy * 40); ctx.lineTo(x - dy * 13, y + dx * 13); ctx.lineTo(x + dy * 13, y - dx * 13);
      ctx.fillStyle = '#1a73e8'; ctx.fill();
      ctx.beginPath(); ctx.arc(x, y, 17, 0, 7); ctx.fill(); ctx.strokeStyle = '#fff'; ctx.lineWidth = 4; ctx.stroke();
      ctx.fillStyle = '#fff'; ctx.font = `700 22px ${FONT}`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(String(i + 1), x, y + 1);
    });
    for (const [text, x, y, size, a, kind] of map.labels) {
      const [fill, halo, weight] = LABEL[kind];
      ctx.save();
      ctx.translate(x, y); ctx.rotate(a);
      ctx.font = `${weight} ${size}px ${FONT}`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.strokeStyle = halo; ctx.lineWidth = size / 4; ctx.strokeText(text, 0, 0);
      ctx.fillStyle = fill; ctx.fillText(text, 0, 0);
      ctx.restore();
    }
    // Scale bar (100 m) and north arrow.
    const bar = 100 / map.m;
    ctx.fillStyle = '#fffd'; ctx.fillRect(16, map.h - 62, bar + 24, 46);
    ctx.strokeStyle = '#333'; ctx.lineWidth = 3; ctx.lineCap = 'butt';
    ctx.beginPath(); ctx.moveTo(28, map.h - 34); ctx.lineTo(28, map.h - 26); ctx.lineTo(28 + bar, map.h - 26); ctx.lineTo(28 + bar, map.h - 34); ctx.stroke();
    ctx.fillStyle = '#333'; ctx.font = `600 22px ${FONT}`; ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
    ctx.fillText('100 m', 28 + bar / 2, map.h - 38);
    ctx.beginPath(); ctx.moveTo(map.w - 40, 20); ctx.lineTo(map.w - 54, 56); ctx.lineTo(map.w - 40, 48); ctx.lineTo(map.w - 26, 56); ctx.closePath(); ctx.fill();
    ctx.fillText('N', map.w - 40, 82);
  }
  function dot([x, y]: XY, c: string) {
    ctx.beginPath(); ctx.arc(x, y, 12, 0, 7);
    ctx.fillStyle = c; ctx.fill(); ctx.strokeStyle = '#fff'; ctx.lineWidth = 5; ctx.stroke();
  }
  function resize() {
    const css = el.clientWidth;
    k = (css * devicePixelRatio) / map.w;
    canvas.width = Math.round(map.w * k);
    canvas.height = Math.round(map.h * k);
    canvas.style.width = canvas.style.height = `${css}px`;
    draw();
  }
  canvas.addEventListener('contextrestored', draw);
  new ResizeObserver(resize).observe(el);
  resize();
  return { canvas, draw, scale: () => k };
}

// Eye-level view: sky, ground, route ribbon, then the walls in baked order.
export function mountView(el: HTMLElement, vs: Views, v: View): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.setAttribute('role', 'img');
  canvas.setAttribute('aria-label', `${v.title}から見た様子 (建物の形と高さによる模式図)`);
  el.prepend(canvas);
  const ctx = canvas.getContext('2d')!;
  const walls = v.walls.map(([c, d]) => [vs.palette[c], new Path2D(d)] as const);
  const ground = new Path2D(v.ground);
  function draw(k: number) {
    ctx.setTransform(k, 0, 0, k, 0, 0);
    const sky = ctx.createLinearGradient(0, 0, 0, vs.horizon);
    sky.addColorStop(0, '#a9cbe8'); sky.addColorStop(1, '#e6eff6');
    ctx.fillStyle = sky; ctx.fillRect(0, 0, vs.w, vs.horizon);
    ctx.fillStyle = '#c9c5bd'; ctx.fillRect(0, vs.horizon, vs.w, vs.h - vs.horizon);
    ctx.fillStyle = '#1a73e8'; ctx.fill(ground);
    ctx.lineJoin = 'round'; ctx.lineWidth = 1.2;
    for (const [c, p] of walls) { ctx.fillStyle = c; ctx.fill(p); ctx.strokeStyle = '#0003'; ctx.stroke(p); }
    for (const [text, x, y, dest] of v.labels) {
      ctx.font = `700 ${dest ? 40 : 34}px ${FONT}`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.strokeStyle = '#fff'; ctx.lineWidth = 9; ctx.strokeText(text, x, y);
      ctx.fillStyle = dest ? '#c41d12' : '#3a3631'; ctx.fillText(text, x, y);
    }
  }
  new ResizeObserver(() => {
    const css = el.clientWidth, k = (css * devicePixelRatio) / vs.w;
    canvas.width = Math.round(vs.w * k); canvas.height = Math.round(vs.h * k);
    canvas.style.width = `${css}px`;
    draw(k);
  }).observe(el);
  return canvas;
}

export function mountBird(el: HTMLElement, b: Bird): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.setAttribute('role', 'img');
  canvas.setAttribute('aria-label', '南西の上空から見た池袋駅東口とグランドスケープ池袋の鳥瞰図 (建物の形と高さによる模式図)');
  el.prepend(canvas);
  const ctx = canvas.getContext('2d')!;
  const polys = b.polys.map(([c, d]) => [b.palette[c], new Path2D(d)] as const);
  const route = new Path2D(b.route);
  new ResizeObserver(() => {
    const css = el.clientWidth, k = (css * devicePixelRatio) / b.w;
    canvas.width = Math.round(b.w * k); canvas.height = Math.round(b.h * k);
    canvas.style.width = `${css}px`;
    ctx.setTransform(k, 0, 0, k, 0, 0);
    const sky = ctx.createLinearGradient(0, 0, 0, b.h);
    sky.addColorStop(0, '#c4dcef'); sky.addColorStop(1, '#f4f8fb');
    ctx.fillStyle = sky; ctx.fillRect(0, 0, b.w, b.h);
    ctx.lineJoin = 'round'; ctx.lineWidth = 0.8; ctx.strokeStyle = '#0002';
    // Fill and outline each polygon; the outline also closes hairline seams.
    for (const [c, p] of polys) { ctx.fillStyle = c; ctx.fill(p); ctx.stroke(p); }
    // The whole route over the buildings, dashed: hidden stretches stay readable.
    ctx.setLineDash([14, 10]); ctx.lineCap = 'round';
    ctx.strokeStyle = '#fff'; ctx.lineWidth = 9; ctx.stroke(route);
    ctx.strokeStyle = '#1a73e8'; ctx.lineWidth = 5; ctx.stroke(route);
    ctx.setLineDash([]);
    for (const [[x, y], c] of [[b.start, '#1a73e8'], [b.goal, '#c41d12']] as const) {
      ctx.beginPath(); ctx.arc(x, y, 11, 0, 7); ctx.fillStyle = c; ctx.fill(); ctx.strokeStyle = '#fff'; ctx.lineWidth = 4; ctx.stroke();
    }
    for (const [text, x, y, a, kind] of b.labels) {
      const [fill, , weight] = LABEL[kind], size = [30, 32, kind === 2 && text.startsWith('（') ? 30 : 40, 34][kind];
      ctx.save(); ctx.translate(x, y); ctx.rotate(a);
      ctx.font = `${weight} ${size}px ${FONT}`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.strokeStyle = '#fff'; ctx.lineWidth = size / 4; ctx.strokeText(text, 0, 0);
      ctx.fillStyle = fill; ctx.fillText(text, 0, 0);
      ctx.restore();
    }
  }).observe(el);
  return canvas;
}

const map: Baked = await (await fetch('../../data/baked/26-ikebukuro-cinema-access/map.json')).json();
document.getElementById('walk')!.textContent = `池袋駅 東口から約${map.walk.m} m・徒歩約${map.walk.min}分`;
document.getElementById('steps')!.append(...map.walk.steps.map((s) => Object.assign(document.createElement('li'), { textContent: s })));
const view = mount(document.getElementById('map')!, map);
// The frame holding the map has been produced after the second rAF.
requestAnimationFrame(() => requestAnimationFrame(async () => {
  performance.mark('map-shown');
  // The bird's-eye and eye-level views sit below the map: fetch and draw
  // them only now.
  const [bird, vs]: [Bird, Views] = await Promise.all(['birdseye', 'views'].map(async (f) =>
    (await fetch(`../../data/baked/26-ikebukuro-cinema-access/${f}.json`)).json())) as [Bird, Views];
  mountBird(document.getElementById('bird')!, bird);
  const box = document.getElementById('views')!;
  vs.list.forEach((v, i) => {
    const fig = document.createElement('figure');
    fig.append(Object.assign(document.createElement('figcaption'), { textContent: `${i + 1}. ${v.title}` }));
    box.append(fig);
    mountView(fig, vs, v);
  });
  performance.mark('views-shown');
}));

if (new URLSearchParams(location.search).has('bench')) {
  const [bench] = await Promise.all([import('./bench.ts'), import('../../harness/page/bench.ts')]);
  await bench.run(view, map);
}
