---
name: projection-and-globe
description: What 38 map engines learnt about where projection math should live (bake time, CPU, or shader), float32 precision at street zoom, curved edges, the antimeridian and the poles, and the extra machinery a globe needs (horizon clipping, culling, per-tile LOD, label occlusion, near/far). Load it when a map-from-scratch request involves choosing a projection, world-scale or Pacific/polar data, a globe or pitched 3D view, zooming to street level over large coordinates, run-time raster reprojection, or measuring distances and areas on the map.
---

# Projection and globe: where the projection math lives

Every renderer turns lon/lat into pixels somewhere. The general engines do it
at run time, for any projection and any camera, and most of their history in
this area is about what that costs: float32 runs out at street scale, straight
edges must bend, the antimeridian and the poles break naive code, a globe
needs its own clipping, culling and level of detail, and every extra
projection touches subsystems that assumed one rectangular world. This
repository already projects at bake time so the renderer only applies an
affine camera [115][116]. This skill covers what is left to decide after that,
how to tell when a request needs projection at run time (a globe, a pitched
view, street zoom over a world), and what the engines learnt when they did
it. Per-engine detail is in [references/engines.md](references/engines.md);
the numbers in brackets point to the Sources list at the end of this file.
Neighbouring skills go deeper on two parts: `float-precision` (coordinate
frames and attribute types in general) and `tile-lod-and-overzoom` (tile
choice under pitch and on a globe).

## 1. First decision: does any projection run at run time?

| The request | Do this |
| --- | --- |
| Flat map, one projection (region or world) | Project in `bake.ts`, ship planar coordinates relative to an origin, and use an affine camera only. |
| Several projections the user switches between | Bake one data set per projection and key every cache by it. Do not add a projection library. |
| Globe, overview zooms only (about z0 to z12) | Sphere positions in float32 are enough. Add the globe machinery from section 5. |
| Globe or 3D zoomed to street level | Use origin-relative positions with the large term in f64 on the CPU, or switch to a flat projection at high zoom (section 2). |
| Imagery in another CRS that cannot be baked | Warp it with an error-bounded mesh (section 6). |

The engines that support many CRSs ended up close to the bake-time answer:

- MapLibre GL JS added arbitrary CRSs only for tiles that are already in that
  CRS. Nothing is reprojected in the client, a planar quad grid stays affine
  per tile and reuses the Mercator shaders, and proj4 is never bundled [4][6].
  The cost: square power-of-two grids only, one CRS per map, no wrap and no
  globe [4].
- iTowns: each view has one CRS, but data need not be in it. A GlobeView
  shows rasters whose source CRS is WGS 84 or Pseudo-Mercator, a PlanarView
  needs all its rasters in one shared CRS, and vectors drawn as 3D objects
  can be in any CRS [109]. Leaflet fixes the CRS for the life of a map
  and recommends separate map instances to switch [85]. d3-geo's null
  projection and `geoIdentity` exist for "fast rendering of pre-projected
  geometry" [101].
- Carrying a projection library is expensive. Cesium's proj4 PR added about
  11,000 lines, about 6,000 of them a bundled copy of proj4, used much more
  memory for unusual projections, and was closed unmerged [22]. Cesium maintainers also refused proj4 in the core build at
  about 25 KB min+gzip, 3.5% of the bundle [23]. OpenLayers raster
  reprojection adds about 3.2 KB gzip [71]. maplibre-rs rejected PROJ as too
  large and not WASM-compatible [14]. MapLibre loads proj4 only into workers
  through a plugin, which adds 2.9 kB (0.9 kB gzip) to the worker [8].
- Datum work belongs at bake time. QGIS picks the PROJ operation once, and
  when a grid file is missing it silently falls back to an inferior operation
  (10 m class). Bundling the grids was rejected because it would lead to "a
  1gb setup file" [58]. In `bake.ts`, use the accurate operation for the
  data's area and fail loudly if its grid is missing. Skip reprojection when
  the source and target CRS are the same (GRASS r.import and v.import) [63].

## 2. Float32 cannot address the world at street scale

- The numbers: about one float32 value per 2.5 m over the Earth's
  circumference [1]. deck.gl objects "wobble" at about Mercator zoom 18 in
  32-bit mode [38]. ortho-earth: float32 at 139 degrees steps 1.5e-5 deg
  (1.4 m), a 3 to 4 px sawtooth at z17.5 [47].
