---
name: symbols-and-icons
description: How map engines turn point symbols, icons, shields, markers and fill patterns into pixels (atlases, resolution, SVG rasterising, pixel snapping, batching, depth and globe occlusion, collision with labels, sizes in metres), with what each choice cost them. Load it when a map-from-scratch request draws anything other than plain shapes at a point or along a line (POI icons, pins, route shields, oneway arrows, hatch or pattern fills, 3D models per point), or when icons come out blurry, clipped, cut by terrain, visible through a globe, or too slow to draw.
---

# Symbols and icons: rasterise once, place by anchor, draw as one batch

A symbol is a small picture tied to a point (or to positions along a line)
that must stay a fixed size on screen, stay sharp at any device pixel ratio,
appear whole or not at all, not overlap its label or its neighbours, and be
drawn thousands of times per frame. General engines must accept any icon
set at run time, so they build atlases on the fly, parse SVG, cache
rasterised images with eviction rules, and wait for sprites to load. Most
of that machinery exists because the icon set is unknown until run time. A
renderer made for one request usually knows its icons at bake time, and
the decision is mostly which of the engines' problems it can skip.

Per-engine detail with the full evidence is in
[references/engines.md](references/engines.md); this file is what you need
at the moment of choosing. Numbers in brackets refer to Sources at the end.

## What the engines decided

### Where icon pixels come from: an atlas, built once

- MapLibre GL JS builds a GlyphAtlas and an ImageAtlas per tile, holding only
  the glyphs and icons that tile uses, packed with potpack [1]. Since 3.0 it
  slices sprite images from the sheet only when they are used, to cut
  memory and `getImageData` calls [2][3]. Each tile then uploads its own
  icon and pattern textures to the GPU in `Tile#prepare` [1].
- Cesium's billboard atlas accepts new images incrementally (rectangle
  packing) and grows by a full repack. WebGL cannot read a texture back, so
  every source Image stays in JS memory; a GUID that changes on each rebuild
  tells collections to refresh texture coordinates, because counting images
  "works by accident" [22].
- QGIS moved 3D billboards to a texture atlas and added a font atlas
  generator that packs only the glyphs of a given set of strings [34][35].
  Its marker textures had been padded by 50-100 px on every side by
  hand-rolled bounds; using the standard symbol-bounds code cut that to
  2 px [36].
- Marble shares identical placemark pixmaps through one cache and draws
  identical symbols in one `drawPixmapFragments` batch, aimed at huge counts
  of the same symbol such as trees [38]. Galileo shares one GPU texture
  between identical images instead of cloning per use [116][117].
- MapServer converts a pixmap symbol into AGG's native pixel format the
  first time it is used, so each later marker is one blit [89]. Navit caches
  decoded icons so they are not read and decompressed on every draw
  [111][112]. OpenLayers caches rendered regular shapes and converts them
  to `ImageBitmap` asynchronously for "better performance and lower memory
  usage" [46][47].
- Cesium rounds point sizes to whole pixels before using them as texture
  keys; continuous sizes had produced thousands of useless canvases [23].
- Atlas size has a device ceiling. mapsforge VTM packs theme symbols into
  atlases but leaves it off by default (`TEXTURE_ATLAS = false`) after
  GL_OUT_OF_MEMORY (1285) on Mali-400 phones around zoom 15; OOMs were
  "much less even with MAX_ATLAS_SIZE = 128" [109][110].
- Caches that rasterise at run time are bounded by measured bytes:
  MapLibre Native sizes its on-demand image cache as 100 x 8192 bytes from
  ~2 kB per sprite at pixel ratio 1 and ~8 kB at 2 [14]. Mapnik 4.3.2 caches
  SVG pattern bitmaps per thread in an LRU of 64 MiB and 64 entries, keyed
  by source identity plus the 6-number transform, and keeps the source
  alive so a freed address cannot alias another SVG [81][82][79]. GeoTools
  under GeoServer rasterises a graphic fill only up to 512 px (after DPI
  scaling) and paints larger ones as vectors: 1024 px is ~4 MB, 2048 px
  ~16 MB, and a 200 px symbol at 300 DPI is already 661 px [101].
