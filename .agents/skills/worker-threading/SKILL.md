---
name: worker-threading
description: When map engines move work off the main or render thread (Web Workers, OffscreenCanvas, WASM threads, native thread pools), what they send across, how they size, start, cancel and recover workers, and what they reverted, distilled for a map-from-scratch renderer. Load it before adding a Worker, worker_threads, SharedArrayBuffer or a thread pool to a renderer or to bake.ts, when data must be decoded, triangulated or laid out at run time, when a bench shows main-thread jank during loading, or when a worker path misbehaves (a blank map on GitHub Pages, memory growth, stale or lost results, output that changes with the thread count).
---

# Worker threading: what to move off the main thread, and what it costs

A worker keeps the frame loop free while data is decoded, triangulated or
laid out, but every engine that adopted workers then paid for them: transfer
and message round trips, worker start-up and duplicated bundle code,
cancellation and stale-result bugs, browser-specific leaks, and, with
SharedArrayBuffer, a requirement on the host's HTTP headers. The 37 engines
behind this skill also show the opposite case: work that moved back to the
main thread, worker pools cut to one, and decode workers reverted because the
network, not the CPU, was the bottleneck. The map-from-scratch rule is to do
the work at bake time, so the renderer receives data laid out for exactly
what it draws, and no example so far uses a worker [2]. Load this skill when
that stops being enough. Per-engine detail, with more numbers, is in
[references/engines.md](references/engines.md). Neighbouring skills:
`tile-cache-and-loading` (scheduling, cancellation and caches),
`data-range-requests` (Range reads), `label-placement` (where collision
runs), `polygon-triangulation`, `raster-tiles` (image decoding) and
`text-rendering` (font workers), `startup-and-bundle-size` (worker bundle
bytes) and `mobile-and-power` (workers killed on iOS).

## First: is there work left for a worker?

Every engine record that recommends workers adds "unless the data is baked".
Check these before writing one:

- **The data is baked and loaded whole.** The renderer only uploads buffers
  and draws. A worker adds start-up and a copy and removes nothing. MapLibre
  GL JS itself defaults to one worker on every browser but Safari, after A/B
  testing, where it used to start up to six [5]. deck.gl deferred its RFC to
  build layer attributes in a worker: review found updates could be slower
  because of the message exchange, and it did not work for composite layers
  such as GeoJsonLayer [6].
- **Worker start-up can exceed the work.** In ortho-earth the first decode
  call was dominated by worker module evaluation, 1,538 ms, against
  26 + 20 ms to parse on the main thread [7]. Cesium's move of WASM decoders
  into workers cost tens of milliseconds of cold start on first use [8].
- **Measure where the time goes first.** ortho-earth reverted three COPC
  reader workers because reading waited on the network (settling varied
  2.4-4.0 s with the network; decode of 43 nodes took 1.4 s in total) [9].
  Its GPU-capable stages were 3-6% of a tile conversion, so moving them
  helped little [10]. QGIS found that PNG encoding, not rendering,
  dominated tile export (268 s to 21 s once encoding moved to a pool) [11].
- **Image decoding needs no worker of your own.** `createImageBitmap` lets
  the browser decode off the main thread. RustGIS's 20-30 ms wasm decode per
  tile vanished from browser profiles when it switched [12]. Cesium 1.56
  made ImageBitmap the default; 1.56.1, the next day, went back to Image
  and made ImageBitmap opt-in, noting that an ImageBitmap cannot be flipped
  during texture upload [13]. See `raster-tiles`.

Run-time work that does justify a worker: decoding and triangulating large
streamed data (MVT, MLT, GeoParquet, LAZ) [14][15], per-pixel raster
operations [16], text shaping with fonts unknown at bake time [17], and live
data that changes faster than the main thread can re-index it [18].

## What goes to the worker, and what stays

- **Do the heavy one-shot work in the thread that already parses the data.**
  deck.gl moved earcut into the loaders.gl worker that parses MVT, rather
  than a second deck.gl worker, which would have moved the data across
  threads twice. Binary MVT parsing was 1.9-2.4x faster in tiles/s, and a
  full-viewport load of 988K vertices fell from 6,242 ms to 2,713 ms; a 12K
  vertex set gained only 13% [14]. The RFC warns that for other loaders the
  transfer may cost more than the work saved [14].
