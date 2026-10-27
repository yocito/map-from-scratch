---
name: text-rendering
description: How 40 map engines draw label text (DOM vs Canvas2D vs bitmap/SDF/MSDF glyph atlases, where glyphs come from, CJK, shaping and bidi, halos, atlas packing, pixel snapping, device pixel ratio) and what a purpose-built renderer should bake instead. Load it when a map-from-scratch request puts text on the map itself (place names, road names, values, labels that pan, zoom or rotate with the map, Japanese/CJK or RTL labels, halos), before writing spec.yaml architecture_selection or bake.ts for the labels.
---

# Text on the map: glyphs, shaping, halos and atlases

Text is the part of a map renderer that pulls in the most machinery: fonts,
a rasteriser, shaping and bidi for non-Latin scripts, a glyph atlas and its
packing, halos, collision, and sharpness at every pixel ratio. General
engines carry all of it because they cannot know which strings and scripts
will appear. A renderer made for one request usually knows its label set at
bake time, so most of that machinery can move into `bake.ts` or disappear.
This skill collects what the engines decided and why, so the choice can be
made from evidence. Label placement and collision are a separate topic (the
`label-placement` skill next to this one); only the parts that touch text
drawing are here. Per-engine detail is in
[references/engines.md](references/engines.md).

## First decision: does the text need to be drawn by the renderer?

| The request needs | Draw text with | Evidence |
| --- | --- | --- |
| a caption, a name on tap | the DOM, outside the renderer | already the repo's pattern (01, 02, 03) [111]; DOM labels are fine for few labels but were not fast enough at vector-tile density in iTowns [86] |
| a few dozen fixed labels, no rotation, no continuous zoom | Canvas2D `fillText` on the map canvas or an overlay | platform shaping, RTL and Indic for free with web fonts [65]; WebWorldWind draws one Canvas2D texture per string and caches it by text attribute state [88]; canvas text cannot rescale with continuous zoom [24] |
| many labels on a map that pans, zooms or rotates | a glyph atlas with one quad per glyph, styling in the shader | per-glyph `fillText` fell from 60 to 20 fps at ~600 glyphs on a tilted view, a glyph atlas restored 60 fps [50]; cached label bitmaps go blurry when the map rotates [56] |
| labels that scale, rotate or carry halos | SDF glyphs in that atlas | one glyph set per font for every size; size, colour and outline become shader parameters [41]; MapLibre, Cesium, tangram-es, navara, openglobus all converged on SDF or MSDF [2][41][78][33][84] |
| sharp corners at very large text sizes | MSDF | navara offers SDF ('low') and MSDF ('high') [33]; openglobus ships MSDF [84] |
| crisp text at extreme sizes | do not render glyph outlines on the GPU | navara tried Slug-like outline rendering and dropped it (slow with colour emoji, complex shader) [33]; maplibre-rs rejected Slug as patented, and tessellated glyphs gave ~1k glyphs at ~40 FPS [24] |

Write the choice and the rejected rows into `architecture_selection`. If
the answer is the DOM, stop here.

## Decisions the engines made

### Where glyphs come from

- **Server glyph PBFs, 256 code points per file, SDF at 24 px with a 3 px
  buffer** is MapLibre's format [2][50]. Block granularity is wasteful: a
  Tokyo z14 window used 1,339 distinct glyphs but fetched 44,288 slots, 3.0%
  utilisation; keeping only the needed glyphs cut the glyph bank from
  22-26 MB to 0.25-0.91 MB with byte-identical output (reearth-papers) [35].
- **CJK is rasterised locally instead of downloaded.** MapLibre GL JS and
  Native draw CJK ideographs and Hangul (later kana) with TinySDF from a
  local font [6][11][17]; Native also leaves them out of offline packs to
  save bandwidth and storage [14]. The price is appearance that depends on
  the device font [14][17]. Local glyphs are drawn at 2x (48 px) because 1x
  lost fine strokes, costing 4x atlas area per glyph [5][13][14].