- QGIS detaches shared QPicture copies because rendering them concurrently
  crashed, and checks SVG file mtimes at most every 30 s instead of once per
  each of 100k points [32].

### Resolution and device pixel ratio

- OpenLayers rasterises regular shapes at `devicePixelRatio`, rounds canvas
  sizes up, and passes both source and destination sizes to `drawImage`.
  Without the ceil, Firefox clipped the left edge of circles. Symbols do not
  re-rasterise when browser zoom changes the ratio [44].
- Tangram declares a texture's density once (default 1) so sprites size in
  CSS pixels, and keeps one set of sprite regions for all densities, because
  per-density regions gave different collision sizes (36x38 at 1x vs 35x37
  at 2x) [54].
- protomaps-leaflet keeps icons as an HTML sheet of sized SVGs, rasterises
  it at device-native resolution into an off-screen canvas, and samples
  with `drawImage`; drop shadows and other advanced SVG features are
  discouraged because browsers render them differently [52].
- Leaflet replaced its 1x and 2x marker and layer PNGs (696 to 2464 B each)
  with SVG, then inlined the SVGs into the bundle and deleted the image-path
  detection code; the marker SVGs were later made 25% smaller [49][50][51].
- RustGIS baked point symbols into its globe drape 2-6x too large and blurred
  while moving; drawing the drape at the camera's scale with fewer pixels
  per point (up to 2M pixels) fixed it [16].

### SVG and vector symbol sources

- Mapnik rejected a librsvg + Cairo dependency for AGG (performance and
  dependency worries) and parses its own SVG subset [85]. A regression
  rendered empty shields for SVGs with `width="100%"` [84]. Arcs with a
  sweep below pi x 1e-6 are now drawn as line segments [88].
- MapServer's switch to `rsvg_handle_render_document` double-scaled every
  SVG symbol; the fix passes the size to librsvg instead of also calling
  `cairo_scale` [96].
- GRASS symbols are small text vector files scaled so the larger side of
  the box is 1; polygon rings must be clockwise outside and counter-clockwise
  inside because PostScript output fills even-odd, a restriction the README
  itself wants removed [37].
- Mapnik's Cairo backend renders pattern markers into a recording surface so
  PDF/SVG output keeps them as vectors; the AGG backend still tiles a
  rasterised image [87].

### Sharpness: snap to device pixels

- OpenLayers 2 rounds icon positions before `drawImage`, because Gecko
  blurred sub-pixel images [48]. Mapnik snaps unscaled raster markers and the
  translation of SVG markers to whole pixels, later also shields; scaled
  icons can still blur, and there is no switch to turn it off [80][86][79].
- OsmAnd snaps billboards in the vertex shader: the anchor is floored, plus
  0.5 when the symbol size is odd, and each vertex is rounded to whole
  pixels; icons then move in whole-pixel steps while panning [102].

### Batching

- Tangram attaches text to a point inside one points style; sprites and
  glyphs share one mesh with two bound samplers and a varying that selects
  one, so each style is still one draw call [55]. Tangram ES batches text and
  sprite quads into one mesh per texture with one global quad index buffer
  [59][60][61][62], later splitting text and sprite vertex shaders again
  [63].
- iTowns turns repeated 3D point models into one `InstancedMesh` per
  sub-mesh with one matrix per point; instances share material and geometry
  [74].
- Galileo replaced per-vertex screen offsets inside world geometry with
  "screen sets" anchored to a map point, drawn by their own pipeline, which
  gave markers and labels one mechanism for collision and fading at the cost
  of projecting anchors on the CPU every frame [113][114][115].
- Cesium requires vertex texture fetch and instancing (WebGL 2, or WebGL 1
  with `ANGLE_instanced_arrays`) for billboards and labels since 1.140,
  dropping the fallback path after announcing it in 1.137 [17][18][19].

