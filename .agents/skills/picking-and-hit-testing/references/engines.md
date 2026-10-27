# Picking and hit testing: engine by engine

Detail behind [../SKILL.md](../SKILL.md), plus smaller decisions that touch
picking from neighbouring topics. Numbers in brackets refer to the Sources
list at the end of this file (its numbering is separate from SKILL.md).

## MapLibre GL JS, MapLibre Native, MLT

- Terrain `pointCoordinate` (#8158): the old path re-rendered every terrain
  tile into a screen-sized framebuffer holding an RGB-encoded coordinate
  texture (4 MB) and called `readPixels` on every mouse or touch event:
  an extra draw pass, a pipeline stall, 1024 steps per tile and a 1-byte tile
  index that breaks past 255 tiles. Issue #1596 had proposed improving the
  framebuffer route instead. The CPU path intersects the screen ray with the
  bilinear DEM: Mercator marches the frustum segment, bisects the first
  crossing and refines with a secant step; globe brackets between min and max
  elevation spheres. 16 scenarios with a 15x15 pick grid: rendering
  pixel-identical, picks ~0.5 px median apart (p95 <= 1.6 px); globe with
  terrain went from ~12 px off the no-terrain math to 0.00 px. Bench: flat z2
  2.0 us, sloped z10 5.0 us, sloped z16 63 us, sky miss 0.2 us. Picking now
  runs in the node bench [1]. The texture, shaders and draw pass were
  deleted; the depth and coords passes had been split earlier, and the
  coverage index is cached [2][3].
- Marker occlusion (#8387): cast the camera ray to the marker's location,
  find the terrain hit with the same terrain pick, hide the marker if the hit
  is more than 1% short; throttled at 100 ms. 5-10 us per marker at pitch
  30-60, 75-90 us at pitch 85. The strict throttle asks about a third more
  often than before. Galaxy S24 with 45 markers: 33 ms worst frame became
  108-117 ms stalls under the old readback [4].
- Symbol queries use the global CollisionIndex of the last placement, not
  per-tile symbol indexes. This removed hover flicker and missed symbols at
  tile seams, coordinate round-trips and deduplication; Placement must keep
  query data alive [5].
- MapLibre Native drops invisible layers before running
  `queryRenderedFeatures` ("almost two times faster" in its benchmark)
  [6], and indexes only features inside the tile, querying
  neighbouring tiles for features that cross the boundary: a smaller index,
  no duplicates, more tiles touched per query [7].
- MLT stores geometry topology as count streams (geometries, parts, rings,
  vertices), so per-feature starts come from a prefix sum: ~0.006 ms on a
  1.3 MB tile of 524,482 vertices, against ~3.8 ms for a full column decode.
  Useful when picking or batching needs per-feature offsets [8].

## navara

- Id-buffer picking renders pickable meshes with batch ids as RGB
  (`R<<16 | G<<8 | B`) into a 1x1 target scissored to the cursor; instanced
  meshes pass a per-instance id. Hover picks are throttled to one per
  animation frame and run only while a listener exists. Chosen over CPU
  raycasting because terrain and shader-positioned text are deformed on the
  GPU. MSAA is bypassed for pick bakes because averaged ids decode to ids that
  do not exist [9].
- The 1x1 target is set with `setViewOffset`, so `gl_FragCoord.xy` is
  (0.5, 0.5); ground polylines sampled globe depth at (0, 0) and discarded
  their fragments at oblique angles. The uniform `nvr_uPickingCoord` now
  carries the real coordinate; every shader that reads screen-space textures
  must know about picking [10].
- A building split across 3D Tiles batches is selected whole through an
  IdPropertyTable (`gml_id` -> all global batch ids). Batches loaded after the
  click were not highlighted until the selected id values were stored and
  checked whenever a batch is created. Matching batch ids in a loop caused an
  FPS drop at the click [11].
- Effect-slot bitmasks live in an R-channel HalfFloat MRT attachment
  (11 slots), sampled with NearestFilter, and the pass is skipped when no slot
  is registered. An UnsignedByte attachment (8 slots) was adopted and
  reverted, because MRT attachments must share a type; RGB encoding allowed
  only 3 slots; LinearFilter blended neighbouring masks [12].

## deck.gl

- One shared colour-coded picking framebuffer for all layers, read back on
  demand; v3's per-layer framebuffers had performance problems with 80+
  layers. The v4.1 RFC lists CPU ray casting as a new algorithm that can pick
  multiple objects along the ray, with the disadvantages that it needs spatial
  indexing and makes pixel-accurate boundaries hard; it says selecting
  overlapping objects would need it. Fewer `readPixels` calls was a roadmap
  item [13]. The v5.3 overlapping-pick RFC adds that each instanced layer
  could need custom JS to match its vertex shader, and that GLSL and JS could
  get out of sync [18].
- Layer identity goes into alpha through `blendColor` with blendFunc
  `[ONE, ZERO, CONSTANT_ALPHA, ZERO]`; layer parameters overriding these blend
  settings broke picking, as did a clear colour other than [0,0,0,0]. Limits:
  16M items per layer, 256 pickable layers [14]. A 2020 workaround
  kept only the first 255 pickable layers; in 2021 alpha values were assigned
  per (layer, viewport) pair actually drawn, and the pass returns a
  `decodePickingColor` function [15].
- Over 2^24-1 objects: warn instead of assert, cap the colour cache, and cap
  over-allocation growth at the same size [16].
- v8.3: non-pickable layers skip picking attributes and no picking
  framebuffer is created when nothing is pickable. v9.4: most instanced layers
  compute the pick colour from the instance index; `rowIndexes` (uint32) stays
  only where the logical id differs from the instance. Cost: deep picking
  guarantees only depth 10 unique objects, and custom shaders that read
  `instancePickingColors` break [17].
- `pickMultipleObjects` re-renders up to depth N (default 10), zeroing the
  picked object's colour with a partial buffer update; uniforms listing
  excluded colours were rejected (limited depth, compile time in every
  shader). The first PR ran the attribute update on all pointer-move picking
  [18][19].
- Picking passes carry a cull rectangle (x, y +/- radius); TileLayer draws
  only tiles that intersect it, zRange included [20].
- Hover picking is suppressed while a button is down; the pass is skipped
  when no layer is pickable and visible [21].
- MVT autoHighlight lit one tile's piece of a clipped feature until the
  hovered feature id (`uniqueIdProperty`) was highlighted in every tile;
  GeoJsonLayer picks report the index in the whole feature array [22].
- Neighbouring topic: CollideExtension draws collide-enabled layers into one
  off-screen target with picking colours, sorted by priority, and draws a
  feature only if its colour survived. 7,000 points at 120 fps, with rotation
  and pitch; one global collision target and per-pixel occlusion
  [23].

## Cesium, reearth, iTowns, openglobus, WorldWind, osgEarth, globe.gl, Terria

- Cesium: `pickPosition` results cached per frame (#5117); `pickAsync`
  through a PBO and a fence (WebGL2 only), sync `pick` kept [24]
  [25]. Terrain picks use a per-tile triangle index built lazily, in a
  worker, only for tiles actually picked against (octree changed to quadtree
  during review); it can be rebuilt when vertical exaggeration changes; the
  first pick of each tile is slower [26]. Rectangle picks return
  objects nearest the centre first and stop at a limit; drillPick moved from
  depth-first to breadth-first (a breaking change with large rectangles);
  height picking sorts tiles by distance to the ray origin [27].
  Terrain culling with tangent-plane OBBs (skirts left out) instead of
  spheres: 330 tiles with spheres, 298 with OBB plus skirts, 279 without
  skirts in one low-angle view [28].
- reearth: TilesetFeatureIndex maps a feature key to a list of
  {content, batchId}, filled as tiles load, instead of walking the tileset
  tree per select or flyTo; one key can map to many tiles [29].
- iTowns: `pickObjectsAt(mouse, layer)` with a per-layer implementation,
  because raycasting millions of points does not work [30]. Vectors
  rasterised into terrain textures are picked with CPU tests on the source
  geometry, a pixel tolerance converted to degrees [31]. A
  full-screen depth buffer is read once while idle and reused for hover; while
  moving, a 1x1 region per pick [32]; readback arrays are preallocated
  and refreshed only on camera or tile change [33]. Batch-table
  data is decoded lazily per batchId on pick [34]; the atmosphere layer
  is skipped [35]; elevation canvases use `willReadFrequently`
  [36]; 3D Tiles regions become bounding spheres (looser, cheaper)
  [37].
- openglobus: picking colour and distance framebuffers read into a
  PIXEL_PACK_BUFFER with `fenceSync`, a skip flag while a read is pending; no
  picking draw while dragging, depth read only while the pointer moves, none
  during touch [38].
- WorldWind Java: colour-id picking in a small viewport of the back buffer,
  layer by layer, then a final read marks which candidates are on top; pick
  pass, clear, then the visible draw in one repaint; colours skip the clear
  colour and wrap at 0xFFFFFF; ranges reserved for batches; duplicates
  removed with an IntSet. Geometric ray tests were rejected as ambiguous in
  depth and slow [39]. Surface shapes are composited into 512x512
  textures for drawing but picked per object [40]. Pick mode
  replaces texture colour with the pick colour, alpha-tests transparent
  texels, widens lines to 9 px [41]. Events and picks moved to device
  pixels for HiDPI (#262), with follow-up fixes (#274) [42].
- WebWorldWind: sector culling before deep picking of surface shapes, with a
  stress page `DeepPickingPerformance.js` [43].
- osgEarth: thin draped lines vanished from the small RTT pick texture on
  Intel HD; LineDrawable (screen-space quads) fixed it, a bigger pick image
  was the rejected option [44]. Heights are sampled on the mesh's own
  diagonal [45]; mesh faces are indexed in an R-tree for point location
  [46]; an exact visible-region cut was dropped as "not enough benefit
  for the performance price" [47].
- globe.gl: `pointsMerge`/`hexBinMerge` give one mesh for 150,000+ hexes but
  no per-datum hover or transitions; merged meshes later let picks pass
  through [48]. The 0.2 line hover threshold also widened polygon
  outlines; made configurable [49]. Fat lines (LineSegments2) could
  not be clicked until a raycast was implemented [50]. DOM markers are
  hidden behind the globe by the renderer; a user-side raycast per marker
  lagged and had to be throttled to once per second [51].
- Terria: every renderer goes through Cesium abstractions, and the docs call
  feature picking "so complicated" because nothing links the model layer to
  the renderers [52]; features carry table `rowIds` so a pick resolves
  to CSV rows, and MVT highlighting needs an `idProperty` [53]. Region
  mapping moved from GeoServer WMS to client-drawn MVT with local picking,
  "quite noticeably faster"; ids had to be frozen in the source shapefiles
  [54]. Ring-order and winding hole test [55]. Protomaps
  GeoJSON picks: a 10 px circle in metres, cached per-feature bbox first,
  then `booleanIntersects`, with a shifted circle for features past 180
  degrees; still a linear scan [56]. Height under the cursor uses
  `sampleTerrainMostDetailed` with error bounds from tile min/max heights
  [57]. Mouse moves: one change event instead of observable fields,
  scratch objects, events once per animation frame with copied positions
  [58].

## OpenLayers and ol2

- Per-layer `getFeatures(pixel)` (6.1) and `getData(pixel)` for raster
  values (6.13) replaced `forEachLayerAtPixel` on the composite canvas, which
  gave false positives once layers shared a canvas and only knew RGBA
  [59].
- Hit areas follow style: unfilled circles are not hit inside (6.0); text
  with a transparent fill is hit, with no fill it is not; dashed lines are hit
  along their whole length; zero-opacity icons are hit (7.5) [60].
- Canvas hit detection replays each candidate into a 1x1 hit canvas and
  reads alpha; kept over an index plus point-in-polygon because the index
  does not know stroke widths and symbol sizes. Hovering the kml-earthquakes
  example: 60 fps in Chrome, ~20 fps in Firefox; freezes reported with
  500-3,000 features; `getImageData` per feature was the hot spot
  [61]. Later: features drawn in index-encoded colours on an opaque
  canvas at pixel ratio 1, `indexFactor = ceil(2^24 / featureCount)`
  [62].
- `hitTolerance` (#5995): a (2r+1)^2 hit canvas checked inside a cached
  midpoint-circle mask; distance is deliberately not returned so the
  implementation can change. Rejected: widening strokes only (does not help
  icons), rbush nearest segment (does not know the rendered symbol)
  [63]. Later: cached pixel indexes sorted by distance, first hit wins;
  6.5 fixed the double DPR multiplication [64].
- WebGL points hit pass at half width and height [65]; id colour
  packed into 2 floats, exact unpack required [66].
- `willReadFrequently`: set (2022), removed (2025-03), reintroduced to
  prevent a Canvas2D warning (2025-04), removed again (2025-06), then
  measured at the first hit test with a 50 ms fillRect + getImageData loop
  for each of true, false and undefined, keeping the fastest (2025-11)
  [67].
- Hover slowness on a county map was polygon re-fill, not hit testing;
  `overlaps: false` batches fills for non-overlapping polygons; results
  depended on hardware [68].
- Declutter with an rbush of screen boxes; hit detection reuses the declutter
  tree of the previous frame instead of decluttering again [69].
- In-house R-tree replaced by rbush with bulk load [70]. UTFGrid
  lookups synchronous, null until loaded, preloaded by default [71].
- ol2 Canvas renderer: a hidden hit canvas with id+1 as RGB, one
  `getImageData` pixel per event, alpha != 255 ignored, strokes widened by
  2 px, only the topmost feature, no picking while dragging [72];
  antialiasing could not be turned off, hence try/catch around decoding
  [73]. UTFGrid: tile resolves pixel offsets, layer resolves map
  locations; surrogate-range code points fail [74]; 2x2 grid by default
  [75]. Pixel-alpha picking on raster tiles needs CORS, made opt-in
  because non-CORS servers then fail [76]. Editing large geometries
  indexes vertices in rbush and shows handles only on the nearest segment
  [77]. An SVG root without `position: absolute` drifted from the base
  layer in Chrome [78].

## Leaflet, tangram, harp.gl, maptalks, galileo

- Leaflet: Canvas partial redraws and better hit detection in 1.0, with a
  tail of rounding and clearing fixes [79]; an event propagation rewrite
  made FeatureGroup and GeoJSON adding and events about 10x faster, and a
  later event delegation rewrite improved add/remove performance and memory
  footprint [80]; Pointer Events only in 2.0
  [81]; `tolerance` as a Canvas renderer option, click tolerance on
  non-touch devices too, throttled hover [82]; hover skips during pans
  and tests only unculled layers [83]; the throttle flag is cleared on
  mouseout [84]; raw pixel bounds kept apart from padded bounds
  [85]; projected even-odd point-in-polygon (PR closed unmerged)
  [86].
- tangram: a 256x256 selection FBO, feature id in RGB, worker id in alpha;
  `readPixels` deferred with a timer, centre pixel first, then a radius scan;
  the fixed size limits precision on large canvases [87]. The pass and
  its framebuffer are lazy and skipped when nothing is interactive
  [88]. Label collision skips OBB tests unless a box is rotated
  [89].
- tangram-es: selection colours drawn into a separate framebuffer only on
  frames with a pending query, tested at half resolution; occluders must be
  drawn [90]; one id per label [91]; colour reads cached per
  frame [92].
- harp.gl: path labels collide glyph by glyph, point labels with one box
  [93].
- maptalks: feature JSON leaves the worker as one transferable UTF-8 buffer,
  geometry stripped, decoded on query; `features: 'id'` sends ids only
  [94].
- galileo: cached per-feature bbox before the exact test; skip tiles that do
  not contain the point [95].

## QGIS, GRASS, d3-geo, ortho-earth

- QGIS: MVT ids ignored because tiles in the wild reuse them [96].
  Label-versus-polygon obstacle tests moved from sample points to
  intersection area (narrow polygons were missed), then backed off the
  expensive intersection two months later [97]. Candidates are indexed
  with cached padded "conflict" bounds, so removal uses exactly the inserted
  box [98]. Clip rewritten for many inputs against few masks with
  prepared geometry and a containment shortcut: 1M lines 5m30s to 10 s, 5M
  points 50 min to 30 s [99].
- GRASS: R*-tree with bounding-sphere volume as the cost [100]; the
  spatial index stays in the file and is queried there (since 2009), memory
  per module "practically to zero" [101]; per-feature boxes removed
  from topology, the point is its own box [102]; a category index
  avoids scanning for selection by id [103]; the click distance
  threshold follows the map extent [104].
- d3-geo: `polygonContains` returns 0 for a boundary through the pole,
  documented as arbitrary [105].
- ortho-earth: restyle by evaluating expressions once into a fid-indexed
  style texture (16 bytes per fid; 31 KB for 1,919 features, 16 MB for 1M);
  a compacting GeoJSON path shifted every fid and coloured the neighbour
  [106].

## Mapnik, MapServer, GeoServer, TileMill, Organic Maps

- Mapnik: grid_renderer burns feature ids into a grid (2.0), 64-bit ids for
  OSM (2.2), optional at compile time (3.0) [107]. Collision boxes
  outside the index extent are no longer inserted (3.0.1 placement
  regression) [108]. Grid placement inside polygons tests candidates
  on a rasterised gray8 mask, spiralling out from the polylabel point, capped
  at 8192x8192 [109].
- MapServer: default TOLERANCE -1 resolved to 3 px for points and lines,
  which over-selected in shape queries; "I prefer less subtle errors like no
  points found" [110]. IDENTIFY CLASSAUTO tests the symbol footprint
  with ANCHORPOINT [111].
- GeoServer: buffer from the largest symbolizer, minimum 5 px for
  GetFeatureInfo; fails for data-driven sizes [112]. Clipped
  rendering must be clipped the same way for GetFeatureInfo [113].
  Numeric MVT ids parsed from the `type.N` feature id, -1 otherwise
  [114]. Label obstacles are bounding boxes, so line and polygon
  obstacles over-block [115].
- TileMill: one interactive layer, UTFGrid per tile; key autodetection
  enabled then reverted, the UI requires a key field instead [116].
- Organic Maps: tap priority current position > marks and POIs > tracks >
  buildings > other, 20 px rect (reviewers suggested 15 px), 10 px building
  snap; first-match-wins bug [117].

## Sources

1. https://github.com/maplibre/maplibre-gl-js/pull/8158, https://github.com/maplibre/maplibre-gl-js/issues/1596
2. https://github.com/maplibre/maplibre-gl-js/commit/8c274a9cd, https://github.com/maplibre/maplibre-gl-js/commit/17ae8e33c
3. ref-repos/maplibre__maplibre-gl-js/CHANGELOG.md (6.6.0 #7640, 6.10.0 #8387), https://github.com/maplibre/maplibre-gl-js/issues/7640
4. https://github.com/maplibre/maplibre-gl-js/pull/8387
5. https://github.com/maplibre/maplibre-gl-js/commit/fc992ec59
6. https://github.com/maplibre/maplibre-native/commit/0051fcdbb85b2a02751c62d1c76ee1518a967bcb
7. https://github.com/maplibre/maplibre-native/commit/90f6c531f31a4edc5945f15a9864b914ce156ba8
8. https://github.com/maplibre/maplibre-tile-spec/blob/main/docs/specification/v1.md, https://github.com/maplibre/maplibre-tile-spec/blob/main/rust/mlt-wasm/README.md (local: ref-repos/maplibre__maplibre-tile-spec/docs/specification/v1.md, ref-repos/maplibre__maplibre-tile-spec/rust/mlt-wasm/README.md)
9. https://github.com/maplibre/navara/blob/main/guide/ARCHITECTURE.md, https://github.com/maplibre/navara/blob/main/guide/TILE_TEXTURE_COMPOSITING.md
10. https://github.com/maplibre/navara/pull/420
11. https://github.com/maplibre/navara/pull/133
12. https://github.com/maplibre/navara/commit/f96c2449
13. https://github.com/visgl/deck.gl/blob/master/dev-docs/RFCs/v4.1/picking-improvements-rfc.md, https://github.com/visgl/deck.gl/blob/master/docs/developer-guide/performance.md, ref-repos/visgl__deck.gl/dev-docs/roadmaps/performance-roadmap.md
14. https://github.com/visgl/deck.gl/commit/0cff9773, https://github.com/visgl/deck.gl/commit/b8c7d33a, ref-repos/visgl__deck.gl/docs/developer-guide/performance.md ("Picking limitations"; docs/advanced/performance.md at 43fd968b)
15. https://github.com/visgl/deck.gl/commit/08e442f4, https://github.com/visgl/deck.gl/commit/80f4c7c1
16. https://github.com/visgl/deck.gl/commit/37237d01
17. https://github.com/visgl/deck.gl/blob/master/docs/whats-new.md, https://github.com/visgl/deck.gl/blob/master/docs/upgrade-guide.md, https://github.com/visgl/deck.gl/commit/0c4b7d11, https://github.com/visgl/deck.gl/commit/48760d53
18. https://github.com/visgl/deck.gl/blob/master/dev-docs/RFCs/v5.3/picking-overlapping-objects-rfc.md, ref-repos/visgl__deck.gl/docs/upgrade-guide.md
19. https://github.com/visgl/deck.gl/pull/1730
20. https://github.com/visgl/deck.gl/commit/13bed5d1
21. https://github.com/visgl/deck.gl/commit/08c389d8, https://github.com/visgl/deck.gl/commit/173a43ea
22. https://github.com/visgl/deck.gl/pull/4365
23. https://github.com/visgl/deck.gl/issues/7374, https://github.com/visgl/deck.gl/pull/7375
24. ref-repos/CesiumGS__cesium/CHANGES.md, https://github.com/CesiumGS/cesium/issues/5117
25. https://github.com/CesiumGS/cesium/pull/12983
26. https://github.com/CesiumGS/cesium/commit/53fa96bf858d13a2c2b0b054c775459d9346cdc1, https://github.com/CesiumGS/cesium/commit/1e8d248e34cc84a11aa512e2a09321c59cff1b39, https://github.com/CesiumGS/cesium/commit/debd74eb915aed2d3e09eb73a991f4c2c9f907e1
27. https://github.com/CesiumGS/cesium/commit/94e579ea4201816bc52c94be45d81cfe0251d60c, https://github.com/CesiumGS/cesium/commit/e3b388d662995577eb4ca7927a413724c2d60538, https://github.com/CesiumGS/cesium/commit/fe8738002a4ee5330124962c927f839ea4c28801
28. https://github.com/CesiumGS/cesium/pull/2782
29. https://github.com/reearth/reearth-visualizer/pull/920, https://github.com/reearth/reearth-visualizer/commit/3c5a29e7, https://github.com/reearth/reearth-visualizer/commit/25359fa5
30. https://github.com/iTowns/itowns/pull/635
31. https://github.com/iTowns/itowns/pull/450, https://github.com/iTowns/itowns/pull/470
32. https://github.com/iTowns/itowns/commit/061d19e3
33. https://github.com/iTowns/itowns/commit/3a8daf03, https://github.com/iTowns/itowns/commit/ac2e8000
34. https://github.com/iTowns/itowns/commit/5d2f384
35. https://github.com/iTowns/itowns/commit/069b2dde
36. https://github.com/iTowns/itowns/commit/9ee991c3
37. https://github.com/iTowns/itowns/commit/f0eaf96c
38. https://github.com/openglobus/openglobus/commit/6e17c9a2, https://github.com/openglobus/openglobus/commit/b52eed53, https://github.com/openglobus/openglobus/commit/13c97f3d, https://github.com/openglobus/openglobus/commit/b1b2f38b
39. ref-repos/NASAWorldWind__WorldWindJava/src/overview.html, ref-repos/NASAWorldWind__WorldWindJava/src/gov/nasa/worldwind/render/DrawContextImpl.java (https://github.com/NASAWorldWind/WorldWindJava/blob/2543c23/src/gov/nasa/worldwind/render/DrawContextImpl.java), ref-repos/NASAWorldWind__WorldWindJava/src/gov/nasa/worldwind/BasicSceneController.java
40. ref-repos/NASAWorldWind__WorldWindJava/src/gov/nasa/worldwind/render/SurfaceObjectTileBuilder.java (https://github.com/NASAWorldWind/WorldWindJava/blob/2543c23/src/gov/nasa/worldwind/render/SurfaceObjectTileBuilder.java), ref-repos/NASAWorldWind__WorldWindJava/src/gov/nasa/worldwind/AbstractSceneController.java
41. ref-repos/NASAWorldWind__WorldWindJava/src/gov/nasa/worldwind/symbology/AbstractTacticalSymbol.java (https://github.com/NASAWorldWind/WorldWindJava/blob/2543c23/src/gov/nasa/worldwind/symbology/AbstractTacticalSymbol.java)
42. https://github.com/NASAWorldWind/WorldWindJava/issues/195, https://github.com/NASAWorldWind/WorldWindJava/pull/262, https://github.com/NASAWorldWind/WorldWindJava/pull/274
43. https://github.com/NASAWorldWind/WebWorldWind/commit/dabcdd1, ref-repos/NASAWorldWind__WebWorldWind/performance/DeepPickingPerformance.js
44. https://github.com/pelicanmapping/osgearth/issues/1062
45. https://github.com/pelicanmapping/osgearth/commit/a1663895ca8ac6650cdf8aed097951c536846950, https://github.com/pelicanmapping/osgearth/commit/b0fd185975425941205772e6996f01b35fd200ca
46. https://github.com/pelicanmapping/osgearth/commit/367a3cf66, https://github.com/pelicanmapping/osgearth/commit/0a7396f54
47. https://github.com/pelicanmapping/osgearth/commit/8d1166c3b79134138d006a625c5b43b5dbc25e4c
48. https://github.com/vasturiano/globe.gl/issues/223, https://github.com/vasturiano/globe.gl/commit/97541ca, https://github.com/vasturiano/globe.gl/commit/5c9b91c, https://github.com/vasturiano/globe.gl/commit/0f2844c, ref-repos/vasturiano__globe.gl/README.md
49. https://github.com/vasturiano/globe.gl/issues/30, https://github.com/vasturiano/globe.gl/commit/77b047b, https://github.com/vasturiano/globe.gl/commit/b35847d
50. https://github.com/vasturiano/globe.gl/issues/25, https://github.com/vasturiano/globe.gl/commit/4ab22ec
51. https://github.com/vasturiano/globe.gl/issues/91, https://github.com/vasturiano/globe.gl/commit/88ed48d, https://github.com/vasturiano/globe.gl/commit/5e3071b
52. ref-repos/TerriaJS__terriajs/packages/terriajs/doc/contributing/architecture.md, ref-repos/TerriaJS__terriajs/packages/terriajs/doc/contributing/feature-picking.md, ref-repos/TerriaJS__terriajs/packages/terriajs/CHANGES.md
53. ref-repos/TerriaJS__terriajs/packages/terriajs/doc/contributing/feature-picking.md, ref-repos/TerriaJS__terriajs/packages/terriajs/CHANGES.md
54. https://github.com/TerriaJS/terriajs/issues/1211
55. https://github.com/TerriaJS/terriajs/commit/f44043366
56. https://github.com/TerriaJS/terriajs/commit/06cfa3a19
57. https://github.com/TerriaJS/terriajs/commit/802ae4c8a, https://github.com/TerriaJS/terriajs/commit/6c7ed9665, https://github.com/TerriaJS/terriajs/commit/d5ff6b5cd
58. https://github.com/TerriaJS/terriajs/commit/39e23d50309f3bf9b26056129d4dc24b8854f0df, https://github.com/TerriaJS/terriajs/commit/fb294d713d08d6263098cddd136f698f55aa710d
59. ref-repos/openlayers__openlayers/changelog/upgrade-notes.md, ref-repos/openlayers__openlayers/changelog/v6.1.0.md, ref-repos/openlayers__openlayers/changelog/v6.13.0.md
60. ref-repos/openlayers__openlayers/changelog/upgrade-notes.md (6.0, 6.5, 7.5)
61. https://github.com/openlayers/openlayers/issues/4232, https://github.com/openlayers/openlayers/issues/4232#issuecomment-232302739
62. https://github.com/openlayers/openlayers/commit/4b13c6dae, https://github.com/openlayers/openlayers/commit/ac5f52a21, https://github.com/openlayers/openlayers/commit/315695eeb
63. https://github.com/openlayers/openlayers/issues/5862, https://github.com/openlayers/openlayers/pull/5995
64. https://github.com/openlayers/openlayers/commit/c076d273e, ref-repos/openlayers__openlayers/changelog/upgrade-notes.md (6.5)
65. https://github.com/openlayers/openlayers/commit/600e1a464
66. https://github.com/openlayers/openlayers/commit/a4b7f7062
67. https://github.com/openlayers/openlayers/commit/b75d4e8ef, https://github.com/openlayers/openlayers/commit/1eb51f456, https://github.com/openlayers/openlayers/commit/295a5b77a, https://github.com/openlayers/openlayers/commit/cf24c77e9, https://github.com/openlayers/openlayers/commit/4ce546b4a, https://github.com/openlayers/openlayers/commit/8f6f87b85
68. https://github.com/openlayers/openlayers/issues/4232#issuecomment-203025742, https://github.com/openlayers/openlayers/issues/4232#issuecomment-232299628
69. https://github.com/openlayers/openlayers/commit/08af20772, https://github.com/openlayers/openlayers/commit/80e67bac7, https://github.com/openlayers/openlayers/commit/ac195c46b, https://github.com/openlayers/openlayers/commit/a2d41da30
70. https://github.com/openlayers/openlayers/commit/af4184e74, https://github.com/openlayers/openlayers/commit/97acd989a, https://github.com/openlayers/openlayers/commit/17e56d835, https://github.com/openlayers/openlayers/commit/3e2cc3c24
71. https://github.com/openlayers/openlayers/pull/3015
72. https://github.com/openlayers/ol2/blob/master/lib/OpenLayers/Renderer/Canvas.js, https://github.com/openlayers/ol2/blob/master/notes/2.13.md
73. https://github.com/openlayers/ol2/commit/3ef0b059, https://github.com/openlayers/ol2/commit/11191464
74. https://github.com/openlayers/ol2/pull/244
75. https://github.com/openlayers/ol2/commit/89e8a872, https://github.com/openlayers/ol2/commit/80656cdf
76. https://github.com/openlayers/ol2/pull/160
77. https://github.com/openlayers/ol2/issues/1080
78. https://github.com/openlayers/ol2/issues/392
79. ref-repos/Leaflet__Leaflet/CHANGELOG.md, https://github.com/Leaflet/Leaflet/pull/5148, https://github.com/Leaflet/Leaflet/pull/6915
80. ref-repos/Leaflet__Leaflet/CHANGELOG.md, https://github.com/Leaflet/Leaflet/pull/3032, https://github.com/Leaflet/Leaflet/pull/2311
81. ref-repos/Leaflet__Leaflet/docs/_posts/2016-03-20-debugging-touch-interactions.md, ref-repos/Leaflet__Leaflet/docs/_posts/2025-05-18-leaflet-2.0.0-alpha.md
82. https://github.com/Leaflet/Leaflet/issues/5922, https://github.com/Leaflet/Leaflet/pull/4396, ref-repos/Leaflet__Leaflet/CHANGELOG.md
83. https://github.com/Leaflet/Leaflet/commit/fd64c7e5
84. https://github.com/Leaflet/Leaflet/commit/6aaad717
85. https://github.com/Leaflet/Leaflet/commit/13f649d4
86. https://github.com/Leaflet/Leaflet/pull/4618
87. https://github.com/tangrams/tangram/blob/master/src/selection/selection.js (local: ref-repos/tangrams__tangram/src/selection/selection.js)
88. https://github.com/tangrams/tangram/commit/068aec9c, https://github.com/tangrams/tangram/commit/7c515884
89. https://github.com/tangrams/tangram/commit/078d25a6, https://github.com/tangrams/tangram/commit/83f61ca5
90. https://github.com/tangrams/tangram-es/pull/948
91. https://github.com/tangrams/tangram-es/pull/1076
92. https://github.com/tangrams/tangram-es/commit/1e3ce2de
93. ref-repos/heremaps__harp.gl/docs/@docs/label-rendering/README.md, https://github.com/heremaps/harp.gl/commit/323f82bb
94. https://github.com/maptalks/maptalks.js/commit/e3e51e3e6, https://github.com/maptalks/maptalks.js/commit/c8f78dc6b
95. https://github.com/galileo-map/galileo/commit/cd61976, https://github.com/galileo-map/galileo/commit/3196f9e
96. https://github.com/qgis/QGIS/commit/70aea49fc4
97. ref-repos/qgis__QGIS/ChangeLog (2015-08-31 "[pal] Improved test for candidate against polygon obstacles"), https://github.com/qgis/QGIS/commit/f9fa9793f0, https://github.com/qgis/QGIS/commit/b384f18a3d
98. https://github.com/qgis/QGIS/commit/5b6151086d, https://github.com/qgis/QGIS/commit/72474ab4a0
99. https://github.com/qgis/QGIS/commit/71ebdb8f69
100. ref-repos/OSGeo__grass/lib/vector/rtree/docs/README.txt, https://github.com/OSGeo/grass/blob/main/lib/vector/rtree/docs/README.txt
101. ref-repos/OSGeo__grass/doc/vector/TODO, ref-repos/OSGeo__grass/lib/vector/vectorlib_indices.dox, https://github.com/OSGeo/grass/blob/main/doc/vector/TODO
102. ref-repos/OSGeo__grass/doc/vector/TODO, https://trac.osgeo.org/grass/ticket/542
103. ref-repos/OSGeo__grass/lib/vector/vectorlib_indices.dox
104. https://github.com/OSGeo/grass/pull/3793, https://github.com/OSGeo/grass/blob/main/gui/wxpython/mapdisp/frame.py
105. https://github.com/d3/d3-geo/commit/aff9146, https://github.com/d3/d3-geo/issues/105
106. https://github.com/kenjiyoshidahome2026-bit/ortho-earth/blob/main/packages/ortho-core/gint%20draw%20spec.md (local: ref-repos/kenjiyoshidahome2026-bit__ortho-earth/packages/ortho-core/gint draw spec.md)
107. https://github.com/mapnik/mapnik/blob/master/CHANGELOG.md, https://github.com/mapnik/mapnik/issues/1661, https://github.com/mapnik/mapnik/issues/1962, ref-repos/mapnik__mapnik/docs/design.md
108. https://github.com/mapnik/mapnik/commit/43dcf35a9, https://github.com/mapnik/mapnik/commit/3f91186a7, ref-repos/mapnik__mapnik/CHANGELOG.md
109. https://github.com/mapnik/mapnik/commit/f10e051e1, https://github.com/mapnik/mapnik/commit/b6c451d7e
110. https://github.com/MapServer/MapServer/issues/1103
111. https://github.com/MapServer/MapServer/commit/b8f298d7, https://github.com/MapServer/MapServer/commit/834b621d
112. ref-repos/geoserver__geoserver/doc/en/user/services/wms/vendor.md
113. https://github.com/geoserver/geoserver/pull/3961
114. https://github.com/geoserver/geoserver/commit/9994bf592a
115. ref-repos/geoserver__geoserver/doc/en/user/styling/sld/extensions/label-obstacles.md
116. https://github.com/tilemill-project/tilemill/issues/1358, ref-repos/tilemill-project__tilemill (commit 3008d9ca), ref-repos/tilemill-project__tilemill/_posts/docs/reference/0204-03-01-project-settings.md
117. https://github.com/organicmaps/organicmaps/pull/7876
