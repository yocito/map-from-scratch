---
name: label-placement
description: How map engines decide which labels and icons to show and where (candidate anchors, collision index, priority, cross-tile identity, hysteresis and fades, line and polygon labels), with what they measured and what they reverted. Load it when a map-from-scratch request needs names drawn on the map itself (place, road, river or POI labels, icons with text) rather than a caption in the DOM, before writing `architecture_selection` or any bake or renderer code for labels, or when labels overlap, flicker, vanish at tile edges or cost too much frame time.
---

# Label placement: what to show, where, and when to decide it

A map with labels must pick, out of many candidate names and icons, a set
that does not overlap, with the important ones winning, and keep that choice
stable while the camera moves. General engines do this at run time, every
placement pass, against every candidate in view, across tile seams and
sources; most of their label code exists because the label set, the zoom and
the camera are not known in advance. A renderer made for one request often
knows all three, and can move nearly all of the work to bake time. This skill
lists what the engines decided, and what each decision cost, so that the
choice is made on purpose. Nothing in this repo draws labels on the map yet;
for a name on tap or hover only, DOM text is already the pattern
(skills/map-from-scratch/references/patterns.md, "Text in the DOM").

Per-engine detail and smaller decisions: [references/engines.md](references/engines.md).
Numbers in brackets refer to the Sources list at the end of this file.

## First question: when is placement decided?

| The request | Decide placement | Engines that show the cost of the other way |
| --- | --- | --- |
| Fixed label set, a few discrete zoom levels, no rotation or pitch | At bake time, per zoom: ship the list of labels that won, with their boxes | QGIS 30 s for 3,000 points at run time [34]; candidate counts [35][39] |
| Continuous zoom or pan, labels from one baked file | Bake candidates and priorities; at run time a greedy pass in screen space, throttled | navara [23], tangram-es [80] |
| Rotation, pitch, or labels from several tiles or sources | Run time, one global screen-space index, plus hysteresis, margin and fades | MapLibre [1][17], tangram [71][79] |
| Static image or per-tile raster output | Once, unthrottled, full placement; neighbours' data needed at tile edges | MapLibre Native still mode [22], reearth-papers [28][29] |

Every engine that started with per-tile placement and a moving camera moved to
one global screen-space pass: MapLibre GL JS dropped per-tile collision in
workers after a series of perspective hacks, including re-placing at most once
per 300 ms [1][2]; Native followed [17]; tangram JS added a main-thread pass
over the visible tiles [71] because per-tile collision forced labels inside
their tile (`move_into_tile`) and duplicated country names in buffered tiles
[66], and labels from different sources never collided [79]. The global pass
costs main-thread CPU at every placement and needs a way to carry fade state
between tiles of different zooms [1][17]. If the renderer draws one baked
data set on one canvas, neither the per-tile problem nor the cross-tile
machinery arises [28][15].

## Decisions, with trade-offs and evidence

### Collision index: a uniform screen grid, not a tree

- MapLibre GL JS replaced its R-tree with an n x n grid: insertions under
  0.1x the time, queries up to 1.3x slower, placement 2/3 of the time
  overall, because placement inserts far more than it queries; it relies on
  labels of similar size [3]. Its cells are 25 px over the viewport plus
  100 px padding on each side [4].
- navara: 64 px cells, a 128 px margin ring, 2 px padding per box, greedy
  in priority order, for "a few hundred labels" per pass; the kernel takes a
  flat `Float64Array` (stride 11) and returns hidden flags [23].
- tangram builds its grid only when the busiest tile has more labels than
  its size in pixels; typical basemaps get no grid at all [75]. tangram-es
  had to cap grid splits because a deeply overzoomed tile allocated huge
  grids [85].
- OpenLayers uses an R-tree (rbush) [50]; QGIS an R-tree with a cost-based
  solver, where caching pairwise conflict results gave "a big speed bump" [44]
  (only worth it for an iterative solver, not a greedy one).
