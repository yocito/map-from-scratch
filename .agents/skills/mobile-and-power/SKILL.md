---
name: mobile-and-power
description: What map engines learnt about phones, tablets, battery-powered and always-on devices (idle cost, pixel budget, memory limits enforced by killing, GPU driver quirks, touch input, measuring on real devices), distilled for a map-from-scratch renderer. Load it when a request names a phone, tablet, iOS Safari, Android, a battery or always-on display, a kiosk or a small board, when a spec has a device_scale_factor above 1, cpu_throttle or a memory budget, or when a bench or user report shows idle CPU/GPU use, a dead tab, a black map on one device, lost contexts, jank during pinch, or memory growth over a long session.
---

# Mobile and power: idle, pixels, memory, drivers and the bench

On a phone the same renderer meets four limits a desktop hides. A frame
nobody asked for still costs battery. Pixels cost the square of the device
pixel ratio. Memory is not swapped: the OS or browser kills the tab, the
canvas or the worker without warning. And the GPU driver is one of hundreds,
some of which crash or render black on code that is valid. The 37 engines
studied here all paid for these, and several reversed a decision more than
once. The repository's own mobile example (02) is benched at 390x844, DPR 3
and 4x CPU throttle, draws one rAF per change, sizes its canvas at the full
device pixel ratio, and treats `webglcontextlost` as a bench error rather
than recovering [1]. Neighbouring skills: resolution and MSAA costs in
`antialiasing-and-blending`, byte budgets and fetch queues in
`tile-cache-and-loading`, shader precision in `float-precision`. Per-engine
detail, the driver-quirk catalogue and native-app notes (backends, render
threads, start-up, bundled archives) are in
[references/engines.md](references/engines.md); it uses the numbering of
the Sources list below.

## First: what the device class demands

| Request says | You need | You can skip |
| --- | --- | --- |
| desktop, known GPU | on-demand drawing | DPR cap, driver workarounds, kill recovery |
| phone browser, one map, baked data that fits | on-demand drawing, a DPR budget, context-loss recovery, Pointer Events, transform-only gestures | workers, byte-budget caches, persistent stores |
| phone browser, streamed or large data | all of the above, plus a byte budget with degradation and a worker liveness check if workers are used | |
| native Android/iOS | the above, plus a backend choice, a fallback path for old drivers, a render thread that never blocks the UI thread | |
| always-on display, kiosk, battery board | idle at 0% measured over hours, flat memory over long sessions, context loss recovery | gesture tuning if there is no touch |

## Idle must cost nothing

- **Draw only on change, and make every producer request the frame.**
  maplibre-rs re-requested a redraw inside its redraw handler: an idle map
  used about 40% CPU and 25-35% GPU on an M1 Max; moving the request into
  the input handler gave "near zero" [7]. QGIS's 3D view went from about
  300% to about 50% CPU idle by switching Qt3D to on-demand [13]. iTowns
  stopped looping entirely: redraws happen "if requested, and only if
  requested" [14]. The repo already does one pending rAF per change [1][2].
- **The cost is a long tail of missed or runaway frames.** Cesium's
  `requestRenderMode` (1.42) needed fixes for continuous rendering after a
  resize, dynamic geometry that rendered forever, and entities that never
  rendered [8]. Porting one Cesium application took about 80
  `requestRender` calls, mostly in property setters, and automatic
  per-entity subscriptions were rejected for memory [8]. reearth-visualizer
  turned on-demand off for four months because asynchronously attached 3D
  Tiles styles missed frames, then re-enabled it with a -1/0/1 state
  (force, idle, once) [9]. TerriaJS had to patch the XHR loader and the
  worker message handler so that data arrivals wake the loop, and fixed
  missed repaints for years after [10]. navara missed late splat sort
  results after the camera stopped until the producer's callback was
  bridged to `requestUpdate` [11].
- **So centralise it.** One `requestFrame()` called from input, resize,
  fetch completion, worker reply, image decode and animation tick. A
  renderer you own calls it directly; TerriaJS patched library internals
  only because it did not own the loop [10].
- **Loading is an event, not a reason to spin.** Cesium renders fully while
  tiles load instead of running an update pass at 60 Hz forever, so that
  "idle is truly idle, 0% CPU" [8]; TerriaJS forces frames only while the
  load queue is non-empty [10].
