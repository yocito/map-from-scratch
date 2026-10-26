---
name: raster-tiles
description: How 42 map engines draw raster tiles without seams, edge artefacts, flicker or runaway texture memory - tile placement and pixel snapping, kernel borders for hillshade and resampling, reprojection, ancestor fallback, browser decoding, GPU texture pools, tile size and DPR, and the payload codecs, no-data masks and COG range reads of baked rasters. Load it when a map-from-scratch renderer draws XYZ/PMTiles image tiles, a COG or GeoTIFF, terrain-RGB/DEM or hillshade, a georeferenced image overlay, or vectors rasterised into tiles, and before writing that renderer's bake.ts, texture code, or seam and fallback checks.
---

# Raster tiles: seams, borders, fallback, decoding and texture memory

Drawing raster tiles looks like the easy part of a map: fetch z/x/y images and
put each on a quad. The engines show where it goes wrong. Tiles placed at
fractional pixels leave 1-2 px gaps [1][2]. A kernel (resampling,
slope, hillshade) run per tile shows the tile grid [3][4].
Reprojecting at run time blurs the image and costs load time [5]. Missing
tiles flash blank during zoom [6]. Decoding images on the main thread
costs 20-30 ms per tile [7], and unbounded texture pools grow VRAM during
fast zoom and pan [8]. Each engine paid for its fix in code, memory or
extra draws. A purpose-built renderer can often move the fix to bake time,
where a general engine cannot. This skill lists the decisions by sub-problem;
per-engine history and numbers are in
[references/engines.md](references/engines.md). The repository's own rules
(bake at bake time, budgets, functional checks) are in
`skills/map-from-scratch/SKILL.md` [9]. Neighbouring skills go deeper on
DEM encoding and shading (`terrain-and-elevation`), parent/child level choice
(`tile-lod-and-overzoom`), byte-range layouts (`data-range-requests`) and edge
antialiasing (`antialiasing-and-blending`).

## 1. Placement: seams between tiles

- **Compute every tile edge from origin + integer index, in one step.** OL2
  walked the grid with `+=` float steps; the same tile got different BBOX
  strings (cache misses offline on Mobile Safari) and 1 px white seams. Rounding
  the BBOX to a fixed precision did not fix it; computing positions from the
  origin and row/column did [2]. OpenLayers places tiles at
  `round(origin - i*dx)` and takes the width from the next edge,
  `round(origin - (i-1)*dx)`, instead of rounding x and x+w separately
  [10]. QGIS computes XYZ destination rects in integers and always expands
  them to the nearest pixel instead of shrinking them, after visible gaps of up
  to 2 px [1].
- **Snap the translation to device pixels when at rest.** Leaflet multiplies
  the drag position by devicePixelRatio, rounds and divides back, because a tile
  edge in the middle of a device pixel is drawn half transparent on both sides
  [11][12]. MapLibre keeps a second, pixel-aligned projection matrix
  (half-pixel shift for odd viewport sizes) used only for rasters, which makes
  them crisp at 0/90/180/270 degree bearings [13]. Polymaps rounds only
  when zoom fraction, rotation and layer transform are all zero [14].
- **Composite tiles into one surface, not one layer per tile.** Seams between
  DOM tiles at fractional scale come from the compositor antialiasing each tile
  edge on its own; Chromium engineers suggested rasterising the whole map at
  scale 1 and downscaling it as one image [15]. OpenLayers draws tiles
  straight onto the map canvas and rotates the composed frame once: fast zoom
  went from 30 to 50-60 fps and rotation no longer shows seams [16]. Per-tile
  3D transforms each made a separate render surface in Leaflet, and were removed
  [17]; so was `will-change` on tiles, to cut memory [18].
- **Globe or curved meshes with mixed zooms:** MapLibre draws every raster tile
  without borders while marking the stencil, then again with stretched borders
  only where the stencil is unmarked. Seams and double-blended pixels disappear;
  every tile is drawn twice [19]. Beyond 85.05 degrees it stretches the
  edge row to the pole rather than invent data, and accepts the artefacts
  [19][20].

## 2. Borders for any per-tile kernel

- **Read neighbour pixels for the kernel radius.** QGIS buffers raster block
  reads by the resampling kernel's radius to remove artefacts at tile edges
  [3][21]. MapLibre DEM tiles carry a 1 px border that is
  backfilled from neighbouring tiles when they arrive [22]; the backfill
  flags the tile so its DEM texture is uploaded again [216]. Navara builds 256x256 normal maps from 258x258 backfilled DEMs
  [23].
