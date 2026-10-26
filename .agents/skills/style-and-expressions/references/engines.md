# Style and expressions: per-engine detail

Numbers in brackets refer to the Sources list in [../SKILL.md](../SKILL.md).
Read this when a decision in SKILL.md needs the history or the numbers behind
it, or when the request resembles one engine's situation closely.

## MapLibre GL JS

- With the image expression, `imageManager.listImages()` ended up inside the
  per-layer recalculation loop and caused a "severe performance regression";
  PR #9261 moved it out with a 2-line diff in `style.js` [1]. A benchmark
  suite is what catches such per-layer calls to O(n) helpers.

## MapLibre Native

- Workers receive only the style layers relevant to their source ("Avoid
  cloning and including irrelevant layers") [2].
- `RenderOrchestrator` keeps a vector of ordered render layers instead of
  calling `getRenderLayer()`, which hashes the layer id, on each pass. The
  `API_renderStill_multiple_sources` benchmark ran about 70% faster; the
  cached vector must be kept in sync with style changes [3].
- SDF fill patterns are coloured by `fill-color` (constant or data-driven);
  SDF state is tracked per layer, mixing SDF and RGBA patterns in one layer
  warns, and switching an image between the two triggers a relayout [182].
- Style-level source options such as raster-dem `encoding` now override the
  TileJSON, matching GL JS; before PR #3570 a terrarium encoding set in the
  style was ignored when the source `url` pointed at a TileJSON [183].

## navara (MapLibre)

- Batch texture: per-feature style values in an RGBA float texture, one
  column per feature, a row block per attribute, width capped at 4096 with
  planar wrap (10,000 features give 3 physical rows per attribute block).
  Rows are allocated on the first write of an attribute and are append-only;
  dirty spans flush once per frame. Costs: a texture fetch per attribute in
  the vertex shader, per-material defines that need a custom program cache
  key, and a mandatory full first upload because `texStorage2D` is
  zero-filled while defaults are not zero [4].
- Data-driven width, size and opacity went into the batch texture, later for
  points, billboards and text, then per-instance rotation and facing. The
  config grows per feature type with every new parameter. Translucent
  instances in one InstancedMesh occlude each other wrongly: CPU sorting is
  impossible because `renderOrder` is per mesh, and dual-pass (depth, then
  colour) doubles GPU work, so it was deferred. Gradient-alpha edge
  antialiasing looks wrong with `transparent=false` [5][6][7].
- MapLibre style support in milestones: fill plus expressions, filter,
  conditionals, then line, circle and symbol [8][9][10][11]. A pure-Rust
  evaluator was imported as `RustStyleEngine` next to the JS one, so two
  engines must stay consistent [10][11]. Legacy functions are converted with
  the style-spec migrate tool; `glyphs` URLs are not supported, fonts come
  from a `fontFamily` built from Google Fonts CSS unicode ranges [12].
- On zoom change only layers with zoom-dependent expressions are
  re-evaluated; re-evaluating each feature in each zoom-dependent layer had
  caused a performance drop in the style plugin [8][184].

## RustGIS

- Paint that reads nothing of the feature (`Expr::feature_free`) is computed
  once per layer, and `==`/`in` filters compare properties in place without
  copying. A z12 Manhattan view went from 225 to 119 ms on one thread with
  identical meshes [13].

## reearth-papers

- In the server-rendered (tile mode) style only, the POI variable anchor is
  pinned to `left` and its text made optional. maplibre-native Tile mode
  refuses variable-anchor labels whose box touches a tile border, which made
  a label-width band along every edge of every 512 px tile a no-place zone
  [14][15].
- MapLibre styles are pre-translated by a script into ezu recipes and
  committed, because the WASM build ships only the renderer. The label-free
  house styles have no glyph or sprite sources, so their renders fetch no
  assets [16][17][18]. `ezu translate` before 0.6.1 copied gl-js `maxzoom`
  into a bound ezu treats as inclusive (ezu#90), so overview and detail
  roads overlapped at z12; found by comparing renders with PLATEAU's served
  tiles, and the re-bake on ezu 0.6.1 moved z12 toward gl-js [190].
- Protomaps emits `is_tunnel`/`is_bridge` only from z12 (measured over Tokyo
  Bay). Subsurface roads and the z4-11 overview layers are drawn below water
  instead of being filtered; a long bridge span vanishes at z9 as a result.
  Road filters list five kinds explicitly because "not rail" drew ferries
  and runways as streets. Verified by running every road feature of five
  real tiles through the compiled filters and sweeping z6-z15 over the
  Aqua-Line [19][20].

## reearth-visualizer

- MVT: the first version built a Feature per polygon keyed by an md5 of its
  geometry, cached Feature and ComputedFeature maps, and pushed them to the
  app after each tile. #521 deleted that (+29/-94 lines in `hooks.ts`): the style
  callback evaluates a throwaway feature, and staleness is a timestamp
  compare. Feature selection was lost until re-implemented in 2023 [21][22].
- 3D Tiles: restyle is split into rAF-sized async jobs with at most 5,000
  features in flight, abandoned when a newer style change arrives (#499).
  #568 stopped syncing features to the app store and tags the raw feature
  with its computed style (+44/-91 lines); a global feature index had to be
  added back later [23][24].
- Component keys hashed a string that included `data.url`; with a large
  `data:` URL this ran per feature until #587 hashed the URL once [25].
- Expressions (jsep, Cesium-like) are parsed once and cached globally by
  text, cleared per layer at unmount via `requestIdleCallback`. #563 then
  used `switch` instead of if-chains, lighter string operations, memoised
  regexes and `typeof` checks; a cache of evaluated outputs was tried and
  removed in the same PR [26][27].

## CesiumGS/cesium

- `MVTDataProvider` loads MVT as 3D Tiles, with properties encoded through
  `EXT_structural_metadata` and styled by `Cesium3DTileStyle`, later draped
  on terrain with screen-space-constant width; the cost is encoding
  properties into the engine's metadata at load [28][29][30].
- Point-cloud styles are transpiled to GLSL. The shader path restricts
  operand types (numbers for comparison and arithmetic, booleans for `!`),
  so some spec-valid styles produce broken shaders; every style change
  recompiles. Stated principle: the language must be implementable both by
  an interpreter and by a GLSL transpiler [31].

## deck.gl

- Constant accessors (`getFillColor: [255,0,0,128]`) upload 4 numbers, use
  no GPU memory and update without `updateTriggers`; `*Scale` props are
  uniform multipliers; Uint8 colours give "significant GPU memory savings"
  [32][33][34].
- DataFilterExtension: one filter-value attribute per object plus a
  `filterRange` uniform ("1 generic vertex attribute + 1 uniform"); filtered
  vertices are still processed by the vertex shader [35]. It sets
  `gl_Position = vec4(0.)` for filtered vertices so no fragments run [37].
  Rejected alternatives: passing a filtered array (recomputes all
  attributes), or radius 0 / transparent colour (layer-specific; transparent
  polygons still pick) [35].
- PathStyleExtension registers `instanceDashOffsets` only with
  `highPrecisionDash`; otherwise `#ifndef HIGH_PRECISION_DASH` sets the
  offset to 0 and saves an attribute slot, at the cost of a shader variant
  [36].
- Fill pattern origin: an fp64 low part (2022) did not stop drift at high
  zoom; reducing the origin modulo the LCM of all frame sizes times scale did
  (72 lines of tests). It needs integer frame sizes and a scalar scale, else
  it falls back [38][39].
- MVT properties: the maintainer suggested keeping them protobuf-encoded and
  decoding on demand on the main thread, "very cheap"; contributors kept
  per-feature property objects for accessor convenience [40].

## ortho-earth

- gint layers: `setPaint`, `setFilter` and feature-state evaluate all
  features once on the main thread into a fid-indexed style texture;
  geometry, edge metadata and tiers are untouched. 16 bytes per fid: 31 KB
  for 1,919 features, 16 MB for 1M. census2020 toggles went from merge plus
  WASM re-bake to zero re-bakes; a 57,341-parcel choropleth is driven by
  `match`/`case`/`in`. Zoom x data expressions re-evaluate only on settle
  (zoom moved by 0.25 or more and stopped). A GeoJSON path that compacted
  broken features shifted every fid and coloured the neighbour [41].
- Vector-tile plan: colours, opacity and width were baked per vertex at tile
  zoom, so a theme switch rebuilt every tile (3.6 ms x 40-80 visible tiles).
  Expressions are classified (a) zoom-only into one uniform per layer per
  frame, (b) data-driven into a row index of an RGBA32F texture (storage
  buffer on WebGPU) keyed by the input attribute tuple, (c) zoom x data
  stays baked. feature-state adds the id to the key with ref-counted rows.
  Over 65,535 rows per tile falls back to baked colour [42].
- Feature-state on fill/line/circle/symbol vector layers rebuilds dirty
  tiles with a 120 ms throttle; a draw-time colour table would need a
  per-vertex id through core build, `mergeTiles` and both GL2 and WGSL
  shaders, rated high difficulty. Splitting features by state in the worker
  was rejected because it breaks sort-key order [43].

## QGIS

- Vector tiles: layers no renderer or labeling rule needs are not decoded
  (OS ZoomStack carries buildings at small scales); the decoder reserves
  arrays from command counts [44][55][56]. Rule zoom uses floor, with a
  separate fractional `@vector_tile_zoom` for interpolation; rounding broke
  12-22 rules at z11.8. Mapbox `maxzoom` is converted by subtracting 1,
  because QGIS hides at > maxzoom and the spec at >= maxzoom [44].
- Simplification runs at fetch time, before symbol line offsets, so offset
  lines come out wrong. Accepted as an edge case: detecting it needs the
  symbol before the fetch (each feature read twice) [45].
- Selective masking walked every symbol of every layer when the layer
  dialog opened: 64 layers x 235 categories took 37-83 s against under 2 s
  in 3.10. Deferring it to opening the mask panel brought the dialog back to
  about 1 s; threading was rejected because the renderer can change while
  the visitor runs [46][47][48].
- Point-cloud filters: a separate lexer first, because `QgsExpression`
  through `QVariant` was "simply too slow" for millions of points. Review
  replaced it with `QgsExpression` parsing plus conversion to typed nodes
  evaluated on point blocks; unsupported nodes are parse errors, with no
  slow fallback [49].
- Render-loop micro-optimisations: simple-marker expression lookup moved
  to `startRender` (up to 10%), array reserve in clipping (~6%), skipping
  work without data-defined properties (20% for 1M 4-point lines, 8% for
  1M polygons), marker size not rebuilt per point (13% for 1M points)
  [50][51][52][53][54].
- Legend labels with aggregate expressions ran three times per layout; an
  aggressive cache invalidated on refresh, atlas change, export and linked
  map extent or rotation won. The extent trigger was missed at first [57].
- The Mapbox GL converter skips `symbol-spacing` until distance-based label
  de-duplication is cheaper [58].

## GRASS GIS

- Colour tables are float interval rules; `fp_lookup` sorts end points and
  binary-searches. Explicit null (`nv`) and default (`*`) colours were added,
  the special zero colour removed, and per-category colours discouraged
  because "Overuse can create large color tables" [59].
- A per-layer category index makes selections like `cats=27591` skip the
  full scan; it goes stale under level-2 editing and forced a topology
  rebuild of every existing vector when introduced [60].
- `v.to.rast` stopped writing labels like "1: 1": `Rast_set_cat()` was
  "terribly slow for many categories" and the labels were redundant [61].
- `r.colors.out` JSON emits colours in a format both CSS and GRASS parse,
  with alternatives behind flags and explicit default and null colours; the
  PR took over 100 comments [62].

## KDE Marble

- DGML describes a map as layers importing existing formats (KML, GPX,
  GeoRSS, tile dirs) plus a legend whose `connect` attribute binds
  checkboxes to layers [63].
- The painter is reconfigured only when the style changes, and equal styles
  must be the same pointer so draws batch; custom building styles broke this
  until e5a44cbf3 [64][65][66][67].
- GPX tracks went back to a thick red line with fit-to-bounds; with a 1 px
  white line users concluded the track had not loaded [68][69].
- The GeoJSON parser builds default styles once and copies them, and maps
  Simplestyle properties; `marker-size` and `marker-symbol` are unimplemented
  [70][71].
- Dark mode: `InvertColorBlending` and `InvertHueBlending` on one texture
  layer, later also for vector tiles; the result is an inversion, not a
  designed night palette [72][73][74].

## OpenLayers

- 10.11: `interpolate` mixes colours in sRGB on both Canvas and WebGL
  (Canvas had used HCL) and `interpolate-hcl` keeps the old gradient on
  Canvas only [75][76].
- 5.0: pattern and gradient origin on 512 CSS-pixel steps from map
  coordinate [0,0], so fills align across tile-clipped polygons; seamless
  patterns must be power-of-two up to 512 [75].
- 6.10: DataTile sources default to `interpolate: false` so WebGL
  expressions see raw values; 6.9 added `normalize: false` for GeoTIFF floats
  [75][77].
- WebGL vector: all flat-style rules compiled to shaders over one attribute
  buffer with one pass per rule (PR #16942, lower memory); attributes are
  padded to fit the shared layout [78][79][80]. Filters that do not depend on
  map state run on the CPU at buffer build; GPU filters discard whole shapes
  in the vertex shader, except line-metric filters that discard per fragment
  [81][82][83][84].
- 8.0 introduced flat expression styles and replaced the WebGLPointsLayer
  symbol format; 10.0 dropped type hints in `get`. Breaking changes followed
  in 8.0, 10.0, 10.3 and 10.4 [75][85].
- ol2 KML: features referenced `#id` while StyleMap entries were stored as
  `#id_n`/`#id_h`, so icons were missing; style files were cached by URL
  including the fragment and refetched [86].

## protomaps-leaflet

- `json_style` was removed: under 20% of the MapLibre spec, and styles with
  dozens of road layers blocked the UI while zooming. Styles are now Rules
  plus Symbolizers [87][88].
- `PaintSymbolizer.draw(ctx, geom, z, feature)` and `LabelSymbolizer.place()`
  (boxes plus a draw closure run only if placement succeeds) "encompass all
  of the functionality"; styles are code, not portable data [89].
- Line and Polygon symbolizers set canvas state once per rule and batch
  paths unless an attribute is feature-dependent [90][91].

## Tangram (JS)

- `parse_json` takes `true` or a list of property names (preferred); dot
  paths and `includes`/`intersects` filters avoid JS filter functions, which
  are "an order of magnitude slower in Tangram ES" [92].
- `order` in (-1, 1) refines painter order inside a parent layer instead of
  hard-coding `sort_key`; it cannot interleave across layers and fails for
  tilted extruded scenes [93].
- `value in list` filters compile to one `indexOf` over an array literal
  [94].

## tangram-es

- Draw-rule names are interned to integer ids; `DrawRule` points into the
  original rule data [95].
- Font parameters use CSS names; Android maps family, weight and style to
  system files by parsing `fonts.xml`, with a bundled fallback [96][97].
- Sublayer match results are cached by a 64-bit set of matched layers,
  which caps a scene at 64 layers [98].
- Unit-bearing point sizes (`%`, `auto`) are stored as value plus unit and
  evaluated at build time because sprite sizes are only known there [99].
- Filters sorted at scene load: globals (`$zoom`, `$geometry`) before
  properties, JS last, highest zoom range first. Eraser-map at z14 on an
  iPhone 5S: filtering -36%, tile build -23%; tangram JS got ~15% from
  zoom-first [100].
- JavaScriptCore was ~700 kB smaller per architecture but evaluated style
  functions 2x slower (22.4 vs 11.2 ms; tile build 54.0 vs 41.3 ms); JS
  evaluation was ~42-45% of tile build under callgrind, so Duktape stayed
  [101]. A runtime-polymorphic context interface was built and then
  replaced by a compile-time switch [112][113]. With JSCore, defining only
  `getProperty` was empirically slightly faster [110].
- Rule merging zeroes only the bitset of active keys ("zeroing out is the
  most expensive part in merging"); tag ids are sorted once per tile
  [102][103][104][105].
- JS function results take a fast path around YAML parsing, "quite
  expensive (as part of tile creation)" [106][107].
- Float label priority for Tilezen collision ranks; layers gained
  `exclusive` and `priority` [108][109].
- Markers can be styled by a path to a scene draw group, exclusive with
  inline YAML [111].

## harp.gl

- Removed nested rules and render-order offset/scale/bias properties in
  favour of expressions such as `['+', ['get','sort_rank'], 123]`; colour
  interpolation moved from HSL to RGB because HSL conversion was inaccurate
  even for static colours [114][115][116].
- Tertiary and residential outlines were dropped at some zooms in the Berlin
  theme to stop flicker (HARP-8057) [117].

## TerriaJS

- Region-mapped choropleths moved from GeoServer WMS with an FID style to
  static boundary vector tiles joined to CSV rows in the client; any static
  host works, and 404 means an empty tile [118][119].
- The in-house MVT provider was replaced by protomaps-leaflet plus a
  Mapbox-style converter (`MapboxJsonStyleToProtomaps.ts`); GeoJSON
  MultiPolygons were dropped as a regression [121][120]. Column types now
  come from `esriFieldType`, because guessing made tiled and GeoJSON
  symbology differ [120].
- Region matching: regex replacements once per code, RegExp compiled once,
  fewer trim/lowercase copies; SEIFA 2011 had locked the browser 2-3 s, after
  the fix `updateRegionMapping` takes 150 ms for ABS SA2. Numeric ids stay
  strings because of leading zeros [122]. Precomputed id lists and an
  `_idIndex` hash replaced server queries and linear scans [123][124][125].
- 3D Tiles search highlight: each tile's features scanned once (a Set of
  watched tiles), matches tagged, one style condition colours them; removal
  drops the rule without stored colours [126]. A React re-render had been
  reloading the whole tileset while scrolling results [127].
- The last legend stop takes `maxValue` directly instead of
  `min + (max-min)*6/6` [128].

## vts-browser-js

- Label thinning was reimplemented as `scr-count1` to `scr-count8`; the
  default went 4, 5, then back to 1 "because of legacy" published configs.
  The engine carries all eight paths and parameter sets [129][130][131].

## osgEarth

- 3.0 made each data source, stylesheet and viewpoint an explicit Layer
  type; feature data and styles can be separate layers referenced by name,
  so one source feeds several visible layers. It was a breaking migration
  [132].

## Mapnik

- 2.1: features share a Context holding the attribute schema, so features
  hold only values [133][134]. 4.3.1 hashed attribute lookups and stored
  PostGIS attributes by index [135]; 4.3.2 had to refresh rule attribute
  indices when a GeoJSON property first appears on a later feature
  (`late-property.geojson`) [143][144].
- 3.0 made all symbolizer properties expressions (except face and fontset
  names); 2.0 added `filter-mode="first"`. 4.3.1 evaluates filters as
  booleans, indexes rules by an `[attr] = 'string'` condition (also inside
  AND) and compares string literals directly [133][136][137].
- Loading: stringstream removed to avoid a locale lock, grammars no longer
  rebuilt, `parse_expression` cached, `box2d::from_string` ~10x faster
  [138][139][140][141].
- Global pattern alignment transforms map origin (0,0) to screen and offsets
  by `fmod(-x, pattern_width)`, shared by AGG and Cairo; local alignment
  anchors at the feature's first vertex [142].

## MapServer

- RFC-55 scaled offsets, dashes, halos and collision buffers with output
  resolution and broke 5.6 betas for maps with non-pixel `SIZEUNITS`. The
  fix split `scalefactor` from `resolutionfactor`, for AGG only; GD went
  back to 5.4 behaviour [145].
- 256-colour GD output: rasters and antialiased text used up the palette
  and later label colours were remapped at random; 4.4 pre-allocates style
  and label colours of active layers. A 22-class raster regressed in
  4.4.0b2 [146].
- Float rasters are classified through a bucket table (`SCALE_BUCKETS`,
  default 65,536) trying the last matched class first; `SCALE` only clipped
  until `CLASSIFY_SCALED=TRUE` (7.6) made `[pixel]` the scaled value [147].
- Contour labels showed `2000.000000`; RFC 64 made TEXT an expression with
  `round()` and a `%g` default instead of trimming in the DBF reader, at the
  cost of breaking old TEXT logical expressions [148].
- RFC 118 drew filtered layers through the query-map path, which silently
  ignored GEOMTRANSFORM, outline width, CLASSGROUP and MASK/OPACITY; the
  maintainer concluded query rendering should reuse the regular pipeline
  [149].
- `LABEL PRIORITY` accepts expressions and attribute bindings [150].

## GeoServer

- `sortBy` orders feature extraction; casing drawn by two FeatureTypeStyles
  needs `sortByGroup` to interleave per z level, else all casings precede all
  fills [151].
- JSON legends decide whether an expression is data-driven by extracting
  attribute references (FilterAttributeExtractor) and encode it with
  `ECQL.toCQL`; evaluating against a dummy feature can return a constant or
  throw [152].
- Vector tiles use `calculateOGCScale` so rule scale ranges match WMS
  (0.28 mm pixel convention) [153].

## TileMill

- Feature-attribute colours were deferred for years: "not an easy thing to
  implement in a way that does not degrade performance" [154].

## OsmAnd

- `clear()` walks only result slots that were written: 45 Greater London
  z12 tiles, reading 612 to 372 ms, primitivising 1,883 to 1,324 ms, total
  2,700 to 1,901 ms; on a Galaxy A54 the two symbols fell from 2.32% to
  0.12% of app CPU. The .obf reader also evaluates the style to decide what
  to keep [155].
- Input values moved from `QHash` to an array indexed by value-definition
  id with constant intermediates precomputed. An earlier change described itself as making
  "map styles even slower than they are" [156][158].

## Organic Maps

- Four priority ranges: landcover by bbox size, water (BG-top) always above
  landcover because size ordering fails for water over forest, foreground
  lines and areas (tunnels even at layer=-10), overlays [159][160].
  Background depth is `999 - (log2(bboxArea) - log2(FLT_MIN))*100`, about
  -13000 to -8000 [167].
- MapCSS dialect compiled by a customised Kothic into `drules_*.bin` per
  style family with `.txt` dumps; the quick Designer rebuild tool is
  documented as broken [161][162].
- Tags map to a closed, numbered classificator; 1-8 types per feature in 3
  header bits; new types reuse deprecated lines to keep ids stable;
  unmapped tags are lost [162][163][164].
- Cycleway rendering: only the subset using existing types and formats was
  merged, so a temporary representation is not shipped as a legacy format.
  Per-side attributes were aggregated onto the centerline, picking the most
  protected category. Visually: one accent hue with solid/dashed/dotted;
  different widths were "surprisingly difficult to differentiate"; the
  planned route became solid and opaque with a darker outline [165].
- Hatching and stipple fills are computed in the fragment shader with
  `fwidth()` on a world-anchored lattice, replacing 13 mask PNGs; lines stay
  crisp at fractional zoom, at one program per pattern [166].

## mapsforge and VTM

- Only tags in `tag-mapping.xml` are written, ids assigned by frequency
  (writer 0.2.2), up to 15 per feature; a theme rule without zoom-min falls
  back to the mapping's zoom-appear [168].
- `RenderTheme.matchWay/matchNode` were synchronised on the whole theme.
  Germany at z9 with the Elevate theme (tiles with 70,000-80,000 ways): with
  9 threads the first tiles took ~14.5-16 s each against 0.17-0.6 s with 1,
  and the first tile appeared after 14 s against about 1 s. #1599 narrowed
  the synchronisation; the tester said only that "the result looks good".
  The maintainer could not reproduce on light maps [169][170].
- VTM tessellation: sea in 2016, all water in 2018, water back to stencil in
  2019 ("Performance and stability are more important"), overlaps fixed in
  the data, and in 2025 the theme option removed and tessellation hard-wired
  to artificial land/sea polygons [171][172][173].

## Galileo

- Style rules draw in sequence; a feature matching several rules is drawn
  once per rule, which gives controllable z-order (casings under roads) at
  the cost of duplicated geometry [174].
- `StyleValue<T>{Simple, Interpolate, Steps}` became a MapLibre-compatible
  expression engine parsed with chumsky; unknown functions are errors;
  a06839f was +441/-1857 [175][176].

## walkers

- Each used MVT source layer is decoded once, then style layers filter;
  roads had been decoded dozens of times per tile. A criterion benchmark on
  a 139 KB Wroclaw tile with an empty-style floor came first [177][178].
- Line widths are held in screen pixels while geometry scales with
  fractional zoom; before, lines were 4x too thin and doubled between
  levels [179].
- A Schema table covers Protomaps and OpenMapTiles: settlements sized by
  OpenMapTiles `class` because ranks count in opposite directions (Wroclaw
  had been 12 px against 21.6 px villages at z14); buildings without `kind`
  matched 0 of 2,723 [180][181].

## kothic-js

- MapCSS is converted offline into a JS `restyle(tags, zoom, type,
  selector)` function, and caching moved into the generated style [185]. A
  string-constant hash in generated code was reverted the same day, no
  reason given [186]. Features are scanned once into per-layer arrays with
  stable order instead of rescanning per kind [187].
