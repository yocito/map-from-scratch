# Polygon triangulation, engine by engine

Bracketed numbers refer to the Sources list in [../SKILL.md](../SKILL.md).
Each entry: what the engine decided, what it paid, the evidence, and what
it means for a renderer that bakes its data.

## MapLibre GL JS

- Globe subdivision. Before a tile finishes loading, polygons and lines
  are subdivided on a consistent square grid, applied to earcut's output;
  subdividing before triangulation was slower. Granularity halves per
  zoom with a floor; 128 for fills keeps index counts inside 16-bit.
  Without it oceans deform and borders stay straight on the sphere.
  Subdivision is prone to single-pixel seams and must split polygons and
  lines at the same places. Raster tiles need a higher base granularity
  or they warp across zoom changes [7]. Applies only if vertices are
  projected nonlinearly on the GPU.
- Ring cap. `classifyRings` keeps the `EARCUT_MAX_RINGS` (500, first 100)
  largest rings per polygon, chosen by quickselect, because "Earcut
  performance degrades with the # of rings". Smallest holes disappear
  silently [8].
- Index remap. The fill subdivider records each input vertex's
  deduplicated index once and remaps earcut output through that array
  instead of a coordinate-keyed Map: about 15% faster bench without
  subdivision and about 67 ms less worker time on three dense city
  views, output unchanged [9].

## MapLibre Native

- mlt-core, an experimental Rust MLT decoder, was added for a safe
  FastPFOR. Decoded tiles take about 5 to 17 times the encoded size, so
  the 20 MiB budget rejected tiles of a few MB (raised to 128 MiB). MLT's
  stored triangles assume rings without a closing point, but decoded
  rings had one; holes misaligned and the covered area was 134.5 instead
  of 91. A parity test against MVT covers 17,154 features; speed was
  "about the same" as the C++ decoder [10]. Lesson: if a format ships
  triangles, define ring closure explicitly and test decoded area.
- Ring fix-up uses mapbox wagyu (union, even-odd, int32 rings into an
  int16 multipolygon) instead of the vendored Angus Clipper; about 6,100
  vendored lines deleted. Needed only if tiles can have invalid rings [11].

## maplibre-rs

- Tessellates MVT lines and polygons with lyon on worker threads into
  vertex/index buffers per layer and tile [12]. Every tile load pays CPU.
- Index format went from Uint16 to Uint32 in the commit that stopped
  silently dropping layers whose tessellation failed (it now returns a
  Result and logs). Index memory doubles; no measurement given [13].
- Output moved from one buffer per tile to one per source layer, then to
  only the layers the style references. No numbers [14].
- Replaced lyon's SVG-style path builder with its own MVT command cursor
  (MoveTo starts a subpath, lines stay open, fills use NonZero):
  "Semantics of SVGs and vector tiles are different" [15].

## MapLibre Tile (MLT)

- Pre-tessellation is optional and off by default. With
  `--tessellate=always` tiles grew 21.9% (v1) / 24.9% (v2) on
  OpenMapTiles and 32.4% / 35.8% on Protomaps; decode got slower by 27%
  (v1 OMT), 145% (v1 Protomaps), 68% (v2 Protomaps) [16].
- v2 triangle trees: one 2-bit symbol per triangle plus one index per
  outline vertex, counted from the layer's first vertex. Relies on earcut
  adding no interior vertices. Triangles-only layout (0xC) cannot rebuild
  rings, so stroking it draws hole cuts, it cannot carry m-values, and
  triangle order within a feature is not preserved [17].
- Rings: v2 stores no closing vertex; ring roles come from part and ring
  lengths, not winding, but winding must still follow MVT; encoders were
  fixed to wind as MVT does [17].
- Auto pricing per layer: `Tessellation::{Off, Always, Auto(Client,
  Network)}`; network cost 3G 4 us/B, 4G 400 ns/B, 5G 40 ns/B, offline 0;
  client earcut time fitted per polygon on five tilesets on one Ryzen 9
  3900, slowdown 2 for a mid-range phone or car head unit. Native profile
  defaults to Auto, web profiles to off. Commit message: "Tesselation is
  a bit more complicated than originally thought" [18].
- Compact layout: about 0.3 B per index instead of 2 B; tessellated v2
  total 57.81 to 50.12 GB (raw -13.3%, gzip -11.9%); tessellation overhead
  over plain v2 from +23.8% to +7.3%; probably no longer zero-copy; later
  7 ns per triangle decode. "As networks get faster, we might need to
  revert" [19].
