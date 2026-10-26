---
name: api-design-and-extensibility
description: What 40-odd map engines learnt about how much surface a renderer should expose (graphics backends, options, plugin hooks, data handed across worker/WASM/JNI boundaries, mutability, embedding constraints, integration with another engine) and which of those surfaces they later cut. Load it when a map-from-scratch request asks for a renderer to be embedded in someone else's page or app, reused as a small library, given options, layers, overlays or a plugin hook, fed data by host code, laid over or under another map engine, or when you are tempted to add a fallback backend, a run-time switch or a configuration knob "just in case".
---

# API design and extensibility: how much surface to give a renderer

A general engine is a public API first: every option, backend, layer type and
plugin hook is a promise it must keep across versions, and most of the history
mined here is engines paying for promises they made too early. They kept two
graphics backends alive, exposed internals, accepted any data shape and
deep-compared it, let callers mutate geometry every frame, and then spent
major versions taking it back. A map-from-scratch renderer serves one request,
so most of this surface should not exist: `spec.yaml` is its contract,
`architecture_selection.not_doing` is its scope, and the baked file is its
data API [112]. This skill is for the moments when some surface is still
needed (an embed, a host app feeding data, an overlay, an option the request
asks for) and for resisting surface that is not. Per-engine detail is in
[references/engines.md](references/engines.md); the numbers in brackets point
to the Sources list at the end of this file. Neighbouring skills go deeper on
parts of this: `vector-tile-encoding` (format versioning), `data-range-requests`
(container readers), `projection-and-globe` (CRS hooks), `draw-order-and-depth`
(sharing a depth buffer with another engine).

## 1. First decision: who calls this renderer?

| The request | Surface to build |
| --- | --- |
| A page or app made for the request, nothing else calls it | None. Constants in code, data in the baked file, `not_doing` in `spec.yaml`. |
| Embedded in someone else's page (a widget, an article map) | One entry function taking one options object, no globals, no `eval`, no required COOP/COEP, works from static files (section 5). |
| Host code supplies data at run time (app, native shell, worker) | One binary buffer in the renderer's own layout per call, cancellable; never GeoJSON or per-feature objects (section 3). |
| Must sit over or under another engine's map | Decide who owns the camera and the GL context first (section 6). |
| Users add their own drawing | A narrow "here is the context and camera, draw" hook in the same frame, not exposed internals (section 6). |

Write the non-goals before the API. Engines that wrote them early stayed
small; engines that grew first spent releases removing:

- deck.gl's TileLayer roadmap states it is "NOT intended to be a full
  replacement for a base map ... long tail of features" [44], and when
  deck.gl finally accepted an MVT layer it listed what it would not do:
  labels along paths, repeating worlds at low zoom [41].
- Marble's manifesto limits the feature set to its primary user: top-down
  viewing only, no 3D flights, because "most users don't need them ... or
  don't even discover that feature" [61].
- protomaps-leaflet 2.0 "aggressively reduces the scope": interaction,
  MapLibre JSON styles (311 lines deleted), client-side simplification and
  the inspector were removed; the project later went into maintenance mode
  and points everyone else to MapLibre GL JS [100].
- Leaflet never added map rotation to core because it changes mouse and
  touch transforms, bounds, tile cover (no longer a rectangle) and clipping;
  users who needed it ran a fork with blur and getBounds drift [94].

## 2. One graphics backend, the newest the devices have

Every engine that kept two backends paid twice, and most converged on one.

- **MapLibre GL JS** went WebGL2-only in v3, re-added a WebGL1 fallback with a
  `contextType` option in v5, and removed it again in v6: "usage of the legacy
  path had plateaued, so maintaining it no longer justified the added
  complexity" [1]. Dropping it enabled line-opacity and Terrain3D work; the
  constructor now throws a catchable `GPUInitializationError` [1]. The earlier
  fallback PR cited WebGL2 at about 94% on caniuse and asked that WebGL1 code
  stay in one place so it could be deleted [2]. headless-gl had no WebGL2, so
  tests moved to a real headless browser [2].
- **MapLibre Native** moved its shaders to `#version 300 es` for UBOs and VAOs,
  knowingly leaving macOS broken on main until Metal landed and keeping ES2 on
  a side branch [13]. **Cesium** requests WebGL2 and falls back to WebGL1, and
  MSAA, voxels and async picking work only on WebGL2, so features fork by
  context [30]. **OpenLayers** added a 16-bit index fallback for missing
  `OES_element_index_uint` and removed it three weeks later, raising an error
  in the "unlikely scenario" it is absent [75].