- Cheap tests first: tangram runs the oriented-box test only when a box is
  rotated [69]; a tiny epsilon (or strict inequality) lets exactly touching
  boxes, such as text right under its icon, both show [70][23].

### Priority and order

- Greedy, one by one, against the winners so far, after one sort: tangram-es
  called it a "major speedup" over collecting all colliding pairs and then
  resolving them [80]. The sort order is the only priority mechanism, so make
  it explicit and deterministic.
- Ties must not fall back to array or arrival order. QGIS added a tiny cost
  to break exact ties because placement flipped between runs [40]; navara
  breaks remaining ties by anchor position, since tile loading reshuffles
  arrays [23]; tangram's load-order placement made initial layouts
  nondeterministic, a problem for its visual tests [74]; protomaps-leaflet
  states its layout "depends on which tile was loaded first" [58].
- Collide an icon and its text as one unit, or decide which can survive
  alone: Marble put the icon inside the collision box because icons drawn
  regardless crowded the map [48]; OpenLayers ties icon and label of one
  feature together [95]; tangram made text required by default and saw many
  more POIs culled under per-tile collision [77]; reearth-papers made POI text
  optional so the icon survives [29].
- Do not add collision geometry for things that cannot win or block: QGIS cut
  point-layer render time by about 60% by not registering obstacles from
  layers without labels [38]; tangram keeps `collide: false` labels off the
  main-thread pass entirely [97].

### Candidates: few, scaled to screen size

- The candidate count is the main cost and quality knob. QGIS capped point
  candidates for very large layers: 3,000 points went from 30 s to 3 s, with
  placement "quasi-random anyway" at that density [34]; it scales line and
  polygon candidates per cm and per cm² of rendered size [35] and spaces the
  polygon candidate grid by density, not label size [36]; it raised the
  defaults to 16/50/30 for "much nicer" placement, reverted the same day
  because reference images broke, and reapplied [39].
- tangram reduced default point anchors from 8 to 4: in dense London the
  diagonals gave 11% more labels for 23% slower tile builds (43% more
  collision tests) [68].

### Stability while the camera moves

- Hysteresis: tangram-es grows the box of a label that was hidden last frame
  by 2 px, and after priority and tile zoom sorts labels shown last frame
  ahead of hidden ones, which makes placement depend on navigation history
  [81]; navara lets an incumbent test with its box shrunk 6 px per side
  while it still registers its full box, and wins ties [23]. Without this,
  near-tied labels swap on sub-pixel drift [23][25].
- Place against more than the viewport, so changes happen off screen:
  MapLibre Native pads 100 px, 200 px when pitched, 1,024 px for static
  tiles, larger being more stable but more expensive [19]; navara 128 px
  [23]; OpenLayers took the render buffer into account to cut flicker [52].
  Items outside the grid must be rejected, not treated as placed, or they
  cascade into the viewport [21].
- Default hidden: navara first showed every candidate until a collision was
  found, which swept a wave of labels in and out on each pan; it now shows a
  label only after it claims space [23].
- Throttle placement, not fades: navara places at most every 150 ms and only
  when camera or label set changed, while 300 ms fades step every frame [23];
  tangram re-collides only at 1/3-zoom steps, tuned through 0.25, 0.5 and back
  to 0.33 by eye [62][73]; MapLibre places in a ~2 ms slice per frame but
  forces a full placement when fades are off, because incomplete labels
  otherwise showed in still output [6].

### Lines and polygons

- Polygon anchors come from the whole geometry at bake time, never from
  tile-clipped pieces: protomaps-leaflet removed its polygon label symbolizer
  as "not accurate for tiled rendering" [61]; tangram computes centroids once
  per GeoJSON source [63]; RustGIS uses the pole of inaccessibility [27];
  QGIS takes perimeter labels from the boundary before clipping [37].
  OpenLayers drops a polygon label that does not fit inside the polygon [54].