- **1 px is not enough if the result is then filtered.** A MapLibre Native PR
  measured seam/control luminance of 1.65x (horizontal) and 1.98x (vertical) at
  overzoom: bilinear filtering pulls the next-inward, tile-local texel across
  the seam. A 2 px border was not enough; 3 px plus ghost texels in the prepare
  pass fixed it for about 2% more DEM memory. The PR was closed unmerged (AI
  policy, suspected over-complexity) [4]. Rule: border >= kernel radius +
  filter footprint.
- **Shade once per tile, not per fragment per frame.** Navara went from vertex
  normals (seams at tile edges) to per-fragment Sobel on the DEM (9 samples per
  fragment per frame) to a normal map baked once per tile and quantised to 8
  bits (one lookup) [24][23]. Faint seams stayed at about z14 and were
  reproduced with two plain textured planes, so they come from edge sampling in
  general [23].

## 3. Resampling and reprojection

- **Draw tiles in their own projection; do not reproject on load.** Cesium
  stopped reprojecting Web Mercator imagery to geographic on load and got both
  better images and slightly faster loads [5][25].
- **If you must reproject, warp once, on data values, aligned to the output
  grid.** QGIS's "early" resampling in GDAL at read time removed a sub-pixel
  shift against other layers that the old resample-after-colouring path caused,
  and made resampling stable across refreshes. It costs computation, gives hard
  pixel edges and odd nodata edges, and needs oversampling of 15-16 for smooth
  zoomed-out output, so it stayed opt-in [26][27]. Resampling of
  reprojected rasters only works through that path; the stated proper fix is to
  resample inside the projector, like gdalwarp [26][28].
- **Run-time warping, when unavoidable: an error-bounded mesh.** OpenLayers
  triangulates the target extent, transforms vertices exactly with the inverse
  transform only, and subdivides until the error is under 0.5 px
  [29]; binary instead of 4-way subdivision and cached transforms saved
  30-35% of transform calls [30][31]. It now reprojects on the GPU
  with float32 interpolation, scaling the stitched source down to fit
  MAX_TEXTURE_SIZE [32][33]. openglobus replaced a two-corner window
  stretch (seams on UTM COGs) with a grid of up to 64 projected nodes refined
  to 0.25 tile pixels of error [34][35][36]. ortho-earth wraps
  each Mercator tile on a 16x16 grid mesh (32 below z4) with v computed on the
  CPU, so no CRS math enters the shader [37].
- **Four arbitrary corners need projective texture coordinates.** Two affine
  triangles show a diagonal seam; MapLibre passes homogeneous coordinates and
  divides per fragment, and rejects concave or self-intersecting quads [38].
- **Value tiles (DEM, classes) are sampled NEAREST.** OpenLayers data tiles
  default to `interpolate: false` so style expressions see raw values [39];
  linear filtering of float textures needs OES_texture_float_linear, with a
  NEAREST fallback [40].

## 4. Fallback while tiles load

- **Ancestor stands in, cached children draw over it.** RustGIS found that when
  zooming in the intermediate zooms are missing but the destination's tiles
  are cached, so drawing only the ancestor blurred the whole view [41].
  OpenLayers keeps old tiles until replaced, aligns lower-resolution fill and
  draws only the uncovered remainder of lower levels [39][42][43];
  it skips the fade-in when a fallback is visible [44]. Leaflet keeps
  several levels and uses different bounds for pruning than for loading
  [6][45].
- **Per layer, never wait for the slowest.** Cesium renders a tile with its
  parent's imagery for any layer still loading [46]; reordering
  terrain/imagery loads cut load time 25%, a later rework loaded 33% faster with
  33% less data [47][48].
- **Signal "no data" as a miss.** reearth-papers returns 404, not 204 or a
  transparent tile, so MapLibre overzooms the parent [49][50]. Cesium
  detects Bing's missing tiles by empty response instead of decoding a
  placeholder and comparing pixels [51].
- **One rounding rule for the tile zoom, used on every path.** Leaflet rounds
  fractional zoom to choose `{z}`; a redraw path that forgot it fetched the
  wrong level [52][53]. Overzoom past the source's native maximum is
  cheap (a parent lookup) but had edge cases for years [54][55].
- **Changing parameters (a time slider):** keep a short, pruned chain of
  outdated versions per tile and draw the most recent loaded one; OpenLayers'
  first chains passed 70 tiles per tile until pruning kept them to 2 [169],
  and the later linked list stays under 3 in practice [56].