- **No abstraction layer for size.** MapLibre Native rejected a cross-API
  toolkit because "quite a few users cannot abide with the toolkit growing
  considerably", with a budget of at most 5% binary growth, no start-up
  increase and no frame-rate loss [6]. Users "have calculations on what
  another 100k bytes will cost them in terms of revenue", so bgfx and
  MetalANGLE were also rejected; the early native Metal build was then slower
  than MetalANGLE, with freezes up to a second [8]. It wrote Metal shaders by
  hand rather than transpile GLSL designed "off a fairly old model of how
  GPUs work" [6], and now ports symbol-shader changes to each backend
  separately [11]. maplibre-rs took the other road (wgpu everywhere) and calls
  itself a proof of concept, with iOS and Android gaps [14].
- **No run-time renderer switch.** OpenLayers 5 removed the Map `renderer`
  option because "code for both the Canvas and WebGL renderers was included in
  all applications - even though most people only use one" [67]. OpenLayers 6
  deleted its full WebGL map renderer (7,738 lines in one commit) and rebuilt
  WebGL bottom-up from a points-only layer, the one case Canvas 2D is bad at
  [66]. maptalks went the other way and dropped its Canvas 2D layers, because
  one canvas per layer composited by the page "significantly lowers frame
  rate" with many layers [109]. Leaflet removed `preferCanvas` in favour of
  passing an explicit renderer instance [99].
- **Optional effects stay optional.** ortho-earth implements atmosphere, PBR,
  AO and shadows only for WebGPU, keeps the GL2 path minimal, and defaults
  every effect off, enabled by URL or options; for two of the stages,
  limiting them to WebGPU instead of writing both paths was estimated to cut
  the work by 30-40% [50].

## 3. Data across boundaries: bytes in your own layout

Whatever crosses a worker, WASM, JNI or host-app boundary should be one sized
binary buffer in the renderer's format, owned by one side.

- MapLibre Native's CustomVectorSource lets the app hand MVT bytes per tile
  through the normal decoder with cooperative cancellation, replacing a
  GeoJSON source that re-encoded data into tiles on its own thread pool [10].
  A custom URL scheme was rejected because it "requires the application to
  write tile data to disk ... adds I/O overhead, doesn't support cooperative
  cancellation" [10].
- navara never exposes wasm-bindgen classes: public functions take and return
  plain objects, and wrappers call `.free()` before returning, removing
  use-after-free and leak hazards at some conversion cost [20]. It computes
  zoom once in Rust instead of a JS approximation that could diverge, and
  reads it across the boundary only while the UI that needs it is open [22].
- tangram-es addresses markers by non-recycled integer IDs rather than
  pointers, so removal and scene reloads cannot leave dangling handles [107].
  A native pointer passed to Java as a signed long must be checked `!= 0`,
  not `> 0`: top-byte pointer tagging on Android 11 made valid pointers
  negative and crashed map creation [108].
- MapLibre Native shares immutable `Impl` snapshots between main, worker and
  render threads instead of locks or copies; a change allocates a new one
  [9]. If a renderer has a worker, transfer immutable buffers.
- ortho-earth normalises every tile format to one intermediate geometry
  (`Int32Array` coords plus ring ends) through `registerTileFormat`, keeps MLT
  in a separate package so core gains no dependency, and never sniffs bytes:
  the format comes from the style's `encoding` or the PMTiles tile type [49].
  MapLibre Native's maintainers lean the same way against HTTP `Accept`
  negotiation for MVT vs MLT: separate endpoints keep caching and debugging
  deterministic [12].
- Keep container and payload apart. navara's PMTiles crate knows only the
  spec and stops at returning bytes; decoding MVT or raster lives elsewhere
  [21]. One archive reader per archive per page: protomaps-leaflet accepts a
  PMTiles instance so the app and the renderer stop fetching the header and
  directory twice [102]. navara's Source/Layer split lets many layers share one
  fetch and cache, at the price of ref-count lifecycle rules [19].
- Push foreign formats out of the runtime. RustGIS links neither GDAL nor
  DuckDB; it shells out once to produce an indexed FlatGeobuf or
  Hilbert-sorted GeoParquet and streams that, keeping its WASM build intact
  [24]. The GRASS vector author later called attributes in an external RDBMS
  a mistake: "either everything must be stored in RDBMS ... or nothing", and
  random access over the server was "terribly slow" [55].

