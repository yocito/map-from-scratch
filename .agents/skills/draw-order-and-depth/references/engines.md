# Draw order and depth, engine by engine

Bracketed numbers refer to the Sources list in [../SKILL.md](../SKILL.md).
Each item: what was decided, the alternative, the cost, and the evidence.
Engines are grouped by family; items already summarised in the SKILL.md are
repeated here with their full numbers.

## MapLibre GL JS

- **Four passes.** Offscreen (hillshade, heatmap, custom precompute to FBOs),
  opaque fills and backgrounds top to bottom, translucent layers bottom to
  top, debug on top; every layer gets its own depth value so opaque overdraw
  is rejected by early-Z [10]. Confidence medium: taken from the developer
  guides, no benchmark.
- **Globe back side without the depth buffer.** Because depth is taken by
  layer order, each vertex writes its distance to the horizon plane into
  `gl_Position.z` so clipping removes the far side; MapLibre's own depth is
  applied later through `glDepthRange`. Fills and rasters also use face
  culling (earcut's inconsistent winding had to be fixed during subdivision),
  lines discard fragments beyond the horizon. Three mechanisms instead of
  one, because some phone drivers apply `glDepthRange` and clipping in the
  wrong order [6].
- **Globe raster seams.** Two stencil passes: all raster tiles borderless
  while marking stencil, then again with stretched borders only where the
  stencil is unmarked. Fixes seams between mixed-zoom neighbours under
  curvature, no pixel blended twice; costs a second draw of every raster
  tile [6].
- **Translucent line overlap (v6, PR 7490).** Lines with a constant
  `line-opacity` strictly between 0 and 1 are drawn opaque offscreen and
  composited once. Zoom and data expressions are not fixed (would need
  MRT/WebGL2). A stencil bit was tried: the first-drawn feature won on
  overlaps, translucent patterns still wrote the stencil, SDF edges showed
  artefacts, and removing the tile stencil caused tile-edge artefacts. Bench
  with 50 line layers at 0.5: 3x slower at first, 1.95x after optimisation;
  standard benches never hit the path because their opacities interpolate to
  0 or 1. Mapbox GL JS had the same offscreen pass and removed it for
  performance (mapbox-gl-js #523, #4090). Users who relied on overlaps adding
  up (GPS density) must move alpha into `line-color` [7].
- **Per-layer fill opacity (PR 1191)**, rendering a fill layer offscreen so
  overlaps do not darken: open 2022-2026, closed as stale. Objections: a
  screen-size framebuffer does not fit 3D/terrain (unlike hillshade's
  per-tile FBOs), the spec shape is hard to change, and the cost is large for
  a trivial-looking property [11].
- **Near plane `height/50`** instead of 1: more depth precision (fixed
  deck.gl custom-layer z-fighting), clips near 3D sooner; chosen by
  experiment [8].
- **Symbol y-sort key rounded** to integers so ties fall back to data order
  and JS and Native agree [9].
- **Solid background via `gl.clear` reverted**: a colour-buffer bug with
  fill-extrusions; a regression test was added [12].
- **All fill-extrusion offscreen textures rendered first**, depth kept
  across extrusion layers: fewer framebuffer switches and extrusion layers
  occlude each other (new `fill-extrusion-multiple` render test) [13].

## MapLibre Native

- **Fill antialiasing outlines depth-clipped** (LEQUAL, fill writes depth)
  so they do not double-blend with neighbouring fills; costs depth range
  bookkeeping per layer; MSAA renderers do not need it [14].
- **Stencil clip ids only for layers that need clipping**; symbols overdraw
  except when rendering still images. Fewer stencil operations and less
  "stencil mask overflow" pressure [15].
- **Tile mask and clip-id generators stopped sorting** because the tile
  pyramid delivers sorted tiles: the TileMaskGeneration benchmark ran 33
  times faster; the algorithms now rely on a caller-side invariant [16].

## maplibre-rs

- **All transparency removed** "because it should be solved separately";
  weighted blended OIT (as in Cesium) proposed, issue still open [17].
- **znear kept large.** A PR lowering znear to 1 to stop clipping while
  tilting was not merged; the real cause was tile loading tied to znear and
  zfar ("the actual problem was not the clipping on the GPU, but clipping in
  the logic of tile loading"), superseded by PR 148 [18].
- **Stencil masking.** Early on a 4-value checkerboard (x%2, y%2) and an
  instanced "perfect masking" scheme (12 quads in 4 steps); the doc now says
  it "is not used currently", and each drawn tile gets a value from
  TileViewPattern, which also covers parent/child fallbacks. No reason given
  [19].
- **Layer order in NDC z.** The vertex shader writes each layer's z-index as
  final NDC z, so znear/zfar no longer decide order; znear/zfar changed from
  100/2000 to 1024/2048 so tilting does not clip, values "selected
  experimentally" [20].
- **Depth32FloatStencil8** (configurable) because it works on Metal and
  "seems to have better overall support"; costs 32-bit depth memory [21].

## MapLibre Tile spec (MLT)

- Feature order is not fixed by the spec and encoders MAY reorder; the Rust
  encoder keeps source order by default (#1867). `--sort all`: -0.4%/-0.1%
  size; `--sort none`: +0.2%/+0.1%; decode within 1% [22].

## navara

- **Vectors draped on terrain** are baked per terrain tile and layer into a
  512x512 texture and composited like imagery. In translucent layers each
  source first claims its square in the stencil, finest first, so
  neighbours' buffers and ancestor fallbacks draw once ("a blend mode cannot
  know which source drew a texel"); costs an RT per slot and a re-bake when
  sources change [23].
- **Selective bloom/outline**: mask passes 4 to 2 (PR 468), then a G-buffer
  with 4 MRT attachments and an effect bitmask of up to 11 slots in
  HalfFloat (PR 488), MRT only when an effect is registered (PR 584).
  Geometry without effects (3D Tiles, terrain, raster) still does not
  occlude effect targets, deferred to WebGPU [24].

## RustGIS

- **CPU (tiny-skia) is the reference renderer**; the wgpu path is opt-in
  beta and draws only what it supports (raster and opaque vector tiles
  north-up; translucent tiles use cached pictures; rotated or tilted only if
  every visible layer is supported; exports always CPU). Two renderers to
  keep consistent [25].
- **Stencil-clip each vector tile mesh to its square**: without it, tile
  buffers blend twice and casings cover neighbours' roads; the parity test
  failed with 48k outlier pixels, after it GPU vs CPU mean diff 1.5/255
  [26].

## reearth-papers

- Subsurface roads and overview layers (z4-11) drawn below the water fill,
  detail from z12 where Protomaps carries `is_tunnel`/`is_bridge`; road
  filters list five kinds instead of "not rail" (ferries and runways had
  been drawn as streets). A long bridge vanishes at z9. Verified by running
  every road feature of five real tiles through the compiled filters and
  sweeping z6-z15 over the Aqua-Line [27].

## CesiumGS/cesium

- **Multi-frustum (PR 261).** View volume split along depth, commands binned
  per frustum, back to front, near/far reused from last frame unless they no
  longer fit. FPS: global 225 to 221, horizon to level 13 122 to 117, level
  20 92 to 90; a horizon view had 3 frustums, 2 commands drawn 3x, 8 drawn
  2x; following Landsat7 one orbit, 2901 renders and 2 recomputes; Molniya
  12308 renders and 23 recomputes. Frustum seams later caused artefacts
  [30].
- **Logarithmic depth (1.45, PR 5851)**, written from the fragment shader,
  default where supported; near 0.1 far 1e10 went from 3 frustums to 1 (2
  with a molniya orbit); a BIM tileset drew 383 commands against 483. Lost
  early-Z for every command writing `gl_FragDepth`; follow-up fixes for
  terrain clipping (#6701), large nearby geometry (#8600), polylines (#8703,
  #8706), very long ranges still needing multiple frustums (#8727).
  Orthographic falls back to standard depth. A near-plane-only depth write
  was rejected because interpolation over long triangles breaks elsewhere
  too [28][30].
- **LESS to LEQUAL** for billboards, labels and points (1.28, #4675) and
  glTF (1.67, #8646): later geometry wins ties, which "makes it easier to
  render e.g. outlined buildings" [29].
- **GroundPrimitive as shadow volumes** with depth/stencil (PR 2865):
  follows any terrain LOD without re-tessellation; many artefacts in
  development (near plane cutting the volume, curvature, frustum seams,
  IDL/poles), needs EXT_frag_depth with an `isSupported()` check [31].
- **Billboards depth-test in the shader**: far away against a plane through
  the ellipsoid centre, close up ground-clamped billboards test three points
  against the depth texture and show whole if any is visible; an attempt to
  clear globe depth with terrain depth testing was reverted; regressions
  fixed later (#13150, #13159) [32].

## deck.gl

- **Interleaving with a foreign basemap (issue 4603)**: one shared GL
  context, `_customRender` without clearing, same near/far/fov. deck's near
  is 0.1 and far depends on pitch; harp.gl's evaluator changes near/far with
  tilt. 61 comments over ~4 months, WebGL1/2 mismatches, a framebuffer
  feedback loop from post-processing; mismatched far planes still left
  artefacts [33].
- **Billboard icons depth-tested at their anchor**: a slanted building cuts
  the top of an icon but not the bottom; use SimpleMeshLayer or
  `billboard:false` for true occlusion [33].
- **@deck.gl/maplibre** uses only public custom-layer APIs (MapLibre 4.5.1
  minimum) after v6 removed the private `map.transform`; cost: a second
  integration package and version confusion [34].
- **No cross-tile feature merging**: the maintainer rejected turf union of
  split features in favour of GPU clipping per tile; highlight set per tile
  [35].
- **WebGPU clip z 0..w vs WebGL -w..w**: OrthographicView put primitives at
  z/w = -0.998 and nothing rasterised; fixed by remapping depth where the
  WGSL clip position is built. Found by writing the clip position as colour
  [36].

## ortho-earth (GPL; summaries only)

- **Stencil-then-cover fills** with non-zero winding after normalising ring
  orientation, so overlapping features equal their union; for single-colour
  fills only arcs with non-zero net reference, one fan pivot. Per-feature
  colours through an ID buffer in 2 passes regardless of colour count (fid
  limit 2,047 on half float). 370k-edge parcel layer: 20-37 ms to ~2 ms
  [37].
- **Log depth per fragment in all 16 depth-writing passes**: vertex-only log
  depth bent large triangles (fake AO bands at z19); terrain-only per-pixel
  depth made a new band; log1p computed by series because 1+w in f32
  quantises at ~0.76 m. +0.38 ms (6.28 to 6.66 ms, ~8%) at Tokyo Station
  z16.5/55deg, none on Fuji; only real GPUs showed the artefact, not
  SwiftShader [38].
- **Ground atlas in 3D**: raster, vector fills and Gint faces composited into
  3 nested windows (2048^2 x2 + 1024^2 x2) sampled by the terrain shader,
  because vertex-draped chords sank under ridges on iPhone; lines stay
  vertex-draped, 2D stays direct [39].

## QGIS

- **Selective masking** (PR 30747, 3.12): masks into an alpha-only image,
  masked symbol layers re-rendered and composited; ~8k lines, features
  iterated twice, post-merge regressions (PDF exports rasterised, white
  flashing ~30 s with parallel rendering, a Qt font crash). One mask-target
  set per layer; label masks from different sources in separate images
  [40][42].
- **Vector output** (PR 47459, QEP 186): mask shapes recorded as paths in
  pass 1, pass 2 into a QPicture clipped by them; layers with paint effects
  fall back to raster; Qt clip bugs QTBUG-100422/100420 [43]. Clip paths
  localised per feature: some PDF exports shrank to 0.01 of their size [41].
- **Near/far from all chunked entities**, not only terrain (point clouds
  were clipped while zooming) [44]; empty chunk nodes removed because their
  extreme heights broke the near/far calculation [45].

## GRASS

- `d.vect` boundaries: off when not requested (Feb 2014), on by default
  (Mar 2014), off again in 2015 because area outlines already draw them ("can
  speed up rendering maps with larger number of areas") [46].

## KDE Marble

- **Layer management**: order from backend hints and ranges, then the order
  in the DGML map section (from behind the earth to the observer), then a
  guess for unnamed plugins; projection layers vs screen layers; parts NYI
  [47].
- **Skip z-sorting** at levels below 17 where almost all items have z 0;
  sorting had taken ~10% of run time; `std::sort` replaced `stable_sort`
  because insertion order means nothing [48].
- **Building walls back-face culled** (~20% faster in building areas), flat
  buildings at level 17 to cut draw calls, DPI-aware switch to fake 3D on
  mobile [49].

## OpenLayers

- **Layer composition history**: tiles straight onto the map canvas (3.14,
  PR 4597: fast zoom 30 to 50-60 fps, panning 55 to 60, no change with 25
  TileWMS layers; white lines between tiles in 3.14.x, #4960), a canvas per
  layer again (3.20) for seams under rotation, DOM composition (6.0) for
  mixed renderers with forEachLayerAtPixel false positives on shared
  canvases, adjacent WebGL layers sharing a canvas and context (6.10) to
  avoid the context limit [50][52].
- **Declutter**: per layer (4.5), jointly across layers and lifted above all
  layers (6.0, `flushDeclutterItems()` workaround), rewritten from scratch
  around one rbush tree, top layer first (552 lines deleted), then layer
  order kept (9.0); the tree kept for hit detection (#7669, #15028)
  [51][55].
- **Canvas size in one function**: 9.0.0 flickered at browser zoom 150%
  because the vector renderer derived the shared canvas size from frame size
  and cleared the tile layer; fixed in 9.1.0 [53].
- **Translucent vector layers** drawn opaque into an intermediate canvas and
  composited with the layer opacity, so styles and overlaps do not stack;
  opaque layers unaffected [54].
- **Fallback tiles**: only the uncovered rectangles of lower-zoom tiles are
  drawn (`subtractExtents`), replacing clip paths and even-odd donut clips
  [56].
- **LEQUAL** in the WebGL helper so several vector-tile layers share a depth
  [57].

## OpenLayers 2

- **Canvas renderer redraws everything** on any change, labels in a second
  pass; bulk adds lock the renderer and redraw once [58].
- **SVG root `position:absolute`** fixed vector layers drifting from the base
  layer on resize in Chrome 18+ [59].
- **SVG pans by translating** and re-centres when the translation leaves
  MAX_PIXEL 15000, then redraws [60].
- **Z-index ordering opt-in**, indexer keeps only the bottom bound instead of
  whole geometries ("increasing memory drain", #2198) [61].

## Leaflet

- Panes ordered by CSS z-index; paths sharing a renderer stack as one group;
  custom panes for labels over vectors with `pointer-events: none` [62].
- Tile layer z-index replaced by DOM order because z-index on a layer with
  opacity < 1 creates a stacking context (#1790) [63].
- `clearRect` inside `save(); setTransform(1,0,0,1,0,0); ... restore()`
  because the active transform left stale pixels (#6915) [64].

## protomaps-leaflet

- Per tile: label symbolizers first-to-last into an R-tree, paint back to
  front, then label closures. Priority is rule order only, and cross-tile
  layout "depends on which tile was loaded first" [65].
- Multiple sources in one canvas: painting waits for all tile promises,
  because drawing is strictly back to front; a slow source delays the tile;
  jank around z10 and 60 ms+ layout at heavy overzoom during the spike [66].

## Tangram / tangram-es

- **Order as depth**: `TANGRAM_LAYER_DELTA = 1/(1<<14)`, 14 bits for order,
  one for half layers, one spare, order doubled; batches by material in any
  order; caps the range and shares precision with extrusions [67].
- **Tiles unclipped, no stencil**: lines join without a buffer, translucent
  buffered polygons double at seams (known limitation #469); CARTO's darker
  seams came from their tile buffer. A depth-write-plus-alpha mode
  ("depthinlay") was rejected because draws are regrouped by tile and
  program [68].
- **Proxy tiles** drawn behind, proxy depth in the w of the tile-origin
  uniform, ancestor depth capped [69]; masked with the stencil so
  translucent proxies do not compound, except points and text (cut-out
  effect) [71].
- **Add and multiply blends** as order-independent transparency, drawn after
  opaque and before overlay styles [70]; tangram-es turns off depth writes
  for them (#1769) [74].
- **tangram-es stencil proxy PR closed**: same result as polygon offset;
  buildings from proxy and real tile still both visible (#411) [72].
- **tangram-es translucent polygons**: depth pre-pass with colour off, then
  EQUAL depth plus stencil EQUAL 0 / INCR so each pixel is written once;
  requires an 8-bit stencil buffer (the iOS view had been configured with
  none) [73].

## harp.gl

- Solid-line clipping opt-in; fallback roads get a 1e-6 render-order offset
  instead of going under the ground plane (duplicated slightly wider roads
  judged "not as disturbing as seeing the cap outlines") [75].
- Fallback tiles: cached ancestors/descendants with a level offset under an
  opaque ground plane (renderOrder -10000); buildings resolved by a depth
  prepass; deep search can stutter [76].
- Text and icons: no depth write, no depth clear, then no depth test after
  icons failed it in globe top-down views (MAPSJS-2660) [77].
- Globe far plane: farMaxRatio 1.8 to 6.0 x altitude; a ray-based far plane
  reverted the same day and re-landed (#1384, globe clipped near aspect 1)
  [78].

## maptalks.js

- A canvas per layer composited each frame became a bottleneck (#2471);
  `tileBackgroundLimitPerFrame` default 3; the scheme was slated for removal
  in favour of a shared GL context [79].

## kothic-js

- Per-layer queues polygons, casings, lines; consecutive features with equal
  style share one fill/stroke: 30% faster geometry [80].
- Secondary sort by fill-color+color inside a z-index to lengthen runs; a
  later contributor could not see why [81].
- Separate loops for icon, text and icon+text break z-index priority (issue
  63 open) [82].

## polymaps

- Level containers relabelled on integer zoom change (three insertBefore
  calls) instead of re-adding tiles: fewer DOM moves, less flicker [83].
- GeoJSON tiles clipped by one shared clipPath rect; WebKit needed the
  clipPath before referencing elements [84].
- Layers hidden with a `visible` flag instead of remove/re-add, which had
  changed z-order [85].

## globe.gl

- Near plane 0.05 ("less will start causing depth z-fighting issues"),
  minDistance derived from it, formula changed a day later to
  globeR + max(0.001, near*1.1); maxDistance globeR*100 [86].
- Default label altitude 0 to 0.002 globe radii after flicker reports
  (#248) [87].

## openglobus

- Reverse-Z by default (PR 986): one perspective frustum [[150, 1e12]]
  instead of four ([[1,100.075],[100,1000.075],[1000,1e6+10000],[1e6,1e9]]),
  EXT_clip_control when present, polygon-offset signs flipped; overlap had
  been hand-tuned against border artefacts (65c0591a); depth offset and
  linear depth code rewritten [88].

## iTowns

- `hideSkirt` (2.43.0) for translucent terrain: skirts (8*segments extra
  triangles per tile) show through when opacity < 1; hiding them can show
  cracks [89].
- Parent tile hidden only when all four children are ready [90].
- Dynamic near/far from altitude and horizon; farFactor default 20 to 0.3,
  maxFarAltitude 80000 m, minFarDistance 10000 m, far-plane culling when
  closer than the horizon (#2699) [91].

## vts-browser-js

- A parent drawn with a shader quadrant mask (`discard` per covered
  quadrant, margin mapSplitMargin 0.0025) while only some children are
  ready: no holes, no CPU re-cut, costs shader variants and overdraw [92].

## WebWorldWind / WorldWindJava

- Stencil shadow volumes for surface shapes measured against shipped
  render-to-texture: 1000 static circles 3.8 ms vs 11-13 ms, 500 moving
  28.7 ms vs 163-169 ms, Nexus 9 80-83 ms where RTT crashed; never merged.
  One program per shape and 6 draw calls per shape were found and removed
  along the way [93].
- Screen images drawn with depth off, outside the eye-distance ordered
  renderables (Firefox clipping, #78) [94].
- WorldWindJava near plane: below the terrain distance, never below
  MINIMUM_NEAR_DISTANCE ("significantly reduces the depth precision");
  far = horizon distance [95].

## osgEarth

- With log depth, coarse LODs touching the nominal near plane are no longer
  culled: old shader failed 20 assertions, the fix passed 57 [96].
- DrapingCullSet held raw pointers and crashed after a map reload; fixed
  with observers [97].
- Log depth kept per vertex; the fragment variant deleted; no reverse-Z;
  third-party shaders (SilverLining, Triton) must use the same function
  [98].
- GPU terrain clamping disables bounding-sphere culling (ClampableNode)
  [99].
- Terrain drawn front to back for early-Z, no numbers [100].
- GPU culling disabled for feature/XYZ models, kept and tuned for
  vegetation (up to 5%) [101].

## Mapnik / GeoServer

- Mapnik style-level comp-op and image filters render a style into its own
  buffer (2.1); 4.3.2 composites and clears only the painted region [102].
- GeoServer `sortBy` orders extraction per FeatureTypeStyle; `sortByGroup`
  interleaves casing and fill styles by z-order [103].

## OsmAnd

- Raster layers of one tile batched into one draw; a debug switch
  `mapLayersBatchingForbidden` to isolate bugs [104].
- On-terrain vector lift 1.0 to 0.5, reverted for z-fighting on Samsung
  devices [105].

## Organic Maps

- Four ranges: BG-by-size, BG-top (water), FG, overlays [106].
- Opaque pattern fills moved before translucent geometry because
  translucent draws write depth and culled later fills (#2381); order pinned
  by a test [107].
- Background area depth `999 - (log2(bboxArea) - log2(FLT_MIN))*100`
  (about -13000..-8000) [108].

## mapsforge / VTM

- Labels moved out of raster tiles into a screen-space LabelLayer with a
  layout thread and a tile-organised LRU; OOM pressure remained [109].
- VTM fills polygons by stencil INVERT (even-odd, up to 8 bits per pass) by
  default, triangulated meshes only with `mesh="true"`; overlapping polygons
  in one layer cancel out (Lake Zurich, a substation inside a fence, #224)
  [110].
- Proxy tiles clipped through a depth pass only in frames with unready
  tiles; depth projection removed from the clip matrix to stop flicker
  [111].

## osmdroid / galileo / walkers

- osmdroid draws one wrapped copy, nearest the screen centre, offset before
  clipping (#725) [112].
- galileo draws style rules in sequence, a feature once per matching rule
  [113].
- walkers merges only consecutive polygons (1,480 meshes to 2; "not faster
  on its own") [114] and sorts labels once by ZOrder [115].

## cartopy / go-staticmaps

- cartopy masks pcolormesh cells whose projected diagonal exceeds width /
  (2*sqrt(2)) and redraws them with pcolor in a second collection; later a
  memory leak on removal (PR 2676) [116].
- go-staticmaps renders whole tiles into an oversized canvas, then overlays,
  then crops; fixed order base tiles, overlays, objects, attribution [117].
