# Line tessellation: per-engine detail

Numbers in brackets refer to the Sources list in [../SKILL.md](../SKILL.md).
Engines in the order of that list. Read the section for an engine before
copying its approach; read the source itself before copying code (licences:
skills/map-from-scratch/SKILL.md, Rules).

## MapLibre GL JS

- Vertex layout history: a_pos_normal was 3 Int16 with round/up packed into
  a float, plus 4 Uint8 of `a_data` (10 bytes); in September 2017 it became
  4 Int16 (12 bytes) so the vertex is 4-byte aligned, which also removed the
  unpacking maths in three shaders
  [1]. The current layout is Int16x2 position, Uint8x4 data, Int8x2
  `a_offset_normal` with 2-byte alignment, 10 bytes, after #8570 improved
  `line-offset` at joins (2026-09-28) [4].
- Constants in line_bucket.ts: `EXTRUDE_SCALE = 63` for byte-stored
  normals; extra vertices `SHARP_CORNER_OFFSET = 15` px from corners sharper
  than 75° so that dashed lines tilt over a shorter stretch (inner and outer
  corner share one distance); `DEG_PER_TRIANGLE = 20` for round joins;
  `line-offset` follows a miter vector of at most 2 and eases to plain
  segment normals between miter lengths 3 and 8; `linesofar` uses 15 bits at
  `LINE_DISTANCE_SCALE = 1/2` and resets with a duplicated vertex past half
  the maximum. Join selection: bevel is miter with limit 1.05; miter longer
  than the limit becomes bevel, longer than 2 becomes "flipbevel"; very
  small bevels are drawn as miter to save a triangle [4].
- Line gradients: step interpolation samples a NEAREST colour ramp sized by
  line-length coverage; high-precision progress goes in an extra vertex
  buffer only when line metrics are on; review moved work from the fragment
  to the vertex shader and to the CPU [2].