### Depth and occlusion

- harp.gl stopped writing depth for text and icons, stopped clearing depth
  before them, and then disabled the depth test, because icons failed it in
  top-down globe views and labels are always on top [64][65][66].
- Cesium changed billboards and labels from LESS to LEQUAL so glyph quads at
  equal depth can overlap and the later draw wins [17][20][21]. It then moved
  billboard depth testing into the shader: far away, test against a plane at
  the ellipsoid centre; near, test three points of a ground-clamped
  billboard against the depth texture and show it whole if any is visible.
  Terrain no longer cuts billboards in half; regressions near the horizon
  had to be fixed afterwards [24][25].
- deck.gl draws icons facing the camera at the depth of their anchor; a
  slanted building cuts the top of an icon while the bottom shows, and the
  maintainers point to world-space quads for true occlusion [26].
- On deck.gl's globe, back-face culling removed every icon (quads wound
  clockwise after a y flip), and a per-anchor surface-normal test cut off
  raised anchors near the horizon and clipped foreground sprites, so it was
  closed [28][27]. The proposed fix (PR still open) rewinds the quads,
  hides far-side anchors with an exact camera-to-anchor ray-sphere test,
  and gives billboards the depth of the nearest globe surface within a
  64 px footprint; the price is a depth bias of about 1.8 km at zoom 12 and
  pitch 60 deg [27].
- globe.gl moved HTML markers into a CSS2DRenderer layer that hides them
  behind the globe inside the render loop; a user's per-marker raycast had
  to be throttled to once a second and made markers jump [71][72][73].
- deck.gl discards a culled vertex by moving it to `vec4(0,0,2,1)` (outside
  clip space), not `vec4(0)`, which could still rasterise [29].

### Placement and collision with labels

- Marble collides icon and label as one box, so icons appear only where
  there is room, uses float positions to stop flicker, and ranks by
  popularity; "room to draw the label alone is not enough" [40][41][42][43].
- Tangram makes a point and its attached text co-dependent by default, with
  `optional: true` on the text as the opt-out; per-tile collision then
  removed many more POIs, because a long label cannot cross a tile edge [56].
- Organic Maps ranks every overlay type with one hand-maintained integer;
  optional captions of icons get 10000 subtracted so the icon survives
  while its caption drops, and `?debug-rect` shows the collision boxes with
  an arrow to the displacing overlay [105][106][123]. Dense street-side
  parking got smaller, lower-priority icons instead of being removed [107].
- Tangram added spaced (for example oneway arrows every 40 px) and midpoint
  placement (for shields away from intersections) besides vertex placement;
  spacing restarts at tile cuts [53]. OsmAnd can fix arrows on the path at a
  power-of-two step in metres from the line start, changing only when zoom
  doubles, so they stop sliding [103].
- Mapnik's `marker-multi-policy` chooses one marker per part, one at the
  centroid of all parts, or one on the largest part by bbox [83].
- MapLibre GL JS PR 716 (merged 2022-03-15) added `viewport-glyph` to
  `text-rotation-alignment`: on line placement, glyphs stay aligned to the
  viewport x-axis while being placed along the line, so highway shields
  stay upright [5]. In its discussion, collision boxes ignore glyph
  rotation, so corners overlap on diagonals, a bug `text-rotate 45` already
  has [5].
- MapServer rotates a symbol with the map only when the symbol has a
  non-zero angle, so plain icons stay upright and directional ones stay
  geographic [93]. Its identify tests clicks against the drawn symbol shape
  and its anchor point instead of a square tolerance, which had given false
  hits for rectangular or bottom-anchored symbols [94][95].
- GeoServer enlarges the vector tile clip box by a buffer estimated from the
  style's symbol sizes, on top of a 12 px margin, so wide symbols are not
  clipped at tile edges [99]. go-staticmaps lets objects declare asymmetric
  pixel margins and recentres on their pixel extent so labels on one side
  are not cropped [118][119][120].
