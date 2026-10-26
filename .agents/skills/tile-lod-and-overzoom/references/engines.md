# Tile LOD and overzoom, engine by engine

Detail behind ../SKILL.md. Numbers in brackets refer to the Sources list in
../SKILL.md. Read the section of the engine whose approach you are about to
copy or reject; quote the source in `performance_knowledge` or a code comment.

## MapLibre GL JS

- Covering tiles under pitch: tile scale S = S_c cos^(b/2+1)(theta)/cos(theta_c).
  b=1 (default) gives tiles of about equal screen area, b=0 equal width
  (pitch-0 behaviour), b=2 equal height, b=-1 one zoom for all tiles, which
  then switch at once. `maxZoomLevelsOnScreen` and `tileCountMaxMinRatio`
  set b and the centre zoom through a closed-form integral that needs a
  hypergeometric function [1].
- Per-tile zoom from 3D distance (PR 4779): desired zoom is the centre zoom
  scaled by camera-to-centre over camera-to-tile distance. Mercator keeps the
  old behaviour without terrain and below 60 degrees; globe always uses the
  new one. Reviewers rejected a `pitchTileLoadingBehavior` enum and a
  `tileZoomDeadband` ("two confusing parameters are worse than one"); users
  override with a tile-zoom function. Render tests changed in the affected
  cases. Fixes #3983 and #4940 [3].
- `setSourceTileLodParams(maxZoomLevelsOnScreen, tileCountMaxMinRatio)`
  (PR 5719): zoom decays toward the horizon, and if the count would exceed
  ratio x the flat-view count, zoom is lowered uniformly. The author
  preferred a decay-rate parameter; a user asked for one less/more slider and
  LOD bands perpendicular to the view. Radius-based bands load lower
  resolution at screen edges; the 0.85*tan horizon heuristic was questioned
  as physically backwards [5].
- Earlier quadtree cover (commits 51d75fc7d, f57818709): descent against the
  frustum with Aabb/Frustum primitives; above 60 degrees, far tiles stop
  splitting, about 3 max-level tiles stay around the centre, results sorted
  by distance. Below 60 degrees unchanged [6].
- Culling with content height (PR 8319): bounding-volume elevation, the
  horizon plane and the horizon-fitted far plane all assumed content on the
  ground. Buckets now record the largest evaluated symbol height offset, kept
  as a per-source high-water mark that never shrinks, and the cover pads all
  three steps by it. On the #8253 scene the symbol vanished at pitch 94 on
  main and stayed to pitch 100 with the change. A style-level max height
  hint was deferred [4].
