---
name: gpu-memory-and-batching
description: How map engines cut draw calls, vertex bytes, uploads and GPU memory, which pools and caches they had to cap or remove, and what they reverted, distilled for a map-from-scratch renderer. Load it when designing the vertex layout or index format a bake writes, deciding how many draw calls a layer or tile becomes (batching, instancing, multi-draw), putting per-feature state on the GPU (attributes, uniforms, lookup textures), writing a buffer, texture or render-target pool, adding a render-to-texture cache, or when a bench shows many draw calls, upload hitches, a growing JS heap or GPU memory, or an out-of-memory crash on a phone.
---

# GPU memory and batching: few draws, few bytes, bounded pools

A GPU renderer spends its frame on three things that a general engine
multiplies by its generality: draw calls (and the state changes between
them), bytes moved to the GPU (vertex layout, uploads, re-uploads), and
GPU or heap memory held at once (buffers, textures, render targets, CPU
copies of all of them). The engines in `ref-repos/` cited below have
spent releases on these: merging per-feature meshes into batches,
shrinking vertex formats, freeing CPU copies after upload, capping pools
that grew without bound, and reverting caches that cost more memory than
they saved. A map-from-scratch renderer starts from the place they
converged on: the bake writes exactly the GPU layout, the renderer
uploads it once and changes uniforms per frame [1]. This skill is
for the decisions inside that rule, and for the moment the rule stops
being enough (streamed tiles, run-time edits, a phone with 3 GB).
Per-engine detail is in [references/engines.md](references/engines.md).
Neighbouring skills: byte budgets for tile caches and fetch queues are
in `tile-cache-and-loading`, glyph atlases and SDF text in
`text-rendering`, id buffers in `picking-and-hit-testing`, terrain grids
in `terrain-and-elevation`, stroke geometry in `line-tessellation`,
DPR and power on phones in `mobile-and-power`, shader compile and
binary caches at start-up in `startup-and-bundle-size`, decode and
transfer off the main thread in `worker-threading`.

## First: where is the renderer on this scale?

- **One baked file, uploaded once, never edited.** Most of this skill is
  bake-time layout: vertex format, index type, how many draw units the
  bake emits, and dropping the CPU copy after upload. Pools, upload
  pacing, dirty tracking and allocators are not needed; say so in
  `not_doing`.
- **Streamed tiles or chunks.** Add per-tile upload once, bounded pools,
  upload pacing and explicit destruction (sections 4 and 5).
- **Run-time edits (restyle, highlight, animate positions, live data).**
  Add the per-feature state and partial-upload sections.

## 1. Draw calls: one draw unit per layer or tile, decided at bake time