- deck.gl's GPU collision filter renders a collision map in a pre-pass and
  tests labels in the vertex shader; the map went stale until it was
  re-rendered when layers finish loading [30][31].
- Tangram ES draws flat (ground-aligned) sprites from pre-projected vertices
  because screen-space quads showed affine texture warping; `texture2DProj`
  could not be made to work [57].

### Size units

- MapLibre Navara replaced `scaleByDistance` with `sizeInMeters`: true means
  world metres, false means constant pixels [15].
- QGIS converts metres to map units for geographic CRSs with one ellipsoidal
  measure at the centre of the rendered extent; error grows away from the
  centre, which reviewers accepted [33].
- Polymaps keeps point markers screen-sized by appending an inverse scale
  after each tile update [69][70]. go-staticmaps draws a metric circle as a
  screen circle through the point due north at that distance, ignoring
  Mercator's scale change inside it [121][122].
- Tangram ES stores `%` and `auto` point sizes as value-plus-unit pairs and
  evaluates them at build time, when the sprite size is known [58].
- GeoServer stopped applying the point-symbol minimum size to legend line
  widths [100].

### Recolouring, patterns and animation

- MapLibre Native lets a fill pattern be an SDF image coloured by
  `fill-color`, one atlas entry recoloured per feature; mixing SDF and RGBA
  patterns in one layer only warns, and switching kinds forces a relayout
  [8].
- osgEarth generates SDFs on the CPU with the exact linear-time distance
  transform of Felzenszwalb, after GPU and CPU jump flooding, and later fixed
  a math error that made SDFs too wide [75][76][77][78].
- MapServer generates hatch lines analytically over the polygon's bbox
  (plus stroke width) and clips them with a boolean AND, replacing a pattern
  tile the size of the whole image [90][91][92].
- MapLibre GL JS lets a style image draw itself into its atlas slot with
  WebGL (`renderWithWebGL`), because re-uploading animated icon pixels from
  the CPU every frame lagged on low-power phones; the image must then handle
  context loss and several atlases [4].
- MapLibre Native accepts several sprite sheets addressed as `id:image` [9].

## Tried and reverted

- MapLibre Native sampled icons with nearest filtering during pure pans,
  then reverted it with no stated reason [10][11].
- MapLibre Native deduplicated sprite reload notifications (a 304 had caused
  two extra parses and every tile re-walking updated images each frame) and
  reverted it the next day without a reason [12][13].
- Cesium tried clearing globe depth with terrain depth testing on, reverted,
  and moved billboard depth testing into the shader [24].
- deck.gl closed the surface-normal globe occlusion PR; the ray-sphere test
  that replaces it is proposed in a PR that is still open [28][27].
- Kothic queued `render()` until sprite images loaded, then commented the
  sprite check out because a missing sprite could block all rendering
  [67][68].
- MapServer reverted to the deprecated librsvg call to fix double scaling,
  then replaced the revert with a size passed through the new API [96].
- MapLibre GL JS left grapheme-indexed, browser-rasterised glyphs (for
  complex scripts on labels) as a draft: wrong clusters for Bengali, Khmer
  and Telugu, a slow fix, and pixelated TinySDF output [6][7].
- OsmAnd reverted a revert so a symbol mesh and its anchor position stay
  together in the GPU resource, since clipping changes the anchor [104].

## Guidance for a renderer in this repository

The examples so far draw points as shader circles and put text in the DOM
(patterns.md). Stay there if the request allows: a circle, ring or square
computed in the fragment shader needs no atlas, no DPR handling and no
loading. Reach for image icons only when the request names icons, shields,
arrows or patterns.

When icons are needed:

1. **Bake one atlas at bake time** with only the icons the data uses
   [1][3][35]. Compute exact bounds with a 2 px pad, not a hand guess [36];
   rasterise at the target device pixel ratio and store sizes and offsets in
   logical pixels, one region set for all densities [44][54]. Normalise SVG
   at bake time: explicit pixel sizes, no `%` sizes, degenerate arcs as
   lines, ring orientation fixed [84][88][37]; then the renderer never
   parses SVG [85]. Ship the atlas inline or as one file next to the data,
   never by external URL [98]. Count it in `total_gzip_bytes`.
