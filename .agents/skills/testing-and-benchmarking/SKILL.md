---
name: testing-and-benchmarking
description: What 41 map engines learnt about measuring renderers honestly (which build to time, GPU time versus frame time, noise floors and A/B order, validating a frame before timing it) and about checking their output (pixel-identical versus tolerant image tests, independent references, golden bake outputs, ratchets of known failures). Load it when writing or changing a bench.ts, spec.yaml budgets or verification checks, a bake test, or a native build line; before claiming that a change made something faster or kept it correct; and whenever two runs disagree, a speed-up looks too good, a check passes on a blank screen, or a reference image breaks after an unrelated change.
---

# Testing and benchmarking: numbers you can trust, pixels you can check

A renderer is judged by two kinds of evidence: timings and checks of what it
drew. Both lie in the same few ways across all 41 engines read here. Timings
come from the wrong build (a debug or dev-transpiled one, 3.7x off in Mapnik
[85]), from frames that drew nothing (very high FPS that means nothing
[10]), from a clock that saturates at vsync [33], or from a single A/B run
that heat and run order move by ±50% [33]. Checks compare against the
renderer's own earlier output and so bless a consistent bug for years [92]
[76], use one tolerance where a refactor should have been exact [8], or are
golden files so large that nobody can debug a failure [37]. The engines that
got this right fixed the definition of "done" before the code (size,
startup, frame-rate budgets and pixel identity [6]), timed the shipped
artifact [1][5], reported a noise floor next to every difference [1][18],
validated output before timing it [86], and tested against references the
renderer did not produce [76][79][92]. This repo already does the first
part (every requirement is a budget, every bench has read-back checks
[117]); this skill is the rest.

Per-engine detail, with all numbers: [references/engines.md](references/engines.md).
Measurement traps already met in this repo are in
`skills/map-from-scratch/references/pitfalls.md` and are not repeated here
[117].

## Where this repo stands

- `benchFrames` reports per frame `cpu_ms` (JS issuing), `frame_ms` (issue
  plus a 1-pixel `readPixels` wait) and `gpu_ms` from
  `EXT_disjoint_timer_query_webgl2`, after 10 warm-up frames; percentiles
  are nearest-rank, so a budget is always an observed value [116].
- A run passes when every budget holds and every check passes in every
  iteration; an unreported check fails [117]. Results record the machine's
  load average and GPU name [116].
- What the harness does not do yet: run A and B alternately, report an A/A
  noise floor, compare a frame against a stored reference image, or check
  bake output against the previous bake. Each section below says when a
  request needs it.

## Decision 1: which build, on which runtime

| Situation | Measure |
| --- | --- |
| browser example | the exact files that ship, as the static server serves them, never a dev transpiler's module graph |
| native example | the build line in `spec.yaml`, with the flags it really has |
| phone request | a real device if the claim is about the phone; CPU throttling only for relative comparisons |
| WASM rasteriser | the SIMD build, and say whether the target has SIMD |

- MapLibre GL JS measured a refactor at +75.6% on `getCameraLngLat` under
  vite-node, which rewrites cross-module imports into property loads; the
  esbuild-bundled build was faster than main [1]. The project's benchmark
  discussion settled on running against built bundles and on comparing PR
  and base on the same runner, because GitHub runners vary too much for
  absolute numbers [5].
- Mapnik's packaged CMake builds lacked `-DNDEBUG`, so `mapbox::variant`
  dispatch was compiled `noinline`: one OSM tile took 25.4 s on Debian 12,
  93.7 s on Debian 13, 24.9 s rebuilt with NDEBUG [85]. Their cheap CI
  check: `nm -D --undefined-only libmapnik.so | grep -c assert_fail` [85].
- MapLibre Native requires release builds for benchmarks; a reported Vulkan
  lag could not be reproduced on a device and was attributed largely to the
  emulator and TextureView [10]. OsmAnd measured an activity recreation at 612
  ms on a software-GPU emulator but 72 ms on a Pixel, about 8x apart, and
  dropped the optimisation the emulator had motivated [100].
- Build flags change results, not only speed: PROJ built with fast-math
  gave a polygon area of 0.126272547475285 m² where the exact value is
  0.126347391348170 [42]; Mapnik builds with `-ffp-contract=off` because
  GCC fuses multiply-adds on aarch64 but not on baseline x86-64, so the same
  map rendered differently per machine [88].
- SIMD: navara turned on SIMD at `opt-level=z` and measured no change
  (+1.6%, -0.2%, +2.2% on frames of 1.2-1.4 ms); the vectoriser emitted no
  vector math [20]. reearth-papers switched its WASM rasteriser to a
  `+simd128` build and warm z14 renders went from 7-8 s to ~1.1 s [22]. Check
  whether vector code was emitted before crediting a flag.