- Line labels collide as chains of cells or circles, not one box:
  protomaps-leaflet cells of twice the text height, minimum labelable segment
  20 px [59]; MapLibre circles projected at placement time [18].
- Repetition: protomaps-leaflet repeats every 250 px and deduplicates equal
  text at that distance, doubling per overzoom level past 4 [59]; tangram's
  default is once per 256 px tile, keyed by style class [78].
- Nested anchors: navara bakes along-line anchors at levels spaced
  finest x 2^l, so zooming out only drops anchors and labels do not swim [24].
- Merge lines split across tiles (by OSM id) before labelling: Marble got
  better street names and fewer items [49].
- Near-vertical lines need a flip tolerance or labels on one boundary point
  both ways [67].

### Pitch and 3D

- Test clip-space w before the divide; labels behind the camera otherwise
  appear mirrored [8][84].
- MapLibre draws a label twice as far away at 75% size, not 50%, and hides
  line labels beyond camera distance 1.5 [13]; glyphs of line-placed labels
  are positioned along the whole line on the CPU, at any pitch, while point
  labels stay in the shaders [12].
- deck.gl collides on the GPU by rendering picking colours into one
  off-screen target: 7,000 points at 120 fps with rotation and pitch, at the
  cost of an extra pass and pixel-level rather than box-level occlusion [32].

### Picking and GPU upload

- Hit-test labels against the placement result: MapLibre removed flicker and
  missed symbols at tile seams this way [7]; OpenLayers reuses the last
  frame's declutter tree for hit detection [55].
- Upload only changed visibility: MapLibre skips rewriting opacity buffers
  for buckets whose dedup result did not change, 260 to 38 buckets per frame
  and p90 39.2 to 35.3 ms under 4x throttle [5]; tangram-es packs label state
  into int16 and updates only alpha for hidden labels [82].

## Tried and reverted

- Per-tile collision in workers with perspective hacks and 300 ms throttling,
  replaced by the global index (MapLibre GL JS [1][2]).
- Named collision groups in the style, removed a month later for one
  `crossSourceCollisions` boolean (MapLibre [10][11]).
- Several collision boxes per line-aligned icon, rolled back to one [1][18].
- Lifting all decluttered labels above every layer (OpenLayers 6), reversed
  in 9.0 to keep layer order [51].
- Collision in Mercator metres, reverted the next day because the code
  depended on tile-local coordinates (tangram [72]).
- Showing labels until proven colliding, reversed to hidden by default
  (navara [23]).
- makeValid for label geometry, reverted to buffer(0) as much slower
  (QGIS [45]).

## Guidance for a renderer in this repo

Write in `architecture_selection.not_doing` which of these the request does
not need: labels on the map at all, rotation, pitch, continuous zoom, line
labels, several sources. Each one removed deletes a section above.

When the request allows it, bake placement:

1. In `bake.ts`, generate few candidates per feature (one anchor for a point
   or 4 sides [68]; a polygon anchor from the unclipped geometry [61][27];
   line anchors at nested spacings [24] after merging split ways [49]).
2. Give each a priority from the data (population, road class), with a
   deterministic tiebreak such as feature id [40][23].
3. For each zoom level the renderer shows, run the greedy grid placement in
   that zoom's pixel space [3][80], and ship the winners per zoom with their
   screen boxes. Assign each label to exactly one tile if the data is tiled
   [9][66]. The renderer then draws a list and does no collision.
4. If zoom is continuous but rotation and pitch are not, ship candidates
   sorted by priority with their unscaled box sizes, and run the greedy grid
   at run time only when the zoom crosses a step [62], with hysteresis and a
   margin [23][81]. A few hundred labels need nothing more [23][75].

Run-time global placement with cross-tile identity, fades and
`CrossTileSymbolIndex`-style matching [15][1] is warranted only for rotating
or pitched views over tiled data from several sources. Glyph rendering
(SDF, atlas, shaping) is a separate decision; note that SDF padding must be
subtracted from the quad before collision [30].