- The fix every engine converged on: keep vertex values small, relative to an
  origin, and add the large term on the CPU in double precision.
  - deck.gl offset mode projects the origin in JavaScript and adds it in clip
    space (`projectionMatrix*offset + projectionCenter`). Before, it added the
    origin in 32-bit GLSL, and the result wobbled [39].
  - tangram-es keeps the camera position in a `dvec3`. Its float view matrix
    holds only the rotation [90].
  - ortho-earth computes `clip = clipT + MVP*(rel,0)`, with `clipT` in f64
    on the CPU. A floor test error went from 9 px to 0.003 px [47].
  - For this repository, baked coordinates quantised relative to a bounding
    box or a tile are the same idea [115]. Keep one origin per region or tile
    when a single origin would span too much.
- Emulated fp64 lost: shaders about 10x slower, attributes stored twice, slow
  compiles on Windows, and drivers that optimised away critical code [29].
  deck.gl made 32-bit "auto offset" the default. Above about z12 it subtracts
  a centre and linearises around it, at the cost of a "low part" attribute
  per position [28][42]. It falls back to plain projection beyond 0.25
  degrees of latitude from the origin [43]. A linear offset scale is wrong by
  roughly 1% per 100 km, so it adds a first-order latitude term [39].
- MapLibre does not extend the globe to street zoom. Around z12 a
  "globeness" uniform blends the vertex projection to Mercator, which works
  because the two converge there [1]. MapLibre Native hands over at z11 to
  z12 [12]. deck.gl GlobeView simply documents no high-precision rendering
  above z12 [30].
- Avoid transcendental functions on large arguments in shaders. MapLibre
  replaced `2*atan(exp(..)) - PI/2` with `sin = (t^2-1)/(t^2+1)` and
  `cos = 2t/(t^2+1)`, where `t = exp(PI - y*2PI)`. The globe had shifted by
  hundreds of metres, atan is inaccurate on some GPUs, and sin/cos are even
  non-monotonic on Mali [1][2]. ortho-earth found that SwiftShader flushes
  `sin` of angles below about 1e-7 rad to zero. It replaced `sin` with a
  Taylor series below 0.1 rad, quantised the origin to 1e-7 deg and folded
  antimeridian deltas in uint. Jitter dropped to 0.02 px or less at z16 to
  z23 [51]. A CPU mirror with `Math.fround` could not reproduce the GPU's
  error; reading real values back did [51].
- Smaller traps: in JavaScript, `1 << z` is 32-bit integer arithmetic, so use
  `2 ** z` [88]. Clamping by project, then unproject, then comparing degrees
  drifts: Leaflet needed tolerances from 1e-9 to 1e-3 depending on the CRS,
  so compare in pixel space instead [86]. Hoist per-view constants out of the
  per-point projection. Marble's cached inverse-Gudermannian term had a hit
  ratio above 99.99% [67].

## 3. Edges that must bend

- A flat renderer with dense baked data needs nothing here. Long edges
  (graticules, great-circle routes, circles, coarse polygons) must be
  resampled after projection. Do it at bake time, with the tolerance in
  output pixels at the deepest zoom:
  - d3-geo bisects each edge on the sphere while the projected midpoint
    deviates by more than the precision (default sqrt(0.5) ~ 0.707 px), to a
    depth of 16, and always splits edges over 30 degrees [97].
  - OpenLayers 2 replaced 50 fixed points per graticule line with the same
    bisection at half a pixel [76].
  - Choose a circle's step from an error budget. d3 went from 6 to 2
    degrees, and the maximum error fell from 4.365 km to about 484 m. Error
    grows with the square of the step [100].
- Decide the edge model before projecting: straight on the lon/lat grid
  (GRASS [60], RFC 7946) or geodesic (d3 [97]). Densify long edges if they
  must look geodesic. Compute a simplification tolerance in the space where
  it is applied: QGIS applied a tolerance computed in metres to degrees, about
  1 degree [53].
- Winding: d3 uses ring orientation to decide which side is inside, so a
  polygon can be larger than a hemisphere. This is the opposite of RFC 7946,
  and mis-wound data renders as "everything except the polygon" [98].
  Normalise winding at bake time.
