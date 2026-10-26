---
name: simplification-and-generalization
description: How 28 map engines reduce geometry for the scale it is drawn at (Douglas-Peucker, Visvalingam ranks, snap-to-grid, 1-pixel filters, shared-arc simplification, per-zoom levels, dropping small features) and what they measured and reverted. Load it before choosing a simplification tolerance or algorithm in bake.ts, when a request spans several zoom levels and you must decide between one bake, several baked levels or a per-vertex rank, when adjacent polygons (admin areas, choropleths, land cover) are simplified, or when slivers, gaps between neighbours, vanished islands or roundabouts, spiky joins or a size budget point at the generalisation step.
---

# Simplification and generalisation: tolerance, topology and levels, decided at bake time

Source geometry carries far more vertices than a screen can show. Every
engine reduces it, and every engine had to answer the same questions:
where the reduction runs (data source, tiler, render loop, export), in
which coordinate space and with what tolerance, with which algorithm per
geometry type, how to keep neighbouring polygons watertight, how many
levels of detail to store, and which whole features to drop at a scale.
General engines mostly answer at run time, because they cannot know the
data or the zoom in advance, and their history is full of tolerances
that collapsed polygons, simplifiers that broke shared borders, and
caches that made things worse. A renderer here knows its data, its
projection and its zoom range at bake time [1], so the reduction runs
once in `bake.ts` and the renderer only selects what was baked. What
carries over from the engines is the evidence about tolerances,
topology, order of operations and the cost of extra levels.

Per-engine detail, with all numbers: [references/engines.md](references/engines.md).
Related skills: tile-lod-and-overzoom (which level to draw),
vector-tile-encoding (clipping into tiles), polygon-triangulation
(validity after simplification), line-tessellation (stroke-side
simplification) [7].

## Where this repo stands

- `tools/geo.ts` has one simplifier: iterative Douglas-Peucker that
  always keeps both endpoints; tolerance 0 returns the input [2]. Its
  test checks endpoints and collinear removal only [2].
- 01 bakes 47 prefectures on a 1,000-unit grid with tolerance 1.2 units
  (about 1 px at 1,000 px wide) and drops rings under 12 square units [3].
- 02 and 03 simplify each country ring separately in Equal Earth with a
  tolerance of 1.5 device pixels at the deepest zoom (32x on a phone,
  8x on a 1,280 px window), then quantise to 16 bits and drop rings
  under 4 points [4][5]. One bake serves every zoom; at the default view
  the tolerance is a small fraction of a pixel.
- Because the rings are simplified one by one, a border shared by two
  countries is simplified twice with different ring endpoints; nothing
  in the bake guarantees the two copies stay identical [4][5].
- 07 dissolves all countries into one land polygon before simplifying,
  because shared borders were shipped twice: 62 KB to 43 KB gzip at the
  same tolerance. It removes consecutive duplicates created by
  quantisation [6].

## Decision 1: where the reduction runs

Engines that simplify at run time:

- QGIS added map-to-pixel vertex prefiltering for rendering only: 2.5x
  to 10x faster draws of over-dense layers zoomed out, at the cost of
  possible gaps between adjacent polygons and a user-facing
  simplification factor. A reviewer noted the gain is small when data
  already suits the scale [20]. Editing, snapping and saving get full
  geometry; layout export turns simplification off while low-resolution
  previews keep it [20].
- MapServer folds a 1-px filter into the world-to-pixel transform for
  every anti-aliased renderer [76][77]; Mapnik offers source-side
  ST_Simplify and symbolizer-level simplification [66][69]; Leaflet
  clips and simplifies per zoom with `smoothFactor` and points heavy
  data to server-rendered tiles [53].
- OpenLayers simplifies to half a device pixel per resolution [49] and
  skips it for vector tiles, which are already generalised [46].
  MapLibre tiles GeoJSON with geojson-vt in a worker for per-zoom
  simplification, paying worker memory and tiling time [8].

What went wrong at run time:

- A QGIS simplifier wrote into a shared geometry buffer; zooming out and
  in made features "more and more generalised" [24].
- OpenLayers removed its per-tolerance cache of simplified geometries
  because it grew with every resolution [50]; Marble removed an area
  cache keyed by object address that randomly dropped polygons, and it
  had made no measurable difference [40].
- After QGIS merged its speed-up, zoomed-in rendering became about
  5-10x slower (1:1200 went from under 1 s to 6-12 s, 1:600 from well
  under 1 s to 23 s). The tester saw 23 s with simplification both on
  and off, and the thread does not isolate the cause; another
  commenter suspected a clipper commit [20].

For a renderer here: simplify in `bake.ts`, never in the frame loop,
and keep the canonical geometry untouched. If a separate export, hit
test or analysis path needs exact geometry, give it its own
full-resolution copy, as QGIS and RustGIS do [20][11]. RustGIS samples
evenly for interactive overviews but found the sample omitted valid
features from exports, and added complete chunked traversal [11][12].