## 4. Mutability and change detection

- **Identity, not deep equality.** deck.gl removed `lodash.isequal` on layer
  data as a "performance bottleneck"; layers now shallow-compare and the app
  passes the same object when nothing changed [43]. Key updates on a version
  number.
- **Immutable by construction.** Cesium froze `ClippingPolygon` positions so
  per-frame, per-vertex change checks could go, with "vast performance
  improvements" and a breaking change; an earlier PR had added
  `Object.freeze` and removed it again before it came back [32]. Cesium's
  experimental Buffer*Collection and GeoJsonPrimitive bypass the per-object
  Entity layer for "significantly improved performance with large datasets",
  with batch `setPositions` and a precomputable bounding volume [31].
- **Per-object cost shows up first.** Leaflet's 1.0 pass made LatLng creation
  about 8x faster by dropping `parseFloat`, inherited options instead of
  copying them, and made FeatureGroup adds 10x faster [93][97]. Folding
  MultiPolygon into one path object per feature made "layers with multiple
  rings ... perform much better" [86].
- **Idle means no work.** Cesium's `requestRenderMode` renders only on events
  so "idle is truly idle, 0% CPU usage"; porting one app took about 80
  `requestRender` calls, and automatic per-entity subscriptions were declined
  because they made browsers "gobble up memory" [33]. Here, draw only when
  something changed, and make load completion an event [113].
- **Zero is a value.** deck.gl's `maxCacheSize: 0` silently became the
  default because of `||`; it now uses `??` [45].
- **Display and export need different data.** QGIS simplifies only for
  interactive screen rendering, never for editing, snapping or print export:
  users accept a one-minute print, not a one-minute screen render [51]. If a
  request has an export or analysis path, give it full-resolution data.

## 5. Constraints of being embedded

- **No code generation at run time.** OpenLayers 2.14 removed `eval` from
  cloning so it runs under Content Security Policy [79]; Leaflet 0.7.1
  reverted an `eval`-based template optimisation whose gain was
  "insignificant" [88]. Generate shaders and templates at bake or build time.
- **No required cross-origin isolation.** ortho-earth's only
  SharedArrayBuffer use is a zero-copy hand-off; without isolation it copies
  once, and a 7-page test asserted the fallback actually ran. Requiring COEP
  would break host pages' ads, video and analytics, and Safari never sets
  `crossOriginIsolated` with `credentialless` [46]. This repository's GitHub
  Pages have no COOP/COEP either [112].
- **No dependencies, no singletons.** Modest Maps was under 7 KB gzip and
  minified with its own helpers, and its maintainers were reluctant to require
  jQuery: "size might be a bad motivation", "small libraries please; the
  browser is the framework already" [111]. Tangram's global singletons (VAO
  cache, render state, textures) blocked several maps per page, and a VAO
  cache that survived layer removal caused out-of-range draws [103]. Keep
  every GL cache keyed to its context.
- **Evergreen platform APIs, feature detection.** Leaflet 2.0 is ESM-only,
  drops VML, polyfills and almost all browser detection, and uses
  ResizeObserver, after two and a half years of work; users of outdated
  plugins are pointed to a V1 polyfill [90]. Its input moved to Pointer
  Events only, with pinch tracking active pointers by `pointerId` [96]. A
  one-line WebKit sniff to dodge iOS 13 pointer bugs was reverted for real
  fixes [98].
- **Async from the start if anything may load lazily.** ortho-earth could not
  lazy-load about 38 KB of geopbf extensions because `merge` and friends are
  synchronous, called synchronously in 34 places; inside the 1.x contract only
  7 KB (2% of the chunk) could be deferred [47].

## 6. Living with another engine

- **One context, one projection, or no shared depth.** Making deck.gl layers
  occlude a harp.gl basemap's buildings needed one shared WebGL context, a
  redraw hook that does not clear, and matching near/far/fov every frame;
  the thread ran 61 comments over about four months and mismatched far planes
  still left artifacts [37]. Driving Google Maps from deck.gl's camera avoided
  one-frame lag, but integer `setZoom` made the basemap jump between zooms
  [39]. If the request needs both layers, draw both in one renderer.