- Layer-global indices: index stream entropy up by under 0.01%, fixture
  sizes unchanged, implementation "gets a lot simpler" [20].
- Triangles-only layers (0xC) are opt-in; the Java decoder later had to
  reject tessellated polygons without outlines after an NPE [21].

## RustGIS

- Vector tile meshes made once per tile and level with lyon, in tile
  units; strokes at width 1 offset in the shader; zoom-dependent paint
  evaluated at two levels and blended. On one thread meshes for a view
  took 106-224 ms (27-53 MB) against 325-440 ms for one zoom step of
  pictures; GPU scene builds dropped from 35-64 ms to 7-24 ms. In map
  units (millions) width-1 strokes broke precision [22].
- Vertex count estimated before tessellating (including round-join arcs);
  past 2M vertices (80 MB) the layer draws on the CPU. Before this, about
  1.5M tiny polygons became 30-50M vertices (1.8 s a frame), exceeded
  `max_buffer_size` and sent the whole scene to the CPU: about 5 s per
  dragged frame [23].

## Cesium

- Replaced its own triangulator with earcut: a GeoJSON of all country
  polygons loaded 2x faster and some large polygons triangulated
  correctly; earcut 2.2.4 gave "10-15% better performance" [24]. Earlier
  it replaced a random-cut triangulator, about 130 lines removed, with a
  1000-iteration reload benchmark of US states whose results are not
  stated [25].
- Projection for earcut chosen by extent: tangent plane for small
  polygons; for spans of at least PI, polar stereographic, or normalised
  lon/lat if the polygon also crosses the equator, to get winding right;
  large polygons split at the equator. Fixed polygons of 90 degrees or
  more and pole artifacts; cost about 300 lines and 698 lines of specs [26].

## deck.gl

- Extruded polygon walls: TOP model indexed by earcut, SIDE model as
  instanced quads from position/nextPosition; a 359-line CPU wall
  tessellator deleted; Uint16 check now tests vertex count, not index
  count. Two draw calls per layer; no numbers [27].
- Earcut moved into the loaders.gl MVT worker, returning a triangles
  index array; a second deck.gl worker was rejected because data would
  cross threads twice. The RFC warns the transfer may cost more than it
  saves without benchmarking [28]. CARTO loaders do the same and return
  Uint32Array triangles [29].

## ortho-earth (GPL-3)

- WASM only where measured: not for the frame loop, tile merge or
  per-polygon earcut (frequency times small payload) [30].
- Stencil-then-cover with non-zero winding; boundary-only arcs for
  single-colour fills; id buffer for per-feature colours, two passes
  regardless of colour count (1,919 municipalities). 370k-edge parcel
  layer 20-37 ms to about 2 ms; polygon identify 0.5-4 ms; fid limit
  2,047 on half float; 3+ overlaps resolve only approximately [31].
- Columnar layer: GeoParquet or GeoPBF to unit-sphere xyz relative to an
  origin, earcut per chunk, grid-rounded LOD z12/9/6 with the needed
  level first. First tile 457 to 75 ms (1.5 MB), 1174 to 70 ms (4.4 MB),
  1257 to 98 ms (11 MB) against the topology bake [32].
- Indexed fills (Uint16 per tile, merged to Uint32): fill 4.96 to
  3.08 MB, total geometry 9.20 to 7.32 MB [33].
- Hashing quantised coordinates with FxHash concentrated buckets
  (multiples of 100 have zero low bits); a splitmix64 finaliser took ZCTA
  topology from 161 s to 13 s with byte-identical output [34].

## QGIS

- PolyhedralSurface and TIN are first-class geometries, so triangulated
  sources are not converted to polygons and re-triangulated [35].
- 3D tessellator (poly2tri) projects each polygon onto its Newell-normal
  plane and offsets by an origin; the first version lost precision with
  large numbers, leaving gaps between roofs and walls [36].
- poly2tri rejects repeated points within epsilon: QGIS simplifies, then
  skips; invalid polygons ignored; a later fix restored lost walls [37].
- A `noZ` 2D path skips z and normals; its triangle fast path crashed
  twice on 2D input [38].
- Speed-ups from not constructing Point objects, direct coordinate access
  and fewer GEOS conversions; no numbers [39].
- Chunk clipping drops edges on the chunk perimeter so borders do not
  show as outlines [40].
