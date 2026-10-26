# Projection and globe: engine by engine

Detail behind [../SKILL.md](../SKILL.md). Numbers in brackets point to the
Sources list in that file. Each entry gives the decision, its cost, and the
evidence the engine recorded.

## MapLibre GL JS

- **Globe latitude without trig.** The vertex shader derives sin and cos of
  latitude from `t = exp(PI - y*2PI)` with rational arithmetic. The old code
  used `2*atan(exp(..)) - PI/2` and a correction that rendered a 1x1
  framebuffer once a second, compared it with the CPU and shifted the
  projection matrix. That correction fixed only atan, and only as one
  constant for the whole view. It was removed. Subtracting PI/2 from a value
  near PI/2 destroys most of the float32 mantissa near the equator [1][2].
- **Globe to Mercator around z12**, through a "globeness" uniform in every
  vertex shader. float32 gives about one value per 2.5 m over the
  circumference, and float64 in shaders is very slow where it exists [1].
- **Subdivision after earcut** on a square grid that is consistent across
  polygons and lines. Granularity halves per zoom with a floor, up to 128 for
  fills, to stay inside 16-bit indices. It is prone to one-pixel seams.
  Rasters need a higher base granularity or they warp across zoom changes
  [1].
- **Back side**: distance to the horizon plane in `gl_Position.z`, the real
  depth applied later through `glDepthRange`, plus face culling (winding
  made consistent in subdivision) and line fragment discard, because some
  phone drivers apply depth range and clipping in the wrong order [1].
- **Poles**: pole fans on the first and last Mercator rows; whatever crosses
  85.05 degrees is stretched to the pole. Spikes are declared expected. The
  camera is eased back when the area past the edge outgrows the viewport,
  and moving across a pole is not supported [1][3].
- **Custom CRS through one seam.** All lon/lat to world conversion goes
  through a `WorldCoordinateHelper`. Mercator keeps calling its original
  functions, pinned by exact-equality tests against values dumped from
  main. A registered CRS shares Mercator's shaders and tile mesh. Box
  projection samples 17x17 because corners are not enough in curved CRSs
  [4][7]. The refactor cost 1.1 KB minified, because helper property names
  cannot be mangled. Hot-path benches against main: +2.2%, +8.9% and +75.6%,
  with A/A noise of 1 to 3%. The +75.6% was an artefact of vite-node turning
  cross-module imports into property loads; an esbuild bundle was faster.
  Measure refactors on the bundled build [7].
- **addProjection** (6.15, experimental): the app supplies project and
  unproject plus a tile matrix origin and extent, and the tiles come in that
  CRS. GPU reprojection of Mercator tiles to Equal Earth was left to a
  style-spec discussion [6].
- **GeoJSON into a registered CRS in workers**: the CRS carries a WKT/PROJ
  string, and workers load a handler such as `wkt => proj4(wkt)`. Projecting
  on the main thread stalled about 500 ms on a million points, and batching
  back to the main thread about 20 ms. Data outside the world square clamps
  to its edge; a diff reloads every tile, because a lon/lat box can miss a
  pole; a point at the opposite pole projected to infinity [8].
- **Projective texture coordinates** for image quads that are not
  parallelograms; concave, self-intersecting and singular quads are rejected
  [9].
- **Per-tile zoom from 3D distance** (centre zoom scaled by the distance
  ratio) for globe always, and for Mercator above 60 degrees of pitch or with
  terrain. A `pitchTileLoadingBehavior` enum and a deadband were rejected:
  "two confusing parameters are worse than one". A tile-zoom callback is the
  hook [5].
- **Quadtree cover against the frustum**: above 60 degrees of pitch, distant
  tiles stop splitting, keeping about 3 max-level tiles around the centre,
  and the result is sorted by distance [10].
- **Labels behind the camera**: anchors with `w <= 0` are skipped on the CPU,
  and shaders push z to `-1.1*w` [11].

