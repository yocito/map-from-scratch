# Range reading, engine by engine

Detail behind [../SKILL.md](../SKILL.md). Numbers in brackets refer to the
Sources list there.

## maplibre/maplibre-native (C++, mobile and desktop)

- PMTiles is a file source keyed on `pmtiles://`; it issues ranges through the
  normal resource loader, so `pmtiles://https://` and `pmtiles://file://` both
  work [1][2].
- Read path: bytes 0..126 (header), root directory, leaf directories up to
  depth 3 (deeper is an error), then exactly `[offset, offset+length-1]`.
  Header and metadata cached per URL; zooms outside the header's
  min/max zoom return no content without a request [1].
- Directory cache: key `url|offset|length`, at most 100 entries per URL,
  move-to-back on hit, evict the front on overflow [1].
- Persistent cache (#4290): sub-requests go through the SQLite ambient cache
  with `?_mlnRange=start-end` (or `&_mlnRange=`) appended to the key, because
  the resources table is unique by URL. `file://` archives bypass the cache.
  Before, PMTiles was network-only. The Android docs still said "no
  caching" after the code changed [3].
- Archive replaced in place: bdon reproduced a crash by replacing an
  R2-hosted archive while the app ran. #4111 validates ETag, Expires and
  Modified (Modified added for local files) and re-requests; #4290 tracks
  ETag and invalidates when a tile response's ETag differs [3][4].
- Compression: tiles are gunzipped only when the bytes carry gzip magic
  (fixture: header says gzip, tile is a raw PNG). Corrupt gzip and corrupt
  metadata become error responses; an exception on the PMTiles thread had no
  handler and called `std::terminate` [5][6].
- Local files: Android asset reads seek to the range start and read only the
  length, clamped to the asset size, so archives can ship inside the APK;
  the iOS asset source gained ranges too [7].
- Build: PMTiles behind `MLN_WITH_PMTILES`, with a stub source when off;
  +1.1% (+1.65 MiB) on Linux, +1.6% (+210 KiB) on iOS. Android first failed
  with "HTTP status code 206" because its HTTP layer treated 206 as an
  error [2].
- App-supplied tiles: the CustomVectorSource proposal rejects a custom URL
  scheme or file source because it needs disk I/O and has no cooperative
  cancellation; bytes are handed over in memory [8].
- Not Range, but the same question of what to download: ideographic CJK
  (later kana) glyphs are rasterised on the device instead of downloaded as
  SDF PBFs, and left out of offline packs; later at 2x resolution [9].

## maplibre/navara (Rust)

- The `pmtiles` crate is IO-free: it emits byte ranges and is fed the bytes.
  The first read is 16 KiB (the spec's recommendation), holding header and
  root directory; a second request only if the root lies beyond it [10][11].
- Leaf directories cached up to 32 MB (`LEAF_CACHE_MAX_BYTES`); the code
  notes that caching all leaves of a global multi-GB archive costs
  50-500 MB [10].
- Directory fetches bypass tile backpressure and are ordered by highest SSE,
  then nearest, so the view centre resolves first under HTTP/1.1 [10].
- Review of PR 637 required the parser to be a standalone crate knowing only
  the PMTiles spec and returning `Vec<u8>`; MVT and raster decoding depend on
  it only to get bytes. `DataRequester` gained an optional `byte_range` [12].
- The DataManager deduplicates by URL plus byte range. A prioritised tile
  fetch ordering and a tile priority tweak were committed and reverted in the
  same PR, keeping `OrderByDistance` [13].

## opengeos/RustGIS (Rust, desktop and wasm)

- Streamed layers: a GeoParquet or FlatGeobuf added by URL is read in place.
  GeoParquet: footer from the tail, row groups whose bbox covering statistics
  meet the view, covering chunks only for row groups on the view's edge, then
  geometry and field chunks of the rows taken; row groups thinned evenly when
  far more match than a read takes. FlatGeobuf: header, then the packed
  R-tree one level per round, then features in view. Whole download remains
  the fallback for an unindexed FlatGeobuf, a GeoParquet without a bbox
  covering, a server ignoring Range, or `"whole": true` [14][16].
- Byte store: reads record missing ranges; `drive()` fetches them in rounds
  and reruns the read, so the same parsers run natively and in wasm without
  blocking. Misses are tagged per drive (thread-local id) so concurrent reads
  of one file do not take each other's misses. Constants: `MIN_FETCH` 64 KiB,
  `GAP` 16 KiB, `MAX_PIECE` 16 MiB, `READ_BUDGET` 96 MiB wasm / 256 MiB
  native, LRU `KEEP` 192 / 640 MiB, `MAX_ROUNDS` 48, a round over twice the
  budget fails [14][15].
- Measured (PR 152): a 525 MB Overture buildings file opened with 0.93 MB in
  1.3 s; a San Salvador view 36.2 MB in 6-16 s; a 50.4 MB grid opened with
  262 KB. FlatGeobuf: UScounties 14.1 MB opened with 131 KB (0.09 s), DC view
  0.74 MB (0.29 s), whole-US view all 14.1 MB (1.5 s); a 12.3 GB file opened
  with 65 KB, an NYC view 8.75 MB in 1.0 s. A remote read of a 160k-feature
  file fetched under a quarter of the bytes with the same ids as a local
  read. wasm grew by 122,458 bytes (+0.31%) [14].
- Review findings: overflow in `at + MAX_PIECE` for hostile offsets, exact
  planned ranges uncapped per round, and flatgeobuf.org gzipping ranges unless
  `Accept-Encoding: identity` was sent [14].
- Hosts: suffix range answered 501 by GitHub release assets (Azure storage),
  so `layer.addUrl` of geobr's GeoParquet failed; now a one-byte probe reads
  the length from `Content-Range`, follows redirects, keeps refusal statuses
  and reads the probe body so ureq reuses the connection [18]. PMTiles
  requires 206; a tail answered with a longer whole file means no Range
  support [19][14].
- PMTiles v3 only; tiles needing the same leaf while it is fetched wait for
  that one fetch; a full leaf cache evicts one entry; offsets, lengths,
  counts and nesting are bounded [19]. Brotli and zstd archives decoded in
  pure Rust, zstd windows capped at 32 MB [20]. Local PMTiles uploads in the
  browser are not supported [16].
- zstd GeoParquet in the browser required compiling C zstd to wasm with clang
  ("Disabled feature at compile time: zstd" before); Brotli GeoParquet is
  still not read [21][16].
- Reads gated by the drawing test (visible and in zoom range) after a
  FlatGeobuf fetched tens of MB never drawn (issue #412) [22].
- COG: header read once (64 KB, more as the IFDs need), tiles of the fitting
  overview by range within a budget, tile index bounded at 8M tiles (about
  128 MB). Fixed 256 KB header steps stopped at about 3 MB after 12 rounds and
  refused MapBiomas's 4 MB index (346,092 tiles); steps now double [23].
  Strip-organised, rotated or unsupported images are downloaded whole [16].
- Caps and sampling: 250,000 features per view local / 60,000 remote on the
  desktop, 100,000 / 30,000 in the browser; the 6.48M-polygon grid at world
  view draws a 136k sample in 1.4 s, every cell at 1:250,000 in 35 ms. #681
  found the sample omitted valid features from maps and exports and added a
  complete traversal in 8 MiB chunks [24][17].
- Benchmark on one data set (1.6M polygons, 183,000-feature view): GeoParquet
  50 MB 0.15 s, FlatGeobuf 335 MB 0.11 s, GeoPackage 344 MB 0.18 s. For
  remote reads bytes dominate, which favours GeoParquet [17].
- Export writes GeoParquet 1.1, WKB in WGS 84, Snappy, 65,536-row groups and
  a bbox covering; DuckDB results are Hilbert-sorted [16][17].
- Overture: STAC extents pick the few files covering the view; more than six
  files is refused, and world views use the theme's PMTiles. Places tiles
  hold features only from zoom 14 [25].
- Local large files without an index: GeoJSON over 32 MB is indexed once by
  feature byte range and bbox (28 bytes a feature), shapefiles over 100,000
  shapes by record offset and bbox (24 bytes); peak memory 4-8x lower,
  reading 2-3x faster. The tree approach peaked at 2.5 GB for 121 MB of
  points [26].

## reearth/reearth-papers (Cloudflare Worker)

- Single-file datasets are served at `/<id>.tif` and `/<id>.pmtiles` with
  single-range semantics: open-ended and suffix ranges, 416 with the object
  size, only the first range of a multi-range request; OPTIONS answered
  globally. Verified with `gdalinfo /vsicurl/` and the PMTiles magic [27].
- Overture PMTiles are range-read from Overture's S3 bucket and re-served as
  tiles, storing nothing; the release is resolved by listing the bucket
  (cached 1 h per isolate) after a pinned release vanished and five routes
  returned 500. Protomaps is mirrored instead (~135 GB per build) [28].
- A custom PMTiles source maps `getBytes` to ranged R2 reads with a stable
  key so the header and directory cache survives across requests in an
  isolate; `latest.json` (1 h TTL) names the snapshot, whose date is in the
  render cache key [29].
- ESA WorldCover: zooms below 8 read one global 22500x9000 overview COG;
  z8-13 read the per-3-degree COGs [30].

## CesiumGS/cesium

- RequestScheduler (PR 3476): one queue for terrain, imagery and 3D Tiles
  with priorities, cancellation of stale low-priority requests, and 6 per
  server. Per-frame budgets were dropped because they broke with several
  widgets on a page. 4G, cache off: static horizon 9.89 s/262 requests to
  9.79 s/255; zoom from space 6.41 s/216 to 5.93 s/190. HTTP/2 static view:
  unthrottled 4.9-5.3 s with about 450 requests, throttled 5.1-5.8 s with
  about 350. The author: a big win on slow links, slightly worse at normal
  speeds, most useful when sources with different traversals mix [31].
- 18 per server for whitelisted HTTP/2 hosts (3 subdomains x 6, the
  parallelism HTTP/1.1 providers already had); unlimited rejected because of
  requests wasted during flights [32]. Later the default rose from 6 to 18
  (1.113); earlier, subdomain switching had made Mapbox imagery 300% faster
  [71][34].
- Token placement: query string broke HTTP caching, `Authorization` cost a
  preflight per tile, so the token went into `Accept` (2018); when the Fetch
  spec forced a preflight for long `Accept` values (2020) it went back to
  `Authorization` [33].
- Quantized-mesh availability is loaded progressively from tile extensions
  instead of one upfront list, for faster start and less memory; without
  availability Cesium requested tiles that did not exist [34].

## visgl/deck.gl

- TileLayer passes an `AbortSignal` to `getTileData` and aborts requests for
  unselected tiles when more than `maxRequests` are in flight; selected tiles
  are never aborted. Default `maxRequests` 8 to 6; one knob rather than a
  second `maxOngoingRequests` [35].
- Before, tiles went through loaders.gl's RequestScheduler, which asks the
  tile whether it is still selected when a slot opens; a fix made the
  priority callback return 1/-1 so deselected tiles were really cancelled
  (test: 1 of 2 queued requests runs). `throttleRequests` was removed [36].
- Docs: Chrome allows 6 per domain, so 3 domains allow 18; HTTP/2 servers may
  take `maxRequests=-1`. An aborted request that still returns data is
  cached; a falsy return is not. Ongoing requests abort when the layer is
  destroyed or a new tileset is created [37].
- `debounceTime` (default 0) queues requests until no tile has been added for
  that many ms [38].

## kenjiyoshidahome2026-bit/ortho-earth (JS, GPL-3)

- `openParquet`: `bytes=0-0` for the length, then the last 64 KB, both
  explicit ranges, so no preflight; `select({bbox})` prunes by bbox covering
  statistics; `readRowGroup` fetches only the requested column chunks, merges
  neighbouring ranges and fetches them in parallel. A 200 falls back to the
  whole file; without statistics every group is selected (`pruned:false`).
  zstd decoder injected (fzstd on the first zstd page). Test: 8,040 features,
  505 KB, STR-sorted, 128-row groups; a Tokyo view selects 32 of 63 groups,
  33 requests coalesced from 64, 110 KB [39][40].
- Streaming above 8 MB: row groups in the view, nearest the centre first,
  under a 64 MB compressed budget; "zoom in for remaining N" over budget;
  attributes fetched per row group on first hover or click. 11 MB of
  polygons: whole Japan 30/30 groups, Tokyo z9 16/30, z14 2/30 (0.7 MB) [41].
- Writing: STR order by default, bbox struct column with statistics,
  dropped for point-only data by `bboxColumn:'auto'`. Overlap and candidate
  numbers in SKILL.md; follows Kanahiro Iguchi's CNG Japan 2026 talk [39].
- GeoPBF: zigzag varint deltas on an integer grid, no index and no partial
  reads by design. N03 (15.7M vertices): 48.6 MB (34.4 gz) vs GeoJSON 579.6
  (138.6 gz), FlatGeobuf 266.9, GeoParquet zstd+STR 124.5; compare formats
  compressed against compressed [39].
- Range probe: one byte; 206 means range reads, 200 means the body becomes an
  in-memory source. Cloudflare Workers Assets returned 200 with the full body
  for `world-z3.pmtiles` (2.4 MB) on 2026-09-01 [42].
- Existence check: GET `bytes=0-0` with a User-Agent instead of HEAD, reading
  the total from `Content-Range`. The geospatial.jp WAF returned 403 without
  a UA; a CKAN 302 to an S3 presigned URL signed for GET returned 403 to
  HEAD [43].
- zstd: `setZstdDecoder` keeps the library dependency-free; earlier, streamed
  zstd columns came back null ("Cannot read properties of null"), so the
  worker now test-reads one column of the first row group at open [44].
- COPC: a worker reads nodes by range and decodes with laz-perf under a
  6M-point budget (2M on low memory); three reader workers were reverted
  because reads, not decoding, dominated [45].
- GitHub Pages answered Range with 206 and `access-control-allow-origin: *`
  (measured). A columnar layer replaced the topology bake for remote data:
  first tile 1.5 MB 457 to 75 ms, 11 MB 1257 to 98 ms. INT32
  DELTA_BINARY_PACKED in Number arithmetic decodes 1M values in 10 ms instead
  of 87 ms with BigInt [46].

## protomaps/protomaps-leaflet

- Two scripts each opening the same PMTiles duplicated the header
  (0-511999) and directory requests; a PMTiles instance can now be passed as
  the URL. 3.0 stopped exporting the bundled PMTiles [47].
- Tile cache with an in-flight map shared by concurrent requests and LRU by
  last-used time; wrapped world copies still request the same tile again [49].
- `ERR_CACHE_OPERATION_NOT_SUPPORTED` on Windows Chrome 126 for range
  requests, gone with DevTools "Disable cache"; `cache: 'no-store'` fixed the
  blank tiles; not reproduced on macOS [48].

## openlayers/openlayers

- GeoZarr: tile size is the largest multiple of the inner chunk that divides
  the shard, within limits; metadata and opened arrays cached; band arrays
  opened in parallel [50].
- Untiled GeoTIFFs with strips under 256 px use 256x256 tiles instead of
  one-row tiles; reprojected grids are limited to the source's finest
  resolution [51].
- Wrapped vector loaders get an extent centred in the real world, split in
  two at the antimeridian, instead of the whole world width [52].
- Data tiles: create sources with only the bands an expression needs, since
  every configured band must load before rendering [70].

## Others

- MapServer: `.qix` quadtree stored depth-first with sibling offsets; `coshp`
  (8.0) reorders shp/shx/dbf to the tree order [53]. SHX read lazily in ~8 KB
  pages, hit bitmap scanned a byte at a time [54]. Native FlatGeobuf reader
  (RFC-137): after release, a pointer set without its size (endless realloc
  of 0), feature offsets from `index_offset` instead of `feature_offset`
  (1640 - 2240 + 5*40 went negative), non-string properties read as one byte;
  the single test file `africa.fgb` covered none of them [55]. Later: index
  search skipped the last hit, a crafted ring end claiming 595 pairs
  overflowed the heap, an empty search read out of bounds [56].
- GeoServer COG: 16 KB initial header range, more chunks of the same size as
  needed; HTTP concurrency 128 requests, 5 per host [57]. Cascaded WMS layers
  outside their advertised bounds are dropped from the remote request
  (opt-in) [58].
- mapsforge: per sub-file, a row-major index of 5-byte entries (water bit +
  39-bit offset) over the bbox grid at the base zoom; an empty tile has the
  next tile's offset; blocks of 128 entries in a 64-block LRU [59].
- OsmAnd: the mapped read window for OBF files went from 16 MB to 1 MB to save
  memory with several files open [60].
- Mapnik: index records `{uint64 off, uint64 size, float box[4]}` so features
  are filtered without parsing; 64-bit offsets for files over 2 GB [61]. A
  shapefile with bogus padding (record length 1,334,468,928) hung at
  4.5 GB [62]. mmap for CSV loading was ~50% faster; an application file
  cache was reverted as the OS already cached [63].
- GRASS: raster rows compressed one by one with a flag byte, stored raw when
  compression grows them, found through a row-offset index [64]; larger
  segments cut 25-33% of kernel time [65]; spatial index queried from the
  file instead of loaded whole since r38385 [77].
- WorldWind Java: tiles that are missing are marked absent for a retry
  interval, then for a longer one after N failures, instead of being
  re-requested every frame [66].
- osgearth: the HTTP cache stores raw server bytes, not decoded objects [67].
- QGIS: remote EPT point clouds reuse the local provider; only index access
  differs, and the URL sits in the same `path` key [68].
- TerriaJS: a file-only search index for up to 500,000 features, numeric
  indexes as value-sorted CSV for binary search, one file per enum value;
  CSV parsed 2-3 s faster than JSON. Whole index files are downloaded [69].