- **A headless or self-contained renderer has no local font to fall back
  on**: reearth-papers' CJK labels silently vanished until it composited
  Noto Sans CJK into its own glyph PBFs; Han unification then forced it to
  pick SC or TC letterforms per tile by region, because a JP-first default
  drew Japanese forms for Chinese place names [39].
- **Missing glyphs must not crash, and a failed fetch is not absence.**
  MapLibre renders locally when a glyph PBF fails [3]; MapServer substitutes
  '?' instead of failing the layer [109]; reearth-papers settles a code
  point as absent only from a block that arrived and parsed, because one
  transient error would otherwise drop that character for the isolate's
  lifetime [37]. MapLibre Native's offline failures came from treating
  glyphs as HTTP-cacheable: an error response overwrote good cached glyphs
  and some tiles silently stopped updating [16]; Native otherwise treats
  glyph PBFs as immutable [19].
- **Ship only the fonts and ranges used**: Native stopped adding default
  fonts for icon-only symbol layers, saving ~15 MB [23]; MapServer embeds a
  whole TrueType font as a 3.4 MB source header [101]; openglobus's
  full-charset MSDF atlas PNG grew to 2.7 MB [84].

### Shaping, bidi and code points

- **MapLibre GL JS does no complex shaping**: one code point, one glyph;
  RTL needs a plugin; `font-faces` widens coverage but not shaping [2].
  Native keeps HarfBuzz + FreeType behind a build flag because it adds 11%
  (+15.3 MiB file on Linux, +1.47 MiB on iOS), and downloading code at run
  time was ruled out for iOS [15].
- **Mapnik chose one HarfBuzz path with no ICU shortcut** to fix Bengali and
  Khmer, although ICU was ~30x faster in a benchmark; text layout became the
  slowest part of 3.x [95]. A decade later it added caches of shaping
  results keyed before text size is applied, so one entry serves every
  zoom [100]. Its shaping-driven font fallback was validated against ~45
  million unique OSM names: 1,871 differed, 1,577 of them as intended [97].
- **Iterate code points, not UTF-16 units.** MapLibre GL JS switched so
  surrogate pairs are not split, making names like 嘎味𩵚魠魚焿 render [4];
  Native keeps label text in UTF-16 and is BMP-only in practice [20].
- **Split text into graphemes, not characters, when glyphs are placed one by
  one along a line**: OpenLayers uses `Intl.Segmenter` so ligatures are not
  cut [57]; tangram splits into 2-character segments on grapheme clusters,
  1 character for RTL, and does not curve contextual scripts such as
  Mongolian [66][68]; tangram-es refuses to curve Arabic and Indic scripts
  [79]; ortho-earth draws any run needing shaping as one sprite [50].
- **Bidi must be resolved on the whole string before splitting**: tangram's
  RTL curved and multi-line labels flipped punctuation because neutral
  characters at segment edges were laid out LTR [66]; MapServer runs
  FriBidi before layout [106]; reearth-papers' RTL label was six isolated
  letterforms running backwards until bidi and Arabic joining were applied
  [40].

### Halos

- **One pass for halo and fill.** MapLibre GL JS: about 40% less symbol GPU
  time, with a two-pass fallback when glyphs overlap (negative letter
  spacing, very wide halo) [1][13]. QGIS computing the text path once for
  buffer and fill: 40 s to 27 s on a benchmark [51]; a plain-text fast path
  cut render time by ~50% [53]. MapServer used to redraw the string in 8
  offset directions (4 left gaps in 'i' and 'l') before moving to a stroked
  outline [103].
- **Small halos can be cheap**: Mapnik's 'fast' halo rasteriser roughly
  doubled text rendering speed in its benchmark and is used automatically
  below radius 1 [93][98].