- Rendering tests moved from headless-gl in Node (WebGL 1 only) to Chrome
  via Puppeteer against the production build, so WebGL2 paths are tested in
  the runtime that ships; with a 3 s timeout the browser run took 7 min 6 s,
  1,161 passed and 47 failed [2]. maplibre-rs made headless rendering a
  driver that renders one frame once loading finishes, so the app, tests and
  image output share one renderer [12].

## Decision 2: what goes into a number

- **GPU time and stall counts, not frame-time averages.** ortho-earth's
  frame-time EMA read 16.7 ms on both backends at 60 Hz while real GPU work
  was 4-8 ms; it switched to timestamp-query GPU times and counts of frames
  over 4 ms, and notes Chrome quantises WebGPU timestamps to ~100 µs, so
  differences below that cannot be resolved [33].
- **Tails and causes, not only the mean.** MapLibre Native's Android bench
  records FPS, average and 1%-low encoding and rendering times separately,
  thermal state, device, renderer, debug flag and git revision; its example
  run shows encode (19.8 ms, 1% low 91.7 ms) dominating render (7.7 ms) [7].
  walkers reports the time spent in the map next to the frame time [112].
  Organic Maps judges position extrapolation by its error per step on 885
  recorded tracks (0.67 m at step 1 to 5.35 m at step 10), not by eye [105].
- **Per-item percentiles, not totals.** MLT's per-tile numbers showed its
  advantage sits in large tiles: on the median OpenMapTiles tile MLT
  v1+gzip was larger (428 B against 422 B for MVT+gzip) and took 117% of
  MVT+gzip's decode time, while the largest 1% shrank 2.13x [15].
- **From the bytes as fetched.** deck.gl chose to benchmark attribute
  generation in Mrows/s from flat lon/lat columns, not from pre-shaped
  `row.position` arrays that give ~70 Mrows/s "for bragging rights" [28].
  reearth-papers times from the top of the tile handler to after the cache
  write, because a Worker's clock advances only after I/O, so timing around
  `render()` missed the CPU time [23].
- **A fixed overhead baseline.** Mapnik's bench added a no-op render to
  measure fixed cost, validates output before timing, synchronises threads
  before starting, and reports iterations per second with a minimum
  duration [86].
- **Load-time protocol.** Cesium's guide fixes the camera in code, disables
  globe and skybox to avoid unrelated requests, throttles the network to a
  stated speed, and separately measures with disk cache on to time only
  code [24].
- **Memory over repeats.** MapServer found memory and time per request
  growing linearly in a long-lived process because temporary `/vsimem`
  files were never deleted [93]. OsmAnd records GPU bytes per resource type
  at creation, and found every texture counted 0 bytes until sized internal
  formats were used [102]; Cesium's per-stage memory statistics double-count
  resources shared through its cache [25].
- **Where time goes before what to change.** OsmAnd measured symbols at 94%
  of per-tile time (500 ms with, 30 ms without) [101]; TileMill found Mapnik
  spending over 90% of "rendering" time waiting on a per-row SQLite mutex
  [98]; TerriaJS found slow tile loads during fast panning were client CPU
  saturation, with curl latencies equal across server variants [72].

## Decision 3: is the difference real?

- **Report the noise floor.** The MapLibre seam refactor reported A/A noise
  of 1-3% next to its deltas [1]; MLT perf PRs run base twice plus the
  change in shuffled order on a pinned core, and reported noise up to 6.2%;
  WASM benches still varied 10-20% between runs [18].
- **Alternate and take medians.** ortho-earth: single A/B runs swing ±50%
  with heat and order, so only medians of 3, run A/B in both orders, are
  reported [33]. GRASS: configurations interleaved, warm-up discarded,
  medians, with the spread of runs shaded in scaling plots [47][48].
- **Compare at equal state.** ortho-earth's absolute frame cost moved from
  9.85 to 11.12 ms with 3 against 76 loaded terrain cells, so comparisons are
  made at equal loaded-cell counts [33].
- **Against the strongest baseline.** MLT compares with gzip-compressed MVT
  ("otherwise we are comparing very unrealistic scenarios") and with
  fast-mvt, and fully decodes MLT so lazy decoding gets no credit; best of
  15 runs, up to 5,000 tiles per zoom, one core [15][18].
- **Samples that are both unbiased and repeatable.** TerriaJS's tile checker
  fetched 50 random tiles per zoom instead of the first 50 in scan order
  (biased to one corner), then disabled the cap "for predictability" [74].
  Use a fixed seed.
- **Benchmarks are code.** GRASS reviewers required the exact commands, a
  reproducible script and a serial/parallel equality test before discussing
  a threading PR; small maps (under ~5k x 5k) gained nothing from threads
  [41]. Its benchmark library writes joinable JSON and plots separately
  [46].
