# Testing and benchmarking, engine by engine

Bracketed numbers refer to the Sources list in [../SKILL.md](../SKILL.md).
Each item: what was decided, the alternative, the cost, and the evidence.

## MapLibre GL JS

- **One seam for lng/lat to world math, verified bit-identical.** Before
  adding CRSs, transform, camera helpers and tile cover were routed through a
  `worldCoordinateHelper`; Mercator behaviour was pinned by exact-equality
  tests against values dumped from main. Cost: +1.1 KB minified, because
  helper property names cannot be mangled. The first push was 5-8% slower
  on three hot paths (a two-getter chain), fixed by making the helper a
  field. Final deltas: `recalculateZoomAndCenter` +2.2%,
  `calculateCenterFromCameraLngLatAlt` +8.9%, `getCameraLngLat` +75.6%, with
  A/A noise 1-3%; the last was an artifact of vite-node turning
  cross-module imports into property loads, and an esbuild bundle was faster
  [1].
- **Render tests in a real browser.** headless-gl in Node supported only
  WebGL 1 on a stale ANGLE fork; Puppeteer and Chrome against the production
  build replaced it. Cypress was seen as slower; Playwright had been tried by
  the maintainer and found slow. Cost: much longer runs (map load dominates),
  fixtures moved into served assets, diff images harder to write to disk.
  With a 3 s timeout: 7 min 6 s, 1,161 passed, 47 failed; existing CI took
  ~13 min on Ubuntu and ~18 min on Windows [2].
- **Regression from one wrong type check.** `bucket.type` instead of
  `bucket.layers[0].type` re-placed every bucket on rotate and pitch, a
  severe regression (#3856) [3].
- **`listImages()` per layer.** Introduced with the image expression; moved
  to once per update [4].
- **Benchmark design debate.** Run against built bundles (local or CDN),
  split end-to-end from micro benchmarks, compare PR and base on the same
  runner; a maintainer wanted pass/fail thresholds, others noted GitHub
  runner variance makes absolute numbers unreliable [5].

## MapLibre Native

- **Budgets before the refactor.** The modularisation proposal: binary no
  more than 5% larger, iOS test-app startup not slower, frame rate not
  lower, render tests pixel-identical on OpenGL; every PR reports compiled
  size, startup and frame rate on iOS and Android. "If something gets
  larger, make something else smaller" (compile flags to drop unused layer
  types) [6].
- **Android benchmark fields.** Per style: fps, average and 1%-low encoding
  and rendering times, thermal state, sync rendering, device, renderer,
  debug flag, git revision. Example on SM-G973F: 34.7 fps, encode 19.8 ms,
  render 7.7 ms, 1%-low encode 91.7 ms [7].
- **Exact for refactors, spirit for ports.** Modularisation must match pixel
  for pixel (bug fixes excepted); the Metal port need not, "Metal just works
  differently"; the globe PR's seam phase was Mercator-only and
  pixel-identical to main [8].
- **Terrain cost by pitch** (iPhone 16 Pro Max, z12, with/without terrain):
  pitch 25 54.8/58.8 vs 61.2/58.9 fps, encode x1.39-1.50, 6 vs 6 draws;
  pitch 45 40.9/42.1 vs 60.5/59.6, x1.73-1.82, 8 vs 8; pitch 65 21.5/22.0 vs
  53.8/56.2, x2.30-2.35, 28 vs 19. A camera-latitude bug scaled terrain
  height 1.02x at z8, 1.31x at z6, 11x at z4 [9].
- **Empty frames.** The Vulkan vs OpenGL benchmark on AWS Device Farm
  produced "very high but meaningless FPS" while no data was loaded; the
  route was slowed and an offline preloaded cache proposed. Benchmarks must
  use release builds; a reported Vulkan lag was not reproducible in the test
  app and attributed largely to emulator and TextureView [10].
- **Asynchronous snapshots.** With frames in flight on Metal/Vulkan,
  snapshots take a callback and blit after completion. The snapshotter was
  missing in the first Metal release (iOS 6.0.0) and Vulkan snapshot timing
  needed fixes [11].

