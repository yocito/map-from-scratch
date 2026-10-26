---
name: float-precision
description: What 44 map engines learnt about float32 (and fixed-point, integer and CSS/Canvas) precision, and which of their fixes a purpose-built renderer needs. Load it when choosing the coordinate frame, vertex attribute types, quantisation grid or shader precision qualifiers of a renderer, when the request zooms past ~z15, draws a globe or 3D with a depth buffer, or dashes long lines, and whenever a bench or screenshot shows jitter, snapping, wobble, seams, z-fighting, banding, drifting patterns or geometry that collapses at deep zoom.
---

# Float precision: keep large numbers off the GPU

A float32 has a 24-bit significand: about 16 million steps over whatever range
a number spans. Over the Earth's circumference that is one value per ~2.5 m
[1]; at the Earth's radius (ECEF) about 1 m [21]; integers above 2^24 are no
longer exact [66]. Every engine that uploaded world coordinates, or let the
GPU add a large camera term to a small offset, saw the same symptoms at street
zoom: vertices wobble or snap while the camera moves [21][40][74], tiles
show seams [77][85], depth z-fights [32], dashes and patterns drift
[52][80], and thin attributes quantise to nothing on overzoom [101]. The
same limit hides outside shaders: Canvas 2D matrices are float32 [96], CSS
transforms break past 2^23 px [88], SVG locked Firefox past ~15,000 px
[84], and JS `<<` is 32-bit [97]. The cure every engine converged on is the
same: keep numbers small where float32 does the arithmetic, and do the large
subtraction once, in float64 or integers, on the CPU or at bake time.

## Decide at design time

1. **Is one origin enough?** Work out the worst pixel error of the plan
   before writing the shader (rule of thumb below). City-scale data with a
   bounded zoom needs nothing more than the repo's usual pattern: positions
   quantised over the bounding box, camera subtracted in the vertex shader
   (patterns.md; 04, 05 [105]). A world map that zooms to streets does not.
2. **If not, use tile- or chunk-local coordinates (RTC)**, with the tile
   origin composed in float64 on the CPU into a per-tile float32 matrix or
   uniform. Every engine with a tiled pipeline does this [12][15][19][58]
   [98][46]. Use split high/low attributes (RTE) only for untiled, freely
   placed features at close range [21][23]. Use emulated fp64 only for the
   few values that cannot be made local [41][81].
3. **Choose the fixed-point scale of every packed attribute** from its
   largest value at the deepest overzoom you support, and its smallest
   step from what the screen must show [4][14][34][98][101].
4. **Precision qualifiers**: `highp` for positions, SDF edges, texture
   coordinates into data rasters and large-range values; `mediump` only for
   colour [3][5][11][13]. Detect fragment `highp` on mobile and degrade
   [82][103].
5. **Depth buffer only for 3D.** A 2D map uses painter's order and keeps
   early-Z; a globe with close-up 3D needs a plan (near plane, log depth)
   [7][26][32][54].

## Rule of thumb for this repo's pattern

The examples upload positions in grid units 0..1 and compute
`(a_pos - u_cam.xy) * u_cam.z` in the vertex shader [105]. The subtraction
is exact when both are close; what rounds is `u_cam.xy` itself, by up to
2^-24 of the grid. The whole frame then moves in steps of about
`2^-24 * u_cam.z` px (arithmetic, not a cited measurement). For a 0..1
world grid drawn at 256 * 2^z px that step is 2^(z-16) px: harmless below
z12, a visible snap near z16-18, which is where deck.gl's 32-bit projection
began to wobble [40]; it looks like the "freeze, then snap" navara describes
for a different float32 cause [21]. For a
23-ward grid (~40 km) the same step stays below 0.1 px up to ~40 px per
metre. When the step reaches ~0.1 px, rebase: pass the camera relative to
the tile or block origin (computed in float64 in JS/C), not the absolute
camera. Check the quantisation grid separately: a u16 grid over the bbox is
the floor of positional accuracy (patterns.md).

## What engines decided, and what it cost

