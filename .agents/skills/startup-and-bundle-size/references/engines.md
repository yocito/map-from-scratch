# Startup and bundle size, engine by engine

Detail behind SKILL.md, grouped by engine. Each item gives the decision,
its trade-off and the evidence. References [n] point to the list at the
end of this file (numbered independently of SKILL.md).

## MapLibre GL JS

- **WebGL2.** PR 1891 first requested WebGL2 with a WebGL1 fallback,
  citing caniuse coverage of about 94%; maintainers asked for the WebGL1
  logic to stay in one place so it could be deleted. Tests moved from
  headless-gl (no WebGL2) to a real headless browser [1]. v3 went
  WebGL2-only, v5 re-added WebGL1 with a `contextType` option, v6 removed
  it; the v6 note: legacy usage "had plateaued, so maintaining it no
  longer justified the added complexity". A missing WebGL2 later became a
  `GPUInitializationError` from the constructor [2].
- **ESM only, explicit worker URL (v6).** One build target instead of
  UMD, CSP and ESM; CSP compliance by default. Apps that forgot
  `setWorkerUrl` rendered only the background (the ngx-maplibre-gl
  showcase); example projects for each bundler joined the integration
  tests; the RTL plugin had to switch from `importScripts` to dynamic
  import [3].
- **One worker by default.** `workerCount` went from half the cores
  (capped at 6) to 1, except Safari (half the cores, capped at 3), "based
  on results from A/B testing"; still 1 in 2026 [4].
- **Shader link order.** Both compiles and the link are issued before
  reading `LINK_STATUS`; compile status is read only on failure. 7
  programs on an M1 Pro (ANGLE Metal): constructor self time 26.1-27.9 ms
  to 19.1-21.5 ms; with fresh contexts 18-23 ms to 13 ms [5].

## MapLibre Native

- **Budgets before the refactor.** Binary at most 5% larger, start-up and
  frame rate not worse, OpenGL render tests pixel-identical; each PR
  reports compiled size, start-up and FPS on iOS and Android. If
  something grows, make something else smaller, for example compile
  flags that drop unused layer types [6].
- **No abstraction layer.** A cross-API toolkit, bgfx (used by PeakFinder,
  "performance the same as old OpenGL") and MetalANGLE (used by Sygic)
  were rejected for size; transpiling the old GLSL was rejected as
  "designed off a fairly old model of how GPUs work". Cost: years of
  per-backend work, and the early native Metal build showed tearing,
  freezes of up to a second and lower FPS than MetalANGLE [6][7].
- **One backend per build.** Android 13.0.0 made Vulkan the default
  package and kept OpenGL ES as a separate artifact; a runtime
  multi-backend flavour that ships both libraries is experimental [8].
- **Program-binary cache removed.** 150-180 KB of binary and buggy. Init
  launch without/with binary: s10 1,129.8/1,346.75 ms, Pixel 1,692/1,883
  ms, Wiko 2,060/3,876 ms; relaunch: Pixel 723/1,039 ms (cache slower),
  Wiko 1,278/1,136 ms (cache faster) [9].
- **Link once.** Re-linking to rebind attribute locations served a non-VAO
  optimisation that was never built; removing it saved 37.14 ms (1.86 ms
  per program) on the first run after reboot on an iPhone SE [10].
- **Compiler flags.** `-Os` for Apple RelWithDebInfo: "a 17% difference
  in binary size" [11]. LTO on iOS, `-Oz` and `icf=all` on Android, and
  removing an unused static library (-97 KB on iOS) [12].
- **Optional features behind build flags.** PMTiles adds +1.65 MiB file /
  +379 KiB VM on Linux and +210 KiB on iOS, so it sits behind
  `MLN_WITH_PMTILES`, with a stub file source linked when off instead of
  `#ifdef`s across the code [13]. HarfBuzz + FreeType shaping: +11% on
  Linux (+15.3 MiB file, +2.09 MiB VM) and on iOS (+1.47 MiB); downloading
  it at run time was rejected because Apple forbids it; the PR was closed
  [14].

