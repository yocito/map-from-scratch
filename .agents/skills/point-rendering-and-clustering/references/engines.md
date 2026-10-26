# Point rendering and clustering: engine by engine

Bracketed numbers refer to the Sources list in [../SKILL.md](../SKILL.md).
Each entry: what was decided, the alternative, the trade-off, the evidence.

## MapLibre GL JS and MLT

- Large-data guide: overlap checking of symbols is computationally
  intensive; allow-overlap "can significantly reduce this". Also: GeoJSON
  clustering (`clusterMaxZoom` 14, `clusterRadius` 50 in the example, 50 is
  the default), a GeoJSON source `maxzoom` of 12 for most point sources
  instead of the default, and layer `minzoom` above 0. No numbers [1].
- MLT: repeated vertices may go into a dictionary sorted by Hilbert curve
  (encoders should, decoders never depend on it) or into delta-coded Morton
  codes. MortonRle and plain Morton were removed as "not very sensible & not
  implemented"; a HyperLogLog estimate for dictionary sizing was replaced by
  an exact count. Pays one indirection per vertex; worth it only when
  vertices repeat [2].

## navara (MapLibre's 3D engine)

- `InstancedSpriteMesh` with real GPU instancing replaced
  `InstancedPointMesh` and `InstancedBillboardMesh`, which were not
  instanced. Fixed flicker and picking (videos in the PR). Review caught
  three regressions: billboards invisible on the debug page, squashed
  vertically, colour not changeable. Add checks for per-instance size,
  aspect ratio and colour when porting attributes [3].
- The pnts reader targets Draco-compressed point clouds because most
  datasets found used Draco; uncompressed ones load with wrong colours;
  batched points unsupported because no file seen used the batch table [4].

## RustGIS

- Per-view caps with an evenly spread sample: 250,000 (desktop, local),
  100,000 (browser, local), 60,000 (desktop, remote), 30,000 (browser,
  remote). A tooltip says the layer is a sample. GeoParquet 0.1 degree grid
  (50 MB, 1.6M polygons): a 183,000-feature view in 0.15 s; global grid
  (190 MB, 6.5M polygons): a 136,000 sample in 0.27 s [5].
- Sources above 100,000 features become read-only streamed layers: a window
  padded by half a view on each side, re-read when the view leaves it or
  zooms well inside a sampled one; one read at a time per layer [6].
- LAS/LAZ/COPC: one evenly spread sample of at most 2 million points
  (500,000 in the browser), not the COPC index; remote files downloaded
  whole; decompression capped at 400 million points (40 million on the web)
  [6].
- CPU drawing: a tiny-skia path per point cost about 5 us, 600 ms a frame
  at 100k points. Markers are now drawn once per quarter-pixel offset into
  a sprite (cache of at most 1024 sprites of reach 24 px or less, about
  10 MB) and copied: 10-14x faster. Shapes under a device pixel blend their
  coverage directly instead of using the rasteriser (about 1 us per path
  however small). Rings are clipped to a box around the image after a
  far-zoomed coastline made tiny-skia index past its buffer [7].

## reearth-visualizer

- `FEATURE_DELEGATE_THRESHOLD = 6000`: above it, a GeoJSON layer is handed
  to Cesium's data-source loader; below, one React component per feature,
  memoised in an LRU (max 10,000) keyed by layer id, feature id and
  `JSON.stringify` of the appearance [8].

## Cesium

- Point-cloud style expressions are transpiled to GLSL; the shader path
  restricts operator types (numbers for comparisons and arithmetic,
  booleans for `!`), constant subexpressions should be folded, and a style
  change recompiles the shader. Principle: the language must be
  implementable by an interpreter and by a GLSL transpiler [9].
- `PointVisualizer` produced thousands of canvases from sampled float
  pixel sizes; sizes are rounded to integers, and non-outlined points scale
  one larger texture [10].
