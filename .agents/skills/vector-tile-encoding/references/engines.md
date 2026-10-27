# Vector tile encoding: engine by engine

Detail behind SKILL.md. Numbers in brackets refer to the Sources list at the
end of [../SKILL.md](../SKILL.md). Read the section for the engine whose
approach you are about to copy or reject.

## MapLibre Tile (MLT), maplibre/maplibre-tile-spec

The most measured source on encoding choices; most numbers come from the
planet benchmarks (OpenMapTiles and Protomaps schemas) [1].

- Layout: each layer writes all ids, then all geometry, then each property as
  its own column, split into ORC-style streams (present, data, length,
  offset) with their own lightweight encoding [2]. Planet: decoding all tiles
  takes 40% (MLT v1) vs 64% (plain MVT) of gzipped MVT's time; 43.1 GB (MLT
  v1 + gzip) vs 50.5 GB (MVT + gzip) [1]. Paid with a stricter data model:
  one type per property per layer, typed nulls, no duplicate keys, feature
  order not guaranteed [2].
- Small tiles: median tile 524 B (v1, uncompressed) vs 422 B gzipped MVT;
  MLT v1 + gzip decodes the median tile in 117% of gzipped MVT's time
  (Protomaps 113%) [1]. v2 shrinks stream headers to one byte,
  takes the geometry type from the layer header, and codes extent as a 4-bit
  power of two (64..2097152); other extents must be rescaled or stay v1 [4][2].
  Gzipped v2 is 10-18% smaller than gzipped MVT [1].
- Frames: `size, tag, body`; v1 (0x01) stable, v2 (0x02) experimental with no
  compatibility promise; v1 and v2 layers may mix in one tile [2].
- Geometry topology as count streams with implicit counts for simple types
  via a type threshold [3]; prefix sums in mlt-wasm take ~0.006 ms on a
  524,482-vertex tile [3].
- Encoding selection: prune with cheap metrics (skip RLE when the average run
  is under 2), try the rest on a ~1% sample, keep the smallest stored output;
  compare stored bytes, not estimates, and do not assume gzip changes the
  winner [6]. v2 presence fields must use the smallest of bitmap, runs and
  sparse [4].
- Integer codecs: FastPFOR (block bit-packing with exception patches) or
  varint; v2 changed FastPFOR blocks from 256 sequential big-endian to 128
  interleaved little-endian values with 64-bit support [6][5]. The C++
  implementation vendored FastPFOR without SIMD so encoder and decoder agree
  and ARMv7 builds [18].
- Strings: a shared dictionary across `name:*` columns (+25.4% size when off
  on OMT, +0.8% on Protomaps) [1]; one new string renumbers it, bad for
  binary diffs [1]. FSST gains 0.2-0.8% [1]. Reusing one trained FSST table
  across unrelated dictionaries gave "terrible" ratios (Latin table on
  Cyrillic); training per shared dictionary made the average tile 0.1%
  smaller [15]. The TS FSST decoder computes the decoded size first and fills
  one exact `Uint8Array`: 1.99x faster on 4.7 kB, 4.47x on 4.5 MB (144.85 ->
  32.42 ms) [16].
