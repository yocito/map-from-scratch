---
name: tile-cache-and-loading
description: How map engines schedule, cancel, prioritise, cache and evict tiles or byte ranges, and what they reverted, distilled for a map-from-scratch renderer. Load it when a request's data does not fit in one baked file fetched once (streamed tiles, HTTP Range reads into PMTiles, GeoParquet or FlatGeobuf, live or refetched data), when writing a fetch queue, a tile or index cache, a memory budget or a persistent (Cache API, IndexedDB) cache, or when a bench shows request floods, blank tiles while panning, memory growth or refetch churn.
---

# Tile cache and loading: what to fetch, in what order, and what to keep

A streaming renderer repeatedly decides which tiles or byte ranges to
request, how many at once, in what order, which in-flight requests to drop
when the view moves, what to draw while they load, how many bytes of
decoded tiles to keep, and under which key a cached copy is still valid.
Each of these decisions has caused request floods, leaked memory, blank or
stale tiles, or a cache that thrashed in at least one of the 47 engines in
`ref-repos/`. Most map-from-scratch requests avoid all of this: every
example so far bakes its data and loads it whole [2]. Load this skill when
that stops being true. Per-engine detail, with more numbers, is in
[references/engines.md](references/engines.md). Neighbouring skills: the
archive layout and Range mechanics are in `data-range-requests`, parent and
child placeholders and overzoom in `tile-lod-and-overzoom`.

## First: do you need any of it?

- **One baked file that fits the memory budget, fetched once.** You need no
  tile cache, scheduler or persistent store. Give the file a stable or
  versioned URL and let the browser's HTTP cache work. maplibre-rs leaves
  all caching to the HTTP layer so that expiry headers are honoured and
  there is no cache format to maintain [4]. MapLibre GL JS built its own
  Cache API layer only because a per-load query parameter defeated HTTP
  caching, and then fixed a Chrome slowdown, a Safari leak and a Firefox
  SecurityError [5].
- **Data larger than the budget, read by Range from a static archive.** Use
  the index, request and memory sections below.
- **Live data, refetched or edited.** Read the section on invalidation and
  live updates.

The harness's static server sends `cache-control: no-store`, so every bench
iteration pays a first visit; it answers a single `bytes=a-b` range with
206 and sends the whole file for a multi-range header; and it sets COEP
`require-corp`, so remote data must come with CORS [1]. Measure a repeat
visit or a persistent cache explicitly, and merge neighbouring ranges into
one span rather than sending multi-range headers.

## Requests: cap, re-check, abort, order

- **Cap in-flight requests per server, sized by transport.** deck.gl moved
  its default from 8 to 6 to match the per-domain HTTP/1.1 limit and kept a
  single knob; on HTTP/2 its OSM example was "much much faster" with no
  request limit, and the merged example sets `maxRequests: 20` [6]. Cesium kept throttling on HTTP/2 but raised the limit from 6 to 18
  (3 subdomains x 6), because unlimited requests were wasted during camera
  flights [7]. RustGIS caps 8 per server in the browser (4 for OSM) and 16
  natively; on a high-latency source a 1920x1080 render went from about
  2.25 s to 1.3 s with more concurrency [8].
- **Decide at dispatch, not at enqueue.** deck.gl's scheduler asks a tile
  whether it is still selected when a slot opens, so tiles panned past are
  never fetched; a priority callback that returned a boolean failed to
  cancel anything until it returned 1/-1 [9]. RustGIS takes the newest
  waiting tile first and drops a waiting tile not asked for in 1.5 s [8].
- **Abort what is in flight, and make the abort release memory.** deck.gl
  passes an AbortSignal to the loader and aborts unselected tiles' requests
  [6]. MapLibre GL JS had to make aborted promises reject, stop
  dispatching tiles dropped during an async step, and remove unloaded tiles
  from every worker, because aborts "happen constantly during map
  movement" and leaked tiles [10]. Cesium leaked payloads through retained
  cancel functions and deferreds [11].
- **A cancelled tile is unloaded, not empty.** deck.gl cached cancelled
  tiles with `data: null`, and they stayed blank after zooming back out
  [12].
- **Centre first, by simple distance.** deck.gl orders queued tiles
  selected first, then by squared screen distance to the view centre [13].
  Cesium's foveated, motion-aware ordering cut camera-tour load time by
  about 67% and load count by about 44% [14]. navara orders index fetches
  by SSE, then distance, so the view centre resolves first under HTTP/1.1
  connection limits [15]. See the reversals below before inventing more.
