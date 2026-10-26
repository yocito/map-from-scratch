---
name: style-and-expressions
description: How map engines turn a style (rules, filters, zoom stops, data-driven expressions, feature state) into colours, widths and visibility, where they evaluate it (bake time, tile build, per frame, in the shader), and what each choice cost them. Load it when a map-from-scratch request colours or filters features by attribute or zoom, must reproduce a MapLibre/Mapbox, MapCSS or SLD style, needs run-time restyling, highlighting, hover state or time/threshold filtering, or when style evaluation shows up in tile-build or frame time.
---

# Style and expressions: resolve the style before the renderer sees the data

A style maps each feature, at each zoom, to "draw or not, in which pass,
with which colour, width and pattern". General engines receive the style
at run time, so they parse it, interpret filters and expressions per
feature in a worker or tile builder, keep an attribute bag per feature for
the interpreter to read, and spend years making that interpreter cheaper.
Most of that machinery exists because the style is unknown until run time
and may change. A renderer made for one request usually knows its style
when it bakes the data. The decisions are then: which parts of the style
really must stay live (restyle, highlight, a time slider, continuous zoom
interpolation), how to keep those few on the GPU, and how to carry the
reference renderer's semantics correctly if a third-party style is the
source.

Per-engine detail and smaller decisions:
[references/engines.md](references/engines.md). Numbers in brackets refer
to the Sources list at the end of this file.

## First question: what must stay live?

| The request | Where style is resolved | Engines that show the cost of the other way |
| --- | --- | --- |
| Fixed look, no style UI | Bake: class id per feature, draw order, constant colours per pass | Organic Maps compiles MapCSS to binary rules offline [161]; kothic-js compiles MapCSS to JS [185]; reearth-papers commits pre-translated recipes [16] |
| Choropleth or classes that the user may switch, highlight, select | Bake geometry once; per-feature row in a palette/style texture, rewritten on change | navara batch texture [4]; ortho-earth: 0 re-bakes per toggle [41]; this repo's 02 already uses one texel per country [188] |
| Time scrub or threshold filter | Bake the key (time, value) as a vertex attribute; a uniform range decides visibility in the vertex shader | deck.gl DataFilterExtension: 1 attribute + 1 uniform [35][37] |
| Width or opacity that follows fractional zoom | One uniform per layer per frame for zoom-only expressions | ortho-earth (a) class [42]; navara re-evaluates zoom-dependent layers only [8][184] |
| Users type expressions at run time | Parse once, compile to typed closures or shader code; never interpret per feature from strings | Cesium point clouds to GLSL [31]; QGIS point-cloud filters [49]; reearth AST cache [26] |

Every engine that kept a run-time interpreter later spent commits making
it cheaper, with real gains: RustGIS 225 to 119 ms for a z12 Manhattan view
by evaluating feature-free paint once per layer [13]; tangram-es filtering
time -36% and tile build -23% by ordering filters cheapest first [100];
OsmAnd 2,700 to 1,901 ms for 45 London tiles by clearing only the result
slots that were written [155]; MapLibre Native 70% faster multi-source
renders by caching the ordered layer list instead of hashing ids [3]. Each
of these is a cost that bake-time resolution removes entirely.

## What the engines decided

### Where the style is evaluated

- Offline compile. Organic Maps authors styles in a MapCSS dialect and
  compiles them with a customised Kothic into binary `drules_*.bin`, plus
  a `.txt` dump for debugging; every change needs a regenerate step and a
  separate commit [161][162]. OSM tags are mapped at map-build time to a
  closed, numbered type list, 1-8 types per feature in 3 header bits; new
  types reuse deprecated lines to keep ids stable [163][164]. kothic-js
  converts MapCSS into a `restyle(tags, zoom, type)` JS function [185].
  reearth-papers translates MapLibre styles into ezu renderer recipes in a
  script and commits them, because the WASM runtime ships only the
  renderer [16][17][18]. mapsforge writes only tags listed in the
  renderer's tag mapping, with ids assigned by frequency so common tags
  are one byte [168].