## maplibre-rs and navara

- maplibre-rs renders through wgpu everywhere and calls itself a proof of
  concept; WebGPU was "significantly faster because WASM output is
  smaller" than the WebGL build in Chrome [15]. Its npm package ships ESM
  with `new URL(..., import.meta.url)` for workers and `.wasm`, plus an
  IIFE build; ESBuild was chosen over Webpack (no ESM library output, no
  worker inlining) and Parcel (worker inlining broken) [16].
- navara's size-tuned WASM: `navara_wasm` 4.76 MB to 3.37 MB raw (-29.2%),
  973 KB to 844 KB brotli (-13.3%); `font_worker` 2.05 MB to 1.75 MB raw,
  524 KB to 478 KB brotli [17]. SIMD at `opt-level z` emitted no vector
  math in the kernels; frame CPU time moved +1.6%, -0.2% and +2.2% [18].
  Demo splats moved from PLY to gzip SPZ (about 100 MB to 11 MB), and LoD
  knobs were rolled back to one boolean [19].

## Cesium

- **Workers.** Rollup with shared chunks: total minified gzip worker size
  2.6 MB to 225 KB, CI about 17 to 11 minutes [20]. The 1.63 notes give
  8,384 KB (2,624 KB gzip) to 863 KB (225 KB gzip) [21]. Workers became ES
  modules (removing RequireJS and a 2,290-line bootstrapper) and were
  inlined into `Cesium.js`, fixing cross-origin loading [22].
- **Lazy decoders.** Draco (712 KB) bundled raised gzip Cesium.js from
  722 KB to 865 KB; worker-only loading left it about 40 KB smaller than
  master; several sample models broke until a race was fixed [23]. KTX2
  replaced KTX1 and CRN: a logo went from 22.1 kB PNG to 3.6 kB ETC1S;
  textures must be multiples of 4; eager loading of ktx-parse broke IE11
  for every app until made lazy [24]. Delay-loading seldom used libraries
  saved 27 KB (about 3.7%) of gzip Cesium.js [25].
- **WASM decoders in workers.** Main-thread busy time 4-33% lower, ready
  time from 3% faster to 22% slower; reviewers asked for A/A baselines on
  stable local assets because a point-cloud delta reproduced in
  main-vs-main reruns [26].
- **Projections.** proj4 in core: 169 KB raw, 45 KB gzip, about 25 KB
  minified+gzip, about 3.5% of 713 KB, refused as a size increase; the
  later PR was closed as out of date. Many subsystems assumed a
  rectangular world [27].
- **`failIfMajorPerformanceCaveat`** went back to false so software
  contexts (RDP) start, at poor performance [28].
- **Text metrics.** A pixel-scanning `measureText` (draw on a scratch
  canvas, scan `getImageData`) was replaced by native `TextMetrics` [29].
- **npm instead of vendored copies.** Third-party code goes through rollup
  into `ThirdPartyNpm`; vendored copies were always modified and went
  stale [30].

## deck.gl

- Bundle peaked above 1 MB minified. Dropping IE11 transpilation made it
  almost 20% smaller; v8.0 core was 50 kB lighter; v9.4 esbuild + gzip -9:
  Deck+Layer 146.8 kB (144.5 webgl-only), GeoJsonLayer +46.9 kB (39.5),
  MVTLayer +82.1 kB (74.6). Subdirectory imports were tried and abandoned;
  class tree shaking is unreliable because transpiled classes look like
  side effects [31].
- One vertex shader for 32- and 64-bit projection by switching modules,
  not shaders, "reduces bundle size" [32].
- Runtime Canvas 2D atlas for ASCII 32-127 at 64 px; a 57,143-byte
  `font.png` deleted; no SDF, no collision [33].
- MVT and terrain loaders run in workers whose code comes from unpkg by
  default; `worker: false` for debugging [34].

## ortho-earth (GPL-3.0-or-later)