- **Animate only what is visible and moving.** Tangram runs a continuous
  loop only while an animated style is drawn in visible tiles, and an
  explicit `animated: true` no longer forces it [15]. maptalks skips frames
  when the container is `display:none` or zero-sized, and watches size with
  ResizeObserver instead of polling [16]. TerriaJS destroys a hidden preview
  map instead of letting it render in the background [17].
- **Throttle derived work separately from frames.** navara re-runs label
  placement only when labels or camera changed, at most every 150 ms, while
  300 ms fades step every frame on their own timer [12]. TerriaJS's scale
  bar skips unchanged cameras and updates at most every 200 ms; before, it
  did two globe picks and a React render per frame [17]. harp.gl skips the
  new-label pass when nothing changed [63].

## Pixels: device pixel ratio and canvas size are budgets

Detail and numbers are in `antialiasing-and-blending`; the decisions that
matter on a phone:

- **Cap the ratio.** navara caps DPR at 2 on every mobile device (1 with
  `mobileOptimization`), because its render-target stack costs about
  100 B/px and an uncapped DPR-3 phone would spend more of its budget on
  framebuffers than on tiles [5]. Cesium changed its default three times
  (1.18 CSS pixels, 1.61 native, 1.62 a flag defaulting off, 1.66 the flag
  on) and now renders at CSS pixels unless the app opts in [4]. deck.gl's
  `useDevicePixels` defaults on, and its performance guide says to turn it
  off where retina is not needed because it is 4x the fragments; picking
  must follow the same ratio [6].
- **Cap the canvas.** MapLibre GL JS 3.2 caps the drawing buffer at
  4096x4096 by default and shrinks it on GL limits [3]; a later fix made
  the clamp warn, because it had lowered resolution silently [3].
- **Measure GPU time, not wall time, when adapting.** ortho-earth's dynamic
  resolution read 33 ms on a 30 Hz monitor at 3.7 ms of GPU time and sank
  to 0.55 scale; it now uses timer queries, falling back to the wall clock
  where they are missing (Safari) [18].
- **Drop expensive passes while moving.** ortho-earth renders 1x during
  camera motion and one 4x MSAA frame after 500 ms still; clock-driven
  updates had to count as motion or GPU time doubled (10 to 21 ms) [18].
- **Never composite an empty full-screen layer.** Marble's routing overlay,
  a QQuickPaintedItem covering 99% of the screen, painted, uploaded and
  blended a fully transparent QImage every frame even with no route:
  3 fps to about 30 fps on a tablet once hidden [58].

## Memory: the OS kills, it does not swap

- **iOS kills tabs and workers silently.** navara's tilted Tokyo view
  allocated until iOS killed the tab; it now keeps a byte ledger (CPU,
  estimated GPU, render targets, in-flight reservations) with LRU eviction
  to 85%, a load gate and a rising SSE, and budgets of 512 or 256 MB on
  mobile [5]. iOS Safari also kills workers without notice; MapLibre GL JS
  pings its workers on each return to the foreground and rebuilds the pool
  and styles if they are silent, otherwise the map stays stuck [24].
- **Recover from context loss.** OpenLayers marks all resources for
  recreation on `webglcontextrestored`; without it "the map stops
  rendering" [27]. Keep the baked data (or its URL) to upload again, which
  conflicts with dropping CPU copies: decide per request.
- **Drop the CPU copy after upload when nothing reads it.** navara frees
  each geometry array on first upload, halving residency [5]; tangram-es
  frees texture pixels after upload and must re-decode after context loss
  [31]. The repo's 05 does the native form (mmap, upload, munmap) [2].
- **Free GPU objects explicitly.** On WebGPU in the browser wgpu's `Drop`
  frees nothing; RustGIS crashed with `VK_ERROR_OUT_OF_DEVICE_MEMORY` until
  every buffer and texture called `destroy()` [30].
- **Canvas memory has a hard cap on iOS.** OpenLayers users hit "Total
  canvas memory use exceeds the maximum limit (256 MB)"; a 704x704 tile
  canvas costs 1.89 MB even empty, DPR 2 doubles it, and the fix was
  smaller default caches plus shrinking pooled canvases to 1x1 [25].
  kothic-js pools its double-buffer canvases for the same reason [62].
- **One GL context per page.** A new WebGL context always succeeds but
  evicts older ones on mobile; maptalks' answer to failed `createBuffer`
  on Android was to merge layers into one context [29].