**Origin-relative coordinates (RTC).** MapLibre normalises each tile to an
8192 integer extent, 1/16 px with 512-px tiles, and allows overshoot for
buffers [12]; maplibre-rs composes per-tile `Matrix4<f64>` on the CPU and
downcasts to f32 "because 32bit is more performant and is better
supported", at one matrix per tile per frame [15]. Tangram stores 0..4096 as
`gl.SHORT`, half the bytes of float32, with a per-tile model matrix [98].
navara measured RTC at 12 B/vertex with stock shaders against RTE at 24
B/vertex plus a camera encode every frame [21]. QGIS moved point-cloud and
vector chunks to a per-chunk corner origin with double bounds [58];
OpenLayers rebased WebGL vertices to the replay extent, then to the view at
buffer-build time, at the cost of rebuilding buffers when the extent changes
[75][76]. deck.gl's MVT layer moved the tile offset out of the model matrix
into `coordinateOrigin` so the large term never reaches the GPU [46].

**Large terms added in float64, outside the shader.** deck.gl fixed the
wobble of meter-offset mode by projecting the origin in JS and adding it in
clip space ("the key to offset mode precision") [42]; ortho-earth uses the
same form, `clip = clipT + MVP*(rel,0)` with `clipT` in f64, and cut a floor
test from 9 px error to 0.003 px [54]. Where a sum must happen in a shader,
add the large terms first: deck.gl's raster and projection fixes [50].

**Emulated fp64, then away from it.** deck.gl's double-float GLSL gave a
~46-bit significand, at ~10x shader time, 2x attribute memory, slow Windows
compiles and NVIDIA compilers optimising the error terms away [41][35].
Its replacement keeps plain 32-bit Mercator below ~z12 and above it
projects a delta from a viewport-centre origin, with a CPU-made low part per
position [35][44]; fp64 became an opt-in extension [44]. OpenLayers added
float64 helpers only for the fill-pattern origin and made tile extents
tile-local [81].

**Split high/low needs an order guard.** Compilers reassociate
`(high-camHigh)+(low-camLow)`; navara multiplies by a uniform `u_rteOne`
(a literal 1.0 is folded away), after Chrome/ANGLE-Metal froze geometry
then snapped it by 0.25-0.5 m [21]. deck.gl needed the same uniform ONE on
NVIDIA [41].

**Cancellation-free formulas.** MapLibre's globe gets sin/cos(lat) from
`t=exp(...)` as (t^2-1)/(t^2+1), 2t/(t^2+1), and removed a once-a-second
1x1 readback that corrected atan per GPU [1][2]. ortho-earth replaced
`cos-1` by `-2 sin^2(θ/2)`, small-angle `sin` by a Taylor series (SwiftShader
flushed sin below ~1e-7 rad to zero), and `log2(1+w)`/`exp2(x)-1` by series
log1p/expm1, which had quantised depth to 0.76 m steps [54][55][57].
Area, centroid and winding on projected coordinates subtract the first
vertex or the mean first [83][87][95][102]; QGIS triangulates in an
origin-offset local plane after artefacts between roofs and walls [61].

**Fixed-point attributes.** MapLibre halved glyph offset precision (1/64 to
1/32 px) to double the longest label in int16 [4][14]; Cesium went the
other way, x4 for 0.25 px, to stop small text misaligning [34]. Tangram
packs heights in 1/16 m [98] and stores line width in style-zoom units
because a 10 px line from z16 tiles was ~8 px at z21 and gone at z24 [101].
Cesium keeps quantised attributes on the GPU and decodes with one
multiply-add per attribute [29].

**Long accumulators.** Distance along a line overflows float32 long before
the line ends. OpenLayers splits it into low/high attributes and reduces
each mod the pattern length (artefacts above z20) [80]; deck.gl reduces
modulo the period before mixing with local coordinates [38]; navara stores
length as multiples of 16384 m plus a remainder and computes phase in u32
[22]. deck.gl's first 64-bit fix for pattern drift was not enough; reducing
the origin modulo the LCM of the pattern periods was [52]. ortho-earth
computes resample positions as exact u32 fractions because f32 drifted 1e-4
texel over 3600 texels [53].