- Quantized-mesh terrain: strips degenerate triangles (often up to 50%)
  and adds skirts [41]. Point-cloud triangulation filters before
  triangulating and drops exterior and oversized triangles; a
  classification-specific path was reverted [42].

## GRASS GIS

- Arc-node topology: shared boundaries stored once, so simplification
  keeps neighbours gap-free; requires clean data [43].
- Symbol polygons must be wound clockwise outside, counter-clockwise for
  holes, because PostScript output uses even-odd fill [44].
- A geodesic area routine returned area signed by orientation and rings
  were skipped until it returned the absolute value [45].
- Polygon area went back to a line integral, "more robust than
  surveyor's formula" [46]. Intersection code scales its float tolerance
  for squared distances and snaps a self-intersection only once [47].

## KDE Marble

- Tile creator clips with Clipper2 in 1e-7-degree int64 coordinates [48];
  its own Weiler-Atherton was replaced by Clipper ("less clipping
  glitches, no endless loops") [49].
- Vertex attributes tracked in a side map keyed by integer coordinates
  instead of patching Clipper's point structs, which Clipper swapped [50].
- Closed-area detection must not depend on feature kind (highway areas
  were clipped as open ways) [51].
- Building walls turned inside out once the clipper stopped normalising
  winding; winding is now normalised explicitly [52].

## OpenLayers

- #5462 wrote an ear clipper with an rbush segment index for
  self-intersections. First measured 40x slower than earcut; after tuning
  3.654 ops/s against earcut 4.096 on 177 Natural Earth polygons. The
  2022 WebGL renderer uses earcut in a worker: "earcut is so fast that
  the difference is probably negligible" [53].
- The library keeps rendering degenerate geometry and skips its own
  simplification for vector tiles, which are already generalised [54].
- Separate paths for bad and simple polygons; simple ones skip the
  diagonal-inside test [55].
- Winding: fast lowest-vertex test, two fixes, then "Return to simpler and
  less efficient winding order algorithm" [56]. Rings are split into
  polygons by winding only for vector-tile features [57].

## Tangram (JS) and Tangram ES

- Triangulate first, write vertices only if earcut returned 3+ indices;
  the earlier rollback approach broke labels [58].
- Outer-ring winding inferred from the first ring of each source; Mapzen
  tiles were CCW against MVT 2.1; earcut re-checks winding anyway [59].
- TopoJSON quantisation made rings touch; fixed by a higher quantisation
  scale on the server, called "not 100% reliable" [60].
- libtess.js replaced by earcut; gl.js about 50 lines shorter; no
  benchmark [61]. earcut later bumped to fix artifacts [62].
- 500-ring cap with quickselect, but the comparator reads a `.area` that
  nothing sets, so the selection is arbitrary [63].
- Tangram ES: a polygon vertex wraparound fix was merged in 2018 and
  reverted in 2019 without a stated reason [64].

## harp.gl

- Tile clipping in the fragment shader with 4 clip planes (worst case
  0.6 ms on 4K; stencil rejected because it fails on the globe), removed
  six weeks later for decoder-side clipping; Sutherland-Hodgman then
  specialised to axis-aligned bounds [65].

## kothic-js

- Outline segments between two points on the same tile edge are not
  stroked (bitmask per edge); an earlier "both on any boundary" test
  dropped real edges. A real edge lying exactly on the border is still
  lost [66].

## d3-geo

- Spherical winding: rings smaller than a hemisphere go clockwise,
  larger ones anticlockwise; opposite of RFC 7946. Wrongly wound input
  renders as everything except the polygon and bounds become -180..180;
  orientation cannot be inferred from area [67].
- Degenerate clipping fixed by tagging points in z ("do not merge") and
  applying epsilons at rejoin, not at clip [68].

## globe.gl

- Polygons subdivided at an angular curvature resolution; after a speed-up
  the default went from 10 to 5 degrees; sphere resolution 4, paths
  interpolated past 2 degrees; no numbers [69].

## iTowns

- Index array width from vertex count (Uint8/16/32), replacing fixed
  Uint16 with splitting at 65,535 [70].
- One feature, one mesh; tests compute mesh area with and without holes
  [71].
- In an abandoned WFS PR, earcut drew buildings correctly but frame rate
  collapsed from feature count, not triangulation [72].

## VTS browser

- GeoJSON tessellation in the browser was slow and crashed on one file;
  exporting the processed geodata gave 55 MB JSON, 14 MB without
  whitespace; binary geodata loading exists [73].

## osgEarth

- Polygons cropped to a grid before tessellation; default tiling angle
  5 to 45 degrees; no numbers [74].
- Own ear clipper (2014) with OSG fallback; MeshConsolidator kept a custom
  triangulator because osgUtil dropped per-vertex feature ids [75].
- Vendored earcut "to improve speed" (2019), a fix six months later, and
  an opt-in `useOSGTessellator` (GLU, odd winding) [76].
- Terrain masks: triangles may not join boundary vertices across a mask
  [77]. Image overlays tessellated by lat/lon interpolation because the
  mesh subdivider flipped triangles on very large polygons [78].

## Mapnik and TileMill

- 3.0 stores exterior and interior rings separately with enforced
  winding; `is_clockwise` later computed relative to the origin [79].
- Clipper, boost.geometry and an own clipper were tried; the simple AGG
  clipper was restored for drawing, Clipper removed after it needed
  `stable_sort` for identical results across operating systems [80].
- Shape plugin classifies holes by orientation instead of point-in-polygon;
  a reinterpret-cast micro-optimisation was reverted for no gain;
  `is_clockwise` tested with coordinates near -13499697, 4698431 that
  differ by about 0.07 [81].
- TileMill #2110: holes filled under AGG non-zero; even-odd fixed holes
  but caused line artifacts; the format was made to specify winding [86].

## MapServer and GeoServer

- MapServer: rectangle clip sized for 3 points per edge; rings of 6 and 7
  points clip to 14 and 16; 2 per edge aborted under ASAN [82].
- GeoServer: envelope clipper, robust then non-robust [83]; lower-dimension
  clip results dropped, several polygons emitted as a possibly invalid
  MultiPolygon [84]; encoder upgraded for MVT 2.1 ring orientation [85].

## OsmAnd

- Filled polygons keep a coarse zoom threshold; only stroked lines got
  exact per-zoom rebuilds [87].
- Coastline polygonisation swapped three times (2021, 2022, 2026) [88];
  remaining coastline defects attributed to generator Douglas-Peucker [89];
  z>=14 tiles read coastlines from the enclosing z14 tile to decide land
  or water [90]; dropping closed rings under 4 points flooded St
  Petersburg [91]; off-screen vertex dropping disabled for areas [92].
  For a bake: compute closed land/water polygons and a per-tile all-land
  or all-water flag at bake time.

## Organic Maps

- Areas simplified per level and triangulated in the generator, stored as
  strips; holes too small for a level dropped; triangles do not shrink
  linearly with simplification [93].
- Hillshade clipping: robust orient2d only where a sign changes topology,
  plain arithmetic for barycentric weights [94].
- Low-zoom simplification can invalidate an outer ring while holes stay
  valid; coast cells keep cell-boundary points [95].
- Strips compacted with parallelogram prediction and binary-tree triangle
  coding; area outlines dropped, area centre reworked [96].
- Whole-continent tessellation reverted in two days; coast cells split by
  4, 10,000-point limit per coastline piece [97].
- Areas and lines clipped to tile rects, building triangles not; tile
  size increased to amortise clipping [98].
- Degenerate triangles dropped below `kMwmPointAccuracy^2 * 0.01` with a
  robust test; marked experimental [99].

## mapsforge and VTM

- Map writer clips polygons to tiles plus 20 m; clipping outlined areas
  draws false edges on tile borders (z12-13 artifact); multipolygons
  clipped since 0.5.0 because unclipped ones caused reader OOM [100].
- VTM stencil INVERT default, libtess2 meshes opt-in; overlapping
  polygons in a layer cancel [101]; tessellation finally hard-wired to
  land/sea polygons, overlapping regions deduplicated in data [102].

## Navit

- maptool slices polygons above tile level 4 into squares; only a few
  dozen planet relations affected; outlined slices look checkered [103].
- Core clips polygons with holes to the screen before the driver [104].
- alloca for point buffers overflowed the stack on huge polygons;
  replaced by a reusable growing buffer and heap for huge elements [105].

## galileo, walkers, cartopy

- galileo: fixed-radius circles drawn as about 50-point polygons; an SDF
  circle was proposed, not built [106].
- walkers: earcut (2025-09, holes 2025-10) replaced by lyon (2025-11):
  artifacts gone, "way faster", cause confounded with one mesh against
  many shapes [107].
- cartopy: one coordinate extraction plus cumsum path codes, 50-100x on a
  50,000-point shell with 20 holes; closed triangles were misclassified
  once [108].