## maplibre-rs

- **Three modules and a headless driver** that runs one iteration once
  data loading finishes, instead of separate WinitMapRenderer and
  HeadlessMapRenderer types; loading needs an explicit completion signal
  [12].
- **MapLibre render suite as a progress meter.** Failed and errored case
  ids are committed with each feature; at 0de294e failed went 585 to 848
  and errored 428 to 115, as cases moved from erroring to rendering but not
  matching. Cost: large result artifacts in commits [13].
- **Premultiplied blending, straight-alpha readback** for PNG comparison;
  PR #340 reported 203 tests and 19 globe fixtures passing on an M3 Max, but
  is unmerged (scope questioned) [14].

## MapLibre Tile (MLT; yuiseki fork)

- **Per-tile percentiles.** Median OpenMapTiles tile: MLT v1+gzip decode
  117% of MVT+gzip, size 428 B vs 422 B; Protomaps median decode 113%;
  largest 1% of tiles 2.13x smaller than MVT [15].
- **Method.** fast-mvt as the MVT baseline, MLT `decode_all` so lazy decoding
  gets no credit, best of 15 runs, up to 5,000 tiles per zoom, one core,
  duplicate tiles counted once, gzip level 6 per tile [15].
- **Encoding selection by sampling.** Prune candidates with cheap metrics
  (no RLE if average run < 2), try the rest on a ~1% sample, keep the
  smallest stored output; compare stored bytes, not estimates, and do not
  assume a later gzip changes the winner [16].
- **Exact count over a broken HyperLogLog.** The HLL formula was inverted
  and used ln instead of log2, saturating to infinity at ~1.5k distinct
  vertices, so no large layer ever raced vertex dictionaries. An exact
  FxHashSet count with early exit at 66% is ~4x cheaper per vertex and
  deterministic; size -0.77% overall, -2.48% on shortbread-dach, encode
  +4%; 7 tilesets, 13.6k tiles [17].
- **Realistic baseline and noise floor.** Compare against gzip MVT; publish
  v1/v2 decode speed next to size; perf PRs run base twice and the change in
  shuffled order on a pinned core (noise floor up to 6.2%); CI hotpath
  series; WASM benches still vary 10-20% [18].

## navara

- **three.js instance ceiling.** After growing pooled instance buffers,
  `geometry._maxInstanceCount` must be deleted, because three.js clamps
  draws to the count seen at first bind. Silent: JS count correct, draw
  issued, labels never appear; found by patching `drawArraysInstanced` and
  logging its last argument [19].
- **SIMD without gain.** Enabled at opt-level z although kernels did not
  change; browser frame CPU +1.6%, -0.2%, +2.2% on ~1.2-1.4 ms frames (M4
  Pro, Chrome 152); no vector math emitted [20].

## RustGIS

- **View-read benchmark across formats**, 1.6 M polygons, 183,000-feature
  view: GeoParquet 0.15 s at 50 MB, FlatGeobuf 0.11 s at 335 MB, GeoPackage
  0.18 s at 344 MB [21].

## reearth-papers

- **SIMD128 WASM build** for pixel loops: warm z14 urban renders 7-8 s to
  ~1.1 s on edge isolates, cold start ~15 s to ~4.6 s; logs
  `simdEnabled()` once per init [22].
- **Byte-identical PNGs and end-to-end timing.** Each perf change rendered
  Tokyo z14/z15, Delhi (Devanagari), Paris (Latin) and compared bytes with
  production. A Worker's clock advances only after I/O, so latency is taken
  from handler entry to after cache writes. Live misses p50 1,491 ms and
  124 KB, p95 14.1 s; `cpu_ms` left null rather than guessed. A first
  cache-rotation test passed the date as a query parameter, changing the URL,
  and so proved nothing [23].

## CesiumJS