- Overzoom slicing: 5.12.0 added `experimentalZoomLevelsToOverscale`
  (re-slicing past source maxzoom with geojson-vt into a bounded LRU,
  default only on Safari); 6.0 made `zoomLevelsToOverscale` default 4.
  Changelog: better high-zoom performance, "can prevent Safari crashes ...
  setting it to 4 or less". Costs: changed `queryRenderedFeatures` results
  and polygon centre labels, cache-key and MLT re-encoding bugs ("Block
  overruns tile", #7707) [2][7].

## MapLibre Native

- Quadtree tile cover (d0c103fa): depth-first with frustum/AABB tests; split
  only within `radiusOfMaxLvlLodInTiles`(=3) + 2^(maxZoom-z) - 2 of the
  centre. About 280 lines of bounding-volume code; a precise intersection
  test removes the under-1% false positives of the coarse test [11].
- Tile LOD controls (#2958) and distance mode (#4057): `TileLodMinRadius`,
  `TileLodScale`, `TileLodZoomShift` above a pitch threshold; a zoom shift of
  -1 cuts tiles by a factor of 4 with reduced quality. Distance mode splits
  when distance(camera, AABB)*2^z < cos(pitchToTile)^0.5 *
  cameraToCenterDistance/scale and ignores MinRadius and ZoomShift. Pitch
  exponent comment: 0 constant screen width, 0.5 constant area, 1 constant
  height. Render tests under `tile-lod/` [14].
- Globe (PR 4533): a ProjectionData uniform per drawable on all four
  backends, pixel-identical to main in flat mode; the GL JS tile zoom
  function moved to `util/tile_lod.hpp` to be shared with terrain. Hand-over
  to Mercator at z11-12. A bounded source blinked to background around
  z5.93-6.0 because the cover asked for next-zoom tiles and bounds were
  checked at the nominal zoom; fixed by checking at the tile's own zoom. One
  test failed only on Android because pow(2, log2(x)) is not exact in Bionic
  libm. The PR is 30k lines, 17.5k of them render-test fixtures [8].
- Prefetch (407fbc70b, 70362662f): also request tiles at zoom -
  `PrefetchZoomDelta` (default 4, clamped to source minzoom), initially only
  for raster until #7026; loaded parents in the cache serve as fallbacks [9].
- `setMaxOverscaleFactorForParentTiles`: per-source cap on how many levels
  up a parent may serve as placeholder; default unlimited. The header warns
  of side effects "especially for raster tiles that are overscaled multiple
  times" [12].
- Off-screen symbols of overscaled tiles are filtered before cross-tile
  indexing and placement; no numbers given [13].
- Tile mask and clip-id generators stopped sorting because the pyramid
  already delivers sorted tiles: TileMaskGeneration benchmark 33x faster [10].

## maplibre-rs

- SourceShapes per view tile: Parent, Children (four), Itself/Exact, None;
  drawn masked by the target's stencil. FIXMEs: on a very slow network a z18
  pattern drawn when zoomed out can grow "dramatically", the same parent is
  found many times, and too-small buffer pools make layers load and unload
  back and forth (VERTEX_SIZE/INDICES_SIZE 10,000,000;
  DEFAULT_TILE_VIEW_PATTERN_SIZE 32*4) [15][18].
- Hard cap: `.take(max_n_tiles)` (32) with a panic if the tile-view buffer
  overflows; pitch brought in unbounded tiles and overran a fixed GPU
  buffer. Later pitch was limited, zoom picked from tile resolution, and PR
  #340 reserved the budget for visible tiles first [16][19].
- znear: a PR lowering znear to 1 was not merged; the maintainer: "The
  actual problem was not the clipping on the GPU, but clipping in the logic
  of tile loading" [16].
- Far plane (PR 233): a port of the GL JS formula allowed pitch one way only
  (90 not 180 degrees) and no yaw with pitch; a new derivation replaced it,
  described as "way faster to calculate" [17].

## navara

- SSE uses the true vertical FOV (6c639148): the old path overestimated
  on-screen error by the aspect ratio on landscape screens. Defaults halved
  (globe 4 to 2, 3D Tiles 16 to 8); the vector-tile `maxSse` stayed 2.0
  after a first patch halving it was reverted, halving MVT fetch density
  [23].
- Web Mercator geometric error scaled by the cosine of the equatorward
  latitude; polar caps use the unextended extent, because bounds reaching
  the pole refined the top row to max zoom [21].
- Terrain upsampling bounded to `MAX_UPSAMPLE_DEPTH = 2`: a z12 clip under a
  z17 parent reads as floating or sunk terrain [21].
- Hillshade past source max zoom reuses the parent's normal map through a UV
  transform; a marker component forces the material update to run so the UV
  is set even when the data did not change (issue 587) [22].
- Memory-pressure SSE multiplier decays x0.98 per frame only after a
  cooldown that starts at about 5 s (300 frames) and doubles on each
  decay-then-raise round trip up to about 60 s (3600 frames); published
  pressure is quantised to 0.25 [20].

## RustGIS

- Stand-in pictures during motion (e6ed0d1): same square at another
  resolution, a zoom up to two levels away, the parent or four children;
  only uncovered squares are drawn, nearest the middle first, about a frame
  at a time. Liberty over Manhattan, headed Chrome: panning worst frame
  650-1010 ms to 110-270 ms; zoom in 540-790 to 60-120 ms; zoom out 630-990
  to 80-390 ms. The old cache keyed pictures by exact resolution and zoom to
  1/256 of a level, so every motion frame missed [26].
- Raster tiles as GPU quads in map units; a missing tile uses its cached
  ancestor and cached children draw over it, because zooming in usually has
  the destination tiles cached but not those passed through (#568) [27].
- Streamed layers are read only when visible and in their zoom range,
  with the renderer's test (issue #412) [25].
- Overture GeoParquet: files chosen from STAC extents; a view needing more
  than six files is refused, and world views use the theme's PMTiles
  instead [24].

## reearth-papers

- Rasters advertised to z22 while vector data stops at z15; each deep tile
  binds its z15 ancestor with `sourceZoom` and renders fresh. Declaring
  sourceZoom 15 for a z14 render throws ("overzoom only reprojects
  downwards"). Neighbour fetches deduplicated after mapping to ancestors (a
  z18 tile fetched the same MVT nine times). Geometry is scaled up to 128x
  at z22; 4x render cost per level, bounded by on-demand rendering and
  permanent caching [28].
- Clipping before stroking: pencil-sketch z20 14.1 s/266 MB to 4.2 s/76 MB,
  z22 from failing to 8.0 s/231 MB; sumi flat at about 28 MB z19-z22; a z22
  pencil tile took 30-50 s before. World-anchored noise floored into
  `isize` overflowed on wasm32 [29].
- 404 instead of 204 or transparent images for empty tiles, with a cache
  version bump to orphan the transparent tiles already cached [30].

## Cesium

- Oriented bounding boxes for terrain and imagery: tile loading reduced by
  up to 50% depending on view (1.11) [31].
- Horizon fog culls: up to 35% terrain performance (#3154); `Fog.renderable`
  keeps culling without the look (#10186); default density 0.0002 to 0.0006
  and `visualDensityScalar` (#12248) [32].
- Foveated, motion-aware requests (#7774): about 67% less tour load time
  and 44% fewer tour loads; general movement about 20% less time and 27%
  fewer loads. Many tuning options [33].
- Skip LOD for 3D Tiles (#5128, #5851): often 50% less data downloaded;
  cloning render states per frame cost about 25% CPU, derived commands cut
  it to 0.25-3%. Back faces of single-sided parents showed during refinement
  [34].
- Fill tiles (#7061): meshes from neighbour edges let selection skip levels
  and siblings. Static horizontal 10.53 s to 8.82 s, 824 to 578 requests;
  top-down 5.98 to 3.64 s, 434 to 205; pan 16.41 to 12.10 s, 1448 to 837. The
  tile under the camera must still load for clamping. The same PR removed
  server BVH (min/max height) support: "It doesn't reduce the number of
  tiles or speed up loading" [35].
- 3D Tiles bounding volumes: box, sphere, region; region distance is
  computed precisely to avoid refining too soon, visibility uses a
  conservative OBB [36].
- Load only tiles chosen for rendering, not children of every visited tile
  [37]. Do not refine into children that would only be upsampled: Half Dome
  243 to 219 tiles [38].
- Skirts replaced screen-space crack filling; extra vertices once broke the
  16-bit index limit [39].
- Vector data baked only for rendered tiles and selected LOD, re-baked by
  dirty rectangles; `makeClean` was never called, so tiles re-baked every
  frame until 1bcefa194 [40].
- `cacheBytes` plus `maximumCacheOverflowBytes` (at least 10 MB) replaced
  `maximumMemoryUsage`; memory-adjusted SSE grows each frame over budget
  (factor 1.01 then 1.02), relaxes below 75% [41].

## deck.gl

- TileLayer roadmap: "not a full basemap replacement"; missing were a
  byte-bounded cache, request cancellation, centre-out order and parents
  shown until children load. Later: AbortSignal, `maxCacheByteSize`,
  `refinementStrategy`, custom Tileset2D, centre-first (9.4) [42].
- Refinement strategies: best-available (default), `no-overlap` (needed with
  opacity < 1), `never`, or a custom function over the whole cache; later
  parents processed first, walking up ancestors before children to reduce
  flashing [44].
- Frustum-culled quadtree (79e65643): up to 3 world copies, `TILE_SIZE=512`,
  maxPitch 89 in the example; later culls by `extent` and loads nothing
  below minZoom without an extent [45].
- Globe OBBs from 4 corners + centre, plus 4 edge midpoints when z < 2, at
  min and max elevation (up to 18 points) instead of a sphere through 3
  points [46].
- Google 3D Tiles blurrier than Cesium (#7955): blank child entries; fixed
  in loaders.gl 3.4.11; interim `filterSubLayer` by lodZoom = 22 -
  log2(lodMetricValue) [43].

## ortho-earth (GPL-3.0-or-later, same licence as this repo)

- Startup: lakes and below-sea land read only in the visible band, admin0
  50m then 10m via setData at z7-9; world layers 3.5 MB to 0.65 MB, JS 341
  to 278 KB gzip [47].
- `selectLOD` walks only samples inside the parent, no per-tile allocation,
  memoised on camera/screen: 4.9 to 2.1 ms per tilted update, same output on
  400 random cameras [48].

## QGIS

- Floor, not round, for rule visibility; `@vector_tile_zoom` keeps the
  fraction; Mapbox maxzoom converted by subtracting 1 since QGIS hides at
  > maxzoom and the spec at >= maxzoom [49].

## Marble (KDE)

- Vector OSM tiles only at z1,3,...,17 as o5m, theme `tileLevels` listing
  them; each tile serves two zoom steps [50][51].
- z1-9 pre-generated from Natural Earth (1.2 GB, 265k files, 60-90 min on
  one core, about 6 GB RAM peak); z11-17 on demand as 8x8 metatiles. Only
  about 2.5% of z17 tiles are ever loaded; 44k distinct tiles in two weeks
  of mid 2020 [50].
- Natural Earth 110m at z0-1, 50m at z3-5, 10m at z7-9, feature classes
  added per level [52].
- Tile level from a target of about 20 tiles on screen (12 on mobile),
  using the average physical screen size [53].
- Metatile input loaded at max(11, z-3) capped at z, in power-of-two blocks
  traversed in a fixed order so each block loads once [54].
- NodeReducer only on levels that need it; z17 near verbatim [55].

## OpenLayers and OpenLayers 2

- Vector tile `renderMode`: hybrid default; 'vector' removed in 6.0 and
  restored in 6.2 for sparse sources; 'image' deprecated in 6.6. Image-mode
  declutter cut labels at tile edges [56].
- Interim tiles: keep tiles on `setUrl` (3.16), align lower-resolution fill
  (3.19), opacity transitions disabled when an interim tile is available
  (4.4, #9286), draw only lower-zoom remainders (10.10) [57][59].
- Remainders are axis-aligned rectangle differences (`subtractExtents`),
  replacing per-tile clip paths and even-odd donut clips (PR #17543) [59].
- Client vector rendering (PR 799): one cached image at the settled
  resolution; dynamic grid resolutions were "slow and confusing" [58].
- OL2: `transitionEffect: 'resize'` default stretches old tiles; doc warns
  of artefacts on non-opaque layers; zoomTo became asynchronous [60]; the
  backbuffer was moved behind the base layer so translucent overlays do not
  double-draw [63]. Continuous zoom by finer tiles stretched (2.12) and
  fractional zoom for analog wheels (2.13) [61]. Pixel positioning fixed
  white lines between tiles (#458) but was held out of an RC for risk [62].

## Leaflet

- `zoomSnap` default 1; tiles from the integer level, scaled; 2.0 builds
  URLs with integer `{z}` [64]. `zoomSnap`/`zoomDelta` won over a
  `zoomTune` PR; floating-point errors in `_pxBoundsToTileRange` at very
  small zoomSnap [69].
- Overzoom: 0.7 `maxNativeZoom` [65][68]; edge cases #7094 (flicker when
  maxNativeZoom === maxZoom), #2725, #3004, #7328 [65]; fix by testing
  min/maxZoom before clamping [72]. Early on, the background layer was kept
  during quick successive zooms so the map did not go blank [71].
- `updateWhenZooming` (default true) loads at each integer level crossed;
  false waits for the end of the animation [66].
- Animations 2.0 (PR 2382): pyramid of levels during animation; merge held
  until pruning accounted for fade-in [67].
- Pruning history: always prune in `_addTiles` or tiles strand; incremental
  pruning (2015-01-29) reverted five days later; pruning paused during
  animated zoom; 2016 back to pruning on every tileready; 2017 marks current
  tiles active (#5381). Retain parents to z-5, children to z+2 [70].
- `_clampZoom` with `Math.round` (#8613), and the same rounding in
  `redraw` (#9930, 2026-10-26) [73].

## protomaps-leaflet

- `levelDiff` 2 then fixed at 1 in 2.0 to match MapLibre; about 4x data per
  viewport [74].
- Line labels repeat every 250 px by default, with the same distance for
  deduplication; x2^(overzoom-4) beyond 4 levels [75].

## Tangram (JS)

- Proxy tiles behind real ones with depth in the w of the origin uniform;
  ancestor depth capped, overzoomed tiles not counted; styles skipped once
  finished [80]. Stencil masks per proxy level for translucent blending;
  points and text unmasked (cut-out / x-ray effect); proxy choice independent
  of scroll direction [76][85].
- `zoom_offset` (#685): Walkabout 1300x650 baseline 6 tiles/1.6 MB, offset
  1 2 tiles/488 KB, 256 to 512 stretch 6 tiles/407 KB; Washington 8/3.5 MB,
  4/2.0 MB, 8/1.0 MB [77].
- Per-tile collision forced labels into the tile (`move_into_tile`), which
  misplaced country names with buffered OpenMapTiles-schema tiles (#602)
  [78].
- 16-bit line widths (#267, fixed in #310) and width in style-zoom units
  [79][81].
- Floor for base zoom; max data zoom 18 because Mapzen tiles add no detail
  past it [82]. Data copied from an already loaded source tile, worker
  chosen after coordinate normalisation, same source only [83]. `zooms`
  list per source [84].

## tangram-es

- Overzoom scale 2^(s-z) applied in the vertex shader to keep precision in
  packed attributes [86].
- Proxy tiles added per newly visible tile and removed when it loads; label
  transitions skipped between tile and proxy [87].
- Cover by rasterising the view trapezoid plus an extra triangle for tall
  geometry; minimum zoom from z = log2(view diameter px / tile size px + 2)
  to avoid antimeridian half-tiles [88].
- Per-source visible sets for scaled tiles instead of enlarging TileID
  (#1435) [89].
- Client GeoJSON tiled on device with geojson-vt-cpp; optimisations
  deferred; API unsafe before GL init [90].
- `min_display_zoom`/`max_display_zoom`: named "display" because data is
  not underzoomed [91].
- Stencil proxy drawing (PR 458) closed: same result as polygon offset;
  #411 (buildings from both proxy and real tile) remained [92].
- `tile_size` power of 2, >= 256, unit-free so JS and ES agree ("1 px" meant
  pixels in JS but meters in ES); 0.7.0 [93].
- LOD discard of labels disabled: skipped updates still drew stale meshes
  [94]. Collider grid splits capped (#2307) [95]. Polyline `texture_scale`
  reduced for 5 overzoomed levels (#2261) [96]. `zoom_offset` for dependent
  terrain rasters [97].

## harp.gl

- Fallback to cached ancestors (zoom in) or descendants (zoom out) with
  `quadTreeSearchDistanceUp/Down`; `levelOffset` shifts flat objects below an
  opaque ground plane (renderOrder -10000); buildings use a depth prepass;
  deep downward search can stutter the frame rate [98].
- `allowOverlappingTiles=false` for transparent sources; ground planes
  removed from GeoJSON sources because they hid fallback tiles [99].
- `isFullyCovering`/`skipRendering` skip the background under opaque
  full-coverage tiles [100].
- Mixed LOD with all-children-or-none, default off; cracks fixed by edge
  subdivision (+838 lines); `maxVisibleDataSourceTiles` back to 100 [101].
- Labels deduplicated across LODs by feature id, else by text within a
  tolerance [102].

## maptalks.js, modestmaps-js, polymaps

- maptalks: default cache 256 tiles lost visible tiles on a 3964x2160
  pitched map from v0.47.0; fix was 1024 and larger tiles [103].
- modestmaps: nearest cached ancestor, else four children;
  `enablePyramidLoading` off by default; child display briefly removed and
  reinstated (0.14.0, 0.14.1) [104]. `tileLimits` (data that exists) vs
  `coordLimits` (where the camera may go), compared at the same zoom (#114
  fix) [105].
- polymaps: triangle scanline over the rotated viewport [106]; proxies 2
  finer / 4 coarser, ref-counted, SVG groups for -4..+2 drawn -4,-3,-2,-1,
  +2,+1,0 [107]; level groups relabelled on integer zoom change instead of
  moving tiles (less flicker) [108].

## iTowns

- No subdivision of level-5 pole rows (0 and 31) in EPSG:4326 [109].
- One shared tile geometry oriented by the centre normal: TileProvider time
  and TileGeometry memory both divided by 3; bounding spheres grew and
  subdivision counts changed [110].
- Skirt height: 5000 m, then 50^(1+1.25/zoom), then 5*((20-level)+10), then
  one segment length; exact per-edge delta judged too heavy at run time
  [111].
- Oblique SSE weight added then removed: wrong for tiles at high altitude
  [112]. SSE distance to the bounding volume, not its centre (#185) [113].
- Parent hidden only when four children are ready; subdivision blocked
  while textures are missing [114].
- Horizon culling with one point per tile, the centre scaled by
  1/cos(alpha/2); replaced 8 then 4 OBB corners updated every frame [115].
- One `preSSE` in Camera shared by globe and 3D Tiles; fixed mountains
  losing detail when zooming in; thresholds retuned later [116].