- **Issue 12, deduplication.** Worker builds 34 to 11 to 7 to 2;
  duplicated bytes 2.74 MB (57%) to 513 KB to 254 KB to 177 KB; total JS
  4.81 MB to 1.72 MB raw (1.65 MB to 639 KB gzip). `pbf-base.js` had been
  copied 25 times and `pbf.js` 29 times. Vite 5 `plugins` do not apply to
  worker builds; minifying worker builds saved 0.79 MB raw. A
  `measure:lib` script gates on `--max-dup-ratio`. WASM inlined as 173 KB
  base64 in 7 chunks was emitted once as a 126 KB file. The GL2 backend
  is loaded like WebGPU (render worker 173 KB to 56 KB); start-up JS at z4
  about 1,010 KB to 797 KB. Synchronous geopbf APIs (merge called
  synchronously in 34 places) left only 7 KB deferrable [35].
- Own MVT decoder into `Int32Array`: 37 tiles bit-identical, 27.8 to
  18.0 ms, -4.5 kB [36]. Elevation decoded straight into `Int16Array`:
  21 ms / +12 MB instead of 99 ms / +230 MB for a 5.7M-point tile [37].
- Worker payloads as one typed-array table: 1,000,000 features 16 s to
  1.6 s; CompressionStream writer/reader about 4x cheaper per tile than
  Blob to Response [38].
- Start-up: coarse world layers first, 3.5 MB to 0.65 MB; JS 341 KB to
  278 KB gzip [39]. Lazy bucket listing (1,893 items, 257 KB) and a
  persistent worker pool (45 s idle shutdown): revisit 4.2 s to 0.5 s
  [40]. Baked result cached by SHA-256: 12.2 s to 1.16 s [41]. zstd
  decoder injected on demand; unreadable codecs rejected at open [42].

## OpenLayers and ol2

- v5 removed the `renderer` option; v6 made `getVectorContext` an explicit
  import so apps without it do not bundle vector rendering [43]. v3.14
  replaced goog.events ("significantly reduces the build size"); v10.5
  dropped `color-space` and `color-rgba` [44]. Lazy worker creation [45].
  `failIfMajorPerformanceCaveat: true` with a Canvas fallback [46].
- ol2 shipped full, mobile and light builds from dependency-declared
  modules; modules split out later broke custom builds that relied on
  implicit inclusion [47]. The light profile was about 80 KB gzip against
  about 115 KB with OGC formats; leaving out VML alone saved more than all
  editing classes [48]. Exception-driven XML parsing was 3x slower in
  Firefox [49].

## Leaflet, Modest Maps, Polymaps, kothic, protomaps-leaflet

- Leaflet 0.4 was 27 KB gzip JS + 1.8 KB CSS; today about 40 KB + 3.2 KB;
  drawing and clustering live in plugins [50]. 2.0 is ESM-only with no
  IE, no global `L`, no VML and almost no browser flags; 2.5 years of
  work and a V1 polyfill package for plugins [51]. `eval` templates
  reverted for CSP [52]. PNG markers became SVG inlined in JS, 25% smaller
  after optimisation [53]. Per-feature object and event costs: "10x
  FeatureGroup layer add speedup", no `parseFloat` in `LatLng` [54].
- Modest Maps under 7 KB gzip, no jQuery [55]. Polymaps: `cat` in order
  plus Closure Compiler, no module system [56]. kothic dropped a 247-line
  colour parser for `globalAlpha` [57]. protomaps-leaflet 2.0 cut scope to
  a basemap renderer and removed JSON styles and interaction [58].

## Tangram and tangram-es

- Two-pass Rollup builds a single file whose worker comes from a Blob;
  shared code is downloaded once but parsed twice; a Rollup 2 upgrade was
  reverted over the UMD worker chunk [59]. ES module plus ES5 nomodule
  builds [60]. Bundling topojson (about 6 KB minified) removed an https
  failure [61]. Variable font weight ranges, the 3 s FontFaceObserver
  timeout, and wrong-font first tiles [62].
