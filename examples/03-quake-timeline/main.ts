// The page: play/pause, the time slider and the caption. The bench branch
// lives in bench.ts and is loaded only with ?bench.
import { mount } from './quake.ts';
const base = '../../data/baked/03-quake-timeline';
// The ids below are all in index.html's markup.
const map = await mount(document.getElementById('map') as HTMLCanvasElement, base);
const T0 = Date.UTC(2025, 0, 1);
const $ = (id: string) => document.getElementById(id)!;
type Quake = [number, number, string];   // time ms, magnitude, place (quakes.json)
let list: Quake[] | null = null;
fetch(`${base}/quakes.json`).then((r) => r.json()).then((l: Quake[]) => { list = l; show(); });

// The largest event among those still on screen, for the caption.
function show() {
  const now = T0 + map.state.time * 60000;
  $('when').textContent = new Date(now).toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
  if (!list) return;
  let best: Quake | null = null;
  for (let i = 0; i < list.length && list[i][0] <= now; i++) {
    if (now - list[i][0] <= map.state.fade * 60000 && (!best || list[i][1] > best[1])) best = list[i];
  }
  $('big').textContent = best ? `M${best[1]} ${best[2]}` : '';
}
const setTime = (t: number) => { map.state.time = t; ($('slider') as HTMLInputElement).value = String(t); show(); map.render(); };
$('slider').addEventListener('input', (e) => setTime(Number((e.target as HTMLInputElement).value)));
let playing = false, last = 0;
const tick = (ts: number) => {
  if (!playing) return;
  if (last) setTime((map.state.time + (ts - last) * 1.44) % 525600);   // one day per second
  last = ts;
  requestAnimationFrame(tick);
};
$('play').addEventListener('click', () => {
  playing = !playing;
  $('play').textContent = playing ? '一時停止' : '再生';
  last = 0;
  if (playing) requestAnimationFrame(tick);
});
show();

const mounted = performance.now();
if (new URLSearchParams(location.search).has('bench')) await (await import('./bench.ts')).run(map, setTime, mounted);