- **The main thread uploads and draws.** MapLibre GL JS fetches, decodes,
  builds buckets, indexes features and lays out symbols in workers, and
  uploads vertex buffers lazily on the main thread [19].
- **Global decisions come back to the main thread.** MapLibre GL JS and
  Native moved label collision out of per-tile worker jobs into one
  viewport-wide index on the main or render thread, after a series of
  perspective workarounds in the worker [20][21]. Tangram JS split it: a
  per-tile pass in the worker, a global pass on the main thread fed only a
  box and a buffer range per label [22]. See `label-placement`.
- **Small per-frame updates stay where the frame is drawn.** MapLibre
  Native added a per-source `synchronousUpdate` so a location marker that
  changes every frame does not lag a frame behind, and limits it to small
  data [23]. OpenLayers' worker-built point buffers lag the view, so each
  result carries the transform it was built with and hit detection is
  skipped while out of sync [24].
- **If you draw in a worker (OffscreenCanvas), draw everything there.**
  ortho-earth's overlays drawn on the main thread with the current camera
  ran 1-2 frames ahead of the worker-rendered globe; drawing them in the
  worker's requestAnimationFrame removed the lead [25].

## What crosses the boundary

- **Flat typed arrays, transferred.** MapLibre GL JS stores collision boxes
  in a StructArray: about 500 KB less memory per tile, about 60% faster
  creation, and transferable [26]. ortho-earth sends attributes as one
  typed-array table with dictionaries; worker start-up for 1,000,000
  features fell from 16 s to 1.6 s [10]. deck.gl calls the many small JS
  arrays of GeoJSON-shaped output "very slow" [27]. MLT's wasm decoder hands
  over whole columns: 524,482 vertices decoded in about 3.8 ms [15].
- **A transferred buffer is gone from the sender.** Copy deliberately what
  both sides need; MapLibre copies the raw tile data for that reason [28].
  ortho-earth stored detached, empty buffers in IndexedDB until it awaited
  the write before transferring [29].
- **Send only what the receiver needs, and only deltas.** Tangram posts back
  a whitelisted slice of the tile; feature geometry stays in the worker [30].
  MapLibre stopped sending the whole GeoJSON back after each update and
  applies the same diff on the main thread: 33.3 ms to 16.7 ms on its bench,
  at the price of two copies kept in sync [31].
- **Post setup data to the worker first, then process it locally.**
  MapLibre sends style layers to the worker before processing them on the
  main thread, so both work in parallel [32].
- **Do not stringify messages.** Tangram JSON-stringified worker messages on
  the strength of a 2016 benchmark and removed it because the gain was
  inconclusive on current browsers [33].
- **A transfer format borrowed from a tile spec imposes its value model.**
  MapLibre serialises worker-built GeoJSON tiles as MVT; undefined property
  values broke the encoder, and nested objects cannot be carried at all
  [34]. Your own format between your own threads can match your data.
- **WASM memory views go stale.** navara re-takes `memory.buffer` views
  after any call that can grow WASM memory instead of holding one [35].
- **Test long sessions on Safari.** Mapbox GL disabled Transferables on
  Safari for unbounded memory growth; MapLibre re-enabled them after Safari
  fixed the bug [36].

## SharedArrayBuffer: never required

SharedArrayBuffer needs cross-origin isolation (COOP and COEP headers on the
page). maplibre-rs's shared-memory web build does not work on Safari, hit
memory corruption with a parallel worker in Firefox, and errors without the
headers; a single-threaded path with transferred flatbuffers was added
beside it [37]. ortho-earth uses SharedArrayBuffer only as an optimisation:
without isolation it copies once, and a test runs seven pages with isolation
off and asserts that the fallback was used [38].

In this repository the trap is concrete. The harness server sends COOP and
COEP so that `performance.now()` has 5 us resolution [1], and
`bin/mfs bench <id> --site` serves the built Pages site through the same
server [3], but GitHub Pages sends neither header [2]. A path that needs
SharedArrayBuffer passes every bench and breaks for every visitor. If you
use it, add a switch that forces the fallback and a verification check that
fails unless the fallback ran.

## Pool size, start-up and lifetime