- On a globe, big flat triangles cut through the sphere. MapLibre subdivides
  earcut's output on a fixed square grid that is shared by polygons and lines
  so neighbours match. Granularity is 128 for fills, which keeps indices
  within 16 bits. Subdividing before earcut was slower, and rasters need a
  finer base grid [1]. Cesium triangulates polygons spanning PI or more in
  stereographic or cylindrical coordinates and splits them at the equator
  [25]. ortho-earth draws each Mercator raster tile as a 16x16 grid (32x32
  below z4) [48]. Do this subdivision at bake time.

## 4. The antimeridian and the poles

- Unwrap longitudes at bake time; never guess at run time. Leaflet's
  per-vertex "magnetize" heuristic stalled for over a decade: it was about
  18% slower where the maintainer asked for 1 to 2% [83]. maptalks lets
  coordinate order choose the short or the long way round [95].
- For a world projection not centred on 0, cut geometry at `lon0 ± 180`
  before projecting. RustGIS uses Liang-Barsky for lines, pairs ring
  crossings for polygons, and stays 1e-9 deg inside the edge. 66 EPSG codes
  with `+pm` had wrong areas, and a datum shift moved the edge about 290 m,
  so it now finds the edge numerically [19].
- Overlap tests across the dateline: compare longitudes as arcs. Cesium's
  `Rectangle.intersection` silently dropped every tile just west of the
  antimeridian [27]. Split data requests in two at ±180 (OpenLayers) [73][70].
  Clamp any tile cover to a sane count: QGIS once requested every tile of a
  zoom level when the extent fell back to the whole world [52].
- World copies: the cheap policy is to show at most one world. OpenLayers 2
  [78][81], OpenLayers 6 by default [70], and tangram-es (wrapping only in
  the lon/lat-to-pixel conversion, plus a zoom limit, which deleted the tile
  wrap state) [92]. If labels must collide across the seam, insert a
  duplicate shifted by one world width (protomaps-leaflet) [89].
- Singularities: Mercator's poles go to infinity, so d3 clips Mercator to the
  world square and clamps planar coordinates to ±1e9 [102]. Azimuthal
  projections returned Infinity at the antipode [105]. In a MapLibre CRS
  PR, a South Pole cell in a north polar stereographic projection (EPSG:3413)
  projected to infinity, and its fill took half the square [8]. Marble's Lambert azimuthal crashed on `asin` arguments
  above 1 for points off the map [68]. Handle out-of-domain points explicitly
  at bake time, and in any inverse projection used for picking.
- A globe fed by Web Mercator data has no data beyond 85.05 degrees.
  MapLibre stretches the edge row to the pole and accepts spikes, such as
  Antarctic ocean polygons [1][3]. iTowns stops subdividing pole rows at
  level 5 [108]. navara scales Mercator geometric error by the cosine of the
  tile's equatorward latitude. Without that it over-refined toward the
  poles [17]. EPSG:4326 pyramids have a 2x1 root, not one square tile [87].

## 5. Globe-only machinery (skip all of it for a flat map)

- Far side: if the depth buffer is free, use it or face culling. MapLibre
  reserves depth for layer order, so it writes the distance to the horizon
  plane into `gl_Position.z`, culls faces as well, and discards line
  fragments, because some phone drivers apply `glDepthRange` and clipping in
  the wrong order [1].
- Horizon culling: test one precomputed occlusion point per tile (iTowns,
  after Cesium), not 8 or 4 box corners every frame [113]. Skip the coarsest
  level [112]. Cesium takes that point from the tile's RTC centre: the
  bounding-sphere centre of a level-0 tile is near the Earth's centre, and
  tiles near the poles vanished [24].
- Tile cover with pitch or on a globe: give each tile its own zoom from its
  3D distance (MapLibre). One replaceable function beat two tuning knobs [5].
  Cover by quadtree descent against the frustum, with about 3 max-level
  tiles around the centre [10][13]. On curved surfaces, fit boxes to 5 or 9
  projected samples rather than a 3-point sphere (deck.gl) [41]. Mixed LOD
  cracks between levels; harp.gl needed edge subdivision and left mixed LOD
  off by default [93]. A top-down flat renderer needs a single zoom.
