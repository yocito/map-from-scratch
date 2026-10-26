---
name: startup-and-bundle-size
description: What map engines did to cut the bytes they ship (code, workers, WASM, fonts, decoders) and the work they do before the first frame (context, shaders, workers, parsing), what they reverted, and how that applies to a map-from-scratch renderer. Load it when a request names a page-size, download or start-up limit ("under 150 KB", "opens instantly", "slow network", "embedded widget"), when `total_gzip_bytes`, `code_gzip_bytes` or `first_frame_ms` misses its budget, or before adding a worker, a WASM module, a decoder, a font or glyph atlas, a second graphics backend, a program-binary cache or a native size flag.
---

# Startup and bundle size: what ships and what runs before the first frame

Two costs come before a user sees a map: the bytes downloaded (page, code,
workers, WASM, fonts, data) and the work done before the first frame
(context creation, shader compile and link, worker start, decoding,
parsing, font loading). General engines have spent years removing both:
WebGL1 paths, runtime renderer switches, eagerly bundled decoders, worker
code duplicated per worker, a shader-binary cache that did not pay. In
this repository the code is already small and the data is not: the
browser examples ship 1-4 KB of gzipped code next to 4 KB to 17.5 MB of
gzipped data, and MapLibre GL JS for the same request as 02 ships 286 KB
of code and reaches its first frame in 826 ms against 02's 3.3 KB and
227 ms [1]. So the job here is mostly to keep out what engines later had
to remove, and to spend the effort on data bytes and start-up work.
Per-engine detail, with more numbers, is in
[references/engines.md](references/engines.md). Neighbouring skills:
Range reads and archive layout are in `data-range-requests`, fetch queues
and caches in `tile-cache-and-loading`, glyphs in `text-rendering`.

## First: where do the bytes and milliseconds go?

- **Read the footprint split before optimising.** The harness reports
  `code_gzip_bytes`, `data_gzip_bytes` and `total_gzip_bytes`, each file
  gzipped as a server would [2]. Latest runs: 01 962 B code / 3.9 KB data,
  02 3.3 KB / 474 KB, 03 2.6 KB / 525 KB, 04 2.7 KB / 17.5 MB, 07 4.2 KB /
  133 KB [1]. When data dominates, cutting code is wasted effort; go to
  quantisation, delta coding and coarse-first loading.
- **Know what the harness does not count.** `transfer_kb` and `requests`
  are uncompressed (the static server does not gzip) and miss requests
  made by workers [2]. A renderer that fetches from a worker must count
  those bytes itself.
- **Measure after compression.** navara's size work cut its WASM 29% raw
  but only 13% after brotli [3]. MLT's converter first wrote uncompressed
  tiles and its archives came out larger than the gzipped MVT input; with
  gzip, 5 tiles went from 813.7 KB raw MVT to 460.3 KB raw MLT (-43%), but
  from 459.8 KB to 357.0 KB as archives (-22%) [4].
- **Write the budget before the code.** MapLibre Native's modularisation
  fixed its limits up front: binary growth at most 5%, no start-up or
  frame-rate regression, visually identical output with all existing
  render tests passing, and compiled-size, start-up and frame-rate tests
  on iOS and Android, with a report on those three before acting [5].
  Marble set a
  2-3 s start-up target against the 15-30 s of other globes and counted
  each linked library against it [6]. Leaflet's build reports gzipped
  size, and the core is about 40 KB gzip with features pushed to
  plugins [7]. Here, `spec.yaml` budgets play that role.

## Code: one backend, chosen at build time, no helpers you can write

- **WebGL2 only, and fail loudly.** MapLibre GL JS went WebGL2-only in
  v3, re-added a WebGL1 fallback in v5 and removed it again in v6, because
  legacy usage "had plateaued" and no longer justified the complexity; a
  missing WebGL2 now throws a catchable error [8]. iTowns' removal deleted
  203 lines and gave logarithmic depth without an extension [9].
