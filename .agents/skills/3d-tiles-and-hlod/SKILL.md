---
name: 3d-tiles-and-hlod
description: How map engines stream hierarchical level-of-detail content (3D Tiles, point-cloud octrees, chunked 3D vector and terrain trees) and which of their choices a purpose-built renderer should copy or skip. Load it when a map-from-scratch request involves 3D city models (PLATEAU, b3dm/glb, Google Photorealistic tiles), point clouds (pnts, LAS/COPC/EPT/Potree), photogrammetry or any data too large to keep on the GPU at once, i.e. before choosing bounding volumes, a screen-space-error rule, a tile cache budget or per-feature picking and styling for tiled 3D content.
---

# 3D Tiles and HLOD: selecting, loading and releasing tiles of detail

A hierarchical level-of-detail (HLOD) tileset is a tree in which each node
carries a bounding volume, a geometric error and some content; the renderer
walks the tree every frame, keeps a node when its projected error is small
enough, descends when it is not, and streams, caches and evicts content as
the camera moves. Every engine below got some part of this wrong first: the
error test, the bounding volume, empty or missing children, memory that was
never released, per-feature bookkeeping that cost more than drawing, or
float precision. Example 22 streams PLATEAU buildings; for its live data,
rendering and cache pitfalls, also read
[plateau-3d-tiles](../plateau-3d-tiles/SKILL.md). Most advice here concerns
what a fixed, baked dataset lets you leave out.

## Selection: bounding volumes and the error test

- **Error test.** Cesium computes a tile's screen-space error as
  `geometricError * drawingBufferHeight / (distance * sseDenominator)`,
  divided by the pixel ratio; a leaf with zero error short-circuits to 0
  [61]. Use the distance to the bounding volume, not to its centre: iTowns
  measured to the centre until 2017, then fixed its SSE computation to use
  the distance to the bounding volume [43].
- **The threshold is part of the data.** TerriaJS maps its quality slider to
  `maximumScreenSpaceError = 8 * base` (16 at the default) and removed the
  special case that set it to 1, because datasets are authored for Cesium's
  default of 16 and a value of 1 means "16 * 16 more detail" in 2D, more
  like cubed in 3D, "and probably crash the browser"; one named tileset
  (aero3Dpro) looks poor at 16 [52].
- **Bounding volumes.** 3D Tiles has box (OBB), sphere and region
  (lon/lat/height). Cesium keeps a conservative OBB of a region for frustum
  tests but computes the distance on the region itself, which "avoids
  refining too soon"; an exact visibility test on a region was judged slow
  because the shape is not convex [8]. iTowns went the other way in 2023 and
  turns regions into an enclosing sphere at load, "to simplify and speed
  computation and culling" and to simplify parsing, with a breaking API
  change [36, 37].
- **Leaves are always acceptable.** QGIS lost terrain tiles near the ground
  until a node that cannot have children was drawn even when the error test
  wanted finer detail [21]. Overzoom the leaf.
- **Validate child lists.** deck.gl drew Google Photorealistic tiles blurrier
  than Cesium because a blank entry in a children list stopped traversal at
  depth 19 where Cesium reached 31 at the same view; lowering the SSE (down
  to 1, even negative) changed nothing. The fix was to filter empty children
  in loaders.gl 3.4.11 [13]. Compare selected depths with a reference engine
  on the same view before tuning thresholds [13].
- **Empty nodes poison the depth range.** QGIS removed empty vector chunk
  nodes and stopped them contributing to parent bounds, because their extreme
  height ranges broke the near/far plane calculation [31, 32].

## Loading and refinement

- **Do not walk every ancestor.** osgEarth's own loader refined level by
  level and was slower in C++ than CesiumJS in a browser; the maintainer put
  it down to Cesium's level skipping ("we're probably loading more data"),
  and the answer was to integrate cesium-native, with version pinning and
  build breakage as the price [56].
- **Additive refinement**: iTowns downloads only the children that will be
  visible, while replace refinement still fetches all children, for "the
  same visual result" with less network and memory [44].
- **Drop requests that left the view.** QGIS removes queued chunk loads
  whose box is now culled by the view-projection matrix, scanning the queue
  each update (code marked wip) [30].