- **SDF halo width is capped by the SDF buffer** [50]; size each atlas frame
  as fontSize + 2 x buffer, or halos clip (deck.gl broke this twice) [49];
  compute collision boxes from glyph metrics, not from the padded quad [44].

### Atlas and GPU layout

- **Pack once when the set is known.** MapLibre GL JS dropped incremental
  shelf-pack growth for potpack over the full set [9]; Cesium's incremental
  atlas had to keep every source image in JS memory to rebuild on growth,
  because WebGL cannot read a texture back [42].
- **Power-of-two atlases if UVs are quantised**: Cesium's 12-bit UVs were
  wrong in large collections until the atlas was always power-of-two [46].
  Tangram caps a label texture at 2048 px for device limits [73].
- **Upload at most once per frame** with a sub-image update, never
  mid-render (MapLibre Native) [18].
- **One instanced draw per tile-layer, instance = glyph**; per-label state
  (fade, hide) in a texture so a change costs one texel, not O(glyphs)
  (navara) [31]. Size label storage by labelled features, not by features
  [31].
- **Quantised glyph offsets**: MapLibre stores int16 offsets in 1/32 px
  (from 1/64) to double the longest label [10][22]; Cesium keeps 2
  fractional bits to fix misaligned small text [45].
- **Shader precision and density**: MapLibre Native raised the SDF
  `gamma` in symbol_sdf from lowp to highp [21]; scale the SDF radius and
  blur with device pixel ratio [78]; tangram-es turned SDF multisampling off by default as
  imperceptible, costlier and broken on some phones [77].

### Sharpness

- **Snap glyph quads to the pixel grid only while the camera is still.**
  Tangram's always-on snapping shimmered during slow pans [69]; osgearth's
  per-label test jittered, so it compares the view matrix instead [91].
  Snap in the vertex shader, not by rounding positions on the CPU: view
  matrices move things off the grid anyway [70]. iTowns rounds DOM label
  positions to whole pixels [85].
- **One pixel space, chosen once**: WorldWindJava's HiDPI fix moved all
  events and picking to device pixels and still missed call sites [89].
  Showing a raster tile at a different pixel size than it was rendered
  for scales its baked labels: Leaflet's zoom+1 retina trick made city
  names too small to read, and reearth-papers' 512 px renders downscaled
  to 256 px showed every label at half size [63][38].

### Canvas2D text

- Cache `measureText` by font + DPR + string, with a bound [72]; kothic got
  40% faster label rendering by no longer measuring each letter repeatedly
  [81].
- Wait for fonts before drawing: wrong weights made FontFaceObserver hit
  its 3 s timeout and delay the first map; drawing early used the wrong font
  [71].
- Free evicted canvases by setting width and height to 0 [59].

## Tried and reverted

- navara: GPU outline (Slug-like) glyphs, dropped for SDF/MSDF [33]; merging
  the font worker into the general worker, reverted [34]; `fontsdf` replaced
  because it produced wrong SDFs for Roboto [34].
- Cesium: tiny-sdf integrated, then replaced by bitmap-sdf over its own
  canvas text within five weeks [43].
- MapLibre GL JS: fixing the hard-coded vertical alignment was declined
  because the constants are tuned to specific fonts [5].
- OpenLayers: the global label bitmap cache, deprecated in 6.2 and removed
  in 7.0 [56]; vector-tile 'image' mode, removed because text rotated with
  the view and labels were cut at tile edges [58].
- tangram: word-break 'articulated' labels replaced by 2-3 letter quads with
  angles precomputed at 3 fractional zooms [67]; CPU pixel rounding (PR
  closed) [70].
- tangram-es: multi-texturing several glyph atlases in one mesh, postponed
  because CJK panning kept 10+ atlases alive anyway [74].
- Mapnik: a locked glyph cache shared across threads, dropped as no faster
  [96]. MapServer: GD stroker route closed [103]. TileMill: 512 px HiDPI
  tiles reverted [110].