- **No run-time renderer switch.** OpenLayers v5 removed the map's
  `renderer` option because "code for both the Canvas and WebGL renderers
  was included in all applications - even though most people only use
  one" [10]. ol2's light build dropped Canvas as redundant with SVG [11].
  deck.gl added a `visgl:webgl-only` export condition (Deck+Layer
  146.8 kB to 144.5 kB gzip) [12]. If a fallback backend must exist, make
  it a lazy chunk: making its GL2 backend a dynamic import took
  ortho-earth's render worker from 173 KB to 56 KB and start-up JS (z4,
  WebGPU machine) from about 1,010 KB to 797 KB [13].
- **No abstraction layer over one API.** MapLibre Native rejected a
  cross-API toolkit, bgfx and MetalANGLE for size ("Quite a few users
  cannot abide with the toolkit growing considerably"; some count what
  "another 100k bytes" costs in revenue) and wrote each backend itself [5]
  [14]. maplibre-rs, built on wgpu, calls itself a proof of concept [15].
- **Write the few functions instead of importing a library.** OpenLayers
  replaced goog.events and colour packages with its own code [16]; Modest
  Maps stayed under 7 KB gzip and found moving its DOM work to jQuery gave
  no size or clarity gain [17]; Leaflet 2 deleted browser detection and
  polyfills "for a smaller bundle" [18]. ortho-earth's own flat MVT
  decoder was 4.5 kB smaller and decoded in 18.0 ms instead of 27.8 ms
  [19]. RustGIS read GeoParquet without Arrow because Arrow plus brotli
  took its WASM to 29 MiB, past Cloudflare Pages' 25 MiB file limit; the
  hand-written reader grew it 1.3 MB instead of 12 MB [20], and a minimal
  read-only SQLite reader for GeoPackage cost 3.8 KB [21].
- **No code generation at run time.** Leaflet reverted an `eval`-based
  template optimisation: the gain was insignificant and it broke CSP-bound
  environments such as browser extensions [22].
- **Ship one ES module for evergreen browsers.** MapLibre GL JS v6 dropped
  UMD and CSP bundles for one ESM target [23]; Leaflet 2 is ESM-only with
  no polyfills [18].

## Optional pieces: load on first use, or bake them away

- **Lazy-load a decoder only some data needs.** Bundling Draco raised
  Cesium.js gzip by 18% (722 KB to 865 KB); loading it only inside a
  worker made the build about 40 KB smaller than before [24]. Cesium's
  KTX2 transcoder is created only when KTX2 is used; loading its ES2015
  parser eagerly had broken IE11 for every app [25]. ortho-earth starts
  PLATEAU workers on first request and imports loaders.gl only for a live
  decode: start-up JS with PLATEAU on went from about 1,060 KB to 797 KB,
  plus 221 KB only when a live decode happens [13]; it injects a zstd decoder only when a zstd Parquet page appears [26].
- **Make lazily loadable APIs async from the start.** ortho-earth could
  defer only 7 KB (2% of a chunk) of its 38 KB topology code, because the
  public functions were synchronous and called synchronously in 34 places;
  an earlier attempt did not move the measurement and was reverted [13].
- **Defer whatever the first frame does not use.** tangram-es parsed
  system font config in 135 ms while loading the whole library took 17 ms,
  and moved the parse to first scene load [27]. QGIS's layer dialog walked
  every symbol of every layer at open (37-83 s on 15,040 categories) and
  dropped to under 1 s once the walk waited for the panel to open [28].
  OpenLayers creates its buffer worker on first use [29].
- **Better: do it at bake time and ship the result.** Cesium never merged
  general proj4 projections: about 6,000 added lines of vendored proj4,
  about 25 KB min+gzip (about 3.5% of Cesium.js), and much more memory for
  unusual projections, which took a separate code path from geographic
  and Web Mercator [30].
  HarfBuzz shaping cost MapLibre Native +11% binary and stayed opt-in [31];
  shape at bake time and ship positioned glyphs. reearth-papers translates
  MapLibre styles into renderer recipes at bake time so the WASM ships only
  the renderer [32]. d3-geo's identity projection exists to draw
  pre-projected geometry fast [33]. TerriaJS removed its GDAL conversion
  service and parses the few formats it needs on the client [34].

## Workers: none, one, or inlined

