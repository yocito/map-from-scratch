// Page glue for 07: the tooltip that follows the pointer, and mount().
import { mount } from './cities.ts';
const tip = document.getElementById('tip')!; // in index.html, parsed before this module runs
let mx = 0, my = 0;
addEventListener('pointermove', (e) => {
  mx = e.clientX; my = e.clientY;
  tip.style.transform = `translate(${mx + 14}px,${my + 14}px)`;
});
// Digits grouped by a regex: the first toLocaleString('ja-JP') loads ICU data
// and made the first hover 30-39 ms instead of 3 ms.
const map = await mount(document.getElementById('map') as HTMLCanvasElement, '../../data/baked/07-world-cities-hover', (c) => {
  tip.textContent = c ? `${c.name} (${c.country})  人口 ${c.population ? String(c.population).replace(/\B(?=(\d{3})+$)/g, ',') + ' 人' : '不明'}` : '';
});
const mounted = performance.now();
if (location.search.includes('bench')) (await import('./bench.ts')).run(map, tip, mounted);
