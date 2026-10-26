---
name: picking-and-hit-testing
description: How map engines answer "what is under the pointer" (GPU id buffers, Canvas hit canvases, CPU indexes and analytic tests, precomputed id grids, terrain raycasts), with the stalls, id limits, tolerance bugs and cross-tile identity problems they measured and reverted. Load it when a map-from-scratch request needs tap, click or hover to identify, highlight or select features, a coordinate or height under the cursor, or "everything under the finger", before writing `architecture_selection` or any bake or renderer code for interaction, or when picks are slow, stall frames, miss thin lines or return the wrong feature.
---

# Picking and hit testing: what is under the pointer, and how to ask

A pick turns a screen position into a feature id (or a ground coordinate),
and the id into the attributes the user asked for. A general engine must
pick any geometry, styled any way, moved by any shader, from any number of
layers and tiles. Most of them therefore render the scene a second time with
ids as colours and read the pixel back, and then spend years on what that
costs: GPU stalls, id-range limits, antialiased ids, picks that disagree with
what was drawn, and features split across tiles. A renderer made for one
request knows what is pickable, how it is drawn and how many there are, and
can often answer from data it already holds on the CPU. The repo has both
ends already: a 1x1 id render on a phone (02, pick p95 0.9 ms at 4x CPU
throttle) [1], a brute-force CPU hover over 7,342 cities (07, p95
0.25-0.3 ms, no index) [2], and `isPointInPath` over 47 prefectures (01,
p95 0.01 ms) [3].

Per-engine detail and the smaller related decisions are in
[references/engines.md](references/engines.md). Numbers in brackets refer to
the Sources list at the end of this file.

## First question: which mechanism answers the pick?

| The request | Answer the pick with | Engines that show why |
| --- | --- | --- |
| Up to ~10^4 simple shapes (points of known radius, lines of known width, polygons) whose geometry the CPU already holds | CPU: bbox or grid prefilter, then an exact test in the space and with the fill rule the renderer draws with | galileo [4], Terria [5][6], Leaflet [7][8], 07 [2] |
| Height or ground coordinate under the cursor over terrain | CPU raycast against the DEM the renderer already holds | MapLibre [9][10][11], Cesium [12] |
| Dense or overlapping GPU geometry whose final shape the shader decides (instancing, line quads, extrusion, draping), or arbitrary icons | GPU id buffer: ids into a tiny target at the pointer, read one pixel, asynchronously where possible | deck.gl [13], navara [14], WorldWind [15], tangram [16], 02 [1] |
| Canvas 2D with a few dozen paths | `isPointInPath`, no index; per-feature hit canvases are slow | 01 [3], OpenLayers [17][18] |
| Geometry not shipped to the client (raster tiles), but hover must name features | A precomputed id grid per tile (UTFGrid), baked with the tiles | Mapnik [19], ol2 [20][21], TileMill [22] |
| Labels drawn by a placement pass | Query the placement result in screen space, not the source features | MapLibre [23], OpenLayers [24] |

Where the geometry is already on the CPU, the engines moved away from
synchronous GPU readback: MapLibre deleted its terrain coordinate framebuffer
for a CPU raycast [10][25] and its per-marker depth readback
for a CPU ray walk [11]; OpenLayers moved picks from composited screen
pixels to each layer's own data [26]. They kept GPU picking where the
shader decides the final shape: navara picks text and terrain-deformed
geometry from an id buffer [14], and deck.gl's overlapping-pick RFC set CPU
ray casting aside because instanced layers define their final geometry in the
vertex shader, so each layer could need custom JS to match it, and the GLSL and
JS could get out of sync [84].

## Decisions, with trade-offs and evidence

### The synchronous readback is the cost, not the id render

