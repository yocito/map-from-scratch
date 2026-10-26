# Antialiasing and blending: per-engine detail

Numbers in brackets refer to the Sources list in [../SKILL.md](../SKILL.md).
Read the section for an engine before copying its approach; read the source
itself before copying code (licences: skills/map-from-scratch/SKILL.md,
Rules).

## deck.gl

- Analytic AA RFC (v9.4): PathLayer, LineLayer, ArcLayer and PointCloudLayer
  gain an `antialiasing` prop, default false. Coverage is
  `(1 - edgeCoord) / max(fwidth(edgeCoord), 1e-6)`, and alpha is multiplied
  by `clamp(edgePixels + 0.5, 0, 1)`; the strip is extended by half a
  device pixel (CSS widths divided by `devicePixelRatio`) so the outer half
  of the ramp is rasterised [1].
- Why not the alternatives: host canvas MSAA is unavailable in Google Maps,
  ArcGIS, offscreen or post-process targets and WebGPU, and MapLibre v5
  moved the option; FXAA/TAA break interleaved shared depth and cannot
  recover coverage, TAA needs several frames; luma.gl's offscreen MSAA does
  not reach interleaved or WebGPU paths; alpha-to-coverage is not mapped in
  luma WebGL and needs a multisampled WebGPU target [1]. A2C was also parked
  because coverage would be counted twice with SRC_ALPHA blending [2].
- Measured on a 2 px diagonal into 240x180: 0 partial-coverage pixels off,
  1,572 on with more than 40 alpha levels; an MSAA canvas gives 1,361 with 3
  levels; the post-process path drops to 0 [1].
- Cost on Apple M1 Max, 3840x2160, WebGL2: PathLayer 100K 1 px strokes
  +0.052 ms (+2.0%); 256 overlapping 64 px strokes +10.8%; ArcLayer 10K
  +0.139 ms (+21.2% of a 0.656 ms baseline); PointCloud 100K +6.6% [1].
- PR 10520: coverage is computed before any `discard`; the multiply must
  precede premultiplication (moving it after raised the worst overshoot
  from 2 to 126); AA on/off are compile-time variants (GLSL define, WGSL
  generated without the snippet) and toggling rebuilds the model; abutting
  segment ends stay hard; enabling it on top of MSAA moved the WebGL golden
  to a 98.28% match [2]. Follow-ups specialised the shaders, added
  `test/bench/antialiasing.html` and discard zero-coverage fringe fragments
  [3].
- Dash prefiltering (PR 10581): the dash square wave is integrated over the
  fragment footprint; rounded dash ends intersect the line's AA envelope
  once (two ramps gave dark shoulders, alpha 55 instead of 109); picking
  keeps a hard test. 100K sparse strokes 2.389 ms plain vs 2.765-2.772 ms
  dashed; 256 overlapping 64 px 0.462 vs 0.662-0.665 ms; a 0.2 px period
  went from mean/stdev 107.7/125.9 to 127.5/0.5 [4].
- Separate alpha blend (`blendFuncSeparate(..., ONE, ONE_MINUS_SRC_ALPHA)`)
  landed for 5.0, was reverted the same day, and returned as opt-in via
  `initWebGLParameters` with a TODO to make it default in the next major
  [5].
- `useDevicePixelRatio` governs drawing and picking together, default
  false; performance docs: Retina 'generates 4x the number of pixels' [6].
- Pattern atlas sampler uses `lodMaxClamp: 0` instead of an invalid empty
  `mipmapFilter`, portable across WebGL/WebGPU, so cells do not bleed [7].

## CesiumGS/cesium

- Draped vector polylines (PR 13675) render at the specified width
  (previously twice) with a half-pixel coverage fade;
  `scene.vectorProvider.antialias = false` turns it off. Baking has no
  camera, so pixel widths are converted to tile UV using the minimum tile
  screen size from the terrain provider (default 256 px); underestimating
  it only widens the clip margin. PR 13703 added `widthUnits` (pixels or
  metres) [8][9].
