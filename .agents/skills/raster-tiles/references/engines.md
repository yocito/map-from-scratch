# Raster tiles: per-engine detail

Numbers in brackets refer to the Sources list in [../SKILL.md](../SKILL.md).
Read this when a decision in SKILL.md needs the history or the numbers behind
it.

## MapLibre GL JS

- Globe: raster tiles drawn twice, borderless with stencil marking, then with
  stretched borders only into unmarked gaps. A single pass of subdivided meshes
  left seams from curvature, worst between tiles of different zooms
  [19]. Pole fans stretch the first and last Mercator rows to the pole;
  Antarctic ocean spikes are declared expected [19][20].
- DEM: worker copies edge pixels into a 1 px border, then
  `TileManager._backfillDEM` copies real edge pixels from neighbours [22],
  and flags the tile so its DEM texture is uploaded again [216].
- Terrain-RGB under fingerprinting: `OffscreenCanvas.getImageData` first; if
  the result looks distorted, read through a `VideoFrame` (RGB/BGR only). Cost
  0.5-1 ms per 512 px tile on desktop, 5-10 ms on an iPhone 14. Per the PR
  comments, it also fixed long standing terrain spikes in Brave, and adopted
  untranspiled async/await, dropping about 0.02% of one site's users [65].
- Image quads with non-parallelogram corners: homogeneous texture coordinates
  from the inverse homography (w = ax+by+c); parallelograms and tiles keep the
  identity. Near-degenerate quads still look wrong (#8172) [38].
- Untiled image on terrain: tiles list which tiles at other zooms overlap the
  image so each terrain tile draws it; slicing the image into a pyramid on
  demand was rejected as complex. Bug from 2022, fixed in 2025 [117].
- `maxParallelImageRequests` queue in util/ajax, documented next to
  `workerCount` [68][69].
- `alignedProjMatrix`: camera x/y rounded to whole pixels, half-pixel shift for
  odd viewport sizes, rotated with bearing, for rasters only [13].
- Tile texture reuse pool capped, excess textures destroyed [8].

## MapLibre Native

- PR 4280 (closed unmerged): Sobel outputs at tile edges differ because each
  tile samples different neighbours, and bilinear filtering drags a tile-local
  texel across the seam. DEM border 1 -> 3, backfill 3 rows/cols and 3x3
  corners, prepare pass at (dim+3)^2. Border 2 with (dim+1)^2 was tried and
  was not enough. Seam/control luminance ratio 1.65x horizontal and 1.98x
  vertical on main. Also found: neighbour-backfill flags not reset when a
  bucket is replaced, and a render-target leak. Render goldens differ between
  llvmpipe ARM64 and x86_64. Closed because the contributor could not explain
  the AI-generated change, and the maintainer pointed to a planned plugin API
  [4].

## maplibre-rs

- PNG/WEBP decoded by the platform and uploaded with
  `copyExternalImageToTexture`; blocked until wgpu implemented it, then
  landed after the raster path stopped reusing the vector BufferPool
  [57][58].

## Navara

- Geographic terrain with Web Mercator imagery: all overlapping tiles are
  mosaicked into one render target per layer, then pasted with per-fragment
  latitude reprojection. The earlier one-slot-per-tile design coarsened every
  layer to one tile or overflowed the GPU slot budget with 3 or more draped
  layers [77][118].
- Hillshade normals: vertex normals (seams) -> per-fragment Sobel on a DEM with
  a 1 px Rust-side backfill (PR 474) -> a 256x256 RGB normal map rendered once
  per tile from a 258x258 DEM, [-1,1] mapped to 8 bits (PR 573, "O(1) per tile
  instead of O(pixels)"). Overzoom upsampling of the hillshade texture did not
  work well [24][23].
- Per-tile MRT atlas for raster imagery, hillshade normals, elevation heatmap
  and draped vector tiles, baked by an offscreen full-screen quad when dirty;
  terrain shader does 3 lookups; about 10 fps more [76][77].

## RustGIS (opengeos)

- COG by URL: header first, then by range the overview tiles each part of the
  view needs. Non-8-bit images stretched between the 2nd and 98th percentiles
  of the coarsest overview. Strip-organised, rotated or unsupported images are
  downloaded whole; zstd COGs supported; browser needs CORS that exposes Range
  [101][102].
- Header read 64 KB first; tile index bounded at 8M tiles (about 128 MB). Fixed
  256 KB steps: 12 rounds stopped at about 3 MB and refused MapBiomas's 4 MB
  index (346,092 tiles). Doubling each round, clamped to MAX_HEADER and stopping
  at already-read parts, fixed it [102][103].
- Texture-array pool (PR 645, issue 635): 16 MB chunks up to 128 MB (browser)
  or 384 MB; LRU reuse never of a tile drawn this frame; <= 8/32 uploads within
  4/6 ms per frame; one instanced draw per chunk; prefetch a quarter view
  around and three levels up. Browser at 4x throttle: frames > 100 ms 23-25 ->
  0, p95 50-67 -> 16.8 ms, wasm memory 164-219 -> 128-132 MB; desktop UI p95
  7.0 -> 1.4 ms. Remaining cost: JPEG decode on the main thread
  [71][119][72].
- Decoder injected into the tile cache; web uses `createImageBitmap` with wasm
  fallback (wasm was 20-30 ms per tile); thousands of tiny-skia warnings per
  frame were dropped from the console [7].
- Vector tiles drawn once into cached pictures, placed like raster tiles;
  features culled by boxes; shapes and dashes cut past each picture by the
  layer's reach (half line width, circle radius, at least 16 pt), keeping dash
  phase. Panning 5-13 ms (GPU) / 20-26 ms (CPU) vs 220-410 ms; a new zoom
  50-70 ms on several cores. Pictures keyed by exact resolution missed the
  cache while moving until #600 [106].
- Ancestor stand-in plus cached children drawn on top, as GPU quads in map
  units with textures uploaded once (#568) [41].

## reearth-papers (server-side tiles)

- Moved server rendering from maplibre-native in a Cloudflare container
  (software Vulkan; 2 vCPU, then 4-32 hash shards, up to 100 instances; cold
  3-7 s -> 1.8-2.8 s, warm 0.5-1.6 s per tile) to ezu, a CPU WASM renderer in
  the Worker: 0.2-0.8 s fresh, about 1.5 s for the first tile per isolate.
  Costs: 128 MB isolate heap, synchronous render, the host does all I/O. ezu
  ran as a hidden shadow route until parity (z <= 15 byte-identical); early
  ezu failed 4/11 tiles and took 8.9 s vs 4.5 s
  [120][121][122][123][124][125].
- SIMD128 build: warm z14 urban renders 7-8 s -> about 1.1 s; cold start
  15 s -> 4.6 s; header comment estimates 1.5-3x in pixel loops [126][127].
- Same tile: RGBA 190 ms / 1024 KB, WebP 179 ms / 213 KB, PNG fast 180 ms /
  287 KB, PNG default 218 ms / 256 KB. WebP default, `?format=png` on request,
  the extension in the cache key; categorical WorldCover stays lossless
  [88][128][129].
- 512 px tiles with `tileSize` 512 in TileJSON; MapLibre lets explicit source
  options override TileJSON, so the viewer's hardcoded 256 kept labels at half
  size [81][82].
- 404 for empty tiles; 204 left transparent gaps in patchy Watercolor and in
  WorldCover's ocean; cache version bumped to orphan cached transparent tiles
  [49][50].
- WorldCover below z8 reads one global 22500x9000 (~1.78 km/px) overview COG,
  choosing the overview by output pixel density; z8-13 read per-3-degree COGs
  (2,651 in total) by R2 ranges [89][130].

## reearth-visualizer

- Google Maps terms forbid blending, so any Google tile sets opacity 1 for all
  tiles and disables the slider; the same migration falls back from Cesium Ion
  to google_satellite without an Ion token [110][111].

## CesiumJS

- 1.27: no reprojection of Web Mercator imagery to geographic on load
  [5][25].
- Load ordering: 25% shorter loads (#4616); terrain/imagery rework about 33%
  faster with 33% less data (#7061) [47][48][25].
- KTX2/Basis only (KTX1 and CRN dropped), transcoded in a worker by the Binomial
  transcoder, ETC2 over ETC1; lazy creation after eager ktx-parse broke IE11
  for every app. Logo 22.1 kB PNG -> 3.6 kB ETC1S (UASTC about 65 kB). Sizes
  not a multiple of 4 failed; 400x400 with REPEAT failed in WebGL1 [70].
- Tiles render with parent imagery for a slow layer [46]. Imagery texture
  pool removed (stale mips in Chrome when mixing mipmapped and non-mipmapped
  textures; little gain) [73]. Bing missing tiles detected by empty
  response; EMPTY_IMAGE made a real blank image [51].
- `imageOrientation: 'none'` reverted to the deprecated `'from-image'` for older
  browsers (#12846, #12871) [63][64].

## ortho-earth (GPL-3)

- Method B': each Mercator tile an n x n grid mesh (16; 32 below z4) of
  origin-relative lon/lat, v from Mercator y on the CPU, fill vertex shader plus
  a texture fragment shader; ancestor fallback by sub-uv of the parent
  texture; one texture per tile; xyz, PMTiles raster, GeoPackage and MBTiles
  behind one z/x/y -> ImageBitmap contract. Rejected: CPU-warping into one
  equirectangular window (0.4 s settle lag, blurry at tilt) and per-pixel
  virtual texturing with Mercator in the shader. Budget about 341 KB per 256 px
  tile with mips; 64 MB desktop (about 190 tiles), 24 MB low-memory; 100-300
  tiles per frame with per-draw binds judged light enough [131][37].

## QGIS

- XYZ destination rects in integers, expanded to the nearest pixel, after
  gaps up to 2 px [1].
- Resample input buffered by the kernel radius (#30152) [3][21].
- Early (provider-side) resampling, opt-in, PR 37044: fixes sub-pixel
  misalignment (#36820) and resampling that moved between refreshes; costs
  hard pixel edges, odd nodata edges (GDAL resamples one band at a time and
  ignores nodata), computation, and oversampling 15-16 vs 2 for smooth
  zoom-out, so the old filter is the fallback without overviews. Users later
  noticed the old "average" label had been GDAL bilinear (#40746). Reprojected
  rasters are forced through provider-side resampling; the proper fix (resample
  inside QgsRasterProjector like gdalwarp) was deferred
  [26][27][132][28].
- Multiband 8-bit fast path writes QRgb from raw bytes: about 40 -> 20 ms per
  tile (debug build) [100].

## GRASS GIS

- Codecs: RLE default for CELL until 7.0.0 (now deprecated, read-only for GRASS
  6 maps) -> zlib (level 1 as the speed/ratio compromise; switch in 2014) ->
  ZSTD by default when built with it. ZSTD "compresses up to 4x faster than
  ZLIB, and usually decompresses 6x faster"; BZIP2 saves 30-50% vs zlib only
  above 10,000 columns; LZ4 about as fast as no compression; low-information
  maps shrink to about 1% [92][133][134][135][93][136][137][138].
- Rows written sequentially, each compressed alone with a 1-byte flag, stored
  raw when compression would grow it, found through a row offsets index
  [90][139][91].
- CELL width 1/2/3+ bytes by value range; FCELL 4 and DCELL 8 bytes [92].
- Null bitmap file replaced zero-as-null (GRASS 4.x maps still read that way);
  sentinels -2^31 and all-ones NaN; FP null test changed to `x != x` because
  NaNs from 0/0 or sqrt(x<0) have no guaranteed bits [91][140].
  Null file compressed with LZ4 by default since 2017 (needs 7.2+); readers
  prefer an uncompressed null file if both exist; a segfault when nulls were
  compressed but data not had to be fixed
  [92][141][142][143][144][145][146].
- Raster3D: zlib plus mantissa truncation ("precision", 0-23 or 0-52 bits) as
  the most effective compression; nulls as a separate bit array at reduced
  precision; RLE writing removed after a large-file test showed it wrong above
  129,032 [97][147][94][95][96].
- Segment library: srows, scols as powers of two about 10% faster; 32, 64 or
  128 best for scattered access; segments sized as a fraction of the matrix
  perform very poorly [98][148].
- Split input/output windows: the column mapping is built once per open map;
  changing a window with maps open is a fatal error [91].
- r.param.scale in bands with per-thread ring buffers and halo rows: about
  1.92x (2 threads), 3.38x (4), 4.62x (8) in the PR body; a review comment
  measured median 203 s -> 104.7 s (2), 59.9 s (4), 44.1 s (8); identical
  output; serial with a mask [115].
- Row buffers moved from alloca to heap after wide rasters overflowed the stack
  [149]. Per-cell byte count from the file checked against the header
  before memcpy (Coverity) [99]. Jupyter display reprojects only as many
  cells as needed [150].

## KDE Marble

- Scanline texture mapping: every screen pixel inverse-projected to lon/lat;
  refactored into Flat and Globe mappers to add the flat projection; the
  per-pixel tile lookup cost was expected, not measured, to matter only a
  little [151][152].
- Stacking layers (clouds over imagery) merged into one painted layer for
  performance; merged tiles rebuild when a member changes
  [153][154].
- Band per thread; the last band now takes the remainder rows, which had left an
  unpainted strip [155].

## OpenLayers

- v6.0 internal tile coordinates follow XYZ (top-left 0,0, y down); v3.7's
  upward rows forced `-y-1` in custom URL functions [39][156].
- Interim tiles: kept on `setUrl` (3.16), aligned fallback (3.19), opacity
  transitions skipped when an interim tile is visible (4.4, #9286), only the
  uncovered remainder of lower levels drawn (10.10)
  [39][42][157][43][44].
- Raster reprojection: triangles with exact vertices and affine interiors,
  subdivided to ERROR_THRESHOLD 0.5 px, inverse transform only (forward would
  "significantly decrease performance"), source resolution per reprojected tile
  at its centre; duplicate images beyond the globe's far side are left to a
  layer extent [29]. Binary subdivision, transform caching (30-35% fewer
  calls), local shifting for the affine solve and stitching precision
  [30][31][158][159]. Original PR: +3.2 KB gzip, stitch lines
  for semi-transparent sources, unstable single-image reprojection on low RAM
  [160]. Now in WebGL with float32 interpolation; stitched source scaled
  down to MAX_TEXTURE_SIZE; fixed Firefox artefacts [32][161][33].
- Data tiles: `interpolate: false` default (6.10), `normalize: false` for raw
  GeoTIFF floats (6.9); float textures, more than four bands, GeoTIFF decoding
  in a lazily created worker pool, paletted rendering
  [39][162][163][164][165]. Float linear filtering needs
  OES_texture_float_linear, else NEAREST [40].
- WebGL tile layer (#12008): renderer owns a TileTexture cache; later the
  renderer caches tiles in view projection (#15905) [74][166]. Data
  were normalised and quantised to 8 bits internally; only configured bands
  should be loaded [105]. GlTiles (user GLSL per tile, re-rendered by
  Canvas 2D) was set aside for it [167].
- Tiles drawn straight onto the map canvas, fallback tiles clipped where
  higher resolution covers them, rotation applied once: fast zoom 30 -> 50-60
  fps, panning 55 -> 60 fps; no change with about 25 TileWMS layers
  [16]; white lines between tiles came back in 3.14 [168].
- Parameter changes: show the most recent outdated tile [56]; chains passed 70
  per tile until limited to 2 [169]; pending requests are not aborted
  [56][169][170].
- ol.source.Raster runs per-pixel operations in a worker and ignores DPR; no
  bundled raster algorithms [171].
- Vector tile `image` render mode removed in 6.6 (labels rotate, scale during
  animation, cut at tile edges); `hybrid` default [107][39].
- Tile positions from index (7f088c2eb) [10]. Untiled GeoTIFF strips
  shorter than 256 px read as 256x256 tiles; reprojected grids capped at the
  source's finest resolution [104][172].

## OpenLayers 2

- Continuous zoom by stretching finer tiles (2.12) and fractional wheel zoom
  (2.13); `getCanvasContext` on tiles requires CORS, `crossOriginKeyword: null`
  for servers without it [66][173][67].
- singleTile mode: one image 1.5x the map, reloaded when uncovered; `buffer`
  default 0 because extra rows "increase bandwidth use significantly"
  [174].
- Grid positions and BBOXes from origin + index after cache misses and seams
  [2]. Sub-pixel `left` values from `margin: auto` gave seams; seams only
  during animation were accepted [175][176]. Pixel instead of percentage
  positioning removed white lines but was held out of 2.12 RCs as risky
  [177].
- One back buffer positioned once during zoom, built also while tiles load;
  transparent layers look wrong during resize [178].
- UTFGrid at 2x2 px by default [179][180].

## Leaflet

- `maxNativeZoom` overzoom (0.7), with later edge cases (#7094 flicker when
  equal to maxZoom) [54][55].
- Multi-level buffering in the 1.0 animation rewrite; separate prune and load
  bounds [6][45][181].
- GridLayer split from TileLayer; `createTile(coords, done)` returns any element
  [182][183].
- Seams (#3575, 200+ comments, since 2015): 1 px or 0.5 px oversize blurs and
  breaks overzoom; Leaflet.TileLayer.NoGap is slow and snaps pinch zoom;
  `L_DISABLE_3D` flickers; results vary by GPU vendor and OS scaling;
  `mix-blend-mode: plus-lighter` (2023) on `img.leaflet-tile` only, still seams
  at page zoom other than 100% [15][184][112][113]. Seams
  during CSS zoom transitions in Firefox and Safari were declared a browser bug
  [185].
- Per-tile 3D transforms removed (separate render surfaces), then 2D translate
  instead of top/left (fixed Safari gaps, smooth iOS zoom)
  [17][186][187][188]; `will-change` removed for memory
  [18].
- Retina: `detectRetina` off by default because zoom+1 tiles shrink baked
  labels; `{r}` token for @2x [83][84]. Blurry tiles traced to DPR
  1.5 and fractional transforms [189][190].
- Drag snapped to device pixels [11][12]. Integer `{z}` via
  `_clampZoom` (Math.round), and in `redraw` [52][53].
- EPSG:4326 pyramids have two tiles at z0 (0.703125 deg/px); fixed in the CRS
  rework [191].

## protomaps-leaflet

- `levelDiff` 2 by default for performance, fixed to 1 in 2.0 to match MapLibre
  generalisation at about 4x the data [86][192][193].
- Tile canvas 256 x devicePixelRatio; a `devicePixelRatio` option for headless
  rendering (5.1) [85][194].

## Tangram (JS) and Tangram ES

- `zoom_offset`: Walkabout 1300x650 baseline 6 tiles / 1.6 MB, `zoom_offset` 1
  2 tiles / 488 KB, 256 px tiles at 512 6 tiles / 407 KB; Washington 8 / 3.5 MB
  vs 4 / 2.0 MB vs 8 / 1.0 MB [87]. Tangram ES added `zoom_offset` for
  dependent terrain rasters [195][196].
- Raster samplers injected only in fragment shaders by default; Mali-400 has no
  vertex texture units [197].
- Untiled images cut into per-zoom raster tiles with Canvas `drawImage`
  (280 drone images in one case; problems above 2048x2048 on an iPhone 6);
  Tangram ES would avoid CPU compositing for binary size [198]. Not kept from
  nearby zooms, density capped, rendered once per scene generation
  [199][200][201][202].
- Tangram ES raster cache as a weak_ptr map evicted by a custom deleter;
  -48 lines [203][204][205].

## maptalks.js

- Worker fetch + `createImageBitmap` (2022-01), default off (2022-03), off on
  Safari and iOS WeChat (2023-08); later `createImageBitmap` on the loaded
  `<img>` on the main thread [59][60][61][62].

## Polymaps

- Tile centre rounded only at integer zoom with no rotation; Firefox tweak
  rolled back [14][114]; seams at fractional zoom stayed open
  [206][207].
- SVG for everything, including raster tiles: no hardware-accelerated
  transforms, stutter at level switches; canvas and WebGL considered, never
  landed; Stamen moved to Leaflet [208][209][210].
- Each tile keeps its decoded HTML Image to stop flicker [211].

## openglobus

- COG reprojection by a grid of projected nodes, GRID_MAX_SIZE 64,
  GRID_MAX_ERROR 0.25 tile pixels, overview chosen with tolerance 1.4; the
  contributed two-corner stretch and an extent clamp only hid the seams
  [34][212][35][36].

## iTowns

- v2.46.0: per-layer tile textures packed into a DataArrayTexture (render
  target LRU, max 200), removing a 15-sampler cap, a 16-unit clamp (Firefox
  bug 777028) and "maximum layer is reached" rejections [78][213].
- Raster sources get no source-side cache [75].
- Vectors either rasterised onto terrain tiles (ColorLayer) or meshed in 3D;
  draped resolution bounded by tile texture size [214][215]; picking of
  draped features by point-in-polygon tests with a pixel tolerance in degrees
  [108][109].
- Run-time atlas (PR 309): 258 px with a 1 px border, power-of-two atlas;
  committed VRAM 191 -> 276 MB, Firefox heap 195-200 -> 215-220 MB; closed
  unmerged [79].
- Premultiplied alpha removed white fringes [80].