- **Batch features; never one mesh per feature.** navara built GeoJSON
  as one mesh per feature until PR 446 merged them ("Now you can render
  20,000 features once"); it lost per-feature model materials and had to
  revert a polyline change that broke endpoints [2]. Cesium
  added `BufferPoint/Polyline/PolygonCollection` and `GeoJsonPrimitive`
  to bypass its per-object Entity layer "for significantly improved
  performance with large datasets" [3]. reearth-visualizer
  switches GeoJSON from one React/Cesium component per feature to the
  bulk path above 6,000 features [4]. MapLibre Native moved to
  Builders that emit Drawables, and the follow-up performance work
  merged segments into one drawable and removed redundant bindings
  [5].
- **Instance identical shapes.** deck.gl replaced 16-sided circle fans
  with one quad per instance and a fragment-shader discard: "about 3x
  faster", correct outline widths, aliased edges unless smoothed
  [6]. Its H3 layer instances one hexagon template and falls
  back to explicit polygons only for pentagons or mixed resolutions
  [7]. navara's `InstancedPointMesh` did not actually instance;
  the real instanced replacement fixed flicker and picking but regressed
  per-instance size, aspect and colour until review caught it
  [8]. Cesium removed CPU instancing entirely
  [9].
- **Text as one instanced draw per tile and layer.** navara draws a unit
  quad per glyph, with per-label values (anchor, hide, flip) in a float
  texture read by `labelIndex`: 60 labels of 5 glyphs are one draw of
  about 360 instances instead of 60 draws, and a per-label fade costs one
  texel instead of O(glyphs) [10]. MapLibre GL JS draws SDF
  halo and fill in one pass: about 40% less symbol GPU time
  [11].
- **Do not split a batch for an order nobody can see.** GL JS splits
  symbol segments by sort key only when symbols may overlap
  [12]. In MapLibre Native, `symbol-sort-key` stopped
  batching and set up 996 renderable items for 4 visible ones; the
  maintainers' advice was fewer candidates (per-zoom filters), not a
  faster sort [13]. Order is a bake-time decision here.
- **Index quads; four vertices, not six.** ortho-earth drew each line
  segment as 6 vertex invocations, each projecting both endpoints;
  indexed 4-vertex quads cut a vertex-bound synthetic z3 view by 20%
  (20.49 to 16.46 ms) and 2D Tokyo z13 by 53% (0.70 to 0.33 ms), and did
  nothing where the view was not vertex-bound [14]. MapLibre
  Native made every draw indexed with 16-bit indices and deleted the
  `glDrawArrays` path [15].
- **Cull chunks of one buffer instead of adding LOD.** ortho-earth
  reordered its terrain index buffer into 16x16 chunks and draws only
  chunks inside the horizon and frustum, merged into few `drawIndexed`
  ranges: Fuji z13 at 60 degrees 7.18 to 3.55 ms with a 0 px difference,
  for about 0.3 ms of CPU; CDLOD levels were then judged not worth it
  [16].
- **Collapse invalid or filtered vertices in the vertex shader.** deck.gl
  sets `gl_Position = vec4(0.)` for filtered items and for invalid
  extrusion side vertices instead of discarding fragments, so no
  fragments are rasterised and the data stays uploaded
  [17].
- **Multi-draw pools replace re-merging when tiles change.**
  ortho-earth uploads tiles once into GPU pools and sends only a 1.8 KB
  draw list per update (a merge had moved 3.2 MB) through
  `WEBGL_multi_draw`; it hit two WebGL traps on the way (no baseInstance
  in multi-draw; an index buffer first bound as `COPY_WRITE` can never be
  an element buffer) [18].

## 2. Vertex bytes: decide the layout in the bake

- **Colours as normalised Uint8.** deck.gl moved colours and picking
  colours from Float32 to `UNSIGNED_BYTE` (4x smaller) [19].
  ortho-earth did the same: fill vertex 24 B to 12 B, geometry 16.28 MB
  to 9.20 MB over 37 real tiles, about 1.8x more tiles in the same LRU
  budget, error at most 0.5/255 [20].
- **Uniform values belong in uniforms.** deck.gl's constant accessors
  upload 4 numbers instead of an array of 4N, and "don't use GPU memory"
  [21]. A shader define that drops an unused attribute saves
  a slot and a buffer [22]. Bake per-vertex only what varies.
- **Pad vertex strides to 4 bytes.** GL JS widened line vertices from 3
  to 4 Int16 because "10 byte vertices are heavily penalized by common GL
  implementations" [23].
- **Indexed fills, smallest index type.** ortho-earth's indexed earcut
  fills took fill bytes to 62% of the triangle soup (4.96 to 3.08 MB)
  [24]. Cesium picks Uint16 or Uint32 per batch from its
  vertex count [25]. A batch that must stay under 65,536
  vertices constrains grid sizes: Cesium dropped skirts from 256x256
  heightmaps and resampled to 129 [26].
- **Quantise positions to a tile or batch origin.** Cesium's quantised
  terrain cut terrain CPU memory by up to 40% [27].
  `patterns.md` already quantises to 16 bits at bake time [1].
- **Layer-global indices if the layer is one draw.** MLT v2 counts
  triangle indices from the layer's first vertex, so vertices and indices
  upload as one layer buffer; per-feature bases help only when features
  are culled individually [28]. MLT's compact triangle trees
  (about 0.3 B per index instead of 2 B) are smaller on the wire but no
  longer zero-copy to the GPU; "as networks get faster, we might need to
  revert" [29]. Read from local disk or mmap: keep a plain index
  buffer.
- **Derive ids from `gl_InstanceID` / `gl_VertexID`.** deck.gl 9.4 stopped
  allocating `instancePickingColors` for most layers, "reducing memory
  usage and initialization times"; an explicit index attribute remains
  only where one feature becomes many instances [30]. RGB ids
  cap at 2^24-1 per pass [31].
- **Keep the attribute count small by design.** MapLibre Native exceeded
  `GL_MAX_VERTEX_ATTRIBS` on some devices; binding only active
  attributes was reverted because it broke certain Android devices
  [32].
- **Bake only the geometry the mode draws.** deck.gl's flat columns build
  only the top fan: about 3x fewer vertices and no indices [33].

## 3. Per-feature state that changes at run time: a texture, not attributes

- navara keeps per-feature style in an RGBA float texture (one column per
  feature, one row block per attribute, width capped at 4096); restyling
  one feature writes one or two texels whatever its vertex count, at the
  cost of a fetch per attribute and a mandatory full first upload
  [34]. If styling never changes, put the colour in the
  vertex or a tiny palette [34].
- A 1D lookup texture caps at the maximum texture width; Cesium wraps
  lookup textures into 2D power-of-two layouts [35].
  Cesium stores clipping planes untransformed in a texture so it does
  not change when the view moves [36].
- Id and bitmask targets need `NEAREST` sampling, and every MRT
  attachment must share a type: navara's switch to an UnsignedByte
  attachment made the framebuffer incomplete and was reverted
  [37].

## 4. Uploads: once, in place, and only what changed

- **Upload once; draw in place.** ortho-earth's WebGPU backend re-merged
  all visible tiles (33 ms for 35 tiles, 9-11 hitches over 4 ms per 9 s
  pan) until a per-tile pool made it 0 hitches [38].
  deck.gl: appending 100K rows to 1M rebuilds 1.1M rows; one buffer per
  chunk does not [39]. RustGIS abandoned a per-frame picture
  renderer for prepare-once tiles after tuning PRs had left throughput
  unchanged (5804 vs 5802 ms) [40].
- **Reuse a buffer with `bufferSubData`; do not recreate it.** GL JS
  recreated vertex buffers on every `setFeatureState` and leaked memory
  [41]. MapLibre Native reallocated the glyph atlas texture on
  every upload, sometimes mid-render; it now sub-uploads once per frame
  [42].
- **Dirty-check before uploading.** Cesium: 170 time-dynamic ellipsoids
  15 to 100 fps by checking values before setting them; re-assigning a
  canvas billboard image created a new atlas texture every frame
  [43]. GL JS stopped rewriting symbol opacity buffers for
  buckets whose dedup result did not change: 260 to 38 buckets per frame,
  frames over 33 ms 89 to 37 under 4x throttle [44]. deck.gl
  fixed a full attribute rebuild caused by a fresh wrapper object each
  render [45].
- **Separate what animates.** Cesium's `setPositions` uploads only the
  position buffer for a range, with the vertex count fixed
  [46]. Treat baked geometry as immutable: frozen clipping
  polygons removed per-frame per-vertex change checks ("vast performance
  improvements") [47].
- **Pace and coalesce uploads when data arrives asynchronously.** RustGIS
  uploads at most 8/32 raster tiles and 4/6 ms per frame (browser/
  desktop); browser frames over 100 ms went from 23-25 to 0
  [48]. ortho-earth uploads at most 3 MB per frame
  [38]. Cesium's worker decode made tiles arrive one per
  frame, each triggering a full re-upload; rebuilds are now debounced
  with a deadline [49]. Keep the old batch drawn until the
  rebuilt one is ready, at twice the memory for that moment
  [50].
- **Move a static grid with a uniform.** ortho-earth's terrain mesh is a
  unit grid placed by a window uniform; the old absolute grid reallocated
  75 MB per window change at G=1536 [51].

## 5. Memory: drop copies, cap every pool, destroy explicitly

- **Free the CPU copy after upload.** GL JS found that deleting
  `arrayBuffer` left typed views holding it; `freeBufferAfterUpload`
  released about 762 KB per tile and avoids "~2x memory usage (JS heap +
  VRAM)" [52]. navara releases every BufferAttribute's array on
  first upload [53]. Keep it only for picking or re-upload.
- **Every pool needs a cap.** GL JS capped its tile texture reuse pool
  "to prevent unbounded VRAM growth during rapid zoom/pan"
  [54]. MapLibre Native's pool of 64 texture names saved
  nothing, because the next `glTexImage` reallocated storage; pooling
  storage by size and format reduced allocation spikes on a Pixel 6 but
  did not remove them [55]. GL JS leaked hillshade textures
  until the pool keyed on the real stride including the border
  [56]. Cesium removed its imagery texture pool: mipmapped and
  non-mipmapped textures in one pool showed stale mip levels in Chrome,
  and pooling had gained little [57].
- **Budget by bytes.** Vertex counts per feature vary by orders of
  magnitude: RustGIS bounds streamed views at 128 MiB desktop and 48 MiB
  browser [58], and estimates a layer's vertex count before
  tessellating, sending a layer past 2M vertices (80 MB) to the CPU
  instead of failing the whole scene on `max_buffer_size`
  [59]. maplibre-rs hard-capped 32 tiles because pitch
  overran fixed GPU buffers, at the price of arbitrary tiles vanishing
  [60]. (Tile-cache budgets: `tile-cache-and-loading`.)
- **On WebGPU in the browser, `destroy()` explicitly.** wgpu's `Drop`
  frees nothing on the web; RustGIS hit `VK_ERROR_OUT_OF_DEVICE_MEMORY`
  until every buffer and texture was owned and destroyed
  [61].
- **WASM memory never shrinks.** reearth-papers measured one CJK theme at
  82 MB and three at 182 MB against a 128 MB isolate, cut resident
  renderers from 3 to 1, and restored 3 after glyph subsetting made each
  extra theme about 12 MB [62][63]. Re-take
  `memory.buffer` views after any call that can grow memory; free
  wasm-bindgen objects explicitly [64].
- **Large single allocations fail.** deck.gl layers crash between 10M and
  100M items because of per-allocation limits (Chrome about 1 GB); split
  into chunks, and size buffers exactly on phones (`overAlloc: 1`)
  [65].
- **The drawing buffer is memory too.** GL JS caps the canvas at
  4096x4096 by default [66]. navara caps DPR at 2 on mobile,
  because its render-target stack costs about 100 B per pixel and grows
  with DPR squared [53]. Antialias offscreen work once in a
  shared MSAA target: per-tile multisampled drape targets quintupled
  their footprint in navara [67]. ortho-earth composes AO with
  a multiply blend instead of an extra full-resolution target (about
  12 MB at DPR 2) [68], and kept one shadow window instead of
  3 cascades (about 48 MB) [69].
- **A cancelled request must not call back.** GL JS saw unbounded memory
  growth from responses to aborted tile requests until the callback was
  nulled at cancel [70].

## 6. Render-to-texture caches: measure the hit rate and the memory

- GL JS's terrain drape cache was a 30-slot stamped LRU with a 0.2% hit
  rate; tying slots to tile lifetime made it 94.6% and the globe bench
  about 37 ms instead of about 410 ms, for 302 MB instead of 151 MB, and
  a maintainer later reported OOM and FPS drops on a phone [71].
  A larger pool alone stayed at 0.1%; without frees it hit 95% at
  3.36 GB [71].
- GL JS closed a proposal to snapshot stable bottom layers into a
  viewport texture: invalidation (camera, resize, paint, tile arrival)
  was "a hornet's nest" in a general engine [72]. A renderer
  whose request is an animated overlay on a static map has few
  invalidation triggers and can do it.
- navara bakes all overlays of a terrain tile into one atlas when the tile
  is dirty, so the terrain shader makes 3 lookups however many layers
  there are: about 10 FPS more, for a render target per tile
  [73].
- **Shader binary caches, measured both ways.** MapLibre Native removed
  its program-binary cache: initial launch was slower with it on every
  phone measured (Wiko 2060 vs 3876 ms), relaunch mixed, and dropping it
  saved 150-180 KB [74]. Example 05 kept one: on NVIDIA
  desktop it avoided loading the GLSL compiler, 166 to 124 MB resident
  and first frame 183 to 107 ms [75]. Decide on the target device.

## 7. API baseline and driver traps

- Target WebGL2 / GLES3 and write one path. MapLibre Native dropped ES2
  for UBOs and VAOs [76]; Cesium defaults to WebGL2 and requires
  instancing and vertex texture fetch for billboards and labels
  [9]. VAO blacklists for Adreno 3xx/4xx and PowerVR matter
  only for old Android GPUs [77].
- GPU reductions depend on drivers: deck.gl's heatmap max rendered to a
  1x1 texture returned 0 on Windows ANGLE [78]. Example 04
  reduces on the GPU; check its result on ANGLE/D3D before relying on it
  elsewhere [1].
- GPU aggregation beat CPU only from about 100K points (25K: CPU 535 vs
  GPU 359 it/s; 1M: 12.7 vs 158) [79].
- three.js caches the instance ceiling at the first VAO bind; navara's
  labels added later silently never drew [10].
- No string lookups in the frame loop: compact program-cache keys
  [80]; an ordered layer vector made a Native bench about 70%
  faster [81]; reuse per-frame arrays [82].

## Tried and reverted

- MapLibre Native reverted "eliminate copies in deferred cleanup"
  (#3035): memory grew [83]; and reverted conditional
  attribute binding on Android [32].
- navara reverted an UnsignedByte MRT attachment [37] and a
  polyline change in GeoJSON batching [2].
- Cesium removed its imagery texture pool [57] and CPU
  instancing [9]; added `Object.freeze` to clipping
  polygons, removed it, then brought it back [47].
- deck.gl added separate GPU/CPU grid layer classes and folded them back
  into one with a flag [79].
- MapLibre Native removed program-binary caching [74].
- GL JS closed the viewport snapshot cache [72].
- ortho-earth measured and declined a per-arc LOD table (+25-50% GPU
  memory for a 10% density gain in z3-5) [84] and CDLOD terrain
  [16].

## Guidance for a renderer here

1. Write the GPU layout in `bake.ts`: Uint8 normalised colours, 16-bit
   quantised positions against a batch origin, strides padded to 4 bytes,
   Uint16 indices with batches split under 65,536 vertices (Uint32 only
   if a single draw needs it), ids from `gl_InstanceID`/`gl_VertexID`.
   Record bytes per vertex and per feature in `performance_knowledge`.
2. Emit as few draw units as the request's draw order allows: one per
   layer, or per tile when streaming; instancing for repeated quads,
   circles and glyphs; order fixed at bake time.
3. Upload once with `STATIC_DRAW`, then drop the typed array unless
   picking or re-upload needs it. Change uniforms per frame. If something
   edits at run time, sub-upload the changed range, or put per-feature
   state in a lookup texture.
4. If streaming: one buffer per tile or a pool with a byte cap, uploads
   paced per frame, old content kept until new lands, explicit
   `deleteBuffer`/`destroy()` on eviction, and a check that memory is
   flat after a long pan.
5. Cap DPR and the drawing buffer for phones and count render targets in
   the memory budget; avoid per-tile MSAA and extra full-resolution
   targets.
6. Add a texture pool, a render-to-texture cache or a shader binary cache
   only after measuring the hit rate and the memory on the target device,
   and give it a cap.
7. Bench: report draw calls, buffer bytes and peak memory (JS heap,
   `process` RSS natively) next to frame times, and add checks that read
   what reached the screen after the optimisation (navara's instancing
   port and ortho-earth's pick program both broke silently)
   [8][14].

## Sources

1. `README.md`, `skills/map-from-scratch/SKILL.md`, `skills/map-from-scratch/references/patterns.md` (this repository)
2. navara GeoJSON batching: https://github.com/maplibre/navara/pull/446, https://github.com/maplibre/navara/pull/497
3. Cesium buffer primitive collections: `ref-repos/CesiumGS__cesium/CHANGES.md`, https://github.com/CesiumGS/cesium/pull/13212, https://github.com/CesiumGS/cesium/pull/13505, https://github.com/CesiumGS/cesium/pull/13477
4. reearth-visualizer feature delegate threshold: https://github.com/reearth/reearth-visualizer/commit/94bc5964
5. MapLibre Native drawable renderer: `ref-repos/maplibre__maplibre-native/design-proposals/2022-10-27-rendering-modularization.md`, `ref-repos/maplibre__maplibre-native/platform/ios/CHANGELOG.md`, https://github.com/maplibre/maplibre-native/pull/3384
6. deck.gl instanced circle quads: https://github.com/visgl/deck.gl/commit/f70a37d4
7. deck.gl H3 instancing: https://github.com/visgl/deck.gl/commit/b7c75e4a, https://github.com/visgl/deck.gl/commit/7ba2daff
8. navara instanced sprites: https://github.com/maplibre/navara/pull/434
9. Cesium minimum GPU feature set: `ref-repos/CesiumGS__cesium/CHANGES.md`, https://github.com/CesiumGS/cesium/issues/13053, https://github.com/CesiumGS/cesium/pull/13253, https://github.com/CesiumGS/cesium/pull/10894, https://github.com/CesiumGS/cesium/pull/12983, https://github.com/CesiumGS/cesium/pull/10589
10. navara text batching: https://github.com/maplibre/navara/blob/main/guide/TEXT_BATCHING.md
11. MapLibre GL JS single-pass halo: `ref-repos/maplibre__maplibre-gl-js/CHANGELOG.md` (5.24.0), https://github.com/maplibre/maplibre-gl-js/pull/7436
12. MapLibre GL JS sort only overlapping symbols: https://github.com/maplibre/maplibre-gl-js/commit/e1e68a80c
13. MapLibre Native symbol-sort-key and batching: https://github.com/maplibre/maplibre-native/issues/3223
14. ortho-earth 4-vertex quads: https://github.com/kenjiyoshidahome2026-bit/ortho-earth/blob/main/packages/ortho-core/perf%20plan.md, `ref-repos/kenjiyoshidahome2026-bit__ortho-earth/packages/ortho-core/perf plan.md`
15. MapLibre Native indexed drawing: https://github.com/maplibre/maplibre-native/commit/54c557d98, https://github.com/maplibre/maplibre-native/commit/bcad3b6d4
16. ortho-earth terrain chunk culling: https://github.com/kenjiyoshidahome2026-bit/ortho-earth/blob/main/packages/ortho-core/perf%20plan.md
17. deck.gl vertex collapse: https://github.com/visgl/deck.gl/commit/85298e97, https://github.com/visgl/deck.gl/commit/469590d0
18. ortho-earth WebGL multi-draw pool: https://github.com/kenjiyoshidahome2026-bit/ortho-earth/commit/7ab5a263, https://github.com/kenjiyoshidahome2026-bit/ortho-earth/commit/d1048bc1, https://github.com/kenjiyoshidahome2026-bit/ortho-earth/commit/71a4ac76
19. deck.gl Uint8 colours: https://github.com/visgl/deck.gl/commit/4236b39d
20. ortho-earth Uint8 colours: https://github.com/kenjiyoshidahome2026-bit/ortho-earth/commit/04d4fe9a
21. deck.gl constant accessors: https://github.com/visgl/deck.gl/blob/master/docs/developer-guide/performance.md, https://github.com/visgl/deck.gl/blob/master/dev-docs/RFCs/v5.3/constant-accessor-rfc.md, `ref-repos/visgl__deck.gl/docs/whats-new.md`
22. deck.gl attribute behind a define: https://github.com/visgl/deck.gl/commit/8484984b
23. MapLibre GL JS 4-byte line vertices: https://github.com/maplibre/maplibre-gl-js/commit/991ab7d1a
24. ortho-earth indexed fills: https://github.com/kenjiyoshidahome2026-bit/ortho-earth/commit/c8febdff
25. Cesium index type per batch: https://github.com/CesiumGS/cesium/commit/ee98e8aab42cbca4e15ef6d054e8015c266b42d0, https://github.com/CesiumGS/cesium/commit/283e394fd2798043d4166f41eabb1204590327ee
26. Cesium 16-bit index terrain grids: https://github.com/CesiumGS/cesium/commit/0eafc5417, https://github.com/CesiumGS/cesium/commit/9fc98317e, https://github.com/CesiumGS/cesium/commit/610ad4f2f
27. Cesium quantised terrain: `ref-repos/CesiumGS__cesium/CHANGES.md`, http://cesiumjs.org/2015/12/18/Terrain-Quantization/
28. MLT layer-global indices: https://github.com/yuiseki/maplibre-tile-spec/commit/211c4124, https://github.com/maplibre/maplibre-tile-spec/blob/main/docs/specification/v2.md, `ref-repos/yuiseki__maplibre-tile-spec/docs/specification/v2.md`
29. MLT triangle trees: https://github.com/yuiseki/maplibre-tile-spec/commit/8c8b4d64, https://github.com/yuiseki/maplibre-tile-spec/commit/1cdc94a6, https://github.com/maplibre/maplibre-tile-spec/blob/main/docs/benchmarks.md
30. deck.gl picking ids from instance index: https://github.com/visgl/deck.gl/blob/master/docs/whats-new.md, https://github.com/visgl/deck.gl/blob/master/docs/upgrade-guide.md, https://github.com/visgl/deck.gl/commit/0c4b7d11, https://github.com/visgl/deck.gl/commit/48760d53
31. deck.gl picking colour cap: https://github.com/visgl/deck.gl/commit/37237d01
32. MapLibre Native attribute binding: https://github.com/maplibre/maplibre-native/commit/874244a65, https://github.com/maplibre/maplibre-native/commit/eed89fcf9, https://github.com/maplibre/maplibre-native/commit/441644166
33. deck.gl flat columns: https://github.com/visgl/deck.gl/commit/23e269a1
34. navara batch texture: https://github.com/maplibre/navara/blob/main/guide/BATCH_TEXTURE.md
35. Cesium 2D power-of-two lookup textures: https://github.com/CesiumGS/cesium/commit/2ce10a6e58ceda1fa37aae51a6c6d61fa822e98a, https://github.com/CesiumGS/cesium/commit/e39461bcfe48e58aacaff3a5552e7298d8c89e25
36. Cesium clipping planes texture: https://github.com/CesiumGS/cesium/pull/6201
37. navara bitmask MRT attachment: https://github.com/maplibre/navara/commit/f96c2449
38. ortho-earth WebGPU tile pool: https://github.com/kenjiyoshidahome2026-bit/ortho-earth/blob/main/packages/ortho-core/vt%20perf%20plan.md, `ref-repos/kenjiyoshidahome2026-bit__ortho-earth/packages/ortho-core/vt perf plan.md`, `ref-repos/kenjiyoshidahome2026-bit__ortho-earth/packages/ortho-core/fallback-ladder.md`
39. deck.gl incremental loading: https://github.com/visgl/deck.gl/blob/master/docs/developer-guide/performance.md, `ref-repos/visgl__deck.gl/docs/whats-new.md`
40. RustGIS picture renderer abandoned: https://github.com/opengeos/RustGIS/issues/635, https://github.com/opengeos/RustGIS/pull/548
41. MapLibre GL JS buffer reuse for feature state: https://github.com/maplibre/maplibre-gl-js/commit/8be10756d
42. MapLibre Native glyph atlas sub-upload: https://github.com/maplibre/maplibre-native/commit/78073d6fd
43. Cesium dirty checks: https://github.com/CesiumGS/cesium/commit/bfc4db038, https://github.com/CesiumGS/cesium/commit/bd3f0c0d9, https://github.com/CesiumGS/cesium/commit/8af426b69
44. MapLibre GL JS opacity buffer reuse: https://github.com/maplibre/maplibre-gl-js/pull/8434
45. deck.gl spurious data changes: https://github.com/visgl/deck.gl/commit/c7f1a66e
46. Cesium setPositions: https://github.com/CesiumGS/cesium/commit/78c1f72c1e97055127c548b06bbf2aa97bf805b2, https://github.com/CesiumGS/cesium/commit/de376c12ea26743dc1390eccb5819be9e53a3fc1
47. Cesium immutable clipping polygons: https://github.com/CesiumGS/cesium/pull/13665, https://github.com/CesiumGS/cesium/pull/13654, https://github.com/CesiumGS/cesium/commit/a21f4d9d92cb2baaf6c0b65588d0cb01c545d0aa, https://github.com/CesiumGS/cesium/commit/351c0acc7f82af568a7c78b836c4eddf19b9d819
48. RustGIS raster texture-array pool: https://github.com/opengeos/RustGIS/pull/645, https://github.com/opengeos/RustGIS/commit/50acdc7
49. Cesium debounced splat rebuilds: https://github.com/CesiumGS/cesium/pull/13669
50. Cesium old batch kept until rebatch: https://github.com/CesiumGS/cesium/commit/bb8de2e94
51. ortho-earth unit-grid terrain: https://github.com/kenjiyoshidahome2026-bit/ortho-earth/blob/main/packages/ortho-core/webgpu%20port.md, `ref-repos/kenjiyoshidahome2026-bit__ortho-earth/packages/ortho-core/perf survey.md`
52. MapLibre GL JS freeBufferAfterUpload: https://github.com/maplibre/maplibre-gl-js/commit/c2e92ecc7
53. navara memory management: https://github.com/maplibre/navara/blob/main/guide/MEMORY_MANAGEMENT.md
54. MapLibre GL JS tile texture pool cap: https://github.com/maplibre/maplibre-gl-js/commit/e50aa58b0
55. MapLibre Native texture pool by storage: https://github.com/maplibre/maplibre-native/pull/2709
56. MapLibre GL JS hillshade texture pool by stride: https://github.com/maplibre/maplibre-gl-js/commit/22ab43e08
57. Cesium imagery texture pool removed: https://github.com/CesiumGS/cesium/commit/8f3c8a4b5
58. RustGIS byte-bounded views and chunked rendering: `ref-repos/opengeos__RustGIS/docs/user-guide/data.md`, https://github.com/opengeos/RustGIS/commit/cfeef0c, https://github.com/opengeos/RustGIS/commit/f9a214a
59. RustGIS mesh size estimate: https://github.com/opengeos/RustGIS/commit/57036b6
60. maplibre-rs tile cap: https://github.com/maplibre/maplibre-rs/pull/147, https://github.com/maplibre/maplibre-rs/pull/134, https://github.com/maplibre/maplibre-rs/commit/d69f81f, https://github.com/maplibre/maplibre-rs/commit/fa2c436
61. RustGIS WebGPU destroy and image decode: https://github.com/opengeos/RustGIS/pull/630, https://github.com/opengeos/RustGIS/commit/f8f84ac
62. reearth-papers resident renderers and WASM heap: https://github.com/reearth/reearth-papers/commit/26acd28, https://github.com/reearth/reearth-papers/commit/eabf229, https://github.com/reearth/reearth-papers/commit/2007668, https://github.com/reearth/reearth-papers/commit/b82da28, `ref-repos/reearth__reearth-papers/src/ezu.ts`
63. reearth-papers glyph subsets: https://github.com/reearth/reearth-papers/commit/9e766d6, https://github.com/reearth/reearth-papers/commit/26acd28, `ref-repos/reearth__reearth-papers/src/glyphs.ts`
64. navara WASM memory views: https://github.com/maplibre/navara/commit/268b8aab, https://github.com/maplibre/navara/commit/4af8b7b0, https://github.com/maplibre/navara/commit/6087f0c1
65. deck.gl allocation limits: https://github.com/visgl/deck.gl/blob/master/docs/developer-guide/performance.md, https://github.com/visgl/deck.gl/blob/master/docs/developer-guide/tips-and-tricks.md
66. MapLibre GL JS maxCanvasSize: `ref-repos/maplibre__maplibre-gl-js/CHANGELOG.md` (3.2.0), https://github.com/maplibre/maplibre-gl-js/pull/2674
67. navara shared MSAA bake target: https://github.com/maplibre/navara/blob/main/guide/TILE_TEXTURE_COMPOSITING.md
68. ortho-earth half-resolution AO: https://github.com/kenjiyoshidahome2026-bit/ortho-earth/issues/46, https://github.com/kenjiyoshidahome2026-bit/ortho-earth/issues/63
69. ortho-earth shadow window: https://github.com/kenjiyoshidahome2026-bit/ortho-earth/issues/112
70. MapLibre GL JS cancelled worker callbacks: https://github.com/maplibre/maplibre-gl-js/commit/b5c90201d
71. MapLibre GL JS terrain RTT cache: https://github.com/maplibre/maplibre-gl-js/pull/7549, https://github.com/maplibre/maplibre-gl-js/commit/1454a123f, https://github.com/maplibre/maplibre-gl-js/pull/7635
72. MapLibre GL JS viewport snapshot proposal (closed): https://github.com/maplibre/maplibre-gl-js/pull/7635
73. navara per-tile overlay atlas: https://github.com/maplibre/navara/pull/642, `ref-repos/maplibre__navara/guide/TILE_TEXTURE_COMPOSITING.md`
74. MapLibre Native program binary removal: https://github.com/maplibre/maplibre-native/commit/c2f974f2a57348213cc02d2472f9c54ba86e6010
75. `examples/05-tokyo-roads-native/spec.yaml` `performance_knowledge` (this repository)
76. MapLibre Native GLES 3.0: https://github.com/maplibre/maplibre-native/pull/995, https://github.com/maplibre/maplibre-native/pull/3838
77. MapLibre Native VAOs and blacklists: https://github.com/maplibre/maplibre-native/commit/de91e6809, https://github.com/maplibre/maplibre-native/commit/bf9c1fb1b, https://github.com/maplibre/maplibre-native/commit/0bbc6b814, https://github.com/maplibre/maplibre-native/commit/00d133239e22fc6df84f81596820ca46afb351bb
78. deck.gl heatmap on ANGLE: https://github.com/visgl/deck.gl/issues/3554, https://bugs.chromium.org/p/angleproject/issues/detail?id=3941
79. deck.gl GPU aggregation: https://github.com/visgl/deck.gl/blob/master/docs/api-reference/aggregation-layers/overview.md, https://github.com/visgl/deck.gl/blob/master/docs/upgrade-guide.md
80. MapLibre GL JS program cache keys: https://github.com/maplibre/maplibre-gl-js/commit/765e71384
81. MapLibre Native ordered render layers: https://github.com/maplibre/maplibre-native/commit/064c60cdcab331bc19fe399492179dcb5b29121a
82. Cesium per-frame array reuse: https://github.com/CesiumGS/cesium/commit/c6efe94f3, https://github.com/CesiumGS/cesium/commit/110f30f3f, https://github.com/CesiumGS/cesium/commit/2dc7b54ff
83. MapLibre Native deferred cleanup revert: `ref-repos/maplibre__maplibre-native/platform/ios/CHANGELOG.md`, `ref-repos/maplibre__maplibre-native/platform/android/CHANGELOG.md`, https://github.com/maplibre/maplibre-native/pull/3035
84. ortho-earth LOD calibration: https://github.com/kenjiyoshidahome2026-bit/ortho-earth/blob/main/packages/geopbf/lod-calibration-2026-10-12.md
85. MapLibre GL JS collision boxes in StructArray: https://github.com/maplibre/maplibre-gl-js/commit/11c8bb562, https://github.com/maplibre/maplibre-gl-js/commit/7b638de40
86. MapLibre GL JS atlas packing: https://github.com/maplibre/maplibre-gl-js/commit/311054442, https://github.com/maplibre/maplibre-gl-js/commit/8dd624d4e
87. MapLibre GL JS sprites on demand: https://github.com/maplibre/maplibre-gl-js/commit/c8615fae1
88. MapLibre Native clip IDs: https://github.com/maplibre/maplibre-native/commit/0cd646180
89. MapLibre Native collision debug buffers: https://github.com/maplibre/maplibre-native/commit/e582a329ef0150616b0d0e1d7c8f44bd31d92f26, https://github.com/maplibre/maplibre-native/commit/c9924ae9d5d6e499267eea3bb9b1092bfd18ddf4
90. MLT columnar layout: https://github.com/maplibre/maplibre-tile-spec/blob/main/docs/overview.md, https://github.com/maplibre/maplibre-tile-spec/blob/main/docs/benchmarks.md, `ref-repos/yuiseki__maplibre-tile-spec/docs/overview.md`, `ref-repos/yuiseki__maplibre-tile-spec/docs/benchmarks.md`
91. MLT in-memory model: https://github.com/maplibre/maplibre-tile-spec/blob/main/docs/implementation-guide.md, `ref-repos/yuiseki__maplibre-tile-spec/docs/implementation-guide.md`
92. mlt-wasm: https://github.com/maplibre/maplibre-tile-spec/blob/main/rust/mlt-wasm/README.md, `ref-repos/yuiseki__maplibre-tile-spec/rust/mlt-wasm/README.md`
93. RustGIS CPU reference renderer: `ref-repos/opengeos__RustGIS/docs/user-guide/maps.md`, `ref-repos/opengeos__RustGIS/ROADMAP.md`, `ref-repos/opengeos__RustGIS/docs/architecture.md`
94. RustGIS vector tile meshes: https://github.com/opengeos/RustGIS/issues/596, https://github.com/opengeos/RustGIS/pull/606, https://github.com/opengeos/RustGIS/pull/611, https://github.com/opengeos/RustGIS/commit/d724d89, https://github.com/opengeos/RustGIS/commit/9f318db
95. reearth-papers render concurrency: https://github.com/reearth/reearth-papers/commit/2007668, https://github.com/reearth/reearth-papers/commit/eabf229, `ref-repos/reearth__reearth-papers/CONTRIBUTING.md`
96. Cesium cacheBytes: `ref-repos/CesiumGS__cesium/CHANGES.md`, https://github.com/CesiumGS/cesium/pull/11310
97. Cesium loader hot paths: https://github.com/CesiumGS/cesium/issues/11197, https://github.com/CesiumGS/cesium/pull/13643, https://github.com/CesiumGS/cesium/pull/13808
98. Cesium skip-LOD and derived commands: https://github.com/CesiumGS/cesium/pull/5128, https://github.com/CesiumGS/cesium/pull/5851
99. Cesium SDF labels: https://github.com/CesiumGS/cesium/pull/7730
100. Cesium power-of-two atlas: https://github.com/CesiumGS/cesium/commit/3c400241a1a82ea25539c81966189e93f683c219, https://github.com/CesiumGS/cesium/commit/0a49108a5025feb5e2f6a420ccd58919e39061f3
101. deck.gl binary attributes: https://github.com/visgl/deck.gl/blob/master/dev-docs/RFCs/v8.0/binary-support-improvements-rfc.md, https://github.com/visgl/deck.gl/blob/master/dev-docs/roadmaps/performance-roadmap.md, https://github.com/visgl/deck.gl/blob/master/docs/developer-guide/performance.md
102. deck.gl pickMultipleObjects: https://github.com/visgl/deck.gl/pull/1730
103. deck.gl tile cache by bytes: https://github.com/visgl/deck.gl/issues/4230
104. ortho-earth derived Gint layer: https://github.com/kenjiyoshidahome2026-bit/ortho-earth/blob/main/packages/geopbf/pbf%20spec.md, https://github.com/kenjiyoshidahome2026-bit/ortho-earth/blob/main/packages/geopbf/README.md, `ref-repos/kenjiyoshidahome2026-bit__ortho-earth/packages/ortho-core/gint draw spec.md`
105. ortho-earth elevation decode: https://github.com/kenjiyoshidahome2026-bit/ortho-earth/commit/c428c1a7, https://github.com/kenjiyoshidahome2026-bit/ortho-earth/commit/09245d64, https://github.com/kenjiyoshidahome2026-bit/ortho-earth/commit/952ad0e7