## 5. Fetch, decode, upload

- **Let the browser decode.** RustGIS decoded in wasm on the main thread at
  20-30 ms per tile; `createImageBitmap` removed decoding from the profiles
  [7]. maplibre-rs waited for wgpu's `copyExternalImageToTexture` rather
  than ship a decoder [57][58].
- **Worker decoding is not a free default.** maptalks turned on fetch +
  `createImageBitmap` in a worker, turned it off by default two months later,
  keeps it off on Safari and iOS WeChat, and now calls `createImageBitmap` on the
  loaded `<img>` [59][60][61][62]. Cesium reverted a newer
  `imageOrientation` value because support cannot be detected [63][64].
- **Do not trust canvas readback for data.** Safari private browsing perturbs
  `getImageData`, which broke terrain-RGB decoding; MapLibre detects it and
  reads through a VideoFrame instead, at 0.5-1 ms per 512 px tile on desktop
  and 5-10 ms on an iPhone 14. The same change also fixed terrain spikes in
  Brave (PR comments) [65].
- **Pixel access requires CORS from the tile server** [66][67].
- **Throttle requests in flight** (`maxParallelImageRequests`) [68][69].
- **GPU-compressed textures** when downloads dominate: a 22.1 kB PNG became a
  3.6 kB ETC1S KTX2, at the price of a wasm transcoder in a worker, sizes in
  multiples of 4 and power-of-two textures for REPEAT on WebGL1 [70].

## 6. Texture memory

- **A fixed texture-array pool with paced uploads.** RustGIS put tiles in 2D
  texture arrays grown in 16 MB chunks up to 128 MB in the browser, LRU reuse
  that never evicts a tile drawn this frame, at most 8 uploads within 4 ms per
  frame in the browser, and one instanced draw per chunk. Frames over 100 ms
  went from 23-25 to 0, p95 from 50-67 to 16.8 ms, wasm memory from 164-219 to
  128-132 MB [71][72].
- **Cap every pool, or have none.** MapLibre capped its reusable texture pool
  after unbounded VRAM growth [8]. Cesium removed its imagery texture
  pool: mixing mipmapped and non-mipmapped textures gave stale mips in Chrome,
  and the gain was small [73].
- **One cache, owned by whoever owns the GPU memory.** The OpenLayers WebGL
  tile renderer keeps its own texture cache instead of the source's [74];
  iTowns gives raster sources a no-op cache because the layer already holds the
  texture [75].
- **Several layers on one surface: composite once, sample once.** Navara bakes a
  tile's overlays into an atlas offscreen, only when dirty, and samples it with
  3 lookups, about 10 fps more [76][77]. iTowns moved per-layer tile
  textures into texture arrays after a 15-sampler cap rejected extra layers
  [78]. iTowns abandoned a run-time power-of-two atlas: committed VRAM went
  from 191 to 276 MB [79].
- **Premultiplied alpha** removed white fringes on transparent layers [80].

## 7. Tile size, DPR, resolution and format

- **Serve the tile size the style was made for, and let the client honour it.**
  Downscaling 512 px renders to 256 px halved every label; a hardcoded
  `tileSize: 256` in the viewer silently did the same [81][82].
- **A zoom+1 tile is not a @2x tile:** it halves the labels baked into it, which
  is why Leaflet's `detectRetina` is off by default [83][84].
- **Make DPR an explicit parameter in headless benches** [85].
- **Coarser data is a choice, priced in bytes and requests.** protomaps-leaflet
  dropped its one-level-coarser default to match MapLibre at the cost of about
  4x the data per view [86]. For a terrain normal-map raster, serving 256 px tiles
  drawn at 512 used fewer bytes (407 KB) than `zoom_offset` (488 KB) though
  more requests (6 vs 2) [87].
- **WebP for rendered map imagery, lossless where values matter:** 213 KB WebP
  vs 256-287 KB PNG for the same tile at similar encode time [88].
- **Pre-bake low zooms.** One global overview COG serves reearth-papers below
  z8, where a tile would otherwise touch up to ~900 source COGs [89].

## 8. Bytes of a baked raster

- **Compress chunks independently and store a chunk raw when that is smaller**,
  with an offset table for random access [90][91].