**CPU-side 2D backends.** protomaps-leaflet's labels drifted above z24 until
translations were subtracted in JS before one small `ctx.translate` [96].
Leaflet keeps layers relative to a per-zoom pixel origin and resets the
view when the pane offset reaches 2^23 px [88]; ol2's SVG renderer
recentres at 15,000 px [84][86]. OpenLayers and ol2 compute every tile's
position from origin plus integer index, never by accumulating deltas, which
fixed seams and cache misses [77][85].

**Depth.** MapLibre set the near plane to height/50 to stop z-fighting in
custom 3D layers [7]. Cesium split the view into frustums (commands drawn up
to 3 times) [32], then made logarithmic depth the default (3 frustums to 1)
at the cost of early-Z and a run of clipping bugs [26]. ortho-earth found
that log depth must be written per fragment in every depth-writing pass:
terrain-only created a new band, all-pass cost +0.38 ms (~8%) [56].

## Tried and reverted

- MapLibre's per-GPU atan correction by 1x1 readback: removed, not adapted [1].
- deck.gl: fp64 per layer, then default auto-offset, back to the 6.0 mode,
  then auto-offset again; fp64 moved to an extension [41][44].
- OpenLayers: a "faster" corner-vertex winding test, patched twice for
  duplicate vertices, reverted to the full shoelace sum [79].
- Leaflet: rounding fitBounds sizes, reverted for rounding the scale [94].
  A PR to stop rounding path pixels stalled on legacy-browser re-testing,
  although no render-time difference was measured and the data looked
  better unrounded [91].
- Tangram: label collision in global Mercator metres, reverted next day [104].
- MLT: ALP float encoding removed, back in v2 exception-free; it gains
  +0.0%/+0.1% on basemaps [18][20].
- Cesium: shader-dequantisation option for Draco removed; Draco attribute
  quantisation disabled then restored [27].
- ortho-earth: terrain-only per-fragment depth; v1's two-regime Jacobian [54][56].

## Guidance for a renderer here

- **Bake it away first.** Project and quantise at bake time into tile-,
  block- or bbox-local integers, keep origins as doubles in the index, and
  store offset/scale at full precision with a round-trip test [12][19][62].
  The engines' run-time machinery (RTE, fp64, auto-offset) exists because
  they accept arbitrary data; a fixed dataset rarely needs it [39][42].
- **Skip what the purpose excludes.** No globe: skip the trig rewrites. No
  3D: no depth buffer, no log depth. No deep zoom: one bbox origin is
  enough (rule of thumb above). Microcontroller: integers throughout, and
  clamp zoom and tile indices at the type boundary [16]; check world
  coordinate math for 32-bit overflow on wasm32 too [25].
- **Validate after quantising.** Quantisation can make consecutive points
  equal (lines drawn as triangles) and rings touch (ear clipping fails)
  [99][100]; drop zero-length segments at bake time and keep a sub-pixel
  epsilon in the shader [43]. Assert units before scaling: radians scaled as
  degrees quantised ~60x coarser [70].
- **Quantise sort keys and compare in pixel space** when two
  implementations must agree [8][92].
- **Round only at the last step.** Keep geometry at full precision for
  bounds and picking; snap translation to device pixels only for raster or
  pixel art [6][89][93].
- **Hand WebGL Float32Array**; do CPU math in float64 and convert once [10].
- **Bake-time aggregates**: compensated (Kahan/Neumaier) sums, no fast-math
  in the baker, and reference values from a higher-precision tool [67][69].
- **Measure on real GPUs.** ortho-earth's depth band did not reproduce in
  SwiftShader [56], and JS `Math.fround` mirrors missed the GPU builtin's
  error; reading values back by transform feedback settled it [57].

Per-engine detail, with every number: [references/engines.md](references/engines.md).

## Sources

Local paths are relative to the repository root.