- Labels and sprites: test clip-space `w <= 0` before dividing, or points
  behind the camera come back mirrored (MapLibre [11], tangram-es [91]).
  Hide far-side billboards with an exact camera-to-anchor ray-sphere test
  (deck.gl). Global back-face culling removed all sprites, and a
  surface-normal test cut off raised anchors near the horizon and was
  abandoned [32][35]. The ray test's depth bias was about 1.8 km at z12 and
  pitch 60 [32].
- Near and far planes: derive them from altitude and the horizon, and cull
  with the same frustum you draw with. iTowns retuned `farFactor` from 20 to
  0.3 [114]. harp.gl's ray-based far plane was reverted the same day and
  re-landed [94]. In deck.gl, a camera parameter used in two meanings made
  bounds of ±1.7e9 and hung the tab [37]. WebGPU clips z to 0..w, WebGL to
  -w..w, and WebGL-style matrices drew nothing on WebGPU [34].
- Camera: keep it north-up unless free rotation is required. deck.gl merged
  ball rotation through the poles, then reverted it (-541 lines) [46]. Euler
  angles are unstable at `rotate [0, ±90]`, so keep a quaternion if users
  drag the globe [103]. Normalise accumulated rotation in long spins [104].
  Engines that left 3D or rotation out did so deliberately: Marble is
  top-down only [65], and Leaflet kept rotation out of core because it
  changes tile cover, clipping and hit testing [84].
- Sphere or ellipsoid: ortho-earth found that sphere formulas inside an
  ellipsoid world shift points about 10 km north (Tokyo 10.1 km, at most
  10.7 km at 45 degrees). The ellipsoid costs about 10% GPU, so it is the
  default only on capable desktops and every overlay must use the same
  formula [49]. Its parity harness found three layers drawn off-screen and a
  187 px error [49].
- Key every cache of projected or tessellated geometry by the projection or
  world mode (ortho-earth) [49].
- Atmosphere, if any: a real-thickness limb is 1 to 1.5% of the radius.
  ortho-earth's old rim was 9%, and it damps ground haze to half of physical
  so thematic colours stay readable [50].

## 6. Raster reprojection at run time, only if it cannot be baked

- First choice: draw tiles in their native projection. Cesium stopped
  reprojecting Web Mercator to geographic on load and got better quality and
  faster loads [21]. iTowns shows rasters in only a few source CRSs per view
  type: WGS 84 or Pseudo-Mercator on a globe, one shared CRS on a plane [109].
- If you must warp, use a mesh of exactly transformed vertices, refined until
  a pixel error bound is met:
  - OpenLayers: 0.5 px, binary instead of 4-way splits, and cached transforms
    (about 30 to 35% fewer transform calls) [69][74]. Its GPU version gained
    float interpolation [75].
  - openglobus: a grid of up to 64 nodes at 0.25 px replaced a two-corner
    stretch whose UTM seams did not match [106].
  - RustGIS: 8 px cells with an exact fallback at the limb and the
    antimeridian, 395 ms down to 100 ms per frame [18].
- Resample inside the warp, not before or after it (QGIS) [57]. On a globe,
  remap Mercator tile rows to latitude, or imagery slides north-south inside
  the tile (deck.gl) [36]. A quad that is not a parallelogram needs projective
  texture coordinates, or the diagonal seam shows [9]. Compute the source
  footprint once: a GRASS table cut sizing from 1.0 to 1.3 s down to under
  0.01 s [61].

## 7. Measuring on the map

Never measure in Web Mercator units. OpenLayers' planar length overstates by
1/cos(latitude): 330 m was reported for 228 m [72]. GRASS moved distance and area
to GeographicLib geodesics; on a half-Finland polygon the old method differed
from GeographicLib by 0.654% in area [62]. For metre-sized symbols, one factor per view is fine near the centre
(QGIS) [56]. deck.gl corrects per vertex with 1/cos(latitude), max error
below 0.003 [44]. Measure on lon/lat (geodesic or WGS84), and draw on the
sphere if the device is weak (ortho-earth) [49].

## What was tried and reverted

- MapLibre: a 1x1 readback once a second to correct `atan` error, removed
  [1].
- deck.gl: global back-face culling and a surface-normal occlusion test for
  globe sprites, both abandoned [35][32]. Ball rotation reverted [46]. The
  projection mode default flipped twice without a stated reason [42].
- harp.gl: ray-based far plane reverted and re-landed [94]. Mixed LOD turned
  back off by default [93].
