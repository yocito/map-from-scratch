# API design and extensibility: engine by engine

Detail behind [../SKILL.md](../SKILL.md). Numbers in brackets point to the
Sources list in that file. Each entry gives the decision, its cost, and the
evidence the engine recorded.

## MapLibre GL JS

- **WebGL1, three times.** v3 moved to WebGL2, v5 added a dual-stack runtime
  with a WebGL1 fallback and a `contextType` option, v6 removed WebGL1 again
  (RFC discussion 6017, PR 7453). Dropping it simplified code and unblocked
  line opacity, Terrain3D work and bug fixes; devices without WebGL2 now get a
  catchable `GPUInitializationError` from the constructor [1].
- **The original WebGL2 PR** requested WebGL2 first and fell back to WebGL1,
  citing caniuse WebGL2 at about 93.96%. Reviewers asked that the WebGL1 logic
  live in one place for later deletion. Gains: custom layers and deck.gl
  interop needing WebGL2, a path to MRT. Costs: headless-gl had no WebGL2 so
  render tests moved to a real headless browser, and two code paths while both
  were supported [2].
- **Custom CRS through one seam.** All lng/lat to world conversions go through
  a `WorldCoordinateHelper`; a registered CRS shares Mercator's shaders and
  tile mesh because pre-projected tiles are already a quad grid. Mercator
  keeps calling its original functions, pinned by a unit test against captured
  outputs (one known last-bit difference). Limits: square power-of-two grids,
  one CRS per map, no wrap, no globe; box projection samples 17x17 because
  corners are not enough in curved CRSs [3]. The public `addProjection`
  (project/unproject plus tile matrix origin and extent) shipped in 6.15 as
  experimental after the issue had been open since 2021; proj4 is never
  bundled and nothing is reprojected in the client [4].
- **Collision groups.** `icon/text-collision-group` style properties were added
  in April 2018 and removed in May 2018 for one global
  `crossSourceCollisions` map option (group by source) [5].

## MapLibre Native