- Render resolution: 1.18 honoured devicePixelRatio as CSS resolution, 1.61
  switched to native device resolution, 1.62 added
  `useBrowserRecommendedResolution` defaulting to false, 1.66 flipped it to
  true. The context requests `powerPreference: 'high-performance'`. An
  earlier SSE + DPR change was reverted in 2019 without a stated reason
  [10].
- Weighted blended OIT (PR 1412, McGuire and Bavoil) with WEBGL_draw_buffers
  MRT or a multipass fallback: two translucent layers looked almost opaque,
  three opaque; sensors behind sensors were less legible; it broke Android
  and some no-MRT browsers during review; a typo in the redundant-bind check
  (`_currentFamebuffer`) rebound the framebuffer on every draw [11].
- ClippingPolygonCollection dropped its SDF distance texture (and the
  `quality` and `debugShowDistanceTexture` options) for per-tile lookups
  'based on the techniques used for vector tiles'; CHANGES says it 'vastly
  improves quality across distance scales'. PR 13308 had optimised the SDF
  path a few months earlier [12].
- Tile texcoords may exceed [0,1] by 1/10 texel; textures are clipped
  without epsilons; removed black pixels and untextured skirts [13].

## OpenLayers

- WebGL stroke AA ramp moved from 0..-1 px to -0.5..+0.5 px because lines
  came out 1 px thinner than asked (PR 15554) [14].
- Layer opacity < 1: features drawn at full opacity into an intermediate
  canvas and composited once, because colours mixed and opacities stacked
  [15].
- Polygon batching: up to 200 paths per fill/stroke pair; landed 2016-03-30,
  reverted 2016-04-07, re-landed with alpha sniffing, replaced by the
  `overlaps` source option on 2016-04-18. Rejected: always batching
  (translucent overlaps lose additive opacity, strokes go under neighbours'
  fills), the 'opacity guessing game'. A downstream team reported a 'very
  positive result'; an IE11/Edge user with non-topological data saw little
  gain and bugs. Maintainers pointed to `renderBuffer` as a bigger win [16].
- Vector tiles replayed into per-tile canvases and composed with
  `drawImage`; rotated views clip with a 1 px buffer; direct replay is used
  while zooming or rotating, later gated by rendered tile size because high
  `tilePixelRatio` images 'trouble the browser'. Reason: anti-aliased clip
  paths leave gaps between tiles [17].
- 5.2 removed per-style `snapToPixel`; the renderer snaps only when idle.
  4.3.3 reverted fractional overlay positioning [18].
- iOS 12 Safari: a rotated (non-axis-aligned) clip made `drawImage` 99%
  slower ('93x'); iOS 11 rotated 44% slower; axis-aligned 22%; desktop
  unaffected. OpenLayers kept the clip and filed a Safari bug; still
  reported in 6.2.1 [19].

## podusowski/walkers

- Segments drawn half a pixel wider, margin faded in the shader as egui
  feathers, instead of MSAA; sub-pixel roads still look thin [20].

## maplibre/maplibre-rs

- Line pipeline extrudes in clip space by `line_width/2` plus a 0.5 px AA
  outset, multiplied by `w` to undo the perspective divide, per axis for
  non-square viewports; replaced lyon stroke tessellation in tile units [21].
- All transparency removed 'because it should be solved separately';
  issue 252 proposes WBOIT, still open [22].
- Checkerboard stencil by tile x/y parity (4 values) was used early and
  dropped; TileViewPattern now gives each tile its own stencil value, which
  also covers parent/child fallbacks [23].
- PR 340 (unmerged): premultiplied blending for translucent fills, readback
  converted to straight alpha before PNG comparison; 203 tests and 19 globe
  fixtures pass on Apple M3 Max/Metal [24].

## MapLibre GL JS

