# Symbols and icons, engine by engine

Detail behind ../SKILL.md. Reference numbers are the Sources list of
../SKILL.md. Confidence notes say when a record rests on a commit message
alone or on a thread that ended without a merge.

## MapLibre GL JS

- Per-tile atlases. When a worker tile has all its dependencies it creates
  a GlyphAtlas and an ImageAtlas holding only the glyphs and icon/pattern
  images it uses, packed into a square with potpack, and sends them to the
  main thread with the buckets [1]. Rejected: one global atlas of the whole
  sprite and font set. Cost: the same icon is duplicated and uploaded again
  in every tile that uses it [1].
- On-demand sprite extraction (3.0.0, #1809): individual images are sliced
  from the sheet only when used, "reduce memory usage and improve
  performance by reducing the number of getImageData calls" [2][3].
- GPU-animated icons (PR 7954, fixes #7857): `StyleImageInterface.data` may
  be `{renderWithWebGL(target)}`; the image draws itself into its atlas slot
  and redraws whenever `render()` returns true. The previous path rewrote
  pixels on the CPU and re-uploaded the whole icon every frame, which lagged
  on low-power phones. A new interface type was dropped to keep the API
  small. The image must handle context loss, several atlases (several calls
  per change) and size limits [4].
- Upright shields along lines (draft PR 716): a boolean
  `text-rotate-to-line=false` zeroes the segment angle in
  `placeGlyphAlongLine` on the CPU. Rejected: hard-coding `segment_angle=0`
  in the vertex shader (breaks everything else); `text-writing-mode` (point
  placement only); icon plus text per shield with `symbol-spacing`. For a
  single shield, `icon/text-rotation-alignment: viewport` with line
  placement already works. Collision boxes ignore glyph rotation, so corners
  overlap on diagonals; the same overlap was reproduced with `text-rotate:
  45` on existing code [5].
- Index-by-grapheme (draft PR 2458, not merged): always rasterise glyphs
  with TinySDF from system fonts and key the atlas by grapheme cluster
  (marked with `@` in tile data or found with `Intl.Segmenter`), so the
  browser shapes Indic, Khmer, Burmese and Arabic. Problems: wrong clusters
  for Bengali, Khmer and Telugu; a CanvasComparer fix that was very slow;
  Firefox lacked `Intl.Segmenter` then; TinySDF looked pixelated at the
  default size; many more atlas entries. For a known label set, shape at
  bake time and store cluster glyphs or prerendered label images [6][7].

## MapLibre Native

- SDF fill patterns (PR 4551): `fill-pattern` referencing an SDF image is
  coloured by `fill-color`, constant or data-driven. SDF metadata travels
  through ImagePosition and the pattern atlas; SDF state is per layer.
  Mixing SDF and RGBA patterns in one layer warns; switching an image
  between RGBA and SDF triggers a relayout. Covered by unit tests and a
  render test (data-driven colours, fill-opacity, antialiased outlines,
  RGBA/SDF swaps) [8].
- Multiple sprite sheets (PR 1858): `sprite` may be an array of `{id,url}`;
  icons are `id:image`, `default` needs no prefix, ids must be unique,
  SpriteLoader loads them in parallel [9].
- Nearest sampling during pure pans: a change avoiding `GL_LINEAR` for icons
  when only translating, with a render test, was reverted with no reason
  given. Treat as an unresolved experiment [10][11].
- Sprite reload dedupe: a commit sending `onSpriteLoaded` only when the
  sprite changed explained that a 304 with a cached sprite caused two extra
  parses, 2x style images treated as updated, and every tile iterating
  `updatedImageVersions` each frame. It was reverted a day later without a
  reason [12][13].
- On-demand image cache: `DEFAULT_ON_DEMAND_IMAGES_CACHE_SIZE = 100 * 8192`,
  with the comment "Average sprite size with 1.0 pixel ratio is ~2kB, 8kB
  for pixel ratio of 2.0" (checked in the commit) [14].

## MapLibre Navara

- `scaleByDistance` was renamed `sizeInMeters` for points, billboards and
  text: true is world metres (shrinks with distance), false is pixels
  (constant at every zoom). A breaking rename across many examples [15].

## RustGIS

- Globe drape: point symbols and strokes were baked 2-6x too large and
  blurred while the globe moved. Drawing the drape at the camera's scale
  with fewer pixels per point, up to 2M pixels, keeps symbol sizes; the
  rejected alternative bounded the texture by drawing at a coarser camera
  scale (#522) [16].

## Cesium

- Minimum GPU features: polylines require vertex texture fetch since 1.26;
  since 1.140, billboards and labels require WebGL 2 or WebGL 1 with
  `ANGLE_instanced_arrays` and `MAX_VERTEX_TEXTURE_IMAGE_UNITS > 0`,
  announced in 1.137 [17][18][19].
- LEQUAL: billboards, labels and points switched from LESS to LEQUAL in 1.28
  (#4675) so glyphs at equal depth can overlap; glTF followed in 1.67
  (#8646): "when geometry overlaps, the later geometry will be visible above
  the earlier ... makes it easier to render e.g. outlined buildings"
  [17][20][21].
- Incremental atlas (PR 69): blackpawn-style rectangle packing accepts new
  images without rebuilding; when full it grows by a silent rebuild, so all
  source Images are kept because WebGL has no `glGetTexImage`. Rejected: an
  FBO plus `copyTexSubImage2D` copy into a bigger texture (a maintainer said
  its benefit would be memory, not speed, since resizes are rare); counting
  images to detect change ("works by accident"), replaced by a GUID [22].
- Quantised point sizes: PointVisualizer produced thousands of useless
  canvases from sampled float sizes; sizes are rounded to integers, and
  non-outlined points scale one larger texture [23].
- Shader depth testing for billboards (PR 12821): beyond an eye-space
  distance, test against a camera-facing plane at the ellipsoid centre;
  closer, ground-clamped billboards test three key points against the depth
  texture and show whole if any is visible. An attempt to clear globe depth
  with terrain depth testing on was reverted. Follow-up fixes were needed
  for depth near the horizon and `disableDepthTestDistance = 0` (#13150,
  #13159) [24][25][17].

## deck.gl

- Billboard icons are depth-tested at their anchor: "all icons are drawn
  facing the camera at the depth of their anchor". With a slanted building,
  depth checking "goes haywire at the top of the icon". For real occlusion
  use world-space quads (`SimpleMeshLayer` with a texture, or `IconLayer`
  with `billboard: false`) [26].
- Globe occlusion. Global `cullMode: 'back'` culled every icon and text
  quad (clockwise after the y flip). PR 9975 tested `dot(normal, viewDir)`
  at the anchor; correct only at sea level, it cut off raised anchors
  (flights) near the horizon and clipped foreground billboards, and was
  closed. PR 10750 rewinds icon quads to be front-facing, hides far-side
  anchors with an exact camera-to-anchor ray-sphere test, and moves
  billboards toward the camera by how much the globe surface rises within a
  64 px footprint. Before it, icons and text drew nothing on a standalone
  GlobeView and billboard ScatterplotLayer showed through the globe.
  Render tests cover 20 near-side and 28 far-side icons. Cost: a depth bias
  of ~1.8 km at zoom 12, pitch 60 deg, so 3D geometry closer than that in
  front of an anchor no longer hides it [28][27].
- Discard outside clip space: `CollisionFilterExtension` changed the
  discarded position from `vec4(0.)` to `vec4(0,0,2,1)` (#7777) [29].
- GPU collision filtering: a collision map rendered in an effect pre-pass,
  tested per label in the vertex shader; it must be re-rendered when layers'
  `isLoaded` changes (#7680) and uses a depth texture rather than a
  renderbuffer (#8477). For a fixed baked label set, CPU placement at bake
  time is cheaper [29][30][31].

## QGIS

- SVG and raster image caches store pre-rendered resampled images; shared
  QPicture copies are detached because concurrent rendering crashed
  (#17089, #17077); the file mtime check is throttled to once per 30 s to
  avoid checking for each of 100k points. Edited files can look stale for up
  to 30 s [32].
- Metres on a degree-based map (PR 4381): one ellipsoidal measure at the
  extent centre for geographic CRSs, a plain unit factor for projected ones,
  a rough degree factor for bare-QPainter previews. Test: 2.5 m pentagons
  and 5 m circles in EPSG:3068 looked the same in UTM 33N and WGS84 [33].
- 3D billboards use a texture atlas so each can have its own image; a
  `QgsFontTextureAtlasGenerator` (~840 lines) packs a font's glyphs for a
  given set of strings. No numbers in the messages [34][35].
- Marker texture bounds: padding of "upwards of 50-100 pixels on all sides"
  replaced by 2 px using the standard render-bounds calculation (checked in
  the commit) [36].

## GRASS

- `lib/symbol/README`: symbols are text vector files (BOX, STRING, POLYGON,
  RING, LINE, ARC) scaled so the larger side of BOX is 1. Outer rings
  clockwise, inner counter-clockwise, because `ps.map` relies on PostScript
  even-odd fill; the README calls this a restriction that "should be removed
  later and replaced by reordering in symbol library". Arcs need
  tessellation per backend [37].

## Marble

- Identical placemark pixmaps share memory through a dedicated
  `QPixmapCache` and are drawn in one `QPainter::drawPixmapFragments()`
  batch; a `BATCH_RENDERING` define turns it off and a debug view colours
  each batch. Later, pixmaps replaced ellipses to cut painter state changes
  [38][39].
- Collision: the icon is part of the placemark's collision box (the old
  "winner takes it all" behaviour, colliding labels only, looked crowded);
  floating-point positions stop flicker; popularity and public placemarks
  rank first; a change of maximum label height forces re-layout. Grouping
  icons into a cluster icon was named as a follow-up [40][41][42][43].

## OpenLayers and OpenLayers 2

- HiDPI shapes (PR 11277): RegularShape and colour-replaced icons are drawn
  into a canvas scaled by pixel ratio, `drawImage` gets both sizes, canvas
  sizes round up. Without the ceil Firefox clipped circles' left edges;
  colour replace without canvas width/height coloured only the top-left
  corner. `DEVICE_PIXEL_RATIO` is a module constant, so browser zoom changes
  do not re-rasterise [44].
- WebGL text replaced one texture per label string with glyph atlases and a
  textured quad per glyph (PR 6793; no numbers) [45].
- Regular shapes are cached as IconImage and converted to `ImageBitmap` with
  `createImageBitmap`, replacing the canvas in place; the canvas is kept
  only if already handed out as a hit-detection image. First frames still
  use the canvas (PR 17235) [46][47].
- OpenLayers 2 rounds `externalGraphic` coordinates before `drawImage` to
  stop Gecko blurring (#3305) [48].

## Leaflet

- Marker, shadow and layers-control PNGs at 1x and 2x (layers.png 696 B,
  layers-2x 1259 B, marker-icon 1466 B, marker-icon-2x 2464 B,
  marker-shadow 618 B) were replaced by SVG (#8766), then inlined into the
  source with image-path auto-detection removed (#10450, 101 lines deleted),
  and the marker SVGs were optimised 25% [49][50][51].

## protomaps-leaflet

- A sheet is an HTML document whose body holds SVGs with px sizes (CSS
  pixels) and unique ids; it can be an inline string. It is rasterised at
  device pixel ratio into an off-screen canvas packed with potpack and
  sampled with `drawImage`. Drop shadows and other advanced SVG features are
  discouraged because browsers render them inconsistently [52].

## Tangram and Tangram ES

- Points on lines (PR 409): vertex placement (old default), spaced (oneway
  arrows every 40 px, angle auto) and midpoint (shields) in one `placement`
  property with centroid. Spacing restarts at tile cuts [53].
- Texture density (PR 234): a `density` parameter (default 1) sizes sprites
  in CSS pixels. One region set across densities preferred, since separate
  regions gave 36x38 at 1x vs 35x37 at 2x collision sizes. Merged 21 months
  later for 2x shields [54].
- Icon plus text in the points style (issue 290, v0.8.0): text anchors and
  offsets relative to the sprite, text priority just below the point's,
  text drawn only if its point is; sprites and glyphs in one mesh with two
  samplers and a selecting varying. Rejected: separate styles with manual
  zoom-dependent offsets, a new unified style, two buffers and two draw
  calls [55].
- Required text (PR 349): point and text both draw or neither; opt-out
  `optional: true`. `require_text` on the point was rejected as ambiguous.
  Per-tile collision then dropped many POIs; proposed remedies were several
  anchor candidates and screen-space collision [56].
- Flat labels (PR 925): pre-projected vertices fix affine texture warping;
  `texture2DProj` was tried and failed with the orthographic label
  projection; higher-precision UVs were rejected because the cause was
  missing perspective-correct interpolation. Very large flat sprites still
  show the limit of drawing labels in screen space [57].
- Unit-bearing sizes (PR 1788): `%` and `auto` sizes are value+unit pairs
  evaluated at build time, when sprite size and aspect are known; the old
  vec2 stops could not express them [58].
- Quad batching: text and sprite meshes merged into one DynamicQuadMesh
  batching by texture; RenderState keeps one global quad index buffer;
  polyline meshes append index offsets to share draws; text and sprite
  vertex shaders were later split again [59][60][61][62][63].

## harp.gl

- Text and icon materials stopped writing depth (June 2020), TextCanvas
  stopped clearing depth, and IconMaterial disabled the depth test
  (MAPSJS-2660: "icons were not passing the depth test in some situations,
  like in globe with top/down view. Depth test is not needed")
  [64][65][66].

## Kothic

- `render()` calls were queued until style images loaded (PR 72), then the
  sprite-loaded condition was commented out as a temporary fix for a
  possible hang [67][68].

## Polymaps

- `geoJson.scale('fixed')` keeps Point and MultiPoint features screen-sized
  by listening to a layer `move` event fired after tiles update and
  appending an inverse scale; the per-example code in cluster.js was
  removed [69][70].

## globe.gl

- Issue 91: users projected points with `getScreenCoords` every frame and
  tested occlusion by raycasting back with `toGlobeCoords`; "makes the
  whole experience lag if I run the check too often", so it was throttled
  to once a second and markers jumped. An HTML elements layer drawn by
  CSS2DRenderer now hides elements behind the globe, and
  `htmlElementVisibilityModifier` allows custom show/hide [71][72][73].

## iTowns

- Since v2.40, point features styled with `point.model` become one
  `THREE.InstancedMesh` per sub-mesh of the model with one matrix per point
  (the example is trees of trunk and canopy); a `misc_instancing` functional
  test covers it. Per-instance styling is limited to the matrix [74].

## osgEarth

- Feature SDFs moved from a GPU compute session to CPU jump flooding "until
  further notice", then to the exact algorithm of "Distance Transforms of
  Sampled Functions" with format-specific pixel loops; a later commit fixed
  a math error making SDFs too wide. No timings [75][76][77][78].

## Mapnik

- Pixel snapping: 2.2 fixed blurry image and SVG icons (#1316); unscaled
  raster markers go to integer positions and SVG marker translations are
  snapped; 3.0 extended snapping to shields (#1866), which made some visual
  tests blurrier. No runtime switch; smarter snapping when scaling left for
  later [79][80][86].
- SVG pattern cache (4.3.2, PR 4582): see SKILL.md; SVG opacity buffers
  were also bounded to marker extents in the same release [79][81][82].
- `marker-multi-policy=[each|whole|largest]`, default `each` for
  compatibility; `largest` uses the part with the largest bbox area,
  `whole` the centroid of all parts. Rejected: changing the default, or
  separate `interior-each`/`interior-largest` values [83].
- `width="100%"` SVGs rendered empty shields in 3.0.16/17 (bisected to
  d09f49b, fixed in 5227f84); osm-carto shields and plaques reappeared [84].
- SVG symbols: a librsvg patch made AGG depend on Cairo; "important to make
  sure this does not incur a performance hit for general rendering without
  svg symbols when using AGG"; SVG was implemented natively in AGG, later
  Cairo [85].
- Cairo vector patterns through `cairo_recording_surface` instead of an
  AGG-rasterised `image_rgba8`; useful only for vector output [87].
- Near-zero-sweep arcs (`|sweep| < pi*1e-6`) fall back to LINETO (#4112)
  [88].

## MapServer

- AGG caches a pixmap symbol in an AGG-compatible state on first access
  (5.2.0-beta1); 5.0.0-beta5 "speed up rendering of pixmap marker symbols"
  [89].
- Hatching: 2004 used an image-sized pattern tile to avoid seams ("not
  optimal for large output with tons of tiled features"); 2011 (#3846,
  "poor performance of polygon hatching") generates lines over the bbox
  expanded by stroke width, strokes them, and intersects with the polygon by
  AGG scanline booleans; other renderers use a vendored Clipper [90][91][92].
- Map rotation applies to a symbol only if its angle is set and non-zero
  (#5271, with tests) [93].
- `LAYER IDENTIFY CLASSAUTO / CLASSGROUP` tests GetFeatureInfo clicks
  against the rendered symbol footprint, honouring ANCHORPOINT, instead of a
  square `TOLERANCE` [94][95].
- librsvg 8.6 API switch double-scaled symbols (#7430); fixed by passing the
  size to `rsvg_handle_render_document` without `cairo_scale`, with a
  version check for older librsvg [96].

## GeoServer (GPL-2.0-only: read, do not copy)

- JSON legend (PR 3310, closed for a replacement): deciding whether an
  expression is static by evaluating it was rejected (it can return a
  constant yet depend on attributes, or throw on a missing one); extract
  attribute references with `FilterAttributeExtractor` and encode with
  `ECQL.toCQL`. KML's IconService could not be reused as is, because it
  matches rules against a real feature [97].
- Legend ExternalGraphic outside the styles directory is allowed with a UI
  warning, since URLs not served by GeoServer endanger web clients; testing
  found the proxy base URL wrongly prefixed to absolute URLs in WMS 1.3.0
  capabilities [98].
- Vector tile buffer from `MetaBufferEstimator` when the request gives none,
  added to the 12 px clip margin [99].
- GEOS-8578: legend lines were drawn thicker because the minimum symbol
  size clamp applied to LineSymbolizer; it is now skipped for lines [100].
- Graphic fills up to `maxRasterizationSize` (512 px after DPI scaling) are
  rasterised once and repeated; larger ones are painted as vectors
  (GEOT-7974 docs) [101].

## OsmAnd

- Billboard snapping in the vertex shader (checked in the commit):
  `symbolLocationOnScreen.x = floor(...) + mod(param_vs_symbolSize.x, 2.0) * 0.5`
  and `vertexOnScreen = floor(vertexOnScreen + vec2(0.5, 0.5))` [102].
- Optional direction arrows counted from the line start at a power-of-two
  step in metres; default stays counted from the route end for navigation
  (#1169) [103].
- A revert of "No position31 in GPU resources" was itself reverted: the
  symbol mesh is relative to position31 and clipping changes position31,
  so both stay in the resource [104].

## Organic Maps

- `priorities_4_overlays.prio.txt`: overlays (icons, captions, path texts,
  shields) draw above all geometry and never overlap; higher priority
  displaces lower; optional captions get the max priority 10000 subtracted.
  The file is regenerated into binary rules by `generate_drules.sh`
  [105][123]. `?debug-rect` draws green/red boxes with an arrow to the
  displacing overlay [106].
- Street-side parking (PR 3896, merged 2023-08-12): new
  `amenity-parking` street_side/lane types with smaller icons and lower
  priority, private parking desaturated and transparent. A kothic MapCSS bug
  (a negated selector also matched tag absence) forced `access=no` styles to
  be commented out (0.3% of cases) [107].
- Designer mode (PR 12699): `--designer style.mapcss` rebuilds compiled
  styles and symbol atlases at run time but keeps type definitions fixed;
  atlas generation is shared with the standalone tools, and tests check that
  every style variant reproduces the bundled data. On Windows, CRLF broke
  number parsing and MapCSS imports were decoded as CP1252; the test running
  real style generation caught the second [108].

## mapsforge VTM

- Real-time SVG theme atlases (#63, #324) exist but `TEXTURE_ATLAS` and
  `POT_TEXTURES` default to false (checked in Parameters.java). #404: GL
  error 1285 OUT_OF_MEMORY on a Galaxy S II and a Galaxy Tab 4 (Mali-400),
  mostly in dense areas around zoom 15. `GL_MAX_TEXTURE_SIZE` can only be
  read on the GL thread after surface creation; loading all theme bitmaps at
  once costs memory; the maintainer preferred plain Java to a native
  rectpack2D packer [109][110].

## Navit

- gtk_drawing_area and Android drivers cache images by name (accounting
  for overlays) so icons are not read and decompressed on every draw
  [111][112].

## Galileo

- Screen sets anchored to a map point, drawn by dedicated pipelines,
  replaced `screen_ref` primitives with per-vertex screen offsets inside the
  world tessellation, which had needed depth-test and removal fixes; the
  change was +664/-316 lines and removed 242 lines of `screen_ref` [113]
  [114][115].
- "Don't clone textures for same images"; the deduplication survived a
  later rewrite [116][117].

## go-staticmaps

- `ExtraMarginPixels` became (left, top, right, bottom) (#50); with no
  centre or bbox given, the centre shifts so the union of pixel extents is
  centred (#51); margins larger than the image are ignored with a log.
  The fit is computed twice and is still approximate [118][119][120].
- Circles store a metric radius; the point due north at that great-circle
  distance (R = 6371000 m) gives the screen radius for one `DrawCircle`
  [121][122].