## MapLibre Native

- Globe came in phases: first a projection seam and one ProjectionData
  uniform block per drawable on all four backends, pixel-identical to main;
  then the globe math, subdivision, cover, symbols, and a hand-over to
  Mercator at z11 to z12. The globe shader is repeated per backend (2.8k
  lines). The PR is 30k lines, 17.5k of them render-test fixtures. A bounded
  source blinked around z5.93 because the cover asked for next-zoom tiles
  and the pyramid capped them; bounds are now checked at each tile's own
  zoom. One test failed only on Android because `pow(2, log2(x))` is not
  exact in Bionic libm [12].
- Distance-based tile cover: depth-first quadtree with frustum and AABB
  tests, splitting only within `3 + 2^(maxZoom-z) - 2` of the centre. About
  280 lines of bounding-volume code; a precise test removes the under-1% false
  positives of the coarse one [13].

## maplibre-rs and navara

- maplibre-rs is Web Mercator only. PROJ was rejected: "large project and
  not compatible with wasm". A later PR proposed a globe from subdivided
  Mercator tiles [14]. It wrote its own far-plane calculation because the GL
  JS formula allowed pitch in only one direction; no benchmark was given
  [15].
- navara: on Geographic terrain, all overlapping Web Mercator tiles are
  mosaicked into one render target per layer and pasted with a per-fragment
  latitude reprojection. The earlier one-slot-per-tile design overflowed the
  GPU slot budget or coarsened every layer with three or more draped layers
  [16]. Mercator geometric error is scaled by the cosine of the equatorward
  latitude, and polar caps use the unextended extent [17].

## RustGIS

- Globe warp on the CPU: inverse projection at 8-pixel cell corners,
  interpolated, middle checked, per-pixel fallback at the limb and the
  antimeridian. 1210x670 at 2x: 395 to 100 ms [18].
- Cut at `lon0 ± 180` before projecting, 1e-9 deg inside; then read `+pm`,
  and with datum shifts bisect every 5 degrees of latitude for the jump,
  cached. A Bessel towgs84 shift moved the edge about 290 m at the equator
  (0.014 deg at 85N) [19].
- Globe drape at camera scale with fewer pixels per point (up to 2M pixels):
  symbols and strokes had been baked 2 to 6x too large and blurred [20].

## Cesium

- 1.27 stopped reprojecting Web Mercator imagery to geographic on load,
  improving "both visual quality and load performance slightly" [21].
- The proj4 projection PR: about 6,000 lines of proj4 (an accidental second
  copy once made it 12,000), much more terrain memory for unusual
  projections, EPSG:3857 projecting poles to infinity with log-depth
  artefacts, and EPSG:4326 semantics different from Cesium's own
  GeographicProjection. Closed as too out of date [22]. An earlier PR kept
  proj4 out of the core bundle; 2D infinite scroll, camera heading and ground
  primitives assumed a rectangular world, and Mollweide performance on a
  low-power Intel GPU was similar to Web Mercator [23].
- Horizon occlusion point from the RTC centre, not the bounding sphere [24].
- Large polygons: tangent plane for small ones, polar stereographic when the
  extent is at least PI, cylindrical lon/lat when they also cross the
  equator, and an equator split. About 300 lines plus 698 lines of specs
  [25].
- Clamped vector tiles: project each vertex to lon/lat once per collection,
  keyed by its model matrix, NaN for failures; per tile only UV projection
  and clipping. Cells get segments by padded boxes, and the shader does the
  exact test [26].
- Antimeridian-safe overlap: two arcs overlap when the angular distance
  between centres is at most the sum of half-widths [27].

## deck.gl

- 2015: Mercator moved into the vertex shader, so camera changes only touch
  uniforms; the price was 32-bit wobble at about z18 [38].