- Run-time interpreter. Mapnik made every symbolizer property an
  expression in 3.0 and then clawed back the cost in 4.3.1: boolean filter
  evaluation, rules indexed by an `[attr] = 'string'` condition, direct
  string-literal compares [133][136][137]. tangram-es sorts filters at
  scene load (globals before properties, JS last, highest zoom range first)
  [100] and interns draw-rule names as integers [95]. OsmAnd moved input
  values from a hash to an array indexed by value-definition id [156] and
  clears only populated result slots [155]. Galileo replaced its ad-hoc
  `StyleValue` enum with a MapLibre-compatible expression engine, deleting
  a 1,685-line module [175][176].
- In the shader. Cesium transpiles 3D Tiles style expressions to GLSL for
  point clouds; the language must be implementable both by an interpreter
  and by a GLSL transpiler, constant subexpressions should fold, and every
  style change recompiles the shader [31]. OpenLayers compiles all flat
  style rules to shaders over one shared attribute buffer, one pass per
  rule [78][79][80].
- Style as code. protomaps-leaflet removed its MapLibre JSON support
  (under 20% of the spec, and MapLibre styles with dozens of road layers
  blocked the UI) in favour of `PaintSymbolizer.draw` and
  `LabelSymbolizer.place` written in JS [87][88][89].

### Making run-time evaluation cheap (if you must keep it)

- Split expressions by what they read. RustGIS: feature-free paint once per
  layer, filters compare properties in place, 225 to 119 ms [13]. navara:
  re-evaluate only zoom-dependent layers on zoom change, after a
  per-feature re-evaluation caused a performance drop [8][184]. ortho-earth
  classifies (a) zoom-only into a uniform, (b) data-driven into a table
  row, (c) zoom x data stays baked [42]. deck.gl constant accessors upload 4
  numbers instead of an array of 4N, and Uint8 colours give "significant
  GPU memory savings" [32][33][34].
- Hoist out of the loops. MapLibre GL JS had a "severe performance
  regression" from calling `listImages()` once per layer per update; a
  2-line fix moved it out [1]. QGIS moved the simple marker's expression
  lookup to `startRender` (it took up to 10% of rendering time) [50] and
  skips work when no data-defined properties are set: 20% for 1M 4-point
  lines, 8% for 1M polygons [52][54]; not constructing the marker size per
  point gave 13% for 1M points [53]. Marble builds default GeoJSON styles once and
  copies [70]. reearth hashed a large `data:` URL per feature until it
  hashed it once per layer [25].
- Parse once. reearth caches parsed ASTs by expression text and later
  rewrote the evaluator (switch, memoised regexes) [26][27]. Mapnik caches
  `parse_expression`, stopped rebuilding grammars and removed stringstream
  locale locks from map loading; `box2d::from_string` became ~10x faster
  [138][139][140][141]. tangram-es gave JS-function results a fast path
  around YAML parsing, "quite expensive (as part of tile creation)" [106][107].
- No embedded script engine. In tangram-es JS evaluation was ~42-45% of
  tile build under callgrind; JavaScriptCore would have saved ~700 kB per
  architecture but evaluated style functions 2x slower (22.4 vs 11.2 ms),
  so Duktape stayed [101]. JS filter functions were "an order of magnitude
  slower" than declarative filters [92].
- No shared lock. mapsforge synchronised style matching on the whole
  theme; with 9 render threads the first dense z9 tiles took 14.5-16 s
  each against 0.17-0.6 s with one thread (14 s to the first tile against
  about 1 s). #1599 narrowed the synchronisation to the matching caches;
  the tester reported only that "the result looks good" [169][170].

### What the data carries for the style

- Decode only layers the style uses. QGIS skips unused MVT layers (OS
  ZoomStack carries buildings even at small scales) [44][55][56]. walkers
  decodes each source layer once instead of once per style layer (roads
  were decoded dozens of times per tile) [177][178]. MapLibre Native sends
  workers only the layers of their source [2].
- Types and schema fixed at bake. TerriaJS took column types from the
  server schema because type guessing made tiled and GeoJSON output differ
  [120]. Mapnik's index-based attribute lookup broke when a GeoJSON
  property first appeared on a later feature [143][144]. tangram parses
  stringified JSON properties only for named fields [92]. deck.gl's
  maintainer suggested keeping properties encoded until styling reads them
  [40].
