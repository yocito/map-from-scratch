# Engine by engine: HLOD and 3D Tiles decisions

Numbers in brackets refer to the Sources list in ../SKILL.md.

## CesiumGS/cesium

- Bounding volumes (2015-16): box, sphere and region were chosen over a
  single lat/lon box; names like curvedBox and WGS84_box were discussed.
  Region keeps a conservative OBB for visibility and a precise distance so
  tiles do not refine too soon. A region's top is a curve tangent to the
  OBB's flat top at one point; exact region visibility was rejected as slow
  and hard because the shape is not convex [8].
- Implicit tiling (first implementation): subtree availability bitstreams
  are transcoded on demand into explicit tiles, with placeholder nodes for
  child subtrees. The PR calls it a naive proof of concept and lists bugs in
  bounding-volume derivation for rotated or non-uniformly scaled boxes [9].
- Screen-space error: `geometricError * height / (distance * sseDenominator)`,
  divided by `frameState.pixelRatio`; an optional fog-based term lowers the
  error of distant tiles (`dynamicScreenSpaceError`); orthographic frustums
  use geometric error over pixel size [61].

## maplibre/navara

- Whole-building selection: an IdPropertyTable maps an id property (for
  example gml_id) to every global batch id. Selected id values are stored in
  a resource and checked when each batch is created; before that fix
  (noted 2025-02-20) batches loaded after the click stayed unhighlighted.
  Matching in a loop dropped FPS at the click [1].
- pnts: Draco-compressed point clouds first; uncompressed ones load but are
  coloured wrongly; batched points unsupported because the files seen did
  not use the batch table [2].

## reearth/reearth-visualizer

- Before #499 every style change looped synchronously over cached features.
  #499 (2023-02-28) splits the work into requestAnimationFrame jobs, with
  `MAX_NUMBER_OF_CONCURRENT_COMPUTING_FEATURES = 5000`, and abandons a pass
  when `skippedComputingAt > startedComputingAt` [3].
- Features used to be hashed (md5 of bounding-sphere centre + feature id) and
  pushed to the app store on tileLoad, removed on tileUnload. #568 (+44/-91)
  attaches `{layerId, featureId, computedFeature}` to the raw feature
  instead [4]. That removed the global feature list, so #920 later added
  TilesetFeatureIndex (`key -> [{content, batchId}]`) for constant-time
  selection of buildings split across tiles, tested on PLATEAU [5, 6]; #746
  lets flyTo skip the per-feature search when only a layer is targeted [7].

## visgl/deck.gl

- Draft RFCs (not implemented as described): layer culling with oriented
  bounds and a GPU time budget, 3-4x in first-person point clouds; GPUs
  cannot index instance tables, so instance filtering needs regenerated
  instance arrays (CPU fine below ~10K instances); a 10K-vertex model x 1000
  instances is 10M vertices per draw; axis-aligned boxes are insufficient
  under 4x4 transforms [10, 11].