- tangram-es: Duktape kept over JavaScriptCore, which was 700 kB smaller
  per architecture but evaluated style functions 2x slower [63]; miniz for
  zipped scenes cost about 200 KB [64]; dropping image formats and a 3 MB
  fallback font [65]; 3x faster shader assembly [66]; lazy font config
  (135 ms) and 1,500 to 67 exported symbols [67]; tile prefetch before
  the scene is ready, with time-to-first-frame logging [68].

## Others

- **RustGIS.** No Arrow (wasm would have hit 29 MiB against a 25 MiB
  limit) [69]; C zstd compiled to wasm with clang because GDAL, DuckDB,
  pyarrow and gpio default to zstd [70]; minimal SQLite reader +3.8 KB,
  1.5M polygons in 0.7 s [71]; GDAL and DuckDB as external converters to
  cached FlatGeobuf/GeoParquet instead of linked libraries [72]; GeoJSON
  read one feature at a time, 121 MB of points had peaked at 2.5 GB [73].
- **reearth-papers.** maplibre-native container replaced by the in-process
  WASM renderer ezu: fresh tile 0.2-0.8 s, first tile per isolate about
  1.5 s, against 3-7 s container cold starts [74]; lavapipe image about
  150 MB against 350 MB with Xvfb [75]; style recipes compiled at bake
  time [76]; sprites mirrored [77].
- **Marble.** 2-3 s start-up target, Qt only [78]; o5m instead of XML in
  the tile generator saved more than 2 GB at level 9 [79]; lazy default
  style kept the headless generator off GUI code [80]; static Qt and
  build for the server CPU [81].
- **openglobus.** MSDF atlas fetched on first label; the regenerated atlas
  is 2,724,703 bytes against 562,932 [82].
- **iTowns.** WebGL1 removed (+47/-203 lines) [83]; Potree workers broke
  under babel tests and Vite because of `import.meta.url` [84].
- **QGIS.** Mask-source discovery deferred, 37-83 s to under 1 s [85];
  image clear moved to the render thread, it was about 40% of job setup
  [86]; SVG marker clone 4.3 s to 150 ms for 100k markers [87].
- **GRASS.** Level 1 streams geometry without topology [88]; flat graph
  form usable without rebuilding [89].
- **TerriaJS.** GDAL conversion service removed [90]; IE11 dropped at
  4.7% of NationalMap users to unlock WASM and service workers [91];
  hidden preview map destroyed [92].
- **globe.gl** keeps three.js bundled because it owns the scene;
  three-globe takes it as a peer [93].
- **reearth-visualizer.** A large `data:` URL hashed per feature; hashed
  once per layer after the fix [94].
- **d3-geo.** `digits` rounding with `Math.round` for smaller SVG strings
  [95]; identity projection for pre-projected geometry [96].

## Sources

