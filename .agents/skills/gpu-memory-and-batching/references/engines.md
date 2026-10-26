# GPU memory and batching, engine by engine

Detail behind SKILL.md, grouped by engine. Each item gives the decision,
its trade-off and the evidence. References [n] point to the Sources list
at the end of SKILL.md.

## MapLibre GL JS

- **Halo and glyph in one SDF pass**: about 40% less symbol GPU time, for
  a more complex fragment shader [11].
- **`maxCanvasSize` default 4096x4096**, reduced further when GL limits
  are hit; avoids distortion and device load at the cost of resolution on
  very large high-DPI screens [66].
- **Terrain RTT cache tied to tile lifetime.** Each tile owns its FBO and
  texture per layer stack and returns them to a recycle pool on unload.
  Measured at z12, pitch 80, 393x852: hit rate 0.2% to 94.6%, memory 151
  to 302 MB, about 91% less jank-sum; a pool of 400 alone gave 0.1%
  because freed slots were reused first, and removing `freeAllObjects`
  gave 95% at 3.36 GB with a "No free RenderPool available" crash. The
  benchmark metric changed from max frame time to jank-sum
  [71].
- **Viewport snapshot (closed).** Copy the framebuffer once the bottom N
  translucent layers (default 5) have been stable for 3 frames; reviewers
  feared the invalidation paths; no benefit while the map moves
  [72].
- **Opacity buffers rewritten only when dedup changes.** 260 to 38 buckets
  per frame; a reusable call 0.014 ms vs 0.14 ms; the call right after a
  commit is about 20% slower and records about 120 KB for 2,880 symbols.
  Liberty, Tokyo z15 pitch 60, 4x throttle: p90 39.2 to 35.3 ms, median
  32.5 to 27.8 ms [44].
- **Collision boxes in a StructArray** (Int16 box + Float32 scale): about
  500 KB less per tile, creation about 60% faster, transferable to
  workers; `get(i)` created an intermediate object until indexed getters
  were added [85].
- **4-byte vertex alignment** for lines; also removed packing math from
  the shader [23].