- **Size caches for the weakest device, in bytes.** ortho-earth budgets
  geometry from `navigator.deviceMemory` (16 GB about 96 MB, 2 GB about
  24 MB) [21]; OL2 halved its image cache to 256 because 512 was "too much
  for some mobile browsers" [34]; vts-browser-js scales its GPU cache by
  about 2^-degradation on mobile [61]; MapLibre Native lets apps disable
  the cross-zoom tile cache, trading memory for re-parsing on zoom [33].
  Cap third-party caches that size themselves from device RAM: OsmAnd cut
  GDAL's 5% default (400-800 MB on iPads, hillshade crashed) to 256 MB [54].
- **Split giant buffers.** deck.gl layers crash between 10M and 100M items
  on per-allocation limits; on phones it sets over-allocation to 1 and no
  pool [46].
- **Measure memory over a long session.** OL2 2.13 grew past 1.4 GB in
  Firefox over 500 scripted pan/zoom events where 2.12 stayed at about
  200 MB [34]; Safari's Transferable leak made MapLibre copy buffers to
  workers until Safari fixed it [23]; Leaflet disabled a listener
  optimisation that caused iOS 7 memory trouble [42].

## Gestures: transform only, work after

- **Defer tile work until the gesture ends on mobile.** Leaflet's
  `updateWhenIdle` is on for mobile, with updates throttled to 200 ms
  during pans [36]. Modest Maps' pinch stuttered and stuck until tile
  updates moved to touchend plus 100 ms [43]. OL2 debounces 100 ms after a
  pan and 200 ms after a zoom, and cut its off-screen ring from 2 to 0 (42
  to 12 tiles for a 500x500 map) [34].
- **No picking during drags.** deck.gl suppresses hover picking while a
  button is down and skips the pass when nothing is pickable [44].
- **Read layout once per gesture.** Leaflet caches the container origin
  and scale at pinch start and resolves wheel positions once per zoom,
  avoiding a forced layout per event [40]; changing the document cursor
  during drag cost noticeable time in Chrome [40].
- **Pointer Events only, passive where possible.** Leaflet 2.0 replaced
  mouse and touch paths with Pointer Events and tracks pinch pointers by
  `pointerId`; UA-sniffing input paths caused regressions and were reverted
  [38]. Touch-move and wheel listeners are passive unless they must cancel
  scrolling [39].
- **Touch targets in CSS pixels times DPR.** OpenLayers' `hitTolerance`
  reads a (2r+1)^2 circle scaled by DPR; thin lines were "a matter of luck"
  to tap without it [45].
- **Wheel and trackpad are continuous.** Debouncing trackpad deltas into
  integer zoom steps failed; Leaflet scales continuously and snaps at the
  end [41].
- **Drive animation from your own clock.** Leaflet abandoned stopping CSS
  transitions (reading transforms forced GPU sync) and an Android
  `transitionend` that never fired froze the map [37][41].

## GPU and driver quirks

The catalogue with commits is in references/engines.md. The rules:

- **Fail fast to a safe path, and verify the first frame.** ortho-earth
  pins Android to WebGL2 for all devices and reads back a pixel after the
  first WebGPU frame, reloading on WebGL2 if nothing presented within 20 s;
  a low-end Android showed a black basemap with no errors [19].
- **Keep vertex formats plain.** MapLibre Native stopped packing line
  normals into position low bits (Broadcom GPUs), growing the vertex from 8
  to 10 bytes [48]; its conditional attribute binding was reverted for
  breaking Android devices [48]. VAOs were blacklisted on Adreno 3xx/4xx
  and PowerVR SGX544 in MapLibre Native and removed from dynamic meshes
  twice in tangram-es [48][49].
- **Precision.** highp for positions and projected coordinates (osgEarth
  moved its GLES default from mediump to highp to stop draping jitter);
  OpenLayers skips world-space fragment maths where highp is missing;
  globe.gl kept highp despite black renders on some phones [50].
- **Do not assume extensions.** Float textures fall back to NEAREST without
  `OES_texture_float_linear` (OpenLayers); osgEarth turned automatic
  texture compression off on GLES [50][51].
- **Canvas 2D on iOS: no rotated clip paths.** A non-axis-aligned clip made
  `drawImage` up to 93x slower on iOS 12 Safari; OpenLayers kept it [26].
- **Software rendering.** OpenLayers refuses WebGL with
  `failIfMajorPerformanceCaveat` and uses Canvas; Cesium reverted that to
  false so remote-desktop users still start [28]. Leave it off for any
  bench that runs on a software rasteriser.

