// Bench branch for 01, loaded only with ?bench so it is not part of the page
// a visitor downloads.
import { emit } from '../../harness/page/bench.ts';
import type { Picker, PrefectureDetail } from './picker.ts';

export async function run(el: HTMLElement, map: Picker): Promise<void> {
  const canvas = el.querySelector('canvas')!;  // mount() appended it
  canvas.addEventListener('contextlost', () => emit({ error: 'canvas context lost' }));
  // First frame = the second rAF after mounting: the frame holding the map
  // has been produced.
  await new Promise(requestAnimationFrame);
  await new Promise(requestAnimationFrame);
  emit({ metric: 'first_frame_ms', value: performance.now() });

  // Canvas 2D only records draw calls; the GPU rasterises at composite time.
  // So measure (a) the cost of recording a redraw and (b) the frame interval
  // while redrawing every frame, against the interval of an idle page.
  const raf = () => new Promise(requestAnimationFrame);
  const gaps = async (n: number, work: (i: number) => void): Promise<number[]> => {
    const out: number[] = [];
    let last = performance.now();
    for (let i = 0; i < n; i++) {
      work(i);
      await raf();
      const t = performance.now();
      out.push(t - last);
      last = t;
    }
    return out;
  };
  await raf();
  emit({ metric: 'idle_frame_interval_ms', values: await gaps(120, () => {}) });
  const redraw: number[] = [];
  emit({ metric: 'frame_interval_ms', values: await gaps(240, (i) => {
    const t0 = performance.now();
    map.setHover(i % map.prefs.length);
    redraw.push(performance.now() - t0);
  }) });
  emit({ metric: 'redraw_ms', values: redraw });

  // Hit tests at fixed pseudo-random points over the map.
  const r = el.getBoundingClientRect();
  let seed = 1;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const pick: number[] = [];
  let hits = 0;
  for (let i = 0; i < 2000; i++) {
    const x = rnd() * r.width, y = rnd() * r.height;
    const t0 = performance.now();
    if (map.pick(x, y) >= 0) hits++;
    pick.push(performance.now() - t0);
  }
  emit({ metric: 'pick_ms', values: pick });
  emit({ info: { hit_ratio: hits / 2000, prefectures: map.prefs.length, timer_resolution_isolated: crossOriginIsolated } });
  map.setHover(-1);

  // Functional check: a click inside Tokyo must announce JP-13.
  const tokyo = map.prefs.findIndex((p) => p.code === 'JP-13');
  let at: [number, number] | null = null;
  for (let y = 0; y < r.height && !at; y += 2) for (let x = 0; x < r.width && !at; x += 2) if (map.pick(x, y) === tokyo) at = [x, y];
  if (!at) throw new Error('no point inside Tokyo found');
  const got = new Promise<string>((res) => el.addEventListener('prefecture', (e) => res((e as CustomEvent<PrefectureDetail>).detail.code), { once: true }));
  canvas.dispatchEvent(new MouseEvent('click', { clientX: r.left + at[0], clientY: r.top + at[1], bubbles: true }));
  const code = await got;
  emit({ check: 'click-tokyo', pass: code === 'JP-13', detail: code });
  emit({ done: true });
}
