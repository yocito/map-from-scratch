---
name: vector-tile-encoding
description: How 37 map engines lay out vector geometry and attributes in a tile or baked binary (integer grid and extent, framing and versioning, columnar vs record layout, which encodings pay, pre-triangulation, ids, clipping at bake time), and how they decode foreign tiles (MVT, MLT, PMTiles) at run time. Load it when a map-from-scratch request needs tiles or a multi-zoom baked format, when bake.ts must clip data into tiles, when a renderer must read MVT/MLT/PMTiles at run time, or when choosing quantisation, compression or triangles-vs-outlines for a binary format.
---

# Vector tile encoding: what to put in a tile, and what to leave out

Every engine that draws vector data splits it into pieces the client can
fetch, keep and draw independently, and every one of them then has to decide
the same things: how coordinates are quantised, how a reader finds features and
vertices, how attributes and strings are stored, whether triangles ship or are
rebuilt, what happens to features cut at tile edges, and how the format can
change later. General engines must also read formats they did not design
(MVT, MLT, PMTiles), and much of their effort goes into undoing those
formats' choices at run time. A renderer here owns its bake step (the rule in
skills/map-from-scratch/SKILL.md), so most of those run-time costs can be paid
once in `bake.ts`. This skill says which choices the engines measured, which
paid, and which they reverted. It does not repeat patterns.md (projection at
bake time, 16-bit quantisation over the bounding box, delta coding, Morton
order, draw order at bake time); read that first.

Per-engine detail: [references/engines.md](references/engines.md).

## Decision 0: do you need tiles at all?

- All seven current examples ship untiled files (up to 17 MB gzip of data)
  [102]. Tiles cost per-tile headers, clipping, seams, and cross-tile
  identity; take them only when one view needs a small fraction of the data or
  the zoom range needs different detail per level.
- ortho-earth's GeoPBF deliberately has no spatial index and no partial reads:
  2.2-3.1 bytes per vertex on dense data, loaded whole [55][56]. Its advice:
  quantise-and-delta when the renderer loads everything anyway; a format with
  row-group or index-based partial reads when the client needs only the
  viewport of a big remote file [55].
- MLT's columnar layout wins on large tiles and loses on small ones: on the
  OpenMapTiles median tile (422 B as gzipped MVT) MLT v1 is 524 B
  uncompressed, and MLT v1 + gzip (428 B) decodes in 117% of gzipped MVT's
  time, while the largest 1% of tiles shrink 2.13x against plain MVT [1]. Many tiny tiles pay header overhead that a few large
  ones do not.
- Marble publishes vector tiles only at odd zoom levels 1-17, halving bake
  output; the client draws each level across two zoom steps [73].

## Coordinates and framing

- **Integer grid per tile, origin at the tile corner, overshoot allowed.**
  MVT/MLT use a per-layer extent (default 4096); coordinates may be negative
  or exceed the extent, and tiles carry no world position, so identical tiles
  (open water) are stored once [2]. MapLibre Native normalises every tile to
  8192, i.e. 1/16 pixel at 512 px tiles [24]. Tangram stores tile-local
  0..4096 as `gl.SHORT` and heights in 1/16 m units [100]. A larger extent
  costs bytes [2]. Pick the extent from the deepest overzoom you will draw:
  tile pixels x 2^overzoom x subpixel steps.
- **Keep the tile's world offset out of the vertex data and out of the model
  matrix's translation.** deck.gl first put a translate in the per-tile
  modelMatrix and later moved the offset to `coordinateOrigin` to fix
  projection precision, leaving only scale in the matrix [50][48]. Converting
  every vertex back to lng/lat on the CPU was rejected as a "significant perf
  cost" [48]. This tile-local layout does not carry over to a globe: deck.gl
  turns its binary path off for GlobeView [54].
- **Little-endian, aligned for typed-array views.** MLT switched its integers
  from big- to little-endian for performance and to match other
  implementations [20]. Cesium shipped a misaligned-offset bug; the correct
  padding is `off += (4 - off % 4) % 4`, not `off += off % 4` [44]. GRASS
  writes its files in machine-native order with a little/big-endian flag, and
  files in either order can be read [65].