- **Public hooks only.** deck.gl wrote a separate MapLibre package on public
  custom-layer APIs after v6 removed the private `map.transform` it relied on
  [38]. OpenLayers 2.13 stopped editing Google's DOM and added its own
  viewport as a Google control [80]. Re:Earth's visualizer forked Cesium and
  must pin `@cesium/engine` 26.3.0 because 26.4.0 dropped about 20 exports
  [28].
- **Same-frame user drawing.** ortho-earth runs user overlay modules inside
  the render worker's rAF on a second OffscreenCanvas with the same camera;
  drawing them on main lagged the globe by 1-2 frames [48]. MapLibre Native
  removed its custom drawable API for a narrow C plugin API shipped only in
  separate artifacts [11].
- **Host-supplied I/O.** maplibre-native's HTTPS stack failed in Cloudflare
  Workers Containers (`SSL_ERROR_SYSCALL`, then `std::terminate`), and a day
  went into a loopback proxy; a renderer that does no I/O of its own avoids
  the class [27]. In a UI framework, assign async GPU resources imperatively
  when they resolve: Re:Earth replaced `setTimeout(0)` and 100 ms polling
  workarounds with a ref assignment [29].

## 7. If you do expose options

- One options object, never growing positional arguments: OpenLayers moved
  `forEachFeatureAtPixel` to `{layerFilter, hitTolerance}` because the
  signature was "already pretty awful" [69]; ol2 made single-argument
  constructors "the way forward" [83].
- An enum where a boolean will grow: Cesium replaced a proposed
  `clampToGround` boolean with `HeightReference` (NONE, CLAMP_TO_GROUND,
  RELATIVE_TO_GROUND) to cover KML altitude modes [34]. Conversely, where one
  boolean suffices, stop there: MapLibre removed per-layer collision groups
  from the style spec a month after adding them, for one
  `crossSourceCollisions` map option [5].
- List forwarded options explicitly: deck.gl's GeoJsonLayer can be "missing a
  feature but never broken" when a sublayer changes [40].
- Bound requests by the data's own manifest: deck.gl clamps user min/max zoom
  to the TileJSON range [42].
- Expose a knob only when a use case exists. navara rolled splat LoD options
  back to a boolean ("lod: boolean is the minimum API (YAGNI)") and cut the
  demo payload from about 100 MB to 11 MB [23]. MLT's encoder profiles were
  removed as "too early ... it just gets in the way" and reintroduced only
  once choices were priced per client and network [18]. OpenLayers removed
  `@api` from its WebGL helpers so internals could change [70].

## 8. Version the data, not the API

- A baked format that may outlive one renderer build needs a version tag per
  chunk. MLT frames start with size then tag, unknown tags are skipped, and a
  finalised tag never changes; new capabilities get a new tag [17]. GRASS
  stores a codec id per file so readers dispatch on it, and must support
  every codec ever written [59]. If bake and renderer always ship together,
  one hard-coded layout is enough.
- Derive cache identity from content. Re:Earth's tile service keys published
  styles by a content hash plus a renderer version: the hash alone missed
  renderer changes, and an hour-long manifest memo made isolates disagree
  (404 vs 200) [26].

## 9. Tried and reverted

| Engine | Tried | Went back to |
| --- | --- | --- |
| MapLibre GL JS | WebGL1 fallback re-added in v5 [1] | WebGL2 only in v6 [1] |
| MapLibre GL JS | Per-layer collision groups in the style spec [5] | One map-level boolean [5] |
| OpenLayers | Full WebGL map renderer (v3.20, five months of work) [66] | Points-only WebGL layer, grown again later [66] |
| OpenLayers | 16-bit index fallback [75] | Always 32-bit, error if missing [75] |
| Leaflet | `eval` template compilation [88] | Plain templates, CSP-safe [88] |
| Leaflet | WebKit UA sniff for iOS 13 pointers [98] | Direct fixes with `isPrimary` [98] |
| Cesium | `Object.freeze` on clipping positions, removed [32] | Frozen again, per-frame checks gone [32] |
| MLT | Encoder profiles, then a bag of bools [18] | Profiles per client and network [18] |
| navara | Several splat LoD knobs [23] | One boolean [23] |
| MapLibre Native | Custom drawable layer API [11] | Narrow C plugin API, separate artifacts [11] |
| protomaps-leaflet | MapLibre JSON styles, interaction [100] | Code symbolizers, no interaction [100][101] |

## 10. Guidance for a map-from-scratch renderer

1. **Write `not_doing` first and treat it as the API** [112]. Include
   rotation, tilt, world wrap, second projection, interaction modes and
   backends you will not support; each one removed subsystems in the engines
   above [61][94].