- PR 7490: constant `line-opacity` strictly in (0,1) is drawn opaque
  offscreen and composited once. Zoom/data expressions were left unfixed
  (would need MRT/WebGL2). 50 line layers at 0.5: 3x slower at first,
  1.95x later; standard benches never hit the path. Stencil masking was
  tried: first-drawn feature wins, semi-transparent patterns write stencil,
  SDF edges show artefacts; removing the tile stencil caused tile-edge
  artefacts. Mapbox GL had the same offscreen approach and removed it for
  performance (#523, #4090). Users who relied on overlaps adding up (GPS
  track density) lose that unless alpha goes into `line-color` [25].
- 6.0 reverted the automatic trigger (#7764); the fix is now behind a
  separate `line-layer-opacity` property [26].
- PR 1191 (per-layer fill opacity via offscreen framebuffer) was open
  2022-2026 and closed stale; a single screen-size framebuffer does not fit
  terrain, unlike hillshade's per-tile FBOs [27].
- highp for symbol vertex shaders and SDF gamma; lowp gamma aliased large
  fonts on mobile; iOS precision bugs (#750) [28].
- SDF halo and glyph in one pass (-40% symbol time); a separate halo pass
  remains for overlapping glyphs (negative letter spacing, very wide halos)
  [29].

## MapLibre Native

- Fill AA outlines drawn with depth test `LEQUAL` so they do not overlap and
  double-blend with neighbouring fills (mapbox-gl-native #381) [30].
- `MLN_TRIANGULATE_FILL_OUTLINES = 1` on Metal and WebGPU: fill outlines
  become line-bucket triangles drawn with the line shader; GL keeps 1 px
  `gfx::Lines` [31].
- Raster tiles and image sources upload the decoder's premultiplied image
  and un-premultiply in the shader, saving a CPU pass [32].
- Nearest icon filtering during pure pans landed with a render test and was
  reverted without a stated reason [33].

## maplibre/navara

- Draped vector features bake through one shared multisampled target and
  are copied into plain 512x512 targets per slot. Per-tile multisampling
  quintupled every drape target's footprint, starved the tile budget and
  stalled terrain refinement. The resolve copy un-premultiplies; textured
  materials must be forced to blend, else edges darken (or brighten by
  1/alpha) [34].
- Per-feature opacity lives in a batch texture; translucent instances in
  one InstancedMesh occlude each other wrongly. CPU sort is impossible
  (renderOrder is per mesh); depth-then-colour dual pass doubles GPU work.
  Point and text edges use gradient alpha that looks wrong with
  `transparent=false` [35].
- Bloom: forked UnrealBloomPass replaced by a mipmap blur with a soft
  threshold; square halos and threshold flicker gone; brightness drops
  about 3x so strength must rise 2-3x [36].

## opengeos/RustGIS

- Stencil-clip each vector tile mesh to its square; without it buffered
  fills blend twice and casings cover neighbours' roads; parity test had
  48k outlier pixels; GPU vs CPU mean diff 1.5/255 [37].
- CPU renderer: markers stamped from a quarter-pixel sprite cache (1,024
  sprites of reach <= 24 px, about 10 MB); sub-pixel lines and polygons
  splat coverage instead of going through tiny-skia (about 1 us per path,
  5 us per point path). 100k points 10-14x faster than 600 ms; rings
  clipped to a box after a tiny-skia panic far zoomed in [38].

## ortho-earth

- WebGPU: 1x during camera moves, animations and clock-driven updates; one
  4x MSAA frame after 500 ms still; 1x/4x pipeline sets built lazily
  (sampleCount is baked into pipelines). Shadow-time replay counted as
  'still' took gpuMap from 10 to 21 ms (38 fps). With MSAA off, dynamic
  resolution stopped dropping. `?msaa=1` keeps always-4x [39].
- Dynamic resolution by GPU time (EXT_disjoint_timer_query, normalised by
  resolution squared), wall-clock fallback on Safari. A 30 Hz monitor read
  33 ms and sank resolution to 0.55 at 3.7 ms GPU time; idle detail at
  256 px caused ~10 s redraw bursts on an M1 (68 to 106-149 ms) [40].
  Licence: GPL-3.0-or-later; do not carry its code into non-GPL work.

## QGIS

- XYZ tile destination rects in integer maths, always expanded; removed
  <= 2 px gaps [41].
- Selective masking: label buffers and mask symbol layers drawn into an
  alpha-only mask image, masked layers re-rendered and composited; one set
  of masked layers per layer. About 8k lines; features iterated twice; PDF
  exports flattened and rasterised; parallel rendering flashed white for
  ~30 s. QEP 186 (PR 47459) records mask shapes as QPainterPath in pass 1
  and clips pass 2 to keep PDF/SVG vector, with a raster fallback per layer
  when paint effects are involved [42].
- Control images with per-pixel tolerance masks (white ignore, black exact,
  grey = max deviation) replaced fragile anomaly images [43].
- Map-to-pixel simplification (#8725): disabling AA measured 87.8 to 86.1 ms
  (2%), 12.4 to 11.0 (12%), 109.8 to 77.3 (30%), but the difference was
  visible, so AA is disabled only for about-one-pixel geometry and only
  when the simplification factor is raised [44].
- Early (provider-side) raster resampling by GDAL at read time (PR 37044):
  no subpixel shift against other layers, stable across refreshes; cost
  harder pixel edges, odd nodata edges, and zoomed-out smoothing needs
  oversampling 15-16 vs 2; opt-in [45].
- 2D point clouds: `fillRect` squares, AA off, 'orders of magnitude faster'
  [46].

## OSGeo/grass

- Transparent cells over opaque ones were wrong until pixels were written
  in cairo's premultiplied form (2010) [47].

## KDE/marble

- A 99% transparent full-screen routing overlay was repainted, uploaded and
  blended every frame: 3 fps on a tablet at level 17, ~30 fps once hidden;
  later converted to a QQuickItem [48].

## OpenLayers 2

- Fade-in tiles: `transitionend` never fired without an app CSS rule, so the
  back buffer was never removed; replaced by a timeout (800 ms still
  flashed, 2,500 ms rarely) and the JS option dropped [49].
- Seams traced to sub-pixel `left` values (235.983 px placed at 235 vs 236);
  settled views fixed, animated seams accepted [50].
- Back-buffer zoom transitions discouraged on non-opaque layers and removed
  from labels; removal delay configurable, 0 for single-tile layers [51].
- Canvas hit detection by colour-ID; antialiasing on the hit canvas 'can't
  be turned off', so a try/catch guards illegal ids [52].
- `externalGraphic` positions rounded before `drawImage` to stop Gecko blur
  (#3305) [53].

## Leaflet

- Rounding at the drawing step: panBy (#1085), pan toward zero (#5858),
  animated pan (#4046), circle radius moved from layer to renderer (#5859),
  Canvas redraw areas (#5148), tooltips (#5089) [54].
- Issue 3575 (2015, 200+ comments): 1 px or 0.5 px oversize blurred and
  stretched tiles and broke `maxNativeZoom` overzoom; NoGap stitching was
  'really slow' and snapped pinch zoom; `L_DISABLE_3D` flickered. Chromium
  engineers: per-tile layer scaling inherently hits coincident-edge AA;
  rasterise once then downscale. 2023 fix: `mix-blend-mode: plus-lighter`
  on `.leaflet-tile` (#8891), narrowed to `img.leaflet-tile` (#8907) two
  weeks later; gaps remain at page zoom != 100% [55].
- Parent tiles kept until children load; prune ran before fade-in marked
  tiles active, so old-zoom tiles stayed forever (9/10 repro with
  `zoomIn(4)`); fixed in #4193 [56].
- Zoom-animation seams (Firefox, Safari, Mozilla 757870/504071) declared
  'not possible to fix on the Leaflet side' [57].
- Drag positions snapped with `round(x * dpr) / dpr` (#10445), with a test
  [58].

## tangram

- Translucent proxy tiles drawn per proxy level with a stencil mask; points
  and text set `stencil_proxy_tiles=false` because transparent pixels write
  stencil and cut out [59].
- Label/sprite quads snapped to the pixel grid only when the view is still
  (always snapping shimmered on slow pans); fill and outline of points in
  one quad with one `length()` and no branch, quad enlarged for edge
  pixels; a '+1 px to balance antialiasing' outline bump removed [60].
- Tiles drawn unclipped with no stencil: lines align across tiles without a
  buffer, but translucent polygons in buffered tiles double at edges
  (#469); depth write with alpha refused because draws are regrouped by
  tile, program and blend [61].
- Add and multiply blends drawn after opaque styles, before overlay, as
  order-independent approximations [62].
- CPU rounding of label positions (PR 454) closed: 'view matrices will
  shift things off the pixel grid anyway' [63].

## tangram-es

- iPhone 6S Plus: ~6.3 to ~3.8 ms per frame with VAOs, fragment work moved
  to vertices, MSAA and stencil off on iOS (MSAA kept as an option); one
  shader 3.59 to 1.55 ms. The VAO path ran on devices without VAO support
  and crashed one Galaxy S3 Adreno driver [64].
- Translucent styles: depth-only pre-pass, then colour with `EQUAL` depth
  and stencil `EQUAL 0, INCR` so each pixel is drawn once; context requests
  an 8-bit stencil [65].
- `glDepthMask(false)` for add and multiply [66].

## harp.gl

- `allowOverlappingTiles=false` for transparent sources; overlapping
  fallbacks 'manifest as flickering'; ground planes removed from GeoJSON
  and feature sources because they hid fallbacks [67].

## maptalks.js

- Dashed Canvas 2D strokes clipped to the viewport plus 3 px before
  `setLineDash`, because dash cost grows with the whole path length; skipped
  when the geometry is already in view [68].

## modestmaps-js

- One `matrix3d` per level during interaction (Feb 2012) was faster and
  meant to end seams, but produced white seams in Safari while dragging;
  master was reverted and the work moved to a branch [69].
- `scale*width` made an integer ('Eliminate white lines'); offsets rounded,
  fractional only while moving: 'pixel-perfect when stopped' [70].

## polymaps

- Tile centre rounded only at integer zoom, zero angle and no transform; a
  Firefox rounding tweak rolled back because Firefox positions the SVG at
  subpixel offsets itself and the tweak broke WebKit [71].

## globe.gl

- Arc lines switched from additive to normal blending (three-globe 2.16.2):
  additive arcs were invisible on white backgrounds [72].

## iTowns

- Transparent colour layers premultiplied in texture and shader; white
  border fringes disappeared [73].

## TerriaJS

- Tippecanoe `--no-polygon-splitting` removed stray lines from stroked
  polygons split above 700 vertices [74].
- COG `bilinear` default; still pixelated next to OpenLayers on the same
  file [75].
- Thick polygon outlines drawn as polylines because WebGL line width > 1 is
  unsupported on Windows [76].
- Leaflet tiles sized `tileSize + 0.5 px` on `tileloadstart`, moved from a
  global CSS rule into the layer classes the same day [77].

## WebWorldWind

- Outgoing-tile fade: flashing, fallbacks fading when their replacement
  failed, and double opacity were fixed in December 2015, then fading was
  disabled when layer or surface opacity < 1 [78].

## WorldWindJava

- Tactical symbol textures premultiplied; alpha test `GREATER 0` in normal
  and pick rendering; pick lines widened to 9 px; depth tested, not
  written, with polygon offset [79].

## osgEarth

- LOD cross-fade with A2C: parent min(1, 2(1-t)), child min(1, 2t);
  complementary ramps kept about 68% of reference colour coverage at the
  midpoint; the fix stays within 1.5% [80].
- PointSymbol `smooth=true` vanished under QOpenGLWidget until a 3.3 core
  context was requested (RTX 3070 Ti, 3.7.1); point rasterisation shape is
  undefined in some configurations [81].

## Mapnik

- `text-halo-rasterizer=fast` (2.2), automatic below radius 1; 'full' for
  AGG text only returned in 4.0.6; the benchmark switched to fast because
  it 'doubles perf'; the grid renderer dropped the FreeType stroker [82].
- Style-level comp-op and filters render into per-style buffers (2.1);
  4.3.2 composites and clears only painted regions, but reused buffers kept
  pixels from child layers and image filters until d4564c85e [83].
- Whole rasteriser premultiplied (2012, #1262); markers premultiplied once
  before caching; `premultiplied` flag on images in 3.0 after bugs #1489,
  #1541, #1995, #2011 [84].
- Grey fringes under bilinear scaling: AGG filters output premultiplied and
  the renderer premultiplied again; fixed for agg and cairo gdal input [85].
- LineSymbolizer 'fast' rasteriser has no dashes; `stroke-dashoffset`
  works only with 'full' [86].
- png256 with one octree per alpha range, 4 levels by default (2 = binary),
  ~10% more encode time and size; at least 12 colours reserved after an
  infinite loop below 8 [87].
- Unscaled raster and SVG markers snapped to integer pixels; extended to
  shields; scaled icons can still blur [88].
- `warp_image` writes reprojected mesh faces with `comp_op_rgba_src`
  because AA face edges seamed on transparent rasters; works only while
  faces do not overlap [89].
- SSE2/NEON source-over span blending, tested against scalar AGG and
  against bypassing custom blenders; about 340 lines [90].

## MapServer

- GD and AGG backends side by side from 5.0 (RFC 32) until GD removal in
  7.0 (RFC 99), with GD/AGG alpha conversions in between. 5.4 stopped
  drawing a hidden same-colour outline around polygons [91].
- 8-bit GD output pre-allocates style and label colours of active layers,
  because rasters and AA text used up the palette and later colours were
  remapped at random [92].
- Polygon clip rectangle padded 2 px (1 px was not enough) so Liang-Barsky
  degenerate edges fall off-image; a degenerate-edge cleaner caused
  polygon flooding; buffer later sized from every style, +2 px for
  polygons, kept in double precision, expanded for offsets [93].
- Halo: 8 offset redraws (4 left gaps in 'i' and 'l'), then a stroked
  outline in AGG, a couple of percent faster; the GD stroker route closed
  [94].
- Hatch lines generated over the feature bbox and ANDed with the polygon
  (AGG scanline boolean, Clipper elsewhere), replacing an image-sized
  pattern tile [95].
- Per-style `ANTIALIAS` for lines via `renderer_scanline_bin_solid`,
  replacing a build-time aliased path [96].

## GeoServer

- Vector tiles clipped 12 px outside the tile, as the streaming WMS
  renderer does, so clip lines on polygons stay off the tile [97].
- PNG8: octree for opaque, RGBA median cut when transparent, overridable
  [98].
- Multi-layer requests stacked from per-layer cached tiles unless labels or
  blending are involved; png8 members are quantised twice and lose AA edges
  [99].

## OsmAnd-core

- Mipmap LOD for the pitched raster map computed per vertex from distance
  and camera elevation; EXT_shader_texture_lod made optional on GLES2 [100].
- Billboard icons snapped: anchor floored plus 0.5 for odd sizes, vertices
  rounded [101].

## Organic Maps

- Hatching and stipple/speckle/grid fills computed with `fwidth` on a
  world-anchored lattice; 13 mask PNGs and their loader removed; no shimmer
  at fractional zoom, continuous across tile seams (#12804) [102].
- Subway layer no longer forces the post-process AA: 'Enabling anti aliasing
  destroys performance on some Android devices' [103].

## mapsforge/vtm

- Translucent lines: depth cleared and depth test with writes per
  non-opaque line bucket so each pixel is written once; global flag first,
  per-style `transparent` option later (#1100); miter spikes remain [104].

## osmdroid

- Pooled bitmaps erased to transparent before drawing approximated tiles;
  stale tiles had appeared over empty sea under a transparent overlay
  (fixed in 6.1.6) [105].

## galileo

- Textures and surface switched from sRGB to plain RGBA because images are
  decoded as standard RGBA; blending happens in gamma space [106].