## Measuring for a phone

- **Record the tail and the conditions.** MapLibre Native's Android bench
  reports fps, encode and render averages, 1%-low times, thermal state,
  build type, device and git revision; encoding (19.8 ms average, 91.7 ms
  1% low) dominated rendering (7.7 ms) on an SM-G973F [52].
- **Frames must contain content.** Its Vulkan vs OpenGL comparison slowed
  the camera route because empty frames gave "very high but meaningless
  FPS"; benches must use release builds, and a reported Vulkan lag was
  largely the emulator [52].
- **Emulators lie about GPU costs.** OsmAnd's renderer re-init cost 612 ms
  on a software-GPU emulator and about 50 ms on a Pixel; a handover design
  motivated by the emulator numbers was dropped [53].
- The harness's DPR-3, 4x-throttle profile emulates CPU and pixel count on
  a desktop GPU, not mobile memory limits, thermal throttling or drivers
  [1]. Budget `js_heap_mb` and `browser_rss_mb` for memory [1], and say in
  `performance_knowledge` what was not measured on a real device.

## Tried and reverted

- Cesium's resolution default: three changes between 1.18 and 1.66 [4].
- reearth-visualizer's on-demand rendering: on, off for four months, on
  again; a 100 ms polling `requestRender` added and removed [9].
- Transferables disabled on Safari, re-enabled years later [23].
- MapLibre Native's conditional attribute binding; tangram-es VAOs on
  dynamic meshes (twice) [48][49].
- Leaflet's iOS 13 "no Pointer Events on WebKit" hack, reverted for proper
  handling; `L_DISABLE_3D` and Android sniffing removed in 2.0 [37][38].
- protomaps-leaflet's 5,400-vertex path cap for a Safari 15 crash, removed
  once WebKit fixed it [64].
- OL2's GPU compositing hint on every element, narrowed to tile images
  after SVG breakage; later per-tile GPU layers made maps vanish with
  several vector layers on large screens [35].
- A MapLibre GL JS proposal to snapshot stable translucent layers into a
  texture was closed over its invalidation paths [65].

## Guidance for a renderer here

1. Write `requestFrame()` first and call it from every producer; add a
   check that the idle page draws zero frames over a few seconds, and one
   that a late data arrival does draw.
2. Size the canvas at `min(devicePixelRatio, 2)` for phones (or a measured
   value) and cap it in pixels; record the choice and the GPU time at both
   ratios in `performance_knowledge`. 02 uses full DPR today [1].
3. On a phone, handle `webglcontextlost` with `preventDefault()` and
   rebuild on `webglcontextrestored`, keeping either the baked buffers or
   their URL; then the bench can still count the loss as an error.
4. Use a worker only if run-time decoding remains after the bake; if you
   do, check it is alive after `visibilitychange` [24].
5. For streamed data, a byte budget from the target device with a declared
   degradation (`tile-cache-and-loading`); for a baked file that fits, none.
6. Gestures move a uniform; picking, tile selection and label placement
   run after the gesture or on a throttle.
7. Use the plainest vertex formats and WebGL2 core features; if WebGPU,
   ship WebGL2 and verify the first presented frame.
8. When the request is for a real device, state which numbers came from
   the harness profile and which from the device, and record tail frame
   time and thermal state from the device if you can.

## Sources