## Guidance for a renderer in this repo

1. **Bake the label set, then decide.** In `bake.ts`, collect every string
   that will be drawn and print the distinct code points per script. A
   fixed set of Latin plus kana and a few hundred kanji is a small atlas;
   256-code-point glyph files fetched ~33x more glyph slots than a Tokyo
   view used [35].
2. **Bake the atlas, do not fetch glyph ranges or rasterise at run time.**
   The engines that rasterise at run time (TinySDF, font workers,
   incremental packing) do so because the text is not known in advance
   [6][32][42]. The base image already has Chromium and `fonts-noto-cjk`
   [112], so a bake step can rasterise each needed glyph once and convert
   it to SDF with the exact Felzenszwalb-Huttenlocher distance transform,
   the algorithm of MapLibre Native's TinySDF port, which osgearth also
   chose over GPU jump flooding [17][92]. Pack once with a potpack-style
   packer into a power-of-two texture [9][46]. Start at 24 px / 3 px buffer like MapLibre,
   or 32 px / 6 px if halos are wide; use 48 px for dense CJK glyphs that
   must stay legible [50][5]. Fix the font, so output is identical on every
   device (local fonts are not) [3][14].
3. **Shape at bake time if any script needs it.** Arabic, Indic and
   Southeast Asian scripts need shaping and bidi; Latin and CJK do not [2]
   [15]. Instead of shipping a shaper, store positioned glyph runs (glyph,
   x, y) from the bake, or bake each such label as one sprite [50][95].
   Latin/CJK-only data skips this entirely.
4. **Check coverage at bake time, fail loudly.** A missing glyph should stop
   the bake with the string that needed it, not fall back to '?' or vanish
   [109][39]. Add a `verification.checks` item that compares drawn labels
   against the baked list.
5. **Draw: one instanced draw, halo and fill in one fragment pass**, glyph
   offsets quantised from the longest label, SDF gamma in highp, radius
   scaled by DPR [31][13][10][21][78]. Snap to device pixels only when idle
   [69][91].
6. **Skip what the request does not need**: curved labels (only for road or
   river names; then split at graphemes and use per-glyph collision boxes
   [57][64]), runtime atlases, workers for fonts, glyph caches and
   eviction. A static set needs a packed buffer, not an allocator [31].
7. **Measure** atlas bytes (gzip), glyph count, text draw GPU time, and
   first-frame delay caused by font or atlas loading; record them in
   `performance_knowledge`.

## Sources

Local paths are relative to the repository; `rr/` is `ref-repos/`.