- **Version per chunk, skippable, never changed once final.** MLT frames are
  `size, tag, body`; the tag follows the size so it is one byte that can be
  skipped without varint parsing; a finalised tag never changes, new
  capabilities get a new tag [2]. Cesium's quantized-mesh replaced an
  extension bitfield with id + 32-bit length framing so clients skip unknown
  extensions [43]. GRASS files carry both a version and a minimum reader
  version [65]. For a single renderer that ships with its data, one magic +
  version word is enough; frames pay off when data and renderer update
  separately [2].
- **Derive counts instead of storing them.** MLT v2 cut stream headers to one
  byte by implying role, count and length from position and feature count,
  and dropped the types stream for single-type layers: uncompressed v2 is
  9-10% smaller than v1, median tile 442 B vs 524 B [4][1].

## Geometry layout

- **Counts/offsets, not drawing commands.** MLT stores geometries -> parts ->
  rings -> vertices as count streams; prefix sums give per-feature starts in
  ~0.006 ms on a 1.3 MB tile of 524,482 vertices vs ~3.8 ms for a full column
  decode [3]. That is what batching, picking and line labels need.
- **Ship the GPU layout.** deck.gl's performance guide says 99% of its CPU
  buffer-update time is accessor calls, and its roadmap says "binary first";
  apps pass typed arrays straight as attributes [46]. Parsing MVT straight to
  typed arrays and triangulating in the worker gave 1.94-2.4x tile throughput
  and cut a 988K-vertex viewport load from 6242 to 2713 ms; a 12K-vertex set
  gained only 13% [45]. Narrow attribute types are free wins: ortho-earth's
  Uint8 normalised colours cut geometry bytes from 16.28 to 9.20 MB with
  bit-identical positions [59].
- **Triangles or outlines: price it per layer.** Shipping triangles in MLT
  grew tiles 21.9-35.8% and made decode slower, +14% to +145% depending on
  data and version [1]. MLT's Rust encoder replaced a bool with
  `Tessellation::Auto(client, network)`, weighing transfer time (3G 4 us/B,
  4G 400 ns/B, 5G 40 ns/B, offline 0) against fitted earcut time with a 2x
  slowdown for a mid-range phone [8]. Triangles-only layers (no outlines) save
  little (+23.2% vs +24.9% on v2 OMT) [1], and a decoder can no longer stroke
  the outline or rebuild the encoded geometry [9]. Separately, MLT's Java
  decoder threw a NullPointerException on any polygons tessellated without
  outlines until it was changed to reject them with an explicit error [9].
- **Define ring closure and winding explicitly, and test decoded area.**
  mlt-core's decoded rings repeated the closing point while the baked
  triangles assumed they did not, misaligning holes (area 134.5 instead of 91)
  [26]. OpenLayers splits rings by winding only for tile features, trusting
  the MVT convention [97]. GeoPBF omits the closing vertex and restarts the
  delta chain per ring [55].
- **Size decode buffers from measured expansion.** MLT tiles decode to 5-17x
  their encoded size; a 20 MiB budget rejected multi-MB tiles and was raised
  to 128 MiB [26].

## Attributes and strings

- **Drop at bake time what no rule draws.** QGIS added an API so the decoder
  skips layers the style does not use, because OS ZoomStack carries buildings
  even at small scales [62]; ortho-earth's decoder skips string decoding for
  unused layers [60]. Marble chose the opposite (keeping tagged data it does
  not render) only because its tiles are a shared product [84]. GRASS stopped writing
  labels that map a value to itself ("1: 1") [72].
- **Flatten nested properties at bake time.** Tangram's `parse_json` parses
  stringified JSON in MVT properties, preferably only for named fields, because
  JS filter functions were an order of magnitude slower in Tangram ES and
  stringified values cannot be deduplicated in the MVT value table [101].