- Cesium: arbitrary proj4 projections never merged [22].
- Leaflet: the antimeridian heuristic, never merged [83].
- d3-geo: clip-circle precision tied to the projection, then fixed at 6, then
  at 2 degrees [99][100].
- iTowns: far-plane defaults retuned [114]. Bounding regions became spheres,
  which broke the API [107].
- ortho-earth: sphere-everywhere reversed to ellipsoid on capable desktops
  [49].
- openglobus: a two-corner raster stretch replaced by an error-bounded grid
  [106].

## Guidance for a renderer in this repository

1. Write the projection and what is left out in `architecture_selection`.
   `not_doing` is the main lever: globe, pitch, rotation, world copies, more
   than one projection, run-time reprojection. Each of these brought a whole
   subsystem into the engines above [84][65][46].
2. Flat map: project in `bake.ts` with `tools/geo.ts` (`equalEarth`,
   `mercator`) [116] and keep the renderer affine [115]. Quantise relative to
   an origin, and float32 is no longer a problem (section 2).
3. World data: unwrap or cut at the antimeridian, resample long edges in
   output pixels, normalise winding, and drop or clamp out-of-domain points,
   all at bake time (sections 3 and 4). Allow one world on screen.
4. Globe: bake sphere positions relative to a tile or region origin, add the
   origin in f64 on the CPU, and subdivide on a fixed grid at bake time.
   Keep a north-up camera and a horizon test. Use per-tile LOD only if the
   camera pitches. Test `w` for labels, and use a ray-sphere test for
   sprites. Stop at about z12, or plan section 2 for street level.
5. Shader math: no `sin`, `cos` or `atan` on absolute angles. Test on the
   GPU the bench uses (SwiftShader behaves differently [51]), and read
   intermediate values back as colour or transform feedback [34][51].
6. Add a parity check to `verification.checks`: draw known points and
   compare each drawn centroid with the CPU projection. ortho-earth's
   working layers were within 0.03 to 0.4 px, and its broken ones were
   about 10 km north or 187 px south [49].
7. Distances and areas: geodesic on lon/lat (section 7). Caches: key them by
   projection.

## Sources

MapLibre GL JS
1. `ref-repos/maplibre__maplibre-gl-js/developer-guides/globe.md`
2. https://github.com/maplibre/maplibre-gl-js/issues/7419
3. https://github.com/maplibre/maplibre-gl-js/issues/5433
4. `ref-repos/maplibre__maplibre-gl-js/developer-guides/custom-crs.md`; `ref-repos/maplibre__maplibre-gl-js/ARCHITECTURE.md`
5. https://github.com/maplibre/maplibre-gl-js/pull/4779
6. https://github.com/maplibre/maplibre-gl-js/issues/168; https://makewithmaplibre.com/projections/
7. https://github.com/maplibre/maplibre-gl-js/pull/8236
8. https://github.com/maplibre/maplibre-gl-js/pull/8738 (PR body and review comments)
9. https://github.com/maplibre/maplibre-gl-js/pull/7887
10. https://github.com/maplibre/maplibre-gl-js/commit/51d75fc7d; https://github.com/maplibre/maplibre-gl-js/commit/f57818709
11. https://github.com/maplibre/maplibre-gl-js/commit/1eed2ae82

MapLibre Native, maplibre-rs, navara
12. https://github.com/maplibre/maplibre-native/pull/4533
13. https://github.com/maplibre/maplibre-native/commit/d0c103fa8f0bade2be56d50a745f16b4e9ed6b29
14. https://github.com/maplibre/maplibre-rs/issues/139; https://github.com/maplibre/maplibre-rs/pull/340
15. https://github.com/maplibre/maplibre-rs/commit/fa2c436
16. https://github.com/maplibre/navara/blob/main/guide/TILE_TEXTURE_COMPOSITING.md
17. https://github.com/maplibre/navara/blob/main/guide/TILE_TERRAIN_TRAVERSAL.md

RustGIS
18. https://github.com/opengeos/RustGIS/pull/630
19. https://github.com/opengeos/RustGIS/pull/269; https://github.com/opengeos/RustGIS/pull/271
20. https://github.com/opengeos/RustGIS/commit/f65b592