Only for user-supplied or editable geometry, the cheap run-time filters
on record: call Canvas `lineTo` only when the pixel changes, which
OpenLayers found speeds up thick lines [48]; a per-layer vertex drop
distance instead of one constant, as VTM moved to [109].

## Decision 2: the tolerance, its space and its size

Space. Compute the tolerance in the space the geometry is drawn in,
after projection:

- QGIS computed a tolerance in metres and applied it to a layer in
  degrees, simplifying with about 1 degree; the fix simplifies first,
  then transforms, and only once [25].
- GeoServer used the source-CRS tolerance after transforming to the
  target CRS; it now computes the tolerance from target pixel spans,
  taking the smaller of x and y [84].
- Mapnik's server-side tolerance is in output units and is wrong when
  source and output projections differ [68].

Size. Engines settled on very different values, and the differences
come from what the geometry is used for:

| Engine | Tolerance | Why |
| --- | --- | --- |
| Mapnik PostGIS | 1/20 px (was 1/2 px) | half a pixel collapsed small polygons; 1/20 looked identical to unsimplified fills, and 1/16 was still "a big improvement" [68][71] |
| GeoServer vector tiles | 0.8 px | "to make sure the generalization isn't too much" [84][89] |
| GeoServer MapML | 0.1 px raised to 0.8 px | to match its raster renderer [91] |
| OpenLayers | 0.5 device px | invisible at the current zoom [49] |
| d3-geo resampling | 0.707 px | adaptive curve densification [59] |
| QGIS print export | 0.1 px on a global grid | "play it safe" against slivers [26] |
| MapServer | 1 px from the previous kept vertex | "naive simplification" in the transform [77] |
| mapsforge writer | 2.5 px at the interval's max zoom, base zooms up to 12 only | full geometry for overzoom to z21 [107] |
| OsmAnd routes | a third of the stroke half-width | tightened from half the half-width the same day [92][94] |
| repo examples | 1.2 units or 1.5 device px at the deepest zoom | one bake for all zooms [3][4][5][6] |

Mapnik measured the payoff of database-side simplification in two
separate tests: under certain conditions with a fixed output size,
1,462,892 vertices in 2,183 geometries became 15,789; and rendering all
8,094 Italian municipalities at 800x600 went from 3,233 ms to 697 ms
[69]. QGIS raised its maximum
tolerance from 5 to 30 px and left the visual risk to the user [27].

For a renderer here: express the tolerance in device pixels at the
deepest zoom the baked level must serve, as the examples do [4][5].
For filled polygons stay well under a pixel or protect small rings
explicitly (Decision 6). For stroked lines the stroke width hides more:
OsmAnd tightened its route tolerance from half to a third of the stroke
half-width [92][94]. Mapnik's 1/20 px default was lost once in a
refactor and restored [68][71]; a regression test with tiny polygons
catches that kind of change.

## Decision 3: algorithm per geometry type

- Lines: Douglas-Peucker. GeoServer's vector tiles module stopped
  using the topology-preserving simplifier for lines and uses plain
  Douglas-Peucker for them, keeping topology preservation for polygons;
  the code comment it replaced said only that Douglas-Peucker "does NOT
  do a good job with polygons" [88].
- Polygons in a coverage: snap to a grid. OpenLayers simplifies
  polygons by quantisation plus point elimination and snaps every
  coordinate of the batch so neighbours share edges; lines keep
  Douglas-Peucker [47]. QGIS PDF/SVG export uses a global snap grid at
  0.1 px, which "avoids all chance of slivers or overlaps" [26]. QGIS's
  PostGIS provider swapped ST_Simplify for ST_SnapToGrid after polygons
  collapsed [28].
- Visvalingam when one pass must serve many zooms: WorldWind computes
  every vertex's effective area once with a min-heap (monotone
  elimination area), then each tile keeps vertices above resolution
  squared and drops records under 4 times resolution squared [62].
  Mapnik made Visvalingam "a lot faster" with an ordered set instead of
  re-sorting [75].
- Radial distance (drop a vertex within tolerance of the last kept one)
  is the cheapest and does not bound deviation; Mapnik chose
  Douglas-Peucker over plain decimation for that reason [69], and
  MapServer calls its own 1-px filter naive [77].
