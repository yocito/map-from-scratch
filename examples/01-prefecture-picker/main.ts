// Application glue for the picker page: show the chosen prefecture as the
// article filter, and hand over to bench.ts only under ?bench.
import { mount, type PrefectureDetail } from './picker.ts';
const el = document.getElementById('map')!;  // in index.html
el.addEventListener('prefecture', (e) => {
  const { name, code } = (e as CustomEvent<PrefectureDetail>).detail;
  document.getElementById('out')!.textContent = `${name} (${code}) の記事を表示`;
});
const map = await mount(el, '../../data/baked/01-prefecture-picker/prefectures.json');

// Under ?bench, fetch bench.ts and the harness module it imports in
// parallel, so only one fetch stands between mount() and first_frame_ms.
if (new URLSearchParams(location.search).has('bench')) {
  const [bench] = await Promise.all([import('./bench.ts'), import('../../harness/page/bench.ts')]);
  await bench.run(el, map);
}