- osgEarth's agent rules require a before/after microbenchmark for any
  performance claim, while checking that behaviour did not change [80]. Its
  design log labels viewer frame statistics as recent-frame diagnostics, not
  a benchmark suite; CPU and GPU times overlap and must not be added [79].

## Decision 4: did the frame contain the map?

- MapLibre Native's Vulkan/OpenGL comparison first produced "very high but
  meaningless FPS" when no data was loaded on a fast route; the remedy was a
  slower route and a proposal to preload an offline cache [10].
- OsmAnd's batch renderer polled `isIdle()` once and got 4 blank tiles out
  of 54; requiring three idle polls 10 ms apart removed them [101].
- OpenLayers 2 counted loading tiles at image `loadstart`; the counter fired
  15 load events for 4 zoom-ins until it counted at queue time and reset
  when the queue was aborted [57].
- go-staticmaps' concurrency rewrite stopped returning tile-fetch errors, so
  a map came back with a hole "about 50% of the time" and callers could not
  tell [114].
- A heatmap's GPU max reduction rendered into a 1x1 texture returned 0 on
  Windows ANGLE, so every pixel took the first colour [27]. 04 reduces on the
  GPU too [117]: its check must read the screen, which the repo's pitfalls
  already demand, and a Windows/ANGLE run is a separate test.
- navara's labels silently stopped drawing because three.js caches the
  instance count at first bind; JS state was correct and the draw was
  issued [19]. Check counts at the API boundary, not in your own variables.
- On Metal and Vulkan, MapLibre Native snapshots take a completion callback
  and blit the finished frame instead of stopping the renderer [11]; a
  synchronous read-back measures the stall it causes.

## Decision 5: what a correctness check compares against

| Change | Check |
| --- | --- |
| refactor, data layout, performance change | pixel- or byte-identical to the previous build |
| new graphics API, new backend, AA change | tolerance: per-pixel threshold or mask |
| projection, geodesy, LOD threshold | independent numeric reference, never the renderer's own output |
| several draw paths sharing one formula | parity test: drawn pixel vs CPU projection, per path |

- **Exact for refactors.** MapLibre Native's modularisation had to match
  the old output pixel for pixel; the Metal port need only keep "the
  spirit" [8]; the globe PR used the exact rule for its seam phase [8]. The
  GL JS seam refactor pinned Mercator with exact-equality tests against
  values dumped from main [1]. reearth-papers compared PNG bytes of fixed
  tiles (Tokyo, Delhi, Paris) with production for every perf change [23].
  GRASS made its parallel path round through float32 like the serial path
  so an equality test stays usable [40]; ortho-earth keeps CPU and GPU bake
  kernels integer-only so they match byte for byte [31].
- **Tolerant across platforms.** QGIS control images take masks: white
  ignored, black exact, grey a maximum deviation per pixel; masks replaced
  fragile lists of acceptable alternative images [35]. kothic-js compares a
  Playwright canvas with a PNG via pixelmatch (threshold 0.1285) and
  refreshes the baseline only with `UPDATE_RENDER_FIXTURES=1` [68]. Mapnik
  runs its visual tests per renderer and per scale factor [82].
- **Independent references.** WebWorldWind disabled tests written from the
  function's own earlier output because they asserted wrong results, and
  tested against official WGS84 values [76]. MapServer wrote twice the
  MoveTo count for MVT points; OGR's decoder rejected them [92]. osgEarth's vegetation cut-off was 12.75 px where 425 px was meant;
  "equivalence tests alone missed that error", and a fixture with objects of
  known 20/80/200 px size caught it [79]. GRASS pins reference values from
  MPFR [42].
- **Parity across paths.** ortho-earth drew a known point per feature type
  and compared the drawn centroid with `map.projectLL`: heatmap, 3D Tiles
  and point clouds were ~10 km off, image corners 187 px off, while working
  paths measured 0.03-0.4 px [34].
- **Ratchet known failures.** ortho-earth's runner fails on new failures,
  on listed failures that now pass, and on tests that did not run [34].
  maplibre-rs commits the failed and errored case ids of the MapLibre render
  suite and counts them separately (errored 428 to 115 while failed grew 585
  to 848 as cases started rendering) [13].
- **Fix the alpha convention of the readback.** maplibre-rs blends
  premultiplied and converts readback to straight alpha before comparing
  with PNGs [14]. wgpu readback rows must be padded to 256 bytes; widths not
  divisible by 64 failed [111]. Test at fractional DPR: OpenLayers' v9
  flicker appeared only at 150% browser zoom, from one renderer computing
  canvas size differently [55]; protomaps-leaflet made DPR an explicit
  option for headless capture [64].

## Decision 6: testing the bake

- **Tiny golden inputs, known-bad baselines included.** Marble feeds one
  small OSM input per case into its tile creator and diffs each tile with a
  reference, recording current output including known errors, so every later
  fix shows up as a reviewable diff [54].