- **Pick a codec for decode speed and record it per blob.** GRASS went RLE ->
  zlib (level 1) -> ZSTD, which compresses up to 4x faster and decompresses
  about 6x faster than zlib; BZIP2 only wins on rasters wider than 10,000
  columns [92][93]. Its hand-written 3D RLE was wrong above 129,032
  and was removed rather than fixed [94][95][96].
- **Narrowest integer width for classes** (1 byte for 0-255) [92];
  **quantise displayed floats** to the precision the screen shows, never data
  that will be computed on [97].
- **No-data: a separate mask, never a valid value.** GRASS replaced zero-as-null
  with a null bitmap compressed with LZ4, and tests float null with `x != x`
  rather than an exact NaN bit pattern [91][92].
- **Tiles of 32-128 px, powers of two, for scattered access** [98].
- **Bounds-check every length read from the payload**, even self-produced
  [99].
- **8-bit RGB on raw arrays:** QGIS's byte fast path halved time per tile, 40 to
  20 ms [100].

## 9. COG and other range-read rasters

- RustGIS reads the header, then by range the tiles of the overview each part
  of the view needs; strip-organised files are downloaded whole [101][102].
- **Grow header reads geometrically.** Fixed 256 KB steps stopped at about 3 MB
  and refused a 4 MB index of 346,092 tiles; doubling fixed it [103].
- OpenLayers reads strip-organised GeoTIFFs whose strips are under 256 px high
  as 256x256 tiles instead of one-row tiles [104], and fetches only the bands a style uses, since every band must
  load before rendering [105].

## 10. Vectors rasterised into tiles

- RustGIS draws vector tiles once into cached tile pictures, cut past each
  picture by each layer's reach (at least 16 pt): panning 5-13 ms per frame on
  the GPU vs 220-410 ms rasterising every redraw [106].
- Labels baked into tiles rotate with the view and are cut at tile edges;
  OpenLayers removed that mode and kept fills and lines as images with labels
  as vectors [107][39].
- Vectors draped as texture lose their identity: picking needs the source
  geometry [108][109].
- Map terms can constrain compositing: Google tiles force opacity 1 for every
  tile layer in reearth-visualizer [110][111].

## 11. Untiled georeferenced images

- **Put the image into the tile grid, or every tile-local stage misses it.**
  On MapLibre terrain an image source in one tile vanished where it spilled
  into neighbours (reported 2022, fixed 2025). The fix tags tiles with the
  image's overlapping tiles so each terrain tile draws the whole image; an
  on-demand pyramid was rejected as complex, and an upfront one is impossible
  when the landing zoom is unknown [117].
- Tangram cuts untiled images into per-zoom raster tiles with Canvas
  `drawImage`, one texture per tile whatever the image count (280 drone images
  in one case), avoiding problems seen above 2048x2048 on an iPhone 6; the cost
  is CPU compositing, which Tangram ES would not pay in binary size [198].
  Such tiles are not kept from nearby zooms and are rendered once per scene
  generation [199][201].
- A purpose-built renderer knows the image at bake time: tile it there, at the
  displayed resolution, in the target projection [198][150].

## Tried and reverted

| What | Why it was dropped | Ref |
| --- | --- | --- |
| 1 px oversized tiles, NoGap single canvas, disabling 3D | blur and broken overzoom; slow; flicker. Leaflet settled on `mix-blend-mode: plus-lighter` on `img` tiles | [15][112][113] |
| Firefox-specific tile rounding (polymaps) | new artefacts in WebKit; Firefox places the SVG at sub-pixels anyway | [114] |
| Per-fragment Sobel hillshade (navara) | 9 samples per fragment per frame; replaced by a baked normal map | [23] |
| One shader slot per overlapping tile (navara) | overflowed the slot budget with 3 or more layers; replaced by an offscreen mosaic | [77] |
| Imagery texture pool (Cesium) | stale mips, little gain | [73] |
| Run-time tile atlas (iTowns) | +85 MB VRAM, Chrome canvas leak | [79] |
| Worker image decoding by default (maptalks) | server and browser dependent | [60][61] |
| Whole-tile `image` render mode with labels (OpenLayers) | labels rotate, scale and get cut | [107] |
| Hand-rolled RLE (GRASS 3D) | corrupt above 129,032 | [95][96] |
| Reprojecting imagery on load (Cesium) | worse quality, slower | [5] |

## Guidance for a renderer in this repository

The repository bakes everything it can and measures what reaches the screen
[9]. For raster tiles that means:

1. **Bake in the target projection and the target tile grid.** Then the
   renderer never reprojects (section 3). Mercator imagery on a sphere is the
   exception: a CPU-side uv grid of about 16x16 per tile [37] is enough.