2. **Target one graphics API**: WebGL2 for browsers (or GLES3, or the
   device's own), no fallback path; when context creation fails, show an
   error and emit a failing check [1][2]. Add WebGPU only if the request needs
   it and say it is measured on SwiftShader here.
3. **Choose backends at build time**, never with a run-time switch that ships
   both [67].
4. **Data enters as one buffer in the baked layout**; format is chosen by
   file name or a version byte, never sniffed or negotiated [10][12][49].
   Version per chunk only if bake and renderer may ship separately [17].
5. **Baked data is immutable**; replace whole buffers on change and key
   updates by version, never deep-compare [32][43].
6. **No per-feature objects**: typed arrays, attributes looked up on pick
   [31][93].
7. **If embedded**: one entry function with one options object, no globals or
   singletons, no `eval`/`new Function`, no required COOP/COEP, async where
   loading may be lazy, Pointer Events [46][47][69][79][96][103].
8. **If the host feeds data or draws extra**: integer handles, cancellable
   byte buffers, and a same-frame draw hook rather than exposed internals
   [11][48][107].
9. **Add an option only when the request names it**, and record why in
   `architecture_selection` [23].

## Sources

MapLibre GL JS
1. `ref-repos/maplibre__maplibre-gl-js/CHANGELOG.md`; https://github.com/maplibre/maplibre-gl-js/discussions/6017; https://github.com/maplibre/maplibre-gl-js/pull/7453; https://github.com/maplibre/maplibre-gl-js/commit/900b2c8da
2. https://github.com/maplibre/maplibre-gl-js/pull/1891
3. `ref-repos/maplibre__maplibre-gl-js/developer-guides/custom-crs.md`; `ref-repos/maplibre__maplibre-gl-js/ARCHITECTURE.md`
4. https://github.com/maplibre/maplibre-gl-js/issues/168; https://makewithmaplibre.com/projections/
5. https://github.com/maplibre/maplibre-gl-js/commit/efd1359c3; https://github.com/maplibre/maplibre-gl-js/commit/003d3ce2a

MapLibre Native
6. `ref-repos/maplibre__maplibre-native/design-proposals/2022-10-27-rendering-modularization.md`; `ref-repos/maplibre__maplibre-native/design-proposals/2022-11-29-metal-port.md`
7. `ref-repos/maplibre__maplibre-native/platform/ios/CHANGELOG.md`; https://github.com/maplibre/maplibre-native/pull/3384
8. https://github.com/maplibre/maplibre-native/pull/547; https://github.com/maplibre/maplibre-native/issues/1609
9. `ref-repos/maplibre__maplibre-native/ARCHITECTURE.md`; `ref-repos/maplibre__maplibre-native/platform/android/CHANGELOG.md`
10. `ref-repos/maplibre__maplibre-native/design-proposals/2025-07-05-custom-vector-source.md`; https://github.com/maplibre/maplibre-native/commit/9ef0f1c79
11. `ref-repos/maplibre__maplibre-native/design-proposals/2025-05-08-plugin-layers.md`; `ref-repos/maplibre__maplibre-native/platform/ios/CHANGELOG.md`; `ref-repos/maplibre__maplibre-native/platform/android/CHANGELOG.md`; `ref-repos/maplibre__maplibre-native/docs/mdbook/src/platforms/android/android-build-flavors.md`
12. https://github.com/maplibre/maplibre-native/issues/4236
13. https://github.com/maplibre/maplibre-native/pull/995; https://github.com/maplibre/maplibre-native/pull/3838

maplibre-rs
14. https://github.com/maplibre/maplibre-rs/blob/main/docs/src/supported-platforms.md; `ref-repos/maplibre__maplibre-rs/README.md`
15. https://github.com/maplibre/maplibre-rs/issues/53; https://github.com/maplibre/maplibre-rs/pull/99; https://github.com/maplibre/maplibre-rs/issues/185; https://github.com/maplibre/maplibre-rs/issues/305
16. https://github.com/maplibre/maplibre-rs/issues/96

MapLibre Tile (MLT)
17. https://github.com/maplibre/maplibre-tile-spec/blob/main/docs/overview.md; `ref-repos/yuiseki__maplibre-tile-spec/docs/overview.md`; https://github.com/maplibre/maplibre-tile-spec/blob/main/rust/mlt-core/README.md; `ref-repos/yuiseki__maplibre-tile-spec/rust/mlt-core/README.md`
18. https://github.com/yuiseki/maplibre-tile-spec/commit/bd720d33; https://github.com/yuiseki/maplibre-tile-spec/commit/3c436932; https://github.com/yuiseki/maplibre-tile-spec/commit/4f30e61d; https://github.com/yuiseki/maplibre-tile-spec/commit/85684b59

navara
19. https://github.com/maplibre/navara/blob/main/guide/ARCHITECTURE.md; https://github.com/maplibre/navara/blob/main/CHANGELOG.md
20. https://github.com/maplibre/navara/blob/main/guide/WASM_API_POLICY.md; `ref-repos/maplibre__navara/guide/WASM_API_POLICY.md`
21. https://github.com/maplibre/navara/pull/637
22. https://github.com/maplibre/navara/commit/68db6b80
23. https://github.com/maplibre/navara/commit/c2b79649

RustGIS
24. `ref-repos/opengeos__RustGIS/docs/user-guide/data.md` (Formats through GDAL); `ref-repos/opengeos__RustGIS/ROADMAP.md`
25. `ref-repos/opengeos__RustGIS/docs/architecture.md`

Re:Earth
26. https://github.com/reearth/reearth-papers/commit/9f63562; https://github.com/reearth/reearth-papers/commit/4e9fcb0; https://github.com/reearth/reearth-papers/commit/89e5870; https://github.com/reearth/reearth-papers/commit/c06d53d; `ref-repos/reearth__reearth-papers/CONTRIBUTING.md`
27. https://github.com/reearth/reearth-papers/commit/ade7313; `ref-repos/reearth__reearth-papers/CONTRIBUTING.md`
28. https://github.com/reearth/reearth-visualizer/pull/2467; https://github.com/reearth/reearth-visualizer/commit/15bf8799
29. https://github.com/reearth/reearth-visualizer/pull/2276

Cesium
30. `ref-repos/CesiumGS__cesium/CHANGES.md`; https://github.com/CesiumGS/cesium/pull/10894; https://github.com/CesiumGS/cesium/pull/12983
31. `ref-repos/CesiumGS__cesium/CHANGES.md`; https://github.com/CesiumGS/cesium/pull/13212; https://github.com/CesiumGS/cesium/pull/13505; https://github.com/CesiumGS/cesium/pull/13477
32. https://github.com/CesiumGS/cesium/pull/13665; https://github.com/CesiumGS/cesium/pull/13654; https://github.com/CesiumGS/cesium/commit/a21f4d9d92cb2baaf6c0b65588d0cb01c545d0aa; https://github.com/CesiumGS/cesium/commit/351c0acc7f82af568a7c78b836c4eddf19b9d819
33. https://github.com/CesiumGS/cesium/pull/6115
34. https://github.com/CesiumGS/cesium/pull/2653
35. https://github.com/CesiumGS/cesium/pull/13404; https://github.com/CesiumGS/cesium/pull/4186
36. https://github.com/CesiumGS/cesium/commit/f594b3c99

deck.gl
37. https://github.com/visgl/deck.gl/issues/4603
38. https://github.com/visgl/deck.gl/pull/10566
39. https://github.com/visgl/deck.gl/pull/2179
40. https://github.com/visgl/deck.gl/pull/5835
41. https://github.com/visgl/deck.gl/pull/3935
42. https://github.com/visgl/deck.gl/pull/4967
43. https://github.com/visgl/deck.gl/commit/7ecadd89; `ref-repos/visgl__deck.gl` at 43fd968b: `docs/advanced/performance.md`
44. https://github.com/visgl/deck.gl/commit/05ca54e0
45. https://github.com/visgl/deck.gl/commit/68533ae0

ortho-earth (GPL-3; may be adapted here, see the repository licence note)
46. https://github.com/kenjiyoshidahome2026-bit/ortho-earth/blob/main/packages/ortho-core/fallback-ladder.md; `ref-repos/kenjiyoshidahome2026-bit__ortho-earth/packages/ortho-core/fallback-ladder.md`
47. https://github.com/kenjiyoshidahome2026-bit/ortho-earth/issues/12
48. https://github.com/kenjiyoshidahome2026-bit/ortho-earth/issues/13
49. https://github.com/kenjiyoshidahome2026-bit/ortho-earth/issues/88
50. https://github.com/kenjiyoshidahome2026-bit/ortho-earth/issues/46 (body: effects off by default, WebGPU only; comments: WebGPU only cuts the work by 30-40%)

QGIS
51. https://github.com/qgis/QGIS/issues/17441; https://github.com/qgis/QGIS/pull/980
52. https://github.com/qgis/QGIS/pull/63749

GRASS
53. `ref-repos/OSGeo__grass/lib/raster/rasterlib.dox`; https://github.com/OSGeo/grass/blob/main/lib/raster/rasterlib.dox
54. `ref-repos/OSGeo__grass/lib/vector/vectorlib.dox`
55. `ref-repos/OSGeo__grass/doc/vector/TODO`; https://github.com/OSGeo/grass/blob/main/doc/vector/TODO
56. https://github.com/OSGeo/grass/pull/3929
57. https://github.com/OSGeo/grass/pull/6480
58. https://github.com/OSGeo/grass/pull/2392
59. https://github.com/OSGeo/grass/commit/689d9593c; https://github.com/OSGeo/grass/commit/3da035643; https://github.com/OSGeo/grass/commit/70f29a0a3; https://github.com/OSGeo/grass/commit/fb033976a
60. https://github.com/OSGeo/grass/commit/3a87c5342; https://github.com/OSGeo/grass/commit/767432b2f; https://github.com/OSGeo/grass/commit/f337eee00

Marble
61. `ref-repos/KDE__marble/MANIFESTO.txt`; https://invent.kde.org/education/marble/-/blob/master/MANIFESTO.txt
62. `ref-repos/KDE__marble/docs/layermanagement.txt`; https://invent.kde.org/education/marble/-/blob/master/docs/layermanagement.txt
63. `ref-repos/KDE__marble/docs/dgml2.txt`; https://invent.kde.org/education/marble/-/blob/master/docs/dgml2.txt
64. https://github.com/KDE/marble/commit/5ded04e18; https://github.com/KDE/marble/commit/9f6972276; https://github.com/KDE/marble/commit/06da643b3
65. https://github.com/KDE/marble/commit/7244fd48c; https://github.com/KDE/marble/commit/aa5585a61

OpenLayers
66. `ref-repos/openlayers__openlayers/changelog/upgrade-notes.md`; `ref-repos/openlayers__openlayers/changelog/v3.20.0.md`; `ref-repos/openlayers__openlayers/changelog/v6.0.0.md`; `ref-repos/openlayers__openlayers/changelog/v7.0.0.md`; https://github.com/openlayers/openlayers/commit/7fa2189fe; https://github.com/openlayers/openlayers/commit/71270efa7
67. `ref-repos/openlayers__openlayers/changelog/upgrade-notes.md`; `ref-repos/openlayers__openlayers/changelog/v5.0.0.md`
68. `ref-repos/openlayers__openlayers/changelog/upgrade-notes.md`; `ref-repos/openlayers__openlayers/changelog/v6.0.0.md`
69. https://github.com/openlayers/openlayers/pull/5995; https://github.com/openlayers/openlayers/issues/5862
70. https://github.com/openlayers/openlayers/pull/13461
71. https://github.com/openlayers/openlayers/issues/3533
72. https://github.com/openlayers/openlayers/pull/11810; https://github.com/openlayers/openlayers/pull/12008
73. https://github.com/openlayers/openlayers/pull/3015
74. `ref-repos/openlayers__openlayers/changelog/v6.0.0.md`; `ref-repos/openlayers__openlayers/changelog/upgrade-notes.md`
75. https://github.com/openlayers/openlayers/commit/03e70bd10; https://github.com/openlayers/openlayers/commit/2412fe021

OpenLayers 2
76. https://github.com/openlayers/ol2/blob/master/lib/OpenLayers/Layer/Vector.js; https://github.com/openlayers/ol2/blob/master/lib/OpenLayers/Control/Graticule.js; https://github.com/openlayers/ol2/blob/master/notes/2.14.md
77. https://github.com/openlayers/ol2/blob/master/notes/2.12.md; https://github.com/openlayers/ol2/blob/master/notes/2.14.md
78. https://github.com/openlayers/ol2/blob/master/notes/2.12.md; https://github.com/openlayers/ol2/pull/101
79. https://github.com/openlayers/ol2/blob/master/notes/2.14.md
80. https://github.com/openlayers/ol2/blob/master/notes/2.12.md; https://github.com/openlayers/ol2/blob/master/notes/2.13.md; https://github.com/openlayers/ol2/blob/master/notes/2.14.md
81. https://github.com/openlayers/ol2/issues/1080
82. https://github.com/openlayers/ol2/issues/483
83. https://github.com/openlayers/ol2/pull/244
84. https://github.com/openlayers/ol2/commit/a309b240

Leaflet
85. `ref-repos/Leaflet__Leaflet/CHANGELOG.md`; https://github.com/Leaflet/Leaflet/pull/2290; `ref-repos/Leaflet__Leaflet/docs/_posts/2012-10-25-leaflet-0-4-5-bugfix-release-and-plans-for-0.5.md`
86. `ref-repos/Leaflet__Leaflet/CHANGELOG.md`
87. `ref-repos/Leaflet__Leaflet/docs/reference.html`; https://github.com/Leaflet/Leaflet/pull/8611
88. https://github.com/Leaflet/Leaflet/issues/2217; `ref-repos/Leaflet__Leaflet/CHANGELOG.md`
89. `ref-repos/Leaflet__Leaflet/docs/_posts/2016-09-27-leaflet-1.0-final.md`; `ref-repos/Leaflet__Leaflet/docs/_posts/2013-11-18-leaflet-0-7-released-plans-for-future.md`
90. `ref-repos/Leaflet__Leaflet/docs/_posts/2025-05-18-leaflet-2.0.0-alpha.md`; https://github.com/Leaflet/Leaflet/pull/8826
91. https://github.com/Leaflet/Leaflet/pull/2247; https://github.com/Leaflet/Leaflet/pull/2345; `ref-repos/Leaflet__Leaflet/CHANGELOG.md`
92. `ref-repos/Leaflet__Leaflet/docs/examples/extending-2-layers/index.md`; https://github.com/Leaflet/Leaflet/pull/2247
93. `ref-repos/Leaflet__Leaflet/CHANGELOG.md`; https://github.com/Leaflet/Leaflet/pull/2300; https://github.com/Leaflet/Leaflet/pull/3109
94. https://github.com/Leaflet/Leaflet/issues/268
95. https://github.com/Leaflet/Leaflet/issues/2553
96. https://github.com/Leaflet/Leaflet/issues/7200
97. https://github.com/Leaflet/Leaflet/commit/d662e005; https://github.com/Leaflet/Leaflet/commit/d0e72934; https://github.com/Leaflet/Leaflet/commit/f631513a; https://github.com/Leaflet/Leaflet/commit/d4fe4cb8; https://github.com/Leaflet/Leaflet/commit/0210071d
98. https://github.com/Leaflet/Leaflet/commit/747b1f73; https://github.com/Leaflet/Leaflet/commit/95c43663
99. https://github.com/Leaflet/Leaflet/commit/aed3418b; `ref-repos/Leaflet__Leaflet/src/map/Map.js`

protomaps-leaflet
100. https://github.com/protomaps/protomaps-leaflet/issues/112; https://github.com/protomaps/protomaps-leaflet/pull/129; `ref-repos/protomaps__protomaps-leaflet/CHANGELOG.md`
101. `ref-repos/protomaps__protomaps-leaflet/GUIDE.md`
102. https://github.com/protomaps/protomaps-leaflet/issues/6; `ref-repos/protomaps__protomaps-leaflet/CHANGELOG.md`

Tangram, tangram-es
103. https://github.com/tangrams/tangram/issues/350; https://github.com/tangrams/tangram/issues/280
104. https://github.com/tangrams/tangram-es/pull/1015
105. https://github.com/tangrams/tangram-es/pull/267
106. https://github.com/tangrams/tangram-es/pull/1526
107. https://github.com/tangrams/tangram-es/pull/930
108. https://github.com/tangrams/tangram-es/issues/2215; https://github.com/tangrams/tangram-es/pull/2217

maptalks, Kothic, Modest Maps
109. https://github.com/maptalks/maptalks.js/issues/2471; `ref-repos/maptalks__maptalks.js/README.md`
110. https://github.com/kothic/kothic-js/commit/2400e05; https://github.com/kothic/kothic-js/commit/9d2379b
111. https://github.com/stamen/modestmaps-js/issues/17 (comments)

This repository
112. `skills/map-from-scratch/SKILL.md` (rules; `architecture_selection.not_doing`; GitHub Pages without COOP/COEP); `skills/map-from-scratch/references/spec-yaml.md` (`not_doing`)
113. `skills/map-from-scratch/references/patterns.md` (draw only when something changed)
