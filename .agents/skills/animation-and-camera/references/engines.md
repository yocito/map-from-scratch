# Animation and camera, engine by engine

Bracketed numbers refer to the Sources list in [../SKILL.md](../SKILL.md).
Each item: what was decided, the alternative, the cost, and the evidence.

## MapLibre GL JS

- **Terrain under gestures.** Every gesture freezes the centre elevation
  from its first frame with terrain; DEM tiles or `setTerrain` calls that
  arrive during the hold are applied at release, re-solving zoom and centre
  while the camera stays still. At rest a terrain change keeps the centre
  and moves the camera; an easeTo/flyTo releases the freeze when it ends.
  Freezing only for drag and zoom made rotate and pitch bob every frame;
  keeping the camera still for every terrain change moved content by its own
  elevation (~60 px) and was reverted; re-clamping in every case changed 32
  of 87 terrain render fixtures. Result, measured with a Puppeteer matrix of
  six gestures on mercator z12 and globe z9: no 90-200 px jumps at gesture
  start; terrain toggled from pitchend went from 2844 m / 64.7 px to 2 m /
  0.0 px; 87/87 terrain render tests pass. Some panning jumps and the
  push-out from inside terrain stayed buggy (#8539) [1].
- **Ground clearance.** During a held gesture the camera and near plane are
  lifted clear of terrain; at gesture end the centre is re-solved by an
  iteration using the Mercator scale at the new latitude, with one cap and a
  stop when a pass moves further than the previous one. The earlier loop
  (10-iteration cap, no divergence stop) oscillated at high latitudes and on
  zoom-outs; its single-pass replacement used the old latitude's scale and
  moved the camera 7-22 m at inertia hand-off. Over 23 gesture scenarios,
  depth inside terrain fell from hundreds of metres to under 1 m and the
  release jump from km to at most 34 cm; main went 719 m into the mountain
  and was thrown 4 km up; 18 of 29 new unit tests fail on main. Globe was
  left for a separate PR [2].
- **Label placement during motion.** Symbols were re-placed at most every
  300 ms during rotate/pitch and on pan only above 25 degrees pitch, then
  replaced months later by viewport collision with fades [3]. A label twice
  as far away is drawn at 75% rather than 50% size; line labels beyond
  camera distance 1.5 are hidden [4]. Placement is time-sliced (~2 ms per
  frame), but forced complete when `fadeDuration` is 0, because labels did
  not appear when collision took longer than 2 ms (#7609) [5].
- **Raster requests while moving** are throttled to a configurable number
  per frame; the first version regressed performance because the throttled
  queue did not advance on its own, fixed by processing it on each render
  while moving (#2278, with a unit test) [6].
- **Terrain drapes.** While moving only the nearest stale drape is
  re-rendered per frame unless the visible layer set changed; one changed
  draped layer no longer re-renders all; colour-relief DEM textures upload
  once per tile, not every frame ("hundreds of MB/s for nothing" while
  panning) [7].
- **Wheel and trackpad** (code, not a decision record). Line deltas x40; a
  delta that is a multiple of 4.000244140625 is a wheel tick; a gap over
  400 ms starts a new gesture and waits 40 ms to classify a lone event;
  otherwise |timeDelta * delta| < 200 means trackpad. Trackpad and single
  ticks use rate 1/100, fast wheels 1/450, and one frame scales at most 2x
  [115].
- **flyTo** follows van Wijk and Nuij (2003), with `curve` (rho),
  `screenSpeed` and `maxDuration` options, and lowers rho when the natural
  arc would pass minZoom [116].

## MapLibre Native

- **`synchronousUpdate`** GeoJSON source option updates tiles on the render
  thread so a location indicator moves smoothly; a constructor option, not a
  toggle, because switching propagates asynchronously; recommended only for
  small updates; +125 KiB binary [8].
- **Placement throttle**: at most once every 300 ms; re-placement on
  camera-to-tile distance only above 25 degrees pitch; none for zoom at low
  pitch; no throttling in still (static image) mode [9].
- **Placement period tied to motion**: while zooming out, fades are shorter
  and placement more frequent (the old viewport area was full of colliding
  labels); pitched views place more rarely, since new symbols are far away
  [10]. Offscreen placed symbols skip the fade, and items outside the
  collision grid are not marked placed, so they cannot cascade into
  collisions inside the viewport (GL JS #5654) [118].
- **Tile LOD under pitch** (tile-lod-and-overzoom skill): distance-based
  splitting and loading nearest the camera first; a zoom shift of -1 cuts
  tiles by a factor of 4 at visible quality cost [11].

## maplibre-rs

- **Redraw on change.** The winit RedrawRequested handler requested another
  redraw, a busy loop: ~40% CPU and 25-35% GPU idle on an M1 Max, earlier
  near 100% GPU in the background, 5% CPU on Wayland. Moving the request into
  the input handler gave "near zero cpu usage". The issue is still open [12].
- **Far plane.** A port of GL JS's formula allowed pitch in one direction
  only (90, not 180 degrees) and no yaw with pitch; it was replaced by a
  derivation from a gamedev.stackexchange answer that works for yaw, pitch
  and roll and is "way faster to calculate" (no benchmark); pitch/yaw were
  limited to 30 degrees in that PR [13].

## navara

- **Labels default to hidden** until they claim space. The earlier "when in
  doubt, show it" showed every label on load and swept a wave of
  full-opacity labels in and out on every pan (300 ms fade-in, collision
  found up to 150 ms later, 300 ms fade-out). Now a label entering view
  waits one pass (up to 150 ms); the 128 px margin hides this [14].

## RustGIS

- **Tilt on the CPU first**: north-up ground bands each twice as far, drawn
  at their near edge's scale and draped while moving (35 fps mid-drag vs
  ~3 fps); later a GPU view-projection matrix with per-band depth discard
  (26 ms vs 316 ms per frame), then a depth buffer for extrusions (~20 ms
  per frame with 4x MSAA, Depth24PlusStencil8). Painter's far-to-near
  extrusions were wrong where features interlock [15].
- **Stand-ins while moving**: pictures already drawn stand in, stretched,
  for missing ones (same square at another resolution, a zoom up to two
  levels away, the parent or four children); only uncovered squares are
  drawn, for about a frame, nearest the middle first; settled frames draw the
  rest a frame's worth at a time. The old cache keyed on exact resolution and
  zoom to 1/256 of a level missed on every motion frame. Headed Chrome,
  Liberty over Manhattan: worst pan frame 650-1010 ms to 110-270 ms; zoom in
  540-790 to 60-120 ms; zoom out 630-990 to 80-390 ms [16].

## Re:Earth (reearth-visualizer)

- `requestRenderMode` made conditional on animating widgets (#439), then
  disabled because 3D Tiles styles were attached asynchronously and frames
  were missed, re-enabled after four months with a ref: -1 force render
  (layer dragging, animating widgets), 0 idle, 1 render once; a postUpdate
  listener calls `scene.requestRender()`; `maximumRenderTimeChange` is 0 only
  while the timeline animates; a `debugFramePerSecond` property was added. A
  later 100 ms polling `requestRender` workaround was added and removed
  again (#2276) [17].

## Cesium

- **requestRenderMode** (1.42): a frame only on scene changes, explicit
  `requestRender()`, or simulation time advancing more than
  `maximumRenderTimeChange`; the scene still updates every tick. Continuous
  stays the default. Follow-ups: continuous rendering after resize (#6812),
  dynamic geometries causing continuous rendering (#6631), geometry entities
  not rendering in this mode (#12841) [18].
- **Dirty checks**: 170 time-dynamic ellipsoids 15 to 100 fps by checking
  instance attribute values before setting; a re-assigned canvas billboard
  image is treated as unchanged (it made a new atlas texture every frame,
  and lost automatic canvas-redraw animation); SVG text set only when
  changed [19].
- **Rebatching** keeps the old primitives until the new ones are ready (data
  flashed on and off before; double memory meanwhile) [20].
- **`setPositions(positions, offset, count)`** with per-attribute dirty flags
  uploads only positions for a range; vertex count cannot change [21].

## deck.gl

- **DataFilterExtension**: a per-object filter value plus a `filterRange`
  uniform; out-of-range objects are hidden in the vertex shader, so a time
  window changes one uniform. Cost: one generic attribute + one uniform;
  filtered vertices still run the vertex shader. Rejected: passing a
  filtered array (recomputes all attributes) and per-layer radius 0 or
  transparent colour (transparent polygons still pick) [22].
- **Basemap sync**: copying the Google Maps viewport from its draw callback
  tore and lagged a frame because the map had already rendered; the advice
  was to disable Google Maps' interaction and drive it from deck's
  controller. Google Maps' integer `setZoom` then made the basemap jump
  between zooms while deck zoomed smoothly [23].
- **fovy separate from altitude** to match Google Maps; scaling zoom was
  rejected because scale = 2^zoom runs through shaders and TileLayer. A
  mismatched altitude made `getBounds` return +-1,706,482,542, creating a
  runaway number of world copies that hung the tab at pitch 63 [24].
- **Trackball globe** through the poles with pointer-anchored zoom was
  reverted after a month (-541 lines) to restore north-up navigation
  "while alternative navigation modes await maintainer consensus" [25].

## QGIS

- **Texture origin** from the unclipped geometry's upper-left corner, so
  fills do not jump when panning and clipping to the view can stay on [26].
- **Cached layer images during redraw**: previous images drawn scaled and
  shifted until the new render finishes; label images only within 30%-300%
  of original size ("don't want to draw massive pixelated labels... nor tiny
  unreadable labels"); results cached per finished layer job; a later fix
  invalidated the cache on rotation [27].
- **3D OnDemand** render policy: idle ~300% to ~50% CPU (top, laptop); an
  earlier attempt on Qt 5.9.0 gained nothing until a Qt fix (QTBUG-55109)
  [28].

## KDE Marble

- Loaded GPX tracks are drawn as a thick red line and the map zooms to fit
  them again; with the regressed 1 px white line and no camera move users
  thought the track had not loaded [29].

## OpenLayers

- **Load during animation** (6.0): `loadTilesWhileAnimating/Interacting`
  removed because DOM composition made frame cost independent of loading;
  passed-through tiles were later dropped from the queue (10.11, #17595) [30].
- **Pixel snapping only at rest** (5.2): `snapToPixel` removed; snapping when
  idle, none during motion; 4.3.3 reverted fractional overlay positioning
  [31].
- **One world** (6.0): no panning past the poles, extent constrains the
  whole viewport, constraints moved into View (`multiWorld: true` opt-in);
  6.3 loads either side of the antimeridian separately instead of one
  540-degree extent [32].
- **Fractional zoom**: trackpad and pinch (3.20), mouse wheel (6.2);
  `zDirection` chooses when the tile z changes; `constrainResolution` still
  snaps [33].
- **View-space vertex coordinates** computed at buffer build, with a
  per-frame matrix = current transform x inverse(build transform), fixing
  float32 jitter; buffers rebuilt when the extent changes [34].
- **Declutter beyond the viewport**: items within the render buffer take
  part, and the buffer grows to the largest label seen; less flicker while
  panning, more collision work [35].
- **Frame budget**: stop preparing new tiles after 16 ms while animating
  (2018); reduce loading after 8 ms and render vector tile images only when
  idle or under 8 ms (2021) [36].
- **No vector tile fade-in** for performance; change events only while a
  tile transition animates [37].
- **Next-step prefetch**: `nextCenter/nextResolution/nextRotation` and
  `nextExtent` let the WebGL tile renderer enqueue destination tiles [38];
  the vector render mode stopped rendering `nextExtent` tiles because of
  overdraw [40].
- **Queue reprioritised every frame**, dropping idle tiles the view no longer
  wants; a frame is rendered when pruning empties the queue only if
  something listens for render completion [39].

## OpenLayers 2

- **`resize` transition** by default (2.13): old tiles scaled on zoom, new on
  top; `map-resize` puts the copy under the base layer; GPU compositing of
  tiles "may interfere with UI widgets"; `zoomTo` became asynchronous [41].
- **0.2 s CSS fade** (2.12): iOS flicker fixed by forcing 3D transforms,
  which slowed freehand drawing on iOS; back buffer removal delayed 2500 ms
  for tiled layers [42].
- **Kinetic** on by default when the module is built in: velocity from the
  last 200 ms (up to 100 points), deceleration 0.0035 px/ms^2 [43].
- **One back buffer** positioned with one conversion; built also while tiles
  load (holes left); edge cases with fast zoom-drag-zoom took several fixes;
  957K vs 958K build [44].
- **No `transitionend` dependency**: it never fires without a CSS transition
  rule, so loadend never fired; back buffer removal by timeout (800 ms still
  flashed, 2500 ms rarely; long ones reuse a stale buffer); `tileAnimation`
  option dropped for CSS control [45].
- **Wheel deltas**: no rounding with fractional zoom; Firefox clamped to +-1;
  Safari's wheelDelta 10x smaller than Chrome's; Firefox detail multiples of
  3; Opera multiples of 40 (160 wheel, 40 analog); modulo-120 detection
  judged "too adventurous"; retiling flicker between levels remained [46].
- **Step-count tween** replaced by CSS transforms on the layer container;
  iOS 6 Safari crashes needed fixes [47].
- **rAF for kinetic panning**: "maybe a little smoother, could be
  imagination"; transform panning blocked by code reading `style.top/left`
  [48].
- **`resize` and kinetic default** once zoom was animated; Bing flashed at
  the end of each zoom without it [49].
- **TileManager**: 2 tiles per 16 ms, `moveDelay` 100 ms, `zoomDelay` 200 ms,
  driven by setTimeout because rAF callbacks may get priority [50].
- **3D transforms only if the stylesheet sets a transform** on the layer
  container; otherwise left/top except for pinch scaling [51].
- **No resize/fade on transparent layers or labels**; removal delay 0 for
  single-tile layers [52]. Same-resolution refresh swaps tiles one by one
  (`.olTileReplace`) [53].

## Leaflet

- **Renderer overscan**: Canvas/SVG cover the view plus 0.1 of its size per
  side and update after pan/zoom ends (`continuous: false`; generalised as
  BlanketOverlay in 2.0); content past the pad is blank until movement ends
  [54].
- **Pixel origin per zoom**: panning translates panes; `transform3DLimit`
  (2^23) forces a reset after very long pans [55].
- **Fractional zoom opt-in** (`zoomSnap` default 1); tiles from integer
  levels scaled; 2.0 tile URLs always integer `{z}` [56][59]. `zoomSnap` and
  `zoomDelta` chosen over several PRs; testers saw x = 123.99999997 tile
  requests [61].
- **Device switches**: hardware-accelerated CSS off on Android 2/3 (#2216);
  zoom, fade and marker animations off on Android by default; no animation
  for zoom jumps over `zoomAnimationThreshold` (4); 2.0 removed the sniffing
  [57]; `L_DISABLE_3D` kept as escape hatch and gone in v2; Android 4.1
  `transitionend` by user agent because the event cannot be detected [60].
- **Page costs**: cursor on `document`, box-shadow on mobile, rAF panning in
  0.2 [58].
- **Animations 2.0** (#2382): fractional zoom by scaling the rounded level;
  panning on rAF; parsing in-flight transforms to stop CSS transitions
  dropped (forces main-thread/GPU sync; fine on a bare grid, jumps with
  tiles and vectors); `map.stop()` a no-op during CSS zoom; `zoomPanTo`
  renamed `flyTo`; a speed option was claimed in the thread but not
  implemented, and `flyTo` reads only `duration` [59][116].
- **Tile refresh flicker**: `redraw`/`setUrl` drop all tiles and fade in over
  200 ms; plugins either preload off-screen and swap `src` (uncacheable URLs
  fetched twice) or keep old tiles until the new one loads plus the fade
  (orphaned nodes when reloads overlap); cross-fading needs exact 50%
  sync [62].
- **Transforms**: never stacked; `transform-origin: 0 0` [63].
- **Trackpad**: debounce 40 to 200 ms and first-delta detection rejected;
  continuous scaling landed in #3653, one tester saw off-centre zoom [64].
- **Throttles and coalescing**: canvas updates 66 to 32 ms by feel [65];
  one redraw per viewreset, no request/cancel churn [66]; cancel the pending
  frame on destroy, with a 46-line test [68].
- **Rounding**: round the fitBounds scale, truncate pan offsets, ignore
  sub-pixel maxBounds corrections, round positions before animating a pan
  [67].
- **`will-change`**: removed from tiles after Amsterdam saw Firefox degrade
  with several maps open; restored on `svg.leaflet-zoom-animated` after an
  SVG regression [69].
- **Layout reads**: pinch caches client offset and CSS scale; wheel defers
  the container point to `_performZoom` [70].
- **Drift**: single-touch drag only, finished when a second touch appears;
  inertia kept out of pinch; drift with `zoomAnimation: false` fixed [71].
- **Wheel deltas** (code): pixels / `getWheelPxFactor()`, lines x20, pages
  x60, horizontal ignored [114]. **flyTo** (code): rho 1.42, duration
  0.8 * S s unless given, rAF-driven [116].

## Tangram and tangram-es

- **Task queue**: 20 ms shared per-frame budget for main-thread work
  (collision, canvas text); overrunning tasks pause for `pause_factor`
  frames; tasks flagged `user_moving_view = false` are skipped during pan
  and zoom [72].
- **Proxy tiles**: collision at the tile's 1x view bunches labels when a tile
  is shown scaled down while zooming out, so their text fades out, later
  faded by proxy status to avoid flicker [73].
- **Re-collision step**: 0.25, configurable, 0.5 ("balance increasing label
  density with reducing label jumpiness"), 0.33 (2018) [74].
- **Collision not deferred on input** and run immediately even over budget,
  to avoid crowding on zoom-out [75].
- **Animate only when an animated style is in view**; an explicit
  `animated: true` no longer forces continuous redraw [76]; tangram-es does
  the same per drawn style [78].
- **tangram-es hysteresis**: last frame's hidden labels grow 2 px, last
  frame's winners sort first [77].

## harp.gl

- No fade-out for labels whose tiles left the frame (flickered on quick
  zoom-out) [79]. Label distance is camera-space Z, not Euclidean distance,
  which stopped centre labels growing and colliding out in top-down panning;
  the per-frame placement cap applies only to new labels [80].

## maptalks

- `stopRenderOnOffscreen` (default true) skips frames when the container is
  `display: none` or 0-sized; resize watched by ResizeObserver [81].

## kothic-js

- Two rAF callbacks: background + geometry, then text and icons;
  `onRenderComplete` fires after geometry. setTimeout chunking (2011) and
  per-layer asynchronous passes (2013) were replaced a month later [82].

## ModestMaps

- **Fast-forward**: one `matrix3d` on the level element instead of
  per-tile transforms, "a lot faster, both in profiling and normal
  interaction", but white seams in Safari during drags and slower Firefox/IE
  < 10; master reverted ("Too rocky for general consumption") [83].
- **Defer tiles to gesture end**: touchmove stopped firing at zoom-level
  boundaries while tiles updated on every move; updates on touchend or 100 ms
  after the last touchmove fixed it, on a branch only [84].
- **`getFrame`** must call rAF with `window` as receiver [85].

## Polymaps

- **SVG for everything** including rasters: CSS styling and DOM events, but
  no hardware-accelerated transforms, stutter at level switches, seams; a
  canvas layer or WebGL never landed and Stamen moved to Leaflet [86].
- **Wheel**: moving average, single-delta dampening, [-1, 1] clamp, a
  wheelDelta >= 4800 threshold (deltas accumulated during redraws), a
  time-since-last check ("take 6"), finally a real scroll of a hidden
  element [87].
- **Anchor zoom on cached cursor location**, cleared on other moves; hash
  control ignores its own hashchange events [88].

## d3-geo

- **fitExtent/fitSize** computes bounds with clip extent off and precision at
  an effective scale of 150; per-projection default geometry was rejected as
  "magical" [89].
- **Euler rotation**; interactive rotation via versors lives outside d3-geo;
  versor-to-Euler conversion jumps at rotate [0, +-90] (fixed in attitude
  0.1.3) [90].

## globe.gl

- **Near plane 0.05** and `minDistance` from it: first
  globeR * (1 + max(1e-5, near * 0.012)), a day later
  globeR + max(0.001, near * 1.1); `maxDistance` = globeR * 100; earlier
  fixed 1.01 * globeR did not allow tile close-ups [91].
- **Speed by altitude**: rotate alt * 0.06 and zoom (alt + 1) * 0.1 (2019),
  rotate alt * 0.2, then alt * 0.3 with zoom sqrt(alt) * 0.4 (tiles, 2025),
  then zoom sqrt(alt) * 0.5 with zoomToCursor; no measurements [92].
- **Tweens** removed from the group when done (memory leak) and the running
  point-of-view tween ended before a new one starts [93].

## iTowns

- **rAF update loop** had to batch completed commands and limit concurrent
  commands per host: first textured globe ~20 s vs 3 s, loading 8.5 s vs
  1.2 s and 3.4 s vs 1.2 s, high-res before low-res tiles [94].
- **Slerp** for near-identical quaternions fixed upstream (three.js r94) [95].
- **Redraw only on `notifyChange(needsRedraw)`**; the loop stops itself;
  commands can declare they need no redraw [96].

## TerriaJS

- **Scale bar**: skip unchanged frames, otherwise at most every 200 ms (it
  did two globe picks, a MobX action and a React render per frame) [97].
- **CZML path resolution** = data interval (86400 s): the default 60 s turned
  365 samples into 525,600 vertices, ~1 GB, sluggish; after the change "it
  performs great" with 118 species [98].
- **Discrete time validity**: each step until the next, the last for the
  previous interval; initial time is now or the closest; the UI tag and
  timeline cursor can differ (10:00 vs 11:00) [99].
- **Cancel on remove, delay first request 100 ms** [100].
- **Next step at opacity 0**, swapped in when the clock enters it; two
  layers' requests and memory; a race noted in the code [101]. Later only
  while the clock runs, and never picked [103].
- **Retained Leaflet layers updated by diff** (setLatLngs/setStyle only when
  values changed): "drastically faster" polygons in 2D [102].
- **Mouse move**: one change event instead of observable coordinates,
  module-level scratch objects for picks, at most one event per frame with
  positions snapshotted [104].

## VTS browser

- Label show/hide by per-job timers exceeding style-defined hysteresis
  durations, with proportional fade; sort hysteresis turned on two days
  after being added; state must survive tile reloads; about 15 "hysteresis"
  commits over 15 months [105].

## WebWorldWind and WorldWind Java

- **`prePopulateCurrentTiles`** retrieves the whole current tile set with
  redraw suppressed; the BlueMarble time-series example prefetches all
  months before animating [106].
- **Camera as the single state**: LookAt-to-Camera rounding left > 1 m on the
  last tick at heading and tilt 15, so GoTo never ended; keeping both in sync
  and exact arithmetic were rejected [107].
- **Near/far** (Java): near below the terrain distance, never below
  `MINIMUM_NEAR_DISTANCE` ("significantly reduces the depth precision");
  far = horizon distance [108].

## osgEarth

- GPU operations per frame by a 1.5 ms budget instead of one per frame;
  terrain defaults `progressive=true`, `mergesPerFrame=max` [109].

## MapServer

- Map rotation rotates a symbol only when its angle is set; angle 0 or unset
  stays screen-aligned (an explicit alignment flag would be clearer) [110].

## OsmAnd-core

- **Hysteresis on the geometry grid**: applied zoom kept in state; a step
  only when the live zoom leaves by more than STEP/2 + 0.01. Stress case
  16.25 +- 1e-5 over 120 updates: plain grid 119 rebuilds, p95 50.43 ms;
  settle approach 0 rebuilds, 0.033 ms; hysteresis model 0 rebuilds, 14->15
  still 3. The x.5 integer level flip was left without hysteresis [111].
- **Marker position pushed every animation step** to the renderer state:
  arrow 591 -> 779 -> 958 px, sector gap 66 -> 253 -> 431 px over 15 s in the
  emulator, ~20 km on a real drive; emulator fixes have no timestamp, so the
  animation never started there and hid the bug [112].
- **Long lines clipped** to the view enlarged 3x per side; rebuilt only after
  a pan larger than the box or a zoom change over a threshold (0.5, later
  0.1 with fractional-zoom scale) [113].

## This repository

- Examples 02, 03, 07: one coalesced `requestAnimationFrame` per change;
  wheel zoom `exp(-deltaY * 0.002)` about the cursor without a `deltaMode`
  check; `getBoundingClientRect()` per pointer event; 03 plays one day per
  second from the rAF timestamp and changes one uniform [117].