- Check what attributes exist at each zoom. Protomaps tiles carry
  `is_tunnel`/`is_bridge` only from z12; reearth-papers drew tunnels and
  overview roads below water instead of filtering by a missing attribute,
  and listed five road kinds instead of "not rail" after ferries and
  runways were drawn as streets [19][20]. walkers needed a schema table
  for Protomaps vs OpenMapTiles, whose ranks count in opposite directions;
  buildings without `kind` matched 0 of 2,723 [180][181].
- Joins at bake time. TerriaJS moved choropleths from server WMS to static
  boundary tiles joined to CSV rows in the client [118][119], and sped up
  matching with prebuilt id lists, a hash index and regexes compiled once:
  a 2-3 s UI lock became 150 ms [122][123][124][125].

### Style on the GPU: restyle, highlight and filter without rebuilding

- Per-feature style texture. navara: an RGBA float texture, one column per
  feature, rows allocated on the first write of each attribute, width
  capped at 4096; a restyle writes one or two texels whatever the vertex
  count, at the cost of a texture fetch per attribute and a mandatory first
  full upload [4]. ortho-earth gint: one 16-byte row per feature id, 31 KB
  for 1,919 features, 16 MB for 1M; feature ids must align with property
  rows, a compaction of broken features shifted every id and coloured the
  neighbour [41]. Its vector-tile plan keys rows by the attribute tuple an
  expression reads, not by the evaluated colour, because two features with
  the same old colour may diverge under a new expression; over 65,535 rows
  per tile falls back to baked colour [42].
- Without per-vertex ids, feature-state means rebuilds: ortho-earth's
  vector layers mark tiles dirty and rebuild with a 120 ms throttle,
  because adding an id to the vertex format was rated high difficulty [43].
  TerriaJS highlights 3D Tiles search hits with a tag property and one
  style rule, scanning each tile once instead of every `tileVisible` [126].
- GPU filtering. deck.gl hides filtered objects by a per-object value and a
  `filterRange` uniform [35], collapsing `gl_Position` to zero so no
  fragments run [37]. OpenLayers filters map-state-independent rules on the
  CPU when building buffers and discards whole shapes in the vertex shader;
  line-metric filters still discard per fragment [81][82][83][84].
- Specialise shaders. deck.gl drops an unused per-instance attribute
  behind a `#define` [36]. Marble batches by identical style pointer and
  broke batching when custom building styles created equal but distinct
  objects [64][65][66][67]. protomaps-leaflet sets canvas state once per
  rule unless an attribute is feature-dependent [90][91].
- Translucency inside one instanced batch stays unsolved in navara:
  per-feature opacity on instances lets a translucent point hide another;
  CPU sorting is impossible per instance and dual-pass doubles GPU work
  [5][6][7].
- CPU restyling of many features: reearth chunks the pass into rAF-sized
  jobs (5,000 in flight) and abandons it when a newer style arrives [23],
  and stopped mirroring every tile feature into app state [21][22][24].

### Semantics that a translation must preserve