- The line bucket rewrite (#8303) removed distance passing and allocations:
  99 insertions, 210 deletions, no numbers [3].

## MapLibre Native

- Normals moved out of the LSB of the int16 position into their own
  component (`x*2|t` packing) because Broadcom GPUs mishandled it; vertex
  8 → 10 bytes, 25 % more per line vertex [5].
- Round joins 30° → 20° per triangle; no measurements [6].
- Sharp-corner offset scaled by overscaling and 0 above 16x; fixed broken
  "really overscaled lines" (#16018) and un-ignored a render test [7].
- `MLN_TRIANGULATE_FILL_OUTLINES = 1` on Metal and WebGPU: fill outlines
  become line-bucket triangles drawn by the line shader; GL keeps 2-vertex
  `gfx::Lines`. Costs a second vertex vector per fill bucket [8].

## maplibre-rs

- Issue #230: width changed with zoom because lines were tessellated in
  world space; the maintainer pointed to multiplying width by the zoom
  fraction in tile.vertex.wgsl [9].
- Commit 0de294e (demotiles): vertices carry position and normal; the vertex
  shader offsets in clip space by `line_width/2 + 0.5 px`, times `center.w`,
  per axis ("NDC spans 2 units across the viewport, so 1 pixel =
  2/viewport_px"); polygons are stroked when a line layer references them.
  Costs per-tile instance attributes (matrix, viewport size, width); blur
  and gap width hard-coded to 0 in that commit [10].
- Tessellation in general is Lyon on worker threads into vertex and index
  buffers per layer and tile [11].

## MapLibre Tile (MLT)

- Delta2 (second differences) for densely sampled lines and per-vertex
  elevation: −0.5 % / −0.6 % size, decode 0 to +1 %; bit-packed dictionary
  codes default (disabling costs +0.7 % / +0.3 %) [12]. Only relevant if the
  bake ships smooth, dense lines; see `vector-tile-encoding`.

## navara

- Dashes in the pitched (volume) path: the pattern unit is the line width
  rounded up to a power of two metres, chosen once per period from a segment
  table, never per fragment; periods start in the middle of the longest gap;
  length so far = high (multiple of 16,384 m) + low, phase computed exactly
  in u32 [13].
- Measured and dropped: per-pattern rounding (two dash arrays could come out
  equal; ratio changes with view), cross-fading neighbouring sizes as
  MapLibre does (a still view stays half-morphed, every other dash shrunk),
  per-fragment power choice (cuts dashes along a horizontal line in pitched
  views), f32 `fract(length/period)` (fails at thousands of periods) [13].
- Only for pitched or 3D views; top-down 2D can use a fixed scale per zoom.

## RustGIS

- Issue #596 / PRs #606, #611: tiny-skia pictures keyed by zoom rounded to
  1/256 level missed the cache on every zoom change. Meshes once per tile and
  level; strokes tessellated at width 1, extruded along lyon normals in the
  vertex shader; zoom-dependent paint stored at level and level+1 for shader
  blending; 52-byte vertex; mesh cache 512 MB native / 128 MB browser [14].
- Manhattan z14.3: meshes 106 ms / 27.7 MB against 440 ms of pictures per
  zoom step; native zoom frames 35 → 7 ms (z12), 64 → 24 ms (z14); browser
  about even. Ignores line-gap-width, line-offset, fill-translate,
  line-pattern. The maplibre-rs crate was rejected as experimental with
  limited style support; its design was borrowed [14].

## CesiumJS

- Draped vector lines (VectorProvider, PRs #13577, #13627): segments clipped
  to each terrain tile's UV square, bucketed into a grid (`gridSize =
  ceil(sqrt(N/16))`, target 16 segments per cell, neighbour padding 0.35),
  packed into float textures queried by the globe fragment shader.
  125K polylines / 500K vertices of U.S. highways ran at stable FPS once
  loaded; rebuilding tables when tiles load costs frame time; segments
  within half a line width of the tile edge must be included or they go
  missing at seams; at oblique angles lines bleed up slopes because the test
  ignores fragment height; beyond 0.1 rad ground angle stroke edges no
  longer line up across seams [18][19].
- PR #13675: draped lines fade coverage over a half-pixel band, default on,
  `scene.vectorProvider.antialias = false` for speed; the same PR fixed lines
  drawn at twice their width; baking takes the minimum tile screen size
  (default 256 px) from the terrain provider to convert pixel widths to UV,
  and underestimating it only widens the clip margin. Width can be in pixels
  or metres (#13703) [15][16].
- Ground polylines (PR #6615): one volume per segment, planes in vertex
  attributes, fragment reconstructs terrain position from globe depth and
  clips against the planes. Faster than corridor shadow volumes, supports
  materials and batching; smears on steep slopes, overdraw at sharp corners,
  special cases for the antimeridian and 2D. Rounded corners ~30–35 fps
  against 40. Centimetre jitter was fragment precision from plane points at
  the conservative −100 km minimum height, fixed by putting them on the
  ellipsoid; early discards helped on Nvidia and Intel. Computing planes in
  the vertex shader ("elbow macaroni") exceeded the attribute budget when
  morphing [17].
- Batch table with one instance per segment replaced by fat vertices; a
  follow-up reduced shader work with a `planeDistance` builtin; no numbers
  [20].

## deck.gl

- Dash RFC (v9.4): `dashMode: 'segment'` (default, free, restarts per
  rendered segment, so dense paths go solid) and `'path'` (CPU-accumulated
  `[offset, totalLength]` vec2 attribute over the normalised geometry,
  vertex shader reduces long-path phase modulo the period to avoid float32
  cancellation; CPU distance still accumulates in Float32). Rejected:
  making 'path' default (as MapLibre and SVG do), GPU prefix sums (vertex
  shader sees one segment; a compute pass would be WebGPU only), and the
  old `highPrecisionDash`, wrong under globe subdivision, antimeridian
  cutting and closed paths [21].
- PR #10580: dash phase follows the rendered path (billboarded, elevated,
  offset, justified, subdivided, cut), metrics refreshed only when
  projection inputs change, extra work only under `DASH_ENABLED`; golden
  diffs up to 3.52 % of pixels [25].
- PR #10581: dash coverage integrated over the pixel footprint; rounded dash
  ends intersected once with the AA envelope (applying two ramps gave dark
  shoulders, alpha 55 → 109 after the fix); picking keeps a hard test.
  M1 Max WebGL2 3840x2160: 100K sparse strokes 2.389 ms plain vs
  2.765–2.772 ms dashed; 256 overlapping 64 px strokes 0.462 vs
  0.662–0.665 ms [24].
- PR #10520 / 427df1b0: opt-in shader antialiasing for PathLayer (then Line,
  Arc, PointCloud): half-pixel vertex expansion, one-device-pixel ramp from
  screen-space derivatives computed before any discard, abutting segment
  ends stay hard, flat caps not covered, self-overlap can show artefacts.
  Compile-time variants (GLSL define, WGSL generated without the snippet);
  toggling rebuilds the model. MSAA is unavailable when drawing into
  MapLibre's framebuffer. Alpha-to-coverage parked (not mapped on WebGL in
  luma.gl, needs sampleCount > 1 on WebGPU, double counting with SRC_ALPHA).
  Benchmarked with GPU timestamps at 3840x2160 [22][23].
- 0fe74cae / adeeedd7: `PIXEL_EPSILON = 0.1` px; ported separately to the
  fp64 shader [26].
- e0cd7275: three dash modes (per segment, justified, high precision); the
  docs note 13 of WebGL's 16 guaranteed attributes are used [27].
  a9ea02e2: dashes evaluated per fragment in units of line width [28].
- PR #2522: flat binary input (one coordinate array plus per-object vertex
  counts and start indices) instead of nested arrays [29].

## ortho-earth (GPL-3)

- Per-vertex Visvalingam rank (0–63) on shared arcs; a vertex is drawn at
  zoom z when rank ≥ 3·(21 − z); the vertex shader's `lodSnap` drops the
  rest, so both sides of a border keep identical vertices at every zoom and
  no per-zoom geometry is baked; the per-vertex decode and project ALU then
  dominates [30].
- 4-vertex indexed quads (`?quad4=0` escape hatch; the 6-vertex shader is
  generated mechanically from the 4-vertex source; u32 index pattern,
  K = 131,072, draws split past K). Numbers in SKILL.md. A uniform added to
  the wrong name ledger killed hover picking while the visual gate passed;
  a separate pick gate caught it [31].
- Draped lines sample elevation at the terrain mesh's own grid and
  triangulation, not bilinear DEM; long edges subdivided to ~0.001° (~100 m),
  at most 256 pieces per edge, 600k-vertex global budget; a 50 km line went
  from 2 to 512 vertices; without terrain, subdivision stops (z ≥ 7). The
  floating lines were a discretisation mismatch, not f32 [32].

## QGIS

- Perimeter labels use the boundary before view clipping, or labels sit on
  the artificial view edge [33]. When the viewport cannot be inverse
  transformed, clip after transforming [34]. Fill textures anchor to the
  unclipped geometry so pans do not jump, keeping clipping on [35].
- PR #44941 (geocentric 2.5D clipping) was closed unmerged: maintainers
  would not risk any slowdown of the heavily optimised 2D clipper [36].
- Fast clip for long lines ("huge improvement" for WMS with long contour
  lines), ~650 lines of clipping code; clipping breaks centroid fills, so
  symbols got an opt-out (2015); 2005 trimming at 30,000 avoided X11
  overflow, 10–15 % less drawing time [37].
- Markers reuse the simplified projected points of the line [38].
- 3D: geometry shaders removed; lines as instanced segments (pointA,
  pointB) with joins as a second instanced pass that also gets pointC;
  reason for removal not stated [39].

## GRASS GIS

- Display drivers moved to path primitives (move/line/close, then stroke or
  fill) plus a point primitive [40]. A caller-chosen clip/cull mode lasted
  three months before clipping and culling moved inside the display library
  (lat/lon wrap handled once) [41]. The PNG driver draws lines in floating
  point; a bug skipped the topmost polygon row [42].

## Marble

- Project a street once and reuse it for outline, inline and label passes
  (an invisible redraw had been used just to place labels): about 20 %
  faster on a busy level-11 area [43].
- Tile creator keeps collinear clip points and tags clip-point index runs
  (`mx:bp=3+1;12+2`, wrapping around the ring) so outlines along tile
  borders can be suppressed [44]. Moved from Clipper to Clipper2's rect clip
  mainly for stable vertex order (one-way streets, cliffs, embankments);
  some nodes moved to a neighbour tile near the boundary, ~20 reference
  tiles changed, no benchmark [45].
- QML polylines keep only on-screen coordinates, with an opt-out [46].

## OpenLayers and OpenLayers 2

- Canvas `lineTo` only when the pixel changes [47]. Low/high distance
  attributes reduced modulo the pattern length [48]. AA ramp ±0.5 px [49].
  Join angle 0 / 2π special cases, guarded sharp offsets, capsule distance
  at segment ends [50]. `u_pixelRatio` for `gl_FragCoord` maths [51].
- OL2's SVG renderer kept coordinates within ±15,000 px (Firefox locked up
  beyond), translated its root on pan and recentred when needed [52]; the
  2.14 graticule preferred Canvas over SVG because its long lines hit the
  range [53].

## Leaflet

- Clip to the view and simplify per zoom at run time (`smoothFactor` 1.0,
  `noClip`); FAQ sends very large data to server-rendered tiles [54].
- Integer rounding of path pixels: a claimed ~20 % SVG speed-up (2012); in
  2016 a Chrome timeline found no measurable difference without rounding,
  and grid-like data (7,000 solar panels) looked jagged with it; the change
  stalled on re-testing IE8–10 and Safari [55].
- Clip bounds padded by stroke weight; only new clip points rounded [56].

## tangram and tangram-es

- #313 element arrays (numbers in SKILL.md), zoom-dependent round-join and
  cap triangle counts, no caps at tile-boundary starts, graceful fallback
  when indices overflow without `OES_element_index_uint` [57].
- #457: 4,443 repeated indices; builder skips degenerate segments; dedupe
  may run twice for outlines [58][59].
- #355: dash arrays scaled by a fixed factor (20) before rendering the dash
  texture, so fractions like 0.25 fit; least-common-denominator scaling
  could blow up to [1, 1000] [60].
- tangram-es markers quantise relative to the marker's own origin: long
  polylines got wrong widths, vanished at some zooms (width rounded to 0,
  mesh not rebuilt); the advice was the tiled client data source; float
  attributes tried by a user caused new problems [61]. Line segments outside
  the tile are dropped and client GeoJSON tiles use zero buffer, to avoid
  double drawing at seams at the cost of geometry for joins there [62].

## harp.gl

- geojson-vt buffer ~5 % of extent and per-vertex clip state (vertices
  exactly on the edge not marked) to classify tiling edges for outlines and
  walls [63]. Solid-line clipping became opt-in (`technique.clipping ===
  true`); fallback roads get only a 1e-6 render-order offset because pixel
  tests compare exactly; duplicated, slightly wider roads judged less
  disturbing than cap outlines [64].

## maptalks.js, kothic-js

- maptalks: geometries whose cached pixel bbox is ≤ 1x1 px drawn as one
  `fillRect` [65]; dashed strokes clipped to the container extent plus
  3 px, skipped when already in view; clipping changes dash phase at the
  edge [66].
- kothic: native `setLineDash` replaced a JS dash walker; IE11+ required;
  casings disappeared for OpenRailwayMap (still open) [67]. `0,0` dashes
  crashed Chromium in 2013; fixed 2026 with `normalizeDashes` and a unit
  test [68]. Line-end extension: identical neighbour coordinates gave NaN
  through division by zero; neighbours too close are skipped; lines entirely
  within the limit dropped [69]. Boundary bitmask for outlines; a real edge
  exactly on the tile border is not detected [70].

## globe.gl, iTowns

- globe.gl: polygon curvature resolution 10° → 5° default after a faster
  generator; `globeCurvatureResolution` 4; paths interpolated beyond
  `pathResolution` 2°; no numbers [71]. Fat lines (LineSegments2) could not
  be clicked until a three.js version with raycast for them [72].
- iTowns: pipes as merged cylinders with spherical joint wedges, one buffer
  per feature; round ends +2–7 % (avg 4.5 %) of 334.5 ms [73]. Uint16 →
  Uint32 indices after merged bus lines exceeded 65,535 vertices [74].

## TerriaJS

- GeoJSON tiled in the browser with geojson-vt and drawn by protomaps into
  imagery (default since 8.1.12); points stay Cesium entities; a regression
  dropped features in 8.8.0, fixed in 8.8.1; protomaps-leaflet fixed a
  5,400-vertex-per-tile limit [75]. CZML path resolution set to the data
  interval (86,400 s) [76]. Thick outlines as polylines on Windows [77].

## osgEarth

- Pick RTT lost thin horizontal and vertical draped lines; fixed only by the
  shader-expanded LineDrawable, not a bigger pick texture [78]. LineDrawable
  keeps an opt-in legacy GL line mode; costs prev/next attributes per vertex
  [79]. Stipple direction in unnormalised clip space; fixes for Intel/AMD
  precision, near-plane crossing, cosine clamped before `acos` [80].

## Mapnik

- Clipping default on since 2.1 (#1116); integer overflow of large shapes at
  high zoom hidden by clipping, reappeared when it was off (#2000); padding
  improved in 4.0 (#3909) [81]. Clip defaults to false since July 2014
  after a sequence of fixes (line clip box expanded, stroke-width-sensitive
  extent, offset-aware extent, reverted `clip_poly_line`, marker clipping
  disabled, polygon clipping off when reprojecting) [85]. Padding formula in
  SKILL.md, shared by AGG, Cairo and grid backends, multiplied by scale
  factor [86].
- Vertex converters chain clip, simplify, smooth, offset, transform; offset
  moved after smoothing (#2202); offset fixes for sharp angles (#3160) [82].
- The AGG "fast" line rasteriser has no dashes; `stroke-dashoffset` only in
  "full" and restarts per subpath [83].
- `text-dy` along a true offset line: a 20k-point polygon never finished;
  0.745 s after reverting the per-candidate closest-position search against
  1.048 s for 2.3.x [84].
- Adaptive smoothing: control-point strength `(angle − π/2)/(π/2)`, 0 at or
  below 90°, so corners survive [87]. Offset curl removal ignored a ring's
  closing joint after small rings lost their whole outline [88].

## MapServer

- Fast path for shapes entirely inside the clip rect; multiply by
  1/cellsize instead of dividing [89][92]. "Fully outside" deliberately not
  tested because the spatial query already discarded those shapes [92].
- #179: phantom line along the image edge from Liang-Barsky polygon
  clipping; a cleanup pass caused polygon flooding; a 2 px clip pad (1 px
  was not enough) hid it [90]. In 2012 the buffer came from the maximum over
  all styles, ×resolution factor, +2 px for polygons, in double precision;
  later expanded for style offsets [93].
- Simplification while projecting: keep a vertex only if more than 1 px²
  from the last kept one; lines keep first and last, polygons the first two
  and last two, rings under 4 points discarded; an off-by-one at the closing
  point broke polygons until #4143 [91].

## GeoServer

- Vector tile buffer multiplied by `max(oversampleX, oversampleY)` [94].
  Densification on reprojection opt-in (off) and dateline heuristic on by
  default, both switchable [95]. Coalesced linestrings fused by JTS
  LineMerger because roads are split at intersections [96].

## OsmAnd

- Zoom grid and hysteresis numbers in SKILL.md; the integer-level flip at
  x.5 was left without hysteresis to avoid changing relief and globe
  tessellation untested; arrow spacing uses the renderer's actual scale
  [97].
- A sentinel tile id for batching lines gave negative elevation scaling for
  tracks with per-point heights on flat maps; per-tile parts reintroduced
  ~1,100 failed heightmap lookups per frame for a 100-part track [98].
- Douglas-Peucker before stroking, epsilon from half-width in metres,
  radius/2 → radius/3, then on the centreline with joins rebuilt from kept
  points and a zoom-dependent radius [99]; later opt-in, skipped for
  coloured lines, tolerance `(lineWidth − outlineWidth) · scale ·
  screenScale / 3` [101].
- Polyline2D vendored (~500 lines), Paul Bourke segment intersection with
  epsilon checks replacing a raw determinant [100].
- Clip to the view bbox enlarged by 3x its size per side, rebuild after a
  shift of more than one bbox or a zoom change over 0.5, later 0.1 [102].

## Organic Maps

- PR #12692: cumulative metaline phase baked by the generator, renderer does
  a cached lookup and carries the clipped-start distance; old maps fall back
  to run time. The same PR drew cycling categories in one hue with solid,
  dashed, dotted treatments (different widths were hard to tell apart) and
  made the planned route solid and opaque with a darker outline, because a
  dashed route bypassed the outline path [103].
- Contours smoothed at render time: clip with guide points, 4 extra points
  per segment by centripetal Catmull-Rom (α 0.5), re-clip; gaps at tile
  edges fixed by inflating the pre-smoothing clip rect 30 % [104].

## mapsforge vtm, osmdroid

- vtm: one depth clear per translucent line style (first a global flag,
  then a per-style option); miter spikes remain [105]. `MIN_DIST = 1/8` tile
  unit, bevel vertices at least `4·MIN_DIST` apart, `Style.dropDistance`
  replacing `pointReduction` in 0.21 [106].
- osmdroid: Android's hardware renderer rasterised long Paths into a texture
  and lines vanished; `Canvas.drawLines` in chunks of 256 floats
  (64 segments) instead. Tried: disabling acceleration, segment culling,
  `clipRect`, `Path.op` (API 19+, "incredibly slow"), per-segment
  `drawLine` [107]. Clip area half-size = 2 × radius through the view
  corners + 10 %; fixed limits from `Integer.MAX_VALUE/8` to ±17,000 all
  failed somewhere [108].

## navit, galileo, walkers

- navit clips in the core before any driver, slightly slower on Qt5 which
  clips itself [109]; clip margin changed from max line width to 1/3 of the
  screen (3D widths vary), intersections cast to float to fix int overflow
  at high zoom [110].
- galileo tessellates each line once per LOD resolution to stop pointy joins
  [111].
- walkers: GPU buffers and uniform camera (numbers in SKILL.md), needs wgpu,
  so a glow app loses vector tiles [112]; tessellating into the drawn tile's
  pixel space cut one OpenFreeMap tile from 64,565 to 9,183 shapes and fixed
  an 8 px dash drawn as 2 px on a 1024 px tile, at the cost of tying decoded
  tiles to one size [113]; screen-pixel widths [114].

## cartopy

- Lines projected by adaptive bisection in target space until the chord is
  within a lateral tolerance and each piece is inside or outside the domain;
  stops at |Δt| ≤ 1e-6. project_linear: 9 s Shapely + bisection, 8 s
  transforming early, 4 s without bisection; the UTM example made 3.7 M
  pyproj calls (48 s vs 7.7 s before a migration). Rectangular domains skip
  per-segment covers/disjoint tests when every vertex is inside [115].
- Thresholds derived from globe semi-axes or x-limits instead of fixed
  metres; fixed values made small globes cut lines randomly; too high a
  threshold shows as jagged lines [116].