- Point-cloud `show`: the vertex shader no longer computes
  `gl_Position = show * positionClip`; a varying lets the fragment shader
  discard hidden points. Fixes "point cloud filtering performance on certain
  hardware" (#11270) [11].

## deck.gl

- Grid/ScreenGrid aggregation on CPU or GPU. Benchmark (MacBook Pro,
  Radeon), iterations/s CPU vs GPU: 25K 535 vs 359; 100K 119 vs 437;
  1M 12.7 vs 158. ScreenGrid GPU aggregation "can be 10x faster". GPU memory
  is proportional to all possible cells, CPU to non-empty cells; GPU is
  float32 and may differ from CPU; quantile/ordinal scales cost a one-time
  read-back from GPU to CPU. `gpuAggregation` defaults to `true`; CPU is the
  fallback without browser support, under WebGPU, or with a custom
  aggregator or value accessor. `GPUGridLayer`/`CPUGridLayer` (v7.1) were
  removed in v9.1 in favour of `GridLayer` with `gpuAggregation` [12].
- Performance guide: a 5 px radius scatterplot point is ~100 fragments;
  10 million points up to 1e9 fragment invocations a frame. Retina doubles
  each axis (4x pixels); `useDevicePixels` can lower it, "largely
  imperceptible" on phones. luma.gl debug mode (error query after every
  call) is another common pitfall [13].
- `CollisionFilterExtension` example: the maintainer called a scatterplot
  showcase "relatively weak" (overlapping points are usually a heatmap or
  clusters, "aggregation, not reduction"); another reviewer said the feature
  was built for labelling. The contributor argued ordinal categories are
  badly served by heatmaps. The PR was merged as a road-labelling example
  [14].
- An 8-PR refactor put CPU and GPU aggregation behind one `Aggregator`
  interface; `AggregationLayer` no longer handles data formats, projection
  or prop names [15].
- `ScatterplotLayer`: 16-sided instanced `TRIANGLE_FAN` plus `LINE_LOOP`
  outlines replaced by a unit square per instance with a fragment-shader
  discard; outline as an inner radius; "about 3x faster"; the Chrome
  `gl.lineWidth` workaround was removed. Edges from discard are hard [16].
- Latitude bounds via `Math.min.apply` overflowed the stack on large
  inputs; replaced by one loop [17].

## QGIS

- Point-cloud filters ("Z > 120 and Classification in (2,3,6)"): the first
  version had its own lexer and parser because `QgsExpression` evaluates via
  `QVariant`/`QgsFeature`, "simply too slow" for millions of points. After
  review it parses with `QgsExpression` and compiles supported nodes to
  `QgsPointCloudExpressionNode`s evaluated on point blocks; unsupported
  nodes are parse errors, no fallback [18].
- Remote EPT reuses the local EPT provider; only index access differs, and
  the URL goes in the `path` URI key as GDAL/OGR do [19].
- Features are registered as label obstacles only if the layer has a label
  or diagram provider: "Cuts render time by ~60%" on point layers [20].
- Markers reuse the already transformed, simplified point array instead of
  recomputing it [21].
- 2D point clouds: `fillRect` squares instead of `setPen` + `drawPoint`,
  anti-aliasing always off: "orders of magnitude faster" [22].
- Point budget minimum 100,000 because whole nodes load and small budgets
  would visibly be exceeded; a per-chunk primitive budget was removed from
  the generic chunk loader (no reason given) [23].

## GRASS

- Per-feature 6-double boxes removed from topology structures in r46898
  (2011); for points the box took "2-3 times more than the point itself".
  Boxes for long lines and areas are computed at query time [24].
- `r.in.pdal` sums per cell with Neumaier's improved Kahan-Babuska
  algorithm and computes variance with Welford's algorithm, unlike the
  naive sums of `r.in.lidar` [25].

## Marble

- KML task list (plans, no measurements): level of detail while parsing,
  sorting placemarks during parsing, a cache for large documents [26].