- **Measure before tuning the queue.** RustGIS's scheduler cut requests by
  about 10% (168 to 152) on a fast machine with no change in frame times:
  the stalls came from drawing [8]. Cesium's global scheduler was a "big
  win" on slow links but slightly slower on HTTP/2 at normal speeds [16].
- **Throttle work, not only requests, while the camera moves.** MapLibre GL
  JS limits raster image requests per frame while moving; the first version
  regressed because the throttled queue did not advance by itself [17].
  deck.gl's `debounceTime` saves requests for tiles passed over, but it is
  opt-in (default 0) and delays the first tile of a settled view [18].
- **Clamp the tile cover.** QGIS found that a view whose extent failed to
  reproject (geographic CRS touching +/-180 or +/-90) handed the vector
  tile renderer a maximal extent and fetched every tile of the zoom level;
  it now derives a minimal extent or fails [55]. Cap the count a cover
  computation may return.

## Memory: a byte budget, not a tile count

- **Count bytes.** In ortho-earth a dense z16 city tile is about 100 KB
  and an offshore z8 tile tens of bytes, so the old 256-tile cap meant
  nothing; the budget now follows `navigator.deviceMemory` (16 GB about
  96 MB, 4 GB about 48 MB, 2 GB about 24 MB), and tiles in view are always
  kept [19]. deck.gl reads a `byteLength` that the tile data reports [20].
  RustGIS bounds streamed windows at 128 MiB on the desktop and 48 MiB in
  the browser, because vertices per feature vary by orders of magnitude
  [21].
- **Plan for the view alone exceeding the budget.** navara evicts the
  oldest and farthest pooled tiles down to 85% of the budget; if visible
  tiles alone exceed it, a load gate stops new fetches and the SSE
  threshold rises by 1.25 every 15 stalled frames; budgets are a quarter of
  device memory capped at 2 GB on desktop, 512 or 256 MB on mobile [22].
  Cesium split its limit into `cacheBytes` and `maximumCacheOverflowBytes`
  and raises the SSE when memory is exceeded [23]. A coarser view instead
  of a dead tab: navara notes that tabs are killed when memory runs out
  (especially on iOS), and that a tilted view over Tokyo could allocate
  until the tab died [22].
- **Reserve at dispatch.** navara reserves an estimated cost when a fetch
  is sent (EMA mean plus 0.5 SD, clamped to 64 KB-16 MB), because a fixed
  hint undercounted terrain about 10x and bursts slipped past the gate
  [22].
- **A budget smaller than the working set thrashes.** QGIS raised its 3D
  chunk budget from 100 to 500 MB because tiles were constantly unloaded
  and reloaded [24]. MapLibre Native sizes its in-memory cache from tiles
  per screen and removed the user setter [25].
- **Small traps.** Prune tiles that are neither visible nor selected, not
  merely invisible, or loading tiles are evicted and refetched; a size of 0
  must mean 0, not "use the default" (`??`, not `||`) [20].

## Invalidation, keys and live data

- **Key Range reads by URL and range.** All PMTiles requests share one
  URL, so MapLibre Native appends `_mlnRange=start-end` to the cache key
  and navara dedups on URL plus range [27]. Keep ranges deterministic
  (whole index blocks, whole row groups) so keys repeat [27].
- **Detect a replaced archive.** Replacing a PMTiles archive in place while
  MapLibre Native ran crashed it until ETag was tracked [28]. ortho-earth
  keys IndexedDB row groups by `URL|ETag|row group|mode|column`; a second
  session needed 2 Range requests (64 KB) instead of 32 (7.1 MB) [29].
  Immutable, versioned file names avoid the problem.
- **Put everything that moves pixels in every cache layer's key.**
  reearth-papers keys rendered tiles by style, renderer version, data date
  and flavour; a key without the data date invalidated nothing on a new
  monthly snapshot, and a renderer bump that rotated R2 but not the edge
  cache kept serving old tiles [30]. ortho-earth had to key baked geometry
  by projection mode after an offline pack built in one mode showed
  nothing in the other [31].
- **A failed fetch is not "absent" and must not replace a good copy.**
  MapLibre Native caches only 200 and 404, because other errors "will
  likely evict perfectly good content" [32]; an offline error overwrote
  cached glyphs [33]; reearth-papers settles a glyph as absent only from a
  block that arrived and parsed [34].
- **Unchanged refetch, no repaint.** MapLibre GL JS compares the ETag
  before parsing and skips the parse and the data event when it is the
  same [26].