- MapLibre terrain picking re-rendered every terrain tile into a
  screen-sized framebuffer with a 4 MB coordinate texture on every pointer
  event; positions were quantised to 1024 steps per tile and a 1-byte tile
  index broke past 255 tiles [10][25]. The CPU replacement
  marches the ray, bisects the first crossing and refines with a secant step
  (on the globe it brackets between min- and max-elevation spheres). It costs
  0.2 us for a sky miss up to 63 us for a sloped hit at z16; picks differ by
  ~0.5 px median (p95 <= 1.6 px, inside the old quantisation), and globe
  unproject went from ~12 px off to 0.00 px [10]. The changelog sums it
  up as full DEM resolution, no GPU stall and ~4 MB less GPU memory [9].
- MapLibre marker occlusion read one depth pixel per marker every 100 ms:
  45 markers on a Galaxy S24 turned a 33 ms worst frame into 108-117 ms
  stalls, and desktop panning fell from 87 to 47-55 fps. The CPU ray walk
  costs 5-10 us per marker at pitch 30-60 and 75-90 us at pitch 85, agreed
  with the depth method on every on-screen marker, and the demo counted zero
  `readPixels` [11].
- Cesium measured synchronous `readPixels` at 46% of total execution time on
  Intel Arc, sometimes longer than a whole frame. `pickAsync` reads into a
  pixel-pack buffer and waits on a fence, so results arrive a frame or more
  later; the synchronous API stayed for callers that need an answer now
  [27]. openglobus did the same and never starts a read while one is
  pending [28]; tangram defers `readPixels` with a timer because the
  synchronous call was "a massive performance hit" [16].
- Read once, answer many: Cesium caches `pickPosition` per frame
  [29]; tangram-es reuses the colour read at the same pixel within a
  frame [30]; iTowns reads the whole depth buffer once while the view
  is idle, answers hover picks from the array, and drops it on the next
  render [31][32].

### If you render ids, render them correctly

- Tiny target: navara and WorldWind draw pickables into a 1x1 (or small
  pick-rectangle) viewport at the cursor [14][15]; 02 does it by
  moving the camera centre to the tap [1]. Any shader that samples a
  screen-space texture then sees `gl_FragCoord` = (0.5, 0.5): navara's ground
  polylines sampled depth at (0, 0) and had to be clicked at a visibly
  different place, until the real pick pixel was passed as a uniform
  [33].
- No antialiasing in the id target. Averaged edge colours decode to ids that
  do not exist, so navara skips MSAA for pick bakes [14]; ol2's Canvas
  hit canvas could not turn antialiasing off, so it ignored pixels with alpha
  != 255 and wrapped decoding in try/catch [34][35]. OpenLayers
  made its hit canvas opaque (`alpha: false`) and decodes RGB only
  [36]. Sample id textures with nearest filtering: linear filtering
  blended neighbouring bitmasks at edges in navara [37].
- Id capacity: 24-bit RGB gives 16,777,215 ids. deck.gl turned a hard assert
  into a warning and capped its colour cache at 2^24-1 [38]; it puts the
  layer index in alpha through the blend constant (limit 256 pickable
  layers), which overflowed with many tiled sublayers until alpha values were
  assigned only to the (layer, viewport) pairs drawn in that pass
  [39][40]. Mapnik's grid needed 64-bit ids for OSM
  [19]. Remap to dense ids at bake time instead.
- Store fewer id bytes: deck.gl 9.4 derives the pick colour from the instance
  index and keeps an explicit `rowIndexes` attribute only where one feature
  becomes many instances (path segments, MVT sublayers), "reducing memory
  usage and initialization times" [41]. OpenLayers packs the id colour
  into 2 float attributes instead of 4; the first unpack function was not
  exact and returned wrong ids [42].
- Resolution: OpenLayers renders its WebGL hit pass at half width and height,
  a 4x smaller allocation "especially for retina devices" [43], and its
  Canvas hit detection at pixel ratio 1 [36].
- The pick pass must match what the user sees. tangram-es rejected skipping
  non-selectable features in the selection buffer, because hidden features
  then became pickable; occluders are drawn as a null id [44].
  WorldWind discards fully transparent icon texels in the pick pass and
  widens symbol lines to 9 px there [45]. Thin GL lines aliased out of
  osgEarth's small pick texture; the fix was drawing lines as quads, not a
  bigger target [46].