- **Start with zero or one.** MapLibre GL JS cut its default from half the
  cores (up to 6) to one, except Safari, after A/B tests [35]. A renderer
  with baked data rarely needs a worker at all.
- **A worker's start can cost more than its job.** ortho-earth's first
  decode was dominated by worker module evaluation (1,538 ms) against
  26+20 ms to parse on the main thread; it now keeps a small persistent
  pool [36]. Moving Cesium's WASM decoders into workers lowered main-thread
  busy time 4-33% but added tens of ms of cold start [37].
- **Do not let a bundler or a path break the worker.** MapLibre GL JS v6
  requires `setWorkerUrl`; apps that forgot it rendered only the
  background [23]. Cesium inlined worker code into the single file to fix
  cross-origin loading [38]; Tangram builds its worker from a Blob, and a
  Rollup 2 upgrade was reverted because it broke that worker chunk [39].
  deck.gl loads worker code from unpkg by default [40]: a run-time
  dependency this repository forbids.
- **Do not duplicate shared code per worker.** Cesium's workers went from
  2.6 MB to 225 KB gzip once built together with shared chunks [41].
  ortho-earth went from 34 worker builds to 2 with one entry that imports
  its role by worker name; duplicated bytes fell from 2.74 MB (57%) to
  177 KB, and a WASM module inlined as base64 into 7 chunks was emitted
  once as a file (4.81 MB to 3.63 MB) [13].
- **Send flat typed arrays.** ortho-earth's worker start-up for 1,000,000
  features went from 16 s to 1.6 s when attributes moved as one
  typed-array table instead of cloned objects [42].

## GPU start-up

- **Compile both shaders, link, then read `LINK_STATUS` only.** Reading
  `COMPILE_STATUS` after each compile forces the driver to finish it;
  deferring the queries cut MapLibre GL JS's program setup from 26-28 ms to
  19-21 ms for 7 programs (M1 Pro, ANGLE Metal) [43]. Link each program
  once [44].
- **A program-binary cache is a per-device measurement, not a rule.**
  MapLibre Native deleted its cache: 150-180 KB of binary, buggy, and slower
  on some phones (Pixel relaunch 723 ms without, 1,039 ms with) [45]. In
  example 05 on NVIDIA it paid: 183 ms and 166 MB on the first start,
  107 ms and 124 MB after [46]. Keep it only where the bench shows a gain.
- **Ship fixed shaders.** Program caches by source hash (Tangram) and
  faster source assembly (tangram-es, 3x) solve problems of style-built
  shaders that a single-purpose renderer does not have [47][48].
- **`failIfMajorPerformanceCaveat` depends on the fallback.** OpenLayers
  sets it true because it can fall back to Canvas [49]; Cesium reverted to
  false so software-rendered sessions (RDP) still start [50]. A WebGL-only
  renderer with `true` just fails; headless SwiftShader runs need it off,
  and the harness already rejects a software GPU for `gpu: hardware`
  examples [46].

## Fonts, icons and other assets

- **Fonts delay the first frame twice.** Tangram waits for fonts with a
  3-second FontFaceObserver timeout that wrong weight values trigger, and
  rendering before fonts load draws the first tiles in the wrong font [51].
- **Atlases can outweigh the renderer.** openglobus loads its MSDF atlas
  on first label; its regenerated atlas is 2.7 MB against 0.56 MB before
  [52]. deck.gl builds an ASCII atlas at run time with Canvas 2D and
  deleted a 57 KB font image [53]. tangram-es removed a 3 MB fallback font
  [54]. Subset glyphs to the data at bake time, or put a few labels in the
  DOM, as 01-03 do [46].
- **Inline small icons.** Leaflet replaced 1x and 2x PNG markers with SVG
  inlined in the JS [55].
- **Host every asset with the renderer.** reearth-papers' sprite fetch was
  about 227 ms of a 1.7 s cold start and failed whenever GitHub Pages did;
  it now mirrors sprites [56].

## Native and WASM builds

- `-Os` cut MapLibre Native's Apple binaries 17%; LTO, `-Oz` and
  identical-code folding were further wins [57]. At `opt-level z`, navara's
  SIMD flags produced no vector code and no speed-up [58]. tangram-es
  exported 67 symbols instead of about 1,500 [27]. Build for the target
  CPU: Marble's server tool once emitted AVX-512 the server lacked [59].
  For bake tools, PGO cut MLT's converter time 18-25% [4].