- Tile creator: peaks no more than 3 km apart are clustered with DBSCAN;
  the highest of each cluster appears at level 11, the others from 13 [27].

## OpenLayers and OpenLayers 2

- WebGL `CircleReplay` with a fragment distance check instead of
  triangulation; on Canvas circles still go through the polygon replay. The
  new replay type changed Canvas draw order; expected images and thresholds
  had to change [28].
- Nov 2018: the experimental WebGL map, tile, image and vector renderers,
  replays, immediate renderer and `AtlasManager` were deleted (one commit,
  47 files, 7,738 deletions) for `WebGLHelper` plus `WebGLPointsLayer`;
  Heatmap was rebuilt on it. WebGL tiles returned in 2021 [29].
- ol2 `Strategy.Cluster`: `distance` 20 px; `threshold` shows clusters
  smaller than N as their original features; recomputed per resolution
  [30].

## Leaflet

- Leaflet.markercluster (outside core): greedy clustering at max zoom,
  then each zoom upward into a tree used to find on-screen clusters;
  `L.DistanceGrid` with cells the size of the clustering distance. Greedy
  clusters depend on input order; the FAQ recommends clustering for
  "thousands of markers" [31].
- A `leaflet-dragging` class on `<body>` made drag start slow on maps with
  many elements (style recalculation even with an empty class in Chrome);
  cursor rules moved to a `leaflet-drag-target` class [32].

## Tangram

- Fill and outline in one quad: smoothstep coverage over one `length()`,
  stroke composited over fill in the shader, quad enlarged in the vertex
  shader; the "+1px" outline bump was removed. Sprites needed explicit
  texcoords and pixel snapping, broken in the first version. Alternative
  not adopted: `GL_POINTS` to cut vertex work 4-6x for small points [33].
- Collision grid cell count = floor(max labels in any tile / tile size);
  0 means no grid, which is typical for basemaps. No numbers [34].

## Polymaps and d3-geo

- `geoJson.scale('fixed')` keeps points at constant screen size by
  appending an inverse scale after the tile update ('move' event) [35].
- d3-geo caches the circle sub-path while radius and digits are unchanged
  [36].

## iTowns

- Point shader: removed the discard on `vColor.a == 0`; only fragments
  outside the round point are discarded. Point materials forced to
  `transparent = true`, `depthWrite = false`, with a 256x1 visibility
  texture per class; follow-up fixes for depth and transparency with
  terrain and 3D tiles [37].
- `view.pickObjectsAt(mouse, layer)`: raycasting by default, layers bring
  their own; the author stated that raycasting millions of points does not
  work well [38].
- Potree attributes in separate buffers: three.js `InterleavedBuffer`
  sets the stride in elements, so a 5-byte point (32-bit position, 8-bit
  class) could not be described [39].
- Point budget: `.cin` (evenly distributed) draws a percentage of each
  node; Potree `.bin` sorts nodes by importance and stops at the budget.
  Point-cloud SSE simplified to the projected average point spacing (no
  convex hull). Both reverted 2018-04-27, relanded 2018-04-30 [40].
- `LabelLayer` `performance` option: labels sorted by order and inserted
  into a screen grid sized to the node's largest screen footprint at load;
  those that fail are removed permanently. Advised against when data is
  already generalised [41].
- POINT features styled with a model become one `InstancedMesh` per model
  sub-mesh; orientation via up/front vectors added later [42].