- **Invariants over huge golden files.** QGIS dropped its large terrain STL
  golden test: 40k-line files were "impossible to debug" and broke on
  tessellator or tiling changes unrelated to export [37].
- **Large inputs and every type.** GRASS's raster3d RLE was wrong above
  129,032 and only a large-file test showed it; the codec was removed [43].
  MapServer's FlatGeobuf reader passed its one test file but had negative
  offsets and one-byte decoding of non-string properties [91]. Marble's
  encoder serialised every relation member as a way and counted UTF-16
  characters against a 250-byte limit [53].
- **Diff against the previous bake.** Organic Maps' CI compares baked
  borders with the previous commit's: uncovered area above a threshold
  (0.01 m² in the documented run), new overlaps and new invalid rings fail; "comparing a file
  with itself cannot detect regressions" [103]. A broken spatial index
  silently dropped some states' polygons for TerriaJS, so count features per
  tile [72]. osgEarth's random seams in tiles cut from a 13 GB raster could not
  be reproduced on small data; the cause was GDAL's VRT rasterizer [81].
- **Committed fixtures, not network fetches.** Organic Maps moved a test
  that downloaded 14 MB of real terrain, and passed vacuously offline, into
  a separate integration suite [104].
- **Edge inputs that crashed engines.** A truncated binary tile threw
  `RangeError` inside the frame loop and froze vts-browser-js, with no URL
  to trace it [75]; a rect clipper overflowed when edges crossed corners (3
  output points per edge, not 2) [94]; a `0,0` dash array hung Chromium
  [67]; non-200 tile responses leaked a file descriptor each [115]; fuzzing
  found an unbounded error chain, now capped at 100 [95].
- **Deterministic order.** mapsforge label output depended on render order
  and on non-deterministic comparison ties until a total order was imposed
  [107]. Reference images of placement change whenever placement does: QGIS
  reverted a label-candidate bump the same day because its tests broke, then
  reapplied it with regenerated images [38].

## Decision 7: which paths to bench

Most regressions in these histories were caught, or would have been, by a
bench of a path nobody was looking at:

- rotating and pitching: a one-word type check re-placed every bucket, not
  just symbols, on bearing/pitch changes [3];
- per-layer loops: `listImages()` was called once per layer per update [4];
- keys and lookups: a `QString` in Marble's tile-id hash cost 32% (13,722 to
  18,103 ms over its timedemo) [51]; Mapnik missed its 4326/3857 fast path
  for uppercase `EPSG:3857`, and a reporter's layers rendered much slower
  until lowercase `epsg:3857` "did the trick" [84];
- exceptions in parsers: 3x faster WMC parsing in Firefox without them [59];
- tilted views: galileo's displayed-tile update fell ~50% with hash maps,
  noticeable when zooming out tilted [110]; MapLibre Native's terrain at
  pitch 65 ran 21.5 fps against 53.8 without, with encode time x2.3 and 28
  draw calls against 19 [9].

Bench every camera mode the request allows, and the expensive end of each.

## Measure before optimising

Measured, then not done or undone: an area cache that never hit (Marble)
[52]; caching surface normals at ~1.5% of tile build (iTowns) [71]; renderer
handover across activity recreation, ~50 ms on device (OsmAnd) [100];
shapefile mmap, same speed without (TileMill) [99]; a sparse-vertex guard
worth 2-9% (QGIS, kept only because it was small) [39]; GPU compute at 3-6%
of a tile build (ortho-earth) [31]; SIMD flags with no vector code (navara)
[20]. Delegating to a general library has the reverse cost: cartopy's move
to pyproj made one example 4.37 s to 19.35 s and CI 57 s to 2 min 38 s [113].

## Tried and reverted

- **Per-frame tile request queue** (OpenLayers 2): smoother panning, but
  cold zoom loads 2-7x slower (24 tiles x 16 ms = 384 ms of waiting); replaced
  by delayed starts [56].
- **Error on a missing tile, then a silent hole** (go-staticmaps), the wrong
  way round [114].
- **Real-time waits in tests** (OpenLayers 2, Leaflet): IE8 in a VM failed 4
  of 5 runs; Leaflet removed two browser zoom tests that failed most of the
  time on master; both point to fake clocks [58][63].
- **Random tile samples**, disabled for predictability (TerriaJS) [74].
- **Self-written snapshot tests**, disabled as wrong (WebWorldWind) [76].
- **Large golden STL**, dropped (QGIS) [37].
- **NDEBUG as a public flag**, leaked into pkg-config, moved private
  (Mapnik) [85].
- **Big rewrite before release**: Leaflet 1.0 was "a culmination of
  several years of work" and 914 commits past 0.7.3; afterwards releases
  every 2-4 weeks and small incremental changes [60].