Cesium
21. `ref-repos/CesiumGS__cesium/CHANGES.md`; https://github.com/CesiumGS/cesium/pull/4339
22. https://github.com/CesiumGS/cesium/pull/7502
23. https://github.com/CesiumGS/cesium/pull/6986
24. https://github.com/CesiumGS/cesium/commit/e3b313606
25. https://github.com/CesiumGS/cesium/commit/3033b0c1e543fba30fdc8e32395d34d81e34d7b8; https://github.com/CesiumGS/cesium/commit/b6c35bd710e1e6c7e14561f758832eb5f15a8b5e
26. https://github.com/CesiumGS/cesium/commit/747b938c9ca6de479c2a8e92bab68b9fc5ab7d81
27. https://github.com/CesiumGS/cesium/commit/caaf52f01349e667c84da627660ebb7feabeec70

deck.gl
28. https://github.com/visgl/deck.gl/blob/master/dev-docs/RFCs/v6.1/improved-lnglat-projection-rfc.md; `ref-repos/visgl__deck.gl/dev-docs/RFCs/v6.1/improved-lnglat-projection-rfc.md`
29. https://github.com/visgl/deck.gl/blob/master/docs/developer-guide/fp64.md; `ref-repos/visgl__deck.gl/docs/developer-guide/fp64.md`; https://github.com/visgl/deck.gl/blob/master/docs/whats-new.md; https://github.com/visgl/deck.gl/blob/master/docs/upgrade-guide.md
30. https://github.com/visgl/deck.gl/blob/master/docs/api-reference/core/globe-view.md; `ref-repos/visgl__deck.gl/docs/api-reference/core/globe-view.md`
31. https://github.com/visgl/deck.gl/blob/master/docs/developer-guide/coordinate-systems.md; `ref-repos/visgl__deck.gl/docs/developer-guide/coordinate-systems.md`
32. https://github.com/visgl/deck.gl/pull/10750
33. https://github.com/visgl/deck.gl/pull/3935
34. https://github.com/visgl/deck.gl/pull/10520
35. https://github.com/visgl/deck.gl/pull/9975
36. https://github.com/visgl/deck.gl/pull/10350
37. https://github.com/visgl/deck.gl/pull/5930
38. https://github.com/visgl/deck.gl/commit/d929d5f0; `ref-repos/visgl__deck.gl` at 43fd968b: `docs/advanced/performance.md`
39. https://github.com/visgl/deck.gl/commit/07a35669; https://github.com/visgl/deck.gl/commit/43fd968b; `ref-repos/visgl__deck.gl` at 43fd968b: `docs/api-reference/web-mercator-viewport.md`
40. https://github.com/visgl/deck.gl/commit/79e65643; https://github.com/visgl/deck.gl/commit/e66228af
41. https://github.com/visgl/deck.gl/commit/70524804; https://github.com/visgl/deck.gl/commit/5c748fc6
42. https://github.com/visgl/deck.gl/commit/a5dea825; https://github.com/visgl/deck.gl/commit/d06f13b5; https://github.com/visgl/deck.gl/commit/ec47556a; https://github.com/visgl/deck.gl/commit/9629dc5c; https://github.com/visgl/deck.gl/commit/2a893b75
43. https://github.com/visgl/deck.gl/commit/ec9feac5
44. https://github.com/visgl/deck.gl/commit/9d6d63e0
45. https://github.com/visgl/deck.gl/commit/4571c0b7
46. https://github.com/visgl/deck.gl/commit/93f0fe01; https://github.com/visgl/deck.gl/commit/c62e58e5

ortho-earth (GPL-3; may be adapted here, see the repository licence note)
47. https://github.com/kenjiyoshidahome2026-bit/ortho-earth/blob/main/packages/ortho-core/projector.md; `ref-repos/kenjiyoshidahome2026-bit__ortho-earth/packages/ortho-core/projector.md`; `ref-repos/kenjiyoshidahome2026-bit__ortho-earth/packages/ortho-core/fallback-ladder.md`
48. https://github.com/kenjiyoshidahome2026-bit/ortho-earth/blob/main/packages/ortho-core/raster%20tiles.md; `ref-repos/kenjiyoshidahome2026-bit__ortho-earth/packages/ortho-core/raster tiles.md`
49. https://github.com/kenjiyoshidahome2026-bit/ortho-earth/issues/43
50. https://github.com/kenjiyoshidahome2026-bit/ortho-earth/issues/46
51. https://github.com/kenjiyoshidahome2026-bit/ortho-earth/commit/3f46a73e