- **Create nodes lazily.** iTowns creates point-cloud child nodes only when
  the parent loads [42] and later shares hierarchy references between
  children to cut upfront memory [48]. Cesium's first implicit-tiling code
  expands one subtree's availability bitstream at a time, with placeholder
  tiles for unexpanded subtrees, instead of an explicit JSON listing every
  tile [9].
- **Bake the tree from density, not from a fixed depth.** QGIS 3D vector
  chunks load up to a feature budget per node and split when the node's
  largest side in pixels exceeds the error, avoiding very thin or wide
  chunks and endless children for empty tiles [28].
- **Parsing is a real cost.** osgEarth sped up glTF/b3dm loading by moving
  from jsoncpp to RapidJSON, reserving arrays and a faster base64 decoder
  ("Not sure why it's so much faster"), then reverted a tinygltf upgrade that
  broke binary writing [57, 58, 59].

## Memory: budgets and release

- **One byte budget across layers, a hard ceiling on weak devices.**
  maptalks budgets 3D Tiles GPU memory in MB: 1024 by default, then 1536
  with one global LRU shared by all layers, 32 MB on mobile [33, 34], and
  later fixed over-budget edge cases [35]. TerriaJS clamps `cacheBytes` to
  min(authored, 128 MiB) and `maximumCacheOverflowBytes` to min(authored,
  64 MiB) at the low-spec tier (defaults 512 MiB), as "a crash-prevention
  safety valve, not a fidelity dial" [53], and its quality slider also
  scales tile cache, resolution, fog, shadows and point attenuation as a
  device preference, not as saved view state [49].
- **Hidden is not released.** ortho-earth found 13 hidden LOD1 tilesets of
  Yokohama still holding 666 tiles (~490 MB) and hidden LOD2 meshes ~188 MB,
  because the shared 512 MB budget was never exceeded; tilesets hidden for
  20 s now unload, and hidden meshes leave the GPU while their IndexedDB/OPFS
  copies stay [14].
- **Shared caches come and go.** iTowns first shared one LRU and
  download/parse queues across all tilesets "to cut down on memory and
  correctly prioritize downloads"; sharing across all views broke multiple
  views, so in 2024 it became per view [45, 47], and in 2026 the sharing was
  removed without stating why [46]. deck.gl passes all active viewports to
  one tileset's traversal and tracks each view's last updated viewport "to
  prevent thrashing in multiview mode" [12].
- **Point budgets are node-granular.** QGIS set the minimum point budget to
  100,000 because whole nodes load and small budgets would be visibly
  exceeded, and dropped the per-chunk primitive budget from the generic
  chunk loader (no reason given) [18, 19, 20].
- **Shared GPU resources need one owner.** Destroying a TerriaJS tileset also
  destroyed imagery layers it shared with the globe, and Cesium crashed
  rendering them [54].

## Features: picking, selection and styling

- **Do not build per-feature objects at load.** iTowns removed eager
  batch-table pre-filling as a load-time overhead and now looks attributes up
  on first access (for example on pick) [38]. reearth stopped syncing every
  feature into app state on tile load and unload and tags the raw feature
  instead [4]; its restyle runs in rAF-sized async jobs, at most 5,000 in
  flight, abandoned when a newer style arrives [3].
- **Selection is a set of ids applied as tiles load.** A building split over
  several tiles must be selected whole: navara maps an id property (gml_id)
  to all its batch ids and checks the stored selection whenever a batch is
  created, because batches loaded after the click were not highlighted; the
  loop caused an FPS drop at click time [1]. reearth keeps a `key -> [content,
  batchId]` index filled at load instead of searching the tile tree [5, 6, 7].
  TerriaJS scans each tile's features once (a Set of seen tiles), tags matches
  and colours them with one style rule, so removing the highlight needs no
  saved colours [50]; a separate bug reloaded the whole tileset on a UI
  re-render while the user scrolled the results [51].
- **Keep picking out of the frame.** Adding shadows to iTowns slowed 3D Tiles
  and the profile showed most time in picking; the author's machine was "too
  good to notice" [41].

## Precision and geometry

- **Tile-local origins, bounds in doubles.** QGIS moved point-cloud and
  vector chunk vertices from scene-origin-relative floats to an origin at a
  corner of each chunk, and chunk bounds from float AABBs to double boxes in
  map coordinates, which also removed axis flipping inside chunks [15, 24,
  25, 26, 27]. When coordinates are quantised, keep offset and scale as full
  doubles: QGIS/untwine datasets failed to index or were misaligned [22, 23].