- Only when needed: tangram creates the selection framebuffer lazily and
  skips the pass when nothing is interactive [47]; deck.gl skips
  picking when no layer is pickable and visible [48], and during a pick
  draws only tiles that intersect the pick rectangle [49]. One shared
  target, not one per layer: deck.gl dropped per-layer picking framebuffers
  after apps with 80+ layers had performance problems [13].

### If you test on the CPU, test what was drawn

- Prefilter, then test exactly. galileo checks a cached bbox before the
  point-in-feature test and skips tiles that do not contain the point, which
  "saves a lot of computational power" [4]; Terria caches each
  feature's bbox and runs the exact intersection only on bbox hits
  [5]; Leaflet tests only layers that survived viewport culling
  [8]; MapLibre Native discards invisible layers before the query
  instead of after, which made its query benchmark almost 2x faster
  [50].
- Index static data once, in bulk. OpenLayers replaced its own R-tree
  (recurring remove and infinite-loop bugs) with rbush and bulk insert, and
  clearing 100,000 features became about 3 s faster, ~350 ms [51]. For incremental R-trees, GRASS chooses nodes by
  bounding-sphere volume, because flat boxes of axis-aligned data have zero
  volume and attract distant entries [52]. Each feature belongs in
  one tile's index; query the neighbouring tiles for features that cross the
  seam [53].
- Same space, same rule as the renderer. Leaflet reviewers required
  point-in-polygon on projected points with the even-odd rule its Canvas
  renderer uses [7]; Terria reported a hit in both ACT and NSW until
  holes were honoured by ring order and winding sign [6]; osgEarth
  samples heights on the same quad diagonal the mesh uses [54]; d3-geo
  answers "outside" for a polygon boundary through the pole, an arbitrary
  choice made because the other answer broke cutting [55].
- The symbol is the hit area, not the anchor. MapServer tests clicks against
  the rendered symbol footprint and its anchor point, because a square
  tolerance gave false hits and misses for rectangular and bottom-anchored
  symbols [56]; GeoServer insists that picks use what was depicted,
  since large or offset markers spill outside the anchor geometry
  [57]. OpenLayers kept render-based hit detection for this reason: a
  geometry index does not know stroke widths and symbol sizes [17]. A
  baked renderer does know them; 07 keeps the baked radius for both the
  shader and the CPU test [2].
- Batching and rasterising lose identity. WorldWind composites surface shapes
  into textures but picks each shape on its own [58]; iTowns needed
  CPU geometry tests for vectors drawn into terrain textures [59];
  globe.gl's merged meshes lost per-datum hover and at first swallowed clicks
  meant for the globe beneath [60].
- Heavy meshes: Cesium builds a terrain-pick quadtree for a tile only when
  that tile is first picked, in a worker, and uses the default pick until it
  is ready [12].

### Tolerance: CSS pixels, scaled once, nearest first

- OpenLayers' `hitTolerance` is in CSS px; a 6.5 fix removed a second
  multiplication by device pixel ratio [61]. Before tolerance
  existed, tapping lines and points under 10 px was "a matter of luck"; it was
  implemented as a cached circle mask [62], later reordered so the
  closest pixels are checked first, with an early exit [61].
- Pixels, not metres: Organic Maps replaced a 5 m snap radius with 10 px,
  because metres were too strong at high zoom and too weak at low zoom;
  reviewers also caught the first match in the tap rectangle winning over the
  nearest one [63]. GRASS's click query returned no lines until the
  distance threshold followed the current map extent [64].
- Tolerance for point picks only: MapServer's 3 px default for point and line
  layers selected points outside box and polygon queries and made counts
  depend on image resolution [65]. GeoServer derives the buffer from
  the largest symbolizer, at least 5 px [66].
- Tolerance per layer: globe.gl's line threshold also applied to polygon
  outline strokes, so small polygons between two others could not be hovered
  [67]. Leaflet made tolerance a renderer option instead of a
  touch-only constant [68], and keeps raw pixel bounds apart from the
  tolerance-padded ones so a style change does not reproject [69].
