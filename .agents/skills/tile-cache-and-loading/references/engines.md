# Tile cache and loading, engine by engine

Detail behind SKILL.md, grouped by engine. Each item gives the decision,
its trade-off and the evidence. References [n] point to the list at the
end of this file (numbered independently of SKILL.md).

## MapLibre GL JS

- **Workers do the heavy work.** Fetch, PBF decode, buckets, feature
  index and symbol layout run in WebWorkers; the main thread uploads
  lazily and draws. Cost: transfer and message round trips; 0.49.0 had to
  shrink worker-to-main JSON and hash symbol keys to cut transfer cost [1].
- **`updateData` by feature id.** 11.5 ms to 1.8 ms per update (M1); a later
  PR reloads only affected tiles (about 50% faster for 1 of 100k points),
  with a full reload above 1,000 changes. Requiring ids only for
  `updateData` was rejected ("pit of success"); computing bounds in the
  worker gave no measurable gain and was reverted. Costs: unique ids
  required, `serialize()` no longer reflects current state, a later stale
  extrusion report [2].
- **ETag unchanged.** The worker compares the stored ETag with the
  response and returns "unchanged", skipping `WorkerTile.parse` and the
  data event. Reusing `shouldReloadTile` was rejected because it skips the
  request entirely [3].
- **`maxParallelImageRequests`** queues raster image requests [4]; a
  per-frame throttle while moving regressed until the queue was processed
  on each render while moving (#2278) [5].
- **setData coalescing** (Idle / Coalescing / NeedsLoadData) drops all but
  the latest pending load. First version reverted for abandoned callbacks
  (#5970), then re-landed [6].
- **Own Cache API layer** because a per-load `sku` parameter defeated HTTP
  caching; follow-ups for slow `ignoreSearch` in Chrome, a Safari leak on
  `caches.open` + `keys()`, Firefox SecurityError [7].
- **Overzoom re-slicing** with geojson-vt in a bounded LRU, behind
  `experimentalZoomLevelsToOverscale`, default only on Safari ("can
  prevent Safari crashes ... setting it to 4 or less"); later cache-key and
  MLT bugs [8].
- **Aborts** must reject, must not dispatch dropped tiles, and must reach
  every worker [9].

## MapLibre Native

- **Geometry tile worker** is a state machine that coalesces queued
  messages to the latest state and re-lays out symbols when glyphs or
  images arrive; it "saves itself from starvation" under load [10].
- **Tile cache can be disabled** (#2590, #2723): "reduce memory usage at the
  cost of having to parse tile data again when the zoom level changes".
  Clearing the in-memory cache before backgrounding also reduced memory;
  prefetched tiles are reused to avoid an empty screen [11].
- **In-memory cache size from the viewport** (tiles per screen, never zero,
  recomputed on resize); the user setter was removed; raster tiles are
  cached; stale tiles are not [12].
- **Disk cache** evicts resources and tiles together by access time
  (UNION ALL, oldest 50), caches only 200 and 404, can be capped [13].
- **Ambient tables split from offline tables** so cache init is bounded by
  the ambient cache size. Rejected: a stored size counter or an is-ambient
  flag, because a crash between two writes leaves the DB incoherent; the
  chosen design only wastes space on failure. Cost: one cache clear on
  upgrade [14].
- **PMTiles** via `pmtiles://` (#2882), Range on asset files (#3404), APK
  archives read by range (#4602); fixes for XYZ scheme, tile compression,
  metadata decompression errors [15]. Caching (#4290) appends
  `_mlnRange=start-end` to the URL key because the resources table is
  UNIQUE(url); `file://` bypasses the cache; differently aligned ranges
  miss. The original re-fetched the header per tile ("extremely
  wasteful"); caching it desynced when an R2 archive was replaced in place,
  so ETag is tracked (#4111 adds Modified for local files) [16].
- **Directory cache** keyed `url|offset|length`, at most 100 per archive,
  move-to-back on hit [17].
- **Prefetch** at zoom minus 4 "to show something on the screen faster at
  the cost of a little of bandwidth"; loaded parents are fallbacks [18].
- **Parent overscale cap** per source, because parents "overscaled multiple
  times" look bad, especially raster [19].
- **Glyphs**: an offline error overwrote cached glyphs and fonts used
  implicitly were missing from offline packs (#2410, a 500 EUR bounty
  withdrawn after shipping fonts locally) [20]; stale glyphs are used and
  never updated, raw bytes dropped after parsing [21]; default fonts are no
  longer fetched for icon-only layers ("~15MB and a few seconds"), CJK
  ranges can be excluded [22].
- **On-demand image cache** capped at 100 x 8192 bytes (about 8 kB per
  sprite at pixel ratio 2) [23].

## maplibre-rs

- **Caching at the HTTP layer** (browser cache; reqwest middleware on disk),
  honouring expiry; tessellation is redone on every load. An IndexedDB
  store and a Workbox service worker were tried and disabled; the native
  cache did not work on mobile, and its crate was replaced [24].
- **SourceShapes** (Parent, Children, Itself, None) drawn through a stencil
  of the target tile; a FIXME notes the pattern can grow "dramatically" on
  a slow network, and that too small buffer pools cause load/unload
  back-and-forth [25].

## MapLibre Tile spec (yuiseki fork)

- For bsdiff-style updates use `--delta2 --sort none --no-shared-dict
  --no-fsst`, no gzip, no rANS or tessellation: rANS roughly doubles the
  patch, shared dictionaries renumber on one new string [26].
- A shared FSST dictionary is decoded once per tile, shared by its child
  vectors (test: `decodeFsst()` called once for two vectors) [27].

## navara

- **Memory ledger** (CPU bytes, GPU estimates, render targets, in-flight
  reservations): LRU pool off screen, eviction to 85%, load gate, SSE x1.25
  per 15 stalled frames; budgets 1/4 of device memory capped at 2 GB
  (desktop), 512 or 256 MB (mobile). Cost: per-device tuning and accurate
  cost hints [28].
- **Reservations**: EMA mean + 0.5 SD (alpha 0.08, 64 KB-16 MB), cold-start
  seed per pipeline; a fixed raster hint undercounted terrain about 10x (a
  3 MB atlas per tile); a 30 MB outlier motivated the clamp [28].
- **PR 692**: mobile "easily crashed when a large tile is selected"; LRU
  retention, dynamic SSE, and a JS buffer store to avoid duplicate WASM
  copies [29].
- **PMTiles reader** is an IO-free state machine emitting byte ranges;
  16 KiB bootstrap; leaf cache 32 MB (all leaves of a global archive: 50-500
  MB); directory fetches bypass tile backpressure, ordered by SSE then
  nearest [30].
- **Dedup by URL + byte range**; two commits of "prioritized tile fetch
  ordering" were reverted in favour of OrderByDistance [31].
- **Sources separate from layers**, ref-counted, so many layers share one
  fetch and cache [32].
- **Readiness recomputed** from live state each frame instead of a
  `scene_ready` flag that drifted on eviction [33].

## RustGIS

- **Remote GeoParquet/FlatGeobuf in place**: footer, row groups by bbox
  covering, column chunks; FlatGeobuf R-tree one level per round. Misses
  round to 64 KiB, neighbours merge, an LRU of fetched bytes; a round asking
  for more than twice the read budget fails rather than send millions of
  requests. Fallback: whole download [34].
- **One window per view**, padded half a view, one read in flight per
  layer; a failed read clears features rather than draw stale ones [35].
  Above 100,000 features a layer streams; a view holds at most 250,000
  (100,000 in the browser), sampled evenly; streamed layers are read-only
  [36].
- **Byte budget** 128 MiB desktop / 48 MiB browser, plus 64 MiB thinned
  geometry per layer; not an RSS or GPU cap [37].
- **Scheduler**: 8 per server in browser (4 OSM), 16/8 native, newest
  first, drop after 1.5 s, 30 s timeout; requests 168/162 to 152/151 with no
  frame-time change on a fast machine [38]. Native: 32 workers; Wayback
  1920x1080 from about 2.25 s to 1.3 s [39].
- **PMTiles leaf single-flight**; a full leaf cache evicts one entry; bounds
  on offsets, counts and nesting; zstd window capped at 32 MB [40].
- **Vector tiles drawn into cached pictures**: pan 5-13 ms (GPU) / 20-26 ms
  (CPU) against 220-410 ms; pictures were keyed by exact resolution, so
  moving frames missed until #600 [41].

## reearth-papers

- **Learned glyph set in one R2 object**: one ~1 MB GET instead of up to
  38 MB of blocks on a cold isolate (first tile took ~1.6-2 s); rewritten
  when grown 25%, capped at 3 MB [42].
- **Negative cache only from parsed blocks** [43].
- **Cache key from everything that moves pixels**, pushed to the edge key
  (`?__v=`); old namespaces left unreachable (~4.9 GB orphaned) [44].
- **Content-hash style revisions plus a runtime version**; a 1 h manifest
  memo made isolates disagree (404 vs 200), lowered to 10 min [45].
- **Range-read upstream PMTiles** instead of mirroring (~135 GB per daily
  build); a pinned release disappeared and five routes returned 500, so the
  release is resolved at run time [46].
- **Bump the cache only for themes affected** (bidi change) [47].
- **Mirror sprites on first miss**: the sprite was ~227 ms of a ~1.7 s cold
  start and a hard dependency on GitHub Pages [48].

## reearth-visualizer

- Inline GeoJSON compared feature by feature with the previous features
  (ignoring generated ids); equal means reuse, which stopped blinking [49].

## CesiumGS/cesium

- **ImageBitmap default** (1.56) reverted in 1.56.1: an ImageBitmap cannot
  be flipped during upload; later bugs with 204 responses, blend modes,
  glTF stutter [50].
- **Foveated, motion-aware requests**: ~67% less camera-tour load time,
  ~44% fewer loads; ~20%/~27% for general movement [51].
- **Per-server limit** 6 to 18 for HTTP/2 (1.113); Mapbox subdomain
  sharding "improved by 300%" earlier [52].
- **Load ordering**: 25% shorter loads (#4616); terrain/imagery ~33% faster
  with ~33% less data (#7061) [53].
- **Progressive availability** instead of an upfront list [54].
- **Byte cache** `cacheBytes` + `maximumCacheOverflowBytes` (1.107), SSE
  multiplied each frame while over (1.01 then 1.02), relaxed below 75% [55].
- **Hot paths**: repeated URI parsing fixed (tile parsing up to 25% faster),
  typed arrays instead of JS arrays [56].
- **RequestScheduler (#3476)**: 4G, cache off: static horizon 9.89 s / 262
  requests to 9.79 s / 255; zoom from space 6.41 s / 216 to 5.93 s / 190;
  HTTP/2 throttled 5.1-5.8 s vs unthrottled 4.9-5.3 s. Per-frame budgets
  dropped because several widgets shared a page [57]. Taken off terrain
  and imagery in #7061 [58].
- **5 ms load slice** measured with `performance.now()` (over 10 ms with
  `Date.now()`) [59].
- **Load only tiles chosen for rendering**, not children of every visited
  tile [60]; **don't wait for the slowest imagery layer**, use the parent's
  [61].
- **Accept-header token** (2018) reverted to Authorization (2020) when the
  Fetch spec forced a preflight on long Accept headers [62].
- **Metadata cached per URL** within a session [63]; **empty tiles detected
  by empty response**, not pixel comparison [64]; **cancelled requests
  leaked** payloads [65].
- **Vector bake**: projection cached per collection [66]; only rendered
  tiles baked, re-bake by dirty region; `makeClean` was never called, so
  tiles re-baked every frame [67]; wrap-safe overlap across the antimeridian
  [68].
- **Bounded height-update queue** (2 ms budget) with a position cache [69];
  skip the work when collision is off [70].

## deck.gl

- **One layer per arriving chunk**: appending 100K to 1M recomputes 1.1M
  rows; ~100 layers fine, not thousands; 1000 layers redraw CPU 76 to
  26 ms after lifecycle work [71].
- **TileLayer roadmap**: "not a full basemap replacement"; later AbortSignal,
  `maxCacheByteSize`, refinement strategies, Tileset2D, centre-first [72].
- **Abort and maxRequests 6** [73]; **RequestScheduler** and the empty-tile
  bug [74][75]; **byteLength budget** [76].
- **Multiple views share one tileset**; per-view last viewport, else an
  infinite update loop; one layer per view loads every tile twice [77].
- **TileJSON** zoom range clamps requests [78].
- **Stale content during reload** with a loader id [79]; **refinement
  strategies** (best-available, no-overlap for opacity < 1, never) [80].
- **Lazy WGS84** per tile, cached on first read [81].
- **Centre-first priority** (SELECTED 0, VISIBLE 1e8) [82]; **debounceTime**
  opt-in [83]; **prune neither visible nor selected** [84]; **0 means 0**
  [85]; **pick-rect culling** of tiles [86].

## ortho-earth (GPL-3.0-or-later)

- **GeoParquet over Range**: `bytes=0-0` then the last 64 KB for the
  footer, CORS-safelisted; bbox statistics prune; ranges merged; 32 of 63
  row groups, 110 KB of 505 KB for a Tokyo view; GitHub Pages answered 206
  with ACAO `*` [87].
- **Draw from row-group chunks** instead of building topology first:
  1.5 MB 457 vs 75 ms, 11 MB 1257 vs 98 ms, 32 MB of points 1307 vs 255 ms
  (SwiftShader, relative) [88].
- **WebGPU tile pool** replaced re-merging; high-water mark never shrinks,
  so low-memory devices keep the classic merge [89].
- **Cache key includes projection mode** [90]; **offline packs** estimated
  from 6 sample tiles, refused over 80% of free quota; Japan at z16 was
  ~130 GB [91].
- **8 MB streaming threshold**, 64 MB compressed budget, attributes read
  lazily [92]; **IDB cache by URL|ETag|row group**, 256 MB LRU; await the
  put before transferring buffers or detached empty buffers get stored
  [93]; **byte-bounded tile cache from deviceMemory** [94]; **baked result
  cached by SHA-256**: second open 12.2 s to 1.16 s [95].

## QGIS

- **Never request every tile of a zoom** when reprojection of the extent
  fails at +/-180 or +/-90 [96].
- **Raw tile cache only for VTPK**, where profiling showed unzip cost [97].
- **Label result cached as an image** [98]; **per-layer images kept from
  cancelled jobs**, keyed by extent and map-to-pixel [99]; **geometry cache
  removed** (rebuilt every redraw, no spatial index) [100].
- **OGR pool keeps refcounts** so render threads release file handles
  promptly (60 s pool timeout locked files on Windows) [101].
- **Simplifier must not write into shared WKB** (features got "more and
  more generalised") [102].
- **Scaled cached images while rendering**; labels reused only at 30%-300%;
  rotation missing from the key at first [103].
- **Bake export**: encoding in a pool, one batched MBTiles writer: PNG 268 s
  to 21 s for 75,560 tiles [104]; WAL, `synchronous=OFF` for a regenerable
  bake [105]; **3D budget 100 to 500 MB** [106].

## GRASS GIS

- **Raster codec** ZSTD (else ZLIB level 1): ZSTD "compresses up to 4x
  faster than ZLIB, and usually decompresses 6x faster"; codec id per
  blob [107].
- **Segment library**: power-of-two segment sides are about 10% faster, and
  32-128 a side is best for scattered access; nrows/4+1 is "very poor" [108].
- **r.proj**: footprint from edge samples padded by a row with a reload
  fallback (interior needed at most 0.044 rows over 62,599 blocks) [109];
  band height grows to the memory option and falls back to serial [110].

## Sources

1. `ref-repos/maplibre__maplibre-gl-js/developer-guides/life-of-a-tile.md`, `ref-repos/maplibre__maplibre-gl-js/ARCHITECTURE.md`, https://github.com/mapbox/mapbox-gl-js/pull/7124
2. https://github.com/maplibre/maplibre-gl-js/pull/1605, https://github.com/maplibre/maplibre-gl-js/pull/6562
3. https://github.com/maplibre/maplibre-gl-js/pull/6972, https://github.com/maplibre/maplibre-gl-js/pull/7074
4. https://github.com/maplibre/maplibre-gl-js/commit/54d6d3411, https://github.com/maplibre/maplibre-gl-js/commit/80c472576
5. https://github.com/maplibre/maplibre-gl-js/commit/99ad3d7d0, https://github.com/maplibre/maplibre-gl-js/commit/af0254e20
6. https://github.com/maplibre/maplibre-gl-js/commit/fa95c19c0, https://github.com/maplibre/maplibre-gl-js/commit/725f2666b, https://github.com/maplibre/maplibre-gl-js/commit/e5497caf1
7. https://github.com/maplibre/maplibre-gl-js/commit/500320f89, https://github.com/maplibre/maplibre-gl-js/commit/20c90905a, https://github.com/maplibre/maplibre-gl-js/commit/6b424fee4, https://github.com/maplibre/maplibre-gl-js/commit/70087e3f8, https://github.com/maplibre/maplibre-gl-js/commit/83ab6b72d
8. https://github.com/maplibre/maplibre-gl-js/commit/11b610182, https://github.com/maplibre/maplibre-gl-js/commit/3f6b54cdc, https://github.com/maplibre/maplibre-gl-js/commit/09349fb23
9. https://github.com/maplibre/maplibre-gl-js/commit/1d3d433d9, https://github.com/maplibre/maplibre-gl-js/commit/368a604f1, https://github.com/maplibre/maplibre-gl-js/commit/95c703172
10. `ref-repos/maplibre__maplibre-native/docs/mdbook/src/design/geometry-tile-worker.md`
11. `ref-repos/maplibre__maplibre-native/platform/ios/CHANGELOG.md`, `ref-repos/maplibre__maplibre-native/platform/android/CHANGELOG.md`, https://github.com/maplibre/maplibre-native/commit/1ae14a55d, https://github.com/maplibre/maplibre-native/commit/a4258ccbb, `ref-repos/maplibre__maplibre-native/src/mln/renderer/render_orchestrator.cpp`
12. https://github.com/maplibre/maplibre-native/commit/44b960fb9, https://github.com/maplibre/maplibre-native/commit/68440ee6c, https://github.com/maplibre/maplibre-native/commit/b0a928dcb, https://github.com/maplibre/maplibre-native/commit/20189db67, https://github.com/maplibre/maplibre-native/commit/8fa078c08, https://github.com/maplibre/maplibre-native/commit/f40519e78
13. https://github.com/maplibre/maplibre-native/commit/a2ceeb4a5, https://github.com/maplibre/maplibre-native/commit/a06f28ddb, https://github.com/maplibre/maplibre-native/commit/6d0b01c5f
14. `ref-repos/maplibre__maplibre-native/design-proposals/2023-11-06-ambient-cache-initialization-speed-improvement.md`, https://github.com/maplibre/maplibre-native/issues/1815, https://github.com/maplibre/maplibre-native/commit/98860f4cd
15. https://github.com/maplibre/maplibre-native/pull/4602 and the Android/iOS CHANGELOGs in [11]
16. https://github.com/maplibre/maplibre-native/pull/4290, https://github.com/maplibre/maplibre-native/pull/4111, https://github.com/maplibre/maplibre-native/commit/a2eb4409a, `ref-repos/maplibre__maplibre-native/platform/default/src/mln/storage/offline_database.cpp`, `ref-repos/maplibre__maplibre-native/test/storage/offline_database.test.cpp`, `ref-repos/maplibre__maplibre-native/test/storage/pmtiles_file_source.test.cpp`
17. https://github.com/maplibre/maplibre-native/commit/cf9f41cf6, `ref-repos/maplibre__maplibre-native/platform/default/src/mln/storage/pmtiles_file_source.cpp`
18. https://github.com/maplibre/maplibre-native/commit/407fbc70b, https://github.com/maplibre/maplibre-native/commit/70362662f
19. https://github.com/maplibre/maplibre-native/commit/15f73a06f2048d4b5f0481d54a79f3f349187b11
20. https://github.com/maplibre/maplibre-native/issues/2410
21. https://github.com/maplibre/maplibre-native/commit/a88e58ef3, https://github.com/maplibre/maplibre-native/commit/73ddff60a
22. https://github.com/maplibre/maplibre-native/commit/ce429dcc1fce2a827e5c9462e3226c3bb04c6a39, https://github.com/maplibre/maplibre-native/commit/b7e2b11a75fd1b12d0ff948b9602fcd3db3779cf
23. https://github.com/maplibre/maplibre-native/commit/0344ce36c483dbbcf770ac7f2615a233b22c4452
24. `ref-repos/maplibre__maplibre-rs/docs/src/development-documents/caching.md`, https://github.com/maplibre/maplibre-rs/blob/main/docs/src/development-documents/caching.md, https://github.com/maplibre/maplibre-rs/commit/7e11f85, https://github.com/maplibre/maplibre-rs/commit/fad6b35, https://github.com/maplibre/maplibre-rs/commit/1f6e31a, https://github.com/maplibre/maplibre-rs/commit/52cc15b, https://github.com/maplibre/maplibre-rs/commit/151ee9f
25. https://github.com/maplibre/maplibre-rs/blob/main/maplibre/src/render/tile_view_pattern/mod.rs, `ref-repos/maplibre__maplibre-rs/maplibre/src/render/tile_view_pattern/pattern.rs`, https://github.com/maplibre/maplibre-rs/commit/2b917e9, https://github.com/maplibre/maplibre-rs/commit/67109d8, https://github.com/maplibre/maplibre-rs/commit/d8c2844
26. https://github.com/maplibre/maplibre-tile-spec/blob/main/docs/benchmarks.md, `ref-repos/yuiseki__maplibre-tile-spec/docs/benchmarks.md`
27. https://github.com/yuiseki/maplibre-tile-spec/commit/c9c39700
28. https://github.com/maplibre/navara/blob/main/guide/MEMORY_MANAGEMENT.md, `ref-repos/maplibre__navara/guide/MEMORY_MANAGEMENT.md`
29. https://github.com/maplibre/navara/pull/692
30. https://github.com/maplibre/navara/blob/main/crates/pmtiles/src/archive.rs, https://github.com/maplibre/navara/blob/main/crates/navara_pmtiles/src/source.rs, https://github.com/maplibre/navara/blob/main/docs/src/content/docs/three/Source/vector-tile-source.md
31. https://github.com/maplibre/navara/commit/20d30a41
32. https://github.com/maplibre/navara/blob/main/guide/ARCHITECTURE.md, https://github.com/maplibre/navara/blob/main/CHANGELOG.md
33. https://github.com/maplibre/navara/blob/main/guide/VECTOR_TILE_DRAPING.md
34. `ref-repos/opengeos__RustGIS/docs/user-guide/data-formats.md`, https://github.com/opengeos/RustGIS/commit/564f953
35. https://github.com/opengeos/RustGIS/commit/d053cf3, `ref-repos/opengeos__RustGIS/docs/user-guide/data.md`
36. https://github.com/opengeos/RustGIS/commit/d053cf3, https://github.com/opengeos/RustGIS/commit/5f498a3
37. `ref-repos/opengeos__RustGIS/docs/user-guide/data.md`, https://github.com/opengeos/RustGIS/commit/cfeef0c
38. https://github.com/opengeos/RustGIS/pull/636, https://github.com/opengeos/RustGIS/issues/635, https://github.com/opengeos/RustGIS/commit/b8c77f7
39. https://github.com/opengeos/RustGIS/commit/5788729
40. https://github.com/opengeos/RustGIS/commit/f9a9343, https://github.com/opengeos/RustGIS/commit/4d0d1ff
41. https://github.com/opengeos/RustGIS/commit/f7b50fd
42. https://github.com/reearth/reearth-papers/commit/eabf229, `ref-repos/reearth__reearth-papers/src/ezu.ts`
43. https://github.com/reearth/reearth-papers/commit/6af6885
44. https://github.com/reearth/reearth-papers/commit/fec9e11, https://github.com/reearth/reearth-papers/commit/9e53d86, https://github.com/reearth/reearth-papers/commit/eb31c89, `ref-repos/reearth__reearth-papers/CONTRIBUTING.md`
45. https://github.com/reearth/reearth-papers/commit/9f63562, https://github.com/reearth/reearth-papers/commit/4e9fcb0, https://github.com/reearth/reearth-papers/commit/89e5870, https://github.com/reearth/reearth-papers/commit/c06d53d
46. https://github.com/reearth/reearth-papers/commit/4148135, https://github.com/reearth/reearth-papers/commit/2caf02d
47. https://github.com/reearth/reearth-papers/commit/30e194f
48. https://github.com/reearth/reearth-papers/commit/6af6885, `ref-repos/reearth__reearth-papers/mirror/README.md`
49. https://github.com/reearth/reearth-visualizer/commit/c10a6713
50. `ref-repos/CesiumGS__cesium/CHANGES.md`, https://github.com/CesiumGS/cesium/pull/7579, https://github.com/CesiumGS/cesium/pull/9627, https://github.com/CesiumGS/cesium/pull/7914, https://github.com/CesiumGS/cesium/issues/12846
51. https://github.com/CesiumGS/cesium/pull/7774
52. https://github.com/CesiumGS/cesium/issues/11627, https://github.com/CesiumGS/cesium/issues/6426, https://github.com/CesiumGS/cesium/commit/26fc56183, https://github.com/CesiumGS/cesium/pull/6445
53. https://github.com/CesiumGS/cesium/pull/4616, https://github.com/CesiumGS/cesium/pull/7061
54. https://github.com/CesiumGS/cesium/pull/7196
55. https://github.com/CesiumGS/cesium/pull/11310, https://github.com/CesiumGS/cesium/commit/0fa7440b0463e4b87ebca23d93b4b60a27d1b30e, https://github.com/CesiumGS/cesium/commit/a8ddd9749cd7e5a79c4a9c42d7e329ffab060faf, https://github.com/CesiumGS/cesium/commit/5de34c26a5b880ccf5d289d40bf90d2c608ee0c5, https://github.com/CesiumGS/cesium/commit/0bf03df1fb74caa0353f093fda38b8d399311f13
56. https://github.com/CesiumGS/cesium/issues/11197, https://github.com/CesiumGS/cesium/pull/13643, https://github.com/CesiumGS/cesium/pull/13808
57. https://github.com/CesiumGS/cesium/pull/3476
58. https://github.com/CesiumGS/cesium/pull/7061
59. https://github.com/CesiumGS/cesium/commit/2c162b1df
60. https://github.com/CesiumGS/cesium/commit/6b67a37b4
61. https://github.com/CesiumGS/cesium/commit/4537f3f3f
62. https://github.com/CesiumGS/cesium/commit/c67111c60, https://github.com/CesiumGS/cesium/commit/d6b06e5c4, https://github.com/CesiumGS/cesium/pull/8561
63. https://github.com/CesiumGS/cesium/commit/4874f8ffe
64. https://github.com/CesiumGS/cesium/commit/9966a0831
65. https://github.com/CesiumGS/cesium/commit/1f3be6cd8, https://github.com/CesiumGS/cesium/issues/8843
66. https://github.com/CesiumGS/cesium/commit/747b938c9ca6de479c2a8e92bab68b9fc5ab7d81
67. https://github.com/CesiumGS/cesium/commit/f4b2dca93115711270aef2a8b4bf3fa024fc71e1, https://github.com/CesiumGS/cesium/commit/333d43848676b77f0d42f052647564af7f5e2d48, https://github.com/CesiumGS/cesium/commit/1bcefa194c5f047bbf43ada6201094af8948d29a
68. https://github.com/CesiumGS/cesium/commit/caaf52f01349e667c84da627660ebb7feabeec70
69. https://github.com/CesiumGS/cesium/commit/142b1d6c545bed0119493b12e4d969be100e7d2b, https://github.com/CesiumGS/cesium/commit/dd7bf0367ef5b170355c6dcbc4b5d6733bf65dc8, https://github.com/CesiumGS/cesium/commit/145e2f25982299d9e7ec3177112baa3c9d1168fc
70. https://github.com/CesiumGS/cesium/commit/5ae7baee9f68623e01ab73ece2f0b344146bdfdf
71. https://github.com/visgl/deck.gl/blob/master/docs/developer-guide/performance.md, `ref-repos/visgl__deck.gl/docs/whats-new.md`
72. https://github.com/visgl/deck.gl/blob/master/dev-docs/roadmaps/tile-layer-roadmap.md, https://github.com/visgl/deck.gl/blob/master/docs/whats-new.md, `ref-repos/visgl__deck.gl/dev-docs/roadmaps/tile-layer-roadmap.md`
73. https://github.com/visgl/deck.gl/pull/4838, https://github.com/visgl/deck.gl/commit/8046edd2, https://github.com/visgl/deck.gl/commit/0adfe055, https://github.com/visgl/deck.gl/commit/19af42d9
74. https://github.com/visgl/deck.gl/pull/4645
75. https://github.com/visgl/deck.gl/commit/1ca25a6b, https://github.com/visgl/deck.gl/commit/b2fcd89b, https://github.com/visgl/deck.gl/commit/e7261715, https://github.com/visgl/deck.gl/commit/05ca54e0
76. https://github.com/visgl/deck.gl/issues/4230
77. https://github.com/visgl/deck.gl/pull/5758
78. https://github.com/visgl/deck.gl/pull/4967
79. https://github.com/visgl/deck.gl/commit/9b263690, https://github.com/visgl/deck.gl/commit/1798a333
80. https://github.com/visgl/deck.gl/commit/a976ef5d, https://github.com/visgl/deck.gl/commit/b5d45751
81. https://github.com/visgl/deck.gl/commit/db5f1320
82. https://github.com/visgl/deck.gl/commit/a75dc388, `ref-repos/visgl__deck.gl/modules/geo-layers/src/tileset-2d/tileset-2d.ts`
83. https://github.com/visgl/deck.gl/commit/401e7a6d
84. https://github.com/visgl/deck.gl/commit/f00e3ffc
85. https://github.com/visgl/deck.gl/commit/68533ae0
86. https://github.com/visgl/deck.gl/commit/13bed5d1
87. https://github.com/kenjiyoshidahome2026-bit/ortho-earth/blob/main/packages/geopbf/README.md, `ref-repos/kenjiyoshidahome2026-bit__ortho-earth/packages/geopbf/README.md`, https://github.com/kenjiyoshidahome2026-bit/ortho-earth/blob/main/packages/globe/src/columnar/README.md, `ref-repos/kenjiyoshidahome2026-bit__ortho-earth/DATA.md`
88. `ref-repos/kenjiyoshidahome2026-bit__ortho-earth/packages/globe/src/columnar/README.md`
89. https://github.com/kenjiyoshidahome2026-bit/ortho-earth/blob/main/packages/ortho-core/vt%20perf%20plan.md, `ref-repos/kenjiyoshidahome2026-bit__ortho-earth/packages/ortho-core/vt perf plan.md`, `ref-repos/kenjiyoshidahome2026-bit__ortho-earth/packages/ortho-core/webgpu port.md`, `ref-repos/kenjiyoshidahome2026-bit__ortho-earth/packages/ortho-core/fallback-ladder.md`
90. https://github.com/kenjiyoshidahome2026-bit/ortho-earth/issues/43
91. https://github.com/kenjiyoshidahome2026-bit/ortho-earth/issues/40
92. https://github.com/kenjiyoshidahome2026-bit/ortho-earth/commit/551a2aa5
93. https://github.com/kenjiyoshidahome2026-bit/ortho-earth/commit/c5492461
94. https://github.com/kenjiyoshidahome2026-bit/ortho-earth/commit/45a8edb1
95. https://github.com/kenjiyoshidahome2026-bit/ortho-earth/commit/6d398c83
96. `ref-repos/qgis__QGIS/ChangeLog` (2025-04-23, [vectortiles] Never try to request every tile in a zoom level)
97. `ref-repos/qgis__QGIS/ChangeLog` (2023-05-17, cache for read tile data from vtpk)
98. `ref-repos/qgis__QGIS/ChangeLog` (2017-02-01, [FEATURE] Cache labeling result)
99. `ref-repos/qgis__QGIS/ChangeLog` (2021-01-28, store cached layer results per job; explicit extent and map to pixel for cache image)
100. `ref-repos/qgis__QGIS/ChangeLog` (2017-05-05, Remove QgsGeometryCache class), `ref-repos/qgis__QGIS/doc/api_break.dox`
101. https://github.com/qgis/QGIS/pull/2755, https://github.com/qgis/QGIS/pull/2197
102. https://github.com/qgis/QGIS/commit/f00c52d5a6
103. https://github.com/qgis/QGIS/commit/d883d416fe, https://github.com/qgis/QGIS/commit/a290537b9e, https://github.com/qgis/QGIS/commit/ab94b204a2, https://github.com/qgis/QGIS/commit/c6dcea7bde
104. https://github.com/qgis/QGIS/commit/6439498f90
105. https://github.com/qgis/QGIS/commit/607e65f42d, https://github.com/qgis/QGIS/commit/a96513a36a
106. https://github.com/qgis/QGIS/commit/07af5ea9a7
107. `ref-repos/OSGeo__grass/raster/r.compress/r.compress.md`, https://github.com/OSGeo/grass/blob/main/raster/r.compress/r.compress.md, `ref-repos/OSGeo__grass/lib/gis/compress.c`
108. `ref-repos/OSGeo__grass/lib/segment/segmentlib.dox`, https://github.com/OSGeo/grass/blob/main/lib/segment/segmentlib.dox
109. https://github.com/OSGeo/grass/pull/7807, https://github.com/OSGeo/grass/blob/main/raster/r.proj/footprint.c
110. https://github.com/OSGeo/grass/pull/7807