- **Performance testing guide**: fixed camera captured as code, globe and
  skybox off, lower `maximumScreenSpaceError` to load more, `performance.now()`
  timing, network throttled to a reported speed, or disk cache on to time
  code alone; "not a replacement for browser profiling"; used for the glTF
  loading refactor [24].
- **Per-stage GPU memory statistics**, with double counting of resources
  shared through the ResourceCache acknowledged; index buffers kept as GPU
  buffers to avoid re-uploads [25].
- **Modern syntax in per-frame code** used "with consideration for their
  performance implications"; spread removed from worker builds, ES5 loops
  back in MetadataPipelineStage [26].

## deck.gl

- **GPU max reduction failed on ANGLE.** Rendering to a 1x1 texture returned
  0,0,0,0 on Windows Intel/Nvidia with hardware acceleration; correct with
  ANGLE disabled in Firefox. A `colorDomain` escape hatch (7.3), then a
  workaround (7.3.2); iOS lacked render-to-float, so an unsigned-byte
  fallback with less precision was planned [27].
- **Mrows/s from flat columns.** LineLayer full regeneration 10 Mrows/s,
  colour only 30 Mrows/s; ScatterplotLayer 12 Mrows/s; the pre-shaped
  sub-array path (~70 Mrows/s) deliberately not the benchmark [28].
- **Picking radius search** skips rows whose dy² exceeds the best distance
  and decodes only the winner; a micro-benchmark for radius 10 and 50 was
  added (no numbers in the message) [29].
- **Stated scaling limits** (2017): ~1 M items at 60 fps on 2015 MacBook
  Pros, 10 M at 10-20 fps; Chrome's 1 GB single allocation crashes buffer
  generation between 10 M and 100 M items; 10 M points of 5 px radius can
  mean ~1 billion fragment invocations [30].

## ortho-earth (GPL-3; the repo is GPL, so adapting is allowed)

- **GPU share of the tile converter** on 4-core Node: NE countries 0.16 of
  5.6 s (3%), 200k parcels 2.1 of 41.5 s (5%), 1 M points 0.9 of 14.6 s
  (6%). Kernels are integer-only so CPU and GPU outputs are byte-identical,
  checked on SwiftShader in CI [31].
- **Present-pixel verification at startup.** After frame 1 a placeholder
  pixel is read back; if the frame did not present, or did not arrive within
  20 s, the session is marked and reloads on WebGL2. Android always gets
  WebGL2 after silent black maps on an entry-level device [32].
- **GPU timestamps and hitch counts.** EMA saturates at 16.7 ms on 60 Hz
  (both backends read 16.7 ms while GPU work was 4-8 ms); results are
  medians of 3, A/B in both orders, at equal loaded-cell counts (9.85 vs
  11.12 ms for 3 vs 76 cells); single A/B runs swing ±50%; timestamps are
  quantised to ~100 µs; every optimisation has a URL escape hatch and a
  pixel-identity gate [33].
- **Parity harness with a ratchet** (`t-ellparity`, `ell-known.json`):
  drawn centroid vs `map.projectLL` per feature, for both world modes on GL2
  and WebGPU. Found heatmap, 3D Tiles and point clouds ~10 km north; a GL2
  floor 187 px (~450 m at z15) south at 60N; a columnar-layer IndexedDB
  cache never written (DataCloneError swallowed). Working features: 0.03-0.4
  px [34].

## QGIS

- **Control-image masks**: white ignored, black exact, grey maximum
  per-pixel deviation; replaced anomaly images, which were fragile;
  `scripts/generate_test_mask_image.py` [35].
- **Render-time vertex prefiltering** (`qgis_bench`, 10 iterations): GTBs
  180.1 to 68.9 ms, MAMMTERR 88.6 to 9.5, CRIF2011 275.1 to 70.3, CARTO1 8.3
  to 1.5; a 300 MB contour shapefile 25 s to 4 s. "Where the data is
  appropriate for the scale, the differences are very small." Dropping AA
  for sub-pixel features as well: a further 2-30%, made opt-in because the
  difference stayed visible [36].