- One pixel space at the input boundary: WorldWind Java switched every event
  and pick coordinate to device pixels after scaled displays broke picking,
  and missed call sites kept surfacing afterwards [70].

### Hover scheduling

- At most one pick per frame, none while dragging, none without a listener:
  navara [14], deck.gl [48], Leaflet [8][71],
  openglobus [28], Terria [72]. Leaflet's throttle lost
  mouseover and mouseout on fast in-and-out moves until leave events bypassed
  it [71]. Terria copies pointer positions when it defers work, so
  screen, scene and globe positions describe one instant [72].
- One listener on the container, not one per feature: Leaflet's event
  delegation rewrite improved layer add/remove performance and memory
  footprint; an earlier, separate event propagation rewrite had made
  FeatureGroup and GeoJSON adding and events about 10x faster [73].
- Profile before blaming the hit test: OpenLayers hover slowness turned out to
  be re-filling every polygon on each style change; a highlight should redraw
  an overlay, not the base layer [74].

### Identity: a pick must resolve to a stable feature id

- Features split by tiles: deck.gl highlighted only the hovered tile's piece
  until it kept the feature id and highlighted that id in every tile
  [75]; navara stores the selected id and applies it to batches that
  load later [76]; reearth keeps id -> [(tile content, batchId)], built
  as tiles load [77].
- Where ids come from: Terria's region picks were off by one until feature
  ids were frozen in the source data [78]; QGIS ignores MVT feature ids
  because real mbtiles reuse them across tiles [79]; TileMill requires
  a key only on the one interactive layer [22].
- Labels: one pick id per label, not per feature [80].
- Attributes on demand: maptalks ships feature JSON from the worker as one
  transferable buffer and decodes it only when queried [81]; iTowns
  stopped building per-feature batch-table objects at tile load [82].
  ortho-earth's fid-indexed style table coloured the neighbour after a bake
  step compacted broken features and shifted every fid [83].

### Everything under the finger

- deck.gl repeats the id pass up to depth 10, zeroing the previous hit's
  colour each time; reviewers required this only on click, never on hover,
  because the passes and readbacks dominate the cost [84][85].
  Cesium's drill pick moved to breadth-first with a limit, ordered by distance
  from the centre [86]. ol2's Canvas renderer could only report the
  topmost feature [34]. A CPU test can return every candidate from
  one scan.

### Precomputed id grids

- Mapnik's grid renderer burns ids into a per-tile grid [19]; UTFGrid
  defaults to 2x2 px cells, a quarter of the data [21]; ids encoded as
  characters fail in the UTF-16 surrogate range [20]; lookups should be
  synchronous and return null until the grid tile has loaded, with grids
  preloaded alongside the visible tiles [87].

## Tried and reverted

- A GPU coordinate framebuffer for terrain picks, and per-marker depth
  readback; both replaced by CPU rays (MapLibre [10][11]).