2. **Bake kernels across tile boundaries.** Hillshade, slope and resampling
   computed on the whole raster (or with a halo >= kernel radius + filter
   footprint) have no seams to fix at run time [4][115]. Skip the
   neighbour backfill machinery entirely.
3. **Place quads from integer (z, x, y) in one expression**, snap to device
   pixels at rest, and draw all visible tiles in one pass into one surface
   [10][13][16]. With a WebGL2 texture array and instancing this
   is one draw call [71], matching the "one draw call" pattern in
   `patterns.md` [116].
4. **Fallback = ancestor sub-rect + cached children on top**, with one
   zoom-rounding function [41][52]. If the request has a fixed zoom
   range and a small area, preloading all tiles removes fallback altogether.
5. **Decode with `createImageBitmap` on fetched blobs**, upload a bounded
   number per frame into a pool with a byte budget [7][71]. Value
   rasters go in a non-image binary (quantised, mask separate, chunked with a
   codec id) so nothing passes through a canvas [65][91].
6. **Skip what the request does not need**: no stencil double pass without a
   globe [19], no reprojection mesh when baked in the target projection,
   no multi-layer atlas with a single layer [76], no DPR tile switching if
   tiles are baked at the device's resolution.

Functional checks worth adding to `verification.checks`: read pixels along a
vertical and a horizontal tile edge at rest and at a fractional zoom and fail
on background colour (seams); compare a hillshade edge column against its
neighbours (kernel seams, as in [4]); after a fast zoom-in, check that no
viewport quadrant shows only the ancestor level; and count GPU texture bytes
against the budget after a long pan path.

## Sources