- Floats: ALP removed (#1128) as never implemented, Pseudodecimal removed
  (#1605); v2 reintroduced framed, exception-free ALP with a mandatory
  bit-exact round-trip check [7][17]. On synthetic decimal columns -19.5%
  (7.4% after gzip); on basemaps +0.0-0.1% when off [17][1]. A change that
  stored doubles as floats was reverted (#1063) [17].
- Pre-tessellation: optional, off by default [1][7]; priced per layer by
  `Tessellation::Auto(Client, Network)`, constants fitted on a Ryzen 9 3900
  and five tilesets (e.g. native index buffer 14,300 + 398 x triangles,
  hundredths of ns); profile `Native` defaults to Auto, `web`, `min_size`,
  `diffable` to off [8]. Triangles-only layout (0xC) drops rings; layers with
  m-values or non-polygons keep 0xD [9].
- Vertex dictionaries: Morton-RLE and plain Morton removed because sorted
  unique keys make delta win, and they crashed decoders; plain might return
  for direct-to-GPU use [11]. The HLL gate for racing Hilbert/Morton
  dictionaries saturated to infinity at ~1.5k distinct vertices (inverted
  formula, ln instead of log2); an exact FxHashSet count stopping at 66% made
  tiles 0.77% smaller overall, -8.5% on omt-ref (v1), encode +4% [12]. Hilbert
  rank lookups via TreeMap made a ~700 kB MVT "spin forever"; a sorted array
  and reverse index made it ~500 ms, Java planet encode 55 -> 29 min [23].
- Sorting: Hilbert and id sorting dropped from `auto` (<0.5% size for >30%
  encode time) [13]; Rust keeps source order by default (#1867) [7].
- Profiles: removed in March 2026 as premature, reintroduced in October as
  `web | native | min_size | diffable | fast_encoding` once choices were
  priced [14].
- Encoder engineering: per-thread FastPFOR codec caching (each allocates ~1
  MB), Java planet z0-7 53.3 -> 22.2 s; reusing geometry Vecs -21..-34% in
  feature iteration; CompactString -3.6..-28.3% [19]. Converting MVT through
  borrowed references instead of an owned tile: 586 -> 394 ms on 95 tiles,
  byte-identical [22]. `mlt convert` keeps the input's tile compression by
  default; uncompressed MLT archives were larger than gzipped MVT input
  (813.7/459.8 kB MVT vs 460.3/357.0 kB MLT gzip); PGO -18..-25% time [21].
- Binary diffs: use v2 with `--delta2 --sort none --no-shared-dict --no-fsst`
  and no gzip; avoid rANS (roughly doubles the patch) and tessellation [1].

## MapLibre Native

- 8192 extent per tile, 1/16 px precision at 512 px; values outside 0..8192
  allowed as buffer [24].
- CustomVectorSource: apps hand binary tiles (MVT, MLT next) for a tile id
  instead of GeoJSON that is re-encoded, reusing the decoder path with
  cooperative cancellation [25].
- mlt-core (Rust) decoder: memory budget raised from 20 to 128 MiB because
  decoded tiles are 5-17x encoded size; ring-closure mismatch broke holes
  (134.5 vs 91); a parity test against MVT covers 17,154 features;
  performance "about the same" as the C++ decoder [26].
- Format selection: debate over Accept negotiation (Martin 1.9.0 ships it) vs
  separate endpoints plus the style's `encoding`; maintainers lean to
  endpoints because MLT will diverge (nested properties, 3D) and TileJSON says
  one URL returns one content [27].
- Labels held as UTF-16 internally while glyph PBF ids stay uint32, of which
  16 bits are used [28].
- Feature index excludes features outside the tile; queries touch
  neighbouring tiles [29].
- PMTiles: header bytes 0..126, root directory, leaf depth > 3 is an error,
  then one exact range; header and metadata cached per URL [30]. gzip magic
  checked before decompressing; corrupt data yields an error response, since
  an exception on the PMTiles thread called `std::terminate` [31].

## MapLibre GL JS

- GeoJSON is tiled with geojson-vt in a worker and then follows the vector
  tile bucket path; 0.43 halved memory and made tiling 20-100% faster (#5799);
  geojson-vt projects with its own Mercator, so GeoJSON does not follow a
  custom CRS [32].
- GeoJSON tiles cross from worker to main as MVT (vt-pbf). When
  vector-tile-js began throwing on undefined values, maplibre's vt-pbf was
  changed to skip null/undefined values and the PR returning raw objects was
  closed; users run 10-100k live points through this path [33]. MLT as the
  transfer format was named the long-term direction [33].

## maplibre-rs and navara

- maplibre-rs decodes MVT commands with its own cursor (new subpath per
  MoveTo, lines left open, NonZero fill), since SVG and MVT semantics differ
  [34].
- navara renders clamp-to-ground MVT and GeoJSON per tile into a texture and
  drapes it like imagery; geojson-vt was ported to Rust behind a shared
  vector-tile crate; stencil draping and `useGroundNormals` were removed.
  Costs: offscreen bake per tile and line sharpness capped by texture
  resolution [35].

## RustGIS

- PMTiles v3 only, read a tile at a time by range; no local PMTiles in the
  browser [36].
- GeoParquet export: 65,536-row groups, a bbox covering column, Hilbert-sorted
  DuckDB results [36]. Remote GeoParquet read by suffix range for the footer
  and row groups pruned by bbox statistics: a 525 MB Overture file opened with
  0.93 MB in 1.3 s [36].
- Arrow pushed the wasm past Cloudflare Pages' 25 MiB file limit (29 MiB);
  the parquet crate's column readers grow it 1.3 MB instead of 12 MB; Brotli
  Parquet no longer read [37].

## Re:Earth

- Deleted a per-feature mirror of MVT features (md5 geometry keys, two
  caches, a callback per tile); style is evaluated on a throwaway feature at
  rasterisation; selection was lost until re-implemented later [38].

## CesiumJS

- Draco: `dequantizeInShader` added in 1.44, removed in 1.97; Draco 1.4.1
  forced disabling attribute quantisation (1.86), partly restored in 1.87;
  Draco point clouds 2-3x better compression [39].
- MVT loaded as 3D Tiles through MVTDataProvider: implicit tileset from a
  `{z}/{x}/{y}` template, bounds-checked varints, vector glTF
  (`CESIUM_mesh_vector`), 404/204 as empty tiles, skip-LOD disabled; a
  dedicated MVT content class was steered away from [40]. Properties go into
  `EXT_structural_metadata`; draping with screen-space constant width came
  later [40]. In 2016 3D Tiles vector tiles were a separate format with MVT
  interop undecided [42].
- WEB3D_quantized_attributes: integers kept in the GPU buffer and decoded
  with a per-attribute decode matrix in the vertex shader; unpacking on load
  was slower and more complicated; folding into the model matrix breaks when
  attributes of one draw are quantised differently [41].
- Oct-encoded normals (2 bytes) cannot be linearly interpolated when
  upsampling; quantized-mesh extensions use id + 32-bit length so clients
  skip unknown ones [43].
- Alignment fix: `off += (4 - off % 4) % 4` [44].

## deck.gl

- Binary MVT: loaders.gl parses to typed arrays in a worker and runs earcut
  there; 1.94-2.4x tiles/s, viewport load -56.5% on 988K vertices; the RFC
  warns against moving triangulation into workers elsewhere without
  benchmarking [45].
- `data.attributes` takes typed arrays or buffers with size/stride/offset and
  `startIndices`; composite layers cannot use it [46].
- Global feature id for cross-tile highlight; GeoJsonLayer picking returns the
  index in the whole feature array [47].
- PR 3935: tile-local coordinates with a per-tile matrix instead of GeoJSON
  lng/lat; worker decoding to flat arrays (`@mapbox/vector-tile` "creates a lot
  of small JS arrays ... very slow"); merging split polygons with turf
  rejected in favour of per-tile GPU clipping [48].
- Polyline-encoded demo data (1e-5 deg, delta + 5-bit varint as ASCII)
  decoded in a worker: 2,921,529 -> 617,521 bytes before HTTP compression
  [49].
- Tile offset moved from the model matrix translate to `coordinateOrigin` for
  precision [50]. TileLayer is "NOT intended to be a full replacement for a
  base map"; MVT worker parsing belongs in the loader [51]. Lazy cached WGS84
  getter per tile [52]. CPU aggregation and CARTO tile properties keep float64,
  because Float32 broke bin assignment and coordinates [53]. Binary path off
  for GlobeView [54].

## ortho-earth (GPL-3.0-or-later; fine to adapt here)

- GeoPBF: zigzag varint deltas on a per-file grid of 10^-precision degrees
  (default 6, 0.11 m), delta chain restarting per ring, closing vertex
  omitted, one global key dictionary, no spatial index [55][56]. N03 (15.7M
  vertices): 48.6 MB (34.4 gz) vs GeoJSON 579.6 (138.6 gz), FlatGeobuf 266.9,
  GeoParquet zstd+STR 124.5 [55].
- Topology (arcs) and the GPU form (Gint, 64-bit Morton with a VW rank in the
  low 6 bits) are built at load and never written; bake costs 0.14 s to 6.9 s
  and 4-232 MB depending on data [56].
- Tiler calibrates VW rank thresholds per arc and zoom to match tippecanoe's
  Douglas-Peucker counts: the fixed rule had been 3-31% larger; countries
  z0-10 in ~6.5 s vs tippecanoe 58 s [55].
- STR-ordered GeoParquet with bbox covering: overlap ratio none 24.5, Morton
  0.87, Hilbert 0.28, STR 0.00; the bbox column roughly doubles point files
  (45.6 vs 21.4 MB), so it is dropped for points [55]. Range reader: 64 KB tail
  for the footer, adjacent ranges merged, 200 falls back to the whole file
  [58].
- Tile format plugins decode to one intermediate `{coords: Int32Array, ends}`;
  MLT lives in a separate package wrapping `@maplibre/mlt`, which allocates a
  Point per vertex and does not yet use MLT's pre-tessellation [57].
- Uint8 normalised colours: fill vertex 24 -> 12 B, line instance 33 -> 21 B,
  geometry 16.28 -> 9.20 MB, LRU holds ~1.8x more tiles [59].
- Own flat MVT decoder: 27.8 -> 18.0 ms, rings to earcut as zero-copy
  subarrays [60].
- PLQ1 mesh format for 3D buildings: u16 positions quantised to the batch
  bbox as delta zigzag varints, i8x3 normals, delta indices; Minato 32 tiles
  15.25 -> 2.95 MB gzip with 1.4 cm error, 28 ms unpack; vertex welding by an
  Int32Array open-address hash (3.12M -> 1.62M), skipped under 15% gain [61].

## QGIS

- Renderer and labeling declare required source layers; the decoder skips
  the rest and reserves arrays from command counts [62].
- `QgsArrowIterator` turns any feature iterator into Arrow batches; a native
  GDAL Arrow stream would skip per-feature iteration [63].
- MVT feature ids ignored and reassigned, since reused ids were seen in real
  mbtiles [64].

## GRASS GIS

- Native byte order with a flag, readers swap; doubles for coordinates;
  version plus back-compat version per file [65].
- Append-only coordinate file: deletes leave dead records; the digitiser's
  undo depends on it [66].
- dglib FLAT graph: 32-bit words with relative offsets, binary search by node
  id, usable straight from a stream; a TREE form for editing [67].
- Raster codecs: own RLE replaced by zlib as default (some maps shrink to ~1%)
  [68]; pluggable codecs (RLE, zlib, LZ4, bzip2, ZSTD) with a stored method
  id and `G_compress_bound()` [69]; NULL bitmap compressed separately with LZ4,
  with a segfault fixed when nulls were compressed but data not [70]; ZSTD the
  default: "up to 4x faster than ZLIB" to compress, "usually decompresses 6x
  faster" [71]. Redundant value-to-itself category labels dropped [72].

## KDE Marble (vectorosm tile creator)

- Tiles at odd zooms 1-17, o5m encoded [73]. o5m keeps OSM tags so the client
  reuses its OSM styling, but it is not a renderer-ready layout [73].
- Simplification: disabled for rings, re-enabled below 17, replaced by
  Douglas-Peucker, tuned, then fixed for missing roundabouts (BUG 373053) [74].
- Clipping: own Weiler-Atherton -> Clipper 6.4 ("less clipping glitches, no
  endless loops") [75] -> Clipper2 rect clip for order stability; 18 test
  files changed numerically [87]. Closed lines clipped as open lines [76].
  Node ids carried in Clipper2's z field [88]. Contained elements pass through
  unclipped and keep real ids delta-encoded [86].
- Border-point tags such as `mx:bp=3+1;12+2` added for outline suppression
  [77], then removed as unusable for reassembly [90]. Real nodes adjacent to
  synthetic border nodes are never dropped [89].
- Ways split across tiles merged by OSM id for levels 11, 13, 15 (not tunnels
  with uncovered roads) [78]. Rings already in a multipolygon not emitted
  again [91].
- Clipping speed: tile-pyramid index plus bounding boxes, the fastest of four
  strategies [79]. Three-pass PBF scan cut preprocessing memory ~75% [80].
  Converting OSM XML to o5m first halves loading memory, more than 2 GB at
  level 9 [82].
- Served on demand by Tirex/mod_tile 8x8 metatiles; mod_tile never re-renders
  an empty or invalid metatile, and needed a rewrite rule for the `o5m`
  extension [83].
- Encoder bugs: relation members all serialised as `way`; string length
  measured in UTF-16 instead of UTF-8 bytes against the 250 limit [85].
  `natural=cliff` treated as an area corrupted published tiles [93].
- Golden tests per tiny input, recorded with known errors [92].
- Radian input into a degree-scaled integer conversion: ~60x coarser [81].

## OpenLayers and ol2

- v4.3: VectorTile sources default to a 512 px XYZ grid to z22, MVT extent
  drives scaling; v5.0: pattern origin on 512 px world steps, power-of-two
  patterns; v6.0: extent and projection passed to `readFeatures` [94].
- #4219: features held per tile, replay groups built per tile, clip at the
  tile boundary, read-only RenderFeature; tiles are "for rendering, not for
  querying" [95].
- MVT read directly from protobuf, coordinates transformed once at parse
  [96]. Winding-based ring splitting only for tile features [97].
- ol2 UTFGrid: per-tile id grids for hit testing; spec demo failed for code
  points 55296-57343 (UTF-16 surrogates) [98].

## Leaflet

- `toGeoJSON` defaults to 6 decimals (RFC 7946); 1.8 accepts `false` to skip
  rounding, because indirect rounding caused round-off errors [99].

## Tangram

- Tile-local 0..4096 in `gl.SHORT`, per-tile model matrix, heights x16 [100].
- `parse_json` for stringified MVT properties, plus dot-path accessors and
  array filters instead of JS filter functions [101].