- Nodes leaving the visible set now set `obj.visible = false`; before, they
  were marked not visible but still drawn ("point cloud performance
  issue", with a unit test) [43].

## TerriaJS

- CSV time series: without an id column each row is a point existing until
  the next time; an id column (set in the JSON config) groups rows into one
  moving feature [44].
- Leaflet visualizer keeps per-entity layer and last position, colour,
  outline and fill; calls `setLatLngs`/`setStyle` only on change ("Made
  polygons drastically faster in 2D") [45].
- CSV points: a CZML `point` (pixelSize 5, 1 px outline) instead of an image
  billboard [46].
- Realtime GTFS: billboards reused per vehicle, colour and position set only
  when changed, removals via a Set of ids, entity events suspended during
  the update. No numbers [47].
- `PreSampledProperty` buffers samples and calls `addSamples` once; if all
  samples are equal it returns a constant property. De-duplication of
  times moved from O(n^2) to a Set [48].
- `explodeMultiPoints`: each MultiPoint becomes Point features with the
  same properties [49].

## vts-browser-js

- Globe back-face `culling` hid labels and icons but not points; alpha-0
  points stayed clickable on the far side of the planet. No maintainer
  reply [50].

## osgEarth

- Procedural vegetation: placements from a stable indexed sequence per
  cell, so raising density appends; per-cell counts use spherical cell
  area. Placement is uniform random, not minimum-spacing [51].
- Thinning rank reused `mix(id)`, which also gave the cell-local X; keeping
  20% kept the westernmost 20% of each cell (repeating grass bands). Salted
  independently; a 4x4-grid regression at 20% and 50% across two seeds
  failed all 128 checks on the old rank. Count and rank-distribution tests
  had not checked spatial correlation [51].
- Distant forest: shared per-species card meshes and four vec4s (64 bytes)
  per tree; one instance per spatial cluster (32 medium, 64 far). Grouping
  reduces instance and culling records, "not the number of tree cards or
  their fragment work" [51].
- Coverage stands weighted by footprint area over one tree's footprint,
  capped by the authored tree count; stands at mixed coverage or exclusions
  fall back to tree cards. Visual A/B only, "not a claim of measured
  frame-rate improvement" [51].
- `smooth` points vanished in `QOpenGLWidget` (RTX 3070 Ti, osgEarth
  3.7.1) until a 3.3 core `QSurfaceFormat` was requested; stars in the sky
  model too [52].
- Declutter: `max_objects` caps the drawables the sort considers; earlier
  changes reused vectors and skipped invisible drawables. No numbers [53].
- Instancing: UBOs (2012), matrix textures (2013), texture buffer objects
  (2015); each matrix transposed into 3 vec4s with the object id in the
  fourth column; more TBOs when one is full [54].
- `osgearth_cluster`: `range(x-r, y-r, x+r, y+r)` instead of
  `within(x, y, r)` "since range is much faster"; neighbourhoods become
  square [55].

## Mapnik, MapServer, TileMill

- Mapnik 3.0 `dot` symbolizer (Dec 2014): a filled AGG ellipse per point
  with a solid scanline renderer, no placement, collision or SVG; 3.0 also
  reduced memory for layers with many points. No numbers [56].
- MapServer `CLUSTER_ALGORITHM=SIMPLE`: attach each point to an existing
  cluster in range (via the quadtree) or start a new one; running mean and
  variance; `KEEP_LOCATIONS` on by default. `FULL` (rank-based iterative
  merging) remains. No timings [57].
- TileMill auto-style: `marker-ignore-placement:true` next to
  `marker-allow-overlap:true` "to help performance" [58].

## osmdroid, galileo, walkers

- osmdroid: `RadiusMarkerClusterer` replaced `GridMarkerClusterer` as the
  default, "a much better clustering algorithm". No numbers [59].
- galileo: no real-radius circle. The maintainer suggested a symbol that
  draws the point as an approximating polygon and planned an `Arc`
  primitive; the requester's workaround used 50 points from the geodesic
  destination formula; an SDF circle was proposed and not built [60].
- walkers: `GroupedPlaces` rebuilt on `rstar` ("considerably faster");
  GeoJSON features indexed into an R-tree [61].

## cartopy

- Quiver and barbs with `regrid_shape`: a regular grid in the target
  projection, mapped back to the source CRS, interpolated there, then
  vectors transformed; four tests broke with the behaviour change [62].
  For symbols thinned to an even screen grid: choose positions in the
  output projection, sample data in its native grid.