- **Which MLT encodings paid on basemaps.** Planet size (uncompressed) and
  decode time when one encoder option is toggled, OpenMapTiles / Protomaps
  [1][5]:

  | Encoding | Measured effect | Verdict for a small renderer |
  | --- | --- | --- |
  | shared dictionary across `name:*` | turning it off: size +25.4% / +0.8%, decode +15..27% / +1..2% | yes, if many label languages |
  | FastPFOR (vs varint) | off: size +2.6..3.4%, decode +11..15% | no; varint or bitpacking is enough [6] |
  | bitpacked dictionary codes | off: size +0.7% / +0.3%, decode +1% / 0% | yes, simple |
  | delta2 for dense lines | on: size -0.5..-0.6%, decode 0..+1% | only for smooth dense lines |
  | FSST strings | off: size +0.2..0.8%, decode 0..3% faster | no |
  | feature sorting | `--sort all`: size -0.4% / -0.1%, decode within 1% | no; keep draw order |
  | ALP, float dictionary | off: size +0.0..0.1% | no; quantise floats to ints |
  | rANS on vertices | on: size -5.4% / -5.3%, decode +16% / +88% | no, unless bytes dominate |

  rANS on plain v2 vertex streams cut total size 15-20% in another
  measurement; OMT decode was unchanged but two smaller tilesets slowed
  (amazon 5.4 -> 8.3 ms, bing 3.3 -> 6.35 ms) [10]. FastPFOR's SIMD
  output did not match the non-SIMD decoder and would not build on ARMv7, so
  the C++ side vendored it without SIMD [18].
- **Measure after transport compression.** On the OMT median tile, plain MVT
  decodes in 40% of gzipped MVT's time [1]. Without compression MLT archives
  were larger than the gzipped MVT input [21]. GeoPBF is 5-17x smaller than
  GeoJSON raw but only 1.8-4.0x once both are gzipped [55].
- **Ids: assign your own, stable across tiles.** QGIS ignores MVT feature ids
  because real mbtiles reuse them across tiles [64]. deck.gl needed a stable
  feature id (`uniqueIdProperty`) so hover highlights every tile's piece of a
  clipped polygon [47]. MapLibre Native indexes a feature only in the tile it
  falls in and queries neighbouring tiles instead [29].

## Clipping and simplifying at bake time