- **Program cache keys about 100x smaller** [80].
- **Cancelled worker requests never call back**: fixed unbounded memory
  growth in IE (#8481) [70].
- **Atlas packing**: stopped incremental resizing, then switched to potpack
  packing the whole set once; tighter atlases, but repacking when the set
  changes [86].
- **Sort keys split segments only with allow-overlap or ignore-placement**
  [12].
- **`updateData` into existing DYNAMIC_DRAW buffers** fixed a leak with
  frequent `setFeatureState` [41].
- **Hillshade texture pool keyed by DEM stride with border**, not tile
  size: fixed a GPU leak [56].
- **Sprite icons extracted on demand**: fewer `getImageData` calls, lower
  memory [87].
- **`freeBufferAfterUpload`**: about 762 KB per tile released on a real
  tile; dynamic buffers keep their copy; the falsy `arrayBuffer` contract
  guarding re-uploads had to be preserved [52].
- **Tile texture reuse pool capped**, excess textures destroyed
  [54].

## MapLibre Native

- **Drawable renderer.** Builders per graphics API emit Drawables that own
  upload, draw, update and teardown; iOS 6.0.0 shipped Metal on it and the
  legacy renderer was deleted (#3384). Follow-ups: redundant
  bindings/states removed after Metal profiling, segments combined, UBOs
  by index instead of map [5].
- **Reverted copy-free deferred cleanup** (#3035) after memory growth
  [83].
- **`symbol-sort-key` defeated batching**: about 1,000 symbols in 3
  layers stuttered while zooming; 4 items visible, 996 renderable items
  set up; Metal GPU time about 10 ms, mostly SDF sampling
  [13].
- **GLES 3.0 only** (#995): UBOs, VAOs, 16 vertex attributes minimum;
  macOS was knowingly broken until Metal landed, ES2 kept on a branch
  [76].
- **Texture pool by storage, not names** (#2709): Tracy on Pixel 6 showed
  many sub-200x200 texture uploads over 1 ms correlated with touches;
  allocation spikes flattened, render-test peak probe 147,712 to 164,096
  bytes [55].
- **Glyph atlas sub-uploaded once per frame** instead of reallocated per
  upload [42].
- **Indexed drawing everywhere**, 16-bit indices [15].
- **Attributes**: unused attributes disabled instead of bound to
  constants; selective binding added for `GL_MAX_VERTEX_ATTRIBS` and
  reverted on Android [32].
- **VAOs** per segment per layer; blacklisted on Adreno 3xx and 4xx;
  non-VAO fallback restored [77].
- **Stencil clip IDs only for layers that need clipping**; symbols skip it
  except in still mode [88].
- **Program binary cache removed**: init launch s10 1129.8 vs 1346.75 ms
  with binary, Pixel 1692 vs 1883, Kazam 17948 vs 19157, Wiko 2060 vs
  3876; relaunch Pixel 723 vs 1039 (binary slower), Wiko 1278 vs 1136
  (binary faster) [74].
- **Ordered render-layer vector** instead of hashing ids per pass: a
  multi-source still-render bench about 70% faster [81].
- **Collision debug buffers only when debugging**: `sizeof(SymbolBucket)`
  1024 to 704 bytes, and a leak of unused debug vertices fixed
  [89].

## maplibre-rs

- **Tile cap of 32 under pitch.** A buffer overrun panic ("copy of 0..4216
  would end up overrunning ... size 2176") led to `take(max_n_tiles)` and
  a fixed tile-view buffer; tiles vanish at high pitch; a later PR
  reserves the budget for visible tiles first [60].

## MapLibre Tile (MLT)

- **Columnar layout**: decoding all planet tiles takes 40% (MLT) vs 64%
  (MVT) of gzipped-MVT time; planet 43.1 vs 50.5 GB with gzip; a stricter
  data model in return [90].
- **Columnar in-memory vectors** with null bitmaps and 64-byte aligned
  buffers: fewer allocations and less GC; random access into
  delta-encoded data is unsolved [91].
- **mlt-wasm `decodeTileColumns`**: whole columns cross the boundary; a
  1.3 MB tile with 524,482 vertices decodes in about 3.8 ms; 64-bit ints
  return as Float64 [92].
- **Layer-global triangle indices** (#1784): entropy change under 0.01%,
  simpler implementation [28].
- **Triangle trees** (#1923): tessellated v2 total 57.81 to 50.12 GB,
  overhead over plain v2 +23.8% to +7.3%; decode later 7 ns per triangle;
  the triangles-only layout cannot rebuild rings for stroking
  [29].

## navara

- **Text batching**: one instanced draw per tile and layer; per-label
  data texture kept roughly square under 2048 (about 800k labels);
  power-of-two glyph slot runs with free lists, accepting 2x
  fragmentation and forbidding compaction without a measurement; labels
  created lazily on first setter, because MVT tiles carry thousands of
  features of which a handful get text; three.js `_maxInstanceCount`
  gotcha found by patching `drawArraysInstanced` [10].
- **Batch data texture** for per-feature style: width 4096, 10,000
  features give 3 physical rows per attribute block; rows allocated on
  first write; dirty spans flushed once per frame; `texStorage2D` is
  zero-filled while defaults are not, so the first upload is full
  [34].
- **Memory**: CPU arrays released on upload (residency factor 1); DPR
  capped at 2 on mobile (1 with `mobileOptimization`) [53].
- **Shared MSAA bake target** with un-premultiplying resolve copy into
  512x512 per-slot targets [67].
- **Per-tile overlay atlas** (MRT), re-baked only when dirty: about 10 FPS
  more [73].
- **GeoJSON batching** (PR 446, 497): one batched mesh and one ECS
  component per batch; per-feature materials lost [2].
- **Real instancing for sprites** (PR 434) [8].
- **WASM views re-taken after allocation** [64].
- **Bitmask MRT attachment**: HalfFloat R channel, 11 slots, NEAREST
  [37].

## RustGIS

- **Byte-bounded streamed views** (128/48 MiB, thinned geometry up to
  64 MiB per layer) and complete export rendering in 8 MiB ordered chunks
  [58].
- **CPU (tiny-skia) as reference, GPU (wgpu) opt-in** for the supported
  flat-map subset; exports stay on CPU [93].
- **Vector tile meshes once per tile and level**, strokes at width 1
  extruded in the shader, zoom paint at level and level+1 blended:
  Manhattan z14.3 meshes 106 ms / 27.7 MB vs 440 ms of pictures per zoom
  step; native zoom frames 35 to 7 ms (z12) and 64 to 24 ms (z14);
  browser about even; tessellating in map units broke precision
  [94].
- **Raster texture-array pool**: 16 MB chunks to 128 MB (browser) /
  384 MB, LRU never evicting a tile drawn this frame, one instanced draw
  per chunk; browser p95 50-67 to 16.8 ms, wasm memory 164-219 to
  128-132 MB; desktop UI p95 7.0 to 1.4 ms [48].
- **Picture renderer abandoned** after tuning (#593, #548, #625) [40].
- **Explicit `destroy()` on WebGPU** and `createImageBitmap` decode
  instead of 20-30 ms per image in wasm [61].
- **Mesh size estimated before tessellation**: about 1.5M tiny polygons
  had tessellated to 30-50M vertices (1.8 s a frame) [59].

## reearth-papers and reearth-visualizer

- **Glyph subsets per codepoint**: a Tokyo z14 window used 1,339 of 44,288
  fetched glyph slots (3.0%); glyph bank 22-26 MB to 0.25-0.91 MB, heap
  52-58 MB to 22-26 MB, output byte-identical [63].
- **Resident renderers sized from measured heap**: after subsetting
  45/59/67/79/91 MB for 1-5 themes [62].
- **Concurrent renders capped by memory, not cores** (4, later 8);
  unbounded concurrency hit RangeError in 2-3 of 12 requests above six in
  parallel [95].
- **reearth-visualizer** delegates GeoJSON above 6,000 features to the
  bulk path; component LRU of 10,000 [4].

## CesiumJS

- **Quantised terrain**: CPU memory down up to 40% (1.17), a further
  about 25% in Chrome (1.18) [27].
- **Minimum GPU feature set**: vertex texture fetch for polylines (1.26),
  WebGL2 or instancing + VTF for billboards and labels (1.140), WebGL2 by
  default (1.102), CPU instancing removed (1.97) [9].
- **`cacheBytes` plus `maximumCacheOverflowBytes`** replaced a single MB
  limit [96].
- **Buffer primitive collections** bypass entities; a precomputed bounding
  volume removes per-update recomputation [3].
- **Immutable clipping polygons** and a rewrite using vector-tile
  techniques [47].
- **Loader hot paths**: tile parsing up to 25% faster by not re-parsing
  URIs; accessor data as typed arrays [97].
- **Skip-LOD with derived commands cached**: often about 50% less data;
  `RenderState.fromCache` and clone were about 25% of CPU and fell to
  0.25-3% [98].
- **Clipping planes in a texture**: up to 2048 planes, RGBA8 fallback
  [36].
- **SDF glyphs at one 48 px size**: 10K labels 60 fps either way; 100K
  labels 10 fps bitmap vs 7 fps SDF [99].
- **Debounced snapshot rebuilds** for Gaussian splats [49].
- **16-bit indices bound terrain grids** (256 to 129) [26].
- **Imagery texture pool removed** [57].
- **Per-frame arrays reused**, cached draw commands [82].
- **Dirty checks** before attribute and image updates [43].
- **Old batch kept until the rebatch is ready** [50].
- **2D power-of-two lookup textures** [35].
- **Atlas always power-of-two, grows by doubling the smaller side**, so
  12-bit quantised UVs land on texels [100].
- **Uint16 or Uint32 indices per batch** [25].
- **`setPositions` with per-attribute dirty flags** [46].

## deck.gl

- **Binary-first attributes**: "99% of the CPU time that deck.gl spends in
  updating buffers is calling the accessors"; typed arrays with
  size/stride/offset skip packing; composite layers cannot use it
  [101].
- **Constant accessors, Uint8 colours** [21][19].
- **GPU vs CPU aggregation** crossover about 100K points; GPU memory is
  proportional to all possible cells [79].
- **Picking ids from the instance index** (9.4); picking framebuffer
  skipped when nothing is pickable (8.3) [30].
- **One buffer per arriving chunk**; about 100 layers fine, not thousands;
  1000 ScatterplotLayers redraw CPU 76 to 26 ms after lifecycle work
  [39].
- **Allocation limits**: 60 FPS up to about 1M items, 10-20 FPS near 10M
  on a 2015 MacBook Pro; `_typedArrayManagerProps {overAlloc: 1,
  poolSize: 0}` for phones [65].
- **`pickMultipleObjects` by repeated passes** instead of a uniform bank
  of excluded colours [102].
- **Tile cache bounded by reported `byteLength`** [103].
- **Heatmap 1x1 reduction returned 0 on ANGLE**; iOS lacked float render
  targets [78].
- **Instanced circle quads** about 3x faster than 16-gons [6].
- **H3 instancing with an early-exit data scan** [7].
- **Vertex collapse** for invalid side vertices and filtered data
  [17].
- **Flat columns without side and bottom geometry** [33].
- **Picking colour cache capped at 2^24-1** and over-allocation capped
  [31].
- **Unused attribute removed by define** [22].
- **Spurious data identity changes** no longer rebuild attributes
  [45].

## ortho-earth

- **Topology and GPU representation derived at load, not stored**: Gint
  costs about 8.2-8.5 bytes per arc vertex; bake N03 3.0 s / 110.4 MB,
  ZCTA5 6.9 s / 232 MB [104].
- **Per-arc LOD table declined**: full table cut L1 error to 0-4% but
  costs +20-40 MB at N03 scale [84].
- **4-vertex indexed quads** with a `?quad4=0` escape hatch; a uniform in
  the wrong ledger broke hover while the visual gate passed
  [14].
- **Terrain chunk culling**: at 60 degrees only 19/256 near and 14/256 far
  chunks visible; Tokyo station 9.69 to 6.54 ms [16].
- **Unit-grid terrain**: G=1536 is 2.36M vertices; a wide pan of 8 hops
  had reallocated 525 MB [51].
- **WebGPU tile pool**: grows by `copyBufferToBuffer`, per-tile
  `drawIndexed` with `firstInstance`; high-water mark never shrinks
  (about 1.3x tile budget), so low-memory devices keep the merge path;
  200-300 draws per frame made render bundles unnecessary
  [38].
- **WebGL multi-draw pool**: 12 B fill vertices, 24 B building vertices,
  line segments in an RGBA32UI texture because RGBA32F could
  NaN-normalise packed colour bits; first-fit allocator with coalescing
  and x1.5 growth [18].
- **Half-resolution AO** in two r8 targets, multiply-blended
  [68].
- **One shadow window** 2048^2 (16 MB), 1024^2 on low memory; depth pass
  reused in 339 of 375 static frames [69].
- **Uint8 colours** and **indexed fills**: together geometry fell to 45%
  [20][24].
- **Elevation varints into Int16Array**: 2400^2 decode 99 ms / +232 MB RSS
  to 21 ms / +12 MB; SIMD varints 22 to 5 ms but whole decode only 73 to
  68 ms because inflate dominates [105].