- **Live edits: diff by id, latest wins.** GeoJSON `updateData` keyed by
  feature id took an update from 11.5 ms to 1.8 ms and reloads only
  affected tiles, falling back to a full reload above 1,000 changes [35].
  When updates arrive faster than the worker, keep only the latest: GL JS
  and Native workers coalesce to the newest state, and dropped requests
  must still resolve their callbacks [36].
- **Keep old content until the new load lands.** deck.gl keeps stale tile
  content during a reload and discards results of superseded loads by a
  loader id [37]; reearth-visualizer compares features and keeps old ones
  to stop blinking [38].

## Range-read archives: the index is a cache too

- One bootstrap read large enough for the header and root index: navara
  reads 16 KiB first [15]. Load deeper index levels lazily: Cesium's
  progressive availability sped up load and cut memory [39].
- Bound the parsed-index cache: navara 32 MB of leaf directories, because
  all leaves of a global archive cost 50-500 MB [15]; MapLibre Native 100
  directories per archive [40]. Tiles waiting on the same leaf share one
  fetch (RustGIS) [41].
- GeoParquet: read the footer with two CORS-safelisted Range requests
  (`bytes=0-0` for the total length, then an explicit range for the last
  64 KB), not a suffix range: `bytes=-N` is outside the safelist, so it
  triggers a preflight and fails on hosts that do not answer OPTIONS. Then
  prune row groups by bbox statistics and coalesce column-chunk ranges. A
  Tokyo view of an 8,000-feature file touched 32 of 63
  row groups and 110 KB of 505 KB [42]. ortho-earth streams only above
  8 MB; below it, one GET is simpler [42].
- Cache the archive's metadata (PMTiles header, Parquet footer) in memory
  by URL, so reopening a layer costs no request; Cesium does this for
  imagery metadata and endpoint lookups within a session [56].
- Avoid per-request custom headers on cross-origin tiles: each costs a
  preflight, and Cesium's Accept-header trick to avoid one was closed by a
  spec change and reverted [43].

## Upload and per-frame work

- Upload each tile or chunk once and draw it in place. ortho-earth's WebGPU
  backend re-merged all visible tiles (33 ms for 35 tiles, 9-11 hitches
  over 4 ms per 9 s pan); a per-tile pool made it 0 hitches [44]. deck.gl:
  appending 100K rows to 1M rebuilds 1.1M rows; one buffer per chunk does
  not [45].
- Time-slice with `performance.now()`: Cesium's 5 ms load budget overran
  to over 10 ms with `Date.now()` [46]. A time-sliced queue needs a bound or
  memoisation, or it grows on slow devices [47].
- Decode and lay out in workers when data arrives at run time; MapLibre GL
  JS then had to shrink worker-to-main transfers [48]. Cesium made
  `createImageBitmap` the default and reverted it in the next patch
  release (flipY, browser bugs) [49].
- If the bake writes many tiles, measure encoding apart from rendering:
  in QGIS's XYZ export PNG encoding cost about twice a simple render, and
  moving encoding to a thread pool with one batched MBTiles writer (WAL,
  `synchronous=OFF`, acceptable for a rebuildable output) took 75,560
  tiles from 268 s to 21 s [54].

## Tried and reverted

- Cesium's global distance-sorted scheduler (#3476) was taken off terrain
  and imagery: a closure per tile, a sort per frame, and important tiles
  loaded late; with the reversal, cancelled requests fell from 755 to 0 in
  one view (a Grand Canyon horizon), and loading was 1.4x to 2.3x faster
  with about 33% less data overall [16].
- navara committed and reverted a custom fetch priority, keeping
  OrderByDistance [50].
- deck.gl added and removed a `throttleRequests` flag and rejected a second
  max-requests prop [9][6].
- MapLibre GL JS reverted, then re-landed, setData coalescing (abandoned
  callbacks) [36]; moving `updateData` bounds to the worker gave no gain and
  was reverted [35].
- maplibre-rs disabled an IndexedDB tile store and a Workbox cache [4].
- QGIS removed a geometry cache that was rebuilt on every redraw [51].
- navara removed a `scene_ready` flag mirrored across JS and WASM; it went
  out of sync on eviction [52].

## Guidance for a renderer here

1. Prefer the baked single file. Reach for tiles or Range streaming only
   when the measured data exceeds the budget in `spec.yaml` or the first
   frame budget cannot be met by one fetch, and say so in
   `architecture_selection`.
