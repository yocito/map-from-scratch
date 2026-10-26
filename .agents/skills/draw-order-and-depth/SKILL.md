---
name: draw-order-and-depth
description: How 42 map engines decide what is drawn on top (painter's order, depth buffer as layer order, stencil per tile, offscreen layer compositing, labels-last passes, near/far planes) and what they reverted. Load it before writing the draw-order rule of bake.ts or the pass list of a renderer, when a request has translucent layers, casings, overlapping tiles, labels over geometry, pitch or 3D, and whenever a screenshot shows the wrong thing on top, darker overlaps, double-blended tile seams, z-fighting, flicker between equal layers, or geometry clipped near the camera.
---

# Draw order and depth: decide the order once, at bake time

Every map is layered: land under water under roads under labels, casings
under road fills, small areas over large ones. A general engine cannot know
the layers in advance, so it re-sorts at run time, encodes layer order into
the depth buffer, masks tiles with the stencil buffer and composites layers
through offscreen buffers, and each of those has a cost and its own bugs.
Engines also hit the same three traps again and again: translucent geometry
that overlaps itself darkens [7][54], buffered tiles blend twice along their
seams [26][68], and anything that shares a depth value with something else
flickers or vanishes depending on driver precision [29][87][105]. A renderer
made for one request knows its layers when it bakes, so its draw order can
be the order of the bytes in the file and of the draw calls in `draw()`
[1][2][3]. What it still needs from the engines is the list of situations
where order alone is not enough, and the cheapest fix each one found.

Per-engine detail, with all numbers: [references/engines.md](references/engines.md).
Depth precision (near plane, log and reversed depth) is covered in more
depth by `../float-precision/SKILL.md`; fallback (proxy) tiles by
`../tile-lod-and-overzoom/SKILL.md`; label collision priority by
`../label-placement/SKILL.md`; extruded buildings by
`../3d-buildings-and-meshes/SKILL.md` [5].

## Where this repo stands

- The rule is "decide draw order at bake time": minor roads first, major on
  top, no sorting at run time (05, 06) [1][2].
- 07 orders cities big first, so a small city is never hidden under a big
  one, and Morton-sorts inside one radius class where the order does not
  show; hover hit-tests from the top of the draw order down, so the city
  found is the one the user sees [3]. It fills land by stencil INVERT and
  dissolved countries into land first [3].
- 02 draws fills, then borders with alpha blending, with no depth or
  stencil buffer [4].
- No example uses a depth buffer yet.

## Decision 1: painter's order or a depth buffer?

| The request has | Use |
| --- | --- |
| a flat 2D map, any number of layers, fixed order | painter's order: draw calls in baked order, no depth buffer |
| many overlapping opaque fill layers and an expensive fragment shader | optionally depth for early-Z (MapLibre's opaque pass) |
| pitch with 3D buildings, terrain or models | a depth buffer for the 3D part only, 2D layers still in order |
| a globe that zooms to street level | depth plus a precision plan (float-precision skill) |

- MapLibre renders in four passes: offscreen, opaque fills top to bottom,
  translucent bottom to top, debug; each layer gets its own depth value, so
  opaque overdraw is rejected early [10]. The price was that the depth
  buffer was taken: the globe could not use it for back-side rejection and
  needed a clip plane written to `gl_Position.z`, plus face culling and
  fragment discard, because some phone drivers apply `glDepthRange` and
  clipping in the wrong order [6].
- Tangram also encodes layer order as depth: `TANGRAM_LAYER_DELTA =
  1/(1<<14)`, assuming a 16-bit depth buffer, with one bit for half layers
  for outlines (inserted between layers) and one to prevent precision loss;
  order is doubled so half layers do not truncate [67]. This lets it batch by material in any order, but caps
  the order range and shares depth precision with extrusions [67].
- maplibre-rs writes each layer's z-index straight into NDC z, so the
  camera's znear/zfar no longer decide layer order; the znear/zfar values
  (1024/2048) were "selected experimentally" [20].
- Organic Maps assigns depth from style priority and from bounding-box
  size: background areas get `999 - (log2(bboxArea) - log2(FLT_MIN))*100`,
  so larger areas sit under smaller ones [108].
- osgEarth sorts terrain front to back for early-Z, "a huge impact on
  performance if the renderer is fragment/fill bound", with no numbers
  given [100].

For this repo: painter's order unless the request is 3D. A depth buffer
used only to express layer order costs memory and adds the equal-depth and
translucency traps below, for an order the bake already knows.

## Decision 2: what order, decided where

Order rules that engines converged on, all of which can be applied in
`bake.ts`:

- Fixed ranges, then size. Organic Maps draws four ranges: landcover sorted
  by bounding-box size (smaller above larger), then water ("ordering by
  size doesn't always work with e.g. water mapped over a forest"), then
  foreground lines and areas (tunnels stay visible over landcover and
  water), then overlays [106].
- Order can stand in for missing attributes. reearth-papers drew undersea
  tunnels and overview roads below the water fill because Protomaps tiles
  carry `is_tunnel`/`is_bridge` only from z12; the cost was a long bridge
  vanishing at z9 [27].
- Casings by z-level, not all casings first. GeoServer's `sortBy` per
  style drew every casing before every road fill; `sortByGroup` interleaves
  them by z-order [103]. galileo, which had no way to set the draw order of
  vector-tile features, now draws style rules in sequence and a feature
  once per matching rule [113].
- Keep source order unless there is a reason. MLT's spec allows encoders to
  reorder features; the Rust encoder went back to keeping source order:
  sorting saved 0.1 to 0.4% of size [22].
- Sort only what depends on the view. Marble's z-sort took about 10% of
  run time although almost nothing changed order; it now sorts only at the
  level where buildings sort by height [48]. ol2 made its z-index ordering
  opt-in and stored only the sort key [61].
- Quantise sort keys. MapLibre rounds the symbols' viewport-y sort key so
  ties fall back to data order and JS and Native agree [9].
- Sort once, upstream. MapLibre Native removed sorting from its tile-mask
  and clip-id generators because the tile pyramid already delivers sorted
  tiles: 33 times faster [16].
- Batch only neighbours in draw order. walkers merges polygons into one
  mesh only when they are consecutive, so a line between two polygons stays
  between them: 1,480 meshes became 2 in a dense tile [114]. kothic-js
  appends features to the open path while the next has the same style (30%
  faster geometry), and adds a colour sort inside each z-index to lengthen
  runs, which a later contributor could not explain [80][81].
- Draw each shared edge once. GRASS removed boundaries from the default
  draw types because area outlines already draw them [46].
- Wrapped worlds need a rule too: osmdroid draws one copy of a shape, the
  one nearest the screen centre, so a city point stays inside its country
  [112].

## Decision 3: equal depth and coplanar layers

- Use LEQUAL when draw order decides ties. Cesium moved billboards and
  labels (1.28), then glTF (1.67), from LESS to LEQUAL so later geometry
  wins, which "makes it easier to render e.g. outlined buildings" [29];
  OpenLayers did the same so several vector-tile layers can share a depth
  [57].
- Translucent draws must not write depth if anything is drawn after them.
  Organic Maps' pattern fills were depth-culled by earlier translucent
  geometry (path dashes showed land colour, a translucent bridge blended
  with land); the fix was to draw opaque pattern fills first, pinned by a
  test [107]. Tangram rejected a depth-write-plus-alpha blend mode because
  it regroups draws by tile and program [68]; tangram-es turns off depth
  writes for add and multiply blending [74].
- Overlays on a depth-tested surface z-fight. globe.gl raised the default
  label altitude from 0 to 0.002 globe radii after flicker reports [87].
  OsmAnd lowered the lift of on-terrain vectors from 1.0 to 0.5 and
  reverted "due to z-fighting on Samsung devices" [105].
- Fill antialiasing outlines double-blend with neighbours unless clipped:
  MapLibre Native draws them with depth LEQUAL against the fill [14].

## Decision 4: translucent layers that overlap themselves

The problem: per-fragment alpha makes a 50% route darker wherever it
crosses itself, and a translucent layer made of several features or styles
stacks its opacity [7][54].

| Fix | Who | Cost |
| --- | --- | --- |
| draw the layer opaque offscreen, composite once with the layer alpha | OpenLayers (Canvas, translucent layers only) [54]; MapLibre lines with constant opacity [7] | one extra target and composite per translucent layer; MapLibre: 3x, later 1.95x slower with 50 lines layers at 0.5 [7] |
| stencil "each pixel once" (EQUAL 0, INCR) after a depth pre-pass | tangram-es [73] | two passes, a stencil clear per style, 8-bit stencil required [73] |
| commutative blends (add, multiply) | Tangram [70]; tangram-es [74] | not real alpha compositing [70] |
| per-style buffer, composite only the dirty rectangle | Mapnik [102] | full-canvas clear and composite per style until dirty tracking [102] |
| order-independent transparency (WBOIT) | proposed for maplibre-rs, still open [17] | none shipped; maplibre-rs removed transparency instead [17] |

- History: Mapbox GL JS had the offscreen pass and removed it for
  performance; MapLibre brought it back in v6 for constant opacities only,
  leaving zoom and data expressions unfixed because they would need MRT
  [7]. Users who used overlap darkening as a density effect lose it [7]. A
  stencil-bit mask was tried and dropped: the first-drawn feature won on
  overlaps and SDF edges showed artefacts [7]. The standard benches never
  hit the path, since their opacities interpolate to 0 or 1 [7].
- A fill version (`fill-comp-op`, per-layer opacity via one screen-size
  framebuffer) stayed open from 2022 and was closed unmerged in 2026, partly
  because a screen-size buffer does not fit 3D or terrain [11].

For this repo, in order of preference: bake the colour opaque (the
background under it is known); dissolve overlapping features of the layer
at bake time, as 07 did for land [3]; then the stencil "once per pixel"
pass for a single translucent layer; then one offscreen composite per
translucent layer, measured, as MapLibre's 1.95x shows it is not free [7].

## Decision 5: tiles that overlap their neighbours

Tiles with buffers draw the buffer twice. Opaque fills hide it; translucent
fills, casings and antialiased edges do not.

- RustGIS's GPU path failed its parity test with 48k outlier pixels until
  each tile's mesh was stencil-clipped to its square; after that, mean
  difference from the CPU reference was 1.5/255 [26].
- Tangram draws tiles unclipped, so lines need no buffer and join
  seamlessly, and left translucent buffered polygons doubling at seams as a
  known limitation (#469) [68]. harp.gl made line clipping opt-in, and gave
  fallback roads only a 1e-6 render-order offset, accepting slightly wider
  duplicated roads over visible cap outlines [75].
- MapLibre Native generates stencil clip ids only for layers that need
  clipping; symbols overdraw except in still images [15].
- deck.gl's maintainer rejected merging features split across tiles (turf
  union) in favour of clipping each tile on the GPU [35]; polymaps used one
  shared SVG clipPath per tile [84].
- maplibre-rs first used a 4-value x%2, y%2 checkerboard of stencil values,
  then dropped it for one value per drawn tile, which also covers
  parent/child fallbacks; the doc does not say why [19].
- navara, draping vectors on terrain, lets each source claim its square in
  the stencil finest first, so neighbours' buffers and ancestor fallbacks
  draw once [23]. MapLibre's globe draws raster tiles twice: borderless
  while marking stencil, then bordered only into the unmarked gaps, so no
  pixel is blended twice [6].
- Fallback tiles: OpenLayers draws only the uncovered rectangles of a
  lower-zoom tile instead of clip paths [56]; tangram-es closed a stencil
  scheme because it gave the same result as polygon offset [72]; VTM writes
  depth for drawn tiles only in frames that need proxies [111]. Details are
  in the tile-lod skill [5].

For this repo: when the bake makes its own tiles or blocks, clip exactly at
the tile edge in `bake.ts` and skip run-time clipping [68][84]; bake
borders and casings from unclipped lines so clip edges are not stroked.
Stencil per tile only when consuming third-party buffered tiles with
translucent fills or casings [26].

## Decision 6: labels, symbols and screen overlays

- Last pass, no depth test. harp.gl stopped writing depth for text and
  icons, then disabled the test, after icons failed it in globe top-down
  views [77]. WebWorldWind draws screen images outside the eye-distance
  ordered renderables with depth off [94].
- Lay out first, paint, then labels. protomaps-leaflet runs label layout
  first-to-last, then paint back to front, then label closures; priority is
  rule order only, so cross-tile layout depends on load order [65]. ol2
  redraws all features, then all labels in a second pass [58]. mapsforge
  took labels out of raster tiles into a screen-space layer to allow
  rotation and stop clipping at tile borders, paying a per-frame redraw,
  a layout thread and memory pressure [109].
- Interleaved or lifted? OpenLayers 6 lifted decluttered labels above every
  layer and needed `flushDeclutterItems()` as a workaround; 9.0 went back
  to keeping layer order [51][55]. Decide statically and write it down
  [51].
- One loop in priority order. kothic-js's separate loops for icons, texts
  and icon+text let a low z-index icon block a higher z-index text (issue
  open) [82]. walkers sorts labels once by map layer and style layer so
  higher style layers win [115].
- Icons in a 3D scene: deck.gl draws billboards at the depth of their
  anchor, so a slanted building cuts the top of an icon but not the bottom;
  use world-space quads for true occlusion [33]. Cesium tests billboards
  against the depth texture at three points and shows them whole if any is
  visible [32].
- Knock-out halos (roads cut under labels) take a mask pass: QGIS renders
  masks into an alpha image and re-renders masked symbol layers [40][42];
  for vector output it records mask paths and clips, per feature [41][43].

## Decision 7: depth in 3D and on globes (summary)

- Near plane as far out as the closest geometry allows: MapLibre moved from
  1 to `height/50`, fixing deck.gl z-fighting but clipping near 3D sooner
  [8]; maplibre-rs refused to lower znear and fixed the real cause, tile
  selection tied to znear/zfar [18]; WorldWind bounds near below the
  terrain distance and above a minimum [95]; globe.gl fixes near at 0.05
  and derives the minimum camera distance from it [86].
- Derive near/far from everything drawn, and not from empty tiles: QGIS
  clipped point clouds while using only terrain bounds, and empty chunk
  nodes with extreme heights broke the range [44][45]. iTowns computes them
  per move from altitude and horizon and retuned the far factor from 20 to
  0.3 [91].
- Huge depth ranges: Cesium went from multi-frustum (commands drawn up to 3
  times, seams) to log depth (3 frustums to 1) [28][30]; openglobus to one
  reversed-Z frustum [88]; ortho-earth writes log depth per fragment in all
  16 depth-writing passes, +0.38 ms (~8%) for lost early-Z [38]; osgEarth
  keeps it per vertex [98]. Numbers are in the float-precision skill [5].
- WebGPU clip z is 0..w, WebGL -w..w: deck.gl's layers were blank on
  WebGPU until depth was remapped where the WGSL clip position is built
  [36].
- Sharing depth with a foreign basemap needs one GL context and matching
  near/far/fov; deck.gl's harp.gl thread ran 61 comments over about 4
  months [33]. Own both or do not interleave [33][34].

## Canvas 2D and DOM specifics

- One canvas. OpenLayers went from one canvas (3.14) to one per layer
  (3.20, seams under rotation) to DOM composition (6.0) to sharing canvases
  between adjacent layers (6.10) to avoid the WebGL context limit [50][52];
  maptalks' canvas per layer cost a full-screen composite per layer and
  frame [79].
- Compute the canvas pixel size in one function: OpenLayers 9.0 cleared a
  tile layer at browser zoom 150% because the vector renderer rounded the
  shared canvas size differently [53].
- Reset the transform before `clearRect`, or stale edges remain [64].
- Draw tiles straight onto the map canvas and rotate the composed frame
  once: 30 to 50-60 fps on a fast zoom, no change with 25 layers [52].
- DOM renderers: explicit z-index on a layer with opacity < 1 creates a
  stacking context; Leaflet reorders DOM nodes instead [63][62]; polymaps
  hides layers rather than remove and re-add them, which changed order
  [85].

## Tried and reverted

- MapLibre drew a solid background with `gl.clear`; reverted after a
  colour-buffer bug with fill-extrusions [12].
- Mapbox GL JS removed the offscreen line-opacity pass for speed; MapLibre
  reinstated it years later, limited to constant opacity [7].
- maplibre-rs: checkerboard stencil abandoned [19]; a PR lowering znear to 1
  not merged [18]; all transparency removed pending OIT [17].
- tangram-es: stencil proxy tiles closed as equivalent to polygon offset
  [72].
- OpenLayers: per-layer canvas, direct drawing, per-layer canvas again,
  DOM composition, shared canvases [50][52]; labels lifted above all layers
  then returned to layer order [51][55].
- GRASS: boundaries on by default, then off again [46].
- OsmAnd: on-terrain lift 1.0 to 0.5 and back [105].
- VTM: depth clipping of tiles removed and restored the same day for proxy
  drawing only [111].
- Cesium: clearing globe depth with terrain depth testing on, reverted
  [32]. harp.gl: a ray-based far plane reverted and re-landed the next day
  [78].
- ortho-earth: per-fragment depth on terrain only made a new band; all
  passes had to match [38]. osgEarth dropped the fragment log-depth variant
  [98].
- QGIS: masks first rasterised PDF exports; vector clip paths came later
  [42][43].
- WebWorldWind: stencil shadow volumes measured 3-6x faster than
  render-to-texture for surface shapes but never merged [93].

## Guidance for a renderer here

1. Write the order rule as a sentence at the top of `bake.ts` and in
   `architecture_selection` (what is drawn first, what wins ties, where
   labels go), as 05 and 07 do [2][3]. Emit records and draw calls in that
   order; sort nothing at run time [1].
2. A typical 2D stack: background clear, large areas by size, water, small
   areas, line casings and fills interleaved per class or z-level, points
   big first, labels last with no depth test [106][103][3][77].
3. Hit-test in reverse draw order, so the picked feature is the visible one
   [3].
4. No depth buffer for 2D. If 3D is requested, give depth to the 3D part,
   use LEQUAL where order breaks ties, push the near plane out, and keep
   tile selection independent of the depth planes [29][8][18].
5. Translucency: bake opaque colours or dissolve overlaps first; otherwise
   pick from the Decision 4 table and measure the extra pass [7][73].
6. Tiles: clip at bake; stencil only for buffered tiles with translucent
   content [26][68].
7. Batch only runs of the same style that are adjacent in draw order
   [114][80].
8. Functional checks for order (take positions from the baked data, see
   pitfalls.md): a pixel where a top feature crosses a bottom one has the
   top colour; a pixel where a translucent layer crosses itself equals the
   single-coverage colour; a pixel on a tile seam equals its neighbours.
   Run them at a fractional devicePixelRatio too [53].

## Sources

1. skills/map-from-scratch/SKILL.md ; skills/map-from-scratch/references/patterns.md
2. examples/05-tokyo-roads-native/bake.ts
3. examples/07-world-cities-hover/bake.ts ; examples/07-world-cities-hover/cities.ts
4. examples/02-world-population-mobile/map.ts
5. .agents/skills/float-precision/SKILL.md ; .agents/skills/tile-lod-and-overzoom/SKILL.md ; .agents/skills/label-placement/SKILL.md ; .agents/skills/3d-buildings-and-meshes/SKILL.md
6. ref-repos/maplibre__maplibre-gl-js/developer-guides/globe.md
7. https://github.com/maplibre/maplibre-gl-js/pull/7490 ; https://github.com/mapbox/mapbox-gl-js/issues/4090
8. https://github.com/maplibre/maplibre-gl-js/commit/5cf6e5f52
9. https://github.com/maplibre/maplibre-gl-js/commit/14b0bb383
10. ref-repos/maplibre__maplibre-gl-js/developer-guides/life-of-a-tile.md ; ref-repos/maplibre__maplibre-gl-js/developer-guides/globe.md
11. https://github.com/maplibre/maplibre-gl-js/pull/1191
12. https://github.com/maplibre/maplibre-gl-js/commit/daf7cb1b4
13. https://github.com/maplibre/maplibre-gl-js/commit/c48a56be0
14. https://github.com/maplibre/maplibre-native/commit/31a3d3603
15. https://github.com/maplibre/maplibre-native/commit/0cd646180
16. https://github.com/maplibre/maplibre-native/commit/b83030aa9bb1a8d9f14ae8160698c1ee4d5a4c72
17. https://github.com/maplibre/maplibre-rs/issues/252
18. https://github.com/maplibre/maplibre-rs/pull/134 ; https://github.com/maplibre/maplibre-rs/pull/147
19. https://github.com/maplibre/maplibre-rs/blob/main/docs/src/development-documents/stencil-masking.md ; ref-repos/maplibre__maplibre-rs/docs/src/development-documents/stencil-masking.md ; ref-repos/maplibre__maplibre-rs/maplibre/src/render/tile_view_pattern/pattern.rs ; https://github.com/maplibre/maplibre-rs/commit/35e1893 ; https://github.com/maplibre/maplibre-rs/commit/2b917e9 ; https://github.com/maplibre/maplibre-rs/commit/021376a
20. https://github.com/maplibre/maplibre-rs/commit/a928fbd ; https://github.com/maplibre/maplibre-rs/commit/ebaacd7
21. https://github.com/maplibre/maplibre-rs/commit/ec1ad07
22. https://github.com/maplibre/maplibre-tile-spec/blob/main/docs/overview.md ; ref-repos/yuiseki__maplibre-tile-spec/docs/overview.md ; https://github.com/maplibre/maplibre-tile-spec/blob/main/docs/benchmarks.md ; ref-repos/yuiseki__maplibre-tile-spec/docs/benchmarks.md ; https://github.com/maplibre/maplibre-tile-spec/blob/main/rust/mlt-core/CHANGELOG.md ; ref-repos/yuiseki__maplibre-tile-spec/rust/mlt-core/CHANGELOG.md
23. https://github.com/maplibre/navara/blob/main/guide/VECTOR_TILE_DRAPING.md ; https://github.com/maplibre/navara/blob/main/guide/TILE_TEXTURE_COMPOSITING.md
24. https://github.com/maplibre/navara/pull/468 ; https://github.com/maplibre/navara/pull/488 ; https://github.com/maplibre/navara/pull/584
25. ref-repos/opengeos__RustGIS/docs/user-guide/maps.md ; ref-repos/opengeos__RustGIS/ROADMAP.md ; ref-repos/opengeos__RustGIS/docs/architecture.md
26. https://github.com/opengeos/RustGIS/pull/611
27. https://github.com/reearth/reearth-papers/commit/3224ead ; https://github.com/reearth/reearth-papers/commit/7c0e951
28. ref-repos/CesiumGS__cesium/CHANGES.md ; https://github.com/CesiumGS/cesium/pull/5851 ; https://github.com/CesiumGS/cesium/pull/8727 ; https://github.com/CesiumGS/cesium/pull/8600
29. ref-repos/CesiumGS__cesium/CHANGES.md ; https://github.com/CesiumGS/cesium/pull/4675 ; https://github.com/CesiumGS/cesium/pull/8646
30. https://github.com/CesiumGS/cesium/pull/261
31. https://github.com/CesiumGS/cesium/pull/2865
32. https://github.com/CesiumGS/cesium/commit/234a4a3e36d5c30eb3feb8dba4ed7a594f80c619 ; https://github.com/CesiumGS/cesium/commit/b804be9e97b73d7e0423d563b6ac5a91d678aae9
33. https://github.com/visgl/deck.gl/issues/4603
34. https://github.com/visgl/deck.gl/pull/10566
35. https://github.com/visgl/deck.gl/pull/3935
36. https://github.com/visgl/deck.gl/pull/10520
37. https://github.com/kenjiyoshidahome2026-bit/ortho-earth/blob/main/packages/ortho-core/gint%20draw%20spec.md ; ref-repos/kenjiyoshidahome2026-bit__ortho-earth/packages/ortho-core/gint draw spec.md ; ref-repos/kenjiyoshidahome2026-bit__ortho-earth/packages/ortho-core/webgpu port.md
38. https://github.com/kenjiyoshidahome2026-bit/ortho-earth/blob/main/packages/ortho-core/fallback-ladder.md ; ref-repos/kenjiyoshidahome2026-bit__ortho-earth/packages/ortho-core/fallback-ladder.md ; https://github.com/kenjiyoshidahome2026-bit/ortho-earth/issues/62
39. https://github.com/kenjiyoshidahome2026-bit/ortho-earth/blob/main/packages/ortho-core/raster%20tiles.md ; ref-repos/kenjiyoshidahome2026-bit__ortho-earth/packages/ortho-core/raster tiles.md ; ref-repos/kenjiyoshidahome2026-bit__ortho-earth/packages/ortho-core/perf survey.md
40. ref-repos/qgis__QGIS/doc/design/selective_masking/README.md ; ref-repos/qgis__QGIS/doc/design/selective_masking/p4/README.md
41. ref-repos/qgis__QGIS/ChangeLog (line 88622, 2024-06-19 "Greatly optimise selective masking vector exports")
42. https://github.com/qgis/QGIS/pull/30747 ; https://github.com/qgis/QGIS-Enhancement-Proposals/issues/63
43. https://github.com/qgis/QGIS/pull/47459 ; https://github.com/qgis/QGIS-Enhancement-Proposals/issues/186
44. https://github.com/qgis/QGIS/commit/8f4a3c64df
45. https://github.com/qgis/QGIS/commit/978fb94bd9 ; https://github.com/qgis/QGIS/commit/bdbd3af8fe
46. https://github.com/OSGeo/grass/commit/597d57499 ; https://github.com/OSGeo/grass/commit/fe3153e14 ; https://github.com/OSGeo/grass/commit/e9d825114
47. ref-repos/KDE__marble/docs/layermanagement.txt ; https://invent.kde.org/education/marble/-/blob/master/docs/layermanagement.txt ; ref-repos/KDE__marble/docs/dgml2.txt
48. https://github.com/KDE/marble/commit/973fa9918 ; https://github.com/KDE/marble/commit/7ffc8c5f6 ; https://github.com/KDE/marble/commit/d6a9063ce
49. https://github.com/KDE/marble/commit/02645ed73 ; https://github.com/KDE/marble/commit/2777cef99 ; https://github.com/KDE/marble/commit/207765fd4
50. ref-repos/openlayers__openlayers/changelog/upgrade-notes.md ; ref-repos/openlayers__openlayers/changelog/v3.14.0.md ; ref-repos/openlayers__openlayers/changelog/v3.20.0.md ; ref-repos/openlayers__openlayers/changelog/v6.0.0.md ; ref-repos/openlayers__openlayers/changelog/v6.10.0.md
51. ref-repos/openlayers__openlayers/changelog/v4.5.0.md ; ref-repos/openlayers__openlayers/changelog/v9.0.0.md ; ref-repos/openlayers__openlayers/changelog/v7.5.2.md ; https://github.com/openlayers/openlayers/pull/15466 ; https://github.com/openlayers/openlayers/pull/15028
52. https://github.com/openlayers/openlayers/pull/4597 ; https://github.com/openlayers/openlayers/issues/4960
53. https://github.com/openlayers/openlayers/issues/15644 ; https://github.com/openlayers/openlayers/pull/15652
54. https://github.com/openlayers/openlayers/commit/645e359cd
55. https://github.com/openlayers/openlayers/commit/7a5e0db59 ; https://github.com/openlayers/openlayers/commit/8e862766f
56. https://github.com/openlayers/openlayers/commit/4651b26cc ; https://github.com/openlayers/openlayers/commit/ee7a1a60a
57. https://github.com/openlayers/openlayers/commit/09c83f3a6
58. https://github.com/openlayers/ol2/blob/master/lib/OpenLayers/Renderer/Canvas.js
59. https://github.com/openlayers/ol2/issues/392
60. https://github.com/openlayers/ol2/commit/c12cb25a ; ref-repos/openlayers__ol2/lib/OpenLayers/Renderer/SVG.js
61. https://github.com/openlayers/ol2/commit/8f45e057 ; https://github.com/openlayers/ol2/commit/7b908631
62. ref-repos/Leaflet__Leaflet/docs/examples/map-panes/index.md ; ref-repos/Leaflet__Leaflet/CHANGELOG.md
63. https://github.com/Leaflet/Leaflet/commit/1954d3d6
64. https://github.com/Leaflet/Leaflet/commit/1a09806d
65. ref-repos/protomaps__protomaps-leaflet/GUIDE.md ; ref-repos/protomaps__protomaps-leaflet/src/labeler.ts
66. https://github.com/protomaps/protomaps-leaflet/issues/33 ; https://github.com/protomaps/protomaps-leaflet/commit/5868f3e
67. https://github.com/tangrams/tangram/blob/master/src/styles/style_manager.js ; ref-repos/tangrams__tangram/src/styles/style_manager.js ; https://github.com/tangrams/tangram/blob/master/src/styles/style.js
68. https://github.com/tangrams/tangram/pull/455
69. https://github.com/tangrams/tangram/commit/a5add9c0 ; https://github.com/tangrams/tangram/commit/464fd323 ; https://github.com/tangrams/tangram/commit/da4dc328 ; https://github.com/tangrams/tangram/commit/b9afe9d1 ; https://github.com/tangrams/tangram/commit/97401dd0
70. https://github.com/tangrams/tangram/commit/acd35493 ; https://github.com/tangrams/tangram/commit/77e436c6
71. https://github.com/tangrams/tangram/commit/b82881dc ; https://github.com/tangrams/tangram/commit/717f00bb ; https://github.com/tangrams/tangram/commit/45467d1b ; https://github.com/tangrams/tangram/commit/06d9c525
72. https://github.com/tangrams/tangram-es/pull/458 ; https://github.com/tangrams/tangram-es/issues/411
73. https://github.com/tangrams/tangram-es/commit/7259be83 ; https://github.com/tangrams/tangram-es/commit/a77e1193 ; https://github.com/tangrams/tangram-es/commit/464d8881
74. https://github.com/tangrams/tangram-es/commit/dbb6420b
75. https://github.com/heremaps/harp.gl/commit/254ab363
76. ref-repos/heremaps__harp.gl/docs/@docs/fallback/README.md
77. https://github.com/heremaps/harp.gl/commit/7c7de6fd ; https://github.com/heremaps/harp.gl/commit/165e6c7d ; https://github.com/heremaps/harp.gl/commit/9e253967
78. https://github.com/heremaps/harp.gl/commit/7fbaee34 ; https://github.com/heremaps/harp.gl/commit/8074de50 ; https://github.com/heremaps/harp.gl/commit/394f28c6 ; https://github.com/heremaps/harp.gl/issues/1384
79. https://github.com/maptalks/maptalks.js/issues/2471 ; https://github.com/maptalks/maptalks.js/commit/1be9af634 ; https://github.com/maptalks/maptalks.js/commit/cb74d380e
80. https://github.com/kothic/kothic-js/commit/cdb1121 ; ref-repos/kothic__kothic-js/src/kothic.js ; ref-repos/kothic__kothic-js/src/renderer/line.js
81. https://github.com/kothic/kothic-js/commit/67cfcc1 ; https://github.com/kothic/kothic-js/issues/63
82. https://github.com/kothic/kothic-js/issues/63 ; ref-repos/kothic__kothic-js/src/kothic.js
83. https://github.com/simplegeo/polymaps/commit/e14c4d2 ; ref-repos/simplegeo__polymaps/src/Layer.js
84. https://github.com/simplegeo/polymaps/commit/42d77cf ; https://github.com/simplegeo/polymaps/commit/f36585d ; ref-repos/simplegeo__polymaps/src/GeoJson.js
85. https://github.com/simplegeo/polymaps/commit/4216fc6 ; https://github.com/simplegeo/polymaps/commit/2a1a5e2
86. https://github.com/vasturiano/globe.gl/commit/96f0cd1 ; https://github.com/vasturiano/globe.gl/commit/810ad92 ; ref-repos/vasturiano__globe.gl/src/globe.js
87. https://github.com/vasturiano/globe.gl/issues/248 ; https://github.com/vasturiano/globe.gl/commit/9c24697
88. https://github.com/openglobus/openglobus/commit/cb1d4e70 ; https://github.com/openglobus/openglobus/commit/38d9b94b ; https://github.com/openglobus/openglobus/commit/65c0591a ; ref-repos/openglobus__openglobus/src/camera/PlanetCamera.ts ; ref-repos/openglobus__openglobus/src/webgl/Handler.ts
89. https://github.com/iTowns/itowns/commit/06c7181 ; ref-repos/iTowns__itowns/changelog.md
90. https://github.com/iTowns/itowns/commit/654bc949 ; https://github.com/iTowns/itowns/commit/d1d63d49
91. https://github.com/iTowns/itowns/commit/56b722b2 ; https://github.com/iTowns/itowns/commit/f531af66
92. https://github.com/melowntech/vts-browser-js/commit/9955794 ; https://github.com/melowntech/vts-browser-js/commit/6470ed7 ; https://github.com/melowntech/vts-browser-js/commit/b907bcb ; ref-repos/melowntech__vts-browser-js/src/core/map/surface-tree.js ; ref-repos/melowntech__vts-browser-js/src/core/map/mesh.js ; ref-repos/melowntech__vts-browser-js/src/core/renderer/gpu/shaders.js
93. https://github.com/NASAWorldWind/WebWorldWind/issues/586
94. https://github.com/NASAWorldWind/WebWorldWind/commit/2f029bf ; https://github.com/NASAWorldWind/WebWorldWind/commit/9bc6c92
95. ref-repos/NASAWorldWind__WorldWindJava/src/gov/nasa/worldwind/view/BasicView.java ; https://github.com/NASAWorldWind/WorldWindJava/blob/2543c23/src/gov/nasa/worldwind/view/BasicView.java
96. ref-repos/pelicanmapping__osgearth/docs/design/procedural2-plan-history.md ; https://github.com/pelicanmapping/osgearth/blob/master/docs/design/procedural2-plan-history.md
97. https://github.com/pelicanmapping/osgearth/issues/640
98. https://github.com/pelicanmapping/osgearth/issues/2296
99. https://github.com/pelicanmapping/osgearth/issues/2074
100. https://github.com/pelicanmapping/osgearth/commit/13f55f750b54876b2ff849cef39673c99c6c233e
101. https://github.com/pelicanmapping/osgearth/commit/3edcb212f ; https://github.com/pelicanmapping/osgearth/commit/e02437dd8
102. https://github.com/mapnik/mapnik/blob/master/CHANGELOG.md ; https://github.com/mapnik/mapnik/issues/1409 ; https://github.com/mapnik/mapnik/commit/49c1c15c4c6081968a80ed0f4b5549decf61825e
103. ref-repos/geoserver__geoserver/doc/en/user/styling/sld/extensions/z-order/syntax.md
104. https://github.com/osmandapp/OsmAnd-core/commit/5805d60c
105. https://github.com/osmandapp/OsmAnd-core/commit/1e2314a1
106. ref-repos/organicmaps__organicmaps/data/styles/default/include/priorities_1_BG-by-size.prio.txt ; ref-repos/organicmaps__organicmaps/data/styles/default/include/priorities_2_BG-top.prio.txt ; ref-repos/organicmaps__organicmaps/data/styles/default/include/priorities_3_FG.prio.txt ; https://github.com/organicmaps/organicmaps/blob/master/data/styles/default/include/priorities_1_BG-by-size.prio.txt
107. https://github.com/organicmaps/organicmaps/commit/c2ee3a3e335353ba144c49d7b353571a9a3086df ; https://github.com/organicmaps/organicmaps/commit/6af516698e37f6db45fa52879bee3470c2cdb880
108. https://github.com/organicmaps/organicmaps/commit/2f0356070a4d8e682892eb5916b50897d937773c
109. ref-repos/mapsforge__mapsforge/docs/LabelLayer.md ; https://github.com/mapsforge/mapsforge/issues/763
110. https://github.com/mapsforge/vtm/issues/224 ; ref-repos/mapsforge__vtm/vtm/src/org/oscim/renderer/bucket/PolygonBucket.java ; ref-repos/mapsforge__vtm/vtm/src/org/oscim/renderer/bucket/MeshBucket.java
111. https://github.com/mapsforge/vtm/commit/20ddff3d ; https://github.com/mapsforge/vtm/commit/67d18136 ; ref-repos/mapsforge__vtm/vtm/src/org/oscim/layers/tile/VectorTileRenderer.java
112. https://github.com/osmdroid/osmdroid/issues/725
113. https://github.com/galileo-map/galileo/commit/4e0f49a
114. https://github.com/podusowski/walkers/commit/f366d36 ; https://github.com/podusowski/walkers/commit/8ca4633
115. https://github.com/podusowski/walkers/commit/7603831 ; https://github.com/podusowski/walkers/commit/c151e19
116. https://github.com/SciTools/cartopy/pull/1622 ; ref-repos/SciTools__cartopy/lib/cartopy/mpl/geoaxes.py
117. ref-repos/flopp__go-staticmaps/context.go ; https://github.com/flopp/go-staticmaps/commit/dbba1d7
