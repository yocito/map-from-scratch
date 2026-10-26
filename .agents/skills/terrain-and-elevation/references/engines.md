# Terrain and elevation, engine by engine

Longer detail behind ../SKILL.md. Numbers in brackets refer to the Sources
list at the end of ../SKILL.md.

## MapLibre GL JS

- DEM border: the worker copies edge pixels into a 1 px border, then
  `TileManager._backfillDEM` copies real edge pixels from neighbours so
  slope is right up to the tile edge; the cost is neighbour bookkeeping and
  re-uploads when neighbours arrive [1].
- Picking (#8158): the old path re-rendered every terrain tile into a
  screen-sized framebuffer with a 4 MB RGB-encoded coordinate texture and
  read it back on every pointer event: an extra pass, a pipeline stall,
  1024 steps per tile and a 1-byte tile index that broke past 255 tiles.
  The new path intersects the screen ray with the bilinear DEM on the CPU:
  Mercator marches the frustum segment, bisects the first crossing and
  refines with a secant step; globe brackets between min/max-elevation
  spheres. Over 16 scenarios with a 15x15 pick grid the rendered output was
  pixel-identical, picks differed by ~0.5 px median (p95 <= 1.6 px), and
  globe unproject went from ~12 px off to 0.00 px. Cost per pick: 0.2 us
  for a sky miss, 2.0 us flat z2, 5.0 us sloped z10, 63 us sloped z16 [3].
  The changelog sums it up as full DEM resolution, no GPU stall and about
  4 MB less GPU memory [2].
- Marker occlusion (#8387): a CPU ray walk to the marker, hidden if the hit
  is more than 1% short, throttled at 100 ms, replaced one or two readPixels
  per marker. On a Galaxy S24, 45 markers turned a 33 ms worst frame into
  108-117 ms stalls on most swipes; desktop panning dropped from 87 fps to
  47-55. CPU cost: 5-10 us per marker at pitch 30-60, 75-90 us at pitch 85.
  CPU and depth methods agreed on every on-screen marker on a 200-point
  grid [4].
- Draped RTT cache (#7549): each tile owns its FBO and texture per layer
  stack and returns them to a recycle pool when it unloads. A bigger pool
  alone (400) still hit 0.1%, because freed slots were reused first; a pool
  without clearing reached 95% hits but 3.36 GB and crashed under panning.
  Result: 0.2% -> 94.6% hits, Terrain3DGlobe ~410 -> ~37 ms, 151 -> 302 MB at
  z12, pitch 80, 393x852. The benchmark metric changed from max frame time
  to jank-sum [5]. A maintainer later reported OOM and FPS drops on a phone
  and suspected these changes [6].
- Re-render budget: while moving, only the nearest stale drape is
  re-rendered per frame; one changed layer no longer re-renders all; DEM
  textures upload once per tile [14].
- Canvas fingerprinting (#3185): getImageData first; on detected distortion
  read through a `VideoFrame` (RGB/BGR only). 0.5-1 ms per 512 px tile on
  desktop, 5-10 ms on an iPhone 14. It also fixed long-standing spikes in
  Brave [7].
- Off-thread decode: ImageBitmap transferred to the worker when
  OffscreenCanvas exists; a Safari regression from ImageBitmap had to be
  fixed [13]. The texture pool keyed by tile size instead of stride leaked
  GPU memory (#7690) [12]. Hillshade uses highp after mediump showed bands
  (#8431) [15].
- Camera: gestures freeze centre elevation from their first frame; DEM that
  lands during the hold is applied at release by re-solving zoom and centre
  with the camera still. Alternatives that failed: freezing only for drag
  and zoom (rotate/pitch bobbed), keeping the camera still for every terrain
  change (~60 px content shift), re-clamping always (changed 32 of 87 render
  fixtures). Toggling terrain from pitchend went from 2844 m / 64.7 px to
  2 m / 0.0 px; some panning jumps and the push-out from inside the terrain
  remained (#8539) [8]. Ground clearance (#8547/#8548): one helper with a
  cap and a stop when a pass moves further than the previous one; 23 gesture
  scenarios went from hundreds of metres inside the terrain to under 1 m,
  and release jumps from km to at most 34 cm. The earlier loop (10
  iterations, no divergence stop) oscillated at high latitudes and was
  replaced in #6775 by a single pass that used the old latitude's scale [11].
- Content above the ground (#8319): buckets track the largest symbol height
  offset as a per-source high-water mark that never shrinks, and
  coveringTiles pads bounding volumes, the horizon plane and the far plane
  by it [9].
- Untiled image on terrain (#1559): tiles carry a list of overlapping tiles
  so each terrain tile also renders the image; slicing an image pyramid was
  rejected as complex. The bug dated from v2.4.0 (2022) [10].
- Pitch above 90 degrees (#4851): `centerClampedToGround=false` with a
  centre elevation; the above-ground check stays in one place [16].
- Terrain landed as one PR (#1022) kept separate from 2D [17].

## MapLibre Native

- 3D terrain on Metal (#4190), iPhone 16 Pro Max at z12, terrain vs none:
  pitch 25 54.8/58.8 vs 61.2/58.9 fps, encode x1.39-1.50, 6 vs 6 draw calls;
  pitch 45 40.9/42.1 vs 60.5/59.6 fps, x1.73-1.82, 8 vs 8; pitch 65
  21.5/22.0 vs 53.8/56.2 fps, x2.30-2.35, 28 vs 19. A bug used the camera
  latitude for pixelsPerMeter, scaling terrain 1.31x at z6 and 11x at z4 [18].
- Hillshade seams (#4280, closed unmerged): Sobel outputs at tile edges
  differ because each tile samples different neighbours, and bilinear
  filtering drags a tile-local texel across the seam. Proposed border 3 and
  a (dim+3)^2 prepare pass, ~2% more DEM memory; border 2 was insufficient.
  Also found: backfill flags not reset when a bucket is replaced, and a
  render-target leak. Closed because the contributor could not explain the
  AI-generated change under the project's AI policy [19].
- Hillshade methods ported to follow the GL JS GLSL; only terrain-rgb and
  terrarium encodings [20].

## MapLibre Tile (MLT) v2 draft

- Interleaved (x, y, z) int32 triples upload as ivec3; elevation = -10000 m
  + z * 10^z_step. At 1 dm, z equals Terrain-RGB's R*65536+G*256+B. Morton
  and Delta2 are not allowed on 3D streams [21].

## navara

- Clamp-to-ground vectors render offscreen into a 512x512 texture per
  terrain tile and layer and composite like imagery; in translucent layers
  each source first claims its square in the stencil, finest first, so
  overlapping tile buffers and ancestor fallbacks draw once [22]. Stencil
  draping and the `useGroundNormals` polyline option were removed; GeoJSON
  goes through a Rust port of geojson-vt into the same path; lines are
  limited by texture resolution [26].
- DEM upsampling bounded by `MAX_UPSAMPLE_DEPTH = 2`, except in the
  overscale band and after failed requests [23].
- Normals: vertex normals (seams) -> per-fragment Sobel on a 1 px backfilled
  DEM (9 samples per fragment per frame) -> a 256x256 RGB normal map baked
  once per tile from a 258x258 DEM, normals in 8 bits; a reviewer noted
  upsampling worked poorly for the hillshade texture [24]. Overzoom past the
  source max zoom reuses the parent's normal map through a UV transform,
  with a marker so the UV setup is not skipped by an early return [25].
- Several raster tiles per quantized-mesh tile are rendered into one
  texture, because a mesh can take only a few textures [27].
- Clamped points: MVT points use their containing tile; GeoJSON gathers
  leaf tiles first, then computes heights [28].
- Skirts, and children kept to fill holes while zooming out, after a series
  of flicker fixes [29].

## reearth

- reearth-papers binds the 3x3 DEM neighbourhood (nine 380 KB tiles per
  render, six shared with the next render); at deep zooms it reprojects an
  ancestor DEM. Buggy vs fixed renders of a Fuji tile differed by 8.4 on
  average and 121 at worst in the outer 16 columns (0.5 in the middle); the
  step across a join fell from 4.8 to 3.4. Cached renders had to be
  re-versioned because they were immutable [30].
- reearth-visualizer: terrain vanished after navigating away and back
  because the React wrapper skipped `update()` on mount; the fix assigns the
  terrain provider imperatively when its promise resolves, removing a
  setTimeout toggle and a 100 ms polling interval [31].

## CesiumJS

- Quantized terrain vertices: CPU memory down up to 40% (1.17), ~25% more
  in Chrome (1.18) [32].
- Fog as culling: up to 35% faster terrain and fewer requests (#3154);
  `Fog.renderable` later decoupled the look from the culling (#10186) and
  default density went 0.0002 -> 0.0006 with `visualDensityScalar` (#12248)
  [33].
- Fill tiles (#7061): master vs fill-tiles: static horizontal 10.53 -> 8.82 s
  and 824 -> 578 requests; top-down 5.98 -> 3.64 s, 434 -> 205; pan 16.41 ->
  12.10 s, 1448 -> 837. Another tester: 1.4-2.3x faster loads, 19.7 -> 13.3 MB.
  The tile under the camera must still load for clamping and collision. The
  same PR removed server BVH min/max support after the author found it did
  not reduce tiles or speed up loading [34].
- OBB culling (#2782): requests down 5-15%; one low view 330 tiles with
  spheres, 298 with OBB plus skirts, 279 without skirts; a four-corner OBB
  failed for tiles spanning the equator [35].
- GroundPrimitive (#2865): closed volumes extruded between terrain min and
  max, intersected with terrain depth through stencil; needs EXT_frag_depth
  [36].
- `HeightReference` enum (#2653) instead of a `clampToGround` boolean, for
  KML altitude modes; heights zig-zag while terrain refines [37].
- Draped vectors (#13577): segments clipped to each terrain tile's UV
  square, bucketed into a grid (target 16 segments per cell), packed into
  float textures; the fragment shader does the distance test. 125K
  polylines / 500K vertices at stable FPS; lines bleed up slopes at oblique
  angles because the test ignores fragment height; seams fixed by padding
  half a line width [38]. Clipping polygons moved from an SDF texture to the
  same lookup technique, deprecating the recently added quality option [42].
- Cracks: screen-space crack filling replaced by skirts, later extended
  slightly outward and deduplicated [39]. A 256x256 heightmap (65,536
  vertices) broke 16-bit indices with skirts; skirts were disabled, or the
  grid resampled to 129 [40].
- Horizon culling point from the RTC centre, not the bounding sphere centre
  (level-0 tiles vanished near the poles, #760) [41].
- Labels: the first attempt set each glyph's heightReference to NONE and was
  reverted within days; a `_positionFromParent` flag now skips clamping for
  glyphs [43].
- `updateHeights` runs within 2 ms per frame; its queue grew without bound
  until a per-tile position cache keyed by level and screen-space error was
  added [44].
- Camera collision adjusts height instead of stopping at the hit; CPU
  intersection had slowed tilt [45]. `TaskProcessor` defaults to unlimited
  active tasks with a throttle option, so must-complete calls never come
  back undefined [46]. A last-layer-first terrain lookup was reverted
  without a stated reason [47].

## deck.gl

- TerrainLayer meshes on a globe have their rows remapped from Mercator Y to
  latitude (copying loader output), detected from the viewport CRS [48].
- Tiled TerrainLayer skirt height = 2 x `meshMaxError`, 0 for a single mesh
  [49].

## ortho-earth (GPL-3.0; fine to read for this GPL repo)

- GPU resampling: step 0 (JS optimisation, native Float16Array) took a Node
  cell from 7.4 to 3.5 ms but a large browser cell only 15.92 -> 14.68 ms.
  Step 1 uploads raw tiles as a storage buffer (not a texture: 7200-byte
  rows break the 256-byte row alignment) and resamples into an r16float
  atlas: per-cell CPU 5.04 -> 0.58, 0.99 -> 0.14, 4.47 -> 0.34 ms; GPU vs CPU
  max delta 2.0 m at 2098 m, one f16 ulp; raw-tile LRU 64 MB (16 MB
  low-memory) [50].
- Chunk culling: index buffer reordered into 16x16 chunks, culled against
  horizon, camera and one frustum plane, contiguous ranges merged into few
  `drawIndexed` calls; Fuji z13 60 degrees 7.18 -> 3.55 ms, Tokyo station
  9.69 -> 6.54 ms, both beating the `?gmax=768` ceiling (5.22 / 6.43 ms); at
  60 degrees only 19/256 near and 14/256 far chunks are visible; ~0.3 ms CPU
  for 256 tests; pixel diff 0. CDLOD step C rejected because it risks
  mismatch with the line/fill elevation grid [50].
- Unit grid plus window uniform: the old absolute grid at G=1536 was 18 MB
  vertices + 56.5 MB indices per window move, 525 MB over 8 hops [51]; atlas
  zeroing reuses a 4 MB strip instead of a 67 MB array; process peak 3.65 ->
  3.14 GB over 20 hops [56].
- Ground atlas: raster base, vector fills and faces composited into nested
  windows (near, x6, x36; 2048^2 x2 + 1024^2 x2), cross-fading the outer 4%,
  recomposited only when a key changes; lines stay vertex-draped [52].
- altpbf: R10 2400^2 decode 99 ms / +232 MB RSS -> 21 ms / +12 MB; browser
  renderer 1.70 -> 1.15 GB [53][55].
- Shadow-hour maps and viewshed in a worker on a grid (~13 m cells at 5 km
  radius), with Earth curvature and refraction k = 0.13; buildings as prisms
  at max roof height [54].
- Draped lines sample `elevQ` at the mesh's grid and triangulation; edges
  subdivided to ~0.001 degree, at most 256 pieces, 600k-vertex budget; a
  50 km line went from 2 to 512 vertices; no subdivision without terrain
  [57].

## QGIS

- First 3D view: Qt 3D, chunked LoD, a separate `qgis_3d` library; DEMs had
  to be in a projected metric CRS; labels planned off by default because
  draped labels become obstacles when rotated [58].
- STL export shipped with a warning: terrain is an open sheet and buildings
  float, so prints need repair; a closed "diorama mode" was proposed. For
  printing, close the mesh at bake time [59].
- Leaves accepted at any error [60]; GDAL DEM hillshade formulation [61];
  degenerate triangles removed and skirts added for quantized mesh [62];
  terrain no longer reloaded on unrelated style edits, in three chunked
  entities [63]; elevation profile clipped to the tolerance corridor, with a
  NaN-gap regression fixed with a test [64].

## GRASS

- `r.horizon` went back to non-negative angles: the simple negative-angle
  version had problems in flat areas and `r.sun` did not handle it [65].

## Tangram

- Raster samplers only in the fragment shader by default, since vertex
  texture fetch is not guaranteed (Mali-400: 0 units) [66].

## maptalks

- Missing altitude = `Float32Array([-1e12])[0]` [67]; terrain mask textures
  at tileSize/4 and skin texture at tileSize with a `skinScale` option [68];
  new terrain tiles per frame capped while interacting, shared skin tiles
  deduplicated, altitude query time bounded per frame [69].

## openglobus

- Decimation keeps peaks and pits; edge heights extrapolated with a
  minmod-limited slope; a side-by-side sandbox compares it [70].
- RGB/Terrarium decode in a worker; 2^n images resampled to a 2^n+1 corner
  grid; grid size per zoom from a table (64 at z0, 8 at z3-5, 64 at
  z15-17) [71].
- Edge equalisation tracked per side by neighbour id; needed later fixes for
  fading nodes and gaps [72].

## iTowns

- Shared index/UV buffers keyed by CRS, skirt flag and segments; skirts last
  so hiding is `setDrawRange`; `hideSkirt` for opacity < 1; a cache bug
  rendered skirts wrongly [73].
- Skirt height: 5000 m, then 50^(1+1.25/zoom), then 5*((20-level)+10), then
  one grid segment [74].
- Elevation min/max from every 32nd sample; nodata no longer rewritten, the
  vertex shader filters it [75]. Three elevation encodings by define
  (RGBA, float, 8-bit grey) [76].
- One geometry per tile shape, oriented to the geodesic normal: build time
  and memory /3 [77]. The elevation-level gate on subdivision removed, after
  a misnamed parameter had caused over-subdivision [78].
- Nearest filtering without `OES_texture_float_linear` [79];
  `willReadFrequently` on elevation canvases [80].

## TerriaJS

- Height under the cursor through `sampleTerrainMostDetailed`, replacing a
  hand-rolled availability walk; error bars from the tile's min/max when
  smaller than the level's geometric error [81].
- Globe hidden until the initial terrain provider is ready, request started
  in `Terria#start` [82].

## VTS browser

- `heightMode` 'float' (relative to currently loaded terrain) by default;
  'fix' for absolute heights; float is non-deterministic and costly at load
  [83].

## WebWorldWind

- LOD distance: minimum of 4 corners and centre with elevation, cached on
  the Sector [84].
- Shadow volumes vs render-to-texture surface shapes (#586): 1000 static
  circles 3.8 vs 11-13 ms, 500 moving 28.7 vs 163-169 ms on an iMac; on a
  Nexus 9 80-83 ms while render-to-texture crashed. Never merged [85].
- `retrievalQueueSize` 16 for elevation [86].
- One index buffer per tile grid with full- and low-resolution border strips
  and `alignNeighborElevations`, no skirts [87].
- Compound elevation picks the highest-resolution coverage per location;
  the global sort had treated a 900 m/30 m/10 m coverage as 10 m and hidden
  a 100 m bathymetry; min/max taken across all coverages [88].

## WorldWind Java

- Tile vertices are floats relative to the tile centroid, pushed into the
  modelview per tile [89].
- Skirts dropped to the globe's minimum elevation; a positive local minimum
  with exaggeration lifted skirt bases above terrain (WWJINT-435) [89].
- Indices and texture coordinates shared per density (20) on a 3x6 level-0
  tiling [89].

## osgEarth

- GPU-clamped features disable bounding-sphere culling (`ClampableNode`)
  [90]. Draping is a top-down orthographic texture; 3D models are not
  draped [91]. Nearest sampling left seams; bilinear sped up after a 3.7
  regression (8 s in 3.6.0 vs 30 s in 3.7.3) [92].
- Skirts merged into the tile geometry as plain triangles; default ratio
  0.05 -> 0.001 [93]. Height queries use the mesh's diagonal rule
  (|ll-ur| < |ul-lr|) [94].
- Conservative bounds instead of sampling elevation per tile [95]; a
  compiled-in min/max table to LOD 6 (~290 lines) [96]; 257-post tiles [97];
  per-key gate and small L2 cache against duplicate fetches [98].
- FlatteningLayer transforms all points at once (lock contention) and
  queries segments per row [99]. Terrain masks forbid triangles joining
  boundary vertices across the mask [100]. Faces in an R-tree for point
  location [101].
- R16 elevation normalised to per-tile min/max (`OSGEARTH_USE_16BIT_ELEVATION_TEXTURES`),
  flat tiles use a unit range [102]. Normal maps BC5 + octahedral, generated
  3x faster, mipmapped at creation [103]. StrongLRU re-enqueued on every use;
  replaced with a map+list LRU [104].

## Mapnik

- Colorizer interpolation truncated channels; png8 decoded 188 instead of
  ~239; exact stops (10,000, slightly slower) and png32 fixed it [105].
- Only rgba8, gray8, gray16 and gray32f supported natively, because each
  type needs its own scaling, warping and colourising; signed 16-bit later
  reported unsupported [106].

## MapServer

- CONTOUR layer: nodata passed through (#6183); scale-ranged intervals (5 m
  below 1:25k, 10 m to 1:500k, a list above) [107].

## OsmAnd

- Eight hillshade workers in vendored GDAL 3.4.0 reached an untested OOM
  fallback that wrote through NULL; patched locally rather than upgraded
  [108].
- Sentinel tile id for lines gave negative elevation scaling for tracks with
  heights; per-tile parts cost ~11 failed heightmap lookups per part per
  frame [109]. Heightmap fixed at 32 heixels per side [110]. Vector lift
  over terrain 1.0 -> 0.5 -> 1.0 (z-fighting on Samsung) [111].

## Organic Maps

- Isoline profiles: 20 m, 50 m, 100 m, 500 m, 1000 m with simplification
  zoom 17/15/14; Sakha Republic isolines 257,829,111 bytes; two Russian
  regions removed entirely [112].

## mapsforge

- Hill shading overlap moved to draw time, DEM preprocessing separate and
  default-on, bicubic path optimised: one HGT 900 ms (high-res) / 550 ms
  (standard) vs 3200 / 1550 ms in v0.22.0; full map 3.9 s / 2.5 s (4 tiles)
  vs 40 s / 19 s (12 tiles) [113].