1. ref-repos/maplibre__maplibre-gl-js/developer-guides/globe.md
2. https://github.com/maplibre/maplibre-gl-js/issues/7419
3. https://github.com/maplibre/maplibre-gl-js/commit/10315c051 ; https://github.com/maplibre/maplibre-gl-js/commit/a72aab768 ; https://github.com/maplibre/maplibre-gl-js/commit/293c80c69
4. https://github.com/maplibre/maplibre-gl-js/commit/c340ebe3d
5. https://github.com/maplibre/maplibre-gl-js/commit/460c28541
6. https://github.com/maplibre/maplibre-gl-js/commit/19d233ebf
7. https://github.com/maplibre/maplibre-gl-js/commit/5cf6e5f52
8. https://github.com/maplibre/maplibre-gl-js/commit/14b0bb383
9. https://github.com/maplibre/maplibre-gl-js/commit/58a73906d
10. https://github.com/maplibre/maplibre-gl-js/commit/30ab70367
11. https://github.com/maplibre/maplibre-gl-js/commit/dda75ad45
12. ref-repos/maplibre__maplibre-native/docs/mdbook/src/design/coordinate-system.md
13. https://github.com/maplibre/maplibre-native/commit/458de43b9
14. https://github.com/maplibre/maplibre-native/commit/673f9e364804b4c3f449c8619e767a7b40e5350e
15. https://github.com/maplibre/maplibre-rs/blob/main/maplibre/src/coords.rs ; ref-repos/maplibre__maplibre-rs/maplibre/src/coords.rs ; ref-repos/maplibre__maplibre-rs/maplibre/src/render/tile_view_pattern/pattern.rs ; https://github.com/maplibre/maplibre-rs/commit/d8c2844
16. https://github.com/maplibre/maplibre-rs/issues/161 ; https://github.com/maplibre/maplibre-rs/pull/273 ; https://github.com/maplibre/maplibre-rs/issues/73
17. https://github.com/maplibre/maplibre-tile-spec/blob/main/docs/specification/v2.md ; ref-repos/yuiseki__maplibre-tile-spec/docs/specification/v2.md
18. https://github.com/maplibre/maplibre-tile-spec/blob/main/rust/mlt-core/CHANGELOG.md ; ref-repos/yuiseki__maplibre-tile-spec/rust/mlt-core/CHANGELOG.md ; https://github.com/maplibre/maplibre-tile-spec/blob/main/docs/encodings.md ; ref-repos/yuiseki__maplibre-tile-spec/docs/encodings.md ; https://github.com/maplibre/maplibre-tile-spec/blob/main/docs/benchmarks.md ; ref-repos/yuiseki__maplibre-tile-spec/docs/benchmarks.md
19. https://github.com/maplibre/maplibre-tile-spec/blob/main/docs/overview.md ; ref-repos/yuiseki__maplibre-tile-spec/docs/overview.md
20. https://github.com/yuiseki/maplibre-tile-spec/commit/c5bb4d93 ; https://github.com/yuiseki/maplibre-tile-spec/commit/460df66a ; https://github.com/yuiseki/maplibre-tile-spec/commit/4b6fb76e ; https://github.com/yuiseki/maplibre-tile-spec/commit/774768aa
21. https://github.com/maplibre/navara/blob/main/guide/RTC_VS_RTE.md ; ref-repos/maplibre__navara/guide/RTC_VS_RTE.md ; https://github.com/maplibre/navara/blob/main/shaders/glsl/chunks/rte_pars_vertex.glsl
22. https://github.com/maplibre/navara/blob/main/guide/POLYLINE_DASH.md
23. https://github.com/maplibre/navara/pull/373 ; https://github.com/maplibre/navara/pull/666
24. https://github.com/opengeos/RustGIS/pull/269 ; https://github.com/opengeos/RustGIS/pull/271
25. https://github.com/reearth/reearth-papers/commit/9c87421 ; https://github.com/reearth/reearth-papers/commit/4e9fcb0 ; https://github.com/reearth/reearth-papers/commit/50a7e17
26. ref-repos/CesiumGS__cesium/CHANGES.md ; https://github.com/CesiumGS/cesium/pull/5851 ; https://github.com/CesiumGS/cesium/pull/8727 ; https://github.com/CesiumGS/cesium/pull/8600
27. https://github.com/CesiumGS/cesium/issues/9847 ; https://github.com/CesiumGS/cesium/pull/9904 ; https://github.com/CesiumGS/cesium/pull/6559
28. https://github.com/CesiumGS/cesium/issues/4563
29. https://github.com/CesiumGS/cesium/pull/3891
30. https://github.com/CesiumGS/cesium/pull/6201
31. https://github.com/CesiumGS/cesium/pull/6615
32. https://github.com/CesiumGS/cesium/pull/261
33. https://github.com/CesiumGS/cesium/commit/16668af98 ; https://github.com/CesiumGS/cesium/commit/a678cd98d ; https://github.com/CesiumGS/cesium/commit/d98cfda35 ; https://github.com/CesiumGS/cesium/commit/d8c11783c
34. https://github.com/CesiumGS/cesium/commit/e946c0260ce760cda8388a7f3699328e3eff35e2
35. https://github.com/visgl/deck.gl/blob/master/dev-docs/RFCs/v6.1/improved-lnglat-projection-rfc.md ; ref-repos/visgl__deck.gl/dev-docs/RFCs/v6.1/improved-lnglat-projection-rfc.md ; https://github.com/visgl/deck.gl/blob/master/docs/developer-guide/fp64.md ; ref-repos/visgl__deck.gl/docs/developer-guide/fp64.md ; https://github.com/visgl/deck.gl/blob/master/docs/whats-new.md ; https://github.com/visgl/deck.gl/blob/master/docs/upgrade-guide.md
36. https://github.com/visgl/deck.gl/blob/master/dev-docs/RFCs/v5.2/unified-32-and-64-bit-project-api-rfc.md ; ref-repos/visgl__deck.gl/dev-docs/RFCs/v5.2/unified-32-and-64-bit-project-api-rfc.md
37. https://github.com/visgl/deck.gl/blob/master/docs/api-reference/core/globe-view.md ; ref-repos/visgl__deck.gl/docs/api-reference/core/globe-view.md
38. https://github.com/visgl/deck.gl/blob/master/dev-docs/RFCs/v9.4/path-dash-rfc.md ; ref-repos/visgl__deck.gl/dev-docs/RFCs/v9.4/path-dash-rfc.md
39. https://github.com/visgl/deck.gl/blob/master/docs/developer-guide/coordinate-systems.md ; ref-repos/visgl__deck.gl/docs/developer-guide/coordinate-systems.md
40. https://github.com/visgl/deck.gl/commit/d929d5f0 ; ref-repos/visgl__deck.gl @43fd968b:docs/advanced/performance.md
41. https://github.com/visgl/deck.gl/commit/84653215 ; https://github.com/visgl/deck.gl/commit/bc138860 ; https://github.com/visgl/deck.gl/commit/15ee077f ; https://github.com/visgl/deck.gl/commit/bced298d ; ref-repos/visgl__deck.gl @43fd968b:docs/advanced/64-bits.md
42. https://github.com/visgl/deck.gl/commit/07a35669 ; https://github.com/visgl/deck.gl/commit/43fd968b ; ref-repos/visgl__deck.gl @43fd968b:docs/api-reference/web-mercator-viewport.md
43. https://github.com/visgl/deck.gl/commit/0fe74cae ; https://github.com/visgl/deck.gl/commit/adeeedd7
44. https://github.com/visgl/deck.gl/commit/a5dea825 ; https://github.com/visgl/deck.gl/commit/d06f13b5 ; https://github.com/visgl/deck.gl/commit/ec47556a ; https://github.com/visgl/deck.gl/commit/9629dc5c ; https://github.com/visgl/deck.gl/commit/2a893b75
45. https://github.com/visgl/deck.gl/commit/ec9feac5
46. https://github.com/visgl/deck.gl/commit/08d9c960
47. https://github.com/visgl/deck.gl/commit/2251085c ; https://github.com/visgl/deck.gl/commit/63506779
48. https://github.com/visgl/deck.gl/commit/9d6d63e0
49. https://github.com/visgl/deck.gl/commit/b7c75e4a ; https://github.com/visgl/deck.gl/commit/7ba2daff
50. https://github.com/visgl/deck.gl/commit/e6d41fec ; https://github.com/visgl/deck.gl/commit/1e788e60
51. https://github.com/visgl/deck.gl/commit/ae842ef9 ; https://github.com/visgl/deck.gl/commit/220a07ed
52. https://github.com/visgl/deck.gl/commit/b0b9ceed ; https://github.com/visgl/deck.gl/commit/dd24687c
53. https://github.com/kenjiyoshidahome2026-bit/ortho-earth/blob/main/packages/ortho-core/perf%20plan.md ; ref-repos/kenjiyoshidahome2026-bit__ortho-earth/packages/ortho-core/perf plan.md
54. https://github.com/kenjiyoshidahome2026-bit/ortho-earth/blob/main/packages/ortho-core/projector.md ; ref-repos/kenjiyoshidahome2026-bit__ortho-earth/packages/ortho-core/projector.md ; https://github.com/kenjiyoshidahome2026-bit/ortho-earth/blob/main/packages/ortho-core/fallback-ladder.md ; ref-repos/kenjiyoshidahome2026-bit__ortho-earth/packages/ortho-core/fallback-ladder.md
55. https://github.com/kenjiyoshidahome2026-bit/ortho-earth/issues/46
56. https://github.com/kenjiyoshidahome2026-bit/ortho-earth/issues/62
57. https://github.com/kenjiyoshidahome2026-bit/ortho-earth/commit/3f46a73e
58. ref-repos/qgis__QGIS/ChangeLog:77507 ; https://github.com/qgis/QGIS/commit/58e47f19f4 ; https://github.com/qgis/QGIS/commit/3cde17724e ; https://github.com/qgis/QGIS/commit/4f183696b0 ; https://github.com/qgis/QGIS/commit/bfa8ce048b
59. https://github.com/qgis/QGIS/issues/30643
60. https://github.com/qgis/QGIS/commit/d4f69b3724 ; https://github.com/qgis/QGIS/commit/3f9cc5d3e7 ; https://github.com/qgis/QGIS/commit/8b37ea2b05
61. https://github.com/qgis/QGIS/commit/042bf97336 ; https://github.com/qgis/QGIS/commit/5b74bdfe21 ; https://github.com/qgis/QGIS/commit/59fa541bc0
62. https://github.com/qgis/QGIS/commit/d5344e584b ; https://github.com/qgis/QGIS/commit/70dd22392d
63. ref-repos/OSGeo__grass/raster/r.compress/r.compress.md
64. ref-repos/OSGeo__grass/lib/raster/rasterlib.dox ; https://github.com/OSGeo/grass/blob/main/lib/raster/rasterlib.dox
65. ref-repos/OSGeo__grass/lib/raster3d/raster3dlib.dox ; https://github.com/OSGeo/grass/blob/main/lib/raster3d/raster3dlib.dox
66. https://github.com/OSGeo/grass/pull/7807
67. https://github.com/OSGeo/grass/pull/1283
68. https://github.com/OSGeo/grass/commit/8d9e430c5 ; https://github.com/OSGeo/grass/commit/0e24a5a66 ; https://github.com/OSGeo/grass/commit/c6c94e04c
69. https://github.com/OSGeo/grass/commit/f75284087cd89e160dffdadce3c1c9c116bad593 ; https://github.com/OSGeo/grass/commit/c7928beda
70. ref-repos/KDE__marble/tools/vectorosm-tilecreator/VectorClipper.h ; https://invent.kde.org/education/marble/-/blob/master/tools/vectorosm-tilecreator/VectorClipper.h ; https://github.com/KDE/marble/commit/915f67f0c
71. https://github.com/KDE/marble/commit/ac2660dd2
72. https://github.com/KDE/marble/commit/75fe1f3d2 ; https://github.com/KDE/marble/commit/73c4289d2
73. https://github.com/KDE/marble/commit/396e4725d
74. https://github.com/openlayers/openlayers/pull/5462 ; https://github.com/openlayers/openlayers/pull/5462#issuecomment-226815825
75. https://github.com/openlayers/openlayers/commit/28e51740c
76. https://github.com/openlayers/openlayers/commit/fb455891c ; https://github.com/openlayers/openlayers/commit/75eb62363
77. https://github.com/openlayers/openlayers/commit/7f088c2eb
78. https://github.com/openlayers/openlayers/commit/78bf0a367
79. https://github.com/openlayers/openlayers/commit/c490745ff ; https://github.com/openlayers/openlayers/commit/f2b790adf ; https://github.com/openlayers/openlayers/commit/c1a547a9a
80. https://github.com/openlayers/openlayers/commit/3649f42bd
81. https://github.com/openlayers/openlayers/commit/206550414 ; https://github.com/openlayers/openlayers/commit/ced1c1903 ; https://github.com/openlayers/openlayers/commit/ba3a2e39b
82. https://github.com/openlayers/openlayers/commit/3849cf272
83. https://github.com/openlayers/openlayers/commit/4597eee9a
84. https://github.com/openlayers/ol2/blob/master/lib/OpenLayers/Renderer/SVG.js ; ref-repos/openlayers__ol2/lib/OpenLayers/Renderer/SVG.js ; https://github.com/openlayers/ol2/blob/master/notes/2.14.md ; https://github.com/openlayers/ol2/commit/c12cb25a
85. https://github.com/openlayers/ol2/issues/587
86. https://github.com/openlayers/ol2/commit/6ef5e395
87. https://github.com/openlayers/ol2/commit/8c93d477
88. ref-repos/Leaflet__Leaflet/docs/examples/extending-2-layers/index.md ; https://github.com/Leaflet/Leaflet/issues/3608 ; https://github.com/Leaflet/Leaflet/commit/c5172f30 ; https://github.com/Leaflet/Leaflet/commit/17c180e1
89. ref-repos/Leaflet__Leaflet/CHANGELOG.md ; https://github.com/Leaflet/Leaflet/issues/1085 ; https://github.com/Leaflet/Leaflet/pull/5148
90. https://github.com/Leaflet/Leaflet/pull/5544 ; https://github.com/Leaflet/Leaflet/pull/7100 ; https://github.com/Leaflet/Leaflet/commit/cc9f327b
91. https://github.com/Leaflet/Leaflet/issues/4745 ; https://github.com/Leaflet/Leaflet/pull/4808
92. https://github.com/Leaflet/Leaflet/issues/2427
93. https://github.com/Leaflet/Leaflet/commit/228d3572 ; https://github.com/Leaflet/Leaflet/commit/a9742e0d
94. https://github.com/Leaflet/Leaflet/commit/b511c7bc ; https://github.com/Leaflet/Leaflet/commit/36b60b7c ; https://github.com/Leaflet/Leaflet/commit/d9846d10 ; https://github.com/Leaflet/Leaflet/commit/7c3d7cb1 ; https://github.com/Leaflet/Leaflet/commit/3a2331d6
95. https://github.com/Leaflet/Leaflet/commit/0dd15699 ; https://github.com/Leaflet/Leaflet/commit/715cf696 ; ref-repos/Leaflet__Leaflet/src/geometry/PolyUtil.js
96. https://github.com/protomaps/protomaps-leaflet/issues/23 ; https://github.com/protomaps/protomaps-leaflet/commit/6e39952
97. https://github.com/protomaps/protomaps-leaflet/commit/15cb30e ; ref-repos/protomaps__protomaps-leaflet/CHANGELOG.md
98. https://github.com/tangrams/tangram/blob/master/src/utils/geo.js ; ref-repos/tangrams__tangram/src/utils/geo.js ; https://github.com/tangrams/tangram/blob/master/src/styles/polygons/polygons.js ; https://github.com/tangrams/tangram/commit/9c6123a3
99. https://github.com/tangrams/tangram/issues/457
100. https://github.com/tangrams/tangram/issues/456
101. https://github.com/tangrams/tangram/issues/267 ; https://github.com/tangrams/tangram/commit/0f800cea ; https://github.com/tangrams/tangram/commit/b2888a92
102. https://github.com/tangrams/tangram/commit/35d4982c
103. https://github.com/tangrams/tangram/commit/97327113 ; https://github.com/tangrams/tangram/commit/a66e4dce ; https://github.com/tangrams/tangram/commit/1fd0879d
104. https://github.com/tangrams/tangram/commit/b041b687 ; https://github.com/tangrams/tangram/commit/f918af75
105. skills/map-from-scratch/references/patterns.md ; examples/02-world-population-mobile/map.ts ; examples/04-osm-node-density/density.ts ; examples/05-tokyo-roads-native/roads.c