1. `rr/maplibre__maplibre-gl-js/CHANGELOG.md` (#7436, #4564, #3006, #8237, #8337, #8535)
2. `rr/maplibre__maplibre-gl-js/developer-guides/unicode.md`
3. https://github.com/maplibre/maplibre-gl-js/pull/4564 ; https://github.com/maplibre/maplibre-style-spec/pull/1068
4. https://github.com/maplibre/maplibre-gl-js/pull/6640
5. https://github.com/maplibre/maplibre-gl-js/pull/3006
6. https://github.com/maplibre/maplibre-gl-js/commit/7bb211344
7. https://github.com/maplibre/maplibre-gl-js/commit/726af278a
8. https://github.com/maplibre/maplibre-gl-js/commit/2313006d8 ; https://github.com/maplibre/maplibre-gl-js/commit/79b3de167
9. https://github.com/maplibre/maplibre-gl-js/commit/311054442 ; https://github.com/maplibre/maplibre-gl-js/commit/8dd624d4e
10. https://github.com/maplibre/maplibre-gl-js/commit/c340ebe3d
11. https://github.com/maplibre/maplibre-gl-js/commit/9f833c69a ; https://github.com/maplibre/maplibre-gl-js/commit/0c931d8f9 ; https://github.com/maplibre/maplibre-gl-js/commit/97ba78bfc ; https://github.com/maplibre/maplibre-gl-js/commit/a2afce62c
12. https://github.com/maplibre/maplibre-gl-js/commit/a49fea4eb
13. https://github.com/maplibre/maplibre-gl-js/commit/018c3a089 ; https://github.com/maplibre/maplibre-gl-js/pull/7436 ; https://github.com/maplibre/maplibre-gl-js/commit/c162f49ec
14. `rr/maplibre__maplibre-native/platform/ios/CHANGELOG.md` ; `rr/maplibre__maplibre-native/platform/android/CHANGELOG.md` ; `rr/maplibre__maplibre-native/CHANGELOG.md`
15. https://github.com/maplibre/maplibre-native/pull/1439
16. https://github.com/maplibre/maplibre-native/issues/2410
17. https://github.com/maplibre/maplibre-native/commit/2e3e88f02 ; https://github.com/maplibre/maplibre-native/commit/f1f2ebb01
18. https://github.com/maplibre/maplibre-native/commit/78073d6fd
19. https://github.com/maplibre/maplibre-native/commit/a88e58ef3 ; https://github.com/maplibre/maplibre-native/commit/73ddff60a
20. https://github.com/maplibre/maplibre-native/commit/40b0c8d07
21. https://github.com/maplibre/maplibre-native/commit/458de43b9
22. https://github.com/maplibre/maplibre-native/commit/673f9e364804b4c3f449c8619e767a7b40e5350e
23. https://github.com/maplibre/maplibre-native/commit/ce429dcc1fce2a827e5c9462e3226c3bb04c6a39 ; https://github.com/maplibre/maplibre-native/commit/b7e2b11a75fd1b12d0ff948b9602fcd3db3779cf
24. https://github.com/maplibre/maplibre-rs/blob/main/docs/src/development-documents/font-rendering.md ; `rr/maplibre__maplibre-rs/maplibre/src/legacy/glyph_atlas.rs`
25. https://github.com/maplibre/maplibre-rs/issues/36 ; https://github.com/maplibre/maplibre-rs/pull/314
26. https://github.com/maplibre/maplibre-rs/commit/0d70a47 ; https://github.com/maplibre/maplibre-rs/commit/1ea2b5c ; `rr/maplibre__maplibre-rs/maplibre/src/legacy/mod.rs`
27. `rr/maplibre__maplibre-tile-spec/docs/benchmarks.md` ; `rr/maplibre__maplibre-tile-spec/docs/encodings.md` ; https://github.com/maplibre/maplibre-tile-spec/blob/main/docs/benchmarks.md ; https://github.com/maplibre/maplibre-tile-spec/blob/main/docs/encodings.md
28. https://github.com/yuiseki/maplibre-tile-spec/commit/e2da710d ; https://github.com/yuiseki/maplibre-tile-spec/commit/92207bdd ; https://github.com/yuiseki/maplibre-tile-spec/commit/816ecece
29. https://github.com/yuiseki/maplibre-tile-spec/commit/d52cf9b0
30. https://github.com/yuiseki/maplibre-tile-spec/commit/c9c39700
31. `rr/maplibre__navara/guide/TEXT_BATCHING.md` ; https://github.com/maplibre/navara/blob/main/guide/TEXT_BATCHING.md
32. https://github.com/maplibre/navara/pull/464
33. https://github.com/maplibre/navara/pull/599
34. https://github.com/maplibre/navara/commit/04a7e1f7 ; https://github.com/maplibre/navara/commit/d0b0d573
35. https://github.com/reearth/reearth-papers/commit/9e766d6 ; https://github.com/reearth/reearth-papers/commit/26acd28 ; `rr/reearth__reearth-papers/src/glyphs.ts`
36. https://github.com/reearth/reearth-papers/commit/eabf229 ; `rr/reearth__reearth-papers/src/ezu.ts`
37. https://github.com/reearth/reearth-papers/commit/6af6885
38. https://github.com/reearth/reearth-papers/commit/1d03b9a ; https://github.com/reearth/reearth-papers/commit/be79e3c
39. https://github.com/reearth/reearth-papers/commit/03a3a69 ; https://github.com/reearth/reearth-papers/commit/1be9d0f ; `rr/reearth__reearth-papers/src/cjk_flavor.ts`
40. https://github.com/reearth/reearth-papers/commit/30e194f
41. `rr/CesiumGS__cesium/CHANGES.md` ; https://github.com/CesiumGS/cesium/pull/7730 ; https://github.com/CesiumGS/cesium/pull/4675
42. https://github.com/CesiumGS/cesium/pull/69
43. https://github.com/CesiumGS/cesium/commit/6ecbc24b6 ; https://github.com/CesiumGS/cesium/commit/a95fe745d ; https://github.com/CesiumGS/cesium/commit/1794ab2d5 ; https://github.com/CesiumGS/cesium/commit/51d99f4ab
44. https://github.com/CesiumGS/cesium/commit/fe52af325
45. https://github.com/CesiumGS/cesium/commit/e946c0260ce760cda8388a7f3699328e3eff35e2
46. https://github.com/CesiumGS/cesium/commit/3c400241a1a82ea25539c81966189e93f683c219 ; https://github.com/CesiumGS/cesium/commit/0a49108a5025feb5e2f6a420ccd58919e39061f3
47. https://github.com/CesiumGS/cesium/commit/6f1487bdd2abdb335c7692f282d9ff78dc9ed0d7 ; https://github.com/CesiumGS/cesium/commit/bb49820c84b359306ca7c6d252ecd92f281916f5
48. https://github.com/visgl/deck.gl/commit/d1d64502 ; https://github.com/visgl/deck.gl/commit/c5472c3b
49. https://github.com/visgl/deck.gl/commit/48219354 ; https://github.com/visgl/deck.gl/commit/cc1d5190
50. `rr/kenjiyoshidahome2026-bit__ortho-earth/packages/ortho-core/text gpu plan.md` ; https://github.com/kenjiyoshidahome2026-bit/ortho-earth/blob/main/packages/ortho-core/text%20gpu%20plan.md
51. `rr/qgis__QGIS/ChangeLog` (2024-10-11, refactor QgsTextRenderer) ; https://github.com/qgis/QGIS/commit/7a17557e64
52. https://github.com/qgis/QGIS/commit/81b546c21c
53. https://github.com/qgis/QGIS/commit/b2d2fc9e28
54. https://github.com/OSGeo/grass/commit/d757e423d
55. https://github.com/KDE/marble/commit/09ecae215
56. `rr/openlayers__openlayers/changelog/v6.2.0.md` ; `rr/openlayers__openlayers/changelog/v7.0.0.md`
57. `rr/openlayers__openlayers/changelog/upgrade-notes.md` ; `rr/openlayers__openlayers/changelog/v10.10.0.md`
58. https://github.com/openlayers/openlayers/commit/45ba5792c
59. https://github.com/openlayers/openlayers/commit/a24c94487 ; https://github.com/openlayers/openlayers/commit/e37734826 ; https://github.com/openlayers/openlayers/commit/335648d61
60. https://github.com/openlayers/openlayers/commit/820299685 ; https://github.com/openlayers/openlayers/commit/650177ffb ; https://github.com/openlayers/openlayers/commit/1bbd138fb ; https://github.com/openlayers/openlayers/commit/dd163f53c ; https://github.com/openlayers/openlayers/commit/ce2d95ee8
61. https://github.com/openlayers/ol2/pull/140
62. https://github.com/Leaflet/Leaflet/issues/3697 ; https://github.com/Leaflet/Leaflet/issues/3297
63. https://github.com/Leaflet/Leaflet/commit/443181af ; https://github.com/Leaflet/Leaflet/commit/de1a62fa
64. `rr/protomaps__protomaps-leaflet/src/line.ts` ; `rr/protomaps__protomaps-leaflet/src/symbolizer.ts`
65. `rr/protomaps__protomaps-leaflet/README.md` ; https://github.com/protomaps/protomaps-leaflet/issues/121
66. https://github.com/tangrams/tangram/blob/master/src/styles/text/text_segments.js ; `rr/tangrams__tangram/src/styles/text/text_segments.js` ; https://github.com/tangrams/tangram/issues/541
67. https://github.com/tangrams/tangram/pull/484 ; https://github.com/tangrams/tangram/pull/360
68. https://github.com/tangrams/tangram/pull/555
69. https://github.com/tangrams/tangram/issues/453 ; https://github.com/tangrams/tangram/pull/583
70. https://github.com/tangrams/tangram/pull/454
71. https://github.com/tangrams/tangram/pull/757
72. https://github.com/tangrams/tangram/commit/816b0ab9 ; https://github.com/tangrams/tangram/commit/2d89e112 ; https://github.com/tangrams/tangram/commit/b4918a8f ; https://github.com/tangrams/tangram/commit/98cd5f80
73. https://github.com/tangrams/tangram/commit/ce89744c ; https://github.com/tangrams/tangram/commit/8b8c81f3 ; https://github.com/tangrams/tangram/commit/bdf680ef
74. https://github.com/tangrams/tangram-es/pull/506
75. https://github.com/tangrams/tangram-es/pull/256 ; https://github.com/tangrams/tangram-es/pull/1092
76. https://github.com/tangrams/tangram-es/pull/649
77. https://github.com/tangrams/tangram-es/commit/107c14fa ; https://github.com/tangrams/tangram-es/commit/c0823152
78. https://github.com/tangrams/tangram-es/commit/cef31f34 ; https://github.com/tangrams/tangram-es/commit/bd4123de ; https://github.com/tangrams/tangram-es/commit/68bc6d85 ; https://github.com/tangrams/tangram-es/commit/93226531
79. https://github.com/tangrams/tangram-es/commit/8ce5dd0c ; https://github.com/tangrams/tangram-es/commit/cd2b5842 ; https://github.com/tangrams/tangram-es/commit/c14a37c4 ; https://github.com/tangrams/tangram-es/commit/ab55001e ; https://github.com/tangrams/tangram-es/commit/6306803b
80. https://github.com/maptalks/maptalks.js/commit/6acc6f4f1 ; https://github.com/maptalks/maptalks.js/commit/e55e965e7 ; https://github.com/maptalks/maptalks.js/commit/d384122a1
81. https://github.com/kothic/kothic-js/commit/9c7af85 ; https://github.com/kothic/kothic-js/commit/7bda3c2 ; `rr/kothic__kothic-js/src/renderer/text.js`
82. https://github.com/kothic/kothic-js/commit/e98f1f0
83. https://github.com/d3/d3-geo/pull/272 ; `rr/d3__d3-geo/src/path/string.js`
84. https://github.com/openglobus/openglobus/commit/517b2eef ; https://github.com/openglobus/openglobus/commit/1a0200b4 ; https://github.com/openglobus/openglobus/commit/0215166f ; `rr/openglobus__openglobus/src/utils/FontAtlas.ts`
85. https://github.com/iTowns/itowns/commit/5d0ca6f
86. https://github.com/iTowns/itowns/pull/1303
87. https://github.com/melowntech/vts-browser-js/commit/bd080be ; https://github.com/melowntech/vts-browser-js/commit/b1b0043 ; https://github.com/melowntech/vts-browser-js/commit/8ced6dd ; `rr/melowntech__vts-browser-js/tools/font-generator/index.js` ; `rr/melowntech__vts-browser-js/src/core/map/geodata-processor/worker-font.js` ; `rr/melowntech__vts-browser-js/src/core/renderer/gpu/font.js`
88. https://github.com/NASAWorldWind/WebWorldWind/commit/4e752b1 ; `rr/NASAWorldWind__WebWorldWind/src/render/TextRenderer.js`
89. https://github.com/NASAWorldWind/WorldWindJava/issues/195 ; https://github.com/NASAWorldWind/WorldWindJava/pull/262 ; https://github.com/NASAWorldWind/WorldWindJava/pull/274
90. https://github.com/NASAWorldWind/WorldWindJava/commit/017d91e
91. https://github.com/pelicanmapping/osgearth/commit/24d8c57fc3d3c2a5428640a002a14a21ac546e84 ; https://github.com/pelicanmapping/osgearth/commit/b1cf3ef4419cea4e5c75a08f41e2dd11b2c6ae73 ; https://github.com/pelicanmapping/osgearth/commit/c6d14eed38322f9c859c1a7a6e1e0577b5a3f5eb
92. https://github.com/pelicanmapping/osgearth/commit/872f41d45 ; https://github.com/pelicanmapping/osgearth/commit/069e61f8a ; https://github.com/pelicanmapping/osgearth/commit/9e621cbfd ; https://github.com/pelicanmapping/osgearth/commit/b83990e65
93. https://github.com/mapnik/mapnik/blob/master/CHANGELOG.md ; https://github.com/mapnik/mapnik/issues/1781 ; https://github.com/mapnik/mapnik/issues/1298
94. https://github.com/mapnik/mapnik/issues/2963
95. https://github.com/mapnik/mapnik/issues/2043 ; https://github.com/mapnik/mapnik/issues/1714 ; https://github.com/mapnik/mapnik/issues/1208
96. https://github.com/mapnik/mapnik/pull/2265 ; https://github.com/mapnik/mapnik/issues/2209
97. https://github.com/mapnik/mapnik/pull/4557 ; https://github.com/mapnik/mapnik/pull/4560
98. https://github.com/mapnik/mapnik/commit/e66d00762 ; https://github.com/mapnik/mapnik/commit/e313b5ba6
99. https://github.com/mapnik/mapnik/commit/1edd3b7a9 ; https://github.com/mapnik/mapnik/commit/33fac6d47 ; https://github.com/mapnik/mapnik/commit/9dac8dcc3 ; https://github.com/mapnik/mapnik/commit/fc25053e8
100. https://github.com/mapnik/mapnik/commit/34d9f178e ; https://github.com/mapnik/mapnik/commit/b0fee1645 ; https://github.com/mapnik/mapnik/commit/f0fe7b036 ; https://github.com/mapnik/mapnik/commit/c2d5b8788
101. `rr/MapServer__MapServer/HISTORY.md` ; `rr/MapServer__MapServer/src/fontcache.c` ; https://mapserver.org/development/rfc/ms-rfc-98.html ; https://mapserver.org/development/rfc/ms-rfc-104.html
102. https://github.com/MapServer/MapServer/issues/1620
103. https://github.com/MapServer/MapServer/issues/1243
104. https://github.com/MapServer/MapServer/issues/3523
105. https://github.com/MapServer/MapServer/issues/2950
106. https://github.com/MapServer/MapServer/issues/956
107. https://github.com/MapServer/MapServer/commit/18b51c4a ; https://github.com/MapServer/MapServer/commit/e9e306a0 ; https://github.com/MapServer/MapServer/commit/ff83a55d
108. https://github.com/MapServer/MapServer/commit/b74fd63f ; https://github.com/MapServer/MapServer/commit/31916420
109. https://github.com/MapServer/MapServer/commit/a82083c2
110. https://github.com/tilemill-project/tilemill/issues/1531 ; `rr/tilemill-project__tilemill` commits 1147d33a, c564573b, f79774e6
111. `skills/map-from-scratch/references/patterns.md` (Interaction: "Text in the DOM")
112. `docker/base/Dockerfile` (chromium, fonts-noto-cjk)
