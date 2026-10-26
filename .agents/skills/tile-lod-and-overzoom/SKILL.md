---
name: tile-lod-and-overzoom
description: How map engines choose which tiles and which zoom level to draw for a view (single zoom, per-tile LOD under pitch or on a globe, screen-space error, tile budgets), how they draw past the data's max zoom (overzoom), and what they show while tiles load (parent/child fallback, pruning). Load it when a map-from-scratch request has more data than one bake can ship, zooms past the data's detail, pitches the camera or uses a globe, or when writing `architecture_selection.not_doing` and deciding whether tiles, LOD or overzoom belong in the renderer at all.
---

# Tile LOD and overzoom: which level to draw, and what to draw when it is missing

A tiled renderer answers three questions every frame. Which tiles cover the
view, and at what zoom each? What to draw for a zoom deeper than the data
goes? What to show for a tile that has not arrived yet? General engines
answer all three for every camera (pitch to the horizon, globes, fractional
zoom, slow networks), and most of their code, knobs and regressions in this
area come from that generality. A renderer made for one request can often
skip all three (the examples in this repo bake everything and list "tiles,
LOD" under `not_doing`, see 05), or answer one of them with a single
function. This skill collects what the engines in `ref-repos/` decided,
what they measured, and what they reverted (decision records mined from 42
engines, 22 of which had something to say here), so the choice is made
from evidence.

Per-engine detail (exact constants, the order of fixes, review discussions)
is in [references/engines.md](references/engines.md). Numbers in brackets
refer to the Sources list at the end.

## First decision: do you need tiles or LOD at all?

- If the whole baked data set fits the size budget and loads in time, there
  is no tile pyramid to select from: draw everything, and no fallback,
  pruning or overzoom logic exists. The fallback machinery in maplibre-rs,
  Tangram and tangram-es exists to cover tiles still in flight over the
  network [15][18][80][87].
- If only the generalisation changes with zoom, swap whole pre-generalised
  layers instead of tiling. ortho-earth starts admin0 at Natural Earth 50m
  and swaps in 10m at z7-9 (world layers 3.5 MB to 0.65 MB at start) [47];
  Marble picks 110m, 50m or 10m Natural Earth per level instead of
  simplifying one dataset [52].
- A top-down camera needs one zoom for all visible tiles. The engines added
  per-tile LOD for pitched or globe views, and GL JS Mercator still uses the
  old cover below 60 degrees of pitch without terrain; harp.gl ships mixed
  LOD off by default [3][6][11][14][45][101].
- Tiles over the network need fallback, cancellation and centre-out
  ordering, which deck.gl's first TileLayer lacked and later added [42].
- For vectors that redraw within a frame, OpenLayers chose one cached image
  at the settled resolution, stretched during gestures, over a
  multi-resolution vector tile grid (crashes after about 10 s of zooming
  in #764) [58].

## 1. Choosing the zoom for a top-down view

- **Pick the integer tile level in one function, with an explicit rounding
  rule, and use it on every code path.** Leaflet rounds (`Math.round`) so
  URLs never carry a fractional `{z}` [73]; it had to fix the same bug a
  second time in `redraw`, which skipped the rounding (#9930) [73]. Tangram
  switched from round to floor so tiles are only ever scaled up toward the
  next zoom [82]. QGIS floors for rule visibility, keeps the fractional zoom
  for interpolation, and treats a Mapbox `maxzoom` as exclusive; rounding
  misfired at z11.8 for a z12-22 rule [49].
- **Compute tile ranges in integer tile space.** With fractional zoom,
  Leaflet testers saw tile requests with x=123.99999997, and rounding them
  then broke low-zoom requests [69].
- **Decide visibility on the requested zoom, then clamp to the data zoom.**
  Clamping first made Leaflet's out-of-range test never fire when
  `maxNativeZoom === maxZoom`, and tiles flickered [72].
- **Fractional zoom is a scaled integer level.** Leaflet, OpenLayers 2 and
  others load the integer level and scale it with a transform [61][64][67];
  snapping to integer zoom stays Leaflet's default because scaled raster
  tiles look soft between levels [64]. Position tiles in integer pixels and
  scale a container; percentage placement caused white seams between tiles
  in OpenLayers 2 [62].
- **Tile size is a zoom offset, not a new coordinate system.** tangram-es
  requests `{x/2, y/2, z-1}` for 512 px tiles (zoom shifted by
  log2(size)-8), cutting URL requests about 4x [93]. protomaps-leaflet's
  `levelDiff` 2 drew from data one zoom lower for speed; 2.0 fixed it at 1
  to match MapLibre, at the cost of loading and drawing about 4x the data
  per viewport [74].
- **Bake only the zooms where the data visibly changes.** Tangram sources
  can list `zooms` (e.g. `[0,2,4,...,16]`) and overzoom between them [84];
  Marble publishes vector OSM tiles only at odd levels 1-17, about half the
  levels to generate [50][51]. Marble keeps its top level (z17) "as
  verbatim as possible" and runs its node reducer only on the levels that
  need it [55].
- **Gate reads with the drawing's zoom test.** RustGIS fetched tens of
  megabytes of FlatGeobuf over HTTP for a layer outside its zoom range,
  because the range gated only drawing [25]; tangram-es fetches nothing
  below `min_display_zoom` [91].
- **Lower-resolution rasters: compare bytes and requests.** Tangram's
  `zoom_offset` 1 cut a view from 6 tiles/1.6 MB to 2 tiles/488 KB, but
  256 px tiles stretched to 512 gave identical pixels at 6 tiles/407 KB
  [77]; tangram-es uses the same offset for terrain rasters [97].
- **A tile count target can set the level.** Marble aims at about 20 tiles
  on screen (12 on mobile), from the physical screen size rather than the
  canvas [53]. A tile cache sized as a constant count fails on large
  screens: maptalks lost visible tiles at 3964x2160 and pitch over 56 with
  the default 256 [103].

## 2. Pitched cameras and globes: per-tile LOD with a budget

- **Choose zoom per tile from distance or screen size.** MapLibre GL JS
  scales the centre zoom by camera-to-centre over camera-to-tile 3D
  distance; Mercator keeps the old cover below 60 degrees without terrain
  [3]. Its formula S = S_c cos^(b/2+1)(theta)/cos(theta_c) loads tiles of
  about equal screen area at b=1 (default); b=0 equal width, b=2 equal
  height, b=-1 one zoom for all [1]. MapLibre Native's distance mode splits
  a node when distance(camera, AABB)*2^z is below
  cos(pitchToTile)^0.5*cameraToCenterDistance/scale, and loads tiles nearest
  the camera first [14]. The quadtree-descent covers in GL JS and Native
  keep about 3 max-level tiles around the centre (`radiusOfMaxLvlLodInTiles
  = 3`) [6][11].
- **Cull a quadtree against the frustum, not a 2D bbox.** deck.gl moved
  from bbox index math to a lazily built quadtree culled with
  `CullingVolume`, checking up to 3 world copies, so pitched views load the
  right tiles [45]. polymaps scan-converts the rotated viewport as two
  triangles; its bbox version was an admitted stopgap, and the rasteriser
  later had a `1<<-1` bug at negative zoom and double counts on the
  diagonal [106].
- **Bound the tile count explicitly.** GL JS `setSourceTileLodParams`
  lowers zoom uniformly when the count would exceed a ratio times the flat
  count [5]. maplibre-rs capped view tiles at 32 because pitch overran a
  fixed GPU buffer ("copy of 0..4216 would end up overrunning ... size
  2176"), and with the cap fewer tiles were shown at higher pitch
  [16][19]. Drop by priority, never arbitrarily [16].
- **Prefer one replaceable function over knobs.** GL JS reviewers rejected
  a `pitchTileLoadingBehavior` enum plus `tileZoomDeadband` ("two confusing
  parameters are worse than one") and left tuning to a callback [3]; GL
  JS's `maxZoomLevelsOnScreen` does not match the actual number of levels
  on screen [5].
- **Screen-space error from one FOV definition, with a unit test.**
  navara found the SSE used the wider-axis FOV while rendering used the
  vertical one, overestimating error by the aspect ratio on landscape
  screens; after the fix it halved globe and 3D Tiles `maxSse` but left the
  vector-tile value at 2.0, accepting coarser lines and labels to halve MVT
  fetches [23]. iTowns had two copies of a wrong SSE formula; unifying it
  changed subdivision and needed threshold retuning [116]. Distance must go
  to the bounding volume, not its centre, or tiles the camera is inside
  under-refine [113].
- **Culling volumes.** Oriented boxes cut Cesium tile loading by up to 50%
  [31]; deck.gl's globe fits an OBB to 5 or 9 sample points (min and max
  elevation) instead of a sphere [46]. iTowns horizon-culls with one
  precomputed point per tile instead of 8 OBB corners per frame [115].
  These matter only where tiles curve or tilt; on a flat map the tile
  rectangles are already exact [31][46].
- **Check selection against a reference engine before tuning.** deck.gl's
  blurry Google 3D Tiles came from blank entries in child lists stopping
  traversal at depth 19 where Cesium reached 31; lowering
  `maximumScreenSpaceError` had no effect [43]. MapLibre Native's globe
  blinked to background near z6 because bounds were checked at the nominal
  zoom, not the tile's own [8].
- **Cull with the content's height, and not with the depth planes.** GL JS
  pads culling by a per-source high-water mark of symbol height offset; a
  symbol that vanished at pitch 94 then stayed to pitch 100 [4]. maplibre-rs
  refused to lower znear to fix tiles disappearing on tilt: the bug was tile
  selection tied to znear/zfar, and znear should stay large [16]. tangram-es
  rasterises an extra triangle so tall geometry whose base is off-screen
  still loads [88].
- **Latitude and pole rules on a globe.** navara scales Web Mercator
  geometric error by the cosine of the equatorward latitude; equatorial
  error over-refined toward the poles [21]. iTowns stops subdividing the
  pole rows of EPSG:4326 tiles at level 5 [109].
- **Coarser toward the horizon, hidden by fog.** Cesium's horizon fog
  culled tiles for up to 35% terrain performance; the culling parameter was
  later separated from the visual density [32].
- **Memory pressure raises the error threshold.** Cesium multiplies SSE
  each frame while over a byte budget and relaxes it below 75% [41]; navara
  makes recovery wait a cooldown that doubles (about 5 s up to 60 s) after
  each failed recovery, to stop a coarsen-refetch loop [20].
- **Selection itself can be expensive.** ortho-earth memoises selection on
  unchanged camera and screen inputs: a tilted view went from 4.9 to 2.1 ms
  per update, checked identical on 400 random cameras [48]. MapLibre Native
  made its tile-mask benchmark 33x faster by trusting the selector's sort
  order instead of re-sorting [10].

## 3. Past the data's max zoom: overzoom

- **Scaling the deepest tile is the baseline.** Leaflet's `maxNativeZoom`
  scales the last level, keeping the map covered with blurry tiles [65][68].
  For DEM or raster layers, sample a sub-rectangle of the ancestor rather
  than dropping the layer: navara's hillshade vanished above its max zoom
  until it reused the parent normal map via a UV transform [22].
- **Deep vector overzoom: clip to the view tile, do not draw the whole
  parent.** GL JS re-slices overzoomed vector tiles (default 4 levels since
  6.0); it improved high-zoom performance and prevented Safari crashes, but
  changed `queryRenderedFeatures` results and brought encoding bugs [2][7].
  reearth-papers renders deep tiles from the z15 ancestor rather than
  upscaling pixels, deduplicating neighbour fetches that collapse onto one
  ancestor (otherwise a z18 tile fetched the same MVT nine times) [28];
  clipping to the tile took a z20 pencil-style tile from 14.1 s/266 MB to
  4.2 s/76 MB, and z22 from failing to 8.0 s [29].
- **Key decoded data by source tile, not display tile.** Tangram copies the
  data of an already loaded source tile instead of refetching and parsing
  it per overzoomed tile [83].
- **Quantised attributes run out of range.** Tangram stored line width in
  16-bit shorts: a 10 px line from z16 was about 8 px at z21 and gone by
  z24; it now stores width in style-zoom units [79][81], and tangram-es
  scales by 2^(s-z) in the vertex shader [86]. tangram-es shrank the line
  UV scale for correct dashes up to 5 overzoomed levels [96], and capped
  its label collision grid, which made huge allocations on deeply
  overzoomed tiles [95]. World-coordinate noise floored into 32-bit `isize`
  overflowed on wasm32 at deep zooms while the native build was fine [29].
- **Thin out per-symbol work.** protomaps-leaflet multiplies line-label
  repeat distance by 2^(overzoom-4) beyond 4 levels [75]; MapLibre Native
  culls off-screen symbols of overscaled tiles before placement [13].
- **Do not refine where children would only be upsampled.** Cesium stops
  refining when all children would be upsampled from the parent: 243 to 219
  rendered tiles on its Half Dome view, no visual loss [38].
- **Signal "no data" as a miss.** reearth-papers returns 404 for empty
  tiles so MapLibre fills from the nearest ancestor; 204 or transparent
  tiles left gaps [30].

## 4. While tiles load: fallback, overlap and pruning

- **Bounded, asymmetric search.** Leaflet keeps up to 5 parent levels or 2
  child levels [70]; polymaps up to 4 coarser or 2 finer, drawn in a fixed
  level order with the current level on top [107]; modestmaps shows the
  nearest cached ancestor, else the four children, with full-pyramid
  loading opt-in [104]. MapLibre Native lets a source cap how many levels a
  parent may be overscaled, mainly for raster [12].
- **Keep tiles until replaced.** OpenLayers keeps rendered tiles until new
  ones replace them, aligns lower-resolution fill, and skips fade-in when a
  fallback is visible [57].
- **Opaque vs translucent layers decide the overlap rule.** Drawing a
  parent under translucent children double-blends: deck.gl added a
  `no-overlap` strategy [44], harp.gl disables fallback for transparent
  sources [99], Tangram masks proxies with the stencil except for points and
  text, where it caused a cut-out effect [76][85], and OpenLayers draws only
  the uncovered remainder rectangles of lower-zoom tiles [59]. OpenLayers 2's
  stretched backbuffer duplicated labels on non-opaque layers [60].
- **Hide a parent only when all four children are ready** (iTowns) [114];
  harp.gl's mixed LOD uses an all-children-or-none rule [101].
- **Prune by re-scanning, not incrementally.** Leaflet tried incremental
  per-tile pruning and reverted it after five days; re-scanning on each
  tile ready proved more robust than bookkeeping, after repeated stranded,
  missing and flickering tiles [70].
- **Load what you render.** Cesium stopped preloading children of every
  visited tile [37]. MapLibre Native's coarse prefetch (z-4) is worth it
  only when latency dominates [9]. Cesium's fill tiles (meshes stitched from
  neighbour edges) let it skip levels: 434 to 205 requests top-down, 1448 to
  837 panning [35].
- **During motion, accept stand-ins and spread the work.** RustGIS stopped
  keying cached pictures by exact mid-motion resolution and uses stretched
  stand-ins: worst panning frame 650-1010 ms down to 110-270 ms [26]; with
  zoom animation, draw cached children over the stand-in parent [27].
  Prioritise the screen centre and cancel requests that leave the view
  (Cesium: about 67% shorter tour load time) [33][42].

## Tried and reverted

- Leaflet incremental tile pruning: reverted to a full re-scan [70].
- iTowns oblique (view-angle) SSE weight: removed eight months later, wrong
  for tiles at high altitude [112].
- Cesium per-node min/max height (BVH) for terrain: removed, because it did
  not reduce tiles or speed loading [35].
- Cesium screen-space crack filling: replaced by skirts [39]; iTowns shrank
  skirts from 5000 m to one segment length for fill rate [111].
- tangram-es stencil proxy drawing: closed, same result as polygon offset [92].
- OpenLayers `renderMode: 'vector'` removed in 6.0, restored in 6.2;
  `'image'` deprecated in 6.6 [56].
- maplibre-rs port of the GL JS far-plane formula: replaced, it allowed
  pitch in one direction only [17].
- tangram-es LOD discard of labels: disabled, stale label meshes kept
  drawing [94].

## Guidance for a renderer in this repo

1. **Write the zoom range into `requirements` first** (whole world to
   street? one city at fixed scales?) and the camera (top-down, rotate,
   pitch, globe). Most requests here are top-down: then tiles and LOD go in
   `not_doing`, unless the data does not fit the size budget.
2. **Too much data, top-down:** bake a zoom ladder only at the levels where
   the data changes [50][51][84], keep the top level as verbatim as
   possible and simplify only the levels below it [55], choose the level in one function with a written
   rounding rule [49][73], and key decoded data by source tile [83]. Size
   the tile cache from the worst view's tile count, not a constant [103].
3. **Overzoom:** if the request zooms past the data, set the bake ceiling
   from the request, then clip to the view tile at deep levels [28][29];
   choose quantisation ranges and widths for the deepest overzoom [79][86];
   test any world-coordinate integer math at the deepest zoom.
4. **Fallback** only if tiles stream over the network: bounded parent
   search, no-overlap for translucent layers, prune by re-scan [70][107].
   Skip it for preloaded data.
5. **Pitch or globe:** per-tile zoom from distance in one replaceable
   function, a hard tile budget dropped by priority, culling independent of
   znear/zfar and padded by content height, SSE derived from the vertical
   FOV with a unit test [3][4][16][23]. Constrain the camera so the budget
   is never hit, and bench the worst view (maximum pitch) as a fixed view,
   since a camera path percentile hides it (references/pitfalls.md in the
   map-from-scratch skill).
6. **Measure** tiles selected, bytes and requests per view, and selection
   time per frame, and add a verification check that reads the screen for
   holes during a zoom path. Record in `performance_knowledge` which
   engine's rule you took.

## Sources

Local paths are under `ref-repos/` of the repo.

1. MapLibre GL JS, covering-tiles derivation: `ref-repos/maplibre__maplibre-gl-js/developer-guides/covering-tiles.md`
2. MapLibre GL JS, overzoom slicing default: `ref-repos/maplibre__maplibre-gl-js/CHANGELOG.md`; https://github.com/maplibre/maplibre-gl-js/pull/6521; https://github.com/maplibre/maplibre-gl-js/issues/7537
3. MapLibre GL JS, per-tile zoom from 3D distance: https://github.com/maplibre/maplibre-gl-js/pull/4779
4. MapLibre GL JS, culling padded by symbol height: https://github.com/maplibre/maplibre-gl-js/pull/8319
5. MapLibre GL JS, tile count ratio: https://github.com/maplibre/maplibre-gl-js/pull/5719
6. MapLibre GL JS, quadtree cover above 60 degrees: https://github.com/maplibre/maplibre-gl-js/commit/51d75fc7d; https://github.com/maplibre/maplibre-gl-js/commit/f57818709
7. MapLibre GL JS, geojson-vt re-slicing: https://github.com/maplibre/maplibre-gl-js/commit/11b610182; https://github.com/maplibre/maplibre-gl-js/commit/3f6b54cdc; https://github.com/maplibre/maplibre-gl-js/commit/09349fb23
8. MapLibre Native, globe and shared tile_lod: https://github.com/maplibre/maplibre-native/pull/4533
9. MapLibre Native, prefetch delta: https://github.com/maplibre/maplibre-native/commit/407fbc70b; https://github.com/maplibre/maplibre-native/commit/70362662f
10. MapLibre Native, pre-sorted tile masks: https://github.com/maplibre/maplibre-native/commit/b83030aa9bb1a8d9f14ae8160698c1ee4d5a4c72
11. MapLibre Native, quadtree tile cover: https://github.com/maplibre/maplibre-native/commit/d0c103fa8f0bade2be56d50a745f16b4e9ed6b29
12. MapLibre Native, max overscale of parent tiles: https://github.com/maplibre/maplibre-native/commit/15f73a06f2048d4b5f0481d54a79f3f349187b11
13. MapLibre Native, off-screen symbols of overscaled tiles: https://github.com/maplibre/maplibre-native/commit/a9d04d7b1ad1ac070f45a3367bec24e9cd4ef074
14. MapLibre Native, tile LOD controls and distance mode: https://github.com/maplibre/maplibre-native/commit/b11134a30; https://github.com/maplibre/maplibre-native/commit/7fe58506c; `ref-repos/maplibre__maplibre-native/src/mln/util/tile_cover.cpp`; `ref-repos/maplibre__maplibre-native/include/mln/map/map.hpp`
15. maplibre-rs, SourceShapes: https://github.com/maplibre/maplibre-rs/blob/main/maplibre/src/render/tile_view_pattern/mod.rs; `ref-repos/maplibre__maplibre-rs/maplibre/src/render/tile_view_pattern/pattern.rs`
16. maplibre-rs, znear and tile cap: https://github.com/maplibre/maplibre-rs/pull/134; https://github.com/maplibre/maplibre-rs/pull/147
17. maplibre-rs, far plane: https://github.com/maplibre/maplibre-rs/pull/233
18. maplibre-rs, parent/children stand-ins: https://github.com/maplibre/maplibre-rs/commit/2b917e9; https://github.com/maplibre/maplibre-rs/commit/67109d8; https://github.com/maplibre/maplibre-rs/commit/d8c2844
19. maplibre-rs, max_n_tiles: https://github.com/maplibre/maplibre-rs/commit/d69f81f; https://github.com/maplibre/maplibre-rs/commit/fa2c436
20. navara, memory management: https://github.com/maplibre/navara/blob/main/guide/MEMORY_MANAGEMENT.md
21. navara, tile and terrain traversal: https://github.com/maplibre/navara/blob/main/guide/TILE_TERRAIN_TRAVERSAL.md
22. navara, hillshade overscale: https://github.com/maplibre/navara/pull/612
23. navara, vertical FOV in SSE: https://github.com/maplibre/navara/commit/6c639148
24. RustGIS, Overture file selection: `ref-repos/opengeos__RustGIS/docs/user-guide/web-data.md#overture-maps`
25. RustGIS, zoom-gated reads: https://github.com/opengeos/RustGIS/commit/8083c40
26. RustGIS, paced drawing with stand-ins: https://github.com/opengeos/RustGIS/commit/e6ed0d1
27. RustGIS, children over stand-in parent: https://github.com/opengeos/RustGIS/commit/3bc73bb
28. reearth-papers, overzoom from ancestor: https://github.com/reearth/reearth-papers/commit/f7247a3; https://github.com/reearth/reearth-papers/commit/f313da5; https://github.com/reearth/reearth-papers/commit/8abd9e7
29. reearth-papers, clipping deep tiles: https://github.com/reearth/reearth-papers/commit/9c87421; https://github.com/reearth/reearth-papers/commit/4e9fcb0; https://github.com/reearth/reearth-papers/commit/50a7e17
30. reearth-papers, 404 for empty tiles: https://github.com/reearth/reearth-papers/commit/f90ac2c; https://github.com/reearth/reearth-papers/commit/454592a
31. Cesium, OBB culling: `ref-repos/CesiumGS__cesium/CHANGES.md`; http://cesiumjs.org/2015/06/24/Oriented-Bounding-Boxes/
32. Cesium, fog as culling: https://github.com/CesiumGS/cesium/pull/3154; https://github.com/CesiumGS/cesium/pull/10186; https://github.com/CesiumGS/cesium/pull/12248
33. Cesium, foveated request priority: https://github.com/CesiumGS/cesium/pull/7774
34. Cesium, skip LOD: https://github.com/CesiumGS/cesium/pull/5128; https://github.com/CesiumGS/cesium/pull/5851
35. Cesium, fill tiles and removed BVH: https://github.com/CesiumGS/cesium/pull/7061
36. Cesium, 3D Tiles bounding volumes: https://github.com/CesiumGS/cesium/pull/3325
37. Cesium, load only rendered tiles: https://github.com/CesiumGS/cesium/commit/6b67a37b4
38. Cesium, UPSAMPLED_ONLY: https://github.com/CesiumGS/cesium/commit/a6274298a
39. Cesium, skirts: https://github.com/CesiumGS/cesium/commit/b7d1b5a64; https://github.com/CesiumGS/cesium/commit/fa2200e3b; https://github.com/CesiumGS/cesium/commit/89bd3df10
40. Cesium, bake vector data for rendered tiles: https://github.com/CesiumGS/cesium/commit/f4b2dca93115711270aef2a8b4bf3fa024fc71e1; https://github.com/CesiumGS/cesium/commit/333d43848676b77f0d42f052647564af7f5e2d48; https://github.com/CesiumGS/cesium/commit/1bcefa194c5f047bbf43ada6201094af8948d29a
41. Cesium, cache bytes and memory-adjusted SSE: https://github.com/CesiumGS/cesium/commit/0fa7440b0463e4b87ebca23d93b4b60a27d1b30e; https://github.com/CesiumGS/cesium/commit/a8ddd9749cd7e5a79c4a9c42d7e329ffab060faf; https://github.com/CesiumGS/cesium/commit/5de34c26a5b880ccf5d289d40bf90d2c608ee0c5; https://github.com/CesiumGS/cesium/commit/0bf03df1fb74caa0353f093fda38b8d399311f13
42. deck.gl, TileLayer roadmap: https://github.com/visgl/deck.gl/blob/master/dev-docs/roadmaps/tile-layer-roadmap.md; https://github.com/visgl/deck.gl/blob/master/docs/whats-new.md; `ref-repos/visgl__deck.gl/dev-docs/roadmaps/tile-layer-roadmap.md`
43. deck.gl, empty children in 3D Tiles traversal: https://github.com/visgl/deck.gl/issues/7955
44. deck.gl, refinement strategies: https://github.com/visgl/deck.gl/commit/a976ef5d; https://github.com/visgl/deck.gl/commit/b5d45751; https://github.com/visgl/deck.gl/commit/05ca54e0
45. deck.gl, frustum-culled quadtree: https://github.com/visgl/deck.gl/commit/79e65643; https://github.com/visgl/deck.gl/commit/e66228af
46. deck.gl, globe OBBs: https://github.com/visgl/deck.gl/commit/70524804; https://github.com/visgl/deck.gl/commit/5c748fc6
47. ortho-earth, coarse first: https://github.com/kenjiyoshidahome2026-bit/ortho-earth/commit/2761c981; https://github.com/kenjiyoshidahome2026-bit/ortho-earth/commit/d265b75d
48. ortho-earth, memoised selection: https://github.com/kenjiyoshidahome2026-bit/ortho-earth/commit/7015576b
49. QGIS, vector tile zoom: `ref-repos/qgis__QGIS/ChangeLog` (2020-09-14 and 2023-04-21 entries)
50. Marble, vector tile service setup (odd levels, static and on-demand split): `ref-repos/KDE__marble/tools/vectorosm-tilecreator/setup/README.md`; https://invent.kde.org/education/marble/-/blob/master/tools/vectorosm-tilecreator/setup/README.md
51. Marble, vector OSM map theme (tileLevels): `ref-repos/KDE__marble/data/maps/earth/vectorosm/vectorosm.dgml`
52. Marble, Natural Earth per level: `ref-repos/KDE__marble/tools/natural-earth-vector-tiling/level_info.txt`; https://invent.kde.org/education/marble/-/blob/master/tools/natural-earth-vector-tiling/level_info.txt
53. Marble, tile count target: https://github.com/KDE/marble/commit/6acd62b8a; https://github.com/KDE/marble/commit/0621ff528; https://github.com/KDE/marble/commit/a6f946ed2
54. Marble, metatile input blocks: https://github.com/KDE/marble/commit/3aafd0e21
55. Marble, top level unsimplified: https://github.com/KDE/marble/commit/15c862bbf
56. OpenLayers, render modes: `ref-repos/openlayers__openlayers/changelog/upgrade-notes.md`; `ref-repos/openlayers__openlayers/changelog/v3.16.0.md`; `ref-repos/openlayers__openlayers/changelog/v6.2.0.md`; `ref-repos/openlayers__openlayers/changelog/v6.6.0.md`; https://github.com/openlayers/openlayers/pull/10309; https://github.com/openlayers/openlayers/pull/11990
57. OpenLayers, interim tiles: `ref-repos/openlayers__openlayers/changelog/v3.19.0.md`; `ref-repos/openlayers__openlayers/changelog/v4.4.0.md`; `ref-repos/openlayers__openlayers/changelog/v10.10.0.md`; https://github.com/openlayers/openlayers/pull/9286
58. OpenLayers, single cached vector image: https://github.com/openlayers/openlayers/pull/799; https://github.com/openlayers/openlayers/issues/764
59. OpenLayers, uncovered remainders: https://github.com/openlayers/openlayers/commit/4651b26cc; https://github.com/openlayers/openlayers/commit/ee7a1a60a
60. OpenLayers 2, resize transition: https://github.com/openlayers/ol2/blob/master/notes/2.13.md; https://github.com/openlayers/ol2/blob/master/lib/OpenLayers/Layer/Grid.js
61. OpenLayers 2, continuous zoom: https://github.com/openlayers/ol2/blob/master/notes/2.12.md
62. OpenLayers 2, pixel positioning: https://github.com/openlayers/ol2/pull/517
63. OpenLayers 2, backbuffer behind base layer: https://github.com/openlayers/ol2/pull/883
64. Leaflet, fractional zoom docs: `ref-repos/Leaflet__Leaflet/docs/examples/zoom-levels/index.md`; `ref-repos/Leaflet__Leaflet/CHANGELOG.md`
65. Leaflet, overzoom in 0.7: `ref-repos/Leaflet__Leaflet/docs/_posts/2013-11-18-leaflet-0-7-released-plans-for-future.md`; https://github.com/Leaflet/Leaflet/pull/7094
66. Leaflet, updateWhenZooming: https://github.com/Leaflet/Leaflet/pull/4462; `ref-repos/Leaflet__Leaflet/docs/reference.html`
67. Leaflet, Animations 2.0: https://github.com/Leaflet/Leaflet/pull/2382
68. Leaflet, maxNativeZoom issue: https://github.com/Leaflet/Leaflet/issues/1934
69. Leaflet, zoomSnap/zoomDelta: https://github.com/Leaflet/Leaflet/pull/3523; https://github.com/Leaflet/Leaflet/pull/1941
70. Leaflet, tile pruning history: https://github.com/Leaflet/Leaflet/commit/fbe23087; https://github.com/Leaflet/Leaflet/commit/44f16b2d; https://github.com/Leaflet/Leaflet/commit/68f86d85; https://github.com/Leaflet/Leaflet/commit/bb19fc1b; https://github.com/Leaflet/Leaflet/commit/fc70a218; https://github.com/Leaflet/Leaflet/commit/4d119c9c; https://github.com/Leaflet/Leaflet/commit/39d7388a; https://github.com/Leaflet/Leaflet/commit/1318b999; https://github.com/Leaflet/Leaflet/commit/22cfd129
71. Leaflet, background layer during rapid zoom: https://github.com/Leaflet/Leaflet/commit/b03f3221; https://github.com/Leaflet/Leaflet/commit/e54bc27a
72. Leaflet, range check before clamp: https://github.com/Leaflet/Leaflet/commit/0fd2f43f
73. Leaflet, integer {z}: https://github.com/Leaflet/Leaflet/commit/511f8f11; https://github.com/Leaflet/Leaflet/commit/199eae85
74. protomaps-leaflet, levelDiff: https://github.com/protomaps/protomaps-leaflet/issues/121; https://github.com/protomaps/protomaps-leaflet/issues/112; `ref-repos/protomaps__protomaps-leaflet/src/view.ts`
75. protomaps-leaflet, label repetition: `ref-repos/protomaps__protomaps-leaflet/src/symbolizer.ts`; https://github.com/protomaps/protomaps-leaflet/commit/ddf63f0
76. Tangram, stencil for translucent proxies: https://github.com/tangrams/tangram/blob/master/src/scene/scene.js; `ref-repos/tangrams__tangram/src/scene/scene.js`; https://github.com/tangrams/tangram/blob/master/src/styles/points/points.js; https://github.com/tangrams/tangram/blob/master/src/styles/style.js
77. Tangram, zoom_offset: https://github.com/tangrams/tangram/pull/685
78. Tangram, move_into_tile: https://github.com/tangrams/tangram/issues/602
79. Tangram, 16-bit line width: https://github.com/tangrams/tangram/issues/267
80. Tangram, proxy tile depth: https://github.com/tangrams/tangram/commit/a5add9c0; https://github.com/tangrams/tangram/commit/464fd323; https://github.com/tangrams/tangram/commit/da4dc328; https://github.com/tangrams/tangram/commit/b9afe9d1; https://github.com/tangrams/tangram/commit/97401dd0
81. Tangram, width in style-zoom units: https://github.com/tangrams/tangram/commit/0f800cea; https://github.com/tangrams/tangram/commit/b2888a92
82. Tangram, floor and max zoom 18: https://github.com/tangrams/tangram/commit/b015b72f; https://github.com/tangrams/tangram/commit/0b55a8ab; https://github.com/tangrams/tangram/commit/d08436e2
83. Tangram, reuse source tile data: https://github.com/tangrams/tangram/commit/50f587b2; https://github.com/tangrams/tangram/commit/9b7464b8; https://github.com/tangrams/tangram/commit/6babc9c3
84. Tangram, zooms list: https://github.com/tangrams/tangram/commit/0751dc57
85. Tangram, proxy stencil masks: https://github.com/tangrams/tangram/commit/b82881dc; https://github.com/tangrams/tangram/commit/717f00bb; https://github.com/tangrams/tangram/commit/45467d1b; https://github.com/tangrams/tangram/commit/06d9c525
86. tangram-es, overzoom scale in the vertex shader: `ref-repos/tangrams__tangram-es/core/src/style/polylineStyle.cpp`
87. tangram-es, proxy tiles: `ref-repos/tangrams__tangram-es/core/src/tile/tileManager.h`; `ref-repos/tangrams__tangram-es/core/src/labels/labelManager.h`
88. tangram-es, view trapezoid cover: `ref-repos/tangrams__tangram-es/core/src/view/view.cpp`
89. tangram-es, per-source visible sets: https://github.com/tangrams/tangram-es/pull/1498
90. tangram-es, on-device GeoJSON tiling: https://github.com/tangrams/tangram-es/pull/267
91. tangram-es, display zoom range: https://github.com/tangrams/tangram-es/pull/944
92. tangram-es, stencil proxies abandoned: https://github.com/tangrams/tangram-es/pull/458; https://github.com/tangrams/tangram-es/issues/411
93. tangram-es, 512 px tile_size: https://github.com/tangrams/tangram-es/issues/1435
94. tangram-es, label LOD discard disabled: https://github.com/tangrams/tangram-es/commit/615e5714; https://github.com/tangrams/tangram-es/commit/3e5a40fb
95. tangram-es, collider grid cap: https://github.com/tangrams/tangram-es/commit/ea032da9
96. tangram-es, polyline texture_scale: https://github.com/tangrams/tangram-es/commit/eff88f37
97. tangram-es, zoom_offset: https://github.com/tangrams/tangram-es/commit/1b664f09; https://github.com/tangrams/tangram-es/commit/a01f510e
98. harp.gl, fallback: `ref-repos/heremaps__harp.gl/docs/@docs/fallback/README.md`
99. harp.gl, transparent sources and ground planes: https://github.com/heremaps/harp.gl/commit/0ea1a7ae; https://github.com/heremaps/harp.gl/commit/0f8617bf
100. harp.gl, skip background under covering tiles: https://github.com/heremaps/harp.gl/commit/3b0c463a
101. harp.gl, mixed LOD: https://github.com/heremaps/harp.gl/commit/de9632e7; https://github.com/heremaps/harp.gl/commit/8e7b9928; https://github.com/heremaps/harp.gl/commit/6cb460c2
102. harp.gl, label dedup across LODs: `ref-repos/heremaps__harp.gl/docs/@docs/label-rendering/README.md`; https://github.com/heremaps/harp.gl/commit/be433dce; https://github.com/heremaps/harp.gl/commit/a43d585c; https://github.com/heremaps/harp.gl/commit/0c946e13
103. maptalks.js, tile cache on large screens: https://github.com/maptalks/maptalks.js/issues/1419
104. modestmaps-js, parent/child fallback: `ref-repos/stamen__modestmaps-js/src/layer.js`; `ref-repos/stamen__modestmaps-js/CHANGELOG`; https://github.com/stamen/modestmaps-js/commit/1b3a646; https://github.com/stamen/modestmaps-js/commit/fa1c2ef
105. modestmaps-js, tileLimits vs coordLimits: https://github.com/stamen/modestmaps-js/issues/88; https://github.com/stamen/modestmaps-js/commit/34db798
106. polymaps, triangle scanline: https://github.com/simplegeo/polymaps/commit/56102e8; https://github.com/simplegeo/polymaps/commit/1435062; https://github.com/simplegeo/polymaps/commit/c8ebe58; `ref-repos/simplegeo__polymaps/src/Layer.js`
107. polymaps, proxy tiles: `ref-repos/simplegeo__polymaps/src/Layer.js`; https://github.com/simplegeo/polymaps/commit/462d243
108. polymaps, recycled level groups: https://github.com/simplegeo/polymaps/commit/e14c4d2
109. iTowns, pole subdivision cap: https://github.com/iTowns/itowns/commit/53a9f6f
110. iTowns, shared tile geometry: https://github.com/iTowns/itowns/pull/586
111. iTowns, skirt height: https://github.com/iTowns/itowns/commit/c36b3bed; https://github.com/iTowns/itowns/commit/6c38cb22; https://github.com/iTowns/itowns/commit/ba0f03fc
112. iTowns, oblique SSE weight: https://github.com/iTowns/itowns/commit/9044af75; https://github.com/iTowns/itowns/commit/7a85dc2e
113. iTowns, SSE distance to bounding volume: https://github.com/iTowns/itowns/commit/e8ce7b7d
114. iTowns, parent hidden when children ready: https://github.com/iTowns/itowns/commit/654bc949; https://github.com/iTowns/itowns/commit/d1d63d49
115. iTowns, horizon culling point: https://github.com/iTowns/itowns/commit/0692c059; https://github.com/iTowns/itowns/commit/2073699a; https://github.com/iTowns/itowns/commit/a96a63af
116. iTowns, unified SSE formula: https://github.com/iTowns/itowns/commit/958f1242; https://github.com/iTowns/itowns/commit/b1740ed4; https://github.com/iTowns/itowns/commit/7a021365