- **Clipping makes seams.** QGIS clips large features to the chunk extent and
  removes outline edges lying on the chunk boundary [29].
- **Cull by chunk, not per vertex.** deck.gl's draft RFCs estimate 3-4x from
  frustum culling of bounded layers ("5 FPS into 20 FPS") and judge
  vertex-shader culling unlikely to give large gains because every vertex is
  still processed [10, 11]. osgEarth disabled elevation-based cluster
  culling by default because geometry standing on the terrain extends above
  the tile's elevation range [60].

## Implement only what the data uses

navara's pnts reader handles Draco-compressed point clouds first because
that is what the datasets used; uncompressed colours and batched points were
left out [2]. osgEarth's glTF loader "is NOT fully implemented", and an
instanced model broke where the same model alone was fine [55]. iTowns
(2024) added an OGC3DTilesLayer built on 3d-tiles-renderer-js and
deprecated its own C3DTilesLayer in its favour (no reason given), and osgEarth turned to cesium-native when its loader was too
slow; both paid with a heavy dependency, migration work and integration or
build bugs [39, 40, 37, 56]. QGIS kept its 3D view in a separate optional library and planned labels
off by default in 3D [16, 17].

## Guidance for a renderer in this repository

- **Prefer baking the tileset into your own format.** A request with one
  fixed dataset does not need the 3D Tiles spec at run time; the engines that
  implemented it in full ended up depending on a library [39, 56]. Bake a
  regular quadtree or octree with implicit bounds (derive them from z/x/y
  like Cesium's implicit tiling [9]), split by feature or point count [28],
  and record per node: a lon/lat/height region for distance and error [8], a
  box in the render frame for the frustum test [8, 36], a double-precision
  origin [24], and the geometric error.
- **Choose the error threshold from visible coverage and measured traffic**
  for the data and device. A loose threshold can finish quickly while showing
  sparse parent content, as example 22 demonstrated. If you expose it, clamp
  it [52]. Treat leaves as final [21] and drop empty nodes from the tree and
  from the bounds [31].
- **Skip levels** you do not need to show on the way down [56]; for additive
  content request only visible children [44]; drop queued requests that left
  the frustum [30].
- **Budget GPU memory in bytes with a device ceiling** [53, 33], and release
  anything hidden after a timeout [14]. Make the bench report resident bytes
  and tile counts after a camera path that leaves and returns, and add a
  budget for both.
- **Features live in tiles.** Bake a global feature id into each vertex,
  keep attributes in one columnar table keyed by that id, and decode on pick
  [38]. Put selection and highlight in a per-feature state texture read in
  the shader, so a new tile picks up the selection without a CPU pass and a
  restyle is one upload [1, 3, 50]. Picking can reuse the 1x1 id render of
  example 02 (references/patterns.md in the map-from-scratch skill).
- **Store vertices relative to the tile origin** in float32 or quantised
  16-bit [15, 24], as the 2D examples already quantise over a bounding box.
- **Verify selection, not only frame time.** Add a check that the selected
  depth at a close-up view reaches the deepest baked level [13], that no hole
  appears at the closest zoom [21], and that the near/far planes are finite
  [31]. Fast frames from a traversal that stopped early are the HLOD form of
  "the renderer drew nothing" (pitfalls.md).
- **When a general engine is the right call**: if the request needs broad
  coverage of changing third-party 3D Tiles formats, extensions or styling,
  put the engine under `baselines/` and measure. A live tileset can still use
  a narrow renderer when its actual format subset has been inspected and
  documented, as example 22 does for PLATEAU.

Per-engine detail (what each changed, when, and the open questions) is in
references/engines.md.

## Sources

1. https://github.com/maplibre/navara/pull/133
2. https://github.com/maplibre/navara/pull/302
3. https://github.com/reearth/reearth-visualizer/commit/6448bacb
4. https://github.com/reearth/reearth-visualizer/commit/e645ec9a
5. https://github.com/reearth/reearth-visualizer/pull/920
6. https://github.com/reearth/reearth-visualizer/commit/3c5a29e7
7. https://github.com/reearth/reearth-visualizer/commit/25359fa5
8. https://github.com/CesiumGS/cesium/pull/3325
9. https://github.com/CesiumGS/cesium/pull/9364
10. https://github.com/visgl/deck.gl/blob/master/dev-docs/RFCs/proposals/layer-culling-rfc.md (local: ref-repos/visgl__deck.gl/dev-docs/RFCs/proposals/layer-culling-rfc.md)
11. https://github.com/visgl/deck.gl/blob/master/dev-docs/RFCs/proposals/instance-culling-rfc.md
12. https://github.com/visgl/deck.gl/pull/5758
13. https://github.com/visgl/deck.gl/issues/7955
14. https://github.com/kenjiyoshidahome2026-bit/ortho-earth/commit/942fbc5f
15. ref-repos/qgis__QGIS/ChangeLog:77507 (2024-10-02, "Make coordinates in point cloud chunks independent from scene origin")
16. https://github.com/qgis/QGIS/pull/5203
17. https://github.com/qgis/QGIS-Enhancement-Proposals/issues/105
18. https://github.com/qgis/QGIS/commit/962c68a9d3
19. https://github.com/qgis/QGIS/commit/6019168a86
20. https://github.com/qgis/QGIS/commit/f9e2409866
21. https://github.com/qgis/QGIS/commit/b85234f5fc
22. https://github.com/qgis/QGIS/commit/d5344e584b
23. https://github.com/qgis/QGIS/commit/70dd22392d
24. https://github.com/qgis/QGIS/commit/58e47f19f4
25. https://github.com/qgis/QGIS/commit/3cde17724e
26. https://github.com/qgis/QGIS/commit/4f183696b0
27. https://github.com/qgis/QGIS/commit/bfa8ce048b
28. https://github.com/qgis/QGIS/commit/df087aced7
29. https://github.com/qgis/QGIS/commit/13d03b559a
30. https://github.com/qgis/QGIS/commit/7c647d9cae
31. https://github.com/qgis/QGIS/commit/978fb94bd9
32. https://github.com/qgis/QGIS/commit/bdbd3af8fe
33. https://github.com/maptalks/maptalks.js/commit/c08c151ce
34. https://github.com/maptalks/maptalks.js/commit/59b746ec6
35. https://github.com/maptalks/maptalks.js/commit/64868299c
36. https://github.com/iTowns/itowns/commit/f0eaf96c
37. ref-repos/iTowns__itowns/changelog.md
38. https://github.com/iTowns/itowns/commit/5d2f3847
39. https://github.com/iTowns/itowns/commit/a2fedd83
40. https://github.com/iTowns/itowns/commit/cbfd1bb6
41. https://github.com/iTowns/itowns/pull/2691
42. https://github.com/iTowns/itowns/pull/2710
43. https://github.com/iTowns/itowns/commit/e8ce7b7d
44. https://github.com/iTowns/itowns/commit/92b738b1
45. https://github.com/iTowns/itowns/commit/b991878f
46. https://github.com/iTowns/itowns/commit/6960a147
47. https://github.com/iTowns/itowns/issues/2426
48. https://github.com/iTowns/itowns/commit/4da7bd22
49. ref-repos/TerriaJS__terriajs/packages/terriajs/CHANGES.md
50. https://github.com/TerriaJS/terriajs/commit/b02dd2bdc
51. https://github.com/TerriaJS/terriajs/commit/38e3c13f9
52. https://github.com/TerriaJS/terriajs/commit/b89bea562
53. https://github.com/TerriaJS/terriajs/commit/87c07944bc904020f96354cc7d5ccaabcdafe5e0
54. https://github.com/TerriaJS/terriajs/commit/d041a5ca0110bfae501731e0be3d592cf6923dea
55. https://github.com/pelicanmapping/osgearth/issues/1598
56. https://github.com/pelicanmapping/osgearth/issues/1824
57. https://github.com/pelicanmapping/osgearth/commit/725ccaa53
58. https://github.com/pelicanmapping/osgearth/commit/bba3b2151
59. https://github.com/pelicanmapping/osgearth/commit/c7cfd2b04
60. https://github.com/pelicanmapping/osgearth/commit/b34b8dcba
61. ref-repos/CesiumGS__cesium/packages/engine/Source/Scene/Cesium3DTile.js (getScreenSpaceError, around line 1003)