## Start early, show something coarse

- tangram-es requests tiles for the view before the scene finishes
  loading [60]. ortho-earth reads coarse world layers first and swaps in
  detail on zoom: world layers 3.5 MB to 0.65 MB, JS 341 KB to 278 KB at
  start [61]. When a bake must happen in the browser, cache it by a
  content hash: 12.2 s to 1.16 s on reopening [62]. GRASS keeps a level
  that streams geometry with no topology, because topology costs memory
  and start-up time [63].

## Tried and reverted

- MapLibre GL JS: WebGL1 removed (v3), re-added (v5), removed (v6) [8].
- MapLibre Native: program-binary cache removed after measurement [45];
  HarfBuzz shaping PR closed, opt-in only [31].
- Leaflet: `eval` templates reverted for CSP [22].
- Tangram: Rollup 2 upgrade reverted over the worker chunk [39].
- Cesium: `failIfMajorPerformanceCaveat: true` reverted [50]; proj4
  projections abandoned [30].
- ortho-earth: lazy import of fallbacks reverted with no measured change
  [13].
- MapLibre GL JS: worker default cut from up to 6 to 1 [35].

## Guidance for a purpose-built renderer here

1. Put `total_gzip_bytes` and `first_frame_ms` in `spec.yaml` whenever the
   request mentions page size, network or start-up, and define where
   `first_frame_ms` starts and stops [2].
2. Look at the code/data split first. With 1-4 KB of code, the next
   kilobyte comes from the data: coarse-first files, quantisation, delta
   coding, fewer requests.
3. One graphics API, chosen in `architecture_selection`, no fallback path,
   a clear error when it is missing. No polyfills, no detection, no
   `eval`, one ES module.
4. Anything optional (decoder, projection, shaper, style translator) is
   done at bake time. Only if it must run in the browser and only some
   data needs it, load it lazily behind an async function.
5. No worker unless the bench shows main-thread jank from decode. If one
   is needed: a single entry, inlined or at an explicit relative URL, fed
   with transferred typed arrays, and its fetches counted by the renderer.
6. Shaders: fixed source, compile both, link, query link status once. Add
   a program-binary cache only for native targets where a cold-start
   bench shows it pays.
7. Fonts and icons: DOM text or a baked subset atlas; inline SVG icons;
   no third-party asset at run time.

## Sources