Budgets and checks to add to `spec.yaml`:

- `placement_ms` per pass (or bake-time only, then say so), and the count of
  labels shown at fixed views, so a change that drops labels is visible.
- A check that no two shown boxes overlap, read from the renderer's own
  placement output.
- A stability check: move the camera by sub-pixel steps along a path and
  count labels whose visibility changed; it should be zero [23][81].
- Pixel tests on labels depend on the font rasteriser: OpenLayers keeps tight
  tolerances only on one Linux CI image [95], and QGIS's candidate change
  broke its reference images [39]. Prefer checks on placement data over
  screenshots.

## Sources

1. https://github.com/maplibre/maplibre-gl-js/commit/135561825
2. https://github.com/maplibre/maplibre-gl-js/commit/aefb3ee1f
3. https://github.com/maplibre/maplibre-gl-js/commit/b62895ab8
4. ref-repos/maplibre__maplibre-gl-js/src/symbol/collision_index.ts
5. https://github.com/maplibre/maplibre-gl-js/pull/8434
6. https://github.com/maplibre/maplibre-gl-js/commit/5401d2f05
7. https://github.com/maplibre/maplibre-gl-js/commit/fc992ec59
8. https://github.com/maplibre/maplibre-gl-js/commit/1eed2ae82
9. https://github.com/maplibre/maplibre-gl-js/commit/a49fea4eb
10. https://github.com/maplibre/maplibre-gl-js/commit/efd1359c3
11. https://github.com/maplibre/maplibre-gl-js/commit/003d3ce2a
12. https://github.com/maplibre/maplibre-gl-js/commit/2313006d8, https://github.com/maplibre/maplibre-gl-js/commit/79b3de167
13. https://github.com/maplibre/maplibre-gl-js/commit/886379839, https://github.com/maplibre/maplibre-gl-js/commit/b5128044a
14. https://github.com/maplibre/maplibre-gl-js/commit/e1e68a80c
15. https://github.com/maplibre/maplibre-gl-js/commit/788cd64d8, https://github.com/maplibre/maplibre-gl-js/commit/e06d0c70d, https://github.com/maplibre/maplibre-gl-js/commit/3a5b25bf9
16. https://github.com/maplibre/maplibre-native/issues/3223
17. https://github.com/maplibre/maplibre-native/commit/c0cb210dd, https://github.com/maplibre/maplibre-native/commit/18d735ccc, https://github.com/maplibre/maplibre-native/commit/31f0f4719, https://github.com/maplibre/maplibre-native/commit/ff58848cf
18. https://github.com/maplibre/maplibre-native/commit/4c6f0e813
19. https://github.com/maplibre/maplibre-native/commit/0bf8fdae9c4055ded52a641ed87f400067f89055
20. https://github.com/maplibre/maplibre-native/commit/cdee5b824903c6f69df90231d75521c7e130175b
21. https://github.com/maplibre/maplibre-native/commit/4f0e5374c
22. https://github.com/maplibre/maplibre-native/commit/77b24bc0d, https://github.com/maplibre/maplibre-native/commit/72f6b7359, https://github.com/maplibre/maplibre-native/commit/975d6b169, https://github.com/maplibre/maplibre-native/commit/f3fc9b2b9
23. https://github.com/maplibre/navara/blob/main/guide/DECLUTTER.md (local: ref-repos/maplibre__navara/guide/DECLUTTER.md)
24. https://github.com/maplibre/navara/blob/main/guide/LINE_PLACEMENT.md (local: ref-repos/maplibre__navara/guide/LINE_PLACEMENT.md)
25. https://github.com/maplibre/navara/pull/717
26. https://github.com/maplibre/navara/commit/6f7c2502, https://github.com/maplibre/navara/commit/a4ecf60d, https://github.com/maplibre/navara/commit/551e368d
27. https://github.com/opengeos/RustGIS/commit/ff32d01
28. https://github.com/reearth/reearth-papers/commit/b82da28, ref-repos/reearth__reearth-papers/src/ezu.ts
29. https://github.com/reearth/reearth-papers/commit/f23b9ce, https://github.com/reearth/reearth-papers/commit/0787de3
30. https://github.com/CesiumGS/cesium/commit/fe52af325
31. https://github.com/CesiumGS/cesium/commit/83eb415e2ae339f1e09bc7de5f32f8dfbde4773a, https://github.com/CesiumGS/cesium/commit/3f678cae6b08093573f2c794d52d0892a73f3279, https://github.com/CesiumGS/cesium/commit/f99c570378220ba87be48ebb3049ec0e80ac8975
32. https://github.com/visgl/deck.gl/issues/7374, https://github.com/visgl/deck.gl/pull/7375
33. ref-repos/kenjiyoshidahome2026-bit__ortho-earth/packages/ortho-core/text gpu plan.md (https://github.com/kenjiyoshidahome2026-bit/ortho-earth/blob/main/packages/ortho-core/text%20gpu%20plan.md)
34. https://github.com/qgis/QGIS/commit/61bfced6a7, ref-repos/qgis__QGIS/ChangeLog (2019-09-25 "[labeling] limit candidates for extreme feature counts")
35. ref-repos/qgis__QGIS/ChangeLog (2019-12-21 "rework max line/polygon candidates settings")
36. ref-repos/qgis__QGIS/ChangeLog (2019-12-18 "[pal] Improve polygon candidate generation logic")
37. ref-repos/qgis__QGIS/ChangeLog (2016-07-28 "Improve polygon perimeter labeling")
38. https://github.com/qgis/QGIS/commit/5798a82c80
39. https://github.com/qgis/QGIS/commit/cd22d4fbc3, https://github.com/qgis/QGIS/commit/ee09131df8, https://github.com/qgis/QGIS/commit/ed69bf26b2, https://github.com/qgis/QGIS/commit/7797e80c66
40. https://github.com/qgis/QGIS/commit/09b8309632
41. https://github.com/qgis/QGIS/commit/5b6151086d, https://github.com/qgis/QGIS/commit/72474ab4a0
42. https://github.com/qgis/QGIS/commit/03f9e1b351, https://github.com/qgis/QGIS/commit/3e618916eb
43. https://github.com/qgis/QGIS/commit/3a44e294de, https://github.com/qgis/QGIS/commit/9cc10e2a21
44. https://github.com/qgis/QGIS/commit/86334fc44b
45. https://github.com/qgis/QGIS/commit/ff5a8bc0ae, https://github.com/qgis/QGIS/issues/20260
46. https://github.com/qgis/QGIS/issues/32489, ref-repos/qgis__QGIS/ChangeLog (2019-11-29 "[pal] more exit points")
47. https://github.com/OSGeo/grass/commit/d757e423d
48. https://github.com/KDE/marble/commit/8955569d0, https://github.com/KDE/marble/commit/94a289443, https://github.com/KDE/marble/commit/e022e8418, https://github.com/KDE/marble/commit/16da841d9
49. https://github.com/KDE/marble/commit/3e8d79cd9, https://github.com/KDE/marble/commit/8ab1bc70a, https://github.com/KDE/marble/commit/da14816df
50. https://github.com/openlayers/openlayers/pull/7328, https://github.com/openlayers/openlayers/commit/08af20772, https://github.com/openlayers/openlayers/commit/80e67bac7
51. ref-repos/openlayers__openlayers/changelog/upgrade-notes.md, ref-repos/openlayers__openlayers/changelog/v9.0.0.md, https://github.com/openlayers/openlayers/pull/15466, https://github.com/openlayers/openlayers/commit/7a5e0db59, https://github.com/openlayers/openlayers/commit/8e862766f
52. https://github.com/openlayers/openlayers/commit/0f9de1544, https://github.com/openlayers/openlayers/commit/ff980077e
53. https://github.com/openlayers/openlayers/commit/bd3f35eef, https://github.com/openlayers/openlayers/commit/aa55cce3b
54. ref-repos/openlayers__openlayers/changelog/v4.4.0.md
55. https://github.com/openlayers/openlayers/commit/ac195c46b, https://github.com/openlayers/openlayers/pull/15028, ref-repos/openlayers__openlayers/changelog/v7.5.2.md
56. https://github.com/openlayers/openlayers/commit/a2d41da30
57. https://github.com/Leaflet/Leaflet/pull/7603
58. ref-repos/protomaps__protomaps-leaflet/GUIDE.md, ref-repos/protomaps__protomaps-leaflet/src/labeler.ts
59. ref-repos/protomaps__protomaps-leaflet/src/symbolizer.ts, ref-repos/protomaps__protomaps-leaflet/src/line.ts, https://github.com/protomaps/protomaps-leaflet/commit/ddf63f0
60. https://github.com/protomaps/protomaps-leaflet/commit/50f9330
61. ref-repos/protomaps__protomaps-leaflet/CHANGELOG.md
62. ref-repos/tangrams__tangram/src/tile/tile_manager.js (https://github.com/tangrams/tangram/blob/master/src/tile/tile_manager.js)
63. ref-repos/tangrams__tangram/src/sources/geojson.js, https://github.com/tangrams/tangram/blob/master/src/utils/geo.js
64. https://github.com/tangrams/tangram/pull/484, https://github.com/tangrams/tangram/pull/360
65. https://github.com/tangrams/tangram/pull/555
66. https://github.com/tangrams/tangram/issues/602
67. https://github.com/tangrams/tangram/issues/517
68. https://github.com/tangrams/tangram/commit/13fa0b83
69. https://github.com/tangrams/tangram/commit/078d25a6, https://github.com/tangrams/tangram/commit/83f61ca5
70. https://github.com/tangrams/tangram/commit/13189aec
71. https://github.com/tangrams/tangram/commit/d4d4606c, https://github.com/tangrams/tangram/commit/8ff7ca80, https://github.com/tangrams/tangram/commit/3f50d8c9
72. https://github.com/tangrams/tangram/commit/b041b687, https://github.com/tangrams/tangram/commit/f918af75
73. https://github.com/tangrams/tangram/commit/f46c9c2f, https://github.com/tangrams/tangram/commit/551eaf56, https://github.com/tangrams/tangram/commit/86dc22da, https://github.com/tangrams/tangram/commit/53e89367
74. https://github.com/tangrams/tangram/commit/b02b7a4f, https://github.com/tangrams/tangram/commit/81090821
75. https://github.com/tangrams/tangram/commit/0a37f38b
76. https://github.com/tangrams/tangram/commit/628f9ee9, https://github.com/tangrams/tangram/commit/6d40cd9b
77. https://github.com/tangrams/tangram/pull/349
78. https://github.com/tangrams/tangram/pull/222
79. https://github.com/tangrams/tangram/issues/365
80. https://github.com/tangrams/tangram-es/commit/3ea60b4f, https://github.com/tangrams/tangram-es/commit/c39ea457
81. https://github.com/tangrams/tangram-es/commit/1ecd9f69, https://github.com/tangrams/tangram-es/commit/99ed08b6, https://github.com/tangrams/tangram-es/blob/ebe6e4df79/core/src/labels/labelManager.cpp#L264-L268
82. https://github.com/tangrams/tangram-es/commit/32157dd0, https://github.com/tangrams/tangram-es/commit/951a9c9e
83. https://github.com/tangrams/tangram-es/commit/8ce5dd0c, https://github.com/tangrams/tangram-es/commit/cd2b5842, https://github.com/tangrams/tangram-es/commit/6306803b
84. https://github.com/tangrams/tangram-es/commit/a6e27a8b
85. https://github.com/tangrams/tangram-es/commit/ea032da9
86. https://github.com/tangrams/tangram-es/pull/1076
87. https://github.com/tangrams/tangram-es/pull/925
88. https://github.com/visgl/deck.gl/pull/3935
89. https://github.com/maplibre/maplibre-native/commit/a9d04d7b1ad1ac070f45a3367bec24e9cd4ef074
90. https://github.com/maplibre/maplibre-native/commit/7d9b54a573a196d9120226c17d8dc30384f207b8, https://github.com/maplibre/maplibre-native/commit/f29865f31ddd9e6293053e810a65c6c093b7d597
91. https://github.com/maplibre/maplibre-native/commit/c25fbe9a94c30be75674772480aab86227521737, https://github.com/maplibre/maplibre-native/commit/8165b7dee1119c09daeda4a82b7c0eb51ad06915
92. https://github.com/maplibre/maplibre-rs/issues/36, https://github.com/maplibre/maplibre-rs/pull/314
93. https://github.com/maplibre/maplibre-rs/commit/0d70a47, https://github.com/maplibre/maplibre-rs/commit/1ea2b5c
94. https://github.com/tangrams/tangram/commit/4ed08411, https://github.com/tangrams/tangram/commit/eb6ec3a1
95. https://github.com/openlayers/openlayers/pull/11592, https://github.com/openlayers/openlayers/pull/14761, https://github.com/openlayers/openlayers/pull/14971
96. https://github.com/KDE/marble/commit/09ecae215
97. https://github.com/tangrams/tangram/commit/1cfaa527, https://github.com/tangrams/tangram/commit/25f0e3ad, https://github.com/tangrams/tangram/commit/ec5257e6
98. https://github.com/qgis/QGIS/commit/b736bf9a44
99. https://github.com/qgis/QGIS/commit/d4cf534e4c
100. https://github.com/tangrams/tangram/commit/c7126096, https://github.com/tangrams/tangram/commit/4953412a, https://github.com/tangrams/tangram/commit/8bc21d5b
101. https://github.com/maplibre/maplibre-native/commit/e582a329ef0150616b0d0e1d7c8f44bd31d92f26, https://github.com/maplibre/maplibre-native/commit/c9924ae9d5d6e499267eea3bb9b1092bfd18ddf4
102. https://github.com/maplibre/maplibre-native/commit/a96fe6ad87d386f25a57a2a7a6632382951733f0
103. https://github.com/maplibre/maplibre-gl-js/commit/170c3499d
104. https://github.com/maplibre/maplibre-gl-js/commit/aef24c139, https://github.com/maplibre/maplibre-gl-js/commit/8a7bbd2df, https://github.com/maplibre/maplibre-gl-js/commit/d8f467ddb
105. ref-repos/maplibre__maplibre-gl-js/CHANGELOG.md (5.12.0, #6521; 6.0.0, #7537), https://github.com/maplibre/maplibre-gl-js/pull/6521
106. https://github.com/qgis/QGIS/commit/81b546c21c
107. https://github.com/qgis/QGIS/commit/f9fa9793f0, https://github.com/qgis/QGIS/commit/b384f18a3d
108. ref-repos/qgis__QGIS/ChangeLog (2017-02-01 "[FEATURE] Cache labeling result")
109. https://github.com/qgis/QGIS/pull/30747
110. https://github.com/tangrams/tangram/pull/409
111. https://github.com/tangrams/tangram/commit/6b4faf6e, https://github.com/tangrams/tangram/commit/7027e157, https://github.com/tangrams/tangram/commit/5ecf6030
112. https://github.com/tangrams/tangram-es/commit/615e5714, https://github.com/tangrams/tangram-es/commit/3e5a40fb
113. https://github.com/protomaps/protomaps-leaflet/commit/5f50575, https://github.com/protomaps/protomaps-leaflet/commit/c10f51a
