---
name: antialiasing-and-blending
description: How map engines smooth edges (MSAA, analytic coverage in the shader, post-process, none), pay for resolution, blend translucent layers without darkened overlaps, keep one alpha convention, and avoid seams between tiles and shapes, with what each choice cost them. Load it when a map-from-scratch request has translucent fills or lines, layer opacity, fades, thin strokes or points on a target without MSAA (offscreen framebuffer, WebGPU, another engine's context, Canvas 2D hit canvas), a devicePixelRatio or frame-time budget on a phone, or when output shows jaggies, darker overlaps, dark or white fringes, hairline seams, blurry icons, or colour-ID picks that return wrong ids.
---

# Antialiasing and blending: edges, alpha, overlaps and seams

Every map edge is a partial-coverage problem, and every partial-coverage
pixel is a blending problem. A general engine must antialias any shape on
any render target, blend any number of translucent layers in any order,
composite over any page, and accept tiles from any producer, so it carries
MSAA, shader coverage, offscreen passes, stencil tricks and alpha
bookkeeping, and still ships bugs where two of them meet: darker overlaps,
fringes at transparent edges, hairline seams between tiles, ids that do not
exist. A renderer made for one request knows its targets, its layers and
whether any of them is translucent, so most of this machinery becomes a
bake-time decision or disappears. This skill collects what the engines
decided and why. Line geometry (joins, the ±0.5 px outset) is in the
line-tessellation skill, glyph halos in text-rendering, icon snapping in
symbols-and-icons, fallback tiles in tile-lod-and-overzoom; only the
coverage and blending side is here [108]. Per-engine detail is in
[references/engines.md](references/engines.md).

## First decision: where does edge coverage come from?

| The target and shapes | Edge coverage from | Evidence |
| --- | --- | --- |
| default WebGL2 canvas you own, mixed shapes, desktop | `antialias: true` (MSAA), nothing in the shader | the repo's 02, 03, 07 do this [107]; MSAA gave 1,361 partial pixels on a 2 px diagonal but only 3 alpha levels [1] |
| offscreen framebuffer, WebGPU canvas, another engine's context (MapLibre, Google Maps) | analytic coverage in the shader: `fwidth`, half-pixel outset | no MSAA reaches these targets [1][2]; 0 partial pixels without it, 1,572 with >40 levels with it [1] |
| lines, circles, SDF glyphs, procedural patterns | analytic coverage, even with MSAA available | +2.0% GPU for 100K 1 px paths [1]; Cesium antialiases draped lines in the shader [8][9]; walkers feathers half a pixel instead of MSAA [20]; Organic Maps draws hatches with `fwidth` instead of mask textures [102] |
| stencil-filled polygons (07's even-odd fill) | MSAA only | the stencil test has no coverage value; the land edge in 07 is smoothed only because the canvas is multisampled [107] |
| id buffer, count buffer, exact-colour mask | none | antialiased hit-canvas edges decode to ids that do not exist [52]; the repo's 04 counts into a canvas with `antialias: false` and additive `ONE, ONE` [107]; MapServer added per-style aliased lines for exact colours [96] |
| a whole frame, weak mobile GPU | not FXAA | Organic Maps stopped enabling its post-process AA because it 'destroys performance on some Android devices' [103]; FXAA/TAA cannot recover coverage and break shared depth [1] |
| Canvas 2D | the browser's own AA | it cannot be turned off on a hit canvas [52]; antialiased clip paths leave gaps between tiles [17] |

Write the choice and the rejected rows into `architecture_selection`.

## Decisions the engines made

### Analytic edge coverage

- **The ramp is centred on the edge, ±0.5 px, and the geometry is widened
  by half a pixel.** OpenLayers' first ramp ran 0 to -1 px and every line
  came out 1 px thinner than asked [14]. deck.gl computes
  `clamp((1 - coord) / fwidth(coord) + 0.5, 0, 1)` and extends the strip by
  half a device pixel so the outer half of the ramp is rasterised [1];
  maplibre-rs adds a 0.5 px outset in clip space, multiplied by `w` [21];
  Cesium fades draped lines over a half-pixel band [9]; tangram enlarges
  point quads in the vertex shader for the same reason, and removed a
  '+1 px to balance antialiasing' that made outlines oversized [60].
- **Feather across the width, never along the length.** Segmented strokes
  abut lengthwise, so feathering their ends seams at every vertex; deck.gl
  leaves flat caps hard [1][2].
- **Coverage multiplies alpha before premultiplication.** Moving the
  multiply after it raised deck.gl's worst overshoot from 2 to 126 [2].
  Compute coverage before any `discard` [2].
- **Compile it as a variant, not a uniform branch**, so the default pays
  nothing; deck.gl replaced a uniform flag with GLSL/WGSL variants [2][3].
  Cost on an M1 Max at 3840x2160: +2.0% for 100K 1 px paths, +10.8% for
  256 overlapping 64 px strokes, +21.2% for 10K arcs, +6.6% for 100K points
  [1]. Cesium keeps an opt-out because 'disabling this is faster but leaves
  the edges aliased' [8][9].
- **Analytic AA on top of MSAA is a different picture**: deck.gl's WebGL
  golden dropped to a 98.28% match, so it is chosen per target [2].
- **Self-overlaps composite twice** with shader coverage; deck.gl documents
  it as a known artefact [1][3].
- **Dashes are prefiltered**: integrating the dash square wave over the
  pixel footprint fixed a 0.2 px period from mean/stdev 107.7/125.9 to
  127.5/0.5 (target 127.5), for +0.10 ms in an overdraw-heavy pass and
  nothing in a sparse one; rounded dash ends intersect the line's AA
  envelope once, not twice (double ramps gave dark shoulders) [4].
- **Points and fill+outline in one pass**: tangram composites stroke over
  fill in the shader with one `length()` and no branch [60]. The repo's 07
  does the same with a 1 px rim [107].
- **highp for SDF edge maths on mobile**: lowp gamma aliased large text on
  mobile in MapLibre [28].
- **Shader patterns beat mask textures**: Organic Maps replaced 13 mask PNGs
  (every DPI/theme) and their mipmaps with `fwidth`-antialiased patterns on a
  world-anchored lattice; thin lines stopped shimmering during zoom [102].

### Paying for pixels: resolution and when to antialias

- **Device pixel ratio is a budget, not a given.** Retina is 4x the
  fragments; deck.gl defaults `useDevicePixelRatio` to false and picking
  must follow the same ratio [6]. Cesium flipped its default three times
  (1.18 CSS px, 1.61 native, 1.62 flag off, 1.66 flag on) and settled on
  CSS pixels because weak laptop and phone GPUs ran 'at an unusable FPS'
  [10].
- **No MSAA while moving, one 4x frame when still.** ortho-earth's WebGPU
  path measured MSAA store/load/resolve as the largest fixed frame cost; it
  renders 1x during motion and one 4x frame after 500 ms still. Every
  animation source must count as motion: shadow-time replay counted as
  'still' doubled the main pass (10 to 21 ms) [39].
- **Measure GPU time, not wall clock, when adapting quality**: a 30 Hz
  monitor always read 33 ms and sank resolution to 0.55 at 3.7 ms of GPU
  time [40].
- **Turn MSAA off only after measuring it.** tangram-es on an iPhone 6S Plus
  went from ~6.3 to ~3.8 ms per frame with MSAA and stencil off plus shader
  work moved to vertices; the MSAA share was not separated [64].
- **Dropping AA is a visible quality cut.** QGIS measured 2%, 12% and 30%
  from disabling AA on three data sets, but the difference showed, so it is
  limited to about-one-pixel geometry and only when the user raises the
  simplification factor [44]. For dense 2D point clouds QGIS draws
  `fillRect` squares with AA off, 'orders of magnitude faster' [46].
- **Do not composite empty full-screen layers**: Marble's transparent
  routing overlay, repainted, uploaded and blended every frame, held a
  tablet at 3 fps; hiding it gave ~30 fps [48].

### Translucent overlaps: the darkening problem

Per-fragment alpha blending darkens wherever a layer overlaps itself:
crossing routes, line joins, buffered tile edges, polygons with several
styles. The engines found four ways out.

- **Draw the layer opaque offscreen, composite once with the layer
  opacity.** OpenLayers does this only when layer opacity < 1 [15].
  MapLibre GL JS did it for constant `line-opacity` in (0,1) [25]: a bench
  of 50 line layers at 0.5 was 3x slower at first, 1.95x later; the
  standard benches never reached the path because their opacities
  interpolate to 0 or 1. 6.0 reverted the automatic trigger and moved the
  fix behind a separate `line-layer-opacity` property [26]. Mapbox GL had
  removed the same approach long ago for performance [25]. A per-layer fill
  opacity PR stayed open 2022-2026 and was closed stale; a screen-size
  framebuffer did not fit terrain [27].
- **Write each pixel once with depth or stencil.** vtm clears depth and
  draws each translucent line style with depth test and writes, first as a
  global flag, then per style; reporters called it 'MUCH better' [104].
  tangram-es draws translucent polygons as a depth pre-pass plus `EQUAL`
  depth with a stencil `EQUAL 0, INCR`, so coplanar overlaps do not
  z-fight, at two passes and an 8-bit stencil [65]. MapLibre Native clips
  fill AA outlines with `LEQUAL` depth so they do not double-blend with
  neighbours [30]. MapLibre's own stencil attempt for lines failed: the
  first-drawn feature won, transparent pattern pixels wrote stencil, SDF
  edges showed artefacts [25].
- **Use commutative blend modes and no depth writes.** tangram draws add and
  multiply styles after opaque ones as order-independent approximations, and
  refused depth write with alpha because it regroups draws by tile and
  shader, so translucent geometry drawn first would hide what lies behind
  [61][62]. tangram-es turns depth writes off for add and multiply [66].
  Additive suits only a known dark background: globe.gl's additive arcs
  vanished on white and switched to normal blending [72].
- **Order-independent transparency only for intersecting 3D volumes.**
  Cesium's weighted blended OIT needs no sorting, but two layers looked
  almost opaque and three opaque, and an FBO bind typo cost every draw [11].
  maplibre-rs removed all transparency until OIT exists [22]. navara left
  translucent instances inside one InstancedMesh unsolved: CPU sorting is
  per mesh, and depth-then-colour dual pass doubles GPU work [35].
- **Batching merges overlaps.** OpenLayers fills up to 200 polygons in one
  path only when the source declares `overlaps: false`; sniffing alpha in
  the style was tried and dropped as an 'opacity guessing game' [16].

### One alpha convention, end to end

- **Premultiplied for anything filtered or composited.** Mapnik's grey
  fringes under bilinear scaling came from premultiplying twice; AGG filters
  require premultiplied input [85]. It moved the whole rasteriser to
  premultiplied buffers, premultiplies markers once before caching, and
  added a `premultiplied` flag to images after a string of bugs (#1489,
  #1541, #1995, #2011) [84]. iTowns removed white fringes on transparent
  raster layers with premultiplied textures and shader [73]. GRASS fixed
  transparent-over-opaque cells by matching cairo's premultiplied surfaces
  [47]. WorldWindJava premultiplies symbol textures and alpha-tests
  `> 0` so transparent texels stay out of the pick frame [79].
- **When resolving MSAA into a texture, un-premultiply on the copy**, or
  edges darken (or brighten by 1/alpha); navara bakes all draped features
  through one shared multisampled target because per-tile multisampling
  quintupled every drape target's memory [34]. MapLibre Native uploads
  decoded premultiplied images as-is and un-premultiplies in the shader
  [32].
- **Separate alpha blend when the canvas is composited over something.**
  deck.gl's `blendFuncSeparate(..., ONE, ONE_MINUS_SRC_ALPHA)` was reverted
  the same day for compatibility and left opt-in, so overlay alpha stays
  wrong by default [5]. The repo's WebGL canvases are `alpha: false`, which
  avoids the question [107].
- **One colour space**: galileo dropped sRGB textures and surface because
  images are decoded as plain RGBA bytes; blending then happens in gamma
  space [106].
- **Fix the convention in test readback**: maplibre-rs's premultiplied PR
  converts readback to straight alpha before comparing with PNG fixtures
  [24].

### Seams between tiles and shapes

- **Snap tile placement to device pixels at rest.** Fractional positions
  leave antialiased, partly transparent edges on both sides: Leaflet snaps
  drag positions by `round(x * dpr) / dpr` [58] and rounds offsets in the
  drawing step, not in stored geometry [54]; QGIS expands integer tile rects
  outwards [41]; modestmaps makes scale × width an integer and rounds only
  when stopped [70]; polymaps rounds only at integer zoom without rotation,
  and seams at fractional zoom stayed open for years [71].
- **Compositor seams are not fixable from DOM tiles.** Leaflet's seam issue
  ran from 2015 with 200+ comments; 1 px oversize blurred tiles and broke
  overzoom, stitching to one canvas was 'really slow', and the 2023 fix is
  `mix-blend-mode: plus-lighter` on tile images, narrowed to `img` within
  two weeks [55]. TerriaJS draws tiles 0.5 px larger [77]; Leaflet called
  its zoom-animation seams 'not possible to fix on the Leaflet side' [57].
  modestmaps' one-transform-per-level was reverted over Safari seams [69].
- **Do not clip with antialiased paths at tile edges.** OpenLayers renders
  each vector tile into its own canvas instead [17]; on iOS 12 a rotated
  clip made `drawImage` up to 93x slower [19].
- **Clip at bake time with a buffer, and do not stroke the clip edge.**
  MapServer pads polygon clipping by 2 px so degenerate clipper edges fall
  off-image, and sizes the buffer from every style's width and offset [93];
  GeoServer clips vector tiles 12 px outside the tile [97]; TerriaJS's
  Tippecanoe polygon splitting drew stray lines until `--no-polygon-splitting`
  [74].
- **Clip each tile to its square when tiles carry buffers.** RustGIS's
  stencil per tile fixed see-through double-blended fills (48k outlier
  pixels) [37]; tangram draws unclipped and accepts doubled translucent
  polygons at tile edges, advising bake-time clipping [61].
- **Adjacent faces of one mesh must not blend twice.** Mapnik warps
  transparent rasters with `src` compositing instead of `src-over` because
  antialiased face edges seamed [89]. MapServer stopped drawing a hidden
  same-colour outline around every polygon; coverages that need continuity
  add it explicitly [91].
- **Atlas and texture edges**: deck.gl uses `lodMaxClamp: 0` so pattern
  cells do not bleed at minification [7]; Cesium tolerates texcoords 1/10
  texel outside [0,1] [13]. Clear pooled bitmaps before drawing transparent
  content: osmdroid showed stale tiles over empty sea [105].

### Fades and translucent stand-ins

- **A fade multiplies with layer opacity.** WebWorldWind needed three fixes
  (flashing, failed-load fallbacks fading, double opacity) and then disabled
  fading on translucent layers [78]. OpenLayers 2 discouraged back-buffer
  transitions on transparent layers [51]; harp.gl offers
  `allowOverlappingTiles=false` because overlapping transparent tiles
  flickered [67]; tangram stencil-masks translucent proxy tiles but not
  points or text, where transparent pixels write stencil and cut out [59].
- **Cross-fades with coverage (A2C/MSAA) bring the new one to full first**:
  osgearth uses min(1, 2(1-t)) and min(1, 2t); complementary ramps kept
  about 68% of reference coverage at the midpoint [80].
- **Never make correctness depend on a fade's completion event**: OL2's
  `transitionend` never fired without a CSS rule, so old tiles stayed [49];
  Leaflet's fade states made pruning racy [56].

### Pixel snapping and filtering

- Snap only when idle: OpenLayers removed per-style `snapToPixel` and snaps
  when no interaction or animation runs [18]; tangram's always-on snapping
  shimmered during slow pans [60]. MapLibre Native tried nearest icon
  sampling during pure pans and reverted it without a stated reason [33].
  OL2, Mapnik and OsmAnd round icon positions to whole pixels at native
  size [53][88][101]; tangram found CPU rounding of label positions
  useless because the view matrix moves them off the grid again, so it
  snaps in the vertex shader [63]. Icon and glyph specifics:
  symbols-and-icons, text-rendering [108].
- Resample data, not colours, and on the target's pixel grid: QGIS moved
  raster resampling to read time so layers stop shifting by a subpixel,
  at the price of harder edges and a visible look change [45]; OL2's tile
  seams came from sub-pixel CSS positions [50].
- Round points come from the fragment shader, not driver point smoothing:
  osgEarth's smooth points vanished in a Qt-hosted context until a 3.3
  context was requested [81]. Mip level on a pitched raster map can be
  computed per vertex to save fragment work [100].
- Halos are a coverage problem too: one-pass SDF halo+fill cut MapLibre's
  symbol time by about 40% [29]; Mapnik's 'fast' halo rasteriser doubled
  its text benchmark for 1-2 px halos [82]; MapServer replaced 8 offset
  redraws with a stroked outline [94]. Details: text-rendering [108].
- Knock-out masks (labels cutting roads) are a second pass or a stencil;
  QGIS's version cost about 8k lines and forced rasterised PDF until mask
  shapes were recorded as clip paths [42].

### Palette output

- Keep a few alpha levels, not binary transparency: Mapnik's png256 builds
  one octree per alpha range (4 levels by default, ~10% more encode time and
  size) [87]; GeoServer uses an RGBA median cut when transparent [98];
  MapServer pre-allocates semantic colours before AA eats the palette [92].
  Composite lossless layers, not palette ones: GeoServer's png8 member
  tiles lost antialiased edges when stacked [99].

## Tried and reverted

- MapLibre GL JS: offscreen pass tied to `line-opacity` (#7490) reverted in
  6.0 for a separate property [25][26]; stencil masking of line overdraw
  [25]; per-layer fill opacity PR closed stale [27].
- MapLibre Native: nearest icon filtering during pans, reverted [33].
- deck.gl: separate alpha blending as default, reverted the same day [5];
  uniform AA branch replaced by compiled variants [2].
- Cesium: render resolution default flipped 1.18 → 1.61 → 1.62 → 1.66 [10];
  an SDF distance texture for clipping polygons, replaced by per-tile
  vector lookups because a fixed-resolution SDF ran out across distance
  scales [12].
- OpenLayers: fill batching landed, reverted within a week, re-landed with
  alpha sniffing, replaced by `overlaps` [16]; fractional overlay positions
  reverted in 4.3.3 [18].
- QGIS: always disabling AA for tiny features as part of fast drawing [44].
- Leaflet: 1 px oversize, NoGap, `L_DISABLE_3D`, then `mix-blend-mode`
  narrowed to images [55]. modestmaps: per-level transform reverted from
  master [69]. polymaps: a Firefox rounding tweak rolled back [71].
- MapServer: cleaning degenerate clipped edges caused polygon flooding [93];
  GD backend removed after years beside AGG [91]; GD halo stroker route
  closed [94].
- maplibre-rs: tile stencil by x/y parity abandoned [23]; all transparency
  removed pending OIT [22].
- navara: forked UnrealBloomPass replaced by a mip blur (square halos,
  threshold flicker) [36].

## Guidance for a renderer in this repo

1. **List the targets and say where coverage comes from on each** (table
   above). The repo's browser examples own their canvas, so `antialias:
   true` is the start [107]; any offscreen, float, id or count target is
   single-sample, and shapes drawn there need analytic coverage or none
   [1][52]. A stencil fill gets edges only from MSAA [107].
2. **Analytic AA for lines, points and patterns**: ±0.5 px ramp from
   `fwidth`, quad widened by half a device pixel, width-wise only, coverage
   before premultiplication, highp on mobile [14][1][2][28]. If MSAA is also
   on, decide which one owns the edge and check the picture [2].
3. **Budget the pixel ratio and MSAA in `spec.yaml`.** Bench frame GPU time
   at DPR 1, 2 and the device's, with and without MSAA [6][10][39]. If the
   map animates and MSAA is expensive, render moving frames at 1x and one
   MSAA frame when still, and count every animation as motion [39]. On weak
   phones avoid full-screen post-process AA [103].
4. **Bake translucency away when you can.** Most map layers are not seen
   through each other: mix the colour with the background at bake time and
   draw opaque. If a layer must stay translucent, decide its overlap rule
   at bake time: a non-overlapping coverage can be one path or one mesh
   [16]; overlapping routes or tracks need write-once (stencil or depth per
   layer) [104][65]; an offscreen composite is affordable for one or two
   layers, not dozens [25]. If overlaps are supposed to add up (track
   density), say so: write-once removes that [25].
5. **Premultiplied alpha everywhere** in textures, sprites and blending,
   converted once in `bake.ts`; `blendFunc(ONE, ONE_MINUS_SRC_ALPHA)` then
   matches [84][85][73]. The repo's examples blend untextured vertex
   colours with `SRC_ALPHA, ONE_MINUS_SRC_ALPHA` [107]; that is exact while
   nothing is filtered, resolved or composited, so switch when the first
   texture, sprite or offscreen layer arrives. Keep `alpha: false` unless
   the map is composited over the page; then set the alpha channel's blend separately [5][107].
6. **No seams by construction**: clip at bake time to the tile or view plus
   max stroke width + offset + 1 px, and never stroke a clip edge [93][97]
   [74]; draw a level of tiles as one mesh in one surface rather than as
   separately antialiased quads [55][17]; snap at rest, not in motion
   [18][58].
7. **Leave out what the purpose excludes**: OIT, fade machinery, proxy
   stencils, palette quantisers and dirty-rect compositors all exist for
   inputs a general engine cannot predict [11][78][59][87][83].
8. **Check edges in `verification.checks`.** Count partial-coverage pixels
   on a known diagonal like deck.gl's RFC (0 means no AA reached the
   target) [1]; sample an overlap of two translucent features against the
   single-feature colour; compare screenshots with per-pixel tolerance
   masks, not exact matches [43].

## Sources

Local paths are relative to the repository; `rr/` is `ref-repos/`.

1. https://github.com/visgl/deck.gl/blob/master/dev-docs/RFCs/v9.4/analytic-antialiasing-rfc.md ; `rr/visgl__deck.gl/dev-docs/RFCs/v9.4/analytic-antialiasing-rfc.md`
2. https://github.com/visgl/deck.gl/pull/10520
3. https://github.com/visgl/deck.gl/commit/427df1b0 ; https://github.com/visgl/deck.gl/commit/9846e044
4. https://github.com/visgl/deck.gl/pull/10581
5. https://github.com/visgl/deck.gl/commit/925a0fa9 ; https://github.com/visgl/deck.gl/commit/2cc1b8fc ; https://github.com/visgl/deck.gl/commit/e01e5b73
6. https://github.com/visgl/deck.gl/commit/376ccfdb ; https://github.com/visgl/deck.gl/commit/32f92341 ; https://github.com/visgl/deck.gl/commit/2645c8e6
7. https://github.com/visgl/deck.gl/commit/14d5aa0f
8. `rr/CesiumGS__cesium/CHANGES.md` ; https://github.com/CesiumGS/cesium/pull/13675 ; https://github.com/CesiumGS/cesium/pull/13703
9. https://github.com/CesiumGS/cesium/commit/d14b301dc06b54f6d994f2cfd353aad7c96160b7 ; https://github.com/CesiumGS/cesium/commit/09a5810776d8bbc41ea029eca8a5f1a2aa6b404d ; https://github.com/CesiumGS/cesium/commit/b470ad5241a2860792f92364f9f22b376258323a
10. `rr/CesiumGS__cesium/CHANGES.md` ; https://github.com/CesiumGS/cesium/pull/8548 ; https://github.com/CesiumGS/cesium/issues/8082 ; https://github.com/CesiumGS/cesium/issues/8215 ; https://github.com/CesiumGS/cesium/commit/7f2dd38a7 ; https://github.com/CesiumGS/cesium/commit/6a9520fef
11. https://github.com/CesiumGS/cesium/pull/1412
12. https://github.com/CesiumGS/cesium/commit/1a74c94654ed16e99f6a13b7da1059f1c6b41520 ; https://github.com/CesiumGS/cesium/commit/dd17f1037609ce24d5c93cb63dbbae81b1219c6a ; https://github.com/CesiumGS/cesium/commit/8862ae50335a5ef8bbcd25ead626a3281084caa9 ; https://github.com/CesiumGS/cesium/commit/e1c238f1c67562f31e879086e49ad5de3b87550f
13. https://github.com/CesiumGS/cesium/commit/048416a30 ; https://github.com/CesiumGS/cesium/commit/3014ae331
14. https://github.com/openlayers/openlayers/commit/dea2bab81
15. https://github.com/openlayers/openlayers/commit/645e359cd
16. https://github.com/openlayers/openlayers/pull/5196 ; https://github.com/openlayers/openlayers/issues/4232 ; https://github.com/openlayers/openlayers/commit/18f3d7243 ; https://github.com/openlayers/openlayers/commit/880d4b89a ; https://github.com/openlayers/openlayers/commit/eed52552a ; https://github.com/openlayers/openlayers/commit/7e940e618
17. https://github.com/openlayers/openlayers/commit/c1b16217f ; https://github.com/openlayers/openlayers/commit/44764ec1d
18. `rr/openlayers__openlayers/changelog/upgrade-notes.md` ; `rr/openlayers__openlayers/changelog/v4.3.3.md`
19. https://github.com/openlayers/openlayers/issues/8531
20. https://github.com/podusowski/walkers/commit/a79e4dd
21. https://github.com/maplibre/maplibre-rs/commit/0de294e
22. https://github.com/maplibre/maplibre-rs/issues/252
23. https://github.com/maplibre/maplibre-rs/blob/main/docs/src/development-documents/stencil-masking.md ; `rr/maplibre__maplibre-rs/docs/src/development-documents/stencil-masking.md` ; `rr/maplibre__maplibre-rs/maplibre/src/render/tile_view_pattern/pattern.rs`
24. https://github.com/maplibre/maplibre-rs/pull/340
25. https://github.com/maplibre/maplibre-gl-js/pull/7490 ; https://github.com/mapbox/mapbox-gl-js/issues/4090
26. `rr/maplibre__maplibre-gl-js/CHANGELOG.md` ; https://github.com/maplibre/maplibre-gl-js/pull/7764
27. https://github.com/maplibre/maplibre-gl-js/pull/1191
28. https://github.com/maplibre/maplibre-gl-js/commit/10315c051 ; https://github.com/maplibre/maplibre-gl-js/commit/a72aab768 ; https://github.com/maplibre/maplibre-gl-js/commit/293c80c69
29. https://github.com/maplibre/maplibre-gl-js/commit/018c3a089
30. https://github.com/maplibre/maplibre-native/commit/31a3d3603
31. https://github.com/maplibre/maplibre-native/commit/893c97f20 ; https://github.com/maplibre/maplibre-native/commit/8264a1c86 ; `rr/maplibre__maplibre-native/src/mln/renderer/buckets/fill_bucket.hpp`
32. https://github.com/maplibre/maplibre-native/commit/8ae701054
33. https://github.com/maplibre/maplibre-native/commit/e2981c890 ; https://github.com/maplibre/maplibre-native/commit/a70bfd891
34. https://github.com/maplibre/navara/blob/main/guide/TILE_TEXTURE_COMPOSITING.md ; `rr/maplibre__navara/guide/TILE_TEXTURE_COMPOSITING.md`
35. https://github.com/maplibre/navara/pull/656 ; https://github.com/maplibre/navara/pull/816 ; https://github.com/maplibre/navara/pull/833
36. https://github.com/maplibre/navara/pull/832
37. https://github.com/opengeos/RustGIS/pull/611
38. https://github.com/opengeos/RustGIS/commit/f2ae8c0
39. https://github.com/kenjiyoshidahome2026-bit/ortho-earth/blob/main/packages/ortho-core/fallback-ladder.md ; `rr/kenjiyoshidahome2026-bit__ortho-earth/packages/ortho-core/fallback-ladder.md` ; `rr/kenjiyoshidahome2026-bit__ortho-earth/packages/ortho-core/webgpu port.md` ; https://github.com/kenjiyoshidahome2026-bit/ortho-earth/commit/06462fba
40. https://github.com/kenjiyoshidahome2026-bit/ortho-earth/commit/b06368cd ; https://github.com/kenjiyoshidahome2026-bit/ortho-earth/commit/9afc6f21
41. `rr/qgis__QGIS/ChangeLog` (line 53370, 2025-04-22 'Fix visible gaps in between xyz tiles')
42. `rr/qgis__QGIS/doc/design/selective_masking/README.md` ; `rr/qgis__QGIS/doc/design/selective_masking/p4/README.md` ; https://github.com/qgis/QGIS/pull/30747 ; https://github.com/qgis/QGIS-Enhancement-Proposals/issues/63 ; https://github.com/qgis/QGIS/pull/47459 ; https://github.com/qgis/QGIS-Enhancement-Proposals/issues/186
43. `rr/qgis__QGIS/ChangeLog` (line 527784, 2015-02-18 'Allow use of masks for unit test control images')
44. https://github.com/qgis/QGIS/issues/17441 ; https://github.com/qgis/QGIS/pull/980 ; https://github.com/qgis/QGIS/commit/3ddcdac57f ; https://github.com/qgis/QGIS/commit/95cabe5711
45. https://github.com/qgis/QGIS/pull/37044 ; https://github.com/qgis/QGIS/issues/36820 ; https://github.com/qgis/QGIS/issues/40746
46. https://github.com/qgis/QGIS/commit/f68e3ae5fa ; https://github.com/qgis/QGIS/commit/47a6e36ee0
47. https://github.com/OSGeo/grass/commit/314d2a35b
48. https://github.com/KDE/marble/commit/e2091b15c ; https://github.com/KDE/marble/commit/9d90adc92
49. https://github.com/openlayers/ol2/issues/127
50. https://github.com/openlayers/ol2/issues/458 ; https://github.com/openlayers/ol2/issues/513
51. https://github.com/openlayers/ol2/commit/4d2fb886 ; https://github.com/openlayers/ol2/commit/5879a71f ; https://github.com/openlayers/ol2/commit/8c6466bf ; https://github.com/openlayers/ol2/commit/da3dc76a ; https://github.com/openlayers/ol2/commit/1e5f8359
52. https://github.com/openlayers/ol2/commit/3ef0b059 ; https://github.com/openlayers/ol2/commit/11191464
53. https://github.com/openlayers/ol2/commit/6ce9feed
54. `rr/Leaflet__Leaflet/CHANGELOG.md` ; https://github.com/Leaflet/Leaflet/issues/1085 ; https://github.com/Leaflet/Leaflet/pull/5148
55. https://github.com/Leaflet/Leaflet/issues/3575 ; https://github.com/Leaflet/Leaflet/pull/8891 ; https://github.com/Leaflet/Leaflet/commit/0392b7f4 ; https://github.com/Leaflet/Leaflet/commit/8483bfa6
56. https://github.com/Leaflet/Leaflet/issues/3765 ; https://github.com/Leaflet/Leaflet/pull/4193
57. https://github.com/Leaflet/Leaflet/issues/1066
58. https://github.com/Leaflet/Leaflet/commit/cf6d32fc ; `rr/Leaflet__Leaflet/src/dom/Draggable.js`
59. https://github.com/tangrams/tangram/blob/master/src/scene/scene.js ; `rr/tangrams__tangram/src/scene/scene.js` ; https://github.com/tangrams/tangram/blob/master/src/styles/points/points.js ; https://github.com/tangrams/tangram/blob/master/src/styles/style.js
60. https://github.com/tangrams/tangram/issues/453 ; https://github.com/tangrams/tangram/pull/583 ; https://github.com/tangrams/tangram/pull/472
61. https://github.com/tangrams/tangram/pull/455
62. https://github.com/tangrams/tangram/commit/acd35493 ; https://github.com/tangrams/tangram/commit/77e436c6
63. https://github.com/tangrams/tangram/pull/454
64. https://github.com/tangrams/tangram-es/pull/1385
65. https://github.com/tangrams/tangram-es/commit/7259be83 ; https://github.com/tangrams/tangram-es/commit/a77e1193 ; https://github.com/tangrams/tangram-es/commit/464d8881
66. https://github.com/tangrams/tangram-es/commit/dbb6420b
67. `rr/heremaps__harp.gl/docs/@docs/fallback/README.md` ; https://github.com/heremaps/harp.gl/commit/0ea1a7ae ; https://github.com/heremaps/harp.gl/commit/0f8617bf
68. https://github.com/maptalks/maptalks.js/commit/a24ef1f82
69. https://github.com/stamen/modestmaps-js/issues/109 ; https://github.com/stamen/modestmaps-js/issues/103 ; https://github.com/stamen/modestmaps-js/commit/96da436 ; https://github.com/stamen/modestmaps-js/commit/dfec3cf ; https://github.com/stamen/modestmaps-js/commit/5ea22cb
70. https://github.com/stamen/modestmaps-js/commit/f03067d ; https://github.com/stamen/modestmaps-js/commit/18d251d ; `rr/stamen__modestmaps-js/src/utils.js`
71. https://github.com/simplegeo/polymaps/commit/86a1b8a ; https://github.com/simplegeo/polymaps/commit/65c6e96 ; https://github.com/simplegeo/polymaps/issues/36 ; https://github.com/simplegeo/polymaps/issues/65
72. https://github.com/vasturiano/globe.gl/issues/35 ; https://github.com/vasturiano/globe.gl/commit/7029fbe
73. https://github.com/iTowns/itowns/pull/584
74. https://github.com/TerriaJS/terriajs/issues/1211
75. https://github.com/TerriaJS/terriajs/pull/7209
76. https://github.com/TerriaJS/terriajs/commit/b456ee2e3
77. https://github.com/TerriaJS/terriajs/commit/479f32bef ; https://github.com/TerriaJS/terriajs/commit/16f82fce8
78. https://github.com/NASAWorldWind/WebWorldWind/commit/2d589d1 ; https://github.com/NASAWorldWind/WebWorldWind/commit/0be0d26 ; https://github.com/NASAWorldWind/WebWorldWind/commit/2043407 ; https://github.com/NASAWorldWind/WebWorldWind/commit/117e9d6 ; https://github.com/NASAWorldWind/WebWorldWind/commit/487a91d
79. https://github.com/NASAWorldWind/WorldWindJava/blob/2543c23/src/gov/nasa/worldwind/symbology/AbstractTacticalSymbol.java ; `rr/NASAWorldWind__WorldWindJava/src/gov/nasa/worldwind/symbology/AbstractTacticalSymbol.java`
80. https://github.com/pelicanmapping/osgearth/blob/master/docs/design/procedural2-plan-history.md ; `rr/pelicanmapping__osgearth/docs/design/procedural2-plan-history.md`
81. https://github.com/pelicanmapping/osgearth/issues/2783
82. https://github.com/mapnik/mapnik/blob/master/CHANGELOG.md (2.0, 2.2, 4.0.6 halo entries) ; https://github.com/mapnik/mapnik/issues/1781 ; https://github.com/mapnik/mapnik/issues/1298 ; https://github.com/mapnik/mapnik/commit/e66d00762 ; https://github.com/mapnik/mapnik/commit/e313b5ba6
83. https://github.com/mapnik/mapnik/blob/master/CHANGELOG.md (2.1, 4.3.2) ; https://github.com/mapnik/mapnik/issues/1409 ; https://github.com/mapnik/mapnik/commit/49c1c15c4 ; https://github.com/mapnik/mapnik/commit/73cfc6e66 ; https://github.com/mapnik/mapnik/commit/d4564c85e
84. https://github.com/mapnik/mapnik/blob/master/CHANGELOG.md (3.0 'premultiplied') ; https://github.com/mapnik/mapnik/issues/1489 ; https://github.com/mapnik/mapnik/issues/1995 ; https://github.com/mapnik/mapnik/commit/751d246f3 ; https://github.com/mapnik/mapnik/commit/327270754 ; https://github.com/mapnik/mapnik/commit/8674e463a
85. https://github.com/mapnik/mapnik/issues/1508 ; https://github.com/mapnik/mapnik/issues/1512
86. https://github.com/mapnik/mapnik/blob/master/docs/line-dashoffset.md ; `rr/mapnik__mapnik/docs/line-dashoffset.md`
87. https://github.com/mapnik/mapnik/issues/477
88. https://github.com/mapnik/mapnik/issues/1316 ; https://github.com/mapnik/mapnik/issues/1866
89. https://github.com/mapnik/mapnik/commit/8b27aba0c
90. https://github.com/mapnik/mapnik/commit/cba876537
91. `rr/MapServer__MapServer/HISTORY.md` (5.0 RFC 32, 5.4.0-beta1 polygon outline, 7.0 RFC 99) ; https://mapserver.org/development/rfc/ms-rfc-32.html ; https://mapserver.org/development/rfc/ms-rfc-99.html
92. https://github.com/MapServer/MapServer/issues/306
93. https://github.com/MapServer/MapServer/issues/179 ; https://github.com/MapServer/MapServer/commit/cbc029d4 ; https://github.com/MapServer/MapServer/commit/f5e1bec9 ; https://github.com/MapServer/MapServer/commit/8b61e099 ; https://github.com/MapServer/MapServer/commit/6a4adf69 ; https://github.com/MapServer/MapServer/commit/d231a752
94. https://github.com/MapServer/MapServer/issues/1243
95. https://github.com/MapServer/MapServer/commit/962fff7a ; https://github.com/MapServer/MapServer/commit/2ab44080 ; https://github.com/MapServer/MapServer/commit/4ceca4cc
96. https://github.com/MapServer/MapServer/commit/212f9794 ; https://github.com/MapServer/MapServer/commit/8d8bcfd6
97. https://github.com/geoserver/geoserver/commit/f4eeb55439 ; `rr/geoserver__geoserver/src/community/vectortiles/src/main/java/org/geoserver/wms/vector/PipelineBuilder.java`
98. https://github.com/geoserver/geoserver/commit/fc024126cb ; https://github.com/geoserver/geoserver/commit/46d2e41946
99. https://github.com/geoserver/geoserver/commit/4b2a4821ba ; https://github.com/geoserver/geoserver/commit/273d6f947d
100. https://github.com/osmandapp/OsmAnd-core/commit/624e907e ; https://github.com/osmandapp/OsmAnd-core/commit/86225532 ; https://github.com/osmandapp/OsmAnd-core/commit/773dbc16
101. https://github.com/osmandapp/OsmAnd-core/commit/a4fbac07
102. https://github.com/organicmaps/organicmaps/commit/173be8d27d90ece935fe3b5a61ec80b1e345f933 ; https://github.com/organicmaps/organicmaps/commit/6af516698e37f6db45fa52879bee3470c2cdb880
103. https://github.com/organicmaps/organicmaps/commit/5c68eefafa1478c497e60408b7f739ad0af1442d
104. https://github.com/mapsforge/vtm/issues/1082 ; https://github.com/mapsforge/vtm/pull/1084 ; https://github.com/mapsforge/vtm/pull/1100
105. https://github.com/osmdroid/osmdroid/issues/1509 ; https://github.com/osmdroid/osmdroid/commit/2424d879
106. https://github.com/galileo-map/galileo/commit/fb02c8a ; https://github.com/galileo-map/galileo/commit/0012cec
107. `examples/02-world-population-mobile/map.ts` ; `examples/03-quake-timeline/quake.ts` ; `examples/04-osm-node-density/density.ts` ; `examples/07-world-cities-hover/cities.ts` (context flags, blend functions, the stencil land fill and the antialiased point rim)
108. `.agents/skills/line-tessellation/SKILL.md` ; `.agents/skills/text-rendering/SKILL.md` ; `.agents/skills/symbols-and-icons/SKILL.md` ; `.agents/skills/tile-lod-and-overzoom/SKILL.md`