- **An antimeridian heuristic** never merged: an 18% Chrome slowdown against
  a 1-2% budget, and early jsperf numbers were misleading until setup,
  teardown and clipping were controlled [61].

## Guidance for a renderer here

Do, always:

1. Bench the shipped files and the shipped build line. For native examples,
   no `-ffast-math` anywhere whose output is compared; if a C example uses
   `assert`, build with `-DNDEBUG` and check for `__assert_fail` as Mapnik
   does [85][42].
2. For every fixed view, add a check that the frame has the content it
   should (drawn pixel count or ids taken from the baked data) before its
   time is trusted [10][86][101]. A blank frame must fail, not score.
3. For a refactor or a speed change, require identical output: read back
   the frame (or hash the baked file) before and after and compare exactly
   [8][23]. Use tolerances only when the API, backend or AA changes [35].
4. Before claiming a difference, run unchanged twice (A/A) and report that
   spread; run A and B alternately at least 3 times each and compare medians
   [1][18][33]. A difference inside the A/A spread is "no measured change".
5. Prefer `gpu_ms` for GPU work and count stalls (frames over a threshold)
   rather than reading `frame_ms` means; keep `cpu_ms` apart [7][33].
6. Test projection and LOD math against an independent reference (PROJ,
   published constants, a hand-computed fixture of known pixel size), never
   against the renderer's earlier output [76][79].
7. Test bake tools on tiny committed inputs with expected outputs and on one
   large input; decode custom formats with a second, independent reader in
   the test; print and diff counts against the previous bake [43][54][92]
   [103].

Do when the request has it:

- tiles or network: Cesium's protocol (fixed camera, no stray requests,
  stated throttle, separate warm-cache run) and a per-tile percentile table
  [15][24];
- rotation, pitch or 3D: a bench at the steepest allowed pitch [3][9];
- a phone claim: a physical device, release build, 1% lows and thermal
  state; CPU throttling in headless Chromium supports only relative claims
  [7][10][100];
- a long-lived session: repeat the interaction many times in one process
  and budget the heap's growth [93];
- several draw paths that each project: a parity check per path [34];
- workers or threads: speedup and efficiency per worker count, with spread;
  give each worker its own seeded RNG, since GRASS's shared atomic RNG
  slowed 4-16 threads by 50-55% [41][47][48].

Skip, because the narrow purpose allows it:

- reference-image suites of over a thousand cases (MapLibre's [2]): one
  renderer with a handful of views needs a handful of exact or masked
  frames;
- render-order-dependent label caches and their determinism fixes [107],
  if labels are placed at bake time;
- runtime filter-order or cache micro-optimisations [60][66][106] where the
  bake has already removed the work; measure first.

## Sources

1. https://github.com/maplibre/maplibre-gl-js/pull/8236
2. https://github.com/maplibre/maplibre-gl-js/issues/2420 ; https://github.com/maplibre/maplibre-gl-js/pull/2497
3. https://github.com/maplibre/maplibre-gl-js/commit/170c3499d
4. https://github.com/maplibre/maplibre-gl-js/commit/9e9abb697
5. https://github.com/maplibre/maplibre-gl-js/issues/982
6. ref-repos/maplibre__maplibre-native/design-proposals/2022-10-27-rendering-modularization.md
7. ref-repos/maplibre__maplibre-native/docs/mdbook/src/platforms/android/benchmark.md
8. https://github.com/maplibre/maplibre-native/pull/547 ; https://github.com/maplibre/maplibre-native/pull/4533
9. https://github.com/maplibre/maplibre-native/pull/4190#issuecomment-5491176380 ; https://github.com/maplibre/maplibre-native/pull/4190
10. https://github.com/maplibre/maplibre-native/issues/2787#issuecomment-2466948888 ; https://github.com/maplibre/maplibre-native/issues/2787 ; https://github.com/maplibre/maplibre-native/issues/4130
11. ref-repos/maplibre__maplibre-native/design-proposals/2022-11-29-metal-port.md ; ref-repos/maplibre__maplibre-native/platform/ios/CHANGELOG.md
12. https://github.com/maplibre/maplibre-rs/issues/96
13. https://github.com/maplibre/maplibre-rs/commit/0de294e ; ref-repos/maplibre__maplibre-rs/render-tests/src/templates/results-failed-caseIds.txt
14. https://github.com/maplibre/maplibre-rs/pull/340
15. https://github.com/maplibre/maplibre-tile-spec/blob/main/docs/benchmarks.md ; ref-repos/yuiseki__maplibre-tile-spec/docs/benchmarks.md
16. https://github.com/maplibre/maplibre-tile-spec/blob/main/docs/implementation-guide.md ; ref-repos/yuiseki__maplibre-tile-spec/docs/implementation-guide.md ; https://github.com/maplibre/maplibre-tile-spec/blob/main/docs/specification/v2.md ; ref-repos/yuiseki__maplibre-tile-spec/docs/specification/v2.md
17. https://github.com/yuiseki/maplibre-tile-spec/commit/a8a7d513
18. https://github.com/yuiseki/maplibre-tile-spec/commit/033374a9 ; https://github.com/yuiseki/maplibre-tile-spec/commit/72c06e10 ; https://github.com/yuiseki/maplibre-tile-spec/commit/65488108 ; https://github.com/yuiseki/maplibre-tile-spec/commit/c9e309e9
19. https://github.com/maplibre/navara/blob/main/guide/TEXT_BATCHING.md
20. https://github.com/maplibre/navara/pull/814
21. ref-repos/opengeos__RustGIS/docs/user-guide/data.md
22. https://github.com/reearth/reearth-papers/commit/1d43319 ; ref-repos/reearth__reearth-papers/src/ezu.ts
23. https://github.com/reearth/reearth-papers/commit/9e766d6 ; https://github.com/reearth/reearth-papers/commit/814cc9b ; https://github.com/reearth/reearth-papers/commit/9e53d86
24. ref-repos/CesiumGS__cesium/Documentation/Contributors/PerformanceTestingGuide/README.md ; https://github.com/CesiumGS/cesium/issues/10331
25. https://github.com/CesiumGS/cesium/pull/10397
26. https://github.com/CesiumGS/cesium/commit/ef173be86c1c56aaffefeefc48cc9e5b6ba70360 ; https://github.com/CesiumGS/cesium/commit/bafe7ddc3527aee8e821f47e1b09058439e5cbd8
27. https://github.com/visgl/deck.gl/issues/3554 ; https://bugs.chromium.org/p/angleproject/issues/detail?id=3941
28. https://github.com/visgl/deck.gl/blob/master/dev-docs/RFCs/v7.2/64bit-attribute-rfc.md ; ref-repos/visgl__deck.gl/dev-docs/RFCs/v7.2/64bit-attribute-rfc.md
29. https://github.com/visgl/deck.gl/commit/d08a72b9
30. ref-repos/visgl__deck.gl @43fd968b: docs/advanced/performance.md
31. https://github.com/kenjiyoshidahome2026-bit/ortho-earth/blob/main/packages/geopbf/README.md ; ref-repos/kenjiyoshidahome2026-bit__ortho-earth/packages/geopbf/README.md
32. https://github.com/kenjiyoshidahome2026-bit/ortho-earth/blob/main/packages/ortho-core/fallback-ladder.md ; ref-repos/kenjiyoshidahome2026-bit__ortho-earth/packages/ortho-core/fallback-ladder.md ; ref-repos/kenjiyoshidahome2026-bit__ortho-earth/packages/ortho-core/webgpu port.md
33. https://github.com/kenjiyoshidahome2026-bit/ortho-earth/blob/main/packages/ortho-core/perf%20plan.md ; ref-repos/kenjiyoshidahome2026-bit__ortho-earth/packages/ortho-core/perf plan.md ; ref-repos/kenjiyoshidahome2026-bit__ortho-earth/packages/ortho-core/webgpu port.md ; ref-repos/kenjiyoshidahome2026-bit__ortho-earth/packages/ortho-core/gint draw spec.md
34. https://github.com/kenjiyoshidahome2026-bit/ortho-earth/issues/43
35. ref-repos/qgis__QGIS/ChangeLog (2015-02-18, "Allow use of masks for unit test control images")
36. https://github.com/qgis/QGIS/issues/17441 ; https://github.com/qgis/QGIS/pull/980
37. https://github.com/qgis/QGIS/pull/63444 ; https://github.com/qgis/QGIS/pull/63173
38. https://github.com/qgis/QGIS/commit/cd22d4fbc3 ; https://github.com/qgis/QGIS/commit/ee09131df8 ; https://github.com/qgis/QGIS/commit/ed69bf26b2 ; https://github.com/qgis/QGIS/commit/7797e80c66
39. https://github.com/qgis/QGIS/commit/5ee97adc16
40. https://github.com/OSGeo/grass/pull/7807
41. https://github.com/OSGeo/grass/pull/7044
42. https://github.com/OSGeo/grass/pull/1283
43. https://github.com/OSGeo/grass/commit/aa1da2117 ; https://github.com/OSGeo/grass/commit/cfdf3e050 ; https://github.com/OSGeo/grass/commit/84a06c341
44. https://github.com/OSGeo/grass/commit/62111bb23 ; https://github.com/OSGeo/grass/commit/23e0af15d
45. https://github.com/OSGeo/grass/commit/e82237485 ; https://github.com/OSGeo/grass/commit/ffaa43069 ; https://github.com/OSGeo/grass/commit/d0f9b8042
46. https://github.com/OSGeo/grass/commit/e3344714bd5337cd85b30f548d03e6222acf5e92 ; https://github.com/OSGeo/grass/commit/7b09143baf55f9493d1e1564f5c4c06eb3da19e8
47. https://github.com/OSGeo/grass/commit/c83afef6d ; https://github.com/OSGeo/grass/commit/becef3d05
48. https://github.com/OSGeo/grass/commit/becef3d05 ; https://github.com/OSGeo/grass/commit/c55184d3f ; https://github.com/OSGeo/grass/commit/c83afef6d
49. ref-repos/KDE__marble/tools/vectorosm-tilecreator/setup/README.md ; https://invent.kde.org/education/marble/-/blob/master/tools/vectorosm-tilecreator/setup/README.md
50. https://github.com/KDE/marble/commit/de1208749 ; https://github.com/KDE/marble/commit/6855d0cea
51. https://github.com/KDE/marble/commit/8b2507c73
52. https://github.com/KDE/marble/commit/d202b9123
53. https://github.com/KDE/marble/commit/9dd870a67 ; https://github.com/KDE/marble/commit/507171b53
54. https://github.com/KDE/marble/commit/fbe9ede00 ; https://github.com/KDE/marble/commit/b80baa530 ; https://github.com/KDE/marble/commit/17bafd867
55. https://github.com/openlayers/openlayers/issues/15644 ; https://github.com/openlayers/openlayers/pull/15652
56. https://github.com/openlayers/ol2/issues/298 ; https://github.com/openlayers/ol2/issues/702
57. https://github.com/openlayers/ol2/issues/322
58. https://github.com/openlayers/ol2/issues/299 ; https://github.com/openlayers/ol2/issues/322
59. https://github.com/openlayers/ol2/commit/319c8f87
60. ref-repos/Leaflet__Leaflet/docs/_posts/2016-09-27-leaflet-1.0-final.md ; ref-repos/Leaflet__Leaflet/docs/_posts/2015-07-01-leaflet-is-alive-and-kicking.md ; ref-repos/Leaflet__Leaflet/docs/_posts/2013-11-18-leaflet-0-7-released-plans-for-future.md
61. https://github.com/Leaflet/Leaflet/pull/1293
62. https://github.com/Leaflet/Leaflet/pull/7603
63. https://github.com/Leaflet/Leaflet/commit/a5ca3d4c
64. https://github.com/protomaps/protomaps-leaflet/issues/156 ; ref-repos/protomaps__protomaps-leaflet/src/frontends/leaflet.ts
65. https://github.com/tangrams/tangram/commit/933fdfa7
66. https://github.com/tangrams/tangram-es/pull/484
67. https://github.com/kothic/kothic-js/issues/48 ; https://github.com/kothic/kothic-js/commit/2ad6db2
68. https://github.com/kothic/kothic-js/commit/403fbc9 ; https://github.com/kothic/kothic-js/commit/7376ecb ; ref-repos/kothic__kothic-js/README.md ; ref-repos/kothic__kothic-js/tests/render-pixelmatch-test.js
69. https://github.com/stamen/modestmaps-js/commit/f12c513 ; ref-repos/stamen__modestmaps-js/src/requests.js
70. https://github.com/d3/d3-geo/commit/d3d9fc0 ; https://github.com/d3/d3-geo/commit/356d26f
71. https://github.com/iTowns/itowns/pull/494
72. https://github.com/TerriaJS/terriajs/issues/1211
73. https://github.com/TerriaJS/terriajs/pull/924
74. https://github.com/TerriaJS/terriajs/commit/1bf0abe0e ; https://github.com/TerriaJS/terriajs/commit/aa5fd6d3c ; https://github.com/TerriaJS/terriajs/commit/ac31beae2
75. https://github.com/melowntech/vts-browser-js/issues/170 ; ref-repos/melowntech__vts-browser-js/src/core/map/metatile.js
76. https://github.com/NASAWorldWind/WebWorldWind/commit/c005bc9 ; https://github.com/NASAWorldWind/WebWorldWind/commit/9058268
77. https://github.com/NASAWorldWind/WorldWindJava/commit/08e9201 ; https://github.com/NASAWorldWind/WorldWindJava/commit/49d2b42
78. ref-repos/pelicanmapping__osgearth/docs/design/procedural2-stall-investigation.md ; https://github.com/pelicanmapping/osgearth/blob/master/docs/design/procedural2-stall-investigation.md
79. ref-repos/pelicanmapping__osgearth/docs/design/procedural2-plan-history.md ; https://github.com/pelicanmapping/osgearth/blob/master/docs/design/procedural2-plan-history.md
80. ref-repos/pelicanmapping__osgearth/AGENTS.md ; https://github.com/pelicanmapping/osgearth/blob/master/AGENTS.md ; ref-repos/pelicanmapping__osgearth/docs/source/prestige.md
81. https://github.com/pelicanmapping/osgearth/issues/201 ; http://trac.osgeo.org/gdal/ticket/5874
82. https://github.com/mapnik/mapnik/blob/master/CHANGELOG.md ; https://github.com/mapnik/mapnik/pull/3074 ; https://github.com/mapnik/test-data-visual
83. https://github.com/mapnik/mapnik/issues/2200
84. https://github.com/mapnik/mapnik/issues/4521#issuecomment-3285327865 ; https://github.com/mapnik/mapnik/issues/4521 ; https://github.com/mapnik/mapnik/blob/master/src/well_known_srs.cpp
85. https://github.com/mapnik/mapnik/pull/4572 ; https://github.com/mapnik/mapnik/issues/4571 ; https://github.com/mapnik/mapnik/commit/5d7aa3fe4
86. https://github.com/mapnik/mapnik/commit/cdd817d77 ; https://github.com/mapnik/mapnik/commit/db58b8b57 ; https://github.com/mapnik/mapnik/commit/af0369d81
87. https://github.com/mapnik/mapnik/commit/7c4ccf020 ; https://github.com/mapnik/mapnik/commit/d70c2d978
88. https://github.com/mapnik/mapnik/commit/f0f641d77 ; https://github.com/mapnik/mapnik/pull/4591
89. ref-repos/MapServer__MapServer/HISTORY.md ; https://github.com/MapServer/MapServer/issues/1244
90. https://github.com/MapServer/MapServer/issues/3157
91. https://github.com/MapServer/MapServer/pull/6520 ; https://github.com/MapServer/MapServer/issues/6550
92. https://github.com/MapServer/MapServer/commit/8b3c9069
93. https://github.com/MapServer/MapServer/commit/8ff12605
94. https://github.com/MapServer/MapServer/commit/40624a2b
95. https://github.com/MapServer/MapServer/commit/b695b573
96. https://github.com/geoserver/geoserver/pull/5325
97. https://github.com/geoserver/geoserver/commit/4fc7fb2e0c ; https://github.com/geoserver/geoserver/commit/2da87db038 ; https://github.com/geoserver/geoserver/commit/eef6503d57
98. https://github.com/tilemill-project/tilemill/issues/938
99. https://github.com/tilemill-project/tilemill/issues/1121
100. https://github.com/osmandapp/OsmAnd-core/pull/1113
101. https://github.com/osmandapp/OsmAnd-core/commit/5e440e6c ; https://github.com/osmandapp/OsmAnd-core/commit/51b37f91
102. https://github.com/osmandapp/OsmAnd-core/commit/12357282 ; https://github.com/osmandapp/OsmAnd-core/commit/7eb989da
103. ref-repos/organicmaps__organicmaps/tools/python/borders/VALIDATION.md ; https://github.com/organicmaps/organicmaps/blob/master/tools/python/borders/VALIDATION.md
104. https://github.com/organicmaps/organicmaps/pull/13253
105. https://github.com/organicmaps/organicmaps/commit/cef145f355 ; https://github.com/organicmaps/organicmaps/commit/32243b1e5a
106. https://github.com/organicmaps/organicmaps/commit/f7223286876ccb3a028969d42d1ed2b95304adad ; https://github.com/organicmaps/organicmaps/commit/1d1ce3041cb3098f8f7d559c408f07703a1e7cd6
107. https://github.com/mapsforge/mapsforge/issues/1085 ; https://github.com/mapsforge/mapsforge/pull/1586 ; https://github.com/mapsforge/mapsforge/pull/1588
108. https://github.com/osmdroid/osmdroid/commit/dd37d046 ; https://github.com/osmdroid/osmdroid/commit/e15b5535
109. https://github.com/navit-gps/navit/issues/1191#issuecomment-1189513485
110. https://github.com/galileo-map/galileo/commit/f1063f8 ; https://github.com/galileo-map/galileo/commit/8894c4f ; https://github.com/galileo-map/galileo/commit/d99bc82
111. https://github.com/galileo-map/galileo/commit/617ba5a
112. https://github.com/podusowski/walkers/commit/a30cc4f
113. https://github.com/SciTools/cartopy/pull/1808 ; ref-repos/SciTools__cartopy/docs/source/index.rst
114. https://github.com/flopp/go-staticmaps/issues/34 ; https://github.com/flopp/go-staticmaps/commit/56e3560 ; https://github.com/flopp/go-staticmaps/commit/f6cd17d
115. https://github.com/flopp/go-staticmaps/commit/8cdef98 ; ref-repos/flopp__go-staticmaps/tile_fetcher_test.go
116. harness/page/bench.ts ; harness/lib/stats.ts ; harness/cli.ts
117. skills/map-from-scratch/SKILL.md ; skills/map-from-scratch/references/pitfalls.md ; skills/map-from-scratch/references/spec-yaml.md ; skills/map-from-scratch/references/patterns.md
