# Text rendering, engine by engine

Bracketed numbers refer to the Sources list in [../SKILL.md](../SKILL.md).
Read the section for the engine whose approach you are about to copy or
reject.

## MapLibre GL JS

- Glyphs: server PBFs per 256 code points, or local TinySDF; one code point
  is one glyph, no complex shaping, RTL needs a plugin; `font-faces` widens
  coverage only [2]. Without a `glyphs` URL, `text-font` is a CSS-like
  fallback list rasterised locally; a failed PBF is rendered locally instead
  of crashing [1][3]. Paid: output differs across platforms, and such
  styles do not work in MapLibre Native [3].
- CJK ideographs and Hangul (later Hiragana/Katakana) rendered locally with
  `localIdeographFontFamily`; server glyphs are not cached into local
  ranges, and a missing glyph in a loaded range no longer refetches it
  [6][11].
- Local glyphs at 2x (48 px) with a texture scale; +0.5 alignment tweaks so
  2x lands where 1x did; fixing hard-coded vertical alignment declined
  because the constants are tuned to DIN Pro / Arial Unicode. A CJK pixel
  test was found always passing (pixelmatch returned 0) [5][13].
- Code points instead of UTF-16 units (#6640); full complex text will need
  graphemes. Render tests could not cover worker-side shaping well [4].
  Word-boundary wrapping for Thai, Khmer etc. via `Intl.Segmenter`, built
  lazily to save several ms at load [1].
- Halo and fill in one pass, ~40% less symbol GPU time; separate halo pass
  kept for overlapping glyphs; precision raised for blur artefacts [1][13].
- Atlas: incremental resizing removed, then potpack over the full set [9].
  Glyph and icon dependencies requested twice per tile, not per bucket [7].
- Offsets in int16 at 1/32 px (was 1/64) to double the longest label [10].
- Line labels: glyph positions along lines computed on the CPU for pitched
  views, point labels stay in shaders [8]. Points in the tile buffer are
  skipped before shaping, since the neighbour tile labels them [12].

## MapLibre Native

- C++ TinySDF port (Felzenszwalb-Huttenlocher EDT) for CJK Unified
  Ideographs and Hangul Syllables, font family set on the Renderer [17];
  ideographs left out of offline packs, later 2x resolution (#4304) [14].
  Paid: device-font appearance, fonts changing between zooms, high-contrast
  rendering errors [14].
- HarfBuzz + FreeType opt-in (+11%); runtime download forbidden on iOS; no
  plugin architecture in the C++ core [15].
- Glyph caching: stale glyph PBFs used, updates unsupported, raw bytes
  dropped after parsing [19]. Issue #2410: glyphs without max-age treated
  as stale, error responses overwrote cached glyphs, offline regions lacked
  implicit default fonts; workaround was shipping fonts locally [16].
- Label text in UTF-16, glyph id stays uint32 in the PBF but only 16 bits
  used [20]. SDF gamma lowp to highp [21]. 1/32 px offsets [22]. No default
  fonts for icon-only layers, ~15 MB saved [23]. Atlas updated with
  glTexSubImage2D once per frame [18].

## maplibre-rs

- Options weighed: tessellated glyphs (ttf2mesh, ~1k glyphs at ~40 FPS),
  SDF, GPU Bezier (Slug, rejected as patented), canvas text (cannot scale
  with zoom) [24]. Took SDF by porting ~10k lines of Native's symbol code
  (shaping, quads, collision, glyph atlas, bidi); collision left unchecked
  at merge [25][26]. A port bug in `justify_line` surfaced a week later
  [26]. "text rendering = glyph rendering + text shaping" [25].

## MapLibre Tile (yuiseki/maplibre-tile-spec)

- One dictionary shared across `name:*` columns: disabling it cost +25.4%
  size on OMT, +0.8% on Protomaps [27]. FSST gave only 0.2-0.8% [27];
  symbol tables must be trained per shared dictionary (a Latin-trained
  table on Cyrillic was "terrible") [28]. FSST decode two-pass into an
  exact Uint8Array: 1.99x to 4.47x faster [29]; decode a shared dictionary
  once per tile [30]. Relevant only if label strings ship in a tile format.

## navara

- One `drawArraysInstanced` per tile-layer, instance = glyph, per-label
  values in a float texture read by `texelFetch`, kept square under 2048
  texels (~800k labels); 60 labels x 5 glyphs = one draw with ~360
  instances [31].
- Power-of-two glyph slot runs with free lists, worst-case 2x
  fragmentation, compaction forbidden without a measurement; labels created
  lazily because MVT tiles carry thousands of features and few get text
  [31].
- Font worker: shaping (rustybuzz) and single-channel SDF atlas in one
  worker registered with a shared concurrency manager; one thread because
  font data cannot be shared; first version flickered and broke outline
  width [32][34]. `fontsdf` replaced for wrong SDFs; merging the font
  worker into the general worker reverted [34].
- SDF ('low') / MSDF ('high') switch; Slug-like outline branch dropped
  [33].

## reearth-papers (headless MapLibre Native on Workers)

- Per-code-point glyph subsets under an 8 MB LRU: 3.0% block utilisation,
  heap 52-58 MB to 22-26 MB, output byte-identical [35]. Learned glyph set
  persisted as one R2 object, ~650 glyphs / 464 KB for Tokyo, one ~1 MB GET
  instead of up to 38 MB of blocks [36]. Failed fetch never recorded as
  absent [37].
- 512 px tiles with `tileSize` in TileJSON; downscaling to 256 halved
  labels, and a client-hard-coded 256 silently undid the fix [38].
- Self-hosted CJK glyphs from Noto Sans CJK, SC/TC flavour per tile by
  region boxes, part of the cache key [39]. Bidi and Arabic joining via a
  renderer upgrade, cache bumped only for text-drawing themes [40].

## Cesium

- SDF labels (1.60) at a fixed 48 px with TinySDF in the browser; outline
  in the fragment shader. Previously one glyph per size x colour x outline.
  10K labels 60 fps on both; 100K labels 10 fps (bitmap) vs 7 fps (SDF)
  [41]. tiny-sdf replaced by bitmap-sdf over Cesium's canvas text; edge
  work moved to the CPU; SDF attribute cut from vec4 to vec2 [43].
- Incremental blackpawn atlas keeping source Images for rebuilds, GUID for
  invalidation [42]; later always power-of-two, grow by doubling the
  smaller side, 12-bit UVs [46].
- Screen-space bounds from glyph metrics, not padded quads [44]; translate
  x4 for 0.25 px precision [45]; native `measureText` instead of
  pixel-scanning [47].

## deck.gl

- TextLayer atlas built at run time: ASCII 32-127 at 64 px with Canvas2D,
  1024 wide; deleted the shipped 57 KB font.png. ASCII only, bitmap, no
  collision [48]. tiny-sdf 2 with per-glyph metrics; outlines restored by
  using the whole SDF image including the halo as the frame [49].

## ortho-earth (GPL-3.0-or-later, may be adapted here)

- Placement and collision stay on the CPU; drawing behind a `TextSink`
  (Canvas2D or WebGPU). GPU path: glyphs rasterised with Canvas2D in a
  worker, converted to SDF (TinySDF-style EDT, 32 px, 6 px buffer, R8),
  keyed by font x glyph only; one 72-byte instance per glyph; MSDF rejected
  because Canvas2D gives no outlines; runs needing shaping become one
  sprite; depth not tested. Refactor gate: 29,151 recorded Canvas2D calls
  identical; GPU vs Canvas2D IoU 0.87-0.97 [50].

## QGIS, GRASS, Marble

- QGIS: halo and fill share one text path (40 s to 27 s) [51]; plain-text
  fast path and 'PreferText' mode (~50%) [53]; opt-in whitespace-ignoring
  collision for curved labels, 25 files / ~1000 lines [52].
- GRASS d.vect: vertical alignment by fixed font-size fractions, not the
  measured ink box, which jitters baselines; use ink boxes only for
  collision [54].
- Marble: visible-placemark cache with a margin around the viewport; label
  pixmaps created lazily because many labels are never shown [55].

## OpenLayers, ol2, Leaflet

- OpenLayers: label cache deprecated (6.2) then removed (7.0) for lower
  memory and no blur when rotated [56]; `Intl.Segmenter` for text along
  lines, Firefox < 125 needs a polyfill [57]; vector-tile 'image' mode
  removed, 'hybrid' kept [58]; per-style-key canvas cache, canvases freed by
  zeroing their size, a listener leak removed [59]; WebGL text drawn by
  Canvas2D in a worker on an OffscreenCanvas and composited, with sync bugs
  (flashing, double rotation, leak) [60].
- ol2: SVG/Canvas halos shipped without VML; baselines differed between
  backends [61].
- Leaflet: blur from DPR 1.5 and fractional transforms answered with `{r}`
  and `detectRetina`, not engine logic [62]; `detectRetina` off by default
  because labels on zoom+1 tiles were too small [63].

## protomaps-leaflet, tangram, tangram-es, maptalks, kothic

- protomaps-leaflet: Canvas `fillText` with web fonts (RTL and Indic for
  free) [65]; line labels collide as chains of square cells sized from text
  height, min labelable segment 20 px [64].
- tangram: 2-char segments, 1 for RTL, Mongolian not curved [66]; curved
  labels with angles precomputed at +0.33/+0.66/+0.99 zoom and interpolated
  in the shader [67]; grapheme regex compiled once (per-char RegExp was a
  "noticeable slowdown"), a missing Khmer range caused wrong glyphs [68];
  snapping only when still [69]; shader-side, not CPU-side [70]; variable
  font weight ranges, 3 s FontFaceObserver timeout [71]; measureText caches
  with pruning and stale-entry bugs [72]; label atlases capped at 2048 px
  [73]. Halos bled when one Canvas render was cut into pieces, because
  `measureText` ignores stroke width [67].
- tangram-es: alfons with per-run HarfBuzz, bidi, fallbacks, growable
  refcounted atlases, one VBO per atlas texture; multi-texturing postponed;
  `std::toupper` stays Latin-only because ICU is heavy [74]; CSS-named
  font properties with Android `fonts.xml` lookup [75]; loading all Android
  fallback fonts raised native heap 12 MB to 66 MB [76]; SDF multisampling
  off by default [77]; SDF radius and blur scaled by pixel ratio [78];
  complex-shaping scripts not curved, labels dropped when glyphs would face
  both ways, Burmese later re-enabled [79].
- maptalks: glyph SDFs in a worker with OffscreenCanvas, persisted in
  IndexedDB because the Cache API only works on https and localhost [80].
- kothic: approximate letter width for curved-label boxes after 40% from
  fewer measure calls [81]; `globalAlpha` on text replaced a 247-line
  colour parser [82].

## d3-geo, openglobus, iTowns, vts-browser-js, WorldWind, osgearth

- d3-geo: `digits` option, Math.round and string concatenation for SVG
  output (benchmarked faster than join and toFixed) [83].
- openglobus: MSDF atlases fetched on demand from a font URL; regenerated
  with msdf-atlas-gen into a texture array; atlas PNG 0.56 MB to 2.7 MB;
  premultiplied blending [84].
- iTowns: DOM labels via a Label2DRenderer, not optimised for vector-tile
  density; store labels in geographic coordinates, not tile-local [86];
  positions rounded to whole pixels [85].
- vts-browser-js: custom .fnt keeping cmap, hmtx and GSUB (Arabic shaping),
  6-7 bytes per glyph, lazily loaded 256x256 4-plane SDF pages, bidi in the
  worker [87].
- WebWorldWind: one Canvas2D texture per string + attribute state key,
  aged 100x faster in the GPU cache [88]. WorldWindJava: device-pixel event
  space [89]; 2,108-line fork of JOGL's TextRenderer deleted for upstream
  [90].
- osgearth: snap to floor+0.5 while the view matrix is unchanged [91]; SDF
  by exact EDT on the CPU, a later math fix made SDFs narrower [92].

## Mapnik

- HarfBuzz since 3.0, with a placement regression fixed in 3.0.1 [93][94];
  single path, no ICU fast path [95]; shaping cache keyed in font units,
  plus glyph-metric, hb font and font set caches [100]; fallback by
  shaping only uncovered ranges, checked on ~45M OSM names, vertical
  writing unsupported [97].
- Fast halo rasteriser, ~2x in the benchmark; grid renderer skips the
  stroker [93][98]. Shared cross-thread glyph cache dropped: benchmark swung
  15.7-60.9 s, then matched master at 10.5 s; segfaults from another
  thread's FT_Face [96]. Script-run paren stack: masked ring buffer
  replaced by a vector reserved at 16 [99].

## MapServer, TileMill

- MapServer 7.0: bitmap fonts removed, DejaVu Sans Condensed compiled in,
  HarfBuzz and FriBidi on by default [101]; fontcache keyed by
  (codepoint, size), GD renderer dropped, HarfBuzz later optional [107];
  per-thread font cache by default, global locked cache opt-in [108];
  '?' for missing glyphs [109].
- ANGLE FOLLOW: one glyph at a time along the longest part, per-glyph
  outlines in the label cache, reject above 1.5x feature length or ~80% of
  180 degrees between characters [102]; MAXOVERLAPANGLE 22.5 degrees,
  opt-in [104]. Halos: 4 then 8 offset redraws, then a stroker [103].
  Number formatting with `round()` in TEXT expressions, not in the reader
  [105]. FriBidi reordering, only when ENCODING is declared [106].
- TileMill: HiDPI via a render-time `scale_factor`; 512 px tiles reverted;
  every symbolizer must honour the factor, as a float [110].
