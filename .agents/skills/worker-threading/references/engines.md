# Worker threading, engine by engine

Detail behind SKILL.md, grouped by engine. Each item gives the decision,
its trade-off and the evidence. References [n] point to the list at the
end of this file (numbered independently of SKILL.md).

## MapLibre GL JS

- **Workers do the heavy tile work.** Fetch, PBF decode, buckets, feature
  index and symbol layout run in WebWorkers; the main thread uploads
  vertex buffers lazily in `Tile#upload` and draws. Cost: structured clone
  and transfer, glyph and image round trips (the worker asks the main
  thread), a large bucket abstraction. 0.49.0 had to shrink worker-to-main
  JSON (#7124) and murmur-hash symbol keys (#7127) to cut transfer cost [1].
- **Worker count.** Half the cores, then half capped at 6 (#7430, no
  benchmark given) [2], then 1 on every browser except Safari (half the
  logical cores, capped at 3) after A/B testing in #2354, flagged as
  breaking [3]. `src/util/worker_pool.ts` still sets 1 [3].
- **Pool lifetime.** v4.0 (#3433) gave the global dispatcher a strong claim
  on the pool, so it never drained; #8491 made the claim weak. On each
  return to the foreground the workers are pinged; if silent, the pool is
  restarted and each map rebuilds its style from a snapshot, using the same
  events as WebGL context loss. Reason: iOS Safari kills workers without
  notice and the map stayed stuck (#8461). An `onTerminate` callback was
  rejected as coupling [4].
- **v6 ESM only, explicit worker URL.** UMD and CSP bundles removed; one
  build target, CSP-compliant by default. Without `setWorkerUrl` the
  ngx-maplibre-gl showcase drew only the background; the RTL plugin had to
  move from `importScripts` to dynamic import [5].
- **Transfer vs copy.** Bucket ArrayBuffers are transferred; `rawTileData`
  is copied because the main thread also needs it; superfluous pbf copies
  removed; a generic serializer (#5143) [6].
- **Safari Transferables.** Mapbox GL 1.5.1 disabled Transferables on
  Safari (unbounded memory growth, #8771, #4695; fixes #8956, #9003);
  MapLibre 3.5.2 re-enabled them (#3225) [7].
- **StructArray.** Collision boxes in an ArrayBuffer (Int16 x1..y2 +
  Float32 scale): about 500 KB less per tile, about 60% faster creation,
  transferable; `get(i)` created an intermediate object, so indexed getters
  were added later [8]. symbolInstances became a StructArray, keys
  murmur-hashed, a packed FeaturePositionMap, and a worker-transfer
  benchmark was added [9].
- **GeoJSON `updateData`.** Diffs keyed by id or promoteId applied to a
  worker copy: 11.5 ms to 1.8 ms per update (M1). A later PR reloads only
  the tiles that contain changed features or intersect new geometry, full
  reload above 1,000 changes: about 50% faster for 1 of 100k points.
  Requiring ids only for updateData was rejected ("pit of success");
  computing bounds in the worker gave no measurable gain and was reverted.
  Costs: unique ids, `serialize()` no longer reflects current state, a later
  stale-extrusion report [10].
- **No full data back from the worker.** #6668 applies the diff to the
  main thread's copy instead: GeoJSONDiff bench 33.33 ms to 16.66 ms, two
  copies kept in sync; a `returnData: false` option (#6688) was split out,
  estimated at only about 10% for 100k points with setData [11]. Later an
  UpdateQueue sends one update at a time and coalesces waiting ones; the
  earlier promise chain kept every finished update alive so per-frame
  setData grew the heap until OOM (#8585) [12].
- **setData coalescing.** A worker state machine (Idle / Coalescing /
  NeedsLoadData) keeps only the latest pending load, with a round trip
  through the main thread ("a little less than full-throttle"). First
  version (Dec 2017) reverted for callbacks of abandoned loads (#5970),
  re-landed with the fix [13].
- **Cancel and abort.** The actor nulls the callback before posting the
  cancel (IE memory growth, #8481/#8490) [14]. Aborted `sendAsync` rejects
  with AbortError, tiles dropped during async `transformRequest` are not
  dispatched, unloaded tiles are removed from every worker (#7826, #8516,
  #8771) [15].
- **MVT as worker-to-main format for GeoJSON tiles.** When vector-tile-js
  started throwing on undefined values, maplibre's vt-pbf was changed to
  skip null/undefined (vt-pbf#16) rather than return raw feature objects.
  Alternatives listed: custom binary, JSON + TextEncoder, geobuf, GeoArrow,
  MLT (no JS encoder yet). Cost: such keys vanish from
  `queryRenderedFeatures`; no nested objects. Users run 10-100k live points
  on this path [16].
- **Projection in the worker.** A CRS carries a WKT/PROJ string; a
  `setProjectionHandler` loaded with `importScriptInWorkers` converts in the
  worker, keeping proj4 out of the bundle (+2.9 kB, 0.9 kB gzip).
  Main-thread pre-projection of a million points stalled about 500 ms;
  batching positions from the worker about 20 ms. Costs: clamping outside
  the world square, a diff reloads every tile, antipodes project to
  infinity [17].
- **Collision moved to the main thread.** One viewport-aligned
  CollisionIndex replaced per-tile CollisionTiles in workers, after
  perspective hacks including re-placement throttled to once per 300 ms;
  workers only prepare, the main thread places and updates small opacity
  buffers [18].
- **Glyph and icon requests batched** to 2 per tile instead of per bucket
  [19]. **Style posted to workers before main-thread processing** so both
  parse in parallel (#2131) [20].
- **DEM decode.** ImageBitmap transferred to and decoded in the worker when
  OffscreenCanvas exists, `getImageData` on the main thread otherwise; a
  Safari regression followed (#324/#325) [21].

## MapLibre Native

- **Geometry tile worker state machine** (Idle, Coalescing, NeedsParse,
  NeedsSymbolLayout) queues and coalesces messages per tile so a busy
  worker does not starve and produces a final result once the map stops;
  glyph or image arrival restarts symbol layout. The doc says the
  transitions "might not seem self-explanatory" [22].
- **Immutable Impl objects** shared between main, worker and render
  threads; mutation allocates a new Impl. The available-image set later
  became copy-on-write (#4651) for styles with many images [23].
- **Actor model with FIFO mailboxes** (2016, 41 files changed); the
  separate render thread was removed in 2015 (net -257 lines); workers run
  at lower priority [24]. **Only relevant style layers** are copied to each
  tile worker [25].
- **Global placement on the render thread** (2017 port of the GL JS
  rewrite): CollisionTile, FrameHistory and PlacementConfig deleted;
  GeometryTiles are not drawn until their symbols load, so the cross-tile
  index can prevent flicker [26].
- **`synchronousUpdate`** per GeoJSON source updates tiles on the render
  thread so a location indicator does not lag; a constructor option because
  a toggle would propagate asynchronously; "only for small updates";
  +125 KiB [27].

## maplibre-rs

- **WASM threads with SharedArrayBuffer** share a tile cache across workers,
  but Safari lacked SharedArrayBuffer and Firefox shared memory was
  corrupted by a parallel worker; the default WebGL demo is single-threaded
  and the multithreaded one "does not work on Safari" [28]. The host must
  send COOP/COEP; issue #45 moved to a discussion unresolved [29].
- **Single-threaded web path** passes worker results as transferable
  buffers, switched to flatbuffers schemas after a regression; SDF text was
  missing until `symbol_layer_tessellated.fbs` was added [30].

## MLT (maplibre-tile-spec)

- **Columnar vectors** (flat, constant, sequence, dictionary, FSST, REE),
  null bitmaps, 64-byte aligned buffers: fewer allocations and less GC.
  Random access into delta-encoded values is unsolved [31].
- **mlt-wasm `decodeTileColumns`** returns typed arrays per layer: a
  1.3 MB tile with 524,482 vertices in about 3.8 ms, per-vertex line id fill
  about 0.2 ms (Node, one machine). 64-bit ints come back as Float64Array
  [32].
- **Reuse codecs and buffers per thread.** FastPFOR codec instances (about
  1 MB working buffers, not thread-safe) cached per thread: planet z0-7
  conversion 53.3 s to 22.2 s; reused geometry Vecs: iteration 21-34%
  faster [33].

## navara

- **One font worker** for shaping and SDF atlas packing, registered with a
  shared ConcurrencyManager so libraries cannot overfill the pool; one
  thread because font data cannot be shared. The first version flickered
  more and broke outline width. Merging it into the general worker was
  tried and reverted; atlas desync after eviction followed (#623) [34].
- **Fresh WASM memory views** after allocation, no intermediate JS copy;
  explicit `free` on wasm-bindgen objects [35].

## RustGIS

- **Sans-IO remote byte store.** Reads record missing ranges; `drive()`
  fetches them in rounds and reruns the read, so one parser runs natively
  and in wasm. Misses tagged per drive so concurrent reads do not take each
  other's; saturating arithmetic against hostile offsets [36].
- **One read in flight per streamed layer**, window padded by half a view,
  on a background thread natively (waker + generation counter) and in place
  in the browser; a failed thread start is not retried every frame [37].
- **Picture renderer abandoned** for prepare-once tiles with a worker pool
  for fetch, decode, MVT and tessellation; a debounce PR left throughput
  unchanged (5,804 vs 5,802 ms) [38].
- **createImageBitmap** instead of 20-30 ms wasm decode per tile; GPU
  buffers destroyed explicitly because wgpu's Drop is a no-op on WebGPU
  (VK_ERROR_OUT_OF_DEVICE_MEMORY) [39].

## reearth-papers

- **Render permits per isolate** (4, then 8) bound resident tile data,
  though rendering is synchronous. Unbounded: RangeError in 2-3 of 12 above
  six parallel. A resolver queue made workerd cancel 8 of 12 concurrent
  requests as hung, so waiters poll every 10 ms under a 20 s budget. 12
  concurrent renders peak at 28 MB after subsetting [40].

## CesiumGS/cesium

- **ImageBitmap default (1.56) reverted to opt-in (1.56.1)**: faster upload
  and fewer frame drops, but no flip during upload; later HTTP 204 blocking
  (#7914), glTF blend modes (#7795), images decoded on the main thread with
  `preferImageBitmap` (#9627), an options update reverted for older
  browsers (#12846) [41].
- **Bundle size.** Worker bundle 8,384 KB (2,624 KB gzip) to 863 KB
  (225 KB gzip) in 1.63; rollup with shared chunks, CI 17 to 11 min [42].
  The 712 KB Draco decoder loaded only in a worker; bundling it had raised
  gzipped Cesium.js from 722 KB to 865 KB (18%) [43]. Workers inlined into
  the single-file build, removing RequireJS and a 2,290-line bootstrapper,
  fixing cross-origin loading (#11505) [44].
- **WASM decoders (meshopt, SPZ, Draco, KTX2) in workers** with
  transferable ArrayBuffers, not SharedArrayBuffer (needs isolation).
  Main-thread busy time 4-33% lower, ready time 3% faster to 22% slower,
  judged noise after A/A runs; splitting TaskProcessor in two was abandoned.
  Gaussian splat rebuilds then stormed (one full re-upload per arriving
  tile) and were debounced with a deadline [45].
- **Terrain pick index** built lazily per picked tile in a worker task,
  octree changed to quadtree; default pick used meanwhile [46].
- **Request scheduler reversal.** Terrain and imagery left the global
  distance-sorted scheduler: a closure per tile and a sort every frame, and
  unimportant tiles loaded first; cancelled requests 755 to 0 in the Grand
  Canyon view [47].

## deck.gl / loaders.gl

- **Binary MVT with triangulation in the loader worker**: 2.86 to 5.57
  and 8.45 to 20.3 tiles/s; Census tracts (988K vertices) 6,242 to
  2,713 ms, block groups (1.57M) 9,202 to 4,261 ms, 12K vertices only -13%.
  A second deck.gl worker was rejected (data crosses twice); the worker must
  know the projection choice [48].
- **Off-thread attribute generation deferred**: updates got slower through
  message exchange and composite layers could not use it. Motivation:
  `JSON.parse` of 50M points froze the UI for seconds [49].
- **MVT decode to flat arrays** via a pre-built loaders.gl worker;
  webworkify-webpack rejected as bundler-specific [50]. CARTO loaders set
  `worker: true` once workers were on the CDN [51]. Worker-only loaders
  fetch their code from unpkg by default; `worker: false` for debugging
  [52].
- **Polyline-encoded demo points decoded in a worker**: 2,921,529 to
  617,521 bytes, about 1 m quantisation [53].

## ortho-earth

- **GPU share 3-6%** of a tile conversion; CPU and GPU paths integer-exact
  and byte-identical [54]. **Typed-array attribute table**: worker start-up
  for 1M features 16 s to 1.6 s; CompressionStream writer/reader about 4x
  cheaper per tile than Blob to Response; countries z0-10 5.3-5.9 s with 4
  workers vs 16-18 s single-threaded; byte-identical at any worker count
  [54].
- **WASM only where measured**: not for the frame loop, tile merge or
  per-polygon earcut; yes for GeoJSON-to-topology (12.3 s on 15.67M
  vertices, 55% BigInt Map dedup) [55].
- **SharedArrayBuffer optional**: copy once without isolation;
  `verify:nocoi` runs 7 pages with isolation off and asserts the fallback
  ran; Safari never isolates with COEP credentialless [56].
- **One worker entry, role by `name`**: worker builds 34 to 2, duplicated
  bytes 2.74 MB (57%) to 177 KB, total JS 4.81 MB to 1.72 MB raw; vite 5
  `plugins` do not apply to worker builds. **Nested workers** hung in some
  environments (in-app 3/3, headless 1/3-1/5); main now creates the decoder
  and passes a MessagePort; a standing live-decode test was added [57].
- **Overlays inside the render worker's frame**, drawn to a second
  OffscreenCanvas: pins no longer trail the globe by 1-2 frames [58].
- **Sun shadow and viewshed on a worker grid**, shown as a raster: works on
  WebGPU and GL2, grid-limited (about 13 m cells at 5 km) [59].
- **Range reads and IndexedDB cache in a worker**: a second session made 2
  Range requests (64 KB) instead of 32 (7.1 MB); await the put before
  transferring [60].
- **COPC: three reader workers reverted** (network-bound) [61].
  **Persistent pool**: at most 2 lanes per kind, 45 s idle shutdown;
  revisit 4.2 s to 0.5 s [62].

## QGIS

- **Fine-grained cancellation in PAL** (#32489) [63]. **Per-layer cache
  images kept from cancelled jobs**, keyed by their exact extent and
  map-to-pixel [64]. **Image caches detach QPicture copies** (concurrent
  rendering crashed, #17089); mtime check throttled to 30 s [65].
- **OGR connection pool keeps refcounts** so render threads' feature-source
  snapshots release file handles when rendering ends; the pool alone closes
  idle handles only after 60 s, locking files on Windows [66].
- **Parallel per-layer rendering** (2013, default 2016, server 2017) and its
  races: SVG cache, static QRegExp, spatialite pool, shared QPicture [67].
  **Image clear moved to the render thread**: about 40% of job setup [68].
- **Tile export**: encoding in a pool, one MBTiles writer thread; 75,560
  tiles PNG 268 s to 21 s, JPG 154 s to 21 s [69].

## GRASS GIS

- **r.proj**: a precomputed input-row footprint table replaced run-time
  band sizing (about 1.0-1.3 s to under 0.01 s); threads share a read-only
  strip and the previous band is written while the next is computed:
  4.56x at 8 threads, output identical to serial; input reading stays
  serial and limits hard projections. Block starts at
  floor(b * ocols / nb) [70].
- **Shared MASK** read through one file descriptor with a global cursor:
  decompression errors and segfaults with nprocs > 1; parallelism disabled
  with a mask [71]. r.mapcalc also falls back to serial with a mask or
  `rand()` [72].
- **Banding with halos**: r.param.scale 203 s to 44.1 s on 8 threads
  (4.60x), output identical [73]; r.geomorphon 5.3x on 8 [74].
- **Thread defaults**: workers added in 2008, default set to zero in 2015
  after a raster3d tile-cache error [75]; OpenMP nprocs default changed to
  all cores, tests force one thread, nested callers pass nprocs=1; a CMake
  bug compiled lib/gis without OpenMP [76]. nprocs resolved by a helper in
  each C tool: 0 means all, -1 all but one [77].
- **Shared state**: per-cell write to a shared FP flag killed scaling [78];
  atomic CAS RNG 50-55% slower at 4-16 threads (mutex gated on a flag the
  default build never defined) [79]; atomic accumulation fixed 12-14% lost
  water at 6% single-thread cost [80]; hand-rounded chunks skipped items,
  e.g. 7 of 1,000,007 at 16 threads [81].

## KDE Marble

- **Plain sockets for the 1:N Tirex render-worker link** after Qt's UDP
  code could reach only one backend [82]. **Last band takes the
  remainder** in threaded texture mapping [83]. **Mutex around o5mreader**,
  which uses static locals [84].

## OpenLayers

- **WebGL vector**: geometries bucketed by type, buffers built in a worker,
  three draw calls per tile [85]. **Raster source** runs per-pixel
  operations in a worker and ships no algorithms [86].
- **Points renderer**: transferable instructions in, vertex and index
  buffers out, with the transform current at request time; hit detection
  skipped when out of sync [87].
- **GeoTIFF decoding in a lazily created worker pool**, data tiles not
  interpolated by default [88]. **Text overlay**: Canvas2D labels drawn in
  a worker on an OffscreenCanvas, composited as a post-process; flashing,
  double rotation and a listener leak followed [89]. **Lazy worker
  creation** [90].

## Tangram JS

- **20 ms per-frame task budget** for main-thread work, skippable while the
  view moves [91]. **Tile slice** returned to the main thread; selection ids
  embed the worker id [92].
- **Two-pass Rollup, Blob URL worker**, shared code parsed twice, needs CSP
  allowance [93]; Rollup 2 upgrade reverted over the worker chunk [94].
- **Per-source collision in workers** could not see other sources; pooled
  in v0.15 [95]; later a worker pass plus a main-thread global pass [96].
- **Stringified messages** adopted (2016) and removed (2017) [97].
  **Random worker assignment** reverted; tiles pinned by coordinate,
  non-tiled sources on one worker [98]. **Mesh groups sent as they finish**
  [99]. **Edge/IE11 worker XHR proxied** through the main thread [100].
  **Allocation cuts** in the build path, no timings given [101].
  **Source config snapshotted** before compilation, so unchanged sources
  keep their tile cache [102].

## Tangram ES

- **Tile objects hold only render data**; an empty result must be a
  terminal state or the loop never idles [103]. **Scene IDs** with one
  listener [104]. **Source generation** instead of stale flags [105].
  **Workers never block** on raster dependencies; network threads separate
  [106]. **GL deletions batched** on the render thread [107].

## Sources

1. https://github.com/maplibre/maplibre-gl-js (`ref-repos/maplibre__maplibre-gl-js/developer-guides/life-of-a-tile.md`, `ref-repos/maplibre__maplibre-gl-js/ARCHITECTURE.md`), https://github.com/mapbox/mapbox-gl-js/pull/7124
2. https://github.com/maplibre/maplibre-gl-js/commit/58a61d625
3. https://github.com/maplibre/maplibre-gl-js/commit/ae427dc27, `ref-repos/maplibre__maplibre-gl-js/src/util/worker_pool.ts`
4. https://github.com/maplibre/maplibre-gl-js/pull/8491, https://github.com/maplibre/maplibre-gl-js/issues/8461
5. https://github.com/maplibre/maplibre-gl-js/pull/6254
6. https://github.com/maplibre/maplibre-gl-js/commit/c465272a3, https://github.com/maplibre/maplibre-gl-js/commit/0310542cd, https://github.com/maplibre/maplibre-gl-js/commit/e2dce3ba4
7. `ref-repos/maplibre__maplibre-gl-js/CHANGELOG.md`, https://github.com/mapbox/mapbox-gl-js/pull/9003, https://github.com/maplibre/maplibre-gl-js/pull/3225
8. https://github.com/maplibre/maplibre-gl-js/commit/11c8bb562, https://github.com/maplibre/maplibre-gl-js/commit/7b638de40
9. https://github.com/maplibre/maplibre-gl-js/commit/aef24c139, https://github.com/maplibre/maplibre-gl-js/commit/8a7bbd2df, https://github.com/maplibre/maplibre-gl-js/commit/8adbbdac4, https://github.com/maplibre/maplibre-gl-js/commit/d8f467ddb
10. https://github.com/maplibre/maplibre-gl-js/pull/1605, https://github.com/maplibre/maplibre-gl-js/pull/6562
11. https://github.com/maplibre/maplibre-gl-js/pull/6668, https://github.com/maplibre/maplibre-gl-js/issues/4364
12. https://github.com/maplibre/maplibre-gl-js/commit/ad813fad1, https://github.com/maplibre/maplibre-gl-js/commit/a30582601, https://github.com/maplibre/maplibre-gl-js/commit/c842c3bd6
13. https://github.com/maplibre/maplibre-gl-js/commit/fa95c19c0, https://github.com/maplibre/maplibre-gl-js/commit/725f2666b, https://github.com/maplibre/maplibre-gl-js/commit/e5497caf1
14. https://github.com/maplibre/maplibre-gl-js/commit/b5c90201d
15. https://github.com/maplibre/maplibre-gl-js/commit/1d3d433d9, https://github.com/maplibre/maplibre-gl-js/commit/368a604f1, https://github.com/maplibre/maplibre-gl-js/commit/95c703172
16. https://github.com/maplibre/maplibre-gl-js/pull/6803, https://github.com/maplibre/vt-pbf/pull/16
17. https://github.com/maplibre/maplibre-gl-js/pull/8738, https://github.com/maplibre/maplibre-gl-js/issues/168
18. https://github.com/maplibre/maplibre-gl-js/commit/135561825, https://github.com/maplibre/maplibre-gl-js/commit/aefb3ee1f, https://github.com/maplibre/maplibre-gl-js/commit/a1afdd253
19. https://github.com/maplibre/maplibre-gl-js/commit/726af278a
20. https://github.com/maplibre/maplibre-gl-js/commit/7351d2fbf
21. https://github.com/maplibre/maplibre-gl-js/commit/85517f056, https://github.com/maplibre/maplibre-gl-js/commit/c0f06f26e, https://github.com/maplibre/maplibre-gl-js/commit/f8830012a
22. `ref-repos/maplibre__maplibre-native/docs/mdbook/src/design/geometry-tile-worker.md`
23. `ref-repos/maplibre__maplibre-native/ARCHITECTURE.md`, `ref-repos/maplibre__maplibre-native/platform/android/CHANGELOG.md`
24. https://github.com/maplibre/maplibre-native/commit/41bbd4e4f, https://github.com/maplibre/maplibre-native/commit/204c7fee0, https://github.com/maplibre/maplibre-native/commit/27d8e82e1
25. https://github.com/maplibre/maplibre-native/commit/e2f52a1dd
26. https://github.com/maplibre/maplibre-native/commit/c0cb210dd, https://github.com/maplibre/maplibre-native/commit/4c6f0e813, https://github.com/maplibre/maplibre-native/commit/18d735ccc, https://github.com/maplibre/maplibre-native/commit/31f0f4719, https://github.com/maplibre/maplibre-native/commit/ff58848cf
27. https://github.com/maplibre/maplibre-native/pull/3968
28. https://github.com/maplibre/maplibre-rs/blob/main/docs/src/supported-platforms.md, `ref-repos/maplibre__maplibre-rs/docs/src/development-documents/architecture.md`, `ref-repos/maplibre__maplibre-rs/docs/src/development-documents/library-packaging/web.md`
29. https://github.com/maplibre/maplibre-rs/issues/45
30. https://github.com/maplibre/maplibre-rs/commit/7dc7346, https://github.com/maplibre/maplibre-rs/commit/2696d81, https://github.com/maplibre/maplibre-rs/commit/9496ef0, https://github.com/maplibre/maplibre-rs/commit/b7e4c27
31. https://github.com/maplibre/maplibre-tile-spec/blob/main/docs/implementation-guide.md, `ref-repos/maplibre__maplibre-tile-spec/docs/implementation-guide.md`
32. https://github.com/maplibre/maplibre-tile-spec/blob/main/rust/mlt-wasm/README.md, `ref-repos/maplibre__maplibre-tile-spec/rust/mlt-wasm/README.md`
33. https://github.com/yuiseki/maplibre-tile-spec/commit/9b126a1f, https://github.com/yuiseki/maplibre-tile-spec/commit/65488108, https://github.com/yuiseki/maplibre-tile-spec/commit/e77db675
34. https://github.com/maplibre/navara/pull/464, https://github.com/maplibre/navara/commit/04a7e1f7, https://github.com/maplibre/navara/commit/d0b0d573
35. https://github.com/maplibre/navara/commit/268b8aab, https://github.com/maplibre/navara/commit/4af8b7b0, https://github.com/maplibre/navara/commit/6087f0c1
36. https://github.com/opengeos/RustGIS/commit/564f953, https://github.com/opengeos/RustGIS/pull/152, `ref-repos/opengeos__RustGIS/crates/data`
37. https://github.com/opengeos/RustGIS/commit/d053cf3, `ref-repos/opengeos__RustGIS/docs/user-guide/data.md`
38. https://github.com/opengeos/RustGIS/issues/635, https://github.com/opengeos/RustGIS/pull/548
39. https://github.com/opengeos/RustGIS/pull/630, https://github.com/opengeos/RustGIS/commit/f8f84ac
40. https://github.com/reearth/reearth-papers/commit/2007668, https://github.com/reearth/reearth-papers/commit/eabf229, `ref-repos/reearth__reearth-papers/CONTRIBUTING.md`
41. `ref-repos/CesiumGS__cesium/CHANGES.md`, https://github.com/CesiumGS/cesium/pull/7579, https://github.com/CesiumGS/cesium/pull/9627, https://github.com/CesiumGS/cesium/pull/7914, https://github.com/CesiumGS/cesium/issues/12846
42. `ref-repos/CesiumGS__cesium/CHANGES.md`, https://github.com/CesiumGS/cesium/pull/7140, https://github.com/CesiumGS/cesium/pull/10399, https://github.com/CesiumGS/cesium/commit/aabd27a76, https://github.com/CesiumGS/cesium/pull/8224
43. https://github.com/CesiumGS/cesium/pull/6191
44. https://github.com/CesiumGS/cesium/commit/07b105ca2b448643db5c2914a37a1583cc94440e, https://github.com/CesiumGS/cesium/commit/18e18021ee46dbf89526921038c34b2e89d0e8f3
45. https://github.com/CesiumGS/cesium/pull/13669
46. https://github.com/CesiumGS/cesium/commit/53fa96bf858d13a2c2b0b054c775459d9346cdc1, https://github.com/CesiumGS/cesium/commit/1e8d248e34cc84a11aa512e2a09321c59cff1b39, https://github.com/CesiumGS/cesium/commit/debd74eb915aed2d3e09eb73a991f4c2c9f907e1
47. https://github.com/CesiumGS/cesium/pull/7061, https://github.com/CesiumGS/cesium/pull/3476
48. https://github.com/visgl/deck.gl/blob/master/dev-docs/RFCs/proposals/loader-worker-triangulation.md, `ref-repos/visgl__deck.gl/dev-docs/RFCs/proposals/loader-worker-triangulation.md`, https://github.com/visgl/deck.gl/blob/master/docs/whats-new.md, https://github.com/visgl/deck.gl/commit/bacb7c24, https://github.com/visgl/deck.gl/commit/0275d745, https://github.com/visgl/deck.gl/commit/8746716d
49. https://github.com/visgl/deck.gl/blob/master/dev-docs/RFCs/proposals/off-thread-attribute-generation-rfc.md, `ref-repos/visgl__deck.gl/dev-docs/RFCs/proposals/off-thread-attribute-generation-rfc.md`
50. https://github.com/visgl/deck.gl/pull/3935, https://github.com/uber-web/loaders.gl/issues/685
51. https://github.com/visgl/deck.gl/commit/2c31fb13, https://github.com/visgl/deck.gl/commit/7643eea0
52. https://github.com/visgl/deck.gl/commit/8d824a4b
53. https://github.com/visgl/deck.gl/commit/47b372b9
54. https://github.com/kenjiyoshidahome2026-bit/ortho-earth/blob/main/packages/geopbf/README.md, `ref-repos/kenjiyoshidahome2026-bit__ortho-earth/packages/geopbf/README.md`
55. https://github.com/kenjiyoshidahome2026-bit/ortho-earth/blob/main/packages/ortho-core/perf%20survey.md, `ref-repos/kenjiyoshidahome2026-bit__ortho-earth/packages/ortho-core/perf survey.md`, `ref-repos/kenjiyoshidahome2026-bit__ortho-earth/packages/ortho-core/perf plan.md`
56. https://github.com/kenjiyoshidahome2026-bit/ortho-earth/blob/main/packages/ortho-core/fallback-ladder.md, `ref-repos/kenjiyoshidahome2026-bit__ortho-earth/packages/ortho-core/fallback-ladder.md`
57. https://github.com/kenjiyoshidahome2026-bit/ortho-earth/issues/12
58. https://github.com/kenjiyoshidahome2026-bit/ortho-earth/issues/13
59. https://github.com/kenjiyoshidahome2026-bit/ortho-earth/issues/44
60. https://github.com/kenjiyoshidahome2026-bit/ortho-earth/commit/c5492461
61. https://github.com/kenjiyoshidahome2026-bit/ortho-earth/commit/93720c28, https://github.com/kenjiyoshidahome2026-bit/ortho-earth/commit/7ca1bba5
62. https://github.com/kenjiyoshidahome2026-bit/ortho-earth/commit/103b127e, https://github.com/kenjiyoshidahome2026-bit/ortho-earth/commit/b036443d
63. `ref-repos/qgis__QGIS/ChangeLog` (2019-11-29 [pal] more exit points), https://github.com/qgis/QGIS/issues/32489
64. `ref-repos/qgis__QGIS/ChangeLog` (2021-01-28 store cached layer results per job; explicit extent and map to pixel for cache image)
65. `ref-repos/qgis__QGIS/ChangeLog` (2017-10-31 concurrent rendering of cached QPictures; svg mtime check; 2018-12-03 QgsImageCache)
66. https://github.com/qgis/QGIS/pull/2755, https://github.com/qgis/QGIS/pull/2197
67. https://github.com/qgis/QGIS/commit/9a4f326ae3, https://github.com/qgis/QGIS/commit/a3af3fc41e, https://github.com/qgis/QGIS/commit/a6eea7205c, https://github.com/qgis/QGIS/commit/dd739ef736
68. https://github.com/qgis/QGIS/commit/022e228522
69. https://github.com/qgis/QGIS/commit/6439498f90
70. https://github.com/OSGeo/grass/pull/7807
71. https://github.com/OSGeo/grass/issues/2809, https://github.com/OSGeo/grass/pull/2829
72. https://github.com/OSGeo/grass/commit/d5c51924e
73. https://github.com/OSGeo/grass/pull/7440
74. https://github.com/OSGeo/grass/commit/251d7f0d9, https://github.com/OSGeo/grass/commit/c80cbf1f6, https://github.com/OSGeo/grass/commit/935447215
75. https://github.com/OSGeo/grass/commit/0fb91788d, https://github.com/OSGeo/grass/commit/3d1354013, https://github.com/OSGeo/grass/commit/3500fb0a8
76. https://github.com/OSGeo/grass/pull/5731, https://github.com/OSGeo/grass/commit/110ff3393, https://github.com/OSGeo/grass/commit/9a61f34e0, https://github.com/OSGeo/grass/commit/0b4a96034
77. https://github.com/OSGeo/grass/pull/3929
78. https://github.com/OSGeo/grass/commit/bf7d8b6f5
79. https://github.com/OSGeo/grass/pull/6480, https://github.com/OSGeo/grass/commit/c83afef6d, https://github.com/OSGeo/grass/commit/becef3d05
80. https://github.com/OSGeo/grass/commit/1f83c2d27
81. https://github.com/OSGeo/grass/commit/9843891c6, https://github.com/OSGeo/grass/commit/2e636fb7a
82. https://github.com/KDE/marble/commit/ce155a1a8, https://github.com/KDE/marble/commit/e5de77084
83. https://github.com/KDE/marble/commit/166159644
84. https://github.com/KDE/marble/commit/28f9362ea, https://github.com/KDE/marble/commit/5598411f1
85. https://github.com/openlayers/openlayers/pull/13461
86. https://github.com/openlayers/openlayers/pull/3214
87. https://github.com/openlayers/openlayers/commit/65be90709, https://github.com/openlayers/openlayers/commit/732b383b5, https://github.com/openlayers/openlayers/commit/5c1191dd5
88. https://github.com/openlayers/openlayers/commit/8d8632bff, https://github.com/openlayers/openlayers/commit/05eac3e38, https://github.com/openlayers/openlayers/commit/59186f2af, `ref-repos/openlayers__openlayers/changelog/upgrade-notes.md`
89. https://github.com/openlayers/openlayers/commit/820299685, https://github.com/openlayers/openlayers/commit/650177ffb, https://github.com/openlayers/openlayers/commit/1bbd138fb, https://github.com/openlayers/openlayers/commit/dd163f53c, https://github.com/openlayers/openlayers/commit/ce2d95ee8
90. https://github.com/openlayers/openlayers/commit/2f7a891b9, https://github.com/openlayers/openlayers/commit/ce2d95ee8
91. https://github.com/tangrams/tangram/blob/master/src/utils/task.js, `ref-repos/tangrams__tangram/src/utils/task.js`
92. https://github.com/tangrams/tangram/blob/master/src/tile/tile.js, `ref-repos/tangrams__tangram/src/tile/tile.js`, https://github.com/tangrams/tangram/blob/master/src/selection/selection.js
93. https://github.com/tangrams/tangram/blob/master/rollup.config.mjs, `ref-repos/tangrams__tangram/rollup.config.mjs`, https://github.com/tangrams/tangram/blob/master/build/intro.js, https://github.com/tangrams/tangram/blob/master/build/bundle.mjs
94. https://github.com/tangrams/tangram/commit/b6405e71, https://github.com/tangrams/tangram/commit/b121e882, https://github.com/tangrams/tangram/commit/81ee5a1d, https://github.com/tangrams/tangram/commit/2373ba0e
95. https://github.com/tangrams/tangram/issues/365, https://github.com/tangrams/tangram/pull/222
96. https://github.com/tangrams/tangram/commit/d4d4606c, https://github.com/tangrams/tangram/commit/8ff7ca80, https://github.com/tangrams/tangram/commit/3f50d8c9, https://github.com/tangrams/tangram/commit/8bafa724, https://github.com/tangrams/tangram/commit/1506a583
97. https://github.com/tangrams/tangram/commit/3d874d22, https://github.com/tangrams/tangram/commit/1621da0c, https://github.com/tangrams/tangram/commit/8d49f81a
98. https://github.com/tangrams/tangram/commit/8a4eb885, https://github.com/tangrams/tangram/commit/311fd022, https://github.com/tangrams/tangram/commit/7a4c4792, https://github.com/tangrams/tangram/commit/b4f51205
99. https://github.com/tangrams/tangram/commit/cf1c3e6b
100. https://github.com/tangrams/tangram/commit/659fe6c2, https://github.com/tangrams/tangram/commit/bcb1ee70
101. https://github.com/tangrams/tangram/commit/af89f8e3, https://github.com/tangrams/tangram/commit/f4905ff3, https://github.com/tangrams/tangram/commit/ee9a0e54, https://github.com/tangrams/tangram/commit/5ae018d0, https://github.com/tangrams/tangram/commit/e2f0ab9e, https://github.com/tangrams/tangram/commit/e0e99e65, https://github.com/tangrams/tangram/commit/c5cb938e
102. https://github.com/tangrams/tangram/commit/8f1bf8f074ade1644c2a2d7218f2831a34e4676c, `ref-repos/tangrams__tangram/src/scene/scene_worker.js`
103. https://github.com/tangrams/tangram-es/pull/436
104. https://github.com/tangrams/tangram-es/pull/1526
105. https://github.com/tangrams/tangram-es/pull/400
106. https://github.com/tangrams/tangram-es/commit/ea75fe42, https://github.com/tangrams/tangram-es/commit/d5db23bf, https://github.com/tangrams/tangram-es/commit/d544e564, https://github.com/tangrams/tangram-es/commit/4978e633, https://github.com/tangrams/tangram-es/commit/3966cfaf, https://github.com/tangrams/tangram-es/commit/c3230792
107. https://github.com/tangrams/tangram-es/commit/ff7aebda