- **Golden STL/OBJ export tests**: triangles sorted for a stable order; the
  big terrain STL test dropped as "impossible to debug", and the tests
  broke on tessellator and tiling changes [37].
- **Label candidates 8/8/8 to 16/50/30**, reverted the same day because
  reference images broke, reapplied with regenerated images; line candidates
  had been hardcoded, ignoring the setting [38].
- **Sparse-vertex guard before simplifying**: 2.7-8.6% per query (37 to 36,
  70 to 64, 114 to 109 ms, ≥100 queries, release build); kept because small
  [39].

## GRASS GIS

- **Parallel path reproduces serial float32 rounding** above 2^24 so the
  equality test stays usable; a pytest enforces it [40].
- **Benchmarks as reproducible code.** "Share a reproducible benchmark code
  which generates the images you are showing, then we can talk"; maps under
  ~5k x 5k gained nothing from threads [41].
- **Fast-math changed geodesic results**: 0.126272547475285 with defaults,
  0.12634739123375 with `-fno-fast-math`, exact 0.126347391348170 m² by MPFR;
  the online Planimeter's long double explained another value [42].
- **raster3d RLE** wrong above 129,032, found by a large-file test; new maps
  switched off it, then the code was removed [43].
- **In-RAM r.buffer kept as default**, more than 40x faster than the
  low-memory script; 32,000² cells with 1 GB RAM, 90,000² with 8 GB [44].
- **Batched writes**: batches of 20 made a module 16x faster; one SELECT
  instead of one per feature sped output "by several magnitudes"; forcing a
  transaction in low-level `db.execute` was reverted [45].
- **grass.benchmark**: minimalist, no API promises, repeated runs, joinable
  JSON, plotting separate (Matplotlib only for plots) [46].
- **Thread-safe shared RNG**: one C11 atomic advanced by CAS keeps the
  single-thread sequence (13% faster at nprocs=1) but costs 55% at 4 and 8
  threads, 50% at 16. Protocol: 3 reps, warm-up discarded, interleaved
  configurations, medians [47].
- **Scaling plots** of time, speedup and efficiency per nprocs with the
  range shaded; benchmark scripts next to each tool's source [48].

## Marble

- **Pre-generate z11**: dense metatiles take ~15 s on demand while low and
  medium density take ≤100 ms [49].
- **Pyramid index plus bounding box** ranked fastest of four clipping
  strategies for tile creation [50].
- **TileId hashing**: 5 timedemo runs, 13,722 ms / 14.575 fps before, 18,103
  ms / 11.048 fps with `QString` in the hash (32%), 13,788 ms / 14.506 fps
  fixed [51].
- **Area cache keyed by address** removed: temporaries collided, tiles lost
  random polygons at z11-15, and the cache made no measurable difference
  [52].
- **o5m encoder bugs**: all relation members written as ways; string length
  checked in UTF-16 characters against a 250-byte limit, garbling the string
  table in two tiles [53].
- **Single-element golden tests** with an explicit source file instead of
  the 850+ GB osmx database; the baseline records current output, known
  errors included; later fixes each change these fixtures [54].

## OpenLayers

- **Canvas size derived differently in one renderer** cleared shared canvases
  on zoom; only at 150% browser zoom on some browsers; bisected; fixed in
  9.1.0 [55].

## OpenLayers 2

- **Per-frame tile queue**: one `img.src` per animation frame. mobile.html
  zoom-in ~1 s vs ~250 ms before (130 ms fully reverted); GeoWebCache 950 vs
  ~747 ms; TileCloud 587 vs 329 ms. Replaced by a TileManager deferring by
  zoom/move delay [56].
- **Loading counter** moved to queue time: 15 load events (13-847 ms) for 4
  zoom-ins on master vs 4 (531-687 ms) on the parent commit [57].
- **Timer tests**: a 0.1 s wait for an 85 ms delay failed 4 of 5 runs on IE8
  in a VM; maintainers wanted no more `delay_call` tests and pointed to
  Sinon fake timers [58].