1. `results/<id>/latest.json` for 01, 02, 03, 04, 07 and b02-maplibre, runs of 2026-10-26 (not committed); `examples/02-world-population-mobile/spec.yaml` (`maplibre-baseline`)
2. `skills/map-from-scratch/references/spec-yaml.md` (footprint and browser metrics)
3. https://github.com/maplibre/navara/pull/713
4. https://github.com/yuiseki/maplibre-tile-spec/commit/7e4250dd, https://github.com/yuiseki/maplibre-tile-spec/commit/5a06589a, https://github.com/yuiseki/maplibre-tile-spec/commit/f642d53f
5. `ref-repos/maplibre__maplibre-native/design-proposals/2022-10-27-rendering-modularization.md`, `ref-repos/maplibre__maplibre-native/design-proposals/2022-11-29-metal-port.md`
6. `ref-repos/KDE__marble/MANIFESTO.txt`, https://invent.kde.org/education/marble/-/blob/master/MANIFESTO.txt
7. `ref-repos/Leaflet__Leaflet/FAQ.md`, `ref-repos/Leaflet__Leaflet/README.md`, `ref-repos/Leaflet__Leaflet/docs/_posts/2012-07-30-leaflet-0-4-released.md`
8. `ref-repos/maplibre__maplibre-gl-js/CHANGELOG.md`, https://github.com/maplibre/maplibre-gl-js/discussions/6017, https://github.com/maplibre/maplibre-gl-js/pull/7453, https://github.com/maplibre/maplibre-gl-js/pull/1891, https://github.com/maplibre/maplibre-gl-js/commit/900b2c8da
9. https://github.com/iTowns/itowns/commit/5bd5c32b, https://github.com/iTowns/itowns/commit/1cf7075f, `ref-repos/iTowns__itowns/changelog.md`, `ref-repos/iTowns__itowns/CODING.md`
10. `ref-repos/openlayers__openlayers/changelog/upgrade-notes.md`, `ref-repos/openlayers__openlayers/changelog/v5.0.0.md`
11. https://github.com/openlayers/ol2/commit/5c42b2f3, https://github.com/openlayers/ol2/blob/master/build/light.cfg
12. https://github.com/visgl/deck.gl/blob/master/dev-docs/roadmaps/dist-size-roadmap.md, https://github.com/visgl/deck.gl/blob/master/docs/developer-guide/building-apps.md, `ref-repos/visgl__deck.gl/docs/developer-guide/building-apps.md`
13. https://github.com/kenjiyoshidahome2026-bit/ortho-earth/issues/12 (comments)
14. https://github.com/maplibre/maplibre-native/pull/547 (conversation comments; "another 100k bytes ... in terms of revenue"), https://github.com/maplibre/maplibre-native/issues/1609
15. https://github.com/maplibre/maplibre-rs/blob/main/docs/src/supported-platforms.md, `ref-repos/maplibre__maplibre-rs/README.md`
16. `ref-repos/openlayers__openlayers/changelog/v3.14.0.md`, `ref-repos/openlayers__openlayers/changelog/v5.0.0.md`, `ref-repos/openlayers__openlayers/changelog/v10.5.0.md`
17. https://github.com/stamen/modestmaps-js/issues/17
18. `ref-repos/Leaflet__Leaflet/docs/_posts/2025-05-18-leaflet-2.0.0-alpha.md`, https://github.com/Leaflet/Leaflet/pull/8826, https://github.com/Leaflet/Leaflet/commit/2c44074e, https://github.com/Leaflet/Leaflet/commit/9f351794, https://github.com/Leaflet/Leaflet/commit/9c58fcdd
19. https://github.com/kenjiyoshidahome2026-bit/ortho-earth/commit/e9fdcfca, https://github.com/kenjiyoshidahome2026-bit/ortho-earth/commit/cfc60789
20. https://github.com/opengeos/RustGIS/pull/70, https://github.com/opengeos/RustGIS/commit/5f498a3
21. https://github.com/opengeos/RustGIS/pull/95
22. https://github.com/Leaflet/Leaflet/issues/2217, `ref-repos/Leaflet__Leaflet/CHANGELOG.md`
23. https://github.com/maplibre/maplibre-gl-js/pull/6254
24. https://github.com/CesiumGS/cesium/pull/6191
25. https://github.com/CesiumGS/cesium/pull/9513
26. https://github.com/kenjiyoshidahome2026-bit/ortho-earth/commit/0dcc93bf, https://github.com/kenjiyoshidahome2026-bit/ortho-earth/commit/b316e2ad
27. https://github.com/tangrams/tangram-es/commit/de7d9483, https://github.com/tangrams/tangram-es/commit/ae94b01e
28. https://github.com/qgis/QGIS/issues/34942, https://github.com/qgis/QGIS/pull/35557, https://github.com/qgis/QGIS/pull/36366
29. https://github.com/openlayers/openlayers/commit/2f7a891b9, https://github.com/openlayers/openlayers/commit/ce2d95ee8
30. https://github.com/CesiumGS/cesium/pull/7502 (comments: proj4 line count, memory), https://github.com/CesiumGS/cesium/pull/6986 (comments: 25 KB gzip + uglify, 3.5% of 713 KB Cesium 1.49)
31. https://github.com/maplibre/maplibre-native/pull/1439
32. https://github.com/reearth/reearth-papers/commit/b82da28, `ref-repos/reearth__reearth-papers/src/ezu.ts`, `ref-repos/reearth__reearth-papers/scripts/ezu-recipes.sh`
33. https://github.com/d3/d3-geo/commit/2c51b71, https://github.com/d3/d3-geo/blob/18eb2fb/README.md#path_projection
34. `ref-repos/TerriaJS__terriajs/packages/terriajs/architecture/0008-remove-conversion-service.md`
35. https://github.com/maplibre/maplibre-gl-js/commit/ae427dc27
36. https://github.com/kenjiyoshidahome2026-bit/ortho-earth/commit/103b127e, https://github.com/kenjiyoshidahome2026-bit/ortho-earth/commit/b036443d
37. https://github.com/CesiumGS/cesium/pull/13669
38. https://github.com/CesiumGS/cesium/commit/07b105ca2b448643db5c2914a37a1583cc94440e, https://github.com/CesiumGS/cesium/commit/18e18021ee46dbf89526921038c34b2e89d0e8f3
39. https://github.com/tangrams/tangram/blob/master/rollup.config.mjs, `ref-repos/tangrams__tangram/rollup.config.mjs`, https://github.com/tangrams/tangram/commit/81ee5a1d, https://github.com/tangrams/tangram/commit/b6405e71
40. https://github.com/visgl/deck.gl/commit/8d824a4b
41. https://github.com/CesiumGS/cesium/commit/aabd27a76, https://github.com/CesiumGS/cesium/pull/8224
42. https://github.com/kenjiyoshidahome2026-bit/ortho-earth/blob/main/packages/geopbf/README.md, `ref-repos/kenjiyoshidahome2026-bit__ortho-earth/packages/geopbf/README.md`
43. https://github.com/maplibre/maplibre-gl-js/commit/73a39c446
44. https://github.com/maplibre/maplibre-native/commit/2a3a1c7bb36410c6037f1d8da46fa68733efbe42
45. https://github.com/maplibre/maplibre-native/commit/c2f974f2a57348213cc02d2472f9c54ba86e6010
46. `skills/map-from-scratch/references/patterns.md` (05 program binary cache; text in the DOM in 01-03), `skills/map-from-scratch/references/pitfalls.md` (WebGPU on SwiftShader)
47. https://github.com/tangrams/tangram/commit/eb148e5f, https://github.com/tangrams/tangram/commit/b2f1b89c
48. https://github.com/tangrams/tangram-es/commit/9c42450a, https://github.com/tangrams/tangram-es/commit/d902d007, https://github.com/tangrams/tangram-es/commit/c6e344e7
49. https://github.com/openlayers/openlayers/commit/d6dc1a2c6
50. https://github.com/CesiumGS/cesium/commit/2b34d0aac
51. https://github.com/tangrams/tangram/pull/757 (comments: FontFaceObserver 3-second timeout, first tile in the wrong font)
52. https://github.com/openglobus/openglobus/commit/517b2eef, https://github.com/openglobus/openglobus/commit/1a0200b4, `ref-repos/openglobus__openglobus/src/utils/FontAtlas.ts`
53. https://github.com/visgl/deck.gl/commit/d1d64502, https://github.com/visgl/deck.gl/commit/c5472c3b
54. https://github.com/tangrams/tangram-es/commit/6e3d59ce, https://github.com/tangrams/tangram-es/commit/dbed0e73
55. https://github.com/Leaflet/Leaflet/commit/e226f77a, https://github.com/Leaflet/Leaflet/commit/c58640e0
56. https://github.com/reearth/reearth-papers/commit/6af6885, `ref-repos/reearth__reearth-papers/mirror/README.md`
57. https://github.com/maplibre/maplibre-native/commit/9d7b77496062b695567f5f688ccb32f64602e3c3, `ref-repos/maplibre__maplibre-native/platform/ios/CHANGELOG.md`, `ref-repos/maplibre__maplibre-native/platform/android/CHANGELOG.md`
58. https://github.com/maplibre/navara/pull/814
59. https://github.com/KDE/marble/commit/253a4b164
60. https://github.com/tangrams/tangram-es/commit/24c09da4, https://github.com/tangrams/tangram-es/commit/c8896b23
61. https://github.com/kenjiyoshidahome2026-bit/ortho-earth/commit/2761c981, https://github.com/kenjiyoshidahome2026-bit/ortho-earth/commit/d265b75d
62. https://github.com/kenjiyoshidahome2026-bit/ortho-earth/commit/6d398c83
63. `ref-repos/OSGeo__grass/lib/vector/vectorlib.dox`