- Zoom: floor the zoom for rule visibility, keep the fraction for
  interpolation; MapLibre `maxzoom` is exclusive. QGIS rounded and broke
  rules at z11.8, and converted maxzoom wrongly until 2023 [44].
  `ezu translate` before 0.6.1 copied gl-js `maxzoom` into a bound ezu
  treats as inclusive, so reearth-papers painted its overview and detail
  road networks on top of each other at z12 (reearth/ezu#90) [190].
- Colour interpolation space: OpenLayers Canvas interpolated in HCL and
  WebGL in sRGB, so one style gave two gradients; 10.11 made both sRGB and
  added `interpolate-hcl` [75][76]. harp.gl moved from HSL to RGB because
  HSL conversion was inaccurate even for static colours [116].
- Value-coded rasters: OpenLayers data tiles default to no interpolation
  so expressions see raw values [75][77]; GRASS looks colours up in sorted
  float intervals by binary search, with explicit null and default colours
  [59]; MapServer classifies floats through a 65,536-bucket table and
  needed a flag to say whether thresholds are raw or scaled [147].
- Endpoints and formatting: TerriaJS pins the last legend stop to the
  exact max instead of computing it in floating point [128]; MapServer
  formats labels with `round()` and a `%g` default rather than trimming
  numbers in the reader [148].
- Scale and DPI: GeoServer vector tiles use the OGC scale formula so rule
  scale ranges match WMS [153]. MapServer RFC-55 scaled dashes and halos
  with DPI and broke maps with other size units; the fix split a size
  factor from a resolution factor [145]. walkers holds line widths in
  screen pixels while geometry scales; before, lines were 4x too thin and
  doubled between levels [179].
- Patterns: anchor the phase in world space. OpenLayers fixed fills to a
  512 px grid from map origin [75]; Mapnik computes `fmod(-x, width)` from
  the transformed origin [142]; deck.gl's fp64 low part did not stop drift,
  reducing the origin modulo the LCM of pattern sizes did [38][39]; Organic
  Maps computes hatches in the fragment shader with `fwidth` instead of 13
  mask PNGs [166]; MapLibre Native colours SDF patterns by `fill-color`
  [182].
- Draw order from style: Galileo draws a feature once per matching rule,
  in rule order [174]; GeoServer's `sortByGroup` interleaves casing and
  fill per z level [151]; Organic Maps orders landcover by log2 bbox area
  under a fixed water range [159][160][167]; tangram's `order` in (-1, 1)
  refines order inside a layer [93].
- Static analysis, not probing: GeoServer decides whether a legend
  expression is data-driven by extracting attribute references, because
  evaluating it can return a constant or throw [152].

### Visual decisions recorded with reasons

- Organic Maps distinguishes cycling categories by dash and shade in one
  hue; different widths were "surprisingly difficult to differentiate" and
  the dashed translucent route lost against dashed lines [165].
- Marble restored a thick red line and fit-to-bounds for loaded tracks;
  with a 1 px white line users thought nothing had loaded [68][69].
- harp.gl dropped thin road outlines at some zooms to stop flicker [117].
- Marble's dark mode inverts raster tiles at blend time [72][73][74].

## Tried and reverted

- protomaps-leaflet removed MapLibre JSON styles entirely [87][88];
  TerriaJS replaced its own MVT provider with a Mapbox-style converter and
  regressed (MultiPolygons dropped) [120][121].
- reearth tried caching evaluated outputs, then removed the cache in the
  same PR [26]; mirrored all MVT features into app state, then deleted it
  and lost selection until it was rebuilt [21].
- kothic-js tried a string-constant hash in generated styles and reverted
  it the same day [186].
- QGIS's point-cloud filters first had their own lexer; review replaced it
  with the general parser plus compilation to typed nodes [49]. QGIS
  disabled import of `symbol-spacing` until duplicate removal is cheaper
  [58].
- tangram-es built a runtime JS engine interface, then a compile-time
  switch [112][113]; harp.gl removed nested rules and render-order tuning
  properties in favour of expressions [114][115].
- MapServer reverted RFC-55 scaling for GD [145].
- vts-browser-js flipped its default label thinning three times and pinned
  the oldest for published styles [129][130][131].
- mapsforge VTM switched style-driven tessellation on and off for nine
  years, then hard-wired it to land/sea polygons [171][172][173].

## Guidance for a renderer in this repository

The examples already resolve style at bake time: 05 and 06 map OSM
`highway` to five classes and bake minor-before-major order [189], 02 keeps
one palette texel per country [188]. Keep that default.

1. **Write no style engine unless the request needs one.** List in
   `architecture_selection.not_doing` which style features are fixed. If a
   third-party style must be reproduced, translate only the subset you
   draw, at bake time, and commit the result or regenerate it in `bake.ts`
   [16][161][87]. Keep a readable dump next to binary rules [161].
2. **Classify at bake time.** Reduce tags or attributes to a small integer
   class per feature, with append-only ids if baked files outlive the code
   [163][165]. Drop layers and attributes no rule reads [44][168]; drop
   lookup tables that map a value to itself [61]. Freeze the attribute
   schema and types for the whole file, never from the first feature
   [143][120]. Before writing a filter, measure which attributes the source
   carries at each zoom [19].
3. **Resolve draw order with the style**: sort runs by class at bake,
   casing and fill per level when layers cross [151][189].
4. **Choose the run-time mechanism by what changes**:
   - nothing: constant colour per draw run as a uniform, or colour in the
     vertex; specialise the shader for the one style [32][36];
   - colours/visibility per feature (switch, highlight, select): feature
     id in the vertex, palette or style texture indexed by id; restyle is
     one `texSubImage2D` [4][41][188]. Key rows by input attributes if
     expressions change [42]. Design the id into the vertex format from
     the start; adding it later is expensive [43];
   - time or threshold: key attribute + uniform range, collapse
     `gl_Position` for hidden vertices [35][37];
   - zoom-only interpolation: one uniform per layer per frame [42][184].
5. **If expressions must run at run time** (user-typed), parse once,
   classify feature-free / zoom-only / per-feature, evaluate the first two
   once per layer, order filters cheapest first, dispatch on one key by
   table, use dense integer ids, clear only written slots, and take no
   shared lock [13][100][136][156][155][170]. Do not embed a JS engine
   [101]. Keep the language typed so a shader path stays possible [31].
6. **Carry semantics exactly**: floor zoom for visibility, exclusive
   maxzoom, explicit interpolation colour space, explicit nodata and
   out-of-range colours, nearest sampling for value-coded textures, pinned
   endpoints for ramps [44][75][59][77][128]. Decide per style parameter
   whether it scales with DPI, zoom or neither [145][179].
7. **Repeating fills**: compute in the fragment shader from world
   coordinates, or wrap the origin by the pattern period on the CPU
   [166][39][142].
8. **Simplify the geometry that is drawn**: apply offsets before
   simplification at bake [45].

Verification ideas for `spec.yaml`: read back the colour of one feature of
each class at a baked location; after a restyle, read it again and count
re-uploaded bytes (should be the style table, not geometry); render a
feature at its `maxzoom` and check that it is absent; if a reference style
was translated, compare screenshots against the reference renderer at
integer and fractional zooms. reearth-papers found its z12 road overlap by
comparing its renders with PLATEAU's served tiles at matched extent and
pixel size [190].

## Sources

1. https://github.com/maplibre/maplibre-gl-js/commit/9e9abb697
2. https://github.com/maplibre/maplibre-native/commit/e2f52a1dd
3. https://github.com/maplibre/maplibre-native/commit/064c60cdcab331bc19fe399492179dcb5b29121a
4. https://github.com/maplibre/navara/blob/main/guide/BATCH_TEXTURE.md
5. https://github.com/maplibre/navara/pull/656
6. https://github.com/maplibre/navara/pull/816
7. https://github.com/maplibre/navara/pull/833
8. https://github.com/maplibre/navara/pull/650
9. https://github.com/maplibre/navara/pull/702
10. https://github.com/maplibre/navara/pull/741
11. https://github.com/maplibre/navara/pull/820
12. https://github.com/maplibre/navara/pull/688
13. https://github.com/opengeos/RustGIS/pull/611
14. https://github.com/reearth/reearth-papers/commit/f23b9ce
15. https://github.com/reearth/reearth-papers/commit/0787de3
16. https://github.com/reearth/reearth-papers/commit/b82da28
17. ref-repos/reearth__reearth-papers/src/ezu.ts
18. ref-repos/reearth__reearth-papers/scripts/ezu-recipes.sh
19. https://github.com/reearth/reearth-papers/commit/3224ead
20. https://github.com/reearth/reearth-papers/commit/7c0e951
21. https://github.com/reearth/reearth-visualizer/commit/82ae2c91
22. https://github.com/reearth/reearth-web/pull/521
23. https://github.com/reearth/reearth-visualizer/commit/6448bacb
24. https://github.com/reearth/reearth-visualizer/commit/e645ec9a
25. https://github.com/reearth/reearth-visualizer/commit/73386249
26. https://github.com/reearth/reearth-web/pull/563
27. https://github.com/reearth/reearth-visualizer/commit/da6bb3a1
28. ref-repos/CesiumGS__cesium/CHANGES.md
29. https://github.com/CesiumGS/cesium/pull/13404
30. https://github.com/CesiumGS/cesium/pull/13577
31. https://github.com/CesiumGS/cesium/pull/4336
32. https://github.com/visgl/deck.gl/blob/master/docs/developer-guide/performance.md
33. https://github.com/visgl/deck.gl/blob/master/dev-docs/RFCs/v5.3/constant-accessor-rfc.md
34. ref-repos/visgl__deck.gl/docs/whats-new.md
35. https://github.com/visgl/deck.gl/blob/master/dev-docs/RFCs/v6.0/data-filter-rfc.md
36. https://github.com/visgl/deck.gl/commit/8484984b
37. https://github.com/visgl/deck.gl/commit/469590d0
38. https://github.com/visgl/deck.gl/commit/b0b9ceed
39. https://github.com/visgl/deck.gl/commit/dd24687c
40. https://github.com/visgl/deck.gl/pull/3935
41. https://github.com/kenjiyoshidahome2026-bit/ortho-earth/blob/main/packages/ortho-core/gint%20draw%20spec.md
42. https://github.com/kenjiyoshidahome2026-bit/ortho-earth/blob/main/packages/ortho-core/vt%20perf%20plan.md
43. https://github.com/kenjiyoshidahome2026-bit/ortho-earth/issues/109
44. ref-repos/qgis__QGIS/ChangeLog (2020-09-14 "[vectortiles] Optimise rendering of complex vector tiles" and "Fix calculation of zoom level for vector tiles"; 2023-04-21 "Fix conversion of max zoom level from mapbox styles")
45. https://github.com/qgis/QGIS/pull/980
46. https://github.com/qgis/QGIS/issues/34942
47. https://github.com/qgis/QGIS/pull/35557
48. https://github.com/qgis/QGIS/pull/36366
49. https://github.com/qgis/QGIS/pull/47257
50. https://github.com/qgis/QGIS/commit/7d8d1d6d06
51. https://github.com/qgis/QGIS/commit/221263db95
52. https://github.com/qgis/QGIS/commit/d8ce7dac76
53. https://github.com/qgis/QGIS/commit/fbbea90da5
54. https://github.com/qgis/QGIS/commit/3ce7be5d39
55. https://github.com/qgis/QGIS/commit/789eccb572
56. https://github.com/qgis/QGIS/commit/c35d8e5e90
57. https://github.com/qgis/QGIS/pull/34476
58. https://github.com/qgis/QGIS/commit/bd420541f1
59. ref-repos/OSGeo__grass/lib/raster/rasterlib.dox
60. ref-repos/OSGeo__grass/lib/vector/vectorlib_indices.dox
61. https://github.com/OSGeo/grass/commit/8a1cd940ebb3574e60ca5ee57371eb4368d4fa86
62. https://github.com/OSGeo/grass/pull/4555
63. ref-repos/KDE__marble/docs/dgml2.txt
64. https://github.com/KDE/marble/commit/3364bf6d3
65. https://github.com/KDE/marble/commit/bf88fdd2b
66. https://github.com/KDE/marble/commit/e5a44cbf3
67. https://github.com/KDE/marble/commit/0409e2691
68. https://github.com/KDE/marble/commit/fbb2d704c
69. https://bugs.kde.org/show_bug.cgi?id=419998
70. https://github.com/KDE/marble/commit/1eae0a397
71. https://github.com/KDE/marble/commit/5cb91148b
72. https://github.com/KDE/marble/commit/7c246797c
73. https://github.com/KDE/marble/commit/3a74bc07b
74. https://github.com/KDE/marble/commit/9dc06d92f
75. ref-repos/openlayers__openlayers/changelog/upgrade-notes.md
76. ref-repos/openlayers__openlayers/changelog/v10.11.0.md
77. ref-repos/openlayers__openlayers/changelog/v6.9.0.md
78. https://github.com/openlayers/openlayers/commit/b3dfcd603
79. https://github.com/openlayers/openlayers/commit/aa979e2c3
80. https://github.com/openlayers/openlayers/commit/9bcf01dd7
81. https://github.com/openlayers/openlayers/commit/2c337d14a
82. https://github.com/openlayers/openlayers/commit/99ae02365
83. https://github.com/openlayers/openlayers/commit/0166f2a01
84. https://github.com/openlayers/openlayers/commit/47a38be41
85. https://github.com/openlayers/openlayers/pull/14780
86. https://github.com/openlayers/ol2/issues/516
87. https://github.com/protomaps/protomaps-leaflet/issues/121
88. ref-repos/protomaps__protomaps-leaflet/CHANGELOG.md
89. ref-repos/protomaps__protomaps-leaflet/GUIDE.md
90. https://github.com/protomaps/protomaps-leaflet/issues/44
91. https://github.com/protomaps/protomaps-leaflet/commit/122cef7
92. https://github.com/tangrams/tangram/pull/715
93. https://github.com/tangrams/tangram/pull/59
94. https://github.com/tangrams/tangram/commit/bcd6754f
95. ref-repos/tangrams__tangram-es/core/src/scene/drawRule.h
96. https://github.com/tangrams/tangram-es/pull/256
97. https://github.com/tangrams/tangram-es/pull/1092
98. https://github.com/tangrams/tangram-es/pull/166
99. https://github.com/tangrams/tangram-es/pull/1788
100. https://github.com/tangrams/tangram-es/pull/484
101. https://github.com/tangrams/tangram-es/pull/1942
102. https://github.com/tangrams/tangram-es/commit/244a9b8b
103. https://github.com/tangrams/tangram-es/commit/fc880c61
104. https://github.com/tangrams/tangram-es/commit/ab50e14e
105. https://github.com/tangrams/tangram-es/commit/f5042bea
106. https://github.com/tangrams/tangram-es/commit/57e4f187
107. https://github.com/tangrams/tangram-es/commit/337cefaa
108. https://github.com/tangrams/tangram-es/commit/5b2f67ca
109. https://github.com/tangrams/tangram-es/commit/d5cdf97c
110. ref-repos/tangrams__tangram-es/core/src/js/JSCoreContext.cpp
111. https://github.com/tangrams/tangram-es/pull/1242
112. https://github.com/tangrams/tangram-es/commit/e2ebbde2
113. https://github.com/tangrams/tangram-es/commit/3f097783
114. https://github.com/heremaps/harp.gl/commit/53e73645
115. https://github.com/heremaps/harp.gl/commit/a2460b0d
116. https://github.com/heremaps/harp.gl/commit/e032b40b
117. https://github.com/heremaps/harp.gl/commit/d4f0dbc0
118. ref-repos/TerriaJS__terriajs/packages/terriajs/doc/deploying/deprecated-wms-region-mapping.md
119. ref-repos/TerriaJS__terriajs/packages/terriajs/doc/deploying/setting-up-a-region-mapping-server.md
120. https://github.com/TerriaJS/terriajs/pull/7370
121. https://github.com/TerriaJS/terriajs/pull/7144
122. https://github.com/TerriaJS/terriajs/pull/924
123. https://github.com/TerriaJS/terriajs/commit/faed327e5
124. https://github.com/TerriaJS/terriajs/commit/80042782b
125. https://github.com/TerriaJS/terriajs/commit/156a9f345
126. https://github.com/TerriaJS/terriajs/commit/b02dd2bdc
127. https://github.com/TerriaJS/terriajs/commit/38e3c13f9
128. https://github.com/TerriaJS/terriajs/commit/f0c55aaaf
129. https://github.com/melowntech/vts-browser-js/commit/f8f22dc
130. https://github.com/melowntech/vts-browser-js/commit/439a5fb
131. https://github.com/melowntech/vts-browser-js/commit/92885d2
132. ref-repos/pelicanmapping__osgearth/docs/source/3.0_upgrade_guide.md
133. https://github.com/mapnik/mapnik/blob/master/CHANGELOG.md
134. https://github.com/mapnik/mapnik/issues/834
135. https://github.com/mapnik/mapnik/commit/d744e094b451a12b070173547f638b896d1386d8
136. https://github.com/mapnik/mapnik/commit/508dd835252b5a523bffef076b6779b0c21e4588
137. https://github.com/mapnik/mapnik/pull/4573
138. https://github.com/mapnik/mapnik/commit/390706b8c
139. https://github.com/mapnik/mapnik/commit/2f134657b
140. https://github.com/mapnik/mapnik/commit/1847ce581
141. https://github.com/mapnik/mapnik/commit/ad1049750
142. https://github.com/mapnik/mapnik/commit/776fa0d2f
143. https://github.com/mapnik/mapnik/pull/4581
144. https://github.com/mapnik/mapnik/commit/ba7378126
145. https://github.com/MapServer/MapServer/issues/3157
146. https://github.com/MapServer/MapServer/issues/306
147. https://github.com/MapServer/MapServer/issues/5830
148. https://github.com/MapServer/MapServer/issues/2950
149. https://github.com/MapServer/MapServer/issues/5744
150. https://github.com/MapServer/MapServer/commit/db74212e
151. ref-repos/geoserver__geoserver/doc/en/user/styling/sld/extensions/z-order/syntax.md
152. https://github.com/geoserver/geoserver/pull/3310
153. https://github.com/geoserver/geoserver/commit/8472d773cf
154. https://github.com/tilemill-project/tilemill/issues/1809
155. https://github.com/osmandapp/OsmAnd-core/pull/1095
156. https://github.com/osmandapp/OsmAnd-core/commit/567bbfd8
157. https://github.com/osmandapp/OsmAnd-core/commit/5f668e88
158. https://github.com/osmandapp/OsmAnd-core/commit/31a2d12b
159. ref-repos/organicmaps__organicmaps/data/styles/default/include/priorities_1_BG-by-size.prio.txt
160. ref-repos/organicmaps__organicmaps/data/styles/default/include/priorities_2_BG-top.prio.txt
161. ref-repos/organicmaps__organicmaps/docs/STYLES.md
162. ref-repos/organicmaps__organicmaps/data/CLAUDE.md
163. ref-repos/organicmaps__organicmaps/data/mapcss-mapping.csv
164. ref-repos/organicmaps__organicmaps/docs/feature_structure.txt
165. https://github.com/organicmaps/organicmaps/pull/12692
166. https://github.com/organicmaps/organicmaps/commit/173be8d27d90ece935fe3b5a61ec80b1e345f933
167. https://github.com/organicmaps/organicmaps/commit/2f0356070a4d8e682892eb5916b50897d937773c
168. ref-repos/mapsforge__mapsforge/docs/Getting-Started-Map-Writer.md
169. https://github.com/mapsforge/mapsforge/issues/1598
170. https://github.com/mapsforge/mapsforge/pull/1599
171. https://github.com/mapsforge/vtm/issues/224
172. https://github.com/mapsforge/vtm/commit/892ea925802e1805d309ca33e710c56388031324
173. https://github.com/mapsforge/vtm/pull/1207
174. https://github.com/galileo-map/galileo/commit/4e0f49a
175. https://github.com/galileo-map/galileo/issues/287
176. https://github.com/galileo-map/galileo/commit/a06839f
177. https://github.com/podusowski/walkers/commit/ea5b345
178. ref-repos/podusowski__walkers/walkers/benches/decode_mvt.rs
179. https://github.com/podusowski/walkers/commit/a476eca
180. https://github.com/podusowski/walkers/commit/c495759
181. https://github.com/podusowski/walkers/commit/32508b3
182. https://github.com/maplibre/maplibre-native/pull/4551
183. https://github.com/maplibre/maplibre-native/pull/3570
184. https://github.com/maplibre/navara/commit/38fdceb9
185. https://github.com/kothic/kothic-js/commit/35c17c7
186. https://github.com/kothic/kothic-js/commit/b73b5f1
187. https://github.com/kothic/kothic-js/commit/ff9c0a5
188. examples/02-world-population-mobile/map.ts
189. examples/05-tokyo-roads-native/bake.ts
190. https://github.com/reearth/reearth-papers/commit/1f64525