- **No exceptions in XML parsing**: 3x faster WMC parsing in Firefox [59].

## Leaflet

- **Small incremental releases** every 2-4 weeks after 1.0, which had taken
  several years and 914 commits past 0.7.3; risky refactors earlier went at the start of
  a cycle [60].
- **Antimeridian "magnetize"**: corrected benchmark showed ~18% drop in
  Chrome against a requested 1-2%; early jsperf misleading until setup,
  teardown and clipping were controlled; PR still open [61].
- **getCenter rewrite**: 1 M iterations, rectangle 47.9 to 39.5 s, polygon
  97.7 to 84.6 s, polyline 145.4 to 126.6 s [62].
- **Flaky browser tile tests removed**: passed in PR CI, failed most of the
  time on master [63].

## protomaps-leaflet, Tangram, tangram-es, kothic-js, modestmaps-js, d3-geo

- protomaps-leaflet: tile canvas is 256 x devicePixelRatio; a
  `devicePixelRatio` option was added for headless rendering instead of
  relying on Puppeteer's deviceScaleFactor [64].
- Tangram: position attribute bound at location 0 to avoid Safari enabling
  and disabling attributes unexpectedly [65].
- tangram-es: filters reordered cheapest first; z14 dense region on an
  iPhone 5S, filtering -36%, total tile build -23% [66].
- kothic-js: dash arrays with zero, negative or non-finite entries drawn
  solid, with a unit test; `0,0` had crashed Chromium [67]. Pixel-diff test
  in Playwright Chromium with pixelmatch (threshold 0.1285) against a PNG,
  refreshed with `UPDATE_RENDER_FIXTURES=1`; a manual performance page had
  existed since 2011 [68].
- modestmaps-js: `clearExcept` was 15% of total time; the cheap validity
  test now runs first [69].
- d3-geo: projections tested by rendering PNGs compared with stored images,
  later snapshot tests; precision changes verified by manually rechecking
  changed snapshots [70].

## iTowns, TerriaJS, vts-browser-js

- iTowns: caching normals on Coordinates declined; profiling showed ~1.5% of
  globe tile construction, while converting all GeoJSON coordinates before
  filtering by extent cost more [71].
- TerriaJS: spatial index made cutting 4-19x faster (SA4 z0-8 1 m 20.7 s to
  23.5 s; SA1 5 m 35 s to 17.9 s); the shapefile index later silently dropped
  some states' polygons, so PostGIS replaced it. Slow requests while
  dragging were client CPU; curl latencies were equal [72]. Region matching
  precomputed: browser lock of 2-3 s became 150 ms [73]. Tile checker: 50
  random tiles per zoom, slow-tile counts, then the cap disabled for
  predictability [74].
- vts-browser-js: an empty or truncated metatile threw RangeError on the
  update path and froze the map; the URL was not reachable from the stack
  [75].

## WebWorldWind, WorldWind Java, osgEarth

- WebWorldWind: geographic-to-Cartesian and normals made more precise and
  tested against WGS84 reference values; tests written from earlier output
  disabled as wrong [76].
- WorldWind Java: EGM96 interpolation-cell fix with a 260-line test; rhumb
  line fix ported from WorldWind Android with tests [77].
- osgEarth: Superluminal capture of stalls, `TextureArena::apply` 3.62 s over
  209 samples, longest 788.64 ms, `glTexSubImage2D` 588/455 ms; offline
  BC3 DDS with all mips; no measured stall reduction claimed yet [78].
  Pixel threshold 12.75 px instead of 425 px, caught only by a fixture of
  known projected size [79]. AGENTS.md: Google Benchmark before/after for any
  perf claim [80]; viewer frame stats are diagnostics, not benchmarks [79]. Random black seams at
  z6-8 from a 431,972 x 208,787 raster, traced to GDAL ticket 5874 after
  2012-2015 [81].

## Mapnik

- Visual tests in `test-data-visual` per renderer (AGG, Cairo, SVG, grid)
  and scale factor; 2.2 grew to 925 tests [82].