2. **Skip run-time atlas growth, eviction and lazy extraction** [22][14][81]:
   they pay for an unknown icon set. If icons truly arrive at run time, key
   the cache by content and transform, own the key object, and bound it by
   measured bytes per icon times count [81][14].
3. **Cap the atlas** by the weakest target GPU; several small pages beat
   one large texture on old mobile GPUs [109].
4. **Draw all icons as one instanced batch** of quads from one shared quad
   index buffer, with icon index, anchor and offset as per-instance
   attributes; put an attached label in the same batch or the same
   collision box [55][59][61]. For a repeated 3D model, instance it with
   positions baked as a flat Float32Array [74].
5. **Snap unscaled, unrotated icons to device pixels** in the vertex shader
   (floor the anchor, add 0.5 for odd sizes) [102][80]; do not snap while
   animating, scaling or rotating, and do not snap SDF glyphs that scale
   [102][86].
6. **Decide occlusion per icon, not per pixel.** Flat map: draw icons last
   with no depth test [66]. Terrain or 3D buildings: test the anchor (or a
   few points) and show or hide the icon whole [24][26]. Globe: hide by a
   ray-sphere test on the anchor, never by face culling or a ground normal
   [27][28]. Cull in the vertex shader by moving vertices outside clip
   space [29].
7. **Collide icon and label as one box with a baked priority integer** and
   a required/optional rule for captions [40][43][105]. Build a debug view
   of collision boxes early [106]. Demote dense micro-features instead of
   dropping them [107].
8. **Compute line anchors at bake time on unclipped lines**: midpoints for
   shields, distance-anchored spacing for arrows, so they neither restart at
   tile cuts nor slide when zooming [53][103]. Decide per layer whether a
   multi-part feature gets one anchor or one per part [83].
9. **Name size units** (`sizeInMeters`, px) [15]; for metric sizes compute
   metres-per-unit once per view at a reference latitude [33]. For
   hit-testing a pin, offset the hit box by its anchor [95]. If data is
   tiled, set the tile buffer to the widest baked symbol [99].
10. **Recolourable symbols and hatches**: bake one SDF tile with an exact
    distance transform and colour it in the shader [8][75]; hatch in the
    fragment shader from coordinates rather than tiling an image [90].
11. **Animate with uniforms or GPU rendering, never a CPU upload per
    frame** [4].
12. **Do not block the first frame on icons** without a timeout; better,
    ship them with the data so there is nothing to wait for [67][68].

Verification ideas for `spec.yaml`: read back a pixel at a baked anchor to
confirm an icon is drawn (take the location from the baked data, as
pitfalls.md advises), check that a far-side globe anchor draws nothing, and
measure draw calls per frame for the icon pass.

## Sources

