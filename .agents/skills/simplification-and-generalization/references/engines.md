# Simplification and generalisation: engine by engine

Bracketed numbers refer to the Sources list in ../SKILL.md. Records were
mined from 28 engines; every engine below had at least one decision on
this topic.

## MapLibre GL JS

- GeoJSON sources go through geojson-vt in a worker and then follow the
  vector tile bucket path: one code path and per-zoom simplification, paid
  in worker memory and tiling time. 0.43 halved the memory and made tiling
  20-100% faster (#5799). geojson-vt projects with its own Mercator, so
  GeoJSON does not follow a custom CRS, and `setData` faster than the
  worker grows memory (#8585) [8].
- `classifyRings` keeps the 500 largest rings per polygon (first tried
  100), selected with quickselect, because "Earcut performance degrades
  with the # of rings". The smallest holes disappear silently [9].

## MapLibre Tile (MLT)

- Hilbert and ID feature sorting left the automatic sort set: together
  under 0.5% smaller for over 30% more encoder time; still available with
  `--sort all` [10].

## RustGIS

- Capped reads return an evenly spread sample, not the first N rows; at
  most 250,000 features per view (100,000 in the browser) in a window
  padded by half a view. A 6.48M-polygon GeoParquet at world view drew a
  136k sample in 1.4 s; at 1:250,000 every cell in 35 ms [12].
- #681 found the sample omitted valid features from maps and exports and
  added complete traversal in source order, in chunks of about 8 MiB,
  with simplification chosen from whole-layer statistics (an extra pass)
  and a shared 20,000-candidate label limit. Screen and export use the
  same traversal, so live redraws read the whole source [11][12].

## ortho-earth

- Columnar layer: GeoParquet row groups (or GeoPBF cut into spatial
  chunks) become float32 arrays relative to a chunk origin, with 2-3
  snapped LOD levels on the z12/9/6 pixel grid; a level removing under
  25% is skipped. Time to first frame stays flat in file size (4.4 MB:
  1,174 ms via topology against 70 ms via chunks; 32 MB of 1M points:
  1,307 against 255 ms, SwiftShader, relative). Paid: shared borders
  drawn twice, stepped LOD, no topology [13].
- Gint: every vertex of a shared arc carries a Visvalingam rank 0-63 and
  is drawn at zoom z when rank >= 3*(21-z); the vertex shader drops the
  rest. Neighbours keep identical vertex lists at every zoom, and no
  per-zoom geometry is baked. Per-vertex decode and projection dominate
  the vertex shader cost [14].
- PMTiles export calibrates the rank threshold per (arc, zoom) so VW keeps
  as many vertices as Douglas-Peucker (tippecanoe -S 1). The fixed rule was
  3% (countries) to 31% (ZCTA) larger than tippecanoe. Calibrated: NE
  countries z0 47,985 against 46,442; z10 471,927 against 471,774.
  Calibration took 0.1 s on 480k vertices and 4.2 s on 29M. Countries
  z0-10: about 6.5 s against tippecanoe's 58 s and GDAL's 780 s; ZCTA5 47 s
  against 251 s [15].
- Draw-time calibration was measured and declined. On pop-density-2020
  (1,897 polygons, 20,611 arcs) the fixed rule's error against DP was
  1-21% (max at z4: 52,580 against 46,542); a per-arc constant offset was
  worse (up to 49%), linear-in-zoom up to 27%, the full table 0-4%. For
  110m countries even the table stayed at 38% at z0 (rank granularity).
  The table would cost +25-50% GPU memory (+20-40 MB at N03 scale) and a
  shader change across 2 backends x 4 passes [16].
- Quantised coordinate keys (multiples of 100 at precision 5) put buckets
  into a quarter of the table with FxHash; a splitmix64 finaliser took the
  ZCTA topology from 161 s to 13 s (junctions 133 to 5.8 s, arc matching
  20.8 to 0.6 s), byte-identical [17].
- The line purifier picks the smallest grid shift whose cell registrations
  stay within 8x the segment count, back to the 730 m base grid if a cell
  exceeds 1,500 segments. World rivers 5,824 to 43 ms; constellation lines
  had crashed wasm after 7.5 s and now take 8 ms; outputs sha1-identical
  on 23 sets [18].
- Line LOD tiers built one per macrotask and never while the camera moves,
  trigger lowered from 3M to 200k edges, 16k-edge chunk ledgers for
  culling: NE 10m coastline vertex launches 406,580 to 6,287 (x64.7),
  texelFetch 1.21M to 14k [19].

## QGIS

- 2.2 render-time simplification (#8725, PR 980): vertices prefiltered by
  a map-to-pixel tolerance, sub-pixel features drawn as their bbox, only
  for render requests. qgis_bench, 10 iterations: 180.1 to 68.9 ms,
  88.6 to 9.5, 275.1 to 70.3, lines 8.3 to 1.5. A 300 MB contour shapefile
  loaded in 4 s instead of 25 s. Costs: gaps between adjacent polygons
  (seen in a 50 dpi composer export) and a factor with a UI warning [20].
- Editing, snapping and save-as get full geometry; layout export disables
  simplification, previews keep it ("users accept a 1 minute print but not
  a 1 minute screen render") [20].
- Simplification runs before symbol offsets, so offset lines can be wrong;
  accepted as an edge case because detecting offsets would read each
  feature twice [20].
- After the merge, zoomed-in rendering was 5-10x slower (1:1200 from under
  1 s to 6-12 s; 1:600 to 23 s); a reduced variant restored it. The thread
  does not isolate whether the patch or a clipper commit caused it [20].
- Antialiasing was disabled only for about-one-pixel geometry when the
  factor is above minimum, choosing quality over the larger speed-up [21].
- The first two and last two vertices of a line are never removed [22].
- Sparse-vertex skip: 2.7-8.6% per query on Swiss OSM roads in PostGIS
  (level 7: 37 to 36 ms; level 3: 114 to 109 ms) [23].
- The simplifier cast away const and overwrote shared WKB, so features got
  more generalised with each zoom out and in [24].
- The inverted polygon renderer applied a metre tolerance to degrees (about
  1 degree); now it simplifies first, then transforms, then disables
  further simplification [25].
- Layout PDF/SVG export: SnappedToGridGlobal at 0.1 px instead of
  per-feature SnapToGrid at 0.5 px; up to 1 px was considered [26].
- Maximum tolerance 5 to 30 px; Visvalingam added as an option, then a
  Visvalingam crash fixed [27].
- Provider-side: PostGIS ST_Simplify collapsed polygons and became
  ST_SnapToGrid, later with ST_RemoveRepeatedPoints for PostGIS 2.2; OGR
  gated on GDAL >= 1.11; Oracle added, gated, reverted without a stated
  reason [28].
- Symbol pipeline: clip, then simplify, then buffer for stroke paths; a
  "significant performance bump" from buffering fewer vertices [29].
- Label mask clip paths are always simplified in PDF/SVG export: much
  smaller files [30].
- Labels: makeValid reverted to buffer(0) because it was much slower
  [31]; big partly visible polygons are rectangle-clipped before repair,
  with the exact intersection only for rotated views [32].
- Clip rewritten for many inputs against few masks with prepared
  geometries and a containment shortcut: 1M lines against 2 polygons
  5 m 30 s to 10 s; 5M points 50 min to 30 s [33].

## GRASS GIS

- Arc-node topology: shared boundaries stored once with left and right
  areas; areas built from rings plus a centroid. OGR sources get only
  pseudo-topology, where simplification of adjacent areas "will not work
  properly". The design cites bad experience with simple-feature data [34].
- v.generalize: a faster topology check, then an "extremely fast" default
  with an "extremely slow" debugging mode [35].

## Marble (KDE)

- Natural Earth 110m at z0-1, 50m at z3-5, 10m at z7-9, with layers added
  level by level (roads from z7; railroads, ports, reefs only at z9) [36].
- Peaks within 3 km clustered with DBSCAN at bake; the highest shows at
  level 11, the rest from 13 [37].
- Node reduction: disabled for polygons, re-enabled below 17, replaced by
  Douglas-Peucker, tuned to simplify less, then fixed after roundabouts
  disappeared at level 15 and lower (BUG 373053) [38].
- Country polygons over about 40 kB kept only as a bbox with a fallback
  lookup; all polygons would be about 75 MB [39].
- An area cache keyed by argument address dropped random polygons at
  z11-15; removed with no measurable cost [40].
- Elements wholly inside a tile are emitted unclipped, keeping vertex
  order and the real id; inner rings not touching the tile are skipped [41].
- Real nodes next to synthetic clip nodes are protected; otherwise an
  L-shaped line reaching into a tile became a diagonal [42].
- The reducer runs only on levels that need it; z17 stays near verbatim [43].
- Skipping building sides under 1.4 px offset gave about 50% at level 17
  and was reverted the next day as "reinventing the wheel" [44].
- Areas under 1% of the tile area are dropped at levels 11-15 [45].

## OpenLayers and OpenLayers 2

- The general renderer keeps handling degenerate geometry but bypasses
  per-zoom Douglas-Peucker for read-only RenderFeatures from vector tiles.
  Restricting WebGL to pre-tessellated data was proposed and not adopted
  [46].
- Polygons simplified by quantisation (Schaub) plus point elimination;
  every coordinate in a batch is snapped so mixed input still shares
  edges; lines keep Douglas-Peucker [47].
- Canvas: `lineTo` only when the pixel changes, a large speed-up for thick
  lines [48].
- Tolerance half a device pixel; skipped when it cannot reduce [49]. The
  per-tolerance simplified-geometry cache was removed; only a
  "max min tolerance" shortcut remains [50].
- ol2 2.14: graticule lines by recursive bisection in geographic space,
  keeping a midpoint only if it deviates over half a pixel
  (squaredTolerance = resolution^2/4), capped at 1e5 iterations, instead
  of 50 fixed points [51]. LineString gained Douglas-Peucker `simplify`
  [52].

## Leaflet and protomaps-leaflet

- Leaflet clips to the view and simplifies per zoom at run time
  (`smoothFactor` 1.0, `noClip`); 0.3 sped up simplification for lines of
  tens of thousands of points. The FAQ sends very large data to
  server-rendered tiles plus UTFGrid [53].
- Clip bounds are padded by the stroke weight so no stroke appears on
  clip edges; only new clip-edge points are rounded [54].
- protomaps-leaflet uses the ceiling data zoom for fractional display
  zooms because it "improves generalized appearance" [55].

## Tangram and maptalks

- Tangram caps rings at 500 before earcut, but no code sets the `.area`
  its comparator reads, so the selection is arbitrary [56].
- Client-side geojson-vt culls tiny features per zoom; a filter that
  seemed zoom-dependent was features with missing properties appearing
  at some zooms [57].
- maptalks draws geometry whose pixel bbox is at most 1x1 as a fillRect
  instead of a path [58].

## d3-geo

- Every edge is a geodesic, resampled while the projected midpoint
  deviates more than `precision` (default sqrt(0.5) px; d2 > 4*delta2),
  depth up to 16, spans over 30 degrees always split. `precision(0)`
  turns it off [59].
- geoCircle and clipCircle step 6 to 2 degrees: maximum error 4.365 km to
  about 484 m, quadratic in the step, worst at latitude 45; 180 instead of
  60 points [60].

## openglobus

- Terrain decimation marks peaks and pits and moves them to the nearest
  inner mesh vertex; edges extrapolated with a minmod-limited slope.
  Summits survive coarse meshes; vertices no longer sit on a regular
  sample [61].

## WorldWind Java

- Visvalingam effective areas computed once per record with a min-heap,
  elimination area forced monotone; each LOD tile keeps vertices with
  area > resolution^2 and drops records under 4*resolution^2. All records
  are tessellated, visible or not, because recomputing on visibility change
  costs more [62].

## osgEarth

- Maximum visible range is separate from LOD selection; the coarsest
  representation of area features has no screen-size cutoff [63].
- Thinning by a hash reused from position generation kept the westernmost
  20% of each cell; a 4x4 spatial test failed 128 of 128 before the fix [63].
- Merged stands weighted by footprint area, not member count, to avoid
  gaps [63].
- Powerline features merged into one lost the `cables` attribute; fixed
  with `combine_lines=false`. Tower-per-vertex inference needs dense OSM
  lines simplified first (100 m in UTM) [64].

## Mapnik

- Vertex converters chain clip, simplify, smooth, offset, transform; 3.0
  moved offset after smoothing (#2202) [65].
- 3.0 raised AGG `vertex_dist_epsilon` (#2196); 2.2 added symbolizer
  simplification (#1385); 2.1 PostGIS `simplify_geometries` (#1179) [66].
- A 3.x slowdown was the clip default: unclipped z11 2.9 s, z12 5.1 s;
  clipped 1.5 s and 1.9 s, equal to 2.3.x [67].
- PostGIS tolerance 1/2 px collapsed small polygons; 1/8 lost a few lines,
  1/16 very small difference, 1/20 none for fills (#1639). A refactor
  reintroduced 1/2; fixed in #2393/#2394 [68][71].
- #1136, two separate comments: 8,094 Italian municipalities at 800x600,
  3,233.2 ms to 697.17 ms; and, in a different test with a fixed output
  size, 1,462,892 vertices in 2,183 geometries to 15,789. ST_Simplify chosen over
  SnapToGrid and over decimation, which can shrink shapes; opt-in because
  point layers only pay overhead [69].
- Clipping to the render extent for all symbolizers (2012) caused months
  of artefacts (trimmed edges, stroke width, offsets, markers,
  reprojection) and became false by default in 2014 [70].
- Adaptive smoothing scales control points by (angle - pi/2)/(pi/2), zero
  at 90 degrees or less: corners survive [72]. Fixed smoothing made
  OpenTopoMap contours intersect; Chaikin in PostGIS detached lines from
  junctions [72].
- Radial-distance mode dropped the last vertex until #4347 [73].
- Labels longer than their segment: merge same-name segments in the
  database (ST_LineMerge, grouped by styling attributes) [74].
- Visvalingam and Zhao-Saalfeld added beside Douglas-Peucker; Visvalingam
  sped up with an ordered set; `simplify_algorithm` became an expression
  [75].

## MapServer

- Anti-aliased renderers use MS_TRANSFORM_SIMPLIFY: keep a vertex only if
  over 1 px from the previous kept one; lines under 2 points dropped;
  doubles kept. ROUND "might create degenerate geometries" [76].
- #2381 and #4143: polygons keep the first two and last two points;
  rings under 4 points discarded [77].
- Per-layer TRANSFORM mode (ROUND, SNAPTOGRID, FULLRESOLUTION, SIMPLIFY)
  replaced a renderer-wide flag [78].
- Quantised triangle rings with height under 1 unit dropped; the signed
  area dropped every triangle of one winding until fixed two days later
  [79].
- `centerline()` from a Voronoi diagram for labels inside polygons: about
  3x slower (0.038 to 0.131 s); simple shapes need densify, slivers must
  be filtered first [80].

## GeoServer

- Vector tiles: `vt-attributes` and `vt-coalesce`; coalescing roads split
  at intersections made tiles about 50% smaller than attribute selection
  alone [81].
- feature-pregeneralized: geometries stored at several distances (e.g. 5,
  10, 20, 50), best fit picked per request [82].
- Advanced projection handling on by default; densification off because it
  slows rendering [83].
- Tolerance from target-CRS pixel spans, 0.8 px for source spans and 1.0 px
  for target spans, min of x and y [84].
- Style rules active at the scale build the query; a screenMap is set on
  supporting sources [85].
- SOLR: a stored centroid drawn as a square at scales above 1:50,000 [86].
- MVT pipeline transform, clip, simplify (was transform, simplify, clip)
  [87]; Douglas-Peucker for lines, topology-preserving for polygons [88].
- GEOMETRY_DISTANCE hint lets pregeneralised stores answer at about
  0.8 px, with in-memory simplification after [89].
- MapML: coordinates rounded to ceil(-log10(distance)) decimals [90];
  tolerance 0.1 to 0.8 px to match raster rendering [91].

## OsmAnd

- Route and track lines: Douglas-Peucker on the centreline before
  stroking, epsilon radius/2 then radius/3 the same day, first on the
  offset edge then on the centreline; radius zoom-dependent below z23 [92].
- Remaining coastline defects were attributed to the generator's
  Douglas-Peucker, not patched in the renderer [93].
- GPU line simplification made opt-in, skipped for per-point colours;
  tolerance (lineWidth - outlineWidth) * scale * screenScale / 3 [94].
- Visible-area simplification of objects over 1,000 points (runs outside
  the bbox collapsed, double-buffered per object) [98] was turned off for
  coastlines and then all areas in October 2026; the bbox replacement for
  collapsed enclosing rings lasted one day [95].
- Coastline polygonisation swapped repeatedly (#280, #365 back to legacy,
  #1094 an alternative) [96].
- Dropping closed coastline rings under 4 points made St Petersburg
  flood [97].

## Organic Maps

- Four geometry bands per file: world z3,5,7,9; countries z10,12,14,17. A
  visibility change crossing a band needs regenerated maps [99]. The
  scale set was once changed and reverted to 10, 12, 14, 17 [105].
- Features with up to 14 points keep geometry inline with a 2-bit per-point
  min-band mask (0 to 3 bytes); levels are nested by simplifying the
  previous one; first and last points are never dropped [100].
- A coarser level is stored only if at least 2 elements fewer and 1.5x
  smaller (kGeomMinDiff, kGeomMinFactor) [101].
- Areas are simplified per level, then triangulated in the generator;
  50 to 10 outline points does not give 5x fewer triangles. Road lines
  keep source points at the top level for routing; coastlines are
  simplified as one zoom higher [102].
- Borders: shared arcs interned and simplified once with Douglas-Peucker;
  arcs that would invalidate a ring are locked; four offshore outlines
  restored; outputs must not be re-simplified [103].
- Isolines: per-region profiles of 20 to 1,000 m; regions too large even
  for 100 m dropped (Sakha 257,829,111 bytes); "poor profile is completely
  useless" [104].
- Contours smoothed per tile with centripetal Catmull-Rom, 4 extra points
  per segment; gaps fixed by inflating the clip rect by 30% [106].

## mapsforge and VTM

- Writer: simplification factor 2.5 px at the interval's max zoom, only
  for base zooms up to 12 [107].
- Tile clip geometry built once per tile and contained envelopes skip
  clipping: about 30% faster in RAM mode, little in HD mode [108].
- VTM LineBucket drops points closer than 1/8 tile unit; a boolean
  pointReduction became a numeric per-style dropDistance [109].
- VTM reader simplification between z8 and z11 is off by default; lines,
  land/sea polygons and listed tags are exempt; an earlier extra
  simplification over-simplified land polygons [110].

## Galileo and cartopy

- Galileo tessellates lines once per LOD resolution; sub-pixel segments
  had made pointy miter joins [111].
- cartopy picks Natural Earth 110m, 50m (under 50 degrees) or 10m (under
  15 degrees) from the view extent; GSHHS c/l/i/h/f at 20/10/2/0.5/0.1
  degrees [112].
