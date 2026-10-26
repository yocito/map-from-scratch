---
name: animation-and-camera
description: What 37 map engines learnt about the camera and everything that moves (on-demand redraw, camera state and transforms, wheel/trackpad/pinch input, fly-to and inertia, fractional zoom, per-frame work budgets while moving, placeholders and fades, time-series playback, near/far planes and terrain under a tilted or globe camera), including what they reverted. Load it when a map-from-scratch request pans, zooms, tilts, flies to places or plays data over time, before writing the render loop, the camera or the input handlers, and whenever a bench or a user shows idle CPU/GPU use, jank or long frames during gestures, drift, jitter, over-zooming on trackpads, popping or flicker during motion, or a camera that ends up inside the terrain.
---

# Animation and camera: one camera state, frames only on change, little work while moving

A map moves in three ways: the user drags, pinches and scrolls; the program
flies the camera somewhere; and the data itself changes over time. Each one
tempts a renderer into the same mistakes. It redraws when nothing changed
(Cesium added on-demand rendering to cut CPU use [18]; QGIS 3D idled at
~300% CPU until it did the same, then ~50% [28]; maplibre-rs idled at ~40%
CPU on an M1 Max [12]). It lets two pieces of code own the camera, which leaves layers
drifting or misplaced [63][71][23]. It feeds input events straight into
discrete steps, so trackpads over-zoom [64][87]. And it does the expensive
work (tile decoding, label placement, rasterising) inside the frames of a
gesture, so the gesture stutters [36][84][16]. The engines converged on one
camera state from which every frame's transform is derived, a frame
requested only when something invalidates it, animations driven by the
renderer's own clock, continuous zoom with discrete levels chosen
explicitly, and a time budget that defers or approximates work while the
camera moves and finishes it when it stops.

## First: which motions does the request have?

| request | what it needs | what it can skip |
|---|---|---|
| a static image, a print, a screenshot test | one full draw, no throttling [5][9] | everything below |
| pan and zoom over baked data on the GPU | on-demand redraw, one camera, wheel/pinch handling | budgets, placeholders, prefetch (the frame is already cheap) [54] |
| streamed tiles, labels placed at run time | the above plus per-frame budgets, placeholders, label stability | |
| programmatic fly-to | wall-clock animation, cancel the previous one, prefetch the destination [38][93] | |
| time playback | one uniform per frame, or prefetch step t+1 while playing [22][103] | per-frame rebuilds |
| tilted 3D, terrain, globe | near/far planes, ground clearance, speed by altitude [91][92][2] | free rotation unless asked [25] |

The repo's examples already draw on demand with one coalesced rAF and
upload everything once (patterns.md; 02, 03, 05) [117]. Most of this skill
is about not losing that as the request grows.

## Decisions, with trade-offs and evidence

### 1. Draw only when something changed, and centralise "changed"

- Every engine that started with a continuous loop moved off it: Cesium's
  `requestRenderMode` [18], QGIS 3D (OnDemand, idle ~300% to ~50% CPU) [28],
  iTowns ("redraws are performed if requested, and only if requested") [96],
  tangram and tangram-es (loop only while an animated style is in view)
  [76][78], maptalks (no frames while the container is hidden or 0-sized;
  size watched by ResizeObserver, not setInterval) [81]. maplibre-rs's
  busy loop came from a redraw handler that requested the next redraw;
  moving the request into the input handler gave "near zero cpu usage" [12].
- The cost is a long tail of "what counts as a change". Cesium fixed both
  runaway redraws (after a resize; with dynamic geometry) and missed ones
  (geometry entities not drawn) for years [18]. Re:Earth turned on-demand
  rendering on, off for four months because asynchronously styled 3D Tiles
  were never drawn, and back on with a three-state request (-1 force
  continuous while dragging or animating, 0 idle, 1 render once) [17].
- Coalesce: at most one pending frame per burst. Leaflet collapsed multiple
  redraws per viewreset and found its old code requested and "cancelled"
  frames without cancelling them [66]; iTowns' first rAF loop re-rendered per
  completed tile command and took ~20 s instead of 3 s to the first textured
  globe [94]. Cancel the pending frame on teardown (Leaflet crashed drawing
  into a destroyed context) [68].
- Dirty-check before uploading: Cesium went from 15 to 100 fps with 170
  time-dynamic ellipsoids by not resetting unchanged attributes, and stopped
  creating a new atlas texture every frame for a re-assigned canvas [19].
  Overlays derived from the camera (a scale bar) must be dirty-checked too:
  TerriaJS's did two globe picks and a React render per frame [97].

### 2. One camera state; derive each frame's transform from it