1. This repository: `examples/02-world-population-mobile/spec.yaml`, `examples/02-world-population-mobile/map.ts`, `examples/02-world-population-mobile/bench.ts`, `skills/map-from-scratch/references/spec-yaml.md`, `README.md`
2. This repository: `skills/map-from-scratch/references/patterns.md`
3. MapLibre GL JS canvas cap: `ref-repos/maplibre__maplibre-gl-js/CHANGELOG.md` (3.2.0 and #8200), https://github.com/maplibre/maplibre-gl-js/pull/2674
4. Cesium render resolution: `ref-repos/CesiumGS__cesium/CHANGES.md`, https://github.com/CesiumGS/cesium/pull/8548, https://github.com/CesiumGS/cesium/issues/8082, https://github.com/CesiumGS/cesium/issues/8215, https://github.com/CesiumGS/cesium/commit/7f2dd38a7, https://github.com/CesiumGS/cesium/commit/6a9520fef
5. navara memory management: https://github.com/maplibre/navara/blob/main/guide/MEMORY_MANAGEMENT.md, `ref-repos/maplibre__navara/guide/MEMORY_MANAGEMENT.md`, https://github.com/maplibre/navara/pull/692
6. deck.gl device pixels: https://github.com/visgl/deck.gl/blob/master/docs/developer-guide/performance.md, `ref-repos/visgl__deck.gl/docs/api-reference/core/deck.md`, `ref-repos/visgl__deck.gl/docs/whats-new.md`, https://github.com/visgl/deck.gl/commit/376ccfdb, https://github.com/visgl/deck.gl/commit/32f92341, https://github.com/visgl/deck.gl/commit/2645c8e6
7. maplibre-rs continuous redraw: https://github.com/maplibre/maplibre-rs/issues/187
8. Cesium request render mode: https://github.com/CesiumGS/cesium/pull/6115, https://github.com/CesiumGS/cesium/issues/6812, https://github.com/CesiumGS/cesium/issues/6631, https://github.com/CesiumGS/cesium/pull/12841, `ref-repos/CesiumGS__cesium/CHANGES.md`
9. reearth-visualizer on-demand rendering: https://github.com/reearth/reearth-visualizer/commit/7a25032d, https://github.com/reearth/reearth-visualizer/pull/583, https://github.com/reearth/reearth-visualizer/commit/e645ec9a, https://github.com/reearth/reearth-web/pull/439
10. TerriaJS render loop pauser: https://github.com/TerriaJS/terriajs/commit/e31f77af7, https://github.com/TerriaJS/terriajs/commit/50b99b7e7, https://github.com/TerriaJS/terriajs/commit/fd1d0fd75, https://github.com/TerriaJS/terriajs/commit/3f02df2d9, https://github.com/TerriaJS/terriajs/commit/0fd18bd17
11. navara async producer wake-up: https://github.com/maplibre/navara/commit/216ea08e
12. navara declutter throttle: https://github.com/maplibre/navara/blob/main/guide/DECLUTTER.md
13. QGIS 3D on-demand: https://github.com/qgis/QGIS/commit/18642371e9
14. iTowns redraw on request: https://github.com/iTowns/itowns/commit/dbf9d25d, https://github.com/iTowns/itowns/commit/258efcdd, https://github.com/iTowns/itowns/commit/ea8905a5, https://github.com/iTowns/itowns/commit/6ac3ea7a
15. Tangram animation gating: https://github.com/tangrams/tangram/commit/c60ad8b0, https://github.com/tangrams/tangram-es/commit/ba9cd53e
16. maptalks offscreen stop: https://github.com/maptalks/maptalks.js/commit/584eb4d96, https://github.com/maptalks/maptalks.js/commit/5a3aebd39
17. TerriaJS changes (scale bar, hidden preview map, quality slider): `ref-repos/TerriaJS__terriajs/packages/terriajs/CHANGES.md`, https://github.com/TerriaJS/terriajs/commit/87c07944bc904020f96354cc7d5ccaabcdafe5e0
18. ortho-earth resolution and MSAA while moving: https://github.com/kenjiyoshidahome2026-bit/ortho-earth/commit/b06368cd, https://github.com/kenjiyoshidahome2026-bit/ortho-earth/commit/9afc6f21, https://github.com/kenjiyoshidahome2026-bit/ortho-earth/commit/06462fba, https://github.com/kenjiyoshidahome2026-bit/ortho-earth/blob/main/packages/ortho-core/fallback-ladder.md
19. ortho-earth backend ladder: https://github.com/kenjiyoshidahome2026-bit/ortho-earth/blob/main/packages/ortho-core/fallback-ladder.md, `ref-repos/kenjiyoshidahome2026-bit__ortho-earth/packages/ortho-core/fallback-ladder.md`, `ref-repos/kenjiyoshidahome2026-bit__ortho-earth/packages/ortho-core/webgpu port.md`
20. ortho-earth device tiers (sphere on weak devices, effects off by default): https://github.com/kenjiyoshidahome2026-bit/ortho-earth/issues/43, https://github.com/kenjiyoshidahome2026-bit/ortho-earth/issues/46, https://github.com/kenjiyoshidahome2026-bit/ortho-earth/issues/112
21. ortho-earth byte-bounded cache: https://github.com/kenjiyoshidahome2026-bit/ortho-earth/commit/45a8edb1
22. ortho-earth offline packs: https://github.com/kenjiyoshidahome2026-bit/ortho-earth/issues/40
23. Safari Transferable workaround: `ref-repos/maplibre__maplibre-gl-js/CHANGELOG.md`, https://github.com/mapbox/mapbox-gl-js/pull/9003, https://github.com/maplibre/maplibre-gl-js/pull/3225
24. MapLibre GL JS worker liveness: https://github.com/maplibre/maplibre-gl-js/pull/8491, https://github.com/maplibre/maplibre-gl-js/issues/8461
25. OpenLayers iOS canvas memory: https://github.com/openlayers/openlayers/issues/8956, https://github.com/openlayers/openlayers/pull/9133, https://github.com/openlayers/openlayers/pull/13321, https://github.com/openlayers/openlayers/commit/22dba410a, https://github.com/openlayers/openlayers/commit/720ccbcd4
26. OpenLayers rotated clip on iOS 12: https://github.com/openlayers/openlayers/issues/8531
27. OpenLayers context loss: https://github.com/openlayers/openlayers/commit/7a9580cab
28. Major performance caveat: https://github.com/openlayers/openlayers/commit/d6dc1a2c6, https://github.com/CesiumGS/cesium/commit/2b34d0aac
29. maptalks WebGL context eviction: https://github.com/maptalks/maptalks.js/issues/1159, `ref-repos/maptalks__maptalks.js/packages/fusion.gl/README.md`
30. RustGIS WebGPU destroy: https://github.com/opengeos/RustGIS/pull/630
31. tangram-es CPU texture release: https://github.com/tangrams/tangram-es/commit/e97a2b0a, https://github.com/tangrams/tangram-es/commit/d4175f7f, https://github.com/tangrams/tangram-es/commit/40f82f6f
32. MapLibre Native texture pool: https://github.com/maplibre/maplibre-native/pull/2709
33. MapLibre Native tile cache toggle: `ref-repos/maplibre__maplibre-native/platform/ios/CHANGELOG.md`, `ref-repos/maplibre__maplibre-native/platform/android/CHANGELOG.md`, https://github.com/maplibre/maplibre-native/commit/1ae14a55d, https://github.com/maplibre/maplibre-native/commit/a4258ccbb, `ref-repos/maplibre__maplibre-native/src/mln/renderer/render_orchestrator.cpp`
34. OpenLayers 2 tile loading and memory: https://github.com/openlayers/ol2/blob/master/notes/2.12.md, https://github.com/openlayers/ol2/blob/master/notes/2.13.md, https://github.com/openlayers/ol2/blob/master/lib/OpenLayers/TileManager.js, https://github.com/openlayers/ol2/pull/179, https://github.com/openlayers/ol2/commit/339d1eba, https://github.com/openlayers/ol2/commit/faa0e60b, https://github.com/openlayers/ol2/issues/1155
35. OpenLayers 2 CSS GPU compositing: https://github.com/openlayers/ol2/issues/800, https://github.com/openlayers/ol2/issues/513, https://github.com/openlayers/ol2/issues/1181, https://github.com/openlayers/ol2/commit/64d291ea, https://github.com/openlayers/ol2/commit/13b4ca65, https://github.com/openlayers/ol2/commit/aa5bab25, https://github.com/openlayers/ol2/commit/d2b3bded, https://github.com/openlayers/ol2/commit/774e9836, https://github.com/openlayers/ol2/blob/master/lib/OpenLayers/Layer/Grid.js, https://github.com/openlayers/ol2/issues/511, https://github.com/openlayers/ol2/issues/542
36. Leaflet GridLayer options: `ref-repos/Leaflet__Leaflet/docs/reference.html`
37. Leaflet Android and 3D switches: https://github.com/Leaflet/Leaflet/pull/2216, https://github.com/Leaflet/Leaflet/issues/1759, https://github.com/Leaflet/Leaflet/issues/1182, `ref-repos/Leaflet__Leaflet/docs/_posts/2025-05-18-leaflet-2.0.0-alpha.md`
38. Leaflet Pointer Events: https://github.com/Leaflet/Leaflet/issues/7200, `ref-repos/Leaflet__Leaflet/docs/_posts/2016-03-20-debugging-touch-interactions.md`, https://github.com/Leaflet/Leaflet/commit/747b1f73, https://github.com/Leaflet/Leaflet/commit/95c43663
39. Leaflet passive listeners: https://github.com/Leaflet/Leaflet/commit/67102996, https://github.com/Leaflet/Leaflet/commit/9be733ee
40. Leaflet layout reads and style costs: https://github.com/Leaflet/Leaflet/commit/0f8f2fb0, https://github.com/Leaflet/Leaflet/commit/9c0cef03, `ref-repos/Leaflet__Leaflet/docs/_posts/2013-11-18-leaflet-0-7-released-plans-for-future.md`, `ref-repos/Leaflet__Leaflet/docs/_posts/2012-07-30-leaflet-0-4-released.md`
41. Leaflet wheel, trackpad and rAF animation: https://github.com/Leaflet/Leaflet/issues/2154, https://github.com/Leaflet/Leaflet/pull/3653, https://github.com/Leaflet/Leaflet/pull/2382
42. Leaflet iOS memory: https://github.com/Leaflet/Leaflet/commit/9fce6979, https://github.com/Leaflet/Leaflet/commit/14c5f160
43. Modest Maps gesture deferral: https://github.com/stamen/modestmaps-js/issues/103, https://github.com/stamen/modestmaps-js/commit/86ffcde, https://github.com/stamen/modestmaps-js/commit/dfec3cf
44. deck.gl picking during drag: https://github.com/visgl/deck.gl/commit/08c389d8, https://github.com/visgl/deck.gl/commit/173a43ea
45. OpenLayers hitTolerance: https://github.com/openlayers/openlayers/issues/5862, https://github.com/openlayers/openlayers/pull/5995
46. deck.gl allocation limits: https://github.com/visgl/deck.gl/blob/master/docs/developer-guide/performance.md, https://github.com/visgl/deck.gl/blob/master/docs/developer-guide/tips-and-tricks.md, `ref-repos/visgl__deck.gl/docs/developer-guide/tips-and-tricks.md`
47. MapLibre Native Android backends: `ref-repos/maplibre__maplibre-native/docs/mdbook/src/platforms/android/android-build-flavors.md`, `ref-repos/maplibre__maplibre-native/platform/android/CHANGELOG.md`
48. MapLibre Native driver workarounds: https://github.com/maplibre/maplibre-native/commit/822df3dd5, https://github.com/maplibre/maplibre-native/commit/1188707dc, https://github.com/maplibre/maplibre-native/commit/874244a65, https://github.com/maplibre/maplibre-native/commit/eed89fcf9, https://github.com/maplibre/maplibre-native/commit/441644166, https://github.com/maplibre/maplibre-native/commit/de91e6809, https://github.com/maplibre/maplibre-native/commit/bf9c1fb1b, https://github.com/maplibre/maplibre-native/commit/0bbc6b814, https://github.com/maplibre/maplibre-native/commit/00d133239e22fc6df84f81596820ca46afb351bb
49. tangram-es driver workarounds: https://github.com/tangrams/tangram-es/commit/3cbe1657, https://github.com/tangrams/tangram-es/commit/8f7bcd23, https://github.com/tangrams/tangram-es/commit/c4b4bc5b, https://github.com/tangrams/tangram-es/commit/cff34a41, https://github.com/tangrams/tangram-es/commit/5339801d, https://github.com/tangrams/tangram-es/commit/31f46ae9, https://github.com/tangrams/tangram-es/commit/107c14fa, https://github.com/tangrams/tangram-es/commit/c0823152
50. Precision and float filtering: https://github.com/pelicanmapping/osgearth/commit/543139a417627e48fd9b8c8ead2a947122791bc7, https://github.com/openlayers/openlayers/commit/3849cf272, https://github.com/openlayers/openlayers/commit/30ec260c4, https://github.com/vasturiano/globe.gl/issues/44, `ref-repos/vasturiano__globe.gl/README.md`
51. osgEarth texture compression on GLES: https://github.com/pelicanmapping/osgearth/commit/074efe0954477a6b77c044d5058ae8ddbe9a5d18, https://github.com/pelicanmapping/osgearth/commit/4a2919516d4852773d0734b45f00e0ec7fa7c0e9
52. MapLibre Native benchmarking: `ref-repos/maplibre__maplibre-native/docs/mdbook/src/platforms/android/benchmark.md`, https://github.com/maplibre/maplibre-native/issues/2787, https://github.com/maplibre/maplibre-native/issues/4130
53. OsmAnd-core render thread and re-init: https://github.com/osmandapp/OsmAnd-core/pull/1113
54. Capping library caches: https://github.com/osmandapp/OsmAnd-core/pull/1126, https://github.com/osmandapp/OsmAnd-core/pull/1128, https://github.com/osmandapp/OsmAnd-core/commit/4dccba80, https://github.com/pelicanmapping/osgearth/commit/92b999b26
55. OsmAnd-core native allocation and I/O: https://github.com/osmandapp/OsmAnd-core/commit/8989ea92, https://github.com/osmandapp/OsmAnd-core/commit/67994e28, https://github.com/osmandapp/OsmAnd-core/commit/841faee6, https://github.com/osmandapp/OsmAnd-core/commit/53fa3489, https://github.com/osmandapp/OsmAnd-core/commit/c1ea8b04, https://github.com/osmandapp/OsmAnd-core/commit/f7f762f8
56. Bundled archives by range: https://github.com/maplibre/maplibre-native/commit/c75849437, `ref-repos/maplibre__maplibre-native/platform/android/MapLibreAndroid/src/cpp/asset_manager_file_source.cpp`, https://github.com/maplibre/maplibre-native/pull/3404, https://github.com/tangrams/tangram-es/issues/1309, https://github.com/tangrams/tangram-es/pull/1015
57. tangram-es start-up and fonts: https://github.com/tangrams/tangram-es/commit/de7d9483, https://github.com/tangrams/tangram-es/commit/ae94b01e, https://github.com/tangrams/tangram-es/pull/649, https://github.com/tangrams/tangram-es/issues/2215, https://github.com/tangrams/tangram-es/pull/2217
58. Marble: `ref-repos/KDE__marble/MANIFESTO.txt`, https://github.com/KDE/marble/commit/6acd62b8a, https://github.com/KDE/marble/commit/0621ff528, https://github.com/KDE/marble/commit/a6f946ed2, https://github.com/KDE/marble/commit/d68eb5f52, https://github.com/KDE/marble/commit/e2091b15c, https://github.com/KDE/marble/commit/9d90adc92
59. Cesium per-frame work: https://github.com/CesiumGS/cesium/commit/2c162b1df, https://github.com/CesiumGS/cesium/commit/c6efe94f3, https://github.com/CesiumGS/cesium/commit/110f30f3f, https://github.com/CesiumGS/cesium/commit/2dc7b54ff
60. MapLibre tile spec codecs: `ref-repos/maplibre__maplibre-tile-spec/docs/benchmarks.md`, `ref-repos/maplibre__maplibre-tile-spec/docs/encodings.md`, https://github.com/yuiseki/maplibre-tile-spec/commit/40de5e70, https://github.com/yuiseki/maplibre-tile-spec/commit/a6600773
61. vts-browser-js caches: https://github.com/melowntech/vts-browser-js/commit/5328917, https://github.com/melowntech/vts-browser-js/commit/90a7f5e, https://github.com/melowntech/vts-browser-js/commit/478b932, `ref-repos/melowntech__vts-browser-js/src/core/map/cache.js`, `ref-repos/melowntech__vts-browser-js/src/core/map/map.js`, `ref-repos/melowntech__vts-browser-js/src/core/map/draw.js`
62. kothic-js canvas pool: https://github.com/kothic/kothic-js/issues/28, https://github.com/kothic/kothic-js/commit/e04e85c, https://github.com/kothic/kothic-js/commit/93ca80c, https://github.com/kothic/kothic-js/commit/b312ee6
63. harp.gl placement skip: https://github.com/heremaps/harp.gl/commit/c86a113b
64. protomaps-leaflet Safari path cap: https://github.com/protomaps/protomaps-leaflet/issues/57, https://github.com/protomaps/protomaps-leaflet/commit/856c2bb, https://bugs.webkit.org/show_bug.cgi?id=231157
65. MapLibre GL JS layer snapshot proposal: https://github.com/maplibre/maplibre-gl-js/pull/7635
66. QGIS provider simplification: https://github.com/qgis/QGIS/pull/980, https://github.com/qgis/QGIS/issues/17441
67. GRASS memory: https://github.com/OSGeo/grass/commit/3e4e4048b, https://github.com/OSGeo/grass/commit/b13e774c3ae92bd040e017f97058df42fafc2765
68. TileMill inspection cap: https://github.com/tilemill-project/tilemill/issues/1275
69. Leaflet canvas hover throttle: https://github.com/Leaflet/Leaflet/commit/6aaad717