QGIS
52. `ref-repos/qgis__QGIS/ChangeLog` line 53299 (2025-04-23, never request every tile in a zoom level)
53. `ref-repos/qgis__QGIS/ChangeLog` line 82879 (2024-08-23, inverted polygon renderer vs on-the-fly simplification)
54. `ref-repos/qgis__QGIS/ChangeLog` line 239746 (2020-09-21, defer clipping after transform); https://github.com/qgis/QGIS/issues/38878
55. https://github.com/qgis/QGIS/pull/44941; https://github.com/qgis/QGIS/issues/44939
56. https://github.com/qgis/QGIS/pull/4381
57. https://github.com/qgis/QGIS/pull/37044; `src/core/raster/qgsrasterprojector.cpp` (in `ref-repos/qgis__QGIS`)
58. https://github.com/qgis/QGIS/issues/30643
59. https://github.com/qgis/QGIS/commit/8f4a3c64df

GRASS
60. `ref-repos/OSGeo__grass/lib/gis/gislib.dox`; https://github.com/OSGeo/grass/blob/main/lib/gis/gislib.dox
61. https://github.com/OSGeo/grass/pull/7807; https://github.com/OSGeo/grass/blob/main/raster/r.proj/footprint.c
62. https://github.com/OSGeo/grass/pull/1283
63. https://github.com/OSGeo/grass/commit/e42a1d76caeee5e51ac284c9630bcdb13a7a7f1e; https://github.com/OSGeo/grass/commit/e33bcaadce751915797fe778aa9ba95356fd9c98
64. https://github.com/OSGeo/grass/commit/599cdff029ea0d5279c33dd83b4d868c4bd86fb4

Marble
65. `ref-repos/KDE__marble/MANIFESTO.txt`; https://invent.kde.org/education/marble/-/blob/master/MANIFESTO.txt
66. `ref-repos/KDE__marble/docs/projects/flatproj/update-1.txt`; https://invent.kde.org/education/marble/-/blob/master/docs/projects/flatproj/update-1.txt
67. https://github.com/KDE/marble/commit/ac2660dd2
68. https://github.com/KDE/marble/commit/396e4725d

OpenLayers
69. `ref-repos/openlayers__openlayers/site/src/doc/tutorials/raster-reprojection.md`
70. `ref-repos/openlayers__openlayers/changelog/upgrade-notes.md`
71. https://github.com/openlayers/openlayers/pull/4122
72. https://github.com/openlayers/openlayers/issues/3533
73. https://github.com/openlayers/openlayers/pull/10807; https://github.com/openlayers/openlayers/issues/10799
74. https://github.com/openlayers/openlayers/commit/726bcbef8; https://github.com/openlayers/openlayers/commit/03c75a864; https://github.com/openlayers/openlayers/commit/30cd0aa58; https://github.com/openlayers/openlayers/commit/83e251621
75. https://github.com/openlayers/openlayers/commit/280b79578; https://github.com/openlayers/openlayers/commit/348ccbc3d; https://github.com/openlayers/openlayers/commit/07e0c0d43

OpenLayers 2
76. https://github.com/openlayers/ol2/blob/master/notes/2.14.md; https://github.com/openlayers/ol2/blob/master/lib/OpenLayers/Geometry/LineString.js; https://github.com/openlayers/ol2/blob/master/lib/OpenLayers/Control/Graticule.js
77. https://github.com/openlayers/ol2/blob/master/notes/2.12.md; https://github.com/openlayers/ol2/blob/master/notes/2.14.md
78. https://github.com/openlayers/ol2/blob/master/notes/2.12.md; https://github.com/openlayers/ol2/blob/master/lib/OpenLayers/Renderer/Elements.js
79. https://github.com/openlayers/ol2/pull/827
80. https://github.com/openlayers/ol2/pull/45
81. https://github.com/openlayers/ol2/commit/0b39d320; https://github.com/openlayers/ol2/commit/2cfe6f83