- **Start with zero or one worker.** MapLibre went from half the cores to
  half capped at 6, then to 1 except on Safari (half the cores, at most 3),
  which is still the default [5]. ortho-earth keeps a persistent pool per
  kind with at most 2 lanes, shut down after 45 s idle, instead of a worker
  per call [7].
- **Create workers lazily.** OpenLayers creates its buffer worker on first
  use [39]. Cesium loads its 712 KB Draco decoder only inside a worker when
  Draco data appears; bundling it had raised gzipped Cesium.js by 18% [40].
- **Assume the browser can kill a worker.** iOS Safari kills workers
  without notice; MapLibre pings them on each return to the foreground and
  rebuilds the pool and the style if they stay silent, and lets the pool
  drain when the last map is removed [41].
- **Cap in-flight work by memory, not cores.** reearth-papers caps
  concurrent renders per isolate although rendering is synchronous, to bound
  resident tile data; unbounded concurrency produced RangeErrors [42].

## Shipping the worker code

- **Make the worker URL explicit or inline it.** MapLibre v6 requires
  `setWorkerUrl` because guessing the path broke under bundlers; an app that
  forgets it draws only the background [43]. Cesium embedded its workers in
  the single-file build to fix cross-origin loading [44]; Tangram builds
  the worker from a Blob URL, which needs a CSP allowance [45].
- **One worker entry, not one per role.** Cesium's workers fell from 2.6 MB
  to 225 KB gzipped once shared code went into shared chunks [46].
  ortho-earth spawns one entry with the role in the Worker `name`;
  duplicated bytes fell from 2.74 MB to 177 KB [47].
- **Avoid nested workers.** In ortho-earth a worker spawned by a worker
  sometimes never ran (headless: 1 in 3 to 1 in 5 succeeded); the main
  thread now creates both and passes a MessagePort [47].
- **No CDN worker.** deck.gl loads its worker bundle from unpkg by default
  [48]; this repository allows no run-time external dependency [2].

Here: the harness server strips `.ts` and serves it as JavaScript [1], so
`new Worker(new URL('./worker.ts', import.meta.url), {type: 'module'})`
works under `bin/mfs bench`. `tools/build-site.ts` follows only `import` and
`from` specifiers and rewrites `.ts` to `.js` [49], so on Pages that worker
file is neither copied nor renamed. Either build the worker from a Blob of a
string in the main module, or extend `build-site.ts` (with a test) to follow
`new URL(…, import.meta.url)`. List the worker file in `chosen.code` [4].

## Scheduling: cancel, coalesce, version

- **A cancelled request must never call back, and must settle.** MapLibre
  nulls the callback before posting the cancel (unbounded memory growth in
  IE otherwise), rejects aborted promises with AbortError, and removes
  unloaded tiles from every worker; aborts "happen constantly during map
  movement" [50].
- **Latest wins.** MapLibre's GeoJSON worker and Native's geometry tile
  worker drop all but the newest pending job [18][51]. The first MapLibre
  version was reverted because dropped jobs never called back [18]. A later
  update queue chained every update and kept each one alive, so setData on
  every frame grew the heap until it ran out of memory [31].
- **Tag results with a generation.** tangram-es keeps old tiles visible and
  accepts a finished tile only if its source generation is newer. It first
  added "stale" and "updating" tile states ("updating" kept a stale tile
  already being rebuilt from being enqueued again), then replaced both with
  a per-tile source generation compared against the data source's [52].
- **Do not block a worker on a dependency.** tangram-es requeues a tile
  waiting for a raster instead of blocking the worker [53]. MapLibre batches
  glyph and icon requests to the main thread into 2 per tile [54].
- **Coalesce GPU rebuilds when results trickle in.** Once Cesium decoded
  splats in workers, tiles finished one per frame and each triggered a full
  re-upload; rebuilds are now debounced with a deadline [8].
- **Long jobs need fine-grained cancellation.** QGIS added exit points
  throughout label placement because cancelled renders kept burning
  threads [55].

## Threads in bake.ts and native renderers

Where the parallel work is a bake step (Node `worker_threads`) or a C
renderer, the failures are shared state:

- **Output must not depend on the thread count.** ortho-earth's converter
  writes byte-identical output at any worker count [10]; GRASS checks
  parallel modules against serial output [56]. Make it a verification check.
- **No hidden shared state.** GRASS threads read each other's rows through
  one shared mask file descriptor (fixed by going serial with a mask) [57];
  Marble wrapped a vendored decoder with static locals in a mutex [58]; a
  per-cell write of the same value to one shared flag stopped r.mapcalc from
  scaling [59]. Give each worker its own handle, buffers and seeded random
  stream; a shared atomic RNG was correct but 50-55% slower at 4-16
  threads [60].
- **Scatter into per-worker buffers.** Unsynchronised `+=` into a shared
  grid lost 12-14% of the total in GRASS r.sim; the atomic fix cost 6%
  single-threaded [61].
- **Split work so no item is lost.** A hand-rounded chunk size skipped up to
  (threads - 1) / 2 items per pass in r.sim, and Marble left an unpainted
  strip when the height did not divide by the thread count; test counts not
  divisible by the worker count [62].
- **Band large rasters with halos, bounded by memory.** GRASS r.param.scale
  reached 4.6x on 8 threads with per-thread ring buffers and output
  identical to serial [63]. Encode in a pool and write from one thread
  (QGIS, above [11]).
- **Default to all cores in a one-shot tool, pin inner tools to one thread
  when the caller already runs jobs in parallel** (GRASS) [64].

## Tried and reverted

| Change | What happened | Ref |
| --- | --- | --- |
| MapLibre: up to 6 workers | cut to 1 (Safari up to 3) after A/B testing | [5] |
| MapLibre: per-tile collision in workers | moved to one main-thread index | [20] |
| MapLibre: setData coalescing v1 | reverted (dropped callbacks), re-landed | [18] |
| Mapbox GL: no Transferables on Safari | re-enabled after Safari fixed the leak | [36] |
| Cesium: ImageBitmap by default (1.56) | back to Image, ImageBitmap opt-in, in 1.56.1 the next day | [13] |
| Tangram: JSON-stringified messages | removed, no measurable gain | [33] |
| Tangram: random tile-to-worker assignment | reverted to round robin; later each non-tiled source pinned to one worker | [65] |
| navara: font worker merged into the general worker | reverted | [17] |
| ortho-earth: three COPC reader workers | reverted, network-bound | [9] |
| ortho-earth: nested workers | main thread creates both, MessagePort | [47] |
| deck.gl: layer attributes built in a worker | RFC deferred | [6] |
| GRASS: worker threads on by default (2008) | default set to zero in 2015 | [66] |

## Guidance for a renderer here

1. Do the work at bake time and ship typed arrays laid out for the draw
   calls. Then there is nothing for a worker to do; write "no worker" and
   the reason in `architecture_selection.not_doing`.
2. Add a worker only for measured run-time work: a long task on the main
   thread during load or interaction, not a guess. Record the before and
   after in `performance_knowledge`.
3. Use one module worker, created on first need, doing decode and
   triangulation in one place, returning transferred typed arrays and
   nothing else. Keep global decisions (label collision, picking state) and
   per-frame updates on the main thread.
4. Every request carries an id and a generation; cancel drops the callback
   and settles the promise; pending jobs coalesce to the latest.
5. Never require SharedArrayBuffer. Make the worker load on Pages (Blob or
   `build-site.ts` support), and run the page once without COOP/COEP.
6. The harness's `requests`, `transfer_kb` and `js_heap_mb` come from the
   page target only, and only page exceptions end a run [67]. Count the
   worker's fetches yourself (as with `range_requests` [4]), watch
   `browser_rss_mb` for its memory, and forward worker errors to `emit`.
   Whether CPU throttling reaches the worker is not verified here; check it
   before trusting throttled numbers.
7. In `bake.ts`, parallel output must be byte-identical to serial, checked
   by a test that runs both.

## Sources