1. https://github.com/maplibre/maplibre-gl-js/pull/1891
2. `ref-repos/maplibre__maplibre-gl-js/CHANGELOG.md`, https://github.com/maplibre/maplibre-gl-js/discussions/6017, https://github.com/maplibre/maplibre-gl-js/pull/7453, https://github.com/maplibre/maplibre-gl-js/commit/900b2c8da
3. https://github.com/maplibre/maplibre-gl-js/pull/6254
4. https://github.com/maplibre/maplibre-gl-js/commit/ae427dc27
5. https://github.com/maplibre/maplibre-gl-js/commit/73a39c446
6. `ref-repos/maplibre__maplibre-native/design-proposals/2022-10-27-rendering-modularization.md`, `ref-repos/maplibre__maplibre-native/design-proposals/2022-11-29-metal-port.md`
7. https://github.com/maplibre/maplibre-native/pull/547, https://github.com/maplibre/maplibre-native/issues/1609
8. `ref-repos/maplibre__maplibre-native/docs/mdbook/src/platforms/android/android-build-flavors.md`, `ref-repos/maplibre__maplibre-native/platform/android/CHANGELOG.md`
9. https://github.com/maplibre/maplibre-native/commit/c2f974f2a57348213cc02d2472f9c54ba86e6010
10. https://github.com/maplibre/maplibre-native/commit/2a3a1c7bb36410c6037f1d8da46fa68733efbe42
11. https://github.com/maplibre/maplibre-native/commit/9d7b77496062b695567f5f688ccb32f64602e3c3
12. `ref-repos/maplibre__maplibre-native/platform/ios/CHANGELOG.md`, `ref-repos/maplibre__maplibre-native/platform/android/CHANGELOG.md`
13. https://github.com/maplibre/maplibre-native/pull/2882
14. https://github.com/maplibre/maplibre-native/pull/1439
15. https://github.com/maplibre/maplibre-rs/blob/main/docs/src/supported-platforms.md, `ref-repos/maplibre__maplibre-rs/README.md`
16. https://github.com/maplibre/maplibre-rs/blob/main/docs/src/development-documents/library-packaging/web.md, `ref-repos/maplibre__maplibre-rs/docs/src/development-documents/library-packaging/web.md`
17. https://github.com/maplibre/navara/pull/713
18. https://github.com/maplibre/navara/pull/814
19. https://github.com/maplibre/navara/commit/c2b79649
20. https://github.com/CesiumGS/cesium/commit/aabd27a76, https://github.com/CesiumGS/cesium/pull/8224
21. `ref-repos/CesiumGS__cesium/CHANGES.md`
22. https://github.com/CesiumGS/cesium/commit/07b105ca2b448643db5c2914a37a1583cc94440e, https://github.com/CesiumGS/cesium/commit/18e18021ee46dbf89526921038c34b2e89d0e8f3
23. https://github.com/CesiumGS/cesium/pull/6191
24. https://github.com/CesiumGS/cesium/pull/9513
25. https://github.com/CesiumGS/cesium/pull/7140, https://github.com/CesiumGS/cesium/pull/10399
26. https://github.com/CesiumGS/cesium/pull/13669
27. https://github.com/CesiumGS/cesium/pull/6986, https://github.com/CesiumGS/cesium/pull/7502
28. https://github.com/CesiumGS/cesium/commit/2b34d0aac
29. https://github.com/CesiumGS/cesium/commit/6f1487bdd2abdb335c7692f282d9ff78dc9ed0d7, https://github.com/CesiumGS/cesium/commit/bb49820c84b359306ca7c6d252ecd92f281916f5
30. https://github.com/CesiumGS/cesium/commit/f594b3c99
31. https://github.com/visgl/deck.gl/blob/master/dev-docs/roadmaps/dist-size-roadmap.md, https://github.com/visgl/deck.gl/blob/master/docs/developer-guide/building-apps.md, `ref-repos/visgl__deck.gl/docs/developer-guide/building-apps.md`
32. https://github.com/visgl/deck.gl/blob/master/dev-docs/RFCs/v5.2/unified-32-and-64-bit-project-api-rfc.md, `ref-repos/visgl__deck.gl/dev-docs/RFCs/v5.2/unified-32-and-64-bit-project-api-rfc.md`
33. https://github.com/visgl/deck.gl/commit/d1d64502, https://github.com/visgl/deck.gl/commit/c5472c3b
34. https://github.com/visgl/deck.gl/commit/8d824a4b
35. https://github.com/kenjiyoshidahome2026-bit/ortho-earth/issues/12
36. https://github.com/kenjiyoshidahome2026-bit/ortho-earth/commit/e9fdcfca, https://github.com/kenjiyoshidahome2026-bit/ortho-earth/commit/cfc60789
37. https://github.com/kenjiyoshidahome2026-bit/ortho-earth/blob/main/packages/altpbf/README.md, `ref-repos/kenjiyoshidahome2026-bit__ortho-earth/packages/altpbf/README.md`, `ref-repos/kenjiyoshidahome2026-bit__ortho-earth/packages/ortho-core/perf survey.md`
38. https://github.com/kenjiyoshidahome2026-bit/ortho-earth/blob/main/packages/geopbf/README.md, `ref-repos/kenjiyoshidahome2026-bit__ortho-earth/packages/geopbf/README.md`
39. https://github.com/kenjiyoshidahome2026-bit/ortho-earth/commit/2761c981, https://github.com/kenjiyoshidahome2026-bit/ortho-earth/commit/d265b75d
40. https://github.com/kenjiyoshidahome2026-bit/ortho-earth/commit/103b127e, https://github.com/kenjiyoshidahome2026-bit/ortho-earth/commit/b036443d
41. https://github.com/kenjiyoshidahome2026-bit/ortho-earth/commit/6d398c83
42. https://github.com/kenjiyoshidahome2026-bit/ortho-earth/commit/0dcc93bf, https://github.com/kenjiyoshidahome2026-bit/ortho-earth/commit/b316e2ad
43. `ref-repos/openlayers__openlayers/changelog/upgrade-notes.md`, `ref-repos/openlayers__openlayers/changelog/v5.0.0.md`
44. `ref-repos/openlayers__openlayers/changelog/v3.14.0.md`, `ref-repos/openlayers__openlayers/changelog/v10.5.0.md`
45. https://github.com/openlayers/openlayers/commit/2f7a891b9, https://github.com/openlayers/openlayers/commit/ce2d95ee8
46. https://github.com/openlayers/openlayers/commit/d6dc1a2c6
47. https://github.com/openlayers/ol2/blob/master/readme.md, https://github.com/openlayers/ol2/blob/master/build/README.txt, https://github.com/openlayers/ol2/blob/master/build/light.cfg, https://github.com/openlayers/ol2/blob/master/notes/2.12.md, https://github.com/openlayers/ol2/pull/101
48. https://github.com/openlayers/ol2/issues/254, https://github.com/openlayers/ol2/issues/16, https://github.com/openlayers/ol2/commit/5c42b2f3
49. https://github.com/openlayers/ol2/commit/319c8f87
50. `ref-repos/Leaflet__Leaflet/FAQ.md`, `ref-repos/Leaflet__Leaflet/README.md`, `ref-repos/Leaflet__Leaflet/docs/_posts/2012-07-30-leaflet-0-4-released.md`
51. `ref-repos/Leaflet__Leaflet/docs/_posts/2025-05-18-leaflet-2.0.0-alpha.md`, https://github.com/Leaflet/Leaflet/pull/8826, https://github.com/Leaflet/Leaflet/commit/2c44074e, https://github.com/Leaflet/Leaflet/commit/9f351794, https://github.com/Leaflet/Leaflet/commit/9c58fcdd
52. https://github.com/Leaflet/Leaflet/issues/2217, `ref-repos/Leaflet__Leaflet/CHANGELOG.md`
53. https://github.com/Leaflet/Leaflet/commit/e226f77a, https://github.com/Leaflet/Leaflet/commit/c58640e0, https://github.com/Leaflet/Leaflet/commit/511dc65c
54. https://github.com/Leaflet/Leaflet/commit/d662e005, https://github.com/Leaflet/Leaflet/commit/f631513a, https://github.com/Leaflet/Leaflet/commit/d4fe4cb8, https://github.com/Leaflet/Leaflet/commit/0210071d
55. https://github.com/stamen/modestmaps-js/issues/17
56. `ref-repos/simplegeo__polymaps/README.mkd`, `ref-repos/simplegeo__polymaps/Makefile`
57. https://github.com/kothic/kothic-js/commit/e98f1f0
58. https://github.com/protomaps/protomaps-leaflet/issues/112, https://github.com/protomaps/protomaps-leaflet/pull/129, `ref-repos/protomaps__protomaps-leaflet/CHANGELOG.md`
59. https://github.com/tangrams/tangram/blob/master/rollup.config.mjs, `ref-repos/tangrams__tangram/rollup.config.mjs`, https://github.com/tangrams/tangram/blob/master/build/intro.js, https://github.com/tangrams/tangram/blob/master/build/bundle.mjs, https://github.com/tangrams/tangram/commit/81ee5a1d
60. https://github.com/tangrams/tangram/blob/master/README.md, https://github.com/tangrams/tangram/commit/2373ba0e
61. https://github.com/tangrams/tangram/commit/7b08f735
62. https://github.com/tangrams/tangram/pull/757
63. https://github.com/tangrams/tangram-es/pull/1942
64. https://github.com/tangrams/tangram-es/pull/1373
65. https://github.com/tangrams/tangram-es/commit/dbed0e73, https://github.com/tangrams/tangram-es/commit/6e3d59ce, https://github.com/tangrams/tangram-es/commit/1aeacf9e
66. https://github.com/tangrams/tangram-es/commit/9c42450a, https://github.com/tangrams/tangram-es/commit/d902d007, https://github.com/tangrams/tangram-es/commit/c6e344e7
67. https://github.com/tangrams/tangram-es/commit/de7d9483, https://github.com/tangrams/tangram-es/commit/ae94b01e
68. https://github.com/tangrams/tangram-es/commit/24c09da4, https://github.com/tangrams/tangram-es/commit/c8896b23, https://github.com/tangrams/tangram-es/commit/0ee3a9fb, https://github.com/tangrams/tangram-es/commit/77728228
69. https://github.com/opengeos/RustGIS/pull/70, https://github.com/opengeos/RustGIS/commit/5f498a3
70. https://github.com/opengeos/RustGIS/commit/32011de
71. https://github.com/opengeos/RustGIS/pull/95
72. `ref-repos/opengeos__RustGIS/docs/user-guide/data.md`, `ref-repos/opengeos__RustGIS/ROADMAP.md`
73. https://github.com/opengeos/RustGIS/commit/d97bd75
74. https://github.com/reearth/reearth-papers/commit/b82da28, https://github.com/reearth/reearth-papers/commit/f7247a3, `ref-repos/reearth__reearth-papers/README.md`
75. `ref-repos/reearth__reearth-papers/CONTRIBUTING.md`
76. `ref-repos/reearth__reearth-papers/src/ezu.ts`, `ref-repos/reearth__reearth-papers/scripts/ezu-recipes.sh`
77. https://github.com/reearth/reearth-papers/commit/6af6885, `ref-repos/reearth__reearth-papers/mirror/README.md`
78. `ref-repos/KDE__marble/MANIFESTO.txt`
79. https://github.com/KDE/marble/commit/00131cf85
80. https://github.com/KDE/marble/commit/7b27be464
81. https://github.com/KDE/marble/commit/c804cf0eb, https://github.com/KDE/marble/commit/253a4b164
82. https://github.com/openglobus/openglobus/commit/517b2eef, https://github.com/openglobus/openglobus/commit/1a0200b4
83. https://github.com/iTowns/itowns/commit/5bd5c32b, `ref-repos/iTowns__itowns/changelog.md`
84. https://github.com/iTowns/itowns/pull/2137
85. https://github.com/qgis/QGIS/issues/34942, https://github.com/qgis/QGIS/pull/36366
86. https://github.com/qgis/QGIS/commit/022e228522
87. https://github.com/qgis/QGIS/commit/f446bda82a
88. `ref-repos/OSGeo__grass/lib/vector/vectorlib.dox`
89. `ref-repos/OSGeo__grass/lib/vector/dglib/dglib.dox`, `ref-repos/OSGeo__grass/lib/vector/dglib/README`
90. `ref-repos/TerriaJS__terriajs/packages/terriajs/architecture/0008-remove-conversion-service.md`
91. `ref-repos/TerriaJS__terriajs/packages/terriajs/architecture/0003-drop-ie11-support.md`, `ref-repos/TerriaJS__terriajs/packages/terriajs/architecture/0010-never-support-ie11.md`
92. `ref-repos/TerriaJS__terriajs/packages/terriajs/CHANGES.md`
93. https://github.com/vasturiano/globe.gl/issues/48, `ref-repos/vasturiano__globe.gl/src/globe.js`
94. https://github.com/reearth/reearth-visualizer/commit/73386249
95. https://github.com/d3/d3-geo/pull/272
96. https://github.com/d3/d3-geo/commit/2c51b71