Leaflet, protomaps-leaflet
82. https://github.com/Leaflet/Leaflet/pull/2247; https://github.com/Leaflet/Leaflet/pull/2345; `ref-repos/Leaflet__Leaflet/CHANGELOG.md`
83. https://github.com/Leaflet/Leaflet/pull/1293
84. https://github.com/Leaflet/Leaflet/issues/268
85. https://github.com/Leaflet/Leaflet/issues/2553
86. https://github.com/Leaflet/Leaflet/issues/2427
87. https://github.com/Leaflet/Leaflet/issues/1207
88. https://github.com/protomaps/protomaps-leaflet/commit/15cb30e; `ref-repos/protomaps__protomaps-leaflet/CHANGELOG.md`
89. `ref-repos/protomaps__protomaps-leaflet/src/labeler.ts`; https://github.com/protomaps/protomaps-leaflet/commit/50f9330

tangram-es, harp.gl, maptalks, polymaps
90. `ref-repos/tangrams__tangram-es/core/src/view/view.h`
91. https://github.com/tangrams/tangram-es/commit/a6e27a8b; https://github.com/tangrams/tangram-es/commit/56d21ccc
92. https://github.com/tangrams/tangram-es/commit/c3dd4a9b
93. https://github.com/heremaps/harp.gl/commit/de9632e7; https://github.com/heremaps/harp.gl/commit/8e7b9928; https://github.com/heremaps/harp.gl/commit/6cb460c2
94. https://github.com/heremaps/harp.gl/commit/7fbaee34; https://github.com/heremaps/harp.gl/commit/8074de50; https://github.com/heremaps/harp.gl/commit/394f28c6; https://github.com/heremaps/harp.gl/issues/1384
95. https://github.com/maptalks/maptalks.js/issues/1061
96. https://github.com/simplegeo/polymaps/commit/6903d67

d3-geo
97. `ref-repos/d3__d3-geo/src/projection/resample.js`; https://github.com/d3/d3-geo/blob/18eb2fb/README.md#projection_precision
98. https://github.com/d3/d3-geo/issues/138; https://github.com/d3/d3-geo/issues/140; https://github.com/d3/d3-geo/blob/18eb2fb/README.md
99. https://github.com/d3/d3-geo/commit/544da8d; https://github.com/d3/d3-geo/commit/ed0791e; https://github.com/d3/d3-geo/pull/108
100. https://github.com/d3/d3-geo/pull/281; https://github.com/d3/d3-geo/pull/282
101. https://github.com/d3/d3-geo/commit/2c51b71; https://github.com/d3/d3-geo/blob/18eb2fb/README.md#path_projection
102. https://github.com/d3/d3-geo/commit/3576c5a; `ref-repos/d3__d3-geo/src/clip/rectangle.js`
103. https://github.com/d3/d3-geo/issues/194
104. https://github.com/d3/d3-geo/commit/c8d5df6; https://github.com/d3/d3-geo/issues/147
105. https://github.com/d3/d3-geo/commit/7dc5ebc; https://github.com/d3/d3-geo/issues/203

openglobus
106. https://github.com/openglobus/openglobus/issues/1097; https://github.com/openglobus/openglobus/issues/1102; https://github.com/openglobus/openglobus/commit/de60c018; `ref-repos/openglobus__openglobus/src/layer/geotiff/GeoTIFFReader.ts`

iTowns
107. https://github.com/iTowns/itowns/commit/f0eaf96; `ref-repos/iTowns__itowns/changelog.md`
108. https://github.com/iTowns/itowns/commit/53a9f6f
109. `ref-repos/iTowns__itowns/docs/tutorials/Fundamentals.md`; `ref-repos/iTowns__itowns/docs/tutorials/3DTiles-mesh-b3dm.md`
110. https://github.com/iTowns/itowns/pull/494
111. https://github.com/iTowns/itowns/commit/a750c793; https://github.com/iTowns/itowns/commit/e8f0ef74
112. https://github.com/iTowns/itowns/commit/de1d3b2e; https://github.com/iTowns/itowns/commit/3660237e
113. https://github.com/iTowns/itowns/commit/0692c059; https://github.com/iTowns/itowns/commit/2073699a; https://github.com/iTowns/itowns/commit/a96a63af
114. https://github.com/iTowns/itowns/commit/56b722b2; https://github.com/iTowns/itowns/commit/f531af66

This repository
115. `skills/map-from-scratch/SKILL.md` (rules: work at bake time) and `skills/map-from-scratch/references/patterns.md` (project at bake time, quantise to 16 bits relative to the bounding box)
116. `tools/geo.ts` (`equalEarth`, `mercator` in the unit square, latitude clamped to ±85.0511)