1. `harness/lib/serve.ts` (this repository)
2. `README.md` and `skills/map-from-scratch/SKILL.md` (this repository)
3. `harness/cli.ts` (this repository)
4. `skills/map-from-scratch/references/spec-yaml.md` (this repository)
5. MapLibre GL JS worker count: https://github.com/maplibre/maplibre-gl-js/commit/58a61d625, https://github.com/maplibre/maplibre-gl-js/commit/ae427dc27, `ref-repos/maplibre__maplibre-gl-js/src/util/worker_pool.ts`
6. deck.gl off-thread attribute generation RFC: https://github.com/visgl/deck.gl/blob/master/dev-docs/RFCs/proposals/off-thread-attribute-generation-rfc.md, `ref-repos/visgl__deck.gl/dev-docs/RFCs/proposals/off-thread-attribute-generation-rfc.md`
7. ortho-earth persistent pool: https://github.com/kenjiyoshidahome2026-bit/ortho-earth/commit/103b127e, https://github.com/kenjiyoshidahome2026-bit/ortho-earth/commit/b036443d
8. Cesium WASM decoders in workers and splat rebuild debounce: https://github.com/CesiumGS/cesium/pull/13669
9. ortho-earth COPC reader workers reverted: https://github.com/kenjiyoshidahome2026-bit/ortho-earth/commit/93720c28, https://github.com/kenjiyoshidahome2026-bit/ortho-earth/commit/7ca1bba5
10. ortho-earth geopbf: https://github.com/kenjiyoshidahome2026-bit/ortho-earth/blob/main/packages/geopbf/README.md, `ref-repos/kenjiyoshidahome2026-bit__ortho-earth/packages/geopbf/README.md`
11. QGIS tile encoding pool: https://github.com/qgis/QGIS/commit/6439498f90
12. RustGIS createImageBitmap: https://github.com/opengeos/RustGIS/pull/630, https://github.com/opengeos/RustGIS/commit/f8f84ac
13. Cesium ImageBitmap revert: `ref-repos/CesiumGS__cesium/CHANGES.md`, https://github.com/CesiumGS/cesium/pull/7579, https://github.com/CesiumGS/cesium/pull/9627, https://github.com/CesiumGS/cesium/issues/12846
14. deck.gl loader-worker triangulation: https://github.com/visgl/deck.gl/blob/master/dev-docs/RFCs/proposals/loader-worker-triangulation.md, `ref-repos/visgl__deck.gl/dev-docs/RFCs/proposals/loader-worker-triangulation.md`, https://github.com/visgl/deck.gl/blob/master/docs/whats-new.md, https://github.com/visgl/deck.gl/commit/bacb7c24, https://github.com/visgl/deck.gl/commit/0275d745, https://github.com/visgl/deck.gl/commit/8746716d
15. MLT columnar decoding: https://github.com/maplibre/maplibre-tile-spec/blob/main/rust/mlt-wasm/README.md, `ref-repos/yuiseki__maplibre-tile-spec/rust/mlt-wasm/README.md`, `ref-repos/yuiseki__maplibre-tile-spec/docs/implementation-guide.md`
16. OpenLayers raster source in a worker: https://github.com/openlayers/openlayers/pull/3214
17. navara font worker: https://github.com/maplibre/navara/pull/464, https://github.com/maplibre/navara/commit/04a7e1f7, https://github.com/maplibre/navara/commit/d0b0d573
18. MapLibre GL JS setData coalescing: https://github.com/maplibre/maplibre-gl-js/commit/fa95c19c0, https://github.com/maplibre/maplibre-gl-js/commit/725f2666b, https://github.com/maplibre/maplibre-gl-js/commit/e5497caf1
19. MapLibre GL JS worker pipeline: `ref-repos/maplibre__maplibre-gl-js/developer-guides/life-of-a-tile.md`, `ref-repos/maplibre__maplibre-gl-js/ARCHITECTURE.md`, https://github.com/mapbox/mapbox-gl-js/pull/7124
20. MapLibre GL JS global placement: https://github.com/maplibre/maplibre-gl-js/commit/135561825, https://github.com/maplibre/maplibre-gl-js/commit/aefb3ee1f, https://github.com/maplibre/maplibre-gl-js/commit/a1afdd253
21. MapLibre Native global placement: https://github.com/maplibre/maplibre-native/commit/c0cb210dd, https://github.com/maplibre/maplibre-native/commit/4c6f0e813, https://github.com/maplibre/maplibre-native/commit/18d735ccc
22. Tangram JS collision split: https://github.com/tangrams/tangram/commit/d4d4606c, https://github.com/tangrams/tangram/commit/8ff7ca80, https://github.com/tangrams/tangram/commit/3f50d8c9
23. MapLibre Native synchronousUpdate: https://github.com/maplibre/maplibre-native/pull/3968
24. OpenLayers worker-built point buffers: https://github.com/openlayers/openlayers/commit/65be90709, https://github.com/openlayers/openlayers/commit/732b383b5, https://github.com/openlayers/openlayers/commit/5c1191dd5
25. ortho-earth same-frame overlays: https://github.com/kenjiyoshidahome2026-bit/ortho-earth/issues/13
26. MapLibre GL JS StructArray: https://github.com/maplibre/maplibre-gl-js/commit/11c8bb562, https://github.com/maplibre/maplibre-gl-js/commit/7b638de40
27. deck.gl MVT decoding in a worker: https://github.com/visgl/deck.gl/pull/3935, https://github.com/uber-web/loaders.gl/issues/685
28. MapLibre GL JS transfer vs copy: https://github.com/maplibre/maplibre-gl-js/commit/c465272a3, https://github.com/maplibre/maplibre-gl-js/commit/0310542cd, https://github.com/maplibre/maplibre-gl-js/commit/e2dce3ba4
29. ortho-earth IndexedDB row-group cache: https://github.com/kenjiyoshidahome2026-bit/ortho-earth/commit/c5492461
30. Tangram tile slice: https://github.com/tangrams/tangram/blob/master/src/tile/tile.js, `ref-repos/tangrams__tangram/src/tile/tile.js`
31. MapLibre GL JS updates without round trips: https://github.com/maplibre/maplibre-gl-js/pull/6668, https://github.com/maplibre/maplibre-gl-js/issues/4364, https://github.com/maplibre/maplibre-gl-js/commit/ad813fad1, https://github.com/maplibre/maplibre-gl-js/commit/a30582601, https://github.com/maplibre/maplibre-gl-js/commit/c842c3bd6
32. MapLibre GL JS style to workers first: https://github.com/maplibre/maplibre-gl-js/commit/7351d2fbf
33. Tangram stringified messages: https://github.com/tangrams/tangram/commit/3d874d22, https://github.com/tangrams/tangram/commit/1621da0c, https://github.com/tangrams/tangram/commit/8d49f81a
34. MapLibre GL JS MVT as transfer format: https://github.com/maplibre/maplibre-gl-js/pull/6803, https://github.com/maplibre/vt-pbf/pull/16
35. navara fresh WASM memory views: https://github.com/maplibre/navara/commit/268b8aab, https://github.com/maplibre/navara/commit/4af8b7b0, https://github.com/maplibre/navara/commit/6087f0c1
36. Safari Transferables: `ref-repos/maplibre__maplibre-gl-js/CHANGELOG.md`, https://github.com/mapbox/mapbox-gl-js/pull/9003, https://github.com/maplibre/maplibre-gl-js/pull/3225
37. maplibre-rs web threading: https://github.com/maplibre/maplibre-rs/blob/main/docs/src/supported-platforms.md, https://github.com/maplibre/maplibre-rs/issues/45, https://github.com/maplibre/maplibre-rs/commit/7dc7346, https://github.com/maplibre/maplibre-rs/commit/b7e4c27
38. ortho-earth SharedArrayBuffer fallback: https://github.com/kenjiyoshidahome2026-bit/ortho-earth/blob/main/packages/ortho-core/fallback-ladder.md, `ref-repos/kenjiyoshidahome2026-bit__ortho-earth/packages/ortho-core/fallback-ladder.md`
39. OpenLayers lazy worker: https://github.com/openlayers/openlayers/commit/2f7a891b9, https://github.com/openlayers/openlayers/commit/ce2d95ee8
40. Cesium Draco in a worker: https://github.com/CesiumGS/cesium/pull/6191
41. MapLibre GL JS pool lifetime and liveness: https://github.com/maplibre/maplibre-gl-js/pull/8491, https://github.com/maplibre/maplibre-gl-js/issues/8461
42. reearth-papers render permits: https://github.com/reearth/reearth-papers/commit/2007668, https://github.com/reearth/reearth-papers/commit/eabf229, `ref-repos/reearth__reearth-papers/CONTRIBUTING.md`
43. MapLibre GL JS v6 setWorkerUrl: https://github.com/maplibre/maplibre-gl-js/pull/6254
44. Cesium inlined workers: https://github.com/CesiumGS/cesium/commit/07b105ca2b448643db5c2914a37a1583cc94440e, https://github.com/CesiumGS/cesium/commit/18e18021ee46dbf89526921038c34b2e89d0e8f3
45. Tangram Blob worker build: https://github.com/tangrams/tangram/blob/master/rollup.config.mjs, `ref-repos/tangrams__tangram/rollup.config.mjs`, https://github.com/tangrams/tangram/blob/master/build/intro.js
46. Cesium shared worker chunks: https://github.com/CesiumGS/cesium/commit/aabd27a76, https://github.com/CesiumGS/cesium/pull/8224
47. ortho-earth single worker entry and nested workers: https://github.com/kenjiyoshidahome2026-bit/ortho-earth/issues/12
48. deck.gl worker from a CDN: https://github.com/visgl/deck.gl/commit/8d824a4b
49. `tools/build-site.ts` (this repository)
50. MapLibre GL JS cancel and abort: https://github.com/maplibre/maplibre-gl-js/commit/b5c90201d, https://github.com/maplibre/maplibre-gl-js/commit/1d3d433d9, https://github.com/maplibre/maplibre-gl-js/commit/368a604f1, https://github.com/maplibre/maplibre-gl-js/commit/95c703172
51. MapLibre Native geometry tile worker: `ref-repos/maplibre__maplibre-native/docs/mdbook/src/design/geometry-tile-worker.md`
52. tangram-es source generation: https://github.com/tangrams/tangram-es/pull/400
53. tangram-es non-blocking workers: https://github.com/tangrams/tangram-es/commit/ea75fe42, https://github.com/tangrams/tangram-es/commit/d5db23bf, https://github.com/tangrams/tangram-es/commit/d544e564
54. MapLibre GL JS batched glyph requests: https://github.com/maplibre/maplibre-gl-js/commit/726af278a
55. QGIS label cancellation: `ref-repos/qgis__QGIS/ChangeLog` (2019-11-29 [pal] more exit points), https://github.com/qgis/QGIS/issues/32489
56. GRASS banded parallel rasters: https://github.com/OSGeo/grass/commit/251d7f0d9, https://github.com/OSGeo/grass/commit/c80cbf1f6, https://github.com/OSGeo/grass/commit/935447215
57. GRASS shared MASK: https://github.com/OSGeo/grass/issues/2809, https://github.com/OSGeo/grass/pull/2829
58. Marble decoder mutex: https://github.com/KDE/marble/commit/28f9362ea, https://github.com/KDE/marble/commit/5598411f1
59. GRASS shared flag: https://github.com/OSGeo/grass/commit/bf7d8b6f5
60. GRASS shared RNG: https://github.com/OSGeo/grass/pull/6480, https://github.com/OSGeo/grass/commit/c83afef6d, https://github.com/OSGeo/grass/commit/becef3d05
61. GRASS atomic accumulation: https://github.com/OSGeo/grass/commit/1f83c2d27
62. Work splitting: https://github.com/OSGeo/grass/commit/9843891c6, https://github.com/OSGeo/grass/commit/2e636fb7a, https://github.com/KDE/marble/commit/166159644
63. GRASS r.param.scale: https://github.com/OSGeo/grass/pull/7440
64. GRASS thread defaults: https://github.com/OSGeo/grass/pull/5731, https://github.com/OSGeo/grass/commit/110ff3393, https://github.com/OSGeo/grass/commit/9a61f34e0, https://github.com/OSGeo/grass/commit/0b4a96034
65. Tangram tile-to-worker assignment: https://github.com/tangrams/tangram/commit/8a4eb885, https://github.com/tangrams/tangram/commit/311fd022, https://github.com/tangrams/tangram/commit/7a4c4792
66. GRASS worker threads off by default: https://github.com/OSGeo/grass/commit/0fb91788d, https://github.com/OSGeo/grass/commit/3d1354013, https://github.com/OSGeo/grass/commit/3500fb0a8
67. `harness/runners/browser.ts` (this repository)