- Endpoints and closing points:
  - QGIS never removes the first two or last two vertices of a line, so
    the angles at start and end, which arrows and joins use, stay the
    same [22].
  - MapServer keeps the first two and last two points of a ring, because
    the last repeats the first; an off-by-one there broke polygons
    (#4143). Rings under 4 points are discarded [77].
  - Mapnik's radial mode dropped the last vertex until #4347 [73].
- Skip guards are cheap but small: QGIS returns early when vertices are
  already sparser than twice the tolerance and gained only 2.7-8.6% on
  Swiss OSM roads [23].

For a renderer here: `simplify()` in `tools/geo.ts` is Douglas-Peucker
with pinned endpoints [2], right for lines and for disjoint polygons.
For a polygon coverage that is drawn per feature, use shared arcs or a
global grid (Decision 4). Keep the first and last segment of a line
when its ends carry arrows or caps.

## Decision 4: adjacent polygons (choropleths, admin areas, land cover)

Simplifying each polygon on its own moves a shared border differently on
each side, which opens gaps and slivers. Engines fixed this in three
ways:

1. Shared arcs, simplified once. GRASS stores a common boundary once
   with its left and right areas; with simple-feature input it has
   only pseudo-topology, and then "smoothing, simplification, removing
   small areas etc. will not work properly for adjacent areas" [34].
   Organic Maps interns vertices and edges across all region files and
   simplifies each common arc once with Douglas-Peucker; arcs that would
   make a valid ring invalid are locked. Four offshore outlines (Bermuda,
   Cape Verde, Faroe Islands, Malta) were excluded because Douglas-Peucker
   removed formerly covered area. Its docs warn not to re-simplify
   outputs, since each run adds another epsilon of displacement [103].
   ortho-earth gives each vertex of a shared arc a Visvalingam rank, so
   both sides keep the identical vertex list at every zoom [14].
2. A global snap grid: OpenLayers and QGIS export, as in Decision 3
   [47][26].
3. Exempt or dissolve. mapsforge VTM exempts land/sea polygons from its
   reader-side simplification, which had shown gaps between tiles [110];
   example 07 dissolved all countries into one land polygon (62 to
   43 KB gzip) [6].

Topology passes cost bake time; two cheap fixes are on record. ortho-earth
replaced FxHash with a splitmix64 finaliser for quantised coordinate keys.
Their low bits were always zero, and the ZCTA topology build went from
161 s to 13 s with byte-identical output [17]. GRASS runs a fast local
topology check by default and keeps the exhaustive one for debugging [35].

For a renderer here: one colour, no per-feature identity, dissolve
first [6]. Per-feature fills or borders: build arcs at bake (TopoJSON
style), simplify each arc once, rebuild rings, and protect small islands.
At 16-bit quantisation, also check that per-ring simplification as in 02
and 03 [4][5] does not open gaps at the deepest zoom; the repo has no
check for this yet.

## Decision 5: how many levels of detail to store

| Approach | Who | Cost |
| --- | --- | --- |
| One bake for all zooms | repo examples [3][4][5][6] | the deepest zoom sets the vertex count everywhere |
| A few baked bands | Organic Maps: 4 per file (z3,5,7,9 world; z10,12,14,17 countries) [99][105]; GeoServer pregeneralised copies at e.g. 5, 10, 20, 50 [82][89] | duplicated geometry; Organic Maps must regenerate maps when a style crosses a band [99] |
| Nested levels with a per-vertex min-zoom | Organic Maps: 2 bits per point for features up to 14 points, levels nested by simplifying the previous one [100]; WorldWind effective area [62]; ortho-earth rank 0-63 tested in the vertex shader [14] | one copy; per-vertex work or a mask |
| A pre-generalised source per zoom | Marble: Natural Earth 110m at z0-1, 50m at z3-5, 10m at z7-9 [36]; cartopy switches by view extent in degrees [112] | curated quality for free; discrete jumps |

Evidence that bears on the choice:

- Drop a level that saves little. Organic Maps keeps a coarser level
  only if it has at least 2 fewer elements and is at least 1.5 times
  smaller than the next detailed one [101]; ortho-earth skips a chunk
  LOD that removes under 25% [13].
- Triangles do not shrink like vertices: Organic Maps notes 50 to 10
  outline points does not give 5 times fewer triangles [101][102]. Count
  triangles per level.
- Keep the top level verbatim when it is also the overzoom source
  (Marble z17 [43]; mapsforge simplifies only up to base zoom 12 [107];
  Organic Maps keeps road geometry for routing [102]).
- Calibrating against an established tool: ortho-earth's fixed rank rule
  came out 3% (countries) to 31% (ZIP areas) larger than tippecanoe;
  per-arc calibration to Douglas-Peucker counts matched it (z10: 471,927
  against 471,774 vertices) at 0.1 s on 480k vertices [15]. It then
  measured the same calibration for draw time and declined it: +25-50%
  GPU memory for a density error of about 10% in z3-5 only, and a cheap
  per-arc constant offset was worse than the fixed rule (up to 49%) [16].
- Line LOD tiers for whole-world lines: ortho-earth cut coastline vertex
  launches from 406,580 to 6,287 (x64.7) and lowered the trigger from 3M
  to 200k edges [19]. Galileo tessellates lines once per LOD because
  sub-pixel segments made miter joins spike [111].
- Search costs: MLT dropped Hilbert and ID sort orders from its automatic
  set because together they gained under 0.5% in size for over 30% more
  encoder time [10].

For a renderer here: if the zoom range is up to about 8x and the gzip
budget holds, one bake is enough (the examples). If the deepest zoom
inflates the default view, bake two to four bands, each at its own
tolerance, and keep a band only if it is clearly smaller. Choose a
per-vertex rank only if one GPU buffer must serve a continuous zoom
range, and measure the simple rule before adding per-element tables [16].

## Decision 6: dropping small parts and whole features

- Small rings collapse first. Mapnik's half-pixel tolerance made small
  polygons vanish [68]. Marble's Douglas-Peucker lost roundabouts at
  level 15 and below [38]. MapServer drops quantised triangle rings
  thinner than 1 unit, and shipped a signed-area bug that dropped every
  triangle of one winding for two days [79].
- Dropping rings can change fills. OsmAnd flooded St Petersburg by
  skipping closed coastline rings under 4 points [97], and moved
  coastline repair to the data generator [93].
- Size thresholds tied to the level: Marble drops areas under 1% of the
  tile area at levels 11-15 [45]; WorldWind drops records under 4
  resolution squared [62]; 01 drops islands under 12 square units [3].
- Hole caps: MapLibre keeps the 500 largest rings per polygon with
  quickselect [9]; Tangram copied the cap, but nothing sets the ring area
  its comparator reads, so its choice is arbitrary [56].
- Sub-pixel features as a dot: QGIS replaces sub-pixel features by their
  bbox [20]; maptalks draws a 1x1 fillRect [58].
- Points and representatives: Marble clusters peaks within 3 km with
  DBSCAN and shows only the highest at level 11 [37]; GeoServer draws a
  stored centroid instead of complex polygons at small scales [86];
  osgEarth found that reusing the position hash for thinning kept the
  westernmost 20% of each cell [63].
- Merging: GeoServer's vt-coalesce merges features with equal kept
  attributes, about 50% smaller tiles than attribute selection alone [81].
  osgEarth's line merge dropped the `cables` attribute that drives
  styling [64]; OsmAnd does not simplify per-point coloured lines [94].
- Style-driven filtering: GeoServer reads only what the active rules show
  at the scale [85].

For a renderer here: drop by area in output pixels squared at the band's
deepest zoom, count what was dropped, and print it [1]. Before dropping
closed rings, check the fill result is unchanged [97]. Never simplify
away vertices that carry attributes [94].

## Decision 7: order of operations

- Project, then simplify (Decision 2) [25][84].
- Clip, then simplify, then buffer or offset, when each is costly:
  QGIS reordered its symbol pipeline for a "significant performance
  bump" [29], and GeoServer clips each tile before its topology-preserving
  simplifier [87]. But per-tile simplification can differ across tile
  edges [87], and simplifying clipped geometry needs care: Marble must
  keep real nodes next to synthetic border nodes, or an L-shaped line
  became a diagonal [42]. A baker that simplifies the whole dataset once
  and then clips avoids both.
- Offsets after simplification are wrong: QGIS simplified before the
  symbol offset and accepted the wrong lines as an edge case [20]; Mapnik
  moved offset after smoothing for consistent output [65]. At bake,
  apply offsets and buffers to the drawn geometry, then simplify.
- Quantise after simplifying, then clean up: remove duplicates (07 does
  [6]) and collapsed rings [79]. GeoServer rounds MapML coordinates to
  ceil(-log10(tolerance)) decimals after simplifying [90].
- Pass contained elements through untouched: Marble skips clipping for
  elements inside the tile, which also keeps vertex order [41]; mapsforge
  builds each tile's clip geometry once and returns early on contained
  envelopes, about 30% faster in RAM mode [108].

## Decision 8: adding vertices (curves, smoothing, terrain)

- Densify by screen error, not a fixed count: d3-geo bisects each
  geodesic edge while the projected midpoint deviates more than 0.707 px,
  to depth 16, always splitting spans over 30 degrees [59]. ol2 replaced
  50 points per graticule line by the same half-pixel test [51]. d3's
  circle step went from 6 to 2 degrees: error 4.365 km to about 484 m,
  quadratic in the step, at 3x the points [60]. GeoServer leaves
  densification off by default because it slows rendering [83].
- Smoothing keeps corners only if weighted: Mapnik's adaptive mode
  smooths only obtuse angles [72]. Organic Maps smooths contours per
  tile with centripetal Catmull-Rom and had gaps until it inflated the
  clip rect by 30% [106].
- Terrain: openglobus moves peaks and pits to the nearest mesh vertex
  instead of subsampling [61].

## Tried and reverted

| Engine | Tried | Outcome |
| --- | --- | --- |
| Mapnik | 1/2 px source tolerance [68] | 1/20 px; regressed by a refactor, restored [68][71] |
| Mapnik | clip all symbolizers by default (2012) [70] | off by default since 2014 after stroke, offset and marker artefacts [70] |
| Marble | node reduction off, on, then Douglas-Peucker [38] | roundabouts lost, then fixed [38] |
| Marble | simplified building sides, about 50% faster at level 17 [44] | reverted next day: "reinventing the wheel" [44] |
| Marble | area cache keyed by address [40] | removed; no measurable cost [40] |
| QGIS | makeValid for label geometry [31] | back to buffer(0), much faster [31] |
| QGIS | Oracle server-side simplification [28] | reverted [28] |
| OsmAnd | simplifying polygons outside the visible bbox [98] | off for coastlines, then all areas [95] |
| OsmAnd | Douglas-Peucker on the offset edge of route lines [92] | centreline instead, same day [92] |
| mapsforge VTM | extra simplification of land polygons [110] | removed; reader simplification opt-in, exempt land/sea [110] |
| Organic Maps | different country scale set [105] | back to 10, 12, 14, 17 [105] |
| ortho-earth | per-arc calibrated LOD at draw time [16] | measured, not built [16] |

## Checklist for the simplification step of bake.ts

1. Project first; state the tolerance in device pixels at the deepest
   zoom each level serves, and print it with the counts [1][4].
2. Lines: Douglas-Peucker with pinned endpoints [2][22]. Polygons drawn
   as a coverage: shared arcs or a global grid; one colour: dissolve [6][103][47].
3. After quantising: remove duplicate points and rings under 4 points or
   under the area threshold, and count them [6][77][79].
4. Check fills and topology after simplification: small islands kept as
   intended, no ring dropped that flips land and water [97][103].
5. If baking several levels, keep a level only when it is clearly
   smaller, and count triangles too [101][102].
6. Test tiny polygons and small closed rings at every level, and bench
   both ends of the zoom range [38][68][20].

## Sources

Paths are relative to the repository root; `ref-repos/<owner>__<repo>/` is
the local clone. Some entries are cited only in references/engines.md,
which uses the same numbers.

1. README.md; skills/map-from-scratch/SKILL.md
2. tools/geo.ts; tools/test/geo.test.ts
3. examples/01-prefecture-picker/bake.ts; examples/01-prefecture-picker/REQUEST.md
4. examples/02-world-population-mobile/bake.ts
5. examples/03-quake-timeline/bake.ts
6. examples/07-world-cities-hover/bake.ts; examples/07-world-cities-hover/REQUEST.md
7. .agents/skills/tile-lod-and-overzoom/SKILL.md; .agents/skills/vector-tile-encoding/SKILL.md; .agents/skills/polygon-triangulation/SKILL.md; .agents/skills/line-tessellation/SKILL.md
8. ref-repos/maplibre__maplibre-gl-js/developer-guides/life-of-a-tile.md; ref-repos/maplibre__maplibre-gl-js/developer-guides/custom-crs.md; https://github.com/mapbox/mapbox-gl-js/pull/5799
9. https://github.com/maplibre/maplibre-gl-js/commit/3d39142e4
10. https://github.com/yuiseki/maplibre-tile-spec/commit/1e8bce31
11. ref-repos/opengeos__RustGIS/docs/user-guide/data.md#complete-streamed-shapefile-rendering; https://github.com/opengeos/RustGIS/commit/f9a214a
12. https://github.com/opengeos/RustGIS/pull/70; https://github.com/opengeos/RustGIS/pull/71; https://github.com/opengeos/RustGIS/pull/681
13. https://github.com/kenjiyoshidahome2026-bit/ortho-earth/blob/main/packages/globe/src/columnar/README.md; ref-repos/kenjiyoshidahome2026-bit__ortho-earth/packages/globe/src/columnar/README.md
14. https://github.com/kenjiyoshidahome2026-bit/ortho-earth/blob/main/packages/geopbf/pbf%20spec.md; ref-repos/kenjiyoshidahome2026-bit__ortho-earth/packages/geopbf/README.md
15. https://github.com/kenjiyoshidahome2026-bit/ortho-earth/blob/main/packages/geopbf/README.md; ref-repos/kenjiyoshidahome2026-bit__ortho-earth/packages/geopbf/README.md
16. https://github.com/kenjiyoshidahome2026-bit/ortho-earth/blob/main/packages/geopbf/lod-calibration-2026-10-12.md; ref-repos/kenjiyoshidahome2026-bit__ortho-earth/packages/geopbf/lod-calibration-2026-10-12.md
17. https://github.com/kenjiyoshidahome2026-bit/ortho-earth/commit/f125c3c2
18. https://github.com/kenjiyoshidahome2026-bit/ortho-earth/commit/9067fe4a
19. https://github.com/kenjiyoshidahome2026-bit/ortho-earth/commit/3f46a73e; https://github.com/kenjiyoshidahome2026-bit/ortho-earth/commit/ce076c19
20. https://github.com/qgis/QGIS/issues/17441; https://github.com/qgis/QGIS/pull/980
21. https://github.com/qgis/QGIS/commit/3ddcdac57f; https://github.com/qgis/QGIS/commit/95cabe5711
22. https://github.com/qgis/QGIS/commit/42fd6a2bdb
23. https://github.com/qgis/QGIS/commit/5ee97adc16
24. https://github.com/qgis/QGIS/commit/f00c52d5a6
25. ref-repos/qgis__QGIS/ChangeLog:82879 (2024-08-23 Fix inverted polygon renderer vs OTF simplification)
26. https://github.com/qgis/QGIS/commit/0419f182d8; https://github.com/qgis/QGIS/commit/913f53a53f; https://github.com/qgis/QGIS/commit/d8d23b56ea
27. https://github.com/qgis/QGIS/commit/73d8544cec; https://github.com/qgis/QGIS/commit/7e1d142fef; https://github.com/qgis/QGIS/commit/56b77db88c
28. https://github.com/qgis/QGIS/commit/db1192f151; https://github.com/qgis/QGIS/commit/01a733ba3f; https://github.com/qgis/QGIS/commit/5ba6e682a7; https://github.com/qgis/QGIS/commit/706e651484
29. https://github.com/qgis/QGIS/commit/99f328c2eb; https://github.com/qgis/QGIS/commit/671ea21908
30. https://github.com/qgis/QGIS/commit/60894cebf1; https://github.com/qgis/QGIS/commit/972369e3b6; https://github.com/qgis/QGIS/commit/32b62447f6
31. https://github.com/qgis/QGIS/commit/ff5a8bc0ae; ref-repos/qgis__QGIS/ChangeLog:342018 (2018-11-09 Revert [pal] makeValid); https://github.com/qgis/QGIS/issues/20260
32. https://github.com/qgis/QGIS/commit/d4cf534e4c
33. https://github.com/qgis/QGIS/commit/71ebdb8f69
34. ref-repos/OSGeo__grass/lib/vector/vectorlib_topology.dox; ref-repos/OSGeo__grass/lib/vector/vectorlib_ogr.dox; ref-repos/OSGeo__grass/doc/vector/TODO
35. https://github.com/OSGeo/grass/commit/c863dc285; https://github.com/OSGeo/grass/commit/cffe2d2f1
36. ref-repos/KDE__marble/tools/natural-earth-vector-tiling/level_info.txt; https://invent.kde.org/education/marble/-/blob/master/tools/natural-earth-vector-tiling/level_info.txt
37. https://github.com/KDE/marble/commit/c22ac0db3
38. https://github.com/KDE/marble/commit/78b8313d5; https://github.com/KDE/marble/commit/70213164b; https://github.com/KDE/marble/commit/081d2950f; https://github.com/KDE/marble/commit/55e24cdac
39. https://github.com/KDE/marble/commit/d68eb5f52
40. https://github.com/KDE/marble/commit/d202b9123
41. https://github.com/KDE/marble/commit/7227009d0; https://github.com/KDE/marble/commit/2d20830ba
42. https://github.com/KDE/marble/commit/c06d7763a
43. https://github.com/KDE/marble/commit/15c862bbf
44. https://github.com/KDE/marble/commit/8a9ba9981; https://github.com/KDE/marble/commit/60128d0bc
45. https://github.com/KDE/marble/commit/c34a13f8f
46. https://github.com/openlayers/openlayers/pull/5462
47. https://github.com/openlayers/openlayers/commit/594cee01e; https://github.com/openlayers/openlayers/commit/b179a27ad; https://github.com/openlayers/openlayers/commit/9bc92b216
48. https://github.com/openlayers/openlayers/commit/71a6c4f27
49. https://github.com/openlayers/openlayers/commit/81c0c37eb; https://github.com/openlayers/openlayers/commit/b374d5c5b
50. https://github.com/openlayers/openlayers/commit/6866f0637
51. https://github.com/openlayers/ol2/blob/master/notes/2.14.md; https://github.com/openlayers/ol2/blob/master/lib/OpenLayers/Geometry/LineString.js; https://github.com/openlayers/ol2/blob/master/lib/OpenLayers/Control/Graticule.js
52. https://github.com/openlayers/ol2/commit/e9e2aec7
53. ref-repos/Leaflet__Leaflet/FAQ.md; ref-repos/Leaflet__Leaflet/CHANGELOG.md; ref-repos/Leaflet__Leaflet/docs/reference.html
54. https://github.com/Leaflet/Leaflet/commit/ddb9a376; https://github.com/Leaflet/Leaflet/commit/3c5cf0fd; https://github.com/Leaflet/Leaflet/commit/b329c4a9; https://github.com/Leaflet/Leaflet/commit/4952b372
55. ref-repos/protomaps__protomaps-leaflet/src/view.ts; https://github.com/protomaps/protomaps-leaflet/commit/136abcc
56. https://github.com/tangrams/tangram/commit/d0b887d09a3645aad91a18bd3bd0362d74627da3; ref-repos/tangrams__tangram/src/builders/polygons.js
57. https://github.com/tangrams/tangram/issues/364
58. https://github.com/maptalks/maptalks.js/commit/ad4c0f538; https://github.com/maptalks/maptalks.js/issues/1266
59. ref-repos/d3__d3-geo/src/projection/resample.js; https://github.com/d3/d3-geo/blob/18eb2fb/README.md#projection_precision
60. https://github.com/d3/d3-geo/pull/281; https://github.com/d3/d3-geo/pull/282
61. https://github.com/openglobus/openglobus/commit/fd645980; https://github.com/openglobus/openglobus/commit/6517a3b1; ref-repos/openglobus__openglobus/src/terrain/terrainUtils.ts
62. ref-repos/NASAWorldWind__WorldWindJava/src/gov/nasa/worldwind/util/PolylineGeneralizer.java; https://github.com/NASAWorldWind/WorldWindJava/blob/2543c23/src/gov/nasa/worldwind/util/PolylineGeneralizer.java; ref-repos/NASAWorldWind__WorldWindJava/src/gov/nasa/worldwind/formats/shapefile/ShapefilePolygons.java
63. ref-repos/pelicanmapping__osgearth/docs/design/procedural2-plan-history.md; https://github.com/pelicanmapping/osgearth/blob/master/docs/design/procedural2-plan-history.md; ref-repos/pelicanmapping__osgearth/docs/design/procedural2-plan.md
64. https://github.com/pelicanmapping/osgearth/issues/2702
65. https://github.com/mapnik/mapnik/blob/master/CHANGELOG.md; https://github.com/mapnik/mapnik/issues/927; https://github.com/mapnik/mapnik/issues/2202; https://github.com/mapnik/mapnik/pull/3160
66. https://github.com/mapnik/mapnik/issues/2196; https://github.com/mapnik/mapnik/issues/1385; https://github.com/mapnik/mapnik/blob/master/CHANGELOG.md
67. https://github.com/mapnik/mapnik/issues/2441; https://github.com/mapnik/mapnik/issues/2937
68. https://github.com/mapnik/mapnik/issues/1639
69. https://github.com/mapnik/mapnik/issues/1136
70. https://github.com/mapnik/mapnik/commit/cdb075f75; https://github.com/mapnik/mapnik/commit/721143631; https://github.com/mapnik/mapnik/commit/c3dae0105; https://github.com/mapnik/mapnik/commit/3db39f2b7; https://github.com/mapnik/mapnik/commit/c1d124f6d
71. https://github.com/mapnik/mapnik/commit/5758e6d9d; https://github.com/mapnik/mapnik/commit/0d098a046; ref-repos/mapnik__mapnik/plugins/input/postgis/postgis_datasource.cpp
72. https://github.com/mapnik/mapnik/commit/2dde0eb25; https://github.com/mapnik/mapnik/issues/2715
73. https://github.com/mapnik/mapnik/commit/9cf40a614; https://github.com/mapnik/mapnik/commit/9e8e17816
74. https://github.com/mapnik/mapnik/issues/13; https://github.com/mapnik/mapnik/pull/3512
75. https://github.com/mapnik/mapnik/commit/483ba7708; https://github.com/mapnik/mapnik/commit/b243f03c9; https://github.com/mapnik/mapnik/commit/22150f908; https://github.com/mapnik/mapnik/commit/06bae0a76
76. ref-repos/MapServer__MapServer/HISTORY.md; ref-repos/MapServer__MapServer/src/mapprimitive.cpp; ref-repos/MapServer__MapServer/src/mapserver.h; https://github.com/MapServer/MapServer/issues/2381
77. https://github.com/MapServer/MapServer/commit/bc06ff51; https://github.com/MapServer/MapServer/commit/af8924bb
78. https://github.com/MapServer/MapServer/commit/e1e409f0
79. https://github.com/MapServer/MapServer/commit/11e05652; https://github.com/MapServer/MapServer/commit/1cec5bf0
80. https://github.com/MapServer/MapServer/pull/5854; https://github.com/MapServer/MapServer/pull/6417
81. ref-repos/geoserver__geoserver/doc/en/user/extensions/vectortiles/options.md; https://github.com/geoserver/geoserver/commit/ee9e57ecba01c5ae8f417d2e3fcc964fbf14d451; ref-repos/geoserver__geoserver/doc/en/user/source/extensions/vectortiles/options.rst
82. ref-repos/geoserver__geoserver/doc/en/user/tutorials/feature-pregeneralized/feature-pregeneralized_tutorial.md
83. ref-repos/geoserver__geoserver/doc/en/user/services/wms/webadmin.md
84. https://github.com/geoserver/geoserver/commit/f4eeb55439
85. https://github.com/geoserver/geoserver/commit/c2520fa32d
86. https://github.com/geoserver/geoserver/commit/2a5bebb7cd; doc/en/user/source/community/solr/optimize.rst (in the GeoServer repository)
87. https://github.com/geoserver/geoserver/commit/4a461bab5b
88. https://github.com/geoserver/geoserver/commit/6d784bb16d
89. https://github.com/geoserver/geoserver/commit/e30cdcc49a
90. https://github.com/geoserver/geoserver/commit/e888ebf27cf78c7a262b3e6764cbb87e811d609e
91. https://github.com/geoserver/geoserver/commit/fbaae80867cb3f43b2bd586ec9eaea481d41bbd9
92. https://github.com/osmandapp/OsmAnd-core/commit/941f1863; https://github.com/osmandapp/OsmAnd-core/commit/3fe5bbc2; https://github.com/osmandapp/OsmAnd-core/commit/3209f9b1
93. https://github.com/osmandapp/OsmAnd-core/commit/2d924177
94. https://github.com/osmandapp/OsmAnd-core/commit/1bebd1105921aeeb8cd94e389d8f620cdf444977; https://github.com/osmandapp/OsmAnd-core/commit/3355bebe514e1b2aecb500d937e64a5137644d60; https://github.com/osmandapp/OsmAnd-core/commit/d3c195e16c48c0cbe0fbb19342d843bc596fd20d
95. https://github.com/osmandapp/OsmAnd-core/commit/0753b344; https://github.com/osmandapp/OsmAnd-core/commit/61fff9af; https://github.com/osmandapp/OsmAnd-core/commit/1501163d; https://github.com/osmandapp/OsmAnd-core/commit/375a2025
96. https://github.com/osmandapp/OsmAnd-core/pull/280; https://github.com/osmandapp/OsmAnd-core/pull/365; https://github.com/osmandapp/OsmAnd-core/pull/1094
97. https://github.com/osmandapp/OsmAnd-core/commit/e0099eabaefbe3864cc0e5d37afad91af3dc19b5
98. https://github.com/osmandapp/OsmAnd-core/commit/78d3f545; https://github.com/osmandapp/OsmAnd-core/commit/4de88807; https://github.com/osmandapp/OsmAnd-core/commit/f471d812; https://github.com/osmandapp/OsmAnd-core/commit/c74e9bd5
99. ref-repos/organicmaps__organicmaps/libs/indexer/feature_impl.hpp; ref-repos/organicmaps__organicmaps/docs/feature_structure.txt; ref-repos/organicmaps__organicmaps/docs/STYLES.md; https://github.com/organicmaps/organicmaps/blob/master/libs/indexer/feature_impl.hpp
100. ref-repos/organicmaps__organicmaps/generator/geometry_holder.hpp; ref-repos/organicmaps__organicmaps/docs/feature_structure.txt; ref-repos/organicmaps__organicmaps/libs/indexer/feature.cpp; https://github.com/organicmaps/organicmaps/blob/master/generator/geometry_holder.hpp
101. ref-repos/organicmaps__organicmaps/generator/geometry_holder.hpp; https://github.com/organicmaps/organicmaps/commit/f8bc87c33cda0f868082176d301760dd4dfc1f59
102. ref-repos/organicmaps__organicmaps/generator/feature_sorter.cpp; ref-repos/organicmaps__organicmaps/libs/indexer/feature.hpp; https://github.com/organicmaps/organicmaps/blob/master/generator/feature_sorter.cpp
103. ref-repos/organicmaps__organicmaps/tools/python/borders/README.md; ref-repos/organicmaps__organicmaps/tools/python/borders/2026-10-alignment-exclusions.tsv; https://github.com/organicmaps/organicmaps/blob/master/tools/python/borders/README.md
104. ref-repos/organicmaps__organicmaps/data/conf/isolines/README.md; ref-repos/organicmaps__organicmaps/data/conf/isolines/isolines-profiles.json; https://github.com/organicmaps/organicmaps/blob/master/data/conf/isolines/README.md
105. https://github.com/organicmaps/organicmaps/commit/effddd5ed3; https://github.com/organicmaps/organicmaps/commit/da53c6195b; https://github.com/organicmaps/organicmaps/commit/47401ef4ed; https://github.com/organicmaps/organicmaps/commit/a13ded6f2d
106. https://github.com/organicmaps/organicmaps/commit/50fd9e058d; https://github.com/organicmaps/organicmaps/commit/e87099c14f
107. ref-repos/mapsforge__mapsforge/docs/Getting-Started-Map-Writer.md; https://github.com/mapsforge/mapsforge/issues/892
108. https://github.com/mapsforge/mapsforge/pull/1751; https://github.com/mapsforge/mapsforge/pull/1741
109. https://github.com/mapsforge/vtm/pull/1085; https://github.com/mapsforge/vtm/issues/1082; ref-repos/mapsforge__vtm/vtm/src/org/oscim/renderer/bucket/LineBucket.java
110. https://github.com/mapsforge/vtm/pull/956; https://github.com/mapsforge/vtm/pull/906; https://github.com/mapsforge/vtm/issues/39; ref-repos/mapsforge__vtm/vtm/src/org/oscim/tiling/source/mapfile/MapFile.java
111. https://github.com/galileo-map/galileo/commit/77689e7
112. ref-repos/SciTools__cartopy/lib/cartopy/feature/__init__.py