- `willReadFrequently` on the Canvas hit context: set in 2022; removed in
  2025-03 ("Hint willReadFrequently leads to worse performance when selecting
  features"); reintroduced in 2025-04 to prevent a Canvas2D warning; removed
  again in 2025-06; then chosen at the first hit test in 2025-11 by a 50 ms
  micro-benchmark of each of true, false and undefined, keeping the fastest
  (OpenLayers [18]).
- An UnsignedByte id attachment to save VRAM, reverted because MRT
  attachments must share one type (navara [37]).
- Per-layer picking framebuffers, and a hard assert at 2^24 objects (deck.gl
  [13][38]); deep-pick attribute rewrites that the first PR ran on
  every pointer move (deck.gl [85]).
- PostGIS key autodetection for UTFGrid ids, rolled back because it broke too
  many stylesheets (TileMill [22]).
- A 5 m building snap radius, replaced by pixels (Organic Maps [63]).
- Per-OS HiDPI multipliers (screenResolution/96), replaced by one
  device-pixel space (WorldWind Java [70]).

## Guidance for a renderer in this repo

Write into `architecture_selection.not_doing` what the request does not need:
hover (click or tap only), highlight, picking at all, several features per
pick, coordinates or heights under the cursor, labels as pick targets. A map
without interaction needs no pick pass and no index [47][48].

Choose the mechanism:

1. **CPU first when the bake knows the shapes.** Points with baked radii,
   lines with known widths, polygons with rings: keep positions in a typed
   array, test topmost-first in draw order, in the renderer's projected
   space, with the same radius and fill rule as the drawing [7][6].
   A linear scan over ~10^4 points stays well under a millisecond [2];
   add a uniform grid or a bulk-loaded packed R-tree baked into the file only
   when the bench says so [51][52]. Nothing comes back from
   the GPU.
2. **Id buffer when the shader decides the shape** (instanced line quads,
   extrusion, draping, many overlapping polygons, as in 02): 1x1 or small
   target at the pointer [14][15], no MSAA, opaque, nearest
   [37][36], ids from `gl_VertexID`/`gl_InstanceID` or a baked
   dense id [41], clear to 0 = none, render only on a pick request, at
   most once per frame, never while dragging [48][47]. On WebGL2
   read through a PBO and a fence when a frame of delay is acceptable
   [27][28]; for a tap, one synchronous 1x1 read was 0.9 ms
   p95 in 02 [1]. Pass the real pick pixel to any shader that samples
   screen-space buffers [33]. Draw lines into the pick pass a few pixels
   wide [46][45].
3. **Terrain**: raycast the baked heightfield on the CPU [10], and
   sample it with the mesh's own triangulation [54].

Bake for identity: one dense integer id per feature, written once into the
geometry and the attribute table, stable across tiles and LOD
[75][78][79]; attributes in a columnar side table decoded
on pick [81][82]. Tolerance: CSS px from the spec, times DPR
once at the input boundary [61][70], nearest candidate first
[63], none for region selection [65].

Budgets and checks to add to `spec.yaml`:

- `pick_ms` or `hover_ms` p95, including the readback and the UI update (02,
  07), and a frame-time budget measured while hovering, so that a stall shows
  up as a frame and not only as pick time [11][27].
- Reachability: for every feature (or a uniform sample), put it under the
  pointer and check the pick returns its id (07's `reachable_ratio` >= 0.99)
  [2]; take the positions from the baked data, not by hand [88].
- Negative picks: a point over sea or background returns none.
- If the data is tiled, a feature cut by a tile seam returns the same id on
  both sides [75][53].
- One pick check at DPR 1 and one at DPR 2 or 3, to catch tolerance or
  coordinate scaling applied twice or not at all [61][70].

## Sources

1. examples/02-world-population-mobile/spec.yaml (performance_knowledge id-pick-one-pixel), skills/map-from-scratch/references/patterns.md (Interaction)
2. examples/07-world-cities-hover/spec.yaml (brute-force-hover, reachable_ratio), examples/07-world-cities-hover/cities.ts (pick)
3. examples/01-prefecture-picker/spec.yaml (performance_knowledge no-index-needed)
4. https://github.com/galileo-map/galileo/commit/cd61976, https://github.com/galileo-map/galileo/commit/3196f9e
5. https://github.com/TerriaJS/terriajs/commit/06cfa3a19
6. https://github.com/TerriaJS/terriajs/commit/f44043366
7. https://github.com/Leaflet/Leaflet/pull/4618
8. https://github.com/Leaflet/Leaflet/commit/fd64c7e5
9. ref-repos/maplibre__maplibre-gl-js/CHANGELOG.md (6.6.0 #7640, 6.10.0 #8387), https://github.com/maplibre/maplibre-gl-js/issues/7640
10. https://github.com/maplibre/maplibre-gl-js/pull/8158, https://github.com/maplibre/maplibre-gl-js/issues/1596
11. https://github.com/maplibre/maplibre-gl-js/pull/8387
12. https://github.com/CesiumGS/cesium/commit/53fa96bf858d13a2c2b0b054c775459d9346cdc1, https://github.com/CesiumGS/cesium/commit/1e8d248e34cc84a11aa512e2a09321c59cff1b39, https://github.com/CesiumGS/cesium/commit/debd74eb915aed2d3e09eb73a991f4c2c9f907e1
13. https://github.com/visgl/deck.gl/blob/master/dev-docs/RFCs/v4.1/picking-improvements-rfc.md, https://github.com/visgl/deck.gl/blob/master/docs/developer-guide/performance.md, ref-repos/visgl__deck.gl/dev-docs/roadmaps/performance-roadmap.md
14. https://github.com/maplibre/navara/blob/main/guide/ARCHITECTURE.md, https://github.com/maplibre/navara/blob/main/guide/TILE_TEXTURE_COMPOSITING.md
15. ref-repos/NASAWorldWind__WorldWindJava/src/overview.html, ref-repos/NASAWorldWind__WorldWindJava/src/gov/nasa/worldwind/render/DrawContextImpl.java (https://github.com/NASAWorldWind/WorldWindJava/blob/2543c23/src/gov/nasa/worldwind/render/DrawContextImpl.java), ref-repos/NASAWorldWind__WorldWindJava/src/gov/nasa/worldwind/BasicSceneController.java
16. https://github.com/tangrams/tangram/blob/master/src/selection/selection.js (local: ref-repos/tangrams__tangram/src/selection/selection.js)
17. https://github.com/openlayers/openlayers/issues/4232, https://github.com/openlayers/openlayers/issues/4232#issuecomment-232302739
18. https://github.com/openlayers/openlayers/commit/b75d4e8ef, https://github.com/openlayers/openlayers/commit/1eb51f456, https://github.com/openlayers/openlayers/commit/295a5b77a, https://github.com/openlayers/openlayers/commit/cf24c77e9, https://github.com/openlayers/openlayers/commit/4ce546b4a, https://github.com/openlayers/openlayers/commit/8f6f87b85
19. https://github.com/mapnik/mapnik/blob/master/CHANGELOG.md, https://github.com/mapnik/mapnik/issues/1661, https://github.com/mapnik/mapnik/issues/1962, ref-repos/mapnik__mapnik/docs/design.md
20. https://github.com/openlayers/ol2/pull/244
21. https://github.com/openlayers/ol2/commit/89e8a872, https://github.com/openlayers/ol2/commit/80656cdf
22. https://github.com/tilemill-project/tilemill/issues/1358, ref-repos/tilemill-project__tilemill (commit 3008d9ca), ref-repos/tilemill-project__tilemill/_posts/docs/reference/0204-03-01-project-settings.md
23. https://github.com/maplibre/maplibre-gl-js/commit/fc992ec59
24. https://github.com/openlayers/openlayers/commit/08af20772, https://github.com/openlayers/openlayers/commit/80e67bac7, https://github.com/openlayers/openlayers/commit/ac195c46b, https://github.com/openlayers/openlayers/commit/a2d41da30
25. https://github.com/maplibre/maplibre-gl-js/commit/8c274a9cd, https://github.com/maplibre/maplibre-gl-js/commit/17ae8e33c
26. ref-repos/openlayers__openlayers/changelog/upgrade-notes.md, ref-repos/openlayers__openlayers/changelog/v6.1.0.md, ref-repos/openlayers__openlayers/changelog/v6.13.0.md
27. https://github.com/CesiumGS/cesium/pull/12983
28. https://github.com/openglobus/openglobus/commit/6e17c9a2, https://github.com/openglobus/openglobus/commit/b52eed53, https://github.com/openglobus/openglobus/commit/13c97f3d, https://github.com/openglobus/openglobus/commit/b1b2f38b
29. ref-repos/CesiumGS__cesium/CHANGES.md, https://github.com/CesiumGS/cesium/issues/5117
30. https://github.com/tangrams/tangram-es/commit/1e3ce2de
31. https://github.com/iTowns/itowns/commit/061d19e3
32. https://github.com/iTowns/itowns/commit/3a8daf03, https://github.com/iTowns/itowns/commit/ac2e8000
33. https://github.com/maplibre/navara/pull/420
34. https://github.com/openlayers/ol2/blob/master/lib/OpenLayers/Renderer/Canvas.js, https://github.com/openlayers/ol2/blob/master/notes/2.13.md
35. https://github.com/openlayers/ol2/commit/3ef0b059, https://github.com/openlayers/ol2/commit/11191464
36. https://github.com/openlayers/openlayers/commit/4b13c6dae, https://github.com/openlayers/openlayers/commit/ac5f52a21, https://github.com/openlayers/openlayers/commit/315695eeb
37. https://github.com/maplibre/navara/commit/f96c2449
38. https://github.com/visgl/deck.gl/commit/37237d01
39. https://github.com/visgl/deck.gl/commit/0cff9773, https://github.com/visgl/deck.gl/commit/b8c7d33a, ref-repos/visgl__deck.gl/docs/developer-guide/performance.md ("Picking limitations"; docs/advanced/performance.md at 43fd968b)
40. https://github.com/visgl/deck.gl/commit/08e442f4, https://github.com/visgl/deck.gl/commit/80f4c7c1
41. https://github.com/visgl/deck.gl/blob/master/docs/whats-new.md, https://github.com/visgl/deck.gl/blob/master/docs/upgrade-guide.md, https://github.com/visgl/deck.gl/commit/0c4b7d11, https://github.com/visgl/deck.gl/commit/48760d53
42. https://github.com/openlayers/openlayers/commit/a4b7f7062
43. https://github.com/openlayers/openlayers/commit/600e1a464
44. https://github.com/tangrams/tangram-es/pull/948
45. ref-repos/NASAWorldWind__WorldWindJava/src/gov/nasa/worldwind/symbology/AbstractTacticalSymbol.java (https://github.com/NASAWorldWind/WorldWindJava/blob/2543c23/src/gov/nasa/worldwind/symbology/AbstractTacticalSymbol.java)
46. https://github.com/pelicanmapping/osgearth/issues/1062
47. https://github.com/tangrams/tangram/commit/068aec9c, https://github.com/tangrams/tangram/commit/7c515884
48. https://github.com/visgl/deck.gl/commit/08c389d8, https://github.com/visgl/deck.gl/commit/173a43ea
49. https://github.com/visgl/deck.gl/commit/13bed5d1
50. https://github.com/maplibre/maplibre-native/commit/0051fcdbb85b2a02751c62d1c76ee1518a967bcb
51. https://github.com/openlayers/openlayers/commit/af4184e74, https://github.com/openlayers/openlayers/commit/97acd989a, https://github.com/openlayers/openlayers/commit/17e56d835, https://github.com/openlayers/openlayers/commit/3e2cc3c24
52. ref-repos/OSGeo__grass/lib/vector/rtree/docs/README.txt, https://github.com/OSGeo/grass/blob/main/lib/vector/rtree/docs/README.txt
53. https://github.com/maplibre/maplibre-native/commit/90f6c531f31a4edc5945f15a9864b914ce156ba8
54. https://github.com/pelicanmapping/osgearth/commit/a1663895ca8ac6650cdf8aed097951c536846950, https://github.com/pelicanmapping/osgearth/commit/b0fd185975425941205772e6996f01b35fd200ca
55. https://github.com/d3/d3-geo/commit/aff9146, https://github.com/d3/d3-geo/issues/105
56. https://github.com/MapServer/MapServer/commit/b8f298d7, https://github.com/MapServer/MapServer/commit/834b621d
57. https://github.com/geoserver/geoserver/pull/3961
58. ref-repos/NASAWorldWind__WorldWindJava/src/gov/nasa/worldwind/render/SurfaceObjectTileBuilder.java (https://github.com/NASAWorldWind/WorldWindJava/blob/2543c23/src/gov/nasa/worldwind/render/SurfaceObjectTileBuilder.java), ref-repos/NASAWorldWind__WorldWindJava/src/gov/nasa/worldwind/AbstractSceneController.java
59. https://github.com/iTowns/itowns/pull/450, https://github.com/iTowns/itowns/pull/470
60. https://github.com/vasturiano/globe.gl/issues/223, https://github.com/vasturiano/globe.gl/commit/97541ca, https://github.com/vasturiano/globe.gl/commit/5c9b91c, https://github.com/vasturiano/globe.gl/commit/0f2844c, ref-repos/vasturiano__globe.gl/README.md
61. https://github.com/openlayers/openlayers/commit/c076d273e, ref-repos/openlayers__openlayers/changelog/upgrade-notes.md (6.5)
62. https://github.com/openlayers/openlayers/issues/5862, https://github.com/openlayers/openlayers/pull/5995
63. https://github.com/organicmaps/organicmaps/pull/7876
64. https://github.com/OSGeo/grass/pull/3793, https://github.com/OSGeo/grass/blob/main/gui/wxpython/mapdisp/frame.py
65. https://github.com/MapServer/MapServer/issues/1103
66. ref-repos/geoserver__geoserver/doc/en/user/services/wms/vendor.md
67. https://github.com/vasturiano/globe.gl/issues/30, https://github.com/vasturiano/globe.gl/commit/77b047b, https://github.com/vasturiano/globe.gl/commit/b35847d
68. https://github.com/Leaflet/Leaflet/issues/5922, https://github.com/Leaflet/Leaflet/pull/4396, ref-repos/Leaflet__Leaflet/CHANGELOG.md
69. https://github.com/Leaflet/Leaflet/commit/13f649d4
70. https://github.com/NASAWorldWind/WorldWindJava/issues/195, https://github.com/NASAWorldWind/WorldWindJava/pull/262, https://github.com/NASAWorldWind/WorldWindJava/pull/274
71. https://github.com/Leaflet/Leaflet/commit/6aaad717
72. https://github.com/TerriaJS/terriajs/commit/39e23d50309f3bf9b26056129d4dc24b8854f0df, https://github.com/TerriaJS/terriajs/commit/fb294d713d08d6263098cddd136f698f55aa710d
73. ref-repos/Leaflet__Leaflet/CHANGELOG.md, https://github.com/Leaflet/Leaflet/pull/3032, https://github.com/Leaflet/Leaflet/pull/2311
74. https://github.com/openlayers/openlayers/issues/4232#issuecomment-203025742, https://github.com/openlayers/openlayers/issues/4232#issuecomment-232299628
75. https://github.com/visgl/deck.gl/pull/4365
76. https://github.com/maplibre/navara/pull/133
77. https://github.com/reearth/reearth-visualizer/pull/920, https://github.com/reearth/reearth-visualizer/commit/3c5a29e7, https://github.com/reearth/reearth-visualizer/commit/25359fa5
78. https://github.com/TerriaJS/terriajs/issues/1211
79. https://github.com/qgis/QGIS/commit/70aea49fc4
80. https://github.com/tangrams/tangram-es/pull/1076
81. https://github.com/maptalks/maptalks.js/commit/e3e51e3e6, https://github.com/maptalks/maptalks.js/commit/c8f78dc6b
82. https://github.com/iTowns/itowns/commit/5d2f384
83. https://github.com/kenjiyoshidahome2026-bit/ortho-earth/blob/main/packages/ortho-core/gint%20draw%20spec.md (local: ref-repos/kenjiyoshidahome2026-bit__ortho-earth/packages/ortho-core/gint draw spec.md)
84. https://github.com/visgl/deck.gl/blob/master/dev-docs/RFCs/v5.3/picking-overlapping-objects-rfc.md, ref-repos/visgl__deck.gl/docs/upgrade-guide.md
85. https://github.com/visgl/deck.gl/pull/1730
86. https://github.com/CesiumGS/cesium/commit/94e579ea4201816bc52c94be45d81cfe0251d60c, https://github.com/CesiumGS/cesium/commit/e3b388d662995577eb4ca7927a413724c2d60538, https://github.com/CesiumGS/cesium/commit/fe8738002a4ee5330124962c927f839ea4c28801
87. https://github.com/openlayers/openlayers/pull/3015
88. skills/map-from-scratch/references/pitfalls.md