- Fixed 256-vertex blocks per part: 3.878 GB peak vs ~395 MB with
  `std::vector` on 1,715,974 tiny parts; render 5,901 vs 6,253 ms (reserve 16:
  5,255 ms) [83].
- Uppercase `EPSG:3857` missed the fast path; lowercase `epsg:3857` fixed
  a reporter's slow render [84].
- NDEBUG: 25.4 / 93.7 / 24.9 s for one tile; rule filters ~6x slower; first
  forced publicly, leaked to pkg-config, then set privately [85].
- Bench harness: early exit when a test does not validate, thread sync
  before start, iterations per second, `--min-duration`, no-op benchmark
  [86].
- `normalize_angle`: subtraction loop up to 16·tau, `std::remainder`
  beyond, with a benchmark [87].
- `-ffp-contract=off` so renders match across x86-64 and aarch64 [88].

## MapServer, GeoServer, TileMill

- MapServer: dropping Z/M from points gave 7-10%; re-enabled by default in
  7.6 [89]. RFC-55 DPI scaling broke dashes and halos; fixed with separate
  scale and resolution factors, checked against 5.4 images [90]. FlatGeobuf
  reader bugs that its single test file missed [91]. MVT MoveTo count
  doubled, caught by OGR [92]. `/vsimem` cleanup: memory and
  time grew linearly per request [93]. Clipper sized 3 points per edge,
  with a corners test [94]. Error chain capped at 100 after OSS-Fuzz [95].
- GeoServer: batched WFS-T with required tests for every order boundary
  [96]; PNGJ default encoder after PngSuite conformance tests, noting that
  faster encoders do not help when loading dominates [97].
- TileMill: >90% of render time waiting on a per-row SQLite mutex [98];
  Windows build without mmap "performs the same" on a z0-6 render [99].

## OsmAnd, Organic Maps, mapsforge, osmdroid, Navit

- OsmAnd-core: renderer handover measured on a Pixel (performDestroy 72/88 ms
  vs 22/39 ms over 16 recreations) and on an emulator (612 vs 148 ms);
  dropped [100]. Batch tile rendering in one process, idle confirmed by
  three polls 10 ms apart (4 of 54 blank with one poll); symbols 500 ms vs
  30 ms per tile [101]. GPU bytes per resource type; 0-byte bug with
  unsized formats [102].
- Organic Maps: border bake validated against the previous commit, area
  thresholds, epsilon 0.003570556640625 [103]; network test moved out of
  unit tests [104]; extrapolation benchmark on 886 tracks / 567,362 points
  (0.71 m at step 1 to 3.13 m at step 5), later 885 tracks [105]; glyph
  cache benchmark in release, 5-run median, 41.8 vs 28.4 ns/op for hits
  [106].
- mapsforge: labels depend on render history; total-order fixes in 2024
  [107].
- osmdroid: tile sets as rectangles; init 50x faster, lookup 2-10x [108].
- Navit: planet build split into four maptool runs by phase, ~51 h on a
  32 GB server; the memory growth was never explained [109].

## galileo, walkers, cartopy, go-staticmaps

- galileo: `tile_bbox` 30% faster, displayed-tile update ~50% faster
  [110]; readback rows padded to 256 bytes [111].
- walkers: scripted circle-scroll demo reporting map time and frame time;
  release builds for web; criterion bench for MVT decoding [112].
- cartopy: pyproj move, Four_Panel_Map 4.37 s (0.19) vs 19.35 s (PROJ 8.1)
  vs 158 s (PROJ 8.0); CI ~57 s to ~2 min 38 s [113].
- go-staticmaps: missing tile became a silent hole after the 2021 rewrite;
  404 tolerated only for overlays with IgnoreNotFound [114]. Response body
  closed before status checks, with 404 and 500 regression tests [115].

## This repo

- Harness: `benchFrames` metrics, nearest-rank percentiles, load average in
  results [116].
- Rules and traps already written down: budgets for every requirement,
  read-back checks, pitfalls of the harness and the examples [117].