- Leaflet's zoom animation kept breaking because transforms were stacked
  and composed in an order that differed per input path; the fix was to
  never stack, set one accumulated translate+scale computed from the start
  state, and use `transform-origin: 0 0` ("greatly simplify zoom animation
  calculations - finally!!!") [63].
- WebWorldWind's fly-to never ended: it set a LookAt each tick, which went
  through a LookAt-to-Camera conversion whose rounding left >1 m of error,
  so the convergence test never passed. The camera became the only state
  and the animator drives it directly [107].
- Polymaps anchored wheel zoom on the location cached under the cursor and
  stopped re-reading its own rounded URL hash, which had drifted smooth zoom
  [88]. Keep camera state at full precision; never round-trip it through a
  serialised or display form.
- One owner at a time. deck.gl over Google Maps lagged a frame and tore
  when the overlay followed the basemap's draw callback; the advice was to
  let the overlay's controller drive the basemap [23]. Leaflet ends a drag
  when a second finger lands and keeps inertia out of pinch, or vector
  layers drift against tiles [71]. One programmatic animation at a time:
  globe.gl leaked finished tweens and let concurrent fly-tos fight until it
  cancelled the previous one [93].
- Constraints live in the camera, not in each handler: OpenLayers moved all
  of them into View and limited the view to one world [32].
- Keep the camera in your own variables, not in DOM style: ol2 could not
  move panning to CSS transforms because other code read
  `style.top/left` [48]. Derive bounds and culling from the same frustum you
  render with: deck.gl's mismatched altitude gave bounds of +-1.7e9 and hung
  the tab at pitch 63 [24].
- When one object is drawn by two subsystems, push the same animated
  position to both every step: OsmAnd's heading sector stayed behind the
  location arrow by up to 431 px (about 20 km on a real drive) because it
  was updated only when the accuracy circle was visible [112].

### 3. Animate in wall-clock time with your own clock

- ol2's first animated zoom used a tween whose "duration" was a step count,
  so it ran at different speeds per browser [47]. CSS-transition-driven
  animation needed events that may never fire: ol2's back buffer was never
  removed when the app had no transition rule, and was replaced by a
  timeout [45]; Leaflet needed a user-agent hack for Android 4.1
  `transitionend` [60]. Leaflet then moved panning to rAF and gave up
  reading in-flight CSS transforms, which forces CPU/GPU sync and lagged
  with tiles and vectors; a CSS zoom can no longer be stopped mid-way [59].
- Fly-to: Leaflet and MapLibre use van Wijk and Nuij's zoom-pan curve
  [116]. Leaflet derives the duration from the path length (rho = 1.42,
  0.8 * S seconds unless `options.duration` is passed) and has no speed
  option; the speed option was assumed in #2382 but never added [59][116].
- Interpolate orientations carefully near identity: three.js slerp was
  imprecise for near-identical quaternions; iTowns got lerp+normalise for
  small angles fixed upstream instead of keeping its own [95].
- Bind platform functions: ModestMaps' cached unbound
  `webkitRequestAnimationFrame` broke Chrome and was reverted [85].

### 4. Input: wheel, trackpad, pinch, inertia

- Treat zoom as continuous during input and snap, if at all, afterwards.
  Debouncing Apple trackpad streams into integer steps (40 to 200 ms windows,
  first-delta detection) over-zoomed or felt sluggish; Leaflet now scales
  continuously like pinch and animates to the final zoom [64]. OpenLayers
  let trackpad, pinch and then wheel end at fractional zoom [33]; ol2 stopped
  rounding wheel deltas when fractional zoom was on [46].
- Normalise deltas by `deltaMode`, then by device. Leaflet multiplies line
  deltas by 20 and page deltas by 60 [114]; MapLibre multiplies lines by 40,
  classifies a stream as trackpad or wheel from delta size and timing (400 ms
  gap = new gesture, 40 ms wait to classify a single tick) and caps scaling
  at 2x per frame [115]. Measured deltas differed 10x between Safari and
  Chrome, Firefox reported multiples of 3 and Opera of 40 [46]. Polymaps
  went through five heuristics before measuring a real scroll of a hidden
  element [87]. Test both a notched wheel and a trackpad.
- Read layout once per gesture: Leaflet caches the container origin and CSS
  scale at pinch start and resolves the wheel point once per zoom step, not
  per event [70]. Coalesce pointer events to one per frame and snapshot the
  inputs so screen and world positions describe the same instant [104].
- Page-level costs count: a `grabbing` cursor set on `document` cost
  Leaflet noticeable pan performance in Chrome, and box-shadow on controls
  was dropped on mobile [58].
- Inertia constants to start from: ol2 estimates velocity from the last
  200 ms (up to 100 points) and decelerates at 0.0035 px/ms^2 [43]; it
  became default once zoom was animated [49].
- Globe or wide altitude range: scale rotate and zoom speed by altitude.
  globe.gl went through four formulas, ending with rotate = alt * 0.3 and
  zoom = sqrt(alt) * 0.5 once tile zoom reached the surface [92].

### 5. Fractional zoom and the discrete levels derived from it

- Tiles come from integer levels, scaled: Leaflet loads the rounded level
  and scales it, keeps fractional zoom off by default (`zoomSnap: 1`), and
  builds tile URLs with integer `{z}` in 2.0 [56][59].
- Derive the level with an explicit floor/round rule and tolerance, in
  integer tile space: Leaflet's fractional zoom produced tile requests with
  x = 123.99999997, and rounding them broke low zooms [61].
- Put hysteresis on every boundary of a value rounded from the camera.
  OsmAnd's line geometry, keyed on rounded zoom, rebuilt 119 times in 120
  updates at 16.25 +- 1e-5 (p95 50 ms); a +-0.01 band gave 0 rebuilds [111].
  Tangram re-collides labels only at 1/3-zoom steps, tuned by eye through
  0.25, 0.5 and back [74].
- Snap to pixels only at rest: OpenLayers removed `snapToPixel` and snaps
  to integer pixels when no interaction or animation runs, for crisp
  rendering, and not during motion, to avoid jitter [31]. Leaflet rounds the derived scale, not
  intermediate sizes, and truncates pan offsets toward zero (floor biased
  negative offsets) [67].

### 6. Budget the work done while the camera moves

- Cap per-frame work by time, not count. OpenLayers stops preparing new
  tiles after 16 ms of a frame while animating, later 8 ms, and renders
  vector tile images only when idle or under budget [36]; osgearth went from
  one GPU operation per frame to as many as fit in 1.5 ms after one per frame
  made roads arrive very slowly at low frame rates [109]; tangram's main-
  thread tasks share 20 ms and can be skipped while the user moves [72];
  MapLibre throttles raster image requests per frame while moving [6] and
  re-renders at most one stale terrain drape per frame [7].
- Show what you have, transformed, instead of nothing. RustGIS stretched
  pictures from other resolutions, zooms or parents and drew only uncovered
  squares, nearest the middle first: worst panning frame 650-1010 ms to
  110-270 ms [16]. QGIS draws the previous layer images scaled, but reuses
  label images only between 30% and 300% of their size, and had to add
  rotation to the cache key [27]. ol2 scales one back buffer for all tiles
  rather than repositioning each [44].
- Or defer to the end of the gesture. ModestMaps' pinch stuck at zoom-level
  boundaries until tile updates moved from touchmove to touchend (or 100 ms
  after the last move) [84]; Leaflet's Canvas/SVG renderers cover the view
  plus 10% each side and redraw only when movement ends [54]; MapLibre
  applies terrain heights that arrive mid-gesture at release [1].
- Throttled redraws: Leaflet set canvas-layer updates to 32 ms after 66 ms
  felt laggy (by feel, no measurement) [65]. Kothic draws geometry in one
  rAF and labels in the next [82].
- Load during motion only if frame cost does not depend on it: OpenLayers
  dropped "postpone loading until the animation ends" once composition made
  frames independent of loading, then reprioritises the queue every frame and
  drops tiles the view no longer wants [30][39]. TerriaJS cancels pending
  tiles of removed layers and delays a new layer's first request by 100 ms
  because leftover requests "clog up the pipeline" while scrubbing [100].
  Prefetch the animation's destination, but do not draw it: OpenLayers
  enqueues tiles at the next resolution [38] and stopped rendering the next
  extent in vector mode because it overdrew [40].
- For label stability during motion (hysteresis, default-hidden, throttled
  placement, padding beyond the viewport) see the label-placement skill;
  the motion-specific numbers are in references/engines.md [3][9][10][14][77]
  [118].

### 7. Placeholders, fades and transitions

- Scaled old content is safe only under opaque content. ol2's `resize`
  transition doubled labels and translucent fills on non-opaque layers and
  was removed from label overlays; back buffers were moved behind the base
  layer [41][49][52].
- Fades cost frames. OpenLayers removed the vector tile fade-in for
  performance [37]; harp.gl stopped fading out labels whose tiles left the
  frame because it flickered on quick zoom-out [79]; ol2's CSS fade made
  every tile a GPU layer, which slowed iOS drawing [42], and Leaflet removed
  `will-change` from tiles for memory but had to restore it on the one
  animated SVG [69].
- Swap only when the replacement is ready: Cesium keeps the old batch until
  the rebatched primitive is ready (no flashing, double memory) [20]; Leaflet
  core still drops all tiles on refresh, so radar animations flicker and
  users double-buffer per tile slot [62]; ol2 replaces tiles one by one when
  only parameters change [53].

### 8. Data that changes over time

- Drive time with uniforms: deck.gl's filter keeps a per-object value
  attribute and a range uniform, so a time window costs one uniform per
  frame and one attribute per object [22] (the repo's 03 does this [117]).
  When only positions animate, keep them in their own buffer and upload a
  range (Cesium `setPositions`) [21]. A small marker that moves every frame
  can bypass the tiling/worker path (MapLibre Native `synchronousUpdate`,
  for small data only) [8].
- Prefetch step t+1, only while playing: TerriaJS draws the next step at
  opacity 0 and swaps [101], later only when the clock is not paused and
  never picks from the hidden layer [103]; WebWorldWind prefetches every
  step of a fixed-view animation with redraw suppressed [106].
- State how long a frame is valid, especially the last one: TerriaJS shows
  each step until the next and the last for the previous interval [99].
  Tessellate tracks at the data's sampling rate: Cesium's default 60 s path
  resolution turned 365 daily samples into 525,600 vertices and ~1 GB [98].

### 9. Tilted, 3D and globe cameras

- Near plane: tie the minimum camera distance to it. globe.gl fixed near at
  0.05 ("less will start causing depth z-fighting") and derived minDistance
  from it [91]; WorldWind keeps near below the distance to terrain but above
  a minimum, and far at the horizon [108]. Free yaw and negative pitch need
  a different far-plane formula than MapLibre's (maplibre-rs) [13].
- Ground clearance and late heights: freeze the centre elevation for a
  gesture, apply new DEM at release, and bound any iteration with a cap and
  a divergence stop (MapLibre: 90-200 px jumps and 719 m into the mountain
  before) [1][2]. Details are in the terrain-and-elevation skill.
- Keep north-up unless free rotation is required: deck.gl reverted a
  540-line trackball globe after a month [25]; Euler angles jump at
  rotate [0, +-90], so a drag-rotated globe should keep a quaternion [90].
- A first pitch can be cheap: RustGIS drew flat bands at doubling distances
  on the CPU and draped them while moving (35 fps vs ~3 fps mid-drag) before
  moving to a GPU matrix (26 ms vs 316 ms) and a depth buffer for
  extrusions (~20 ms) [15].

## Tried and reverted

- On-demand rendering in Re:Earth: on, off for four months, on again with
  an explicit request state [17].
- deck.gl trackball globe rotation, merged then reverted [25].
- Stacked transforms with a per-input `backwards` flag (Leaflet) [63];
  per-level `matrix3d` "fast-forward" in ModestMaps, reverted on master
  over Safari seams [83]; fractional overlay positioning in OpenLayers
  4.3.x [31].
- Wheel heuristics: debounce windows for trackpads (Leaflet) [64]; five
  delta heuristics (Polymaps) [87]; modulo-120 analog detection (ol2) [46].
- Tile loading: one tile per rAF in ol2 2.12, removed, then reinstated in a
  TileManager with setTimeout (2 per 16 ms) because rAF callbacks may
  outrank setTimeout [50]; OpenLayers' loadTilesWhileAnimating flags [30].
- MapLibre: 300 ms placement throttle, later superseded [3]; keeping the
  camera still for every terrain change (content moved ~60 px), reverted to
  pinning the centre at rest [1]; an unbounded clearance loop [2].
- Leaflet: fitBounds rounding of sizes, reverted to rounding the scale [67];
  `will-change` everywhere, then nowhere, then on one SVG [69].
- Tangram's re-collision step 0.25, 0.33, 0.5, 0.33 [74].
- TerriaJS always preloading the next time step [103].

## Guidance for a renderer here

- **Keep the repo's loop shape**: one `render()` that schedules at most one
  rAF, called by every input, data arrival and resize; nothing when idle
  [117]. Add a bench check that an idle page fires no frames, since this is
  the property engines kept losing [17][18]. Cancel the pending rAF on
  teardown [68].
- **One `cam` object at full precision** (centre, zoom, and bearing/pitch if
  used); every frame's matrix comes from it; handlers and animations only
  write it; one active animation handle replaced on each new one [63][93]
  [107]. URL or UI state is written from it, never read back into it while
  moving [88].
- **Wheel**: the examples compute `exp(-deltaY * 0.002)` with no
  `deltaMode` check [117]. Multiply line-mode deltas (Leaflet x20, MapLibre
  x40) [114][115], or a line-mode wheel zooms 20-40 times less per notch
  than those engines would (arithmetic, not measured); clamp the scale per
  event or per frame [115]. Keep the
  continuous zoom; add snapping only if raster tiles need it [56][64].
- **Pointer**: the examples call `getBoundingClientRect()` on every
  pointermove [117]; cache it at gesture start, as Leaflet does [70]. One
  gesture owns the camera; a second finger ends the pan [71].
- **Fly-to only if asked**: van Wijk curve with speed, rho 1.42, wall-clock
  time, prefetch the destination's data [38][59][116].
- **Skip the motion machinery when the frame is cheap.** Placeholders,
  budgets, deferred decoding and throttled placement exist for run-time
  tiling and labelling [16][36]. Data baked onto the GPU and moved by one
  uniform needs none of it; measure the gesture frame first, and add a
  budget only for the work that exceeds it. Leaflet's overscan, for
  instance, exists because its DOM/Canvas redraw is expensive [54].
- **Anything rounded from the camera** (tile level, LOD, label pass) gets
  an explicit rule and hysteresis [61][111]; pixel snapping only on the idle
  frame [31].
- **Time playback**: one uniform per frame [22]; prefetch t+1 only while
  playing [103]; write down the validity of each frame [99].
- **Tilt and globe**: cap pitch and keep north-up unless the request says
  otherwise [25]; tie near plane and min distance [91][108]; speed by
  altitude [92]; terrain clearance from the terrain skill [1][2].

Per-engine detail, with every number: [references/engines.md](references/engines.md).

## Sources

Local paths are relative to the repository root.

1. https://github.com/maplibre/maplibre-gl-js/pull/8471 ; https://github.com/maplibre/maplibre-gl-js/issues/8539
2. https://github.com/maplibre/maplibre-gl-js/pull/8547 ; https://github.com/maplibre/maplibre-gl-js/pull/8548
3. https://github.com/maplibre/maplibre-gl-js/commit/aefb3ee1f
4. https://github.com/maplibre/maplibre-gl-js/commit/886379839 ; https://github.com/maplibre/maplibre-gl-js/commit/b5128044a
5. https://github.com/maplibre/maplibre-gl-js/commit/5401d2f05
6. https://github.com/maplibre/maplibre-gl-js/commit/99ad3d7d0 ; https://github.com/maplibre/maplibre-gl-js/commit/af0254e20
7. https://github.com/maplibre/maplibre-gl-js/commit/4b4f0d6f4 ; https://github.com/maplibre/maplibre-gl-js/commit/a6dd56577 ; https://github.com/maplibre/maplibre-gl-js/commit/23703cb2e
8. https://github.com/maplibre/maplibre-native/pull/3968
9. https://github.com/maplibre/maplibre-native/commit/77b24bc0d ; https://github.com/maplibre/maplibre-native/commit/72f6b7359 ; https://github.com/maplibre/maplibre-native/commit/975d6b169 ; https://github.com/maplibre/maplibre-native/commit/f3fc9b2b9
10. https://github.com/maplibre/maplibre-native/commit/7d9b54a573a196d9120226c17d8dc30384f207b8 ; https://github.com/maplibre/maplibre-native/commit/f29865f31ddd9e6293053e810a65c6c093b7d597
11. https://github.com/maplibre/maplibre-native/commit/b11134a30 ; https://github.com/maplibre/maplibre-native/commit/7fe58506c ; ref-repos/maplibre__maplibre-native/src/mln/util/tile_cover.cpp ; ref-repos/maplibre__maplibre-native/include/mln/map/map.hpp
12. https://github.com/maplibre/maplibre-rs/issues/187
13. https://github.com/maplibre/maplibre-rs/pull/233 ; https://github.com/maplibre/maplibre-rs/commit/fa2c436
14. https://github.com/maplibre/navara/blob/main/guide/DECLUTTER.md
15. https://github.com/opengeos/RustGIS/pull/433 ; https://github.com/opengeos/RustGIS/pull/489 ; https://github.com/opengeos/RustGIS/pull/492
16. https://github.com/opengeos/RustGIS/commit/e6ed0d1
17. https://github.com/reearth/reearth-visualizer/commit/7a25032d ; https://github.com/reearth/reearth-visualizer/pull/583 ; https://github.com/reearth/reearth-visualizer/commit/e645ec9a ; https://github.com/reearth/reearth-web/pull/439
18. ref-repos/CesiumGS__cesium/CHANGES.md ; https://github.com/CesiumGS/cesium/pull/6115 ; https://github.com/CesiumGS/cesium/issues/6812 ; https://github.com/CesiumGS/cesium/issues/6631 ; https://github.com/CesiumGS/cesium/pull/12841
19. https://github.com/CesiumGS/cesium/commit/bfc4db038 ; https://github.com/CesiumGS/cesium/commit/bd3f0c0d9 ; https://github.com/CesiumGS/cesium/commit/8af426b69
20. https://github.com/CesiumGS/cesium/commit/bb8de2e94
21. https://github.com/CesiumGS/cesium/commit/78c1f72c1e97055127c548b06bbf2aa97bf805b2 ; https://github.com/CesiumGS/cesium/commit/de376c12ea26743dc1390eccb5819be9e53a3fc1
22. https://github.com/visgl/deck.gl/blob/master/dev-docs/RFCs/v6.0/data-filter-rfc.md ; ref-repos/visgl__deck.gl/dev-docs/RFCs/v6.0/data-filter-rfc.md
23. https://github.com/visgl/deck.gl/pull/2179
24. https://github.com/visgl/deck.gl/pull/5930
25. https://github.com/visgl/deck.gl/commit/c62e58e5 ; https://github.com/visgl/deck.gl/commit/93f0fe01
26. ref-repos/qgis__QGIS/ChangeLog:250971 (2020-07-10 Avoid texture jump when panning maps)
27. https://github.com/qgis/QGIS/commit/d883d416fe ; https://github.com/qgis/QGIS/commit/a290537b9e ; https://github.com/qgis/QGIS/commit/ab94b204a2 ; https://github.com/qgis/QGIS/commit/c6dcea7bde
28. https://github.com/qgis/QGIS/commit/18642371e9
29. https://github.com/KDE/marble/commit/fbb2d704c ; https://bugs.kde.org/show_bug.cgi?id=419998
30. ref-repos/openlayers__openlayers/changelog/upgrade-notes.md ; ref-repos/openlayers__openlayers/changelog/v10.11.0.md ; https://github.com/openlayers/openlayers/pull/17595
31. ref-repos/openlayers__openlayers/changelog/upgrade-notes.md ; ref-repos/openlayers__openlayers/changelog/v4.3.3.md
32. ref-repos/openlayers__openlayers/changelog/upgrade-notes.md
33. ref-repos/openlayers__openlayers/changelog/upgrade-notes.md ; ref-repos/openlayers__openlayers/changelog/v3.20.0.md ; ref-repos/openlayers__openlayers/changelog/v6.2.0.md
34. https://github.com/openlayers/openlayers/commit/fb455891c ; https://github.com/openlayers/openlayers/commit/75eb62363
35. https://github.com/openlayers/openlayers/commit/0f9de1544 ; https://github.com/openlayers/openlayers/commit/ff980077e
36. https://github.com/openlayers/openlayers/commit/690efda16 ; https://github.com/openlayers/openlayers/commit/c24976155 ; https://github.com/openlayers/openlayers/commit/54763d2fb ; https://github.com/openlayers/openlayers/commit/9aa890217
37. https://github.com/openlayers/openlayers/commit/dcdfc22b9 ; https://github.com/openlayers/openlayers/commit/60790fea1
38. https://github.com/openlayers/openlayers/commit/4dc66ef8e
39. https://github.com/openlayers/openlayers/commit/8d25c388a ; https://github.com/openlayers/openlayers/commit/e26e8aaab
40. https://github.com/openlayers/openlayers/commit/10f818f39
41. https://github.com/openlayers/ol2/blob/master/notes/2.13.md ; https://github.com/openlayers/ol2/blob/master/lib/OpenLayers/Layer/Grid.js
42. https://github.com/openlayers/ol2/blob/master/notes/2.12.md ; https://github.com/openlayers/ol2/blob/master/lib/OpenLayers/Layer/Grid.js ; https://github.com/openlayers/ol2/issues/511 ; https://github.com/openlayers/ol2/issues/542
43. https://github.com/openlayers/ol2/blob/master/notes/2.13.md ; https://github.com/openlayers/ol2/blob/master/lib/OpenLayers/Kinetic.js
44. https://github.com/openlayers/ol2/issues/16
45. https://github.com/openlayers/ol2/issues/127
46. https://github.com/openlayers/ol2/issues/483
47. https://github.com/openlayers/ol2/issues/503 ; https://github.com/openlayers/ol2/issues/800
48. https://github.com/openlayers/ol2/pull/128
49. https://github.com/openlayers/ol2/pull/883
50. https://github.com/openlayers/ol2/commit/48efd432 ; ref-repos/openlayers__ol2/lib/OpenLayers/TileManager.js
51. https://github.com/openlayers/ol2/commit/a309b240
52. https://github.com/openlayers/ol2/commit/4d2fb886 ; https://github.com/openlayers/ol2/commit/5879a71f ; https://github.com/openlayers/ol2/commit/8c6466bf ; https://github.com/openlayers/ol2/commit/da3dc76a ; https://github.com/openlayers/ol2/commit/1e5f8359
53. https://github.com/openlayers/ol2/commit/c8564838
54. ref-repos/Leaflet__Leaflet/docs/reference.html ; https://github.com/Leaflet/Leaflet/pull/8611
55. ref-repos/Leaflet__Leaflet/docs/examples/extending-2-layers/index.md ; https://github.com/Leaflet/Leaflet/issues/3608
56. ref-repos/Leaflet__Leaflet/docs/examples/zoom-levels/index.md ; ref-repos/Leaflet__Leaflet/CHANGELOG.md
57. https://github.com/Leaflet/Leaflet/pull/2216 ; ref-repos/Leaflet__Leaflet/docs/reference.html ; ref-repos/Leaflet__Leaflet/docs/_posts/2025-05-18-leaflet-2.0.0-alpha.md
58. ref-repos/Leaflet__Leaflet/docs/_posts/2013-11-18-leaflet-0-7-released-plans-for-future.md ; ref-repos/Leaflet__Leaflet/docs/_posts/2012-07-30-leaflet-0-4-released.md
59. https://github.com/Leaflet/Leaflet/pull/2382
60. https://github.com/Leaflet/Leaflet/issues/1759 ; https://github.com/Leaflet/Leaflet/issues/1182
61. https://github.com/Leaflet/Leaflet/pull/3523 ; https://github.com/Leaflet/Leaflet/pull/1941
62. https://github.com/Leaflet/Leaflet/issues/6659 ; https://gist.github.com/barryhunter/e42f0c4756e34d5d07db4a170c7ec680
63. https://github.com/Leaflet/Leaflet/issues/1705 ; https://github.com/Leaflet/Leaflet/commit/b5569dd0 ; https://github.com/Leaflet/Leaflet/commit/f3217357 ; https://github.com/Leaflet/Leaflet/commit/9020f4d4 ; https://github.com/Leaflet/Leaflet/commit/1e9c8649
64. https://github.com/Leaflet/Leaflet/issues/2154 ; https://github.com/Leaflet/Leaflet/pull/3653
65. https://github.com/Leaflet/Leaflet/commit/64333d2d
66. https://github.com/Leaflet/Leaflet/commit/67f12ee6 ; https://github.com/Leaflet/Leaflet/commit/7059f27d
67. https://github.com/Leaflet/Leaflet/commit/b511c7bc ; https://github.com/Leaflet/Leaflet/commit/36b60b7c ; https://github.com/Leaflet/Leaflet/commit/d9846d10 ; https://github.com/Leaflet/Leaflet/commit/7c3d7cb1 ; https://github.com/Leaflet/Leaflet/commit/3a2331d6
68. https://github.com/Leaflet/Leaflet/commit/3e8e76c7
69. https://github.com/Leaflet/Leaflet/commit/1d3e3a08 ; https://github.com/Leaflet/Leaflet/commit/388717ae ; ref-repos/Leaflet__Leaflet/src/leaflet.css
70. https://github.com/Leaflet/Leaflet/commit/0f8f2fb0 ; https://github.com/Leaflet/Leaflet/commit/9c0cef03
71. https://github.com/Leaflet/Leaflet/commit/763e841c ; https://github.com/Leaflet/Leaflet/commit/d1016279
72. https://github.com/tangrams/tangram/blob/master/src/utils/task.js ; ref-repos/tangrams__tangram/src/utils/task.js
73. https://github.com/tangrams/tangram/commit/4ed08411 ; https://github.com/tangrams/tangram/commit/eb6ec3a1
74. https://github.com/tangrams/tangram/commit/f46c9c2f ; https://github.com/tangrams/tangram/commit/551eaf56 ; https://github.com/tangrams/tangram/commit/86dc22da ; https://github.com/tangrams/tangram/commit/53e89367
75. https://github.com/tangrams/tangram/commit/628f9ee9 ; https://github.com/tangrams/tangram/commit/6d40cd9b
76. https://github.com/tangrams/tangram/commit/c60ad8b0
77. https://github.com/tangrams/tangram-es/commit/1ecd9f69 ; https://github.com/tangrams/tangram-es/commit/99ed08b6 ; https://github.com/tangrams/tangram-es/commit/9517daa6 ; https://github.com/tangrams/tangram-es/commit/bbcf82d7
78. https://github.com/tangrams/tangram-es/commit/ba9cd53e
79. https://github.com/heremaps/harp.gl/commit/a385987f
80. https://github.com/heremaps/harp.gl/commit/901b2489
81. https://github.com/maptalks/maptalks.js/commit/584eb4d96 ; https://github.com/maptalks/maptalks.js/commit/5a3aebd39
82. https://github.com/kothic/kothic-js/commit/fd58caa ; https://github.com/kothic/kothic-js/commit/10202a2 ; https://github.com/kothic/kothic-js/commit/dcc282c ; ref-repos/kothic__kothic-js/src/kothic.js
83. https://github.com/stamen/modestmaps-js/issues/109 ; https://github.com/stamen/modestmaps-js/commit/96da436 ; https://github.com/stamen/modestmaps-js/commit/dfec3cf ; https://github.com/stamen/modestmaps-js/commit/5ea22cb ; https://github.com/stamen/modestmaps-js/issues/103
84. https://github.com/stamen/modestmaps-js/issues/103 ; https://github.com/stamen/modestmaps-js/commit/86ffcde ; https://github.com/stamen/modestmaps-js/commit/dfec3cf
85. https://github.com/stamen/modestmaps-js/commit/34a463f ; ref-repos/stamen__modestmaps-js/src/utils.js
86. https://github.com/simplegeo/polymaps/issues/81 ; https://github.com/simplegeo/polymaps/issues/51 ; https://github.com/simplegeo/polymaps/issues/129
87. https://github.com/simplegeo/polymaps/commit/4518c22 ; https://github.com/simplegeo/polymaps/commit/3f591e7 ; https://github.com/simplegeo/polymaps/commit/ec0d932
88. https://github.com/simplegeo/polymaps/commit/5f20062 ; https://github.com/simplegeo/polymaps/commit/f4c16c1
89. https://github.com/d3/d3-geo/pull/50
90. https://github.com/d3/d3-geo/issues/194
91. https://github.com/vasturiano/globe.gl/commit/96f0cd1 ; https://github.com/vasturiano/globe.gl/commit/810ad92 ; ref-repos/vasturiano__globe.gl/src/globe.js
92. https://github.com/vasturiano/globe.gl/commit/01bb339 ; https://github.com/vasturiano/globe.gl/commit/96f0cd1 ; https://github.com/vasturiano/globe.gl/commit/7187ed5
93. https://github.com/vasturiano/globe.gl/commit/cad17b4 ; https://github.com/vasturiano/globe.gl/commit/2d94ffd
94. https://github.com/iTowns/itowns/pull/141
95. https://github.com/iTowns/itowns/pull/774 ; https://github.com/mrdoob/three.js/pull/14349
96. https://github.com/iTowns/itowns/commit/ea8905a5 ; https://github.com/iTowns/itowns/commit/6ac3ea7a ; https://github.com/iTowns/itowns/commit/258efcdd ; https://github.com/iTowns/itowns/commit/dbf9d25d
97. ref-repos/TerriaJS__terriajs/packages/terriajs/CHANGES.md
98. https://github.com/TerriaJS/terriajs/issues/1275
99. https://github.com/TerriaJS/terriajs/pull/2645
100. https://github.com/TerriaJS/terriajs/commit/753d3f2bb ; https://github.com/TerriaJS/terriajs/commit/f7a2d62e4
101. https://github.com/TerriaJS/terriajs/commit/0ae45c714
102. https://github.com/TerriaJS/terriajs/commit/c57884fc0 ; https://github.com/TerriaJS/terriajs/commit/cbf20257c
103. https://github.com/TerriaJS/terriajs/commit/5162a6d7f ; https://github.com/TerriaJS/terriajs/commit/01f0a9978 ; https://github.com/TerriaJS/terriajs/commit/cd98c2ae1
104. https://github.com/TerriaJS/terriajs/commit/39e23d50309f3bf9b26056129d4dc24b8854f0df ; https://github.com/TerriaJS/terriajs/commit/fb294d713d08d6263098cddd136f698f55aa710d
105. https://github.com/melowntech/vts-browser-js/commit/37893e5 ; https://github.com/melowntech/vts-browser-js/commit/7e72d67 ; https://github.com/melowntech/vts-browser-js/commit/305a68e ; https://github.com/melowntech/vts-browser-js/commit/fac25a6 ; ref-repos/melowntech__vts-browser-js/src/core/renderer/draw.js
106. https://github.com/NASAWorldWind/WebWorldWind/commit/1f74955 ; https://github.com/NASAWorldWind/WebWorldWind/commit/395a1ea
107. https://github.com/NASAWorldWind/WebWorldWind/issues/101
108. ref-repos/NASAWorldWind__WorldWindJava/src/gov/nasa/worldwind/view/BasicView.java ; https://github.com/NASAWorldWind/WorldWindJava/blob/2543c23/src/gov/nasa/worldwind/view/BasicView.java
109. https://github.com/pelicanmapping/osgearth/commit/2163d7750 ; https://github.com/pelicanmapping/osgearth/commit/fb74b788f
110. https://github.com/MapServer/MapServer/commit/91d53be6
111. https://github.com/osmandapp/OsmAnd-core/pull/1138 ; ref-repos/osmandapp__OsmAnd-core/src/Map/VectorLine_P.cpp
112. https://github.com/osmandapp/OsmAnd-core/pull/1109
113. https://github.com/osmandapp/OsmAnd-core/commit/8bce21910868a809850be58f42d4a5960935f3eb ; https://github.com/osmandapp/OsmAnd-core/commit/3d2e273213dc51155bd61da2130ba68e0a4a9e49
114. ref-repos/Leaflet__Leaflet/src/dom/DomEvent.js (getWheelDelta)
115. ref-repos/maplibre__maplibre-gl-js/src/ui/handler/scroll_zoom.ts
116. ref-repos/maplibre__maplibre-gl-js/src/ui/camera.ts (flyTo, van Wijk 2003) ; ref-repos/Leaflet__Leaflet/src/map/Map.js (flyTo: rho 1.42, duration 0.8 * S)
117. skills/map-from-scratch/references/patterns.md ; examples/02-world-population-mobile/map.ts ; examples/03-quake-timeline/main.ts ; examples/03-quake-timeline/quake.ts ; examples/07-world-cities-hover/cities.ts
118. https://github.com/maplibre/maplibre-native/commit/4f0e5374c