2. If streaming: lay the archive out so that one bootstrap read gets the
   header and root index, blocks are spatially ordered, and ranges are
   deterministic; cache the index with a byte or count bound; key every
   cache by (URL, offset, length) plus a version (ETag or versioned name).
3. Fetch queue: per-origin cap (6 on HTTP/1.1, higher on HTTP/2, measured),
   visibility re-checked at dispatch, AbortSignal on fetch, centre-first by
   distance, cancelled means unloaded. Do not build a cross-source priority
   scheduler.
4. Memory: a byte budget from the target device, eviction with hysteresis,
   visible tiles pinned, and a declared degradation (coarser LOD or stop
   refining) when the view alone exceeds it.
5. Draw from parents while children load only if zooming over streamed data
   is in the request (the `tile-lod-and-overzoom` skill).
6. Bench under `benchmarks.network` [3] with budgets on requests, bytes and
   peak memory, and add verification checks that fail when a pan back
   refetches cached tiles, an aborted load keeps memory, a cancelled tile
   stays blank, or a tile is re-baked every frame (Cesium's `makeClean` bug
   re-baked every frame) [53].

## Sources

1. `harness/lib/serve.ts` (this repository)
2. `README.md` and `skills/map-from-scratch/SKILL.md` (this repository)
3. `skills/map-from-scratch/references/spec-yaml.md` (this repository)
4. maplibre-rs caching: `ref-repos/maplibre__maplibre-rs/docs/src/development-documents/caching.md`, https://github.com/maplibre/maplibre-rs/blob/main/docs/src/development-documents/caching.md, https://github.com/maplibre/maplibre-rs/commit/7e11f85, https://github.com/maplibre/maplibre-rs/commit/fad6b35, https://github.com/maplibre/maplibre-rs/commit/1f6e31a, https://github.com/maplibre/maplibre-rs/commit/52cc15b, https://github.com/maplibre/maplibre-rs/commit/151ee9f
5. MapLibre GL JS Cache API tile cache: https://github.com/maplibre/maplibre-gl-js/commit/500320f89, https://github.com/maplibre/maplibre-gl-js/commit/20c90905a, https://github.com/maplibre/maplibre-gl-js/commit/6b424fee4, https://github.com/maplibre/maplibre-gl-js/commit/70087e3f8, https://github.com/maplibre/maplibre-gl-js/commit/83ab6b72d
6. deck.gl abort and concurrency: https://github.com/visgl/deck.gl/pull/4838, https://github.com/visgl/deck.gl/commit/8046edd2, https://github.com/visgl/deck.gl/commit/0adfe055, https://github.com/visgl/deck.gl/commit/19af42d9
7. Cesium per-server limit: https://github.com/CesiumGS/cesium/commit/26fc56183, https://github.com/CesiumGS/cesium/pull/6445, https://github.com/CesiumGS/cesium/issues/11627, https://github.com/CesiumGS/cesium/issues/6426, `ref-repos/CesiumGS__cesium/CHANGES.md`
8. RustGIS fetch scheduler: https://github.com/opengeos/RustGIS/pull/636, https://github.com/opengeos/RustGIS/issues/635, https://github.com/opengeos/RustGIS/commit/b8c77f7, https://github.com/opengeos/RustGIS/commit/5788729
9. deck.gl request scheduler: https://github.com/visgl/deck.gl/commit/1ca25a6b, https://github.com/visgl/deck.gl/commit/b2fcd89b, https://github.com/visgl/deck.gl/commit/e7261715, https://github.com/visgl/deck.gl/commit/05ca54e0, https://github.com/visgl/deck.gl/commit/a75dc388
10. MapLibre GL JS abort paths: https://github.com/maplibre/maplibre-gl-js/commit/1d3d433d9, https://github.com/maplibre/maplibre-gl-js/commit/368a604f1, https://github.com/maplibre/maplibre-gl-js/commit/95c703172
11. Cesium cancelled-request leak: https://github.com/CesiumGS/cesium/commit/1f3be6cd8, https://github.com/CesiumGS/cesium/issues/8843
12. deck.gl cancelled tiles cached empty: https://github.com/visgl/deck.gl/pull/4645
13. deck.gl centre-first priority: https://github.com/visgl/deck.gl/commit/a75dc388, `ref-repos/visgl__deck.gl/modules/geo-layers/src/tileset-2d/tileset-2d.ts`
14. Cesium foveated prioritisation: https://github.com/CesiumGS/cesium/pull/7774, `ref-repos/CesiumGS__cesium/CHANGES.md`
15. navara PMTiles reader: https://github.com/maplibre/navara/blob/main/crates/pmtiles/src/archive.rs, https://github.com/maplibre/navara/blob/main/crates/navara_pmtiles/src/source.rs, https://github.com/maplibre/navara/blob/main/docs/src/content/docs/three/Source/vector-tile-source.md
16. Cesium global scheduler and its reversal: https://github.com/CesiumGS/cesium/pull/3476, https://github.com/CesiumGS/cesium/pull/7061
17. MapLibre GL JS raster throttle while moving: https://github.com/maplibre/maplibre-gl-js/commit/99ad3d7d0, https://github.com/maplibre/maplibre-gl-js/commit/af0254e20
18. deck.gl debounceTime: https://github.com/visgl/deck.gl/commit/401e7a6d
19. ortho-earth byte-bounded tile cache: https://github.com/kenjiyoshidahome2026-bit/ortho-earth/commit/45a8edb1
20. deck.gl cache by bytes and pruning: https://github.com/visgl/deck.gl/issues/4230, https://github.com/visgl/deck.gl/commit/f00e3ffc, https://github.com/visgl/deck.gl/commit/68533ae0
21. RustGIS byte-bounded streamed views: `ref-repos/opengeos__RustGIS/docs/user-guide/data.md`, https://github.com/opengeos/RustGIS/commit/cfeef0c
22. navara memory management: https://github.com/maplibre/navara/blob/main/guide/MEMORY_MANAGEMENT.md, `ref-repos/maplibre__navara/guide/MEMORY_MANAGEMENT.md`, https://github.com/maplibre/navara/pull/692
23. Cesium cacheBytes and memory-adjusted SSE: https://github.com/CesiumGS/cesium/pull/11310, https://github.com/CesiumGS/cesium/commit/0fa7440b0463e4b87ebca23d93b4b60a27d1b30e, https://github.com/CesiumGS/cesium/commit/a8ddd9749cd7e5a79c4a9c42d7e329ffab060faf, https://github.com/CesiumGS/cesium/commit/5de34c26a5b880ccf5d289d40bf90d2c608ee0c5, https://github.com/CesiumGS/cesium/commit/0bf03df1fb74caa0353f093fda38b8d399311f13
24. QGIS 3D chunk budget: https://github.com/qgis/QGIS/commit/07af5ea9a7
25. MapLibre Native cache sized from viewport: https://github.com/maplibre/maplibre-native/commit/44b960fb9, https://github.com/maplibre/maplibre-native/commit/68440ee6c, https://github.com/maplibre/maplibre-native/commit/b0a928dcb, https://github.com/maplibre/maplibre-native/commit/20189db67, https://github.com/maplibre/maplibre-native/commit/8fa078c08, https://github.com/maplibre/maplibre-native/commit/f40519e78
26. MapLibre GL JS ETag skip: https://github.com/maplibre/maplibre-gl-js/pull/6972, https://github.com/maplibre/maplibre-gl-js/pull/7074
27. Range cache keys: https://github.com/maplibre/maplibre-native/commit/a2eb4409a, `ref-repos/maplibre__maplibre-native/platform/default/src/mln/storage/offline_database.cpp`, `ref-repos/maplibre__maplibre-native/test/storage/offline_database.test.cpp`, `ref-repos/maplibre__maplibre-native/test/storage/pmtiles_file_source.test.cpp`, https://github.com/maplibre/navara/commit/20d30a41
28. MapLibre Native PMTiles ETag invalidation: https://github.com/maplibre/maplibre-native/pull/4290, https://github.com/maplibre/maplibre-native/pull/4111
29. ortho-earth IndexedDB row-group cache: https://github.com/kenjiyoshidahome2026-bit/ortho-earth/commit/c5492461
30. reearth-papers cache keys: https://github.com/reearth/reearth-papers/commit/fec9e11, https://github.com/reearth/reearth-papers/commit/9e53d86, https://github.com/reearth/reearth-papers/commit/eb31c89, `ref-repos/reearth__reearth-papers/src/ezu.ts`, `ref-repos/reearth__reearth-papers/CONTRIBUTING.md`
31. ortho-earth projection-mode cache key: https://github.com/kenjiyoshidahome2026-bit/ortho-earth/issues/43
32. MapLibre Native disk cache eviction: https://github.com/maplibre/maplibre-native/commit/a2ceeb4a5, https://github.com/maplibre/maplibre-native/commit/a06f28ddb, https://github.com/maplibre/maplibre-native/commit/6d0b01c5f
33. MapLibre Native glyph cache overwritten offline: https://github.com/maplibre/maplibre-native/issues/2410
34. reearth-papers negative glyph cache: https://github.com/reearth/reearth-papers/commit/6af6885
35. MapLibre GL JS updateData: https://github.com/maplibre/maplibre-gl-js/pull/1605, https://github.com/maplibre/maplibre-gl-js/pull/6562
36. Latest-wins coalescing: https://github.com/maplibre/maplibre-gl-js/commit/fa95c19c0, https://github.com/maplibre/maplibre-gl-js/commit/725f2666b, https://github.com/maplibre/maplibre-gl-js/commit/e5497caf1, `ref-repos/maplibre__maplibre-native/docs/mdbook/src/design/geometry-tile-worker.md`
37. deck.gl stale content during reload: https://github.com/visgl/deck.gl/commit/9b263690, https://github.com/visgl/deck.gl/commit/1798a333
38. reearth-visualizer blink fix: https://github.com/reearth/reearth-visualizer/commit/c10a6713
39. Cesium progressive availability: https://github.com/CesiumGS/cesium/pull/7196, `ref-repos/CesiumGS__cesium/CHANGES.md`
40. MapLibre Native PMTiles directory cache: https://github.com/maplibre/maplibre-native/commit/cf9f41cf6, `ref-repos/maplibre__maplibre-native/platform/default/src/mln/storage/pmtiles_file_source.cpp`
41. RustGIS PMTiles leaf single-flight: https://github.com/opengeos/RustGIS/commit/f9a9343, https://github.com/opengeos/RustGIS/commit/4d0d1ff
42. ortho-earth GeoParquet over Range: https://github.com/kenjiyoshidahome2026-bit/ortho-earth/blob/main/packages/geopbf/README.md, `ref-repos/kenjiyoshidahome2026-bit__ortho-earth/packages/geopbf/README.md`, `ref-repos/kenjiyoshidahome2026-bit__ortho-earth/DATA.md`, https://github.com/kenjiyoshidahome2026-bit/ortho-earth/commit/551a2aa5
43. Cesium Accept-header token: https://github.com/CesiumGS/cesium/commit/c67111c60, https://github.com/CesiumGS/cesium/commit/d6b06e5c4, https://github.com/CesiumGS/cesium/pull/8561
44. ortho-earth WebGPU tile pool: https://github.com/kenjiyoshidahome2026-bit/ortho-earth/blob/main/packages/ortho-core/vt%20perf%20plan.md, `ref-repos/kenjiyoshidahome2026-bit__ortho-earth/packages/ortho-core/vt perf plan.md`
45. deck.gl incremental loading: https://github.com/visgl/deck.gl/blob/master/docs/developer-guide/performance.md
46. Cesium performance.now budget: https://github.com/CesiumGS/cesium/commit/2c162b1df
47. Cesium bounded height-update queue: https://github.com/CesiumGS/cesium/commit/142b1d6c545bed0119493b12e4d969be100e7d2b
48. MapLibre GL JS worker pipeline: `ref-repos/maplibre__maplibre-gl-js/developer-guides/life-of-a-tile.md`, `ref-repos/maplibre__maplibre-gl-js/ARCHITECTURE.md`, https://github.com/mapbox/mapbox-gl-js/pull/7124
49. Cesium ImageBitmap revert: https://github.com/CesiumGS/cesium/pull/7579, `ref-repos/CesiumGS__cesium/CHANGES.md`
50. navara fetch priority reverted: https://github.com/maplibre/navara/commit/20d30a41
51. QGIS geometry cache removed: `ref-repos/qgis__QGIS/ChangeLog` (2017-05-05 Remove QgsGeometryCache class)
52. navara drape readiness: https://github.com/maplibre/navara/blob/main/guide/VECTOR_TILE_DRAPING.md
53. Cesium per-frame re-bake: https://github.com/CesiumGS/cesium/commit/1bcefa194c5f047bbf43ada6201094af8948d29a
54. QGIS tile export pipeline: https://github.com/qgis/QGIS/commit/6439498f90, https://github.com/qgis/QGIS/commit/607e65f42d, https://github.com/qgis/QGIS/commit/a96513a36a
55. QGIS whole-zoom fetch guard: `ref-repos/qgis__QGIS/ChangeLog` (2025-04-23 "[vectortiles] Never try to request every tile in a zoom level", line 53299)
56. Cesium metadata cache: https://github.com/CesiumGS/cesium/commit/4874f8ffe