1. ref-repos/qgis__QGIS/ChangeLog:53370 (2025-04-22 Fix visible gaps in between xyz tiles)
2. https://github.com/openlayers/ol2/issues/587
3. ref-repos/qgis__QGIS/ChangeLog:291328 (2019-11-08 Fix rendering artifacts on edges of resampled raster tiles)
4. https://github.com/maplibre/maplibre-native/pull/4280
5. https://github.com/CesiumGS/cesium/pull/4339
6. https://github.com/Leaflet/Leaflet/pull/2382
7. https://github.com/opengeos/RustGIS/pull/630
8. https://github.com/maplibre/maplibre-gl-js/commit/e50aa58b0
9. skills/map-from-scratch/SKILL.md
10. https://github.com/openlayers/openlayers/commit/7f088c2eb
11. https://github.com/Leaflet/Leaflet/commit/cf6d32fc
12. ref-repos/Leaflet__Leaflet/src/dom/Draggable.js
13. https://github.com/maplibre/maplibre-gl-js/commit/19d233ebf
14. https://github.com/simplegeo/polymaps/commit/65c6e96
15. https://github.com/Leaflet/Leaflet/issues/3575
16. https://github.com/openlayers/openlayers/pull/4597
17. https://github.com/Leaflet/Leaflet/commit/c9205932
18. https://github.com/Leaflet/Leaflet/pull/7872
19. ref-repos/maplibre__maplibre-gl-js/developer-guides/globe.md
20. https://github.com/maplibre/maplibre-gl-js/issues/5433
21. https://github.com/qgis/QGIS/issues/30152
22. ref-repos/maplibre__maplibre-gl-js/developer-guides/life-of-a-tile.md
23. https://github.com/maplibre/navara/pull/573
24. https://github.com/maplibre/navara/pull/474
25. ref-repos/CesiumGS__cesium/CHANGES.md
26. https://github.com/qgis/QGIS/pull/37044
27. https://github.com/qgis/QGIS/issues/36820
28. ref-repos/qgis__QGIS/src/core/raster/qgsrasterprojector.cpp
29. ref-repos/openlayers__openlayers/site/src/doc/tutorials/raster-reprojection.md
30. https://github.com/openlayers/openlayers/commit/726bcbef8
31. https://github.com/openlayers/openlayers/commit/03c75a864
32. https://github.com/openlayers/openlayers/commit/280b79578
33. https://github.com/openlayers/openlayers/commit/07e0c0d43
34. https://github.com/openglobus/openglobus/issues/1097
35. https://github.com/openglobus/openglobus/commit/de60c018
36. ref-repos/openglobus__openglobus/src/layer/geotiff/GeoTIFFReader.ts
37. ref-repos/kenjiyoshidahome2026-bit__ortho-earth/packages/ortho-core/raster tiles.md
38. https://github.com/maplibre/maplibre-gl-js/pull/7887
39. ref-repos/openlayers__openlayers/changelog/upgrade-notes.md
40. https://github.com/openlayers/openlayers/commit/30ec260c4
41. https://github.com/opengeos/RustGIS/commit/3bc73bb
42. ref-repos/openlayers__openlayers/changelog/v3.19.0.md
43. ref-repos/openlayers__openlayers/changelog/v10.10.0.md
44. https://github.com/openlayers/openlayers/pull/9286
45. https://github.com/Leaflet/Leaflet/pull/4650
46. https://github.com/CesiumGS/cesium/commit/4537f3f3f
47. https://github.com/CesiumGS/cesium/pull/4616
48. https://github.com/CesiumGS/cesium/pull/7061
49. https://github.com/reearth/reearth-papers/commit/f90ac2c
50. https://github.com/reearth/reearth-papers/commit/454592a
51. https://github.com/CesiumGS/cesium/commit/9966a0831
52. https://github.com/Leaflet/Leaflet/commit/511f8f11
53. https://github.com/Leaflet/Leaflet/commit/199eae85
54. ref-repos/Leaflet__Leaflet/docs/_posts/2013-11-18-leaflet-0-7-released-plans-for-future.md
55. https://github.com/Leaflet/Leaflet/pull/7094
56. https://github.com/openlayers/openlayers/pull/5795
57. https://github.com/maplibre/maplibre-rs/issues/71
58. https://github.com/maplibre/maplibre-rs/pull/205
59. https://github.com/maptalks/maptalks.js/commit/8f96400d4
60. https://github.com/maptalks/maptalks.js/commit/652c4bb5e
61. https://github.com/maptalks/maptalks.js/commit/cfb4cf225
62. https://github.com/maptalks/maptalks.js/commit/7f78245e5
63. https://github.com/CesiumGS/cesium/commit/9e1c4f9e9490d55f40caaee73ef662a19adf7d37
64. https://github.com/CesiumGS/cesium/commit/c5e368890e03fecf4ad6e879358c325a842f13ee
65. https://github.com/maplibre/maplibre-gl-js/pull/3185
66. https://github.com/openlayers/ol2/blob/master/notes/2.12.md
67. https://github.com/openlayers/ol2/pull/160
68. https://github.com/maplibre/maplibre-gl-js/commit/54d6d3411
69. https://github.com/maplibre/maplibre-gl-js/commit/80c472576
70. https://github.com/CesiumGS/cesium/pull/9513
71. https://github.com/opengeos/RustGIS/pull/645
72. https://github.com/opengeos/RustGIS/commit/50acdc7
73. https://github.com/CesiumGS/cesium/commit/8f3c8a4b5
74. https://github.com/openlayers/openlayers/pull/12008
75. https://github.com/iTowns/itowns/commit/521ca74
76. https://github.com/maplibre/navara/pull/642
77. ref-repos/maplibre__navara/guide/TILE_TEXTURE_COMPOSITING.md
78. https://github.com/iTowns/itowns/commit/b46b807
79. https://github.com/iTowns/itowns/pull/309
80. https://github.com/iTowns/itowns/pull/584
81. https://github.com/reearth/reearth-papers/commit/1d03b9a
82. https://github.com/reearth/reearth-papers/commit/be79e3c
83. https://github.com/Leaflet/Leaflet/commit/443181af
84. https://github.com/Leaflet/Leaflet/commit/de1a62fa
85. https://github.com/protomaps/protomaps-leaflet/issues/156
86. https://github.com/protomaps/protomaps-leaflet/issues/121
87. https://github.com/tangrams/tangram/pull/685
88. https://github.com/reearth/reearth-papers/commit/91138b4
89. https://github.com/reearth/reearth-papers/commit/6578932
90. ref-repos/OSGeo__grass/lib/gis/compress.c
91. ref-repos/OSGeo__grass/lib/raster/rasterlib.dox
92. ref-repos/OSGeo__grass/raster/r.compress/r.compress.md
93. https://github.com/OSGeo/grass/commit/2cff96505517566532c24a5aa5197bc36ec8062c
94. https://github.com/OSGeo/grass/commit/aa1da2117
95. https://github.com/OSGeo/grass/commit/cfdf3e050
96. https://github.com/OSGeo/grass/commit/84a06c341
97. ref-repos/OSGeo__grass/lib/raster3d/raster3dlib.dox
98. ref-repos/OSGeo__grass/lib/segment/segmentlib.dox
99. https://github.com/OSGeo/grass/commit/30cdc6928
100. https://github.com/qgis/QGIS/commit/0a35d43552
101. ref-repos/opengeos__RustGIS/docs/user-guide/data-formats.md#files-on-the-web
102. https://github.com/opengeos/RustGIS/commit/d9d2a7b
103. https://github.com/opengeos/RustGIS/commit/3429749
104. https://github.com/openlayers/openlayers/commit/796b2b837
105. https://github.com/openlayers/openlayers/pull/12008#issuecomment-803620507
106. https://github.com/opengeos/RustGIS/commit/f7b50fd
107. https://github.com/openlayers/openlayers/commit/45ba5792c
108. https://github.com/iTowns/itowns/pull/450
109. https://github.com/iTowns/itowns/pull/470
110. https://github.com/reearth/reearth-visualizer/blob/main/web/docs/concepts/tiles-migration.md
111. https://github.com/reearth/reearth-visualizer/commit/68e88e19
112. https://github.com/Leaflet/Leaflet/commit/0392b7f4
113. https://github.com/Leaflet/Leaflet/commit/8483bfa6
114. https://github.com/simplegeo/polymaps/commit/86a1b8a
115. https://github.com/OSGeo/grass/pull/7440
116. skills/map-from-scratch/references/patterns.md
117. https://github.com/maplibre/maplibre-gl-js/issues/1559
118. https://github.com/maplibre/navara/blob/main/guide/TILE_TEXTURE_COMPOSITING.md
119. https://github.com/opengeos/RustGIS/issues/635
120. https://github.com/reearth/reearth-papers/commit/b82da28
121. https://github.com/reearth/reearth-papers/commit/f7247a3
122. https://github.com/reearth/reearth-papers/commit/f069927
123. https://github.com/reearth/reearth-papers/commit/8abd9e7
124. ref-repos/reearth__reearth-papers/README.md
125. ref-repos/reearth__reearth-papers/CONTRIBUTING.md
126. https://github.com/reearth/reearth-papers/commit/1d43319
127. ref-repos/reearth__reearth-papers/src/ezu.ts
128. https://github.com/reearth/reearth-papers/commit/8f46314
129. https://github.com/reearth/reearth-papers/commit/00f24c2
130. https://github.com/reearth/reearth-papers/commit/0011827
131. https://github.com/kenjiyoshidahome2026-bit/ortho-earth/blob/main/packages/ortho-core/raster%20tiles.md
132. https://github.com/qgis/QGIS/issues/40746
133. https://github.com/OSGeo/grass/blob/main/raster/r.compress/r.compress.md
134. https://github.com/OSGeo/grass/commit/0ae0be638
135. https://github.com/OSGeo/grass/commit/5a36e44ce
136. https://github.com/OSGeo/grass/commit/7227e5b17c7f48b0c2cad532363c43721e574681
137. https://github.com/OSGeo/grass/commit/20a03092d1f2bab55180a008ab22e2871d231125
138. https://github.com/OSGeo/grass/commit/56ebd04da5463cdc5c5a39f51eb4078990926898
139. https://github.com/OSGeo/grass/blob/main/lib/gis/compress.c
140. https://github.com/OSGeo/grass/blob/main/lib/raster/rasterlib.dox
141. ref-repos/OSGeo__grass/raster/r.null/r.null.md
142. https://github.com/OSGeo/grass/commit/3ed6888c3
143. https://github.com/OSGeo/grass/commit/57ff07fef
144. https://github.com/OSGeo/grass/commit/9cce81c7b
145. https://github.com/OSGeo/grass/commit/9328c92a1
146. https://github.com/OSGeo/grass/commit/e2dc2789f
147. https://github.com/OSGeo/grass/blob/main/lib/raster3d/raster3dlib.dox
148. https://github.com/OSGeo/grass/blob/main/lib/segment/segmentlib.dox
149. https://github.com/OSGeo/grass/commit/3e4e4048b
150. https://github.com/OSGeo/grass/commit/599cdff029ea0d5279c33dd83b4d868c4bd86fb4
151. ref-repos/KDE__marble/docs/projects/flatproj/update-1.txt
152. https://invent.kde.org/education/marble/-/blob/master/docs/projects/flatproj/update-1.txt
153. ref-repos/KDE__marble/docs/layermanagement.txt
154. https://invent.kde.org/education/marble/-/blob/master/docs/layermanagement.txt
155. https://github.com/KDE/marble/commit/166159644
156. ref-repos/openlayers__openlayers/changelog/v6.0.0.md
157. ref-repos/openlayers__openlayers/changelog/v4.4.0.md
158. https://github.com/openlayers/openlayers/commit/30cd0aa58
159. https://github.com/openlayers/openlayers/commit/83e251621
160. https://github.com/openlayers/openlayers/pull/4122
161. https://github.com/openlayers/openlayers/commit/348ccbc3d
162. ref-repos/openlayers__openlayers/changelog/v6.9.0.md
163. https://github.com/openlayers/openlayers/commit/8d8632bff
164. https://github.com/openlayers/openlayers/commit/05eac3e38
165. https://github.com/openlayers/openlayers/commit/59186f2af
166. https://github.com/openlayers/openlayers/pull/15402
167. https://github.com/openlayers/openlayers/pull/11810
168. https://github.com/openlayers/openlayers/issues/4960
169. https://github.com/openlayers/openlayers/pull/3660
170. https://github.com/openlayers/openlayers/pull/4389
171. https://github.com/openlayers/openlayers/pull/3214
172. https://github.com/openlayers/openlayers/commit/1d17b1ee1
173. https://github.com/openlayers/ol2/blob/master/notes/2.13.md
174. https://github.com/openlayers/ol2/blob/master/lib/OpenLayers/Layer/Grid.js
175. https://github.com/openlayers/ol2/issues/458
176. https://github.com/openlayers/ol2/issues/513
177. https://github.com/openlayers/ol2/pull/517
178. https://github.com/openlayers/ol2/issues/16
179. https://github.com/openlayers/ol2/commit/89e8a872
180. https://github.com/openlayers/ol2/commit/80656cdf
181. ref-repos/Leaflet__Leaflet/docs/_posts/2016-09-27-leaflet-1.0-final.md
182. ref-repos/Leaflet__Leaflet/docs/examples/extending-2-layers/index.md
183. https://github.com/Leaflet/Leaflet/pull/2247
184. https://github.com/Leaflet/Leaflet/pull/8891
185. https://github.com/Leaflet/Leaflet/issues/1066
186. https://github.com/Leaflet/Leaflet/commit/6e5d3e26
187. https://github.com/Leaflet/Leaflet/commit/cfde916e
188. https://github.com/Leaflet/Leaflet/commit/592d2ce8
189. https://github.com/Leaflet/Leaflet/issues/3697
190. https://github.com/Leaflet/Leaflet/issues/3297
191. https://github.com/Leaflet/Leaflet/issues/1207
192. https://github.com/protomaps/protomaps-leaflet/issues/112
193. ref-repos/protomaps__protomaps-leaflet/src/view.ts
194. ref-repos/protomaps__protomaps-leaflet/src/frontends/leaflet.ts
195. https://github.com/tangrams/tangram-es/commit/1b664f09
196. https://github.com/tangrams/tangram-es/commit/a01f510e
197. https://github.com/tangrams/tangram/pull/282
198. https://github.com/tangrams/tangram/pull/688
199. https://github.com/tangrams/tangram/commit/f5d2738b
200. https://github.com/tangrams/tangram/commit/c59fbb6b
201. https://github.com/tangrams/tangram/commit/899bb484
202. https://github.com/tangrams/tangram/commit/879998c0
203. https://github.com/tangrams/tangram-es/commit/cc25dbba
204. https://github.com/tangrams/tangram-es/commit/f49c3354
205. https://github.com/tangrams/tangram-es/commit/96e9b323
206. https://github.com/simplegeo/polymaps/issues/36
207. https://github.com/simplegeo/polymaps/issues/65
208. https://github.com/simplegeo/polymaps/issues/81
209. https://github.com/simplegeo/polymaps/issues/51
210. https://github.com/simplegeo/polymaps/issues/129
211. https://github.com/simplegeo/polymaps/commit/a376a47
212. https://github.com/openglobus/openglobus/issues/1102
213. ref-repos/iTowns__itowns/changelog.md
214. ref-repos/iTowns__itowns/docs/tutorials/Fundamentals.md
215. https://github.com/iTowns/itowns/commit/f286b40
216. ref-repos/maplibre__maplibre-gl-js/src/tile/tile_manager_raster_dem.ts (fillBorder sets needsTerrainPrepare) and src/render/terrain.ts:357 (re-uploads demTexture when needsTerrainPrepare)
