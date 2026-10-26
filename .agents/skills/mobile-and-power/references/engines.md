# Mobile and power: per-engine detail

Reference numbers [n] are those of the Sources list in `../SKILL.md`.

## On-demand rendering, engine by engine

- **Cesium.** `Scene.requestRenderMode` (1.42) renders on scene changes,
  explicit `requestRender()`, or when simulation time advances more than
  `maximumRenderTimeChange`; the scene still updates every tick before
  deciding, and continuous rendering stayed the default [8]. Triggers in the
  final design: camera change, completed requests and worker results, tile
  loads, imagery layer changes, morphs, `afterRender` callbacks. A first
  default of re-rendering when sim time moved more than 0.5 s was rejected
  because the picture would not match the clock; the shipped default is 0
  [8]. Follow-up bugs: continuous render after resize (#6812), dynamic
  geometry rendering forever (#6631), geometry entities not rendering
  (#12841) [8]. The tile load queue is time-sliced at about 5 ms per frame;
  measuring with `Date.now()` let it overrun past 10 ms, `performance.now()`
  fixed it [59]. Frustum command lists reuse arrays with an index reset and
  billboard draw commands are cached, to cut garbage per frame [59].
- **reearth-visualizer** (Cesium-based). Feb 2023: on-demand made
  conditional on whether an animating widget (timeline, navigator) was
  present. Mar 2023: disabled in the new layer system, because styles were
  attached to 3D Tiles features asynchronously and frames were missed.
  Jul 2023: re-enabled with a ref holding -1 (force: layer dragging,
  animating widgets), 0 (idle) and 1 (render once); layer and scene-property
  changes set "once", a `postUpdate` listener calls `scene.requestRender()`,
  and `maximumRenderTimeChange` is 0 only while the timeline animates. A
  `debugFramePerSecond` property exposes it. A 100 ms polling
  `requestRender` was later added and removed (#2276) [9].
- **TerriaJS** (Cesium-based). `CesiumRenderLoopPauser` stops rendering
  when the camera has not moved; it forces frames while the globe's tile
  load queue is non-empty (2014), and patches `loadWithXhr.load`,
  `TaskProcessor.prototype.scheduleTask` and `worker.onmessage` to request
  a repaint on every response or worker reply (2015, re-enabled 2019). A
  frame-rate monitor had to be disabled because it did not interact with the
  pausing; missed-repaint fixes continued for years (splitter drag and
  others) [10]. The quality slider maps `baseMaximumScreenSpaceError` 1..3
  to a 0..1 fraction and scales `resolutionScale` 1.0 to 0.75, globe
  `tileCacheSize` 100 to 50, preloading, fog density 0.0006 to 0.0012,
  shadows (off at the low end, with a toast) and 3D Tiles dynamic SSE up to
  2x; `cacheBytes` is capped at the low end against memory blowouts.
  Quality is a viewer device preference, not restored from shared story
  scenes (that caused snapping back) [17].
- **maplibre-rs.** The winit `RedrawRequested` handler called
  `request_redraw()` again: a busy loop. macOS M1 Max idle about 40% CPU and
  25-35% GPU, earlier near 100% GPU in the background; Wayland 5% CPU.
  Moving the request into the input handler gave near-zero CPU. The
  maintainer first thought the re-request was needed on some platforms; the
  issue is still open [7].
- **navara.** Splat sort and LoD finish asynchronously after the camera
  stops; the splat renderer's `onDirty` is bridged to
  `MeshDesc.requestUpdate()` (upstream gap sparkjsdev/spark#298) [11].
  Declutter runs only on dirty labels or changed camera matrices/viewport,
  at most once per 150 ms; 300 ms fades step every frame; follow-up frames
  are scheduled with `setTimeout` because the on-demand loop clears
  `forceUpdate` every tick, and a pending timer is only replaced by a
  shorter one so the 150 ms retry never starves the 16 ms fade cadence
  [12].
- **QGIS 3D.** Qt3D render policy Always to OnDemand; an earlier attempt on
  Qt 5.9.0 gave nothing until QTBUG-55109 was fixed in Qt 5.9.5. Idle about
  300% to about 50% CPU (top, laptop) [13].
- **iTowns.** `setTimeout` to `requestAnimationFrame`; then redraw only on
  `notifyChange(needsRedraw=true)`; commands can declare that they need no
  redraw; "the number of commands executed is irrelevant"; finally the loop
  stops calling itself [14].
- **Tangram / tangram-es.** Continuous rendering only while an animated
  style is drawn; scene `animated: false` disables it; in Tangram JS an
  explicit `animated: true` no longer forces it [15].
- **maptalks.** `stopRenderOnOffscreen` (default true) skips frames for a
  `display:none` or zero-sized container; ResizeObserver replaced a
  `setInterval` size poll [16].
- **harp.gl.** The new-label placement pass runs only when labels changed,
  some label still waits for glyphs/icons, or a label group was evicted
  [63].

## Resolution

- **Cesium**: 1.18 honoured `devicePixelRatio` at CSS resolution, noting it
  "greatly improves performance on mobile devices and high DPI displays ...
  reduces bandwidth usage and increases battery life"; 1.61 native device
  resolution; 1.62 `useBrowserRecommendedResolution` defaulting false; 1.66
  defaulting true, with `powerPreference: 'high-performance'` [4]. An
  earlier SSE plus DPR change was reverted in 2019 without a stated reason
  [4].
- **MapLibre GL JS**: `maxCanvasSize` [4096, 4096] since 3.2.0, reduced
  further on GL limits; the clamp now warns once (#8200) [3].
- **navara**: DPR capped at 2 on mobile, 1 with `mobileOptimization`, an
  explicit `pixelRatio` bypasses both; render targets about 100 B/px [5].
- **deck.gl**: `useDevicePixels` (one prop for drawing and picking),
  library default false, examples on; retina 4x fragments; a 5 px-radius
  scatterplot is about 100 fragments per point, so 10M points is up to 1e9
  fragment invocations; luma.gl debug mode (an error query after every
  call) is the other common trap [6].
- **ortho-earth**: GPU time from `EXT_disjoint_timer_query`, normalised by
  resolution squared, drives dynamic resolution; idle detail at 256 px
  caused about 10 s redraw bursts on an M1 (68 to 106-149 ms), hence
  `tilePx` 384 on tiered machines [18]. Display stays a sphere on low-memory
  (`deviceMemory` <= 4 GB or touch) and mid-tier devices, including 8 GB
  Android and SwiftShader; the ellipsoid costs about 10% more GPU and a
  second set of baked caches, and is used only on normal and high desktops;
  measurements are always on WGS84 [20]. Atmosphere, PBR, AO and shadows
  are WebGPU-only and off by default; the WebGL2 fallback keeps rim light,
  fixed light and base colour; mirroring every effect was estimated at
  30-40% more work [20].
- **Marble**: vector tile level chosen for about 20 tiles on screen, 12 on
  mobile, from physical screen size rather than the canvas viewport [58].
  Its 2007 manifesto made software rendering the baseline so output is
  identical without decent 3D drivers [58].

## Memory and lifetime

- **navara** budgets: desktop a quarter of device memory capped at 2 GB;
  mobile 512 or 256 MB. Over budget, oldest and farthest pooled tiles go
  down to 85%; if the view alone exceeds it, the load gate closes and the
  SSE multiplier rises x1.25 per 15 stalled frames, weighted to far tiles.
  Recovery: the multiplier decays x0.98 per frame only after a cooldown
  that starts at about 5 s (300 frames) and doubles per raise-after-decay
  up to about 60 s (3600 frames); pressure is quantised to 0.25 steps so
  traversal reruns only on real change. Overestimated cost hints make the
  map too coarse; underestimated ones stop the budget from binding. A JS
  buffer store avoids holding WASM and JS copies of the same data; before
  PR 692 "mobile device easily crashed when a large tile is selected" [5].
- **MapLibre GL JS workers**: v4.0 (#3433) gave the global dispatcher a
  strong claim on the shared pool, so it never drained; now a weak claim
  terminates workers with the last map. On foreground return it pings
  workers, and if they stay silent restarts the pool; maps rebuild style
  from a snapshot through the context-loss events, so apps must re-add
  custom layers. An `onTerminate` callback was rejected as coupling [24].
- **Safari Transferables**: Mapbox GL 1.5.1 copied instead of transferring
  on Safari and worked around a CacheStorage leak (unbounded growth,
  #8771, #4695); MapLibre 3.5.2 transferred again after Safari's fix [23].
- **OpenLayers on iOS**: the canvas limit is 224-480 MB depending on
  device; about half of one user's tiles were empty but each still cost a
  full canvas; `cacheSize` 256 or 4 made the error go away for some users;
  smaller caches cause re-rendering and blank tiles on zoom out. Zeroing
  canvas size on dispose only releases memory sooner; reusing one canvas
  for empty tiles was rejected as special-casing; the WebGL renderer was
  reported to work [25].
- **OL2 2.13** memory: bisected to a change that improved browser-cache
  reuse of tile URLs (ff1f99a); 500 scripted events took Firefox 25 past
  1.4 GB and 32-bit Firefox to 3 GB, against 170-210 MB in 2.12;
  maintainers kept it as "browser cache working properly". One user traced
  it to the `translateZ` GPU CSS on tile images [34].
- **MapLibre Native**: clearing the in-memory tile cache before entering
  the background reduced memory (#11197); prefetched tiles are reused to
  avoid an empty screen (#2668); the cross-zoom cache toggle is
  experimental in #2590 and final in #2723 [33]. Texture pool: 64 pooled GL
  names did not pool storage, so every `glTexImage` reallocated; pooling
  handle plus storage by size/format, evicting least used, flattened the
  allocation histogram on a Pixel 6 (uploading many sub-200x200 textures
  took over 1 ms and correlated with touches), but remaining allocations
  still block the render thread [32].
- **deck.gl**: Chrome caps one allocation near 1 GB; 60 FPS up to about 1M
  items and 10-20 FPS near 10M on a 2015 MacBook Pro; experimental
  `_pickable: false` and `_typedArrayManagerProps {overAlloc: 1,
  poolSize: 0}` trade speed for peak memory on phones [46].
- **vts-browser-js**: MapCache is a doubly linked LRU keyed by byte cost;
  GPU cache default 360 to 500 to 600 MB; on mobile limits multiply by
  about 2^-degradation and `texelSizeFit` by 2^mapMobileDetailDegradation
  [61].
- **Third-party caches**: OsmAnd capped GDAL at 256 MB on devices with
  >= 4 GB RAM (was 204-819 MB); the crash was an `EXC_BAD_ACCESS` in the
  hillshade worker reachable only on failed allocation; a correction notes
  256 MB was tuned on the weather path and the cache is process-wide [54].
  osgEarth fixes GDAL's cache at 40 MB, without measurements [54].
- **Leaflet**: a `contextId` listener optimisation was disabled when
  `context === this` for iOS 7 memory trouble (#2122); detached DOM is
  scrubbed on removal (#5263) [42].
- **kothic-js**: double-buffer canvases were never deleted ("Too many
  canvases used", a Chromium bug); a quick fix deleted them, the final one
  reused them [62].

## Gestures and DOM

- **OL2**: 2.12's queue loaded one tile at a time; 2.13's optional
  TileManager waits (move 100 ms, zoom 200 ms) then loads all, letting the
  browser schedule; its doc says queueing helps "dragging performance on
  mobile devices that show a lag in dragging when loading of new images
  starts". The queue is cleared on zoom change and sorted by distance from
  the centre, replacing `spiralTileLoad`; setting many `img.src` at once
  froze iPads; a first version regressed iOS and needed a fix [34]. Fade:
  0.2 s CSS opacity; forcing GPU transforms fixed iOS flicker (#511) but
  slowed freehand drawing (#542); the back buffer lingers 2.5 s [35]. GPU
  compositing on all layer children broke SVG positioning in WebKit; GPU on
  tiles only was "way better performance" on iOS 6; per-tile GPU layers
  later caused missing tiles on Chrome Android 4.2.1, seams on Linux, and a
  vanishing map with 4-5 vector layers at 2560x1440 [35].
- **Leaflet**: `updateWhenIdle` true on mobile, false on desktop;
  `updateInterval` 200 ms; `keepBuffer` 2 [36]. 0.7.1 disabled 3D CSS on
  Android 2/3 for tile flicker; zoom and fade animations off on Android; no
  animation for zoom differences above `zoomAnimationThreshold` 4; 2.0
  removed the sniffing [37]. Android 4.1's `transitionend` could not be
  feature-detected, so a UA check was used [37]. 0.4 replaced box-shadow
  with borders on mobile; 0.2 moved panning to rAF [40]. Map stop during a
  CSS zoom transition became a no-op after reading in-flight transforms
  "lags heavily when CPU and GPU are busy" [41]. Trackpad debounce windows
  of 40 to 200 ms were sluggish or still over-zoomed; #3653 scales
  continuously [41]. Canvas hover hit-testing uses a 32 ms flag cleared on
  mouseout instead of a throttle wrapper, fixing lost enter/leave events
  [69].
- **Modest Maps**: touchmove stopped firing at zoom-level boundaries while
  tiles updated on every move; a `fastForward` flag skips hash updates and
  draws on touchend or 100 ms after the last move; it shipped only on a
  branch because it broke Firefox/IE and caused Safari seams [43].
- **OpenLayers `hitTolerance`**: hit canvas (2r+1)^2 with a cached
  midpoint-circle mask; distance is not returned so the implementation can
  change; alternatives rejected: widening strokes only (no help for icons),
  an rbush nearest-segment (does not know the rendered symbol) [45].

## GPU drivers

- **MapLibre Native**: Vulkan became the default Android artifact in
  13.0.0, OpenGL ES ships as `android-sdk-opengl`; backends are build
  flavors, a runtime multi-backend flavor is experimental and ships both
  libraries. Vulkan costs: `VK_ERROR_DEVICE_LOST` on Adreno 600 (workaround
  extended to all texture sampling, #4666), swapchain rebuild recovery
  (#4730) [47]. Line normals moved out of the int16 position's low bit
  (Broadcom) into `a_pos_normal`, 8 to 10 bytes per vertex [48]. Constant
  attribute bindings were removed by disabling unused attributes; binding
  only active attributes (data-driven line width exceeded
  `GL_MAX_VERTEX_ATTRIBS`) was reverted on a release branch for "issues on
  certain Android devices" [48]. VAOs per segment per layer work around
  buggy PowerVR SGX544 VAOs; VAOs are blacklisted on Adreno 3xx (crashes in
  `glBuffer(Sub)Data`) and Adreno 4xx; a non-VAO path was restored [48].
- **tangram-es**: VAOs reverted for the label mesh in 2015 (Galaxy S3),
  re-introduced for dynamic quad meshes in March 2017, disabled again for
  dynamic meshes in April/May 2017 because "some drivers crash when using
  vaos together with dynamic vbos"; static meshes keep VAOs with a hardware
  check; only the index buffer needs rebinding per VAO [49]. SDF text
  supersampling became optional, then off by default: "imperceptible in
  most cases ... more expensive and breaks on some phones" [49].
- **Precision**: osgEarth's GLES default float precision mediump to highp
  for draping jitter; OpenLayers skips render-extent cropping without highp
  ("most devices seem to support highp"), leaving the gutter visible;
  globe.gl kept three.js's highp although some phones render textured
  materials black (three.js #14570), exposing `rendererConfig` for
  `precision: 'mediump'` [50]. OpenLayers falls back to NEAREST for Float32
  textures without `OES_texture_float_linear` [50].
- **osgEarth**: automatic hardware compression of terrain textures (2014-04)
  was off by default on GLES three months later, because "many drivers on
  PV/ETC don't support it" [51].
- **ortho-earth**: on iOS WebKit, page-to-worker messages died in the
  worker that created the GPU device (fixed by relaying through another
  worker), and `mapAsync` in the same task as `submit` stopped
  presentation; Adreno/Mali Vulkan black screens were reported on
  flagships; the agent environment could not read back WebGPU pixels, so a
  WGSL compile test (27, then 32 modules) gates every run [19][20].
- **protomaps-leaflet**: Safari 15 Canvas crash/deadlock (WebKit 230751,
  231157); a UA-sniffed 200-path batch, then a fixed 5,400 vertices per
  draw call for all browsers; removed in 2.0 [64].

## Native apps

- **Render thread (OsmAnd)**: `EGLThread.run()` held its monitor across
  the operation, so a stalled driver call blocked every caller and a
  `wait()` timeout could not help. The operation now runs without the
  monitor; callers wait with a deadline and abandon the thread on timeout.
  With a 20 s injected stall, close went from 20,179 ms to about 1,565 ms;
  rotation ANRs remain because the hang is in AOSP's GLSurfaceView. The
  field stall was `GL_GenTextures` in a vendor driver. Renderer reuse across
  activity recreation (16 rotations: 72 to 22 ms average on a Pixel) was
  dropped as not worth the lifetime complexity [53].
- **OsmAnd allocations**: a sort comparator that parsed section dates with
  a regex twice per comparison caused 83% of native allocations (374 MB/s
  while scrolling on a Pixel 9 Pro XL); now precomputed per section. SWIG
  director upcalls stopped creating `shared_ptr` and Java proxies per call;
  enum lookups are cached; these fed GC-related ANRs. The mmap window for
  OBF reads went from 16 MB to 1 MB. Without `EXT_unpack_subimage` (iOS
  GLES2) sub-texture upload falls back to one call per row, "very slow on
  iOS" [55]. tangram-es: a JNI handle check `<= 0` rejected tagged
  pointers on Android 11 and hardened_malloc; it must be `== 0` [57].
- **Bundled data**: MapLibre Native reads only the requested range from
  Android APK assets and iOS asset sources, so a PMTiles archive can ship
  in the app [56]. tangram-es could not open MBTiles inside the APK
  because SQLite needs a real file path [56].
- **Start-up (tangram-es)**: loading the shared library took 17 ms but
  parsing the system font config 135 ms, so it moved to first scene load;
  exported symbols went from about 1,500 to 67. Loading every Android
  fallback font raised native heap from 12.9 MB to 67.7 MB, more than the
  32 MB tile cache [57].
- **Decoding cost (MLT)**: rANS on vertex deltas saved about 5% size but
  cost 16% (OMT) to 88% (Protomaps) more decode time, so it is opt-in;
  FastPFOR is vendored without SIMD so encoder and decoder agree and ARMv7
  builds [60].
- **Offline web packs (ortho-earth)**: no native shell (iOS WebView is the
  same WebKit); packs limited to the view with max zoom 12-16, size
  estimated from 6 sample tiles, refused above 80% of
  `navigator.storage.estimate()` free space; nationwide z16 for Japan was
  estimated at about 130 GB [22].

## Bake-side notes

- QGIS moved simplification to a request-level method so a backend can do
  it; the OGR pre-simplifying iterator was only about 8% faster, and
  offloading means fewer nodes transferred, saving "time and power" on
  mobile [66]. In map-from-scratch the bake is that backend.
- GRASS moved row buffers from `alloca` to the heap after wide rasters
  overflowed the stack, and streamed PDAL point clouds through a small
  buffer so memory no longer depends on cloud size [67].
- TileMill capped layer inspection at 500 rows and stopped reading raster
  featuresets after large files failed to load [68].
- Marble stored only bounding boxes for country polygons over about 40 kB
  (all polygons were about 75 MB) and accepted false positives with a
  fallback lookup [58].