- **Drawables instead of per-layer GL calls.** The 2022 modularisation
  proposal replaced `render_*_layer` code issuing GL calls every frame with
  per-API Builders emitting Drawables that own upload, draw, update and
  teardown [6]. iOS 6.0.0 shipped Metal on it; 6.1.0 lists the follow-up
  performance fixes (redundant bindings found with the Metal profiler,
  combined segments, UBOs by index instead of a map), and 6.13.0 deleted the
  legacy renderer (#3384) [7].
- **Acceptance budget** for the port: binary growth at most 5%, no start-up
  increase, no frame-rate decrease, identical GL rendering. A cross-API
  toolkit and GLSL transpilation were rejected [6]. bgfx (PeakFinder,
  "performance the same as old OpenGL") and MetalANGLE (Sygic in production)
  were rejected for size; the early native Metal build showed tearing, freezes
  up to a second, lower FPS than MetalANGLE and polyline annotations taking
  about 2 s to appear [8].
- **Immutable Impl objects** shared between threads; a mutation creates a new
  Impl. A later change made the available-image set copy-on-write for styles
  with many images and frequently updated sources (#4651) [9].
- **CustomVectorSource** delivers MVT bytes (MLT named as the next candidate)
  per CanonicalTileID through VectorTileData and GeometryTileWorker, with
  cooperative cancellation. CustomGeometrySource's drawbacks: bbox requests, an
  internal 4-thread pool, GeoJSON re-encoded into tiles [10].
- **Plugins.** The CustomDrawableLayer API went through several versions and
  was removed (#4611) for an experimental C plugin API (#4612) shipped only in
  `-with-plugin-api` artifacts; per-drawable depth/stencil/cull state had to be
  added back (#4692), and there is no WebGPU support. The 2025 proposal limits
  plugins to taking the render context [11].
- **MVT vs MLT negotiation (open).** Martin 1.9.0 shipped `Accept`-based
  negotiation; core maintainers prefer separate endpoints plus the style's
  `encoding` because MLT will diverge from MVT, TileJSON says one URL returns
  one content, and conneg adds per-request overhead. The Rust MLT encoder was
  reported about 30% smaller than the Java one [12].
- **OpenGL ES 3.0.** PR 995 moved shaders to `#version 300 es` and removed
  `MBGL_USE_GLES2` for UBOs and VAOs and 16 vertex attributes; a WebGL1 WASM
  build was later possible only from the `opengl-2` branch [13].

## maplibre-rs

- wgpu everywhere (Vulkan, Metal, WebGL or WebGPU). iOS lacks instanced index
  drawing and forbids zero-length index draws; Android does not know the
  window size before resume; mobile browsers had only WebGL. WebGPU was
  "significantly faster because WASM output is smaller" than the WebGL build
  in Chrome [14].
- Rendering to a native surface through raw-window-handle worked (including an
  Android JNI Surface); gesture input per host was the real cost, and the
  Android proof of concept was postponed until input worked: "Input is
  generally a big thing to overcome after rendering" [15].
- Core split into data pipeline, renderer and window/surface handler; headless
  rendering is a driver that runs one iteration after loading finishes, so
  loading needs an explicit completion signal [16].

## MapLibre Tile (MLT)

- Self-delimiting frames: size, then a one-byte tag readable without varint
  parsing; decoders skip unknown tags; a finalised tag never changes. v1
  (0x01) is stable, v2 (0x02) experimental, and both can mix in one tile [17].
- Encoder profiles removed in March 2026, replaced by bools, then reintroduced
  in October as `EncoderConfig::from_profile(Profile::Native(Network::Cellular4G))`
  with web, native, min_size, diffable and fast_encoding [18].

## navara

- Sources own URL, zoom range, tiling scheme and decoding; layers reference a
  source by id; a SourceStore ref-counts layers so many share one PMTiles
  header and directory fetch. Explicit sources survive at ref count 0 and
  deleting a referenced source is rejected. The legacy per-layer implicit
  source was removed (#756) [19].
- WASM policy: no wasm-bindgen class in public APIs; wrappers create, use and
  `.free()` internally [20].
- PMTiles: the parser crate knows only Header, Directory, TileId and Entry,
  depends on nothing in the engine and returns `Vec<u8>`; review required it,
  and the generic vector layer was deferred to a later PR [21].
- Zoom computed in Rust; polled only while the attribution popover is open;
  guard against `fov_y == 0` producing NaN [22].
- Splat LoD knobs (quality mode, lodScale, coneFoveate) rolled back to one
  boolean; demo splats converted from PLY to gzip spz [23].

## RustGIS

- GDAL and DuckDB are external programs: `ogr2ogr` converts each layer once
  into an indexed FlatGeobuf in WGS 84 kept in a cache folder; `duckdb` writes
  Hilbert-sorted GeoParquet. Desktop only, with conversion latency and
  extensions downloaded on first use [24].
- Layered Cargo workspace checked by `cargo xtask layers`: crates below the UI
  layer may not depend on egui, wgpu or winit; a wasm32 build is a separate CI
  gate [25].

## Re:Earth (reearth-papers, reearth-visualizer)

- Published paint styles keyed by `rev` (content hash of document plus assets)
  and `PAINT_RUNTIME_VERSION`; manifest written last; parameters
  canonicalised, out-of-range values rejected with 400, unknown query keys
  excluded from identity. Manifest TTL lowered from 1 h to 10 min after
  isolates disagreed [26].
- Loopback proxy with reqwest (rustls) in front of maplibre-native's
  libcurl/OpenSSL path, later made moot by an in-worker renderer with no I/O
  of its own [27].
- The in-repo engine wrapper (about 34k lines, 321 files) was replaced by
  `@reearth/core`, built against a custom cesium 1.145.0 and custom resium;
  the upgrade needed `@cesium/engine` pinned to 26.3.0 and a Playwright pass
  (27+11+6 tests) [28].
- Terrain vanished after navigating back because Resium's Globe skipped
  `update()` on initial mount; the fix sets `globe.terrainProvider` through a
  ref after the promise resolves (#2276) [29].

## Cesium

- WebGL2 by default since 1.102, `requestWebgl2` replaced by `requestWebgl1`;
  custom materials and shaders had to move to GLSL 300 [30].
- Buffer*Collection (1.140) and GeoJsonPrimitive (1.142) bypass Entity and
  DataSource; "providing a precomputed bounding volume can eliminate the
  performance cost of automatically updating the bounding volume frequently"
  [31].
- Clipping polygons frozen at construction and rewritten with vector-tile
  techniques, dropping the distance texture and a quality setting; better
  quality across distance scales and lower warm-up [32].
- `requestRenderMode`: the first version kept an update pass at 60 Hz when
  idle; a 0.5 s sim-time threshold default was rejected because the view would
  not match the clock, so `maximumRenderTimeChange` defaults to 0 [33].
- `HeightReference` enum for billboards: heights zig-zag while terrain
  refines, false occlusion flickers, and merge to master waited for the
  flicker fix [34].
- MVT through a format-agnostic codec into the 3D Tiles content path: 404 and
  204 become empty tiles, skip-LOD disabled for vector tiles; a dedicated MVT
  content class was steered away from [35].
- Third-party libraries (earcut, rbush, kdbush) pulled from npm through rollup
  instead of modified vendored copies that went stale; Cesium itself still
  needs no bundler for development [36].

## deck.gl

- Interleaving with harp.gl: deck's near is fixed at 0.1 and its far depends
  on pitch, harp.gl's changes with tilt; WebGL1/WebGL2 context mismatches and
  a framebuffer feedback loop from a post-processing pass were also hit [37].
- `@deck.gl/maplibre` uses only public custom-layer APIs, with MapLibre 4.5.1
  as the minimum because it first exposed the needed render parameters [38].
- Google Maps: deck reacting to the map's draw callback lags a frame because
  the map has already rendered; driving the map from deck's controller works
  except that `getZoom()` returns integers during transitions [39].
- GeoJsonLayer forwards an explicit prop list; rare props go through
  `_subLayerProps`; cost is naming inconsistency (`pointRadius*` vs `size*`)
  [40].
- MVT layer accepted with stated limits; CARTO's use case was thematic data
  (22M census blocks, about 8 GB) [41].
- TileJSON support lives in MVTLayer; `data` is overloaded (template, TileJSON
  URL, array, object) and user zoom range is restricted by the TileJSON's [42].
- Shallow compare of data; apps use `updateTriggers` or keep identity [43].
- TileLayer roadmap (January 2020): worker MVT parsing moves to
  `@loaders.gl/mvt`, non-geospatial tiling through hooks, not a base class;
  known issues were a naive cache and no request scheduling [44].
- `maxCacheSize`/`maxCacheByteSize` of 0 fixed with nullish checks (#9156)
  [45].

## ortho-earth

- SharedArrayBuffer optional; `verify:nocoi` ran 7 pages with
  `crossOriginIsolated` false and all passed [46].
- Main-chunk geopbf breakdown: topology 18.6 KB, pbf-base 10.9, index 10.4,
  gint 9.0, WASM glue 6.5; a lazy import of fallbacks did not move the
  measurement and was reverted [47].
- `map.overlay(url, {name, opts})`: the module exports init, message, frame and
  destroy, must be dependency-free, receives data via `post(data, transfer)`;
  input and picking stay on main. Pin ground heights became synchronous [48].
- Tile format plugins: seven call sites routed through `decodeTile`; tests
  convert MVT to MLT and compare layers, counts, props, coords and ring
  orientation. The official MLT library allocates a Point per vertex, GC
  pressure the custom MVT decoder had removed [49].
- WebGPU-only effects: software WebGPU in the agent environment could not read
  back pixels, so pixel tests ran only on the owner's GPU and a WGSL compile
  test (27, later 32 modules) gates everywhere [50].

## QGIS

- Simplification is a flag on the render feature request; editing, "save as"
  and layout export get full geometry, low-resolution layout previews keep
  it. A first `RenderingPrintComposition` flag proved redundant [51].
- `QgsSimplifyMethod` on the request lets providers simplify server-side
  (PostGIS ST_Simplify); an OGR-specific pre-simplifying iterator was only
  about 8% faster [51].
- `QgsArrowIterator` (nanoarrow) turns any feature iterator into Arrow batches
  for a requested schema; reviewers proposed delegating to GDAL's
  `OGR_L_GetArrowStream`, which skips per-feature iteration for some drivers
  [52].

## GRASS GIS

- Split input/output windows: the column mapping is built once per map open;
  changing a window while maps are open is a fatal error, chosen over silent
  breakage. GRASS 6 changed the window twice per output row [53].
- Two vector access levels: level 1 streams geometry without topology; level 2
  loads topology for random access and areas, with "more memory, and longer
  startup time" [54].
- Attributes in an external RDBMS: per-row SQL is slow, "number precision can
  be lost", and the author recommended embedded databases in the vector
  directory with insert/update cursors [55].
- `nprocs`: above 0 is min(nprocs, available), 0 or below is
  max(available + nprocs, 1); resolved in each C tool, because resolving in
  the parser broke four `t.rast.what` tests [56].
- drand48 state as one atomic 64-bit value advanced by CAS. The first mutex
  version was gated on `HAVE_PTHREAD`, which the default OpenMP builds never
  defined, so the fix would have been compiled out where the race happened.
  Mutex worst case for 1e8 calls: 0.82 s on 1 thread, 6.23 s on 16 [57].
- `GRASS_MASK` names the mask raster; a Python `MaskManager` scopes a
  temporary mask without touching the user's [58].
- Compression codecs per file: RLE, zlib, LZ4, bzip2, then ZSTD with
  `G_compress_bound()`; ZSTD is now the default [59].
- Display monitors (separate processes receiving drawing commands over a
  socket) removed; modules render directly into an image, cairo by default
  [60].

## Marble

- Manifesto: top-down 2.5D only; plate carrée preferred for tasks like a
  timezone chooser [61].
- Render order from backend hints, the order of layers in the DGML map section
  (from behind the globe to the observer) and a guess for undeclared plugins;
  layers are either projection-based or screen layers [62].
- DGML references existing formats (KML, GPX, GeoRSS, PNT, image tile dirs)
  and binds legend checkboxes to layers through a `connect` attribute [63].
- Vector tiles keep tagged data Marble does not render (railway=platform_edge
  is about 1.5k elements for all of Germany) for other consumers [64].
- QML polylines keep only on-screen coordinates; `clipScreenCoordinates`
  restores the old behaviour, and the follow-up fixed a memory leak [65].

## OpenLayers

- Full WebGL renderer in v3.20 after a "nearly 5 month effort"; removed in
  v6.0 with its AtlasManager ("the atlas was only used by this renderer");
  rebuilt as WebGLHelper plus WebGLPointsLayer, extended to lines and
  polygons in v7, WebGLPoints deprecated for WebGLVector in v10.4, text in
  WebGL only in 10.10, with breaking style-format changes in 8.0, 10.3 and
  10.4 [66].
- v5.0 removed the Map `renderer` option; v6.0 made the immediate vector API
  an explicit import (`getVectorContext`) so apps not using it do not bundle
  it [67].
- v6.0 switched internal tile coordinates to XYZ (top-left origin, y down); v3.7
  had rows increasing upward so every tile had negative y and URL functions
  computed `-y-1` [68].
- `forEachFeatureAtPixel(pixel, callback, {layerFilter, hitTolerance})`;
  `this` arguments dropped for `Function.bind` [69].
- `@api` removed from WebGLHelper, WebGLRenderTarget, WebGLArrayBuffer and
  WebGLPostProcessingPass; removing `@api` is itself a breaking change [70].
- Geometries carry no projection; `getLength` in EPSG:3857 overstates by
  1/cos(lat) (1.44 at 45.6N, 330 m reported vs 228 m) [71].
- GlTiles (user fragment shader per tile, then copied into Canvas 2D) set
  aside for a WebGL tile layer with generic typed-array DataTiles; geotiff
  stays a dev dependency, like proj4 [72].
- UTFGrid lookups synchronous against loaded data (null until loaded),
  asynchronous only when asked to fetch; preloading on by default [73].
- v6 composes layers as separate DOM elements so each can pick its renderer;
  consecutive compatible layers may still share a canvas, which gives
  `forEachLayerAtPixel` false positives, and forcing separate canvases "may
  incur a significant performance loss" [74].

## OpenLayers 2

- Vector layers pick the first supported renderer from
  `['SVG','VML','Canvas']`; the 2.14 Graticule overrides to Canvas first
  because long lines hit SVG coordinate range limits [76].
- Projection defaults per projection (maxExtent, units, worldExtent);
  examples before 2.11 used maxResolution 156543.0339, "which was ...
  incorrect. The correct value is 156543.03390625" [77].
- Geometry decoupled from WKT and Feature to shrink builds; without WKT.js,
  `toString` returns `[object Object]` [78].
- `eval` replaced by `getConstructor` on `CLASS_NAME` for CSP [79].
- Google v3 layer broke with Google's DOM changes ("Good ideas ... welcome!");
  2.13 added the OpenLayers viewport as a Google Maps control; 2.14 removed
  GMaps v2 [80].
- ModifyFeature `bySegment`: vertices in rbush, handles only on the nearest
  segment; vertex deletion broke and an undefined `closestHit` crashed [81].
- Wheel deltas: Safari 10x smaller than Chrome, Firefox `detail` in multiples
  of 3, Opera multiples of 40; Firefox clamped to ±1 and user-agent sniffing
  removed in the final version [82].
- New layers take one options object [83]. 3D transforms used only when the
  stylesheet sets a transform on the layer container [84].

## Leaflet

- 1.0 separated geometry from Renderer layers (SVG, Canvas, VML) that can be
  mixed on one map; creating and adding a big GeoJSON layer on SVG got 3x
  faster with 2.5x less memory; Canvas got partial redraw of changed shapes,
  tested on about 1,800 zip-code shapes updating on hover; a Canvas renderer
  above an SVG one captured all pointer events until fixed [85].
- MultiPolyline/MultiPolygon removed ("API should reflect implementation");
  Polygon `getLatLngs` always returns nested arrays [85][86].
- Renderers cover the view plus 10% padding per side and update after the
  map settles; generalised in 2.0 as BlanketOverlay (#8611) [87].
- Release cadence after 1.0 (914+ commits over more than a year): every 2-4
  weeks, "many small, incremental changes over ambitious rewriting quests"
  [89].
- CRS-driven wrapping and bounds (`wrapLng`, `wrapLat`, `infinite`), 2x1 root
  pyramid for EPSG:4326, non-square tiles; Circle approximated as an ellipse
  in Earth CRS [91]. A polar LAEA user was pointed to D3 or OpenLayers
  because projected-coordinate APIs stayed missing [91].
- GridLayer (which tiles) split from TileLayer (image loading); `createTile(coords,
  done)` returns any element and signals async completion [92].
- `bindPopup` with a function generates content lazily instead of storing it
  per layer [93].
- CRS fixed for a map's life: any code holding pixel or projected coordinates
  would have to handle a change, and plugins would not [95].
- Pointer Events migration merged incrementally; 1.6's `!webkit &&` pointer
  check had broken leaflet-draw touch handling [96].
- Renderer resolution: layer option, then pane renderer, then map option,
  then a lazily created default; custom panes inherit the map renderer's kind
  [99].

## protomaps-leaflet

- 2.0 removals and maintenance mode [100]. Styles as code: a PaintSymbolizer
  needs only `draw(ctx, geom, z, feature)`, a LabelSymbolizer's `place()`
  returns boxes plus a draw closure run only if placement succeeds; styles are
  not serialisable and performance depends on user code [101].
- A PMTiles instance can be passed as the URL; a layer-level `metadata()` was
  rejected as meaningless for `{z}/{x}/{y}` URLs; 3.0 stopped exporting the
  bundled PMTiles [102].

## Tangram and tangram-es

- Singletons converted to per-scene and per-context step by step; iframes
  crashed phones at 4-8 maps, and "after more than ~4 maps, static may be the
  best way" [103].
- MBTiles read-only, detected by the `.mbtiles` extension; `type` still names
  the payload format. A `mbtiles://` scheme and `type: MBTiles` were rejected,
  and a writable cache was deferred because tangram cannot safely write into
  files other tools produced [104].
- Client GeoJSON tiled on device with geojson-vt-cpp, reusing the tile
  pipeline; the API was unsafe before the GL view existed [105].
- One scene-ready listener with scene IDs instead of per-call callbacks;
  wrong IDs during loads and auto-applied queued updates were the bugs [106].
- Marker IDs non-recycled; easing only for points [107]. Pointer checks
  `!= 0` (ARM Top-Byte-Ignore, GrapheneOS hardened_malloc) [108].

## maptalks, Kothic, Modest Maps

- maptalks-gl drops Canvas 2D layers; WebGPU has no `preserveDrawingBuffer`,
  so the layer-canvas architecture needed extra copies; HeatmapLayer and
  MarkerClusterLayer must be rewritten [109].
- Kothic creates its collision buffer per `render()` call; a shared buffer
  caused wrong collisions when tiles rendered concurrently; labels are not
  deduplicated across tiles [110].
- Modest Maps stays dependency-free, under 7 KB gzip [111].