- Offset systems: the projected origin is added in clip space after a
  64-bit JS computation; per-unit scales are taken at the coordinate origin
  with a first-order latitude term [39]. Coordinate systems (lnglat,
  meter-offsets, lnglat-offsets, cartesian) and `modelMatrix` avoid CPU
  conversion. Offsets are correct only at city scale, and lon/lat cannot be
  moved by a 4x4 matrix [31].
- LNGLAT auto offset (RFC v6.1): 64-bit low parts generated on the CPU,
  offset mode above z12, polynomial approximation of the delta. It became the
  default, was switched back to the 6.0 mode, then became the default again,
  and fp64 moved to an extension [28][29][42]. Beyond 0.25 degrees of
  latitude from the origin it projects with Mercator and subtracts a
  CPU-projected common origin, instead of clamping the delta [43].
- Metre sizes: 1/cos(latitude) per vertex (Taylor series in common y,
  "max error < 0.003"), 34 files changed [44].
- MVT in tile-local coordinates with a per-tile model matrix instead of
  decoding to lon/lat and reprojecting [33]. The binary MVT path is disabled
  on GlobeView [45].
- GlobeView: no high-precision mode above z12, lnglat only, several layers
  unsupported [30].
- Globe sprites: global back-face culling culled all icon quads (they wound
  clockwise after a y flip); a per-anchor surface-normal test (#9975) cut off
  raised anchors and clipped foreground sprites and was closed. #10750
  rewound the quads, hides the far side with a ray-sphere test, and gives
  sprites the depth of the nearest globe surface point within a 64 px
  footprint [32][35].
- Terrain on the globe: mesh rows spaced in latitude are remapped for
  Mercator images (copied, not mutated), with globes detected from the
  viewport CRS. BitmapLayer goes 6 vertices to tessellated and back as the
  view changes [36].
- Tile selection: quadtree culled against the frustum with up to 3 world
  copies, `props.extent` culling, and nothing loaded below `minZoom` without
  an extent [40]. Globe tile volumes are oriented boxes from 5 points, or 9
  below z2, at both elevation limits [41].
- WebGPU: viewport matrices for WebGL's -w..w clip range put everything at
  z/w = -0.998, so nothing drew. It was first misread as "WebGPU draws
  nothing under the software renderer"; writing the clip position to colour
  found it. The fix remaps depth where the WGSL clip position is built [34].
- Matching Google Maps: `fovy` separate from altitude; a mismatch made
  `getBounds` return offsets of ±1706482542 and a runaway number of world
  copies at pitch 63 [37].
- Ball rotation through the poles (#10598) was reverted a month later to
  restore north-up navigation [46].

## ortho-earth (GPL-3)

- Origin-relative integer vertices with exact longitude wrap;
  cancellation-free formulas (`cos-1 = -2 sin^2(theta/2)`, small-angle
  `sinP`); `clip = clipT + MVP*(rel,0)` with `clipT` in f64. Ray-cast floors
  use f64 ray bases and `t = 2c/(-b+sqrt(h))`. View rays from `invMvp`
  (entries ~7e4) gave a 1 to 4 px sawtooth. Floor flicker went from 50% of
  pixels to under 1%. Four packers each recompute origin terms in f64, noted
  as debt [47].
- Raster XYZ as textured n x n meshes (16, 32 below z4), Mercator v computed
  on the CPU, the CRS never in the shader; parent texture with a sub-uv
  rectangle as fallback; about 341 KB per tile, budgets 64 MB desktop and
  24 MB low-memory. Rejected: CPU warping into one equirectangular window
  (0.4 s lag, blurry when tilted) and per-pixel virtual texturing [48].
- Sphere or ellipsoid (issue 43): measurements always on WGS84; display on
  the ellipsoid only on normal and high-end desktops; low-memory, mid-tier,
  8 GB Android and SwiftShader stay on the sphere. A parity page draws one
  known point per feature and compares the drawn centroid with
  `map.projectLL` in both modes and both backends; a known-failures file
  ratchets. It found heatmap, 3D Tiles and point clouds about 10 km north,
  a GL2 floor 187 px (about 450 m at z15) south at 60N, and a cache never
  written because of a swallowed DataCloneError. Pre-baked building batches
  exist per mode (3,882 verified), cached under separate keys, and offline
  packs record their mode [49].
- Atmosphere (issue 46): single-scattering Rayleigh and Mie in the existing
  full-screen globe pass, 8 view and 3 sun steps, real thickness, ground
  haze at half of physical, WebGPU only and off by default [50].
- High-zoom jitter: SwiftShader flushes small `sin` to zero (11 px steps),
  an origin mismatch gave 0.15 px at z20 to 1.3 px at z23, and float folding
  gave a 2.8 m grid [51].

## QGIS

- Never request every tile of a zoom level when extent reprojection falls
  back to the whole world [52].
- Simplify before transforming, and only once [53]. Clip after transforming
  when the inverse transform of the viewport is unreliable [54].
- A geocentric (EPSG:4978) clipper keeping Z stalled: maintainers would not
  risk "ANY regressions" in the 2D clipper's speed and accepted only
  duplicated 2.5D code [55].
- Metres on a degree-based map: one ellipsoidal measure at the centre of
  the extent [56].
- Reprojected rasters: provider-side resampling forced when reprojecting; the
  proper fix, resampling inside the projector like gdalwarp, was deferred
  [57].
- The coordinate operation is chosen once without the data's extent, with a
  silent fallback when grids are missing [58].
- 3D near and far from all chunked entities, not only terrain [59].

## GRASS

- Lat-lon edges are straight on the grid; east is normalised to within 360
  degrees of west; plotting handles wraparound [60].
- r.proj precomputes an input-row footprint table per output block (at most
  32 blocks per row); against a run-time search, 8-thread speedups were 3.40x
  vs 2.09x (LAEA, bilinear) and 5.09x vs 4.06x (pole). Footprints come from
  edge columns only, padded by a full row, with a re-read fallback; in
  62,599 blocks the interior never needed more than 0.044 rows beyond the
  edges; a pole inside a cell forces input row 0 [61].
- Geodesic area through GeographicLib: 251199344354.4303 m^2 against an
  exact 251199344354.42985 m^2, where the old method was 0.654% low [62].
- Skip reprojection when the CRS matches [63]. Reproject only as many raster
  cells as the web map shows [64].

## Marble

- Top-down only, no 3D flights; plate carree is more convenient for tasks
  such as a timezone chooser [65].
- Per-pixel scanline inverse projection with Flat and Globe subclasses;
  the per-pixel tile lookup cost was expected, not measured, to matter little
  [66].
- One inverse-Gudermannian term cached per view (hit ratio > 99.99%) [67].
  An `asin` domain check in Lambert azimuthal prevents a NaN and a segfault
  [68].

## OpenLayers and OpenLayers 2

- Raster reprojection: adaptive triangles, exact vertex transforms, affine
  inside, 0.5 px threshold, inverse transform only, source resolution per
  tile at its centre; duplicates on the far side of a globe are left to a
  layer extent [69]. Binary splits, transform caching (30 to 35% fewer
  calls), local coordinate shifting for the affine solve and stitching
  precision [74]. +3.2 KB gzip; stitch lines with semi-transparent sources;
  wrapX simplified by unwrapping, which broke untiled image wrapping [71].
  Moved to WebGL: float32 interpolation in one pass, textures scaled down to
  `MAX_TEXTURE_SIZE` [75].
- OL 6: one world by default (`multiWorld` opt-in), extent applies to the
  whole viewport, constraints in View; OL 6.3: two loader calls across the
  antimeridian instead of a 540-degree extent [70][73].
- Geometries do not carry a projection; `getLength` is planar (factor 1.44
  at 45.6N); geodesic measures added separately [72].
- OL 2: graticule by half-pixel adaptive bisection [76]; projection defaults
  per CRS, and the old example resolution 156543.0339 was wrong
  (156543.03390625) [77]; wrapped maps refuse zooms showing more than one
  world and renderers shift by one world width [78][81]; projection checked
  when features are merged, not once at start [79]; spherical helpers with
  radius 6378137 m [80].

## Leaflet and protomaps-leaflet

- 1.0 made wrapping, bounds and the tile pyramid come from the CRS
  (`wrapLng`, `wrapLat`, `infinite`) and removed Earth-specific hardcoding;
  0.5 had removed default LatLng wrapping [82].
- The antimeridian "magnetize" PR (69 comments) is still open; geometries
  with vertices more than half a world apart still mis-render [83].
- Rotation stays out of core [84]; the CRS is fixed for a map's life [85];
  bounds clamping drifts with inexact round trips (EPSG:28992 needed about
  1e-5, EPSG:31370 1e-3, spherical Mercator round-trips exactly) [86];
  EPSG:4326 TMS has a 2x1 root at 0.703125 deg/px [87].
- protomaps-leaflet: `2 ** z` instead of `1 << z` [88]; label index
  duplicates across the seam [89].

## tangram-es, harp.gl, maptalks, polymaps

- tangram-es: float view matrix without translation [90]; world-to-clip and
  clip-to-screen split so negative `w` is caught [91]; tile wrap state
  removed in favour of wrapping in conversion and a zoom constraint [92].
- harp.gl: mixed LOD with an all-children-or-none rule, off by default,
  `maxVisibleDataSourceTiles` back to 100, cracks fixed with edge
  subdivision (+838 lines), then a minimum tile size [93]. Globe far plane:
  `farMaxRatio` 1.8 to 6.0 times altitude; a ray-based estimate clipped the
  globe when the aspect ratio was near 1, was reverted and re-landed [94].
- maptalks: coordinate order chooses the dateline direction; animations
  crossing it can jump [95].
- polymaps 2.0: zoom independent of tile pixel size, one tile at z0, which
  broke the API [96].

## d3-geo

- Adaptive resampling of geodesic edges [97]; spherical winding opposite to
  RFC 7946, described as "the face is on your right" [98].
- Pluggable `preclip` (sphere, radians) and `postclip` (planar, pixels); the
  clip circle precision was first tied to the projection, then fixed [99],
  and later tightened to 2 degrees [100].
- `geoIdentity` for pre-projected data [101]; automatic Mercator clip, at
  first leaking the clamped extent through the getter [102]; Euler rotation
  with interactive dragging left to versor libraries [103]; full longitude
  normalisation for large rotations [104]; azimuthal antipode guard [105].

## openglobus

- COG reprojection: two-corner window stretching gave seams on UTM tiles;
  replaced by a projected node grid (up to 64, 0.25 tile px), bilinear
  per-pixel source coordinates, and an overview chosen from grid density
  with a 1.4 tolerance. Clamping the layer extent only hid part of the error
  [106].

## iTowns

- 3D Tiles regions converted to bounding spheres for cheaper culling; loose
  for thin, wide regions; API changed [107].
- No subdivision of pole rows at level 5 [108]; one CRS per view [109].
- Surface normals not cached on Coordinates without profiling: the normal
  was about 1.5% of globe tile construction, and converting all GeoJSON
  before filtering by extent cost more [110].
- proj4 transforms cached; a provider stopped scanning every image per tile
  [111].
- Horizon culling skipped for level-1 tiles, later fixed for a globe not at
  the origin [112]; one occlusion point per tile scaled by
  1/cos(alpha/2), replacing 8 and then 4 box corners updated every frame
  [113].
- Dynamic near and far from altitude and horizon, with fog; `farFactor` 20
  to 0.3, `maxFarAltitude` 80,000 m, `minFarDistance` 10,000 m, far-plane
  culling when the far plane is nearer than the horizon [114].