1. ref-repos/maplibre__maplibre-gl-js/developer-guides/life-of-a-tile.md
2. https://github.com/maplibre/maplibre-gl-js/pull/1809
3. https://github.com/maplibre/maplibre-gl-js/commit/c8615fae1
4. https://github.com/maplibre/maplibre-gl-js/pull/7954
5. https://github.com/maplibre/maplibre-gl-js/pull/716
6. https://github.com/maplibre/maplibre-gl-js/pull/2458
7. https://github.com/wipfli/index-by-grapheme
8. https://github.com/maplibre/maplibre-native/pull/4551
9. https://github.com/maplibre/maplibre-native/pull/1858
10. https://github.com/maplibre/maplibre-native/commit/a70bfd891
11. https://github.com/maplibre/maplibre-native/commit/e2981c890
12. https://github.com/maplibre/maplibre-native/commit/80cb05420a86ed53815cae7fb2cb3fddf07dd1d1
13. https://github.com/maplibre/maplibre-native/commit/12d350ec3c69b8d547eeb92ad2d818ca605308f7
14. https://github.com/maplibre/maplibre-native/commit/0344ce36c483dbbcf770ac7f2615a233b22c4452
15. https://github.com/maplibre/navara/pull/487
16. https://github.com/opengeos/RustGIS/commit/f65b592
17. ref-repos/CesiumGS__cesium/CHANGES.md
18. https://github.com/CesiumGS/cesium/issues/13053
19. https://github.com/CesiumGS/cesium/pull/13253
20. https://github.com/CesiumGS/cesium/pull/4675
21. https://github.com/CesiumGS/cesium/pull/8646
22. https://github.com/CesiumGS/cesium/pull/69
23. https://github.com/CesiumGS/cesium/commit/2a1abcdc8
24. https://github.com/CesiumGS/cesium/commit/234a4a3e36d5c30eb3feb8dba4ed7a594f80c619
25. https://github.com/CesiumGS/cesium/commit/b804be9e97b73d7e0423d563b6ac5a91d678aae9
26. https://github.com/visgl/deck.gl/issues/4603
27. https://github.com/visgl/deck.gl/pull/10750
28. https://github.com/visgl/deck.gl/pull/9975
29. https://github.com/visgl/deck.gl/commit/f963897d
30. https://github.com/visgl/deck.gl/commit/3496a60d
31. https://github.com/visgl/deck.gl/commit/fb818bfa
32. ref-repos/qgis__QGIS/ChangeLog (entries of 2017-10-31 on concurrent QPicture rendering and the SVG mtime check; 2018-12-03 QgsImageCache)
33. https://github.com/qgis/QGIS/pull/4381
34. https://github.com/qgis/QGIS/commit/8399cfe3fd
35. https://github.com/qgis/QGIS/commit/3603ef070a
36. https://github.com/qgis/QGIS/commit/3914ec75b7
37. ref-repos/OSGeo__grass/lib/symbol/README
38. https://github.com/KDE/marble/commit/0d3aedbb8
39. https://github.com/KDE/marble/commit/4eb1b47c0
40. https://github.com/KDE/marble/commit/8955569d0
41. https://github.com/KDE/marble/commit/94a289443
42. https://github.com/KDE/marble/commit/e022e8418
43. https://github.com/KDE/marble/commit/16da841d9
44. https://github.com/openlayers/openlayers/pull/11277
45. https://github.com/openlayers/openlayers/commit/a4c421e69
46. https://github.com/openlayers/openlayers/commit/e0ea10a77
47. https://github.com/openlayers/openlayers/commit/6d47426c0
48. https://github.com/openlayers/ol2/commit/6ce9feed
49. https://github.com/Leaflet/Leaflet/commit/e226f77a
50. https://github.com/Leaflet/Leaflet/commit/c58640e0
51. https://github.com/Leaflet/Leaflet/commit/511dc65c
52. ref-repos/protomaps__protomaps-leaflet/SPRITES.md
53. https://github.com/tangrams/tangram/pull/409
54. https://github.com/tangrams/tangram/pull/234
55. https://github.com/tangrams/tangram/issues/290
56. https://github.com/tangrams/tangram/pull/349
57. https://github.com/tangrams/tangram-es/pull/925
58. https://github.com/tangrams/tangram-es/pull/1788
59. https://github.com/tangrams/tangram-es/commit/543a8a31
60. https://github.com/tangrams/tangram-es/commit/5b4be8e5
61. https://github.com/tangrams/tangram-es/commit/66b1786a
62. https://github.com/tangrams/tangram-es/commit/c4e6ba3e
63. https://github.com/tangrams/tangram-es/commit/b185bf1e
64. https://github.com/heremaps/harp.gl/commit/7c7de6fd
65. https://github.com/heremaps/harp.gl/commit/165e6c7d
66. https://github.com/heremaps/harp.gl/commit/9e253967
67. https://github.com/kothic/kothic-js/commit/6eccbbb
68. https://github.com/kothic/kothic-js/commit/7ff00aa
69. https://github.com/simplegeo/polymaps/commit/b31f277
70. ref-repos/simplegeo__polymaps/src/GeoJson.js
71. https://github.com/vasturiano/globe.gl/issues/91
72. https://github.com/vasturiano/globe.gl/commit/88ed48d
73. https://github.com/vasturiano/globe.gl/commit/5e3071b
74. https://github.com/iTowns/itowns/commit/619a611
75. https://github.com/pelicanmapping/osgearth/commit/872f41d45
76. https://github.com/pelicanmapping/osgearth/commit/069e61f8a
77. https://github.com/pelicanmapping/osgearth/commit/9e621cbfd
78. https://github.com/pelicanmapping/osgearth/commit/b83990e65
79. https://github.com/mapnik/mapnik/blob/master/CHANGELOG.md
80. https://github.com/mapnik/mapnik/issues/1316
81. https://github.com/mapnik/mapnik/commit/fcf101d0bdce986bd362915ed9d3f29ef2388d43
82. https://github.com/mapnik/mapnik/pull/4582
83. https://github.com/mapnik/mapnik/issues/1555
84. https://github.com/mapnik/mapnik/issues/3812
85. https://github.com/mapnik/mapnik/issues/320
86. https://github.com/mapnik/mapnik/issues/1866
87. https://github.com/mapnik/mapnik/commit/2344fe3ac
88. https://github.com/mapnik/mapnik/commit/4e26d2a7d
89. ref-repos/MapServer__MapServer/HISTORY.md
90. https://github.com/MapServer/MapServer/commit/962fff7a
91. https://github.com/MapServer/MapServer/commit/2ab44080
92. https://github.com/MapServer/MapServer/commit/4ceca4cc
93. https://github.com/MapServer/MapServer/commit/91d53be6
94. https://github.com/MapServer/MapServer/commit/b8f298d7
95. https://github.com/MapServer/MapServer/commit/834b621d
96. https://github.com/MapServer/MapServer/commit/3abd4dc9
97. https://github.com/geoserver/geoserver/pull/3310
98. https://github.com/geoserver/geoserver/pull/551
99. https://github.com/geoserver/geoserver/commit/43c8a183f1
100. https://github.com/geoserver/geoserver/commit/8a295e03a9
101. https://github.com/geoserver/geoserver/commit/ee6236460b
102. https://github.com/osmandapp/OsmAnd-core/commit/a4fbac07
103. https://github.com/osmandapp/OsmAnd-core/commit/69f9df37
104. https://github.com/osmandapp/OsmAnd-core/commit/d28f524f
105. ref-repos/organicmaps__organicmaps/data/styles/default/include/priorities_4_overlays.prio.txt
106. ref-repos/organicmaps__organicmaps/docs/DEBUG_COMMANDS.md
107. https://github.com/organicmaps/organicmaps/pull/3896
108. https://github.com/organicmaps/organicmaps/pull/12699
109. https://github.com/mapsforge/vtm/issues/404
110. ref-repos/mapsforge__vtm/vtm/src/org/oscim/utils/Parameters.java
111. https://github.com/navit-gps/navit/commit/e24b2d5f
112. https://github.com/navit-gps/navit/commit/ac0809d0
113. https://github.com/galileo-map/galileo/commit/6eb7499
114. https://github.com/galileo-map/galileo/commit/42ba40c
115. https://github.com/galileo-map/galileo/commit/6a2088f
116. https://github.com/galileo-map/galileo/commit/d426524
117. https://github.com/galileo-map/galileo/commit/452f5ba
118. https://github.com/flopp/go-staticmaps/issues/50
119. https://github.com/flopp/go-staticmaps/issues/51
120. https://github.com/flopp/go-staticmaps/commit/7fadbc4
121. ref-repos/flopp__go-staticmaps/circle.go
122. https://github.com/flopp/go-staticmaps/commit/8fe0236
123. https://github.com/organicmaps/organicmaps/blob/master/data/styles/default/include/priorities_4_overlays.prio.txt