- Multiple views (#5758): traversal receives every viewport the layer is
  drawn in (intercepting activateViewport) and compares each against
  `lastUpdatedViewports[viewId]`. Tests were timing-sensitive (50 ms vs
  10 ms) [12].
- Blurry Google 3D Tiles (#7955): blank children entries stopped traversal at
  depth 19 versus Cesium's 31 at the Eiffel Tower. Workaround before the
  loaders.gl 3.4.11 fix: hide tiles whose `lodZoom = 22 - log2(lodMetricValue)`
  is far below the viewport zoom, trading possible holes. A 2024 comment
  still reports lost detail at very high zoom [13].

## kenjiyoshidahome2026-bit/ortho-earth (GPL-3)

- Hidden tilesets unload after 20 s; showing again reloads from the root,
  quick zoom in/out keeps them. Hidden building meshes are evicted from the
  GPU; IndexedDB/OPFS copies make the return a cache hit. Measured on
  Yokohama: 666 tiles (~490 MB) and ~188 MB of LOD2 meshes held while
  hidden under a 512 MB shared budget [14].

## qgis/QGIS

- First 3D view (2017): Qt 3D, chunked LoD, DEM terrain, in a separate
  `qgis_3d` library behind a registry; Qt 5.8+ required (5.7 crashed); DEMs
  must be in a projected metric CRS; draped labels "become obstacles" when
  rotated, so labels off by default was planned [16, 17].
- Chunk selection uses a node that cannot have children even when finer
  detail is wanted (2020) [21].
- Empty vector chunk nodes removed and excluded from parent bounds (2022)
  [31, 32].
- Dynamic vector chunking by feature budget and screen error, avoiding big
  or thin tiles and endless empty children; a fixed root screen error was
  later removed from the user settings [28].
- Clipping to the chunk extent and suppressing outline edges on the chunk
  perimeter, with a safeguard for geometry collections from differencing
  [29].
- Queued loads culled by the view-projection matrix are dropped (wip, with an
  assertion about full reloads) [30].
- Point budget minimum 100,000; per-chunk primitive budget removed [18, 19,
  20].
- Precision: EPT offset/scale parsed without loss and written by untwine
  (hobu/untwine#28, #46) [22, 23]; chunk-local coordinates from a chunk
  corner and double `QgsBox3D` bounds in map coordinates instead of float
  `QgsAABB` in flipped world coordinates, preparing QEP #301 large scenes
  [15, 24, 25, 26, 27].

## maptalks/maptalks.js

- `maxGPUMemory` default 1024 MB, then 1536 MB (2024-01-12) with a
  GlobalTileCache LRU of 32 MB on mobile, 1024 MB on desktop, grown to the
  largest layer's budget and reset when the last layer goes; a warning says
  tiles will be discarded when the budget is too small [33, 34]. Later fixes
  for exceeding the budget [35].

## iTowns/itowns

- 2017: SSE from distance to the volume (#185) [43]; additive refinement
  fetches only visible children [44].
- 2023-07 (v2.42.0): regions become enclosing spheres; `region/box/sphere`
  replaced by `volume` and `initialVolumeType`; a sphere-subdivision bug
  fixed in the same commit [36, 37].
- 2024-02 (v2.43.0): lazy batch-table lookup; `findBatchTable` removed;
  C3DTFeature constructor changed [38].
- 2024 (v2.44.0): OGC3DTilesLayer on 3d-tiles-renderer-js (+2883/-1676,
  glTF 1.0/2.0 loader kept), C3DTilesLayer deprecated with a warning in
  v2.45.0 [39, 40, 37]. Earlier C3DTilesLayer fixes in the changelog cover
  tiles disappearing on zoom, cache cleaning and load overhead [37].
- Cache sharing: one LRU and download/parse queues per view (#2435, after
  sharing across all views broke multiple views, #2426), removed in
  2026-10 without a message body [45, 46, 47].
- Point clouds: children created when the parent loads (#2710) [42]; 2026-05
  lazy hierarchy for Potree, Potree2, COPC and Entwine sharing hierarchy
  references [48].
- Shadows (#2691) separate from realistic lighting; the reviewer's profile
  showed picking dominating the 3D Tiles slowdown; remaining flicker put
  down to float precision [41].

## TerriaJS/terriajs

- Quality slider: `maximumScreenSpaceError = 8 * base`, slider 1-3 in 0.1
  steps, default 2 gives 16; SSE=1 special case removed [52]. The slider
  also scales tile cache, preloadAncestors, resolution scale, fog, shadows
  (off at the low end, with a toast) and per-tileset dynamic SSE and point
  attenuation; quality is a device preference not restored from story
  scenes [49].
- Low-spec ceilings: `cacheBytes` 128 MiB, `maximumCacheOverflowBytes`
  64 MiB, applied as min(authored, ceiling) [53].
- Search highlight: `tileVisible` fires per visible tile per frame, so a Set
  of watched tiles limits scanning to once per tile; matches get a
  `terriajs_search_result` property and one style condition [50]. A React
  re-render reloaded the tileset during scrolling [51].
- Destroying a tileset destroyed shared draped imagery layers; now detached
  first and recreated if destroyed [54].

## pelicanmapping/osgearth

- The glTF loader covers only what some 3D Tiles datasets need; instanced
  models broke (#1598, closed for inactivity) [55].
- The native ThreeDTilesLayer loaded every level (json and b3dm together)
  without skip-LOD; slower than CesiumJS at 8 concurrent requests; later
  replaced by an osgEarthCesium layer on cesium-native, with users hitting
  compile errors and being advised to pin v0.31.0 [56].
- RapidJSON, reserved arrays, faster base64 and a Buffer move constructor
  (~6k vendored lines); tinygltf upgrade reverted; fast base64 re-added
  [57, 58, 59].
- SimplePager cluster culling off by default: wrong for geometry standing on
  terrain and rarely useful at the layers' draw distances [60].