- **Use a rectangle clipper, and keep vertex order.** Marble moved from its own
  Weiler-Atherton (glitches, endless loops) to Clipper, then to Clipper2's
  rect clip, mainly because rect clipping keeps vertex order, which one-way
  streets, cliffs and embankments depend on [75][87]. Elements wholly inside a
  tile pass through unclipped [86]. Closed line strings (boundaries) must be
  clipped as open lines, or a box-sized rectangle appears when the tile lies
  inside the ring [76]. Carry per-vertex ids through the clipper (Clipper2's z)
  rather than recovering them by coordinate lookup [88].
- **Simplify before clipping, and test small closed rings.** Marble's
  Douglas-Peucker lost roundabouts at level 15 and below [74], and dropping
  real nodes next to synthetic border nodes turned an L-shaped line into a
  diagonal [89].
- **Assert units at every quantisation.** Marble fed radians into a
  degree-scaled integer conversion and silently quantised ~60x coarser,
  destroying sub-meter structures [81]. Marble's o5m writer also measured a
  250-character limit in UTF-16 units instead of UTF-8 bytes, which garbled
  the string table [85].
- **Seams.** deck.gl rejected merging split polygons across tiles (turf union)
  in favour of independent tiles clipped per tile [48]; OpenLayers clips at
  the tile boundary so buffered polygons get no stroke at tile edges [95] and
  anchors fill patterns in world space on a 512 px grid [94]. Marble merges
  lines split across tiles by OSM id for better street labels [78].
- **Golden tests per tiny input.** Marble feeds one small OSM input per case
  and diffs every generated tile against a reference, known errors included,
  so each later clipper change shows up as a reviewable diff [92].

## Reading foreign tiles at run time

- **Write a flat decoder.** ortho-earth replaced `@mapbox/vector-tile` (a Point
  object per vertex) with a decoder into `{coords: Int32Array, ends}`:
  27.8 -> 18.0 ms on 37 tiles, bit-identical, bundle -4.5 kB [60]. OpenLayers
  dropped the same dependency and transforms coordinates once while parsing
  [96]. maplibre-rs stopped feeding MVT through an SVG path builder because
  MoveTo/LineTo/ClosePath semantics differ from SVG's [34].
- **Normalise every format to one internal representation, chosen explicitly.**
  ortho-earth decodes MVT and MLT (plugin) to the same flat structure and takes
  the format from the style or PMTiles `tileType`, never by sniffing [57];
  Cesium turns MVT into its own vector glTF through a codec interface and
  treats 404/204 as empty tiles [40]; its 2016 vector tiles had been a
  separate 3D-specific format [42]. MapLibre Native's maintainers lean to
  separate endpoints plus `encoding` over Accept negotiation [27].
- **PMTiles.** MapLibre Native reads a 127-byte header, the root directory,
  at most three leaf levels, then exactly the tile's range, and returns
  nothing for zooms outside the header without a request [30]. It checks gzip
  magic bytes instead of trusting the header's compression flag, and turns
  corrupt data into an error rather than a crash [31]. Details of Range reading
  belong to the data-range-requests know-how.
- **Do not materialise features as app objects.** Re:Earth deleted a per-feature
  mirror (md5 keys, two caches) and evaluates style while rasterising [38];
  deck.gl converts tile data to WGS84 only when the app reads it [52].

## Tried and reverted

- MLT: encoder profiles removed as premature, reintroduced once tessellation
  and encodings were priced per client and network [14]; ALP and Pseudodecimal
  removed as never implemented, ALP reintroduced exception-free with a bit-exact
  round-trip check [17][7]; Morton-RLE and plain Morton removed (sorted unique
  keys make delta win, and they crashed decoders) [11]; Hilbert and id
  sorting dropped from `auto` (<0.5% for >30% encode time) [13]; source order
  made the default [7]; a HyperLogLog gate never fired above ~1.5k vertices
  because of an inverted formula, replaced by an exact count [12].
- MapLibre GL JS kept MVT as the worker-to-main transfer format and fixed the
  encoder rather than ship raw objects, at the cost of dropping undefined
  property keys [33].
- Cesium removed its `dequantizeInShader` option and had to disable Draco
  quantisation for a release [39]; it decodes quantised attributes in the
  vertex shader rather than expanding them to floats [41].
- Marble abandoned border-point annotations: derived from already-clipped
  paths, they carried nothing a client could use [90][77].
- GRASS dropped hand-rolled RLE for zlib, then made ZSTD the default
  [68][71].

## For a renderer here

Do as the engines did:

- Quantise to a tile-local integer grid with a buffer, Uint16/Int16, offset
  per tile as a uniform, little-endian, 4-byte aligned, with a version word
  [2][24][50][44].
- Store counts/offsets and the exact GPU vertex layout, so the client uploads a
  slice of the fetched buffer [3][46].
- Assign your own ids at bake time, stable across tiles, if anything is picked
  or highlighted [64][47].
- Clip with an axis-aligned rect clipper after simplifying, pass contained
  features through, and keep golden tile tests [87][86][89][92].
- Report per-tile-size percentiles, compare compressed against compressed, and
  pick encodings by stored bytes on a sample, not estimates [1][55][6].

Skip what the narrow purpose makes unnecessary:

- Tiles themselves, if the whole data fits the page budget [55].
- Frames and skippable chunks, if renderer and data ship together [2].
- FastPFOR, FSST, ALP, rANS and feature reordering: under 1-5% on basemaps,
  most of them slower to decode [1]. Use delta + varint or bitpacking and let
  gzip/brotli do the rest [1][6].
- Pre-triangulation when bytes over the network dominate; ship triangles when
  the data is local or offline (network cost 0) and the client is CPU-starved
  [8].
- Run-time MVT parsing, layer filtering, JSON property parsing and seam
  merging: all of it moves into `bake.ts` [45][62][101][48].

## Sources

Local paths are under `ref-repos/` of this repository; commits are in the
corresponding clone or on GitHub.

1. ref-repos/maplibre__maplibre-tile-spec/docs/benchmarks.md; https://github.com/maplibre/maplibre-tile-spec/blob/main/docs/benchmarks.md
2. ref-repos/maplibre__maplibre-tile-spec/docs/overview.md; https://github.com/maplibre/maplibre-tile-spec/blob/main/docs/overview.md; ref-repos/maplibre__maplibre-tile-spec/rust/mlt-core/README.md
3. ref-repos/maplibre__maplibre-tile-spec/docs/specification/v1.md; ref-repos/maplibre__maplibre-tile-spec/rust/mlt-wasm/README.md
4. ref-repos/maplibre__maplibre-tile-spec/docs/specification/v2.md
5. ref-repos/maplibre__maplibre-tile-spec/docs/encodings.md
6. ref-repos/maplibre__maplibre-tile-spec/docs/implementation-guide.md
7. ref-repos/maplibre__maplibre-tile-spec/rust/mlt-core/CHANGELOG.md
8. https://github.com/yuiseki/maplibre-tile-spec/commit/a7eac51d; https://github.com/yuiseki/maplibre-tile-spec/commit/85684b59
9. https://github.com/yuiseki/maplibre-tile-spec/commit/364a9852; https://github.com/yuiseki/maplibre-tile-spec/commit/2deacaa4
10. https://github.com/yuiseki/maplibre-tile-spec/commit/89ceaef3
11. https://github.com/yuiseki/maplibre-tile-spec/commit/48c8491f
12. https://github.com/yuiseki/maplibre-tile-spec/commit/a8a7d513
13. https://github.com/yuiseki/maplibre-tile-spec/commit/1e8bce31
14. https://github.com/yuiseki/maplibre-tile-spec/commit/bd720d33; https://github.com/yuiseki/maplibre-tile-spec/commit/3c436932; https://github.com/yuiseki/maplibre-tile-spec/commit/4f30e61d
15. https://github.com/yuiseki/maplibre-tile-spec/commit/e2da710d; https://github.com/yuiseki/maplibre-tile-spec/commit/92207bdd; https://github.com/yuiseki/maplibre-tile-spec/commit/816ecece
16. https://github.com/yuiseki/maplibre-tile-spec/commit/d52cf9b0
17. https://github.com/yuiseki/maplibre-tile-spec/commit/c5bb4d93; https://github.com/yuiseki/maplibre-tile-spec/commit/460df66a; https://github.com/yuiseki/maplibre-tile-spec/commit/4b6fb76e; https://github.com/yuiseki/maplibre-tile-spec/commit/774768aa
18. https://github.com/yuiseki/maplibre-tile-spec/commit/40de5e70; https://github.com/yuiseki/maplibre-tile-spec/commit/a6600773
19. https://github.com/yuiseki/maplibre-tile-spec/commit/9b126a1f; https://github.com/yuiseki/maplibre-tile-spec/commit/65488108; https://github.com/yuiseki/maplibre-tile-spec/commit/e77db675
20. https://github.com/yuiseki/maplibre-tile-spec/commit/64568a46
21. https://github.com/yuiseki/maplibre-tile-spec/commit/7e4250dd; https://github.com/yuiseki/maplibre-tile-spec/commit/5a06589a; https://github.com/yuiseki/maplibre-tile-spec/commit/f642d53f
22. https://github.com/yuiseki/maplibre-tile-spec/commit/f787431e
23. https://github.com/yuiseki/maplibre-tile-spec/commit/9ff1678c; https://github.com/yuiseki/maplibre-tile-spec/commit/4d58576f; https://github.com/yuiseki/maplibre-tile-spec/commit/2f6aa58b
24. ref-repos/maplibre__maplibre-native/docs/mdbook/src/design/coordinate-system.md
25. ref-repos/maplibre__maplibre-native/design-proposals/2025-07-05-custom-vector-source.md
26. https://github.com/maplibre/maplibre-native/pull/4428
27. https://github.com/maplibre/maplibre-native/issues/4236
28. https://github.com/maplibre/maplibre-native/commit/40b0c8d07
29. https://github.com/maplibre/maplibre-native/commit/90f6c531f31a4edc5945f15a9864b914ce156ba8
30. https://github.com/maplibre/maplibre-native/commit/cf9f41cf6; ref-repos/maplibre__maplibre-native/platform/default/src/mln/storage/pmtiles_file_source.cpp; ref-repos/maplibre__maplibre-native/platform/android/docs/data/PMTiles.md
31. https://github.com/maplibre/maplibre-native/commit/9a4fd44c3; https://github.com/maplibre/maplibre-native/pull/4399; ref-repos/maplibre__maplibre-native/test/fixtures/storage/pmtiles/uncompressed-tiles.py; ref-repos/maplibre__maplibre-native/test/storage/pmtiles_file_source.test.cpp
32. ref-repos/maplibre__maplibre-gl-js/developer-guides/life-of-a-tile.md; ref-repos/maplibre__maplibre-gl-js/developer-guides/custom-crs.md; https://github.com/mapbox/mapbox-gl-js/pull/5799
33. https://github.com/maplibre/maplibre-gl-js/pull/6803; https://github.com/maplibre/vt-pbf/pull/16
34. https://github.com/maplibre/maplibre-rs/commit/e6f3b18
35. https://github.com/maplibre/navara/pull/485; https://github.com/maplibre/navara/pull/484; https://github.com/maplibre/navara/pull/559; ref-repos/maplibre__navara/guide/VECTOR_TILE_DRAPING.md
36. ref-repos/opengeos__RustGIS/docs/user-guide/data-formats.md; ref-repos/opengeos__RustGIS/docs/user-guide/data.md; https://github.com/opengeos/RustGIS/commit/4d0d1ff; https://github.com/opengeos/RustGIS/pull/152; https://github.com/opengeos/RustGIS/pull/158
37. https://github.com/opengeos/RustGIS/pull/70; https://github.com/opengeos/RustGIS/commit/5f498a3
38. https://github.com/reearth/reearth-visualizer/commit/82ae2c91; https://github.com/reearth/reearth-web/pull/521
39. ref-repos/CesiumGS__cesium/CHANGES.md; https://github.com/CesiumGS/cesium/issues/9847; https://github.com/CesiumGS/cesium/pull/9904; https://github.com/CesiumGS/cesium/pull/6559
40. https://github.com/CesiumGS/cesium/pull/13404; https://github.com/CesiumGS/cesium/pull/13577
41. https://github.com/CesiumGS/cesium/pull/3891
42. https://github.com/CesiumGS/cesium/pull/4186
43. https://github.com/CesiumGS/cesium/commit/16668af98; https://github.com/CesiumGS/cesium/commit/a678cd98d; https://github.com/CesiumGS/cesium/commit/d98cfda35; https://github.com/CesiumGS/cesium/commit/d8c11783c
44. https://github.com/CesiumGS/cesium/commit/870369577
45. https://github.com/visgl/deck.gl/blob/master/dev-docs/RFCs/proposals/loader-worker-triangulation.md; ref-repos/visgl__deck.gl/dev-docs/RFCs/proposals/loader-worker-triangulation.md; https://github.com/visgl/deck.gl/blob/master/docs/whats-new.md
46. https://github.com/visgl/deck.gl/blob/master/dev-docs/RFCs/v8.0/binary-support-improvements-rfc.md; ref-repos/visgl__deck.gl/dev-docs/RFCs/v8.0/binary-support-improvements-rfc.md; https://github.com/visgl/deck.gl/blob/master/dev-docs/roadmaps/performance-roadmap.md; https://github.com/visgl/deck.gl/blob/master/docs/developer-guide/performance.md
47. https://github.com/visgl/deck.gl/pull/4365
48. https://github.com/visgl/deck.gl/pull/3935; https://github.com/uber-web/loaders.gl/issues/685
49. https://github.com/visgl/deck.gl/commit/47b372b9
50. https://github.com/visgl/deck.gl/commit/08d9c960
51. https://github.com/visgl/deck.gl/commit/05ca54e0
52. https://github.com/visgl/deck.gl/commit/db5f1320
53. https://github.com/visgl/deck.gl/commit/ae842ef9; https://github.com/visgl/deck.gl/commit/220a07ed
54. https://github.com/visgl/deck.gl/commit/4571c0b7
55. ref-repos/kenjiyoshidahome2026-bit__ortho-earth/packages/geopbf/README.md; https://github.com/kenjiyoshidahome2026-bit/ortho-earth/blob/main/packages/geopbf/README.md
56. ref-repos/kenjiyoshidahome2026-bit__ortho-earth/packages/geopbf/pbf spec.md; https://github.com/kenjiyoshidahome2026-bit/ortho-earth/blob/main/packages/geopbf/pbf%20spec.md; ref-repos/kenjiyoshidahome2026-bit__ortho-earth/packages/ortho-core/gint draw spec.md
57. https://github.com/kenjiyoshidahome2026-bit/ortho-earth/issues/88
58. https://github.com/kenjiyoshidahome2026-bit/ortho-earth/commit/cc67c5c7
59. https://github.com/kenjiyoshidahome2026-bit/ortho-earth/commit/04d4fe9a
60. https://github.com/kenjiyoshidahome2026-bit/ortho-earth/commit/e9fdcfca; https://github.com/kenjiyoshidahome2026-bit/ortho-earth/commit/cfc60789
61. https://github.com/kenjiyoshidahome2026-bit/ortho-earth/commit/1db85633; https://github.com/kenjiyoshidahome2026-bit/ortho-earth/commit/74b8d5f0; https://github.com/kenjiyoshidahome2026-bit/ortho-earth/commit/da8dc2f4
62. ref-repos/qgis__QGIS/ChangeLog (2020-09-14 "[vectortiles] Optimise rendering of complex vector tiles"); https://github.com/qgis/QGIS/commit/789eccb572; https://github.com/qgis/QGIS/commit/c35d8e5e90
63. https://github.com/qgis/QGIS/pull/63749
64. https://github.com/qgis/QGIS/commit/70aea49fc4
65. ref-repos/OSGeo__grass/lib/vector/vectorlib_topology.dox; ref-repos/OSGeo__grass/lib/vector/vectorlib_files.dox
66. ref-repos/OSGeo__grass/doc/vector/TODO
67. ref-repos/OSGeo__grass/lib/vector/dglib/dglib.dox; ref-repos/OSGeo__grass/lib/vector/dglib/README
68. https://github.com/OSGeo/grass/commit/0ae0be638; https://github.com/OSGeo/grass/commit/5a36e44ce; ref-repos/OSGeo__grass/raster/r.compress/r.compress.md
69. https://github.com/OSGeo/grass/commit/689d9593c; https://github.com/OSGeo/grass/commit/3da035643; https://github.com/OSGeo/grass/commit/70f29a0a3; https://github.com/OSGeo/grass/commit/fb033976a
70. https://github.com/OSGeo/grass/commit/3ed6888c3; https://github.com/OSGeo/grass/commit/57ff07fef; https://github.com/OSGeo/grass/commit/9cce81c7b; https://github.com/OSGeo/grass/commit/9328c92a1; https://github.com/OSGeo/grass/commit/e2dc2789f
71. https://github.com/OSGeo/grass/commit/2cff96505517566532c24a5aa5197bc36ec8062c; https://github.com/OSGeo/grass/commit/7227e5b17c7f48b0c2cad532363c43721e574681; https://github.com/OSGeo/grass/commit/20a03092d1f2bab55180a008ab22e2871d231125; https://github.com/OSGeo/grass/commit/56ebd04da5463cdc5c5a39f51eb4078990926898
72. https://github.com/OSGeo/grass/commit/8a1cd940ebb3574e60ca5ee57371eb4368d4fa86
73. ref-repos/KDE__marble/tools/vectorosm-tilecreator/setup/README.md; https://invent.kde.org/education/marble/-/blob/master/tools/vectorosm-tilecreator/setup/README.md; ref-repos/KDE__marble/data/maps/earth/vectorosm/vectorosm.dgml
74. https://github.com/KDE/marble/commit/78b8313d5; https://github.com/KDE/marble/commit/70213164b; https://github.com/KDE/marble/commit/081d2950f; https://github.com/KDE/marble/commit/55e24cdac
75. https://github.com/KDE/marble/commit/89a0e9010; https://github.com/KDE/marble/commit/342aa8041; https://github.com/KDE/marble/commit/1e879be7b
76. https://github.com/KDE/marble/commit/3cc478ed1
77. https://github.com/KDE/marble/commit/1426a625e; https://github.com/KDE/marble/commit/9d3bc52f0; https://github.com/KDE/marble/commit/867ec8cb2
78. https://github.com/KDE/marble/commit/3e8d79cd9; https://github.com/KDE/marble/commit/8ab1bc70a; https://github.com/KDE/marble/commit/da14816df
79. https://github.com/KDE/marble/commit/de1208749; https://github.com/KDE/marble/commit/6855d0cea
80. https://github.com/KDE/marble/commit/3a3c7146d
81. https://github.com/KDE/marble/commit/915f67f0c
82. https://github.com/KDE/marble/commit/00131cf85
83. https://github.com/KDE/marble/commit/357ad31c3; https://github.com/KDE/marble/commit/4b9796233; https://github.com/KDE/marble/commit/1a082a3ef; https://github.com/KDE/marble/commit/af6e619fd
84. https://github.com/KDE/marble/commit/5ded04e18; https://github.com/KDE/marble/commit/9f6972276; https://github.com/KDE/marble/commit/06da643b3
85. https://github.com/KDE/marble/commit/9dd870a67; https://github.com/KDE/marble/commit/507171b53
86. https://github.com/KDE/marble/commit/7227009d0; https://github.com/KDE/marble/commit/2d20830ba
87. https://github.com/KDE/marble/commit/2c1bd0ee7; https://github.com/KDE/marble/commit/bcf7bfa6c; https://github.com/KDE/marble/commit/48c412ef1
88. https://github.com/KDE/marble/commit/c08b75a1b
89. https://github.com/KDE/marble/commit/c06d7763a
90. https://github.com/KDE/marble/commit/46b725934
91. https://github.com/KDE/marble/commit/47d08774d
92. https://github.com/KDE/marble/commit/fbe9ede00; https://github.com/KDE/marble/commit/b80baa530; https://github.com/KDE/marble/commit/17bafd867
93. https://github.com/KDE/marble/commit/2356dc308; https://github.com/KDE/marble/commit/b3711f257
94. ref-repos/openlayers__openlayers/changelog/upgrade-notes.md
95. https://github.com/openlayers/openlayers/pull/4219
96. https://github.com/openlayers/openlayers/commit/4b4f38304; https://github.com/openlayers/openlayers/commit/3cb506049; https://github.com/openlayers/openlayers/commit/ba867f8ff
97. https://github.com/openlayers/openlayers/commit/1361a7907; https://github.com/openlayers/openlayers/commit/4c58b9788
98. https://github.com/openlayers/ol2/pull/244
99. https://github.com/Leaflet/Leaflet/pull/5544; https://github.com/Leaflet/Leaflet/pull/7100; https://github.com/Leaflet/Leaflet/commit/cc9f327b
100. ref-repos/tangrams__tangram/src/utils/geo.js; https://github.com/tangrams/tangram/blob/master/src/utils/geo.js; https://github.com/tangrams/tangram/blob/master/src/styles/polygons/polygons.js
101. https://github.com/tangrams/tangram/pull/715
102. README.md of this repository (example sizes)
