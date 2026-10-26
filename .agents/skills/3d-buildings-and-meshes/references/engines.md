# 3D buildings and meshes: engine by engine

Bracketed numbers refer to the Sources list in [../SKILL.md](../SKILL.md).
Read this when you need the detail behind a decision there; the SKILL.md
summary is enough for choosing.

## MapLibre GL JS

- Before 2017 each fill-extrusion layer switched framebuffers mid-frame and
  cleared depth. c48a56be0 renders every extrusion layer's offscreen texture
  before any other layer and keeps the depth buffer between extrusion layers,
  so several extrusion layers occlude each other. A new render test,
  `fill-extrusion-multiple`, covers it [1].
- 460c28541 changed `base` and `height` from lowp to highp in the vertex
  shader and removed them from the fragment shader. It fixed heights over
  65,536 m not rendering "on some devices" (#7247, discussion in #2096) [2].

## MapLibre Native

- With `MLN_USE_FILL_EXTRUSION_INSTANCING` (Metal #4256, Vulkan #4310) the
  layout vertex is `pos` (int16 integer part) + `decimals_ed` (fraction
  x*256+y, times 2, plus a discard bit; then edgeDistance for pattern
  wrapping). A static vertex buffer supplies the shared wall shape and there
  are separate `instanceSegments`. The non-instanced path, still used for
  OpenGL, has 4 vertices per edge with a `normal2d` (nx, ny scaled by 2^14 to
  int16) and the top/bottom flag in the fraction bits. CHANGELOG: "Optimize
  fill extrusion memory by using instancing" [3][4][5].

## maplibre-rs

- PR 192 extruded the building layer to a fixed height behind a Style flag,
  suggested off by default; OSM height tags and OSM2World-style buildings were
  deferred. It needed normals and 3D APIs, gave wrong heights, and went stale
  unmerged [6].

## RustGIS (opengeos)

- PR 433: pitch first drew north-up ground bands on the CPU, each twice as far
  as the last, at its near edge's scale, draped while moving: 35 fps mid-drag
  against about 3 fps [7].
- PR 489: a GPU view-projection matrix with per-band depth discard, 26 ms
  against 316 ms per frame [8].
- PR 492: a depth buffer for extrusions, because painter's far-to-near order
  is wrong where features interlock; about 20 ms per frame with 4x MSAA and
  Depth24PlusStencil8 [9].

## Cesium

- CPU instancing of models was deprecated in 1.96 (#10589) and removed in 1.97
  with the new Model implementation; GPU instancing only, dropping devices
  without instanced arrays [10][11].

## deck.gl

- 85298e97 (SolidPolygonLayer side walls): invalid side vertices set
  `gl_Position = vec4(0.)` and return early under `IS_SIDE_VERTEX`, replacing
  an `isValid` varying and a fragment discard. 7 insertions, 8 deletions [12].

## ortho-earth (GPL-3; adapting its code is allowed in this GPL repository)

- Lighting (#46): glTF models get GGX + Schlick + Smith. Diffuse environment is
  SH9 computed on the CPU each frame by evaluating the atmosphere's scattering
  function over 96 sky directions; specular is the Karis analytic
  approximation; normal maps use screen-derivative tangents (no TANGENT
  attribute); `doubleSided` is ignored so badly wound models show no holes.
  The light moved from an Earth-fixed constant to the local up/east/north
  frame. `view.pbrFill` 0.35 mixes in fixed light; below the horizon the sun
  fades to a dimmed fixed light. Plain PLATEAU meshes use the same model,
  diffuse only. Test t-light: identical boxes in Tokyo and London must have
  equal wall luminance (Tokyo S=176/N=218, London the same; GL2 still showed
  London S=157). Released as core 1.3.0 / globe 1.2.0. WebGPU only [13].
- AO (#46, #63): only when enabled and tilted; after the main pass, before
  line overlays. Half-res horizon-based AO, 4x4 depth-weighted blur, then a
  multiply blend (dst*src) onto the MSAA or canvas target. Radius 10% of view
  distance (20 to 400 m), strength 0.6, also on terrain. Hemisphere to horizon
  sampling darkened building feet 0.92 to 0.8 in simulation; strength 0.7
  looked dirty on dense low-rise blocks; 15% radius barely differed; 0.6
  widened the t-ao margin from 2.4 to 8 grey levels. A full-res RGBA8
  intermediate would be about 12 MB at DPR 2, 2000x1500 [13][14].
- Shadows (#112): one sun-orthographic window, z >= 13, up to about 12 km,
  2048^2 (16 MB), LOW_MEM 1024^2 (4 MB); radial fade 0.7 to 1; casters culled
  by the window's projected rectangle (a circle was too small for a low sun);
  depth range R*max(1, cot(elevation)) (before this, at 10 degrees sun
  elevation shadows vanished beyond about 11 km). Shadow bindings share
  group(2) with per-batch uniforms because model shaders used all 4 bind
  groups. Resources exist only while shadows are on; no GL2 shadows. Tokyo
  Station, Apple M, WebGPU: z15/60deg about 7.4M casting triangles, depth pass
  2.27/2.06 ms (pan/time-play); z17/60deg 2.93/2.48 ms; after culling
  1.9-2.3 ms (z15), 2.6-3.4 ms (z17); static views reused the pass 339 of 375
  frames. About 19% of visible ground (the far side at 60 degrees tilt) has no
  shadow. Three cascades (about 48 MB) rejected [15].
- PLQ1 (1db85633): positions u16 over the batch bbox (32 tiles of about
  1-2 km give 2-3 cm steps), previous-vertex delta zigzag varint; normals
  i8x3; indices implicit (Draco output shares no vertices, nv about 3nt) or
  explicit delta varints. Minato 32 tiles 15.25 MB typed arrays to 2.95 MB
  gzip (19%), 1.4 cm error, 28 ms unpack. Raw b3dm 341 MB per ward, 60%
  batch-table JSON. Baked in Node and put on R2; the raw MLIT path stays as the
  fallback per tile [16].
- Welding (74b8d5f0): vertices with identical quantised position and i8
  normal merged; Int32Array open-address hash (about 30 B per vertex
  temporary) instead of a Map; numbering by first use in triangle order so
  index deltas stay small; unreferenced vertices dropped; skipped if under 15%.
  Komae b0 3.12M to 1.62M vertices (52%), gzip 11.8 to 7.7 MB; Ota (boxes)
  1.00M to 0.60M; Minato 32 tiles 762,708 to 422,227 vertices (55%), gzip
  2.95 to 1.94 MB; 0.2-0.6 s per batch. Tests: box 36 to 24 vertices,
  per-triangle geometry and normals unchanged, idempotent, round trip [17].
- da8dc2f4: normals float32x3 (12 B) to int8 xyz + pad (4 B), byte-normalised
  attribute, about 2/3 the bytes. Indices sorted by building (connected
  component) height, descending; `lodCounts[k]` is the draw count for
  buildings at least `lodH[k]` tall; the renderer picks k from metres per
  screen pixel (relaxed with distance for far batches) and draws a prefix.
  Equal heights keep their original order for vertex-cache locality; sort key
  packed into a Float64 so no comparator is needed [18].

## QGIS

- Export tests (PR 63444, 63173): STL scene export kept exact-text comparisons
  against exported files, triangles sorted before insertion. The big terrain
  STL test was dropped as a compromise; terrain is covered by the OBJ test. A
  reviewer called multiple 40k+ line golden files "impossible to debug"; others
  noted they break on tessellator, tiling (#63865) and cross-tile feature
  changes. The authors said such files had been needed to fix earlier export
  regressions [19][20].
- STL export shipped with a GUI warning about 3D printing: terrain is an open
  sheet and buildings float. Repair in Blender took 8 manual steps, about
  5 min; a "closed object terrain / diorama mode" was started separately [19].
- PR 58583: QgsPolyhedralSurface and QgsTriangulatedSurface after GDAL RFC 64;
  TIN is the multipart of triangle; WKT/WKB checked against SFCGAL [21][22].
- poly2tri: "Poly2Tri does not support repeat points within epsilon",
  typically with unprojected lat/lon (#17286, #17515). Simplify, else skip;
  invalid polygons ignored; missing walls regression fixed later (#17604)
  [23][24][25].
- Point clouds: on-the-fly triangulation per chunk for the 3D view, filtering
  before triangulation, dropping exterior and oversized triangles; the
  classification-specific path was reverted. Commit messages are terse
  [26][27][28].

## Marble (KDE)

- 8a9ba9981: skip walls when the roof offset is under 1.4 px, simplified walls
  under 5 px; "approximately 50% speed increase for level 17". Reverted by
  60128d0bc next day: "This was reinventing the wheel" [29][30].
- 02645ed73: wall culling in the painter by the sign of
  `(b-a) x (shiftA-a)`; outer rings draw front faces, inner rings draw the
  others; "about 20%" faster in building areas [31].
- 2777cef99: buildings flat at level 17, fewer draw calls [32]. 207765fd4:
  DPI-aware earlier switch to fake 3D on mobile [33].
- 48c412ef1 (2023): the tile creator switched to Clipper2's rectangular clip
  mode for stable vertex order (one-way streets, cliffs, embankments).
  d3c923f75 (2024): BuildingGraphicsItem now normalises winding itself because
  culling assumes clockwise rings and the old clipper's reordering was gone
  [35][34].

## Tangram and tangram-es

- Tangram 9c6123a3: `Geo.height_scale = 16`, heights and min_height multiplied
  before packing, `a_position.z / TANGRAM_HEIGHT_SCALE` in the vertex shader
  [36].
- tangram-es view.cpp: visible tiles by scan-rasterising the frustum
  footprint, plus a triangle from the point under the view centre to the two
  nearest corners for tall geometry; minimum zoom chosen so the horizontal span
  is at most 2^z - 2 tiles, z = log2(view diameter px / tile size px + 2) [37].
- PR 602 / #578: the isometric camera's normal matrix comes from the unsheared
  view, shear applied afterward. Alternatives: an identity normal matrix (the
  first fix), shear in the projection matrix (cleaner, costs a view inverse),
  skewing north in world space (changes existing styles) [38][39].

## harp.gl

- 6e977615 (HARP-10450): `boundaryWalls` default true to false, "causes
  artifacts when used with shadows" [40].

## maptalks.js

- 6768d1adf: `getHeightValue` multiplies metres by 100 instead of 10 because
  tileTransform's unit became centimetres; a shadow render-test image changed
  [41].

## openglobus

- #963 and the April 2026 RTC series (to 7e774ca7): each Segment stores
  vertices relative to its bounding-sphere centre and uploads its own
  `rtcEyePosition`, still split high/low. Terrain and plain-segment workers
  emit RTC vertices. Polylines, geoObjects, strips and rays got per-handler
  centres in #824 (December 2024). `setRelativeCenter` +
  `recalcRTCVertices` exist but are commented out. Hit tests in Segment.ts
  add `_relativeCenter` back [42][43][44][45].

## iTowns

- Fundamentals tutorial: vector data either rasterised onto the terrain via a
  ColorLayer, or meshed in a GeometryLayer with `base_altitude` and
  `extrusion_height`. 2.44.0 added MVT texture and subdivision size
  parameters [46][47].
- PR 1662: FeatureCollection coordinates in local ENU at parse time; fixes
  jitter #1596 and altitude #1330; convert options moved into Style; missing
  altitude defaults to 0. PR 195 had suggested RTC matrices updated per camera
  move [48][49].
- PR 195 (WFS, never merged, superseded by #431): CVML left buildings missing,
  earcut drew them but frame rate was low with too many buildings loaded; a
  reviewer asked to load buildings only nearer the ground [49].
- PR 2691: shadow maps through a GlobeView option and SunLightLayer, separate
  from SkyManager realistic lighting, sun position from the date. A reviewer's
  profiler showed most time in picking (fixed later); remaining flicker
  attributed to float precision; sun intensity 0 below the horizon [50].
- 1f8323ff: WFS buildings requested at a suitable zoom; drag went from laggy
  to "very smooth" [51].
- 082eda8e: OGC3DTilesLayer calls `computeVertexNormals` only when there is no
  normal attribute, with unit tests [52].

## TerriaJS

- 94bfb5dbc (#6638): GltfMixin keeps private stable DataSource and Entity
  instances and updates them when traits change [53].

## osgEarth

- #1472: models on features tilted under GDAL 3 + PROJ 6, upright under GDAL
  2.4.1. A user's fix preferred WKT/EPSG over proj strings and set
  `OGR_CT_FORCE_TRADITIONAL_GIS_ORDER=YES`; `D_NAD83` worked where `NAD83`
  did not [54].
- #2046, #2472: GL3 core has no default pipeline; external models go through
  ShaderGenerator or `.osgearth_shadergen`; only `GL_FRONT_AND_BACK`
  PolygonMode accepted. A textured osgb tile rendered black or blue; particle
  systems worked after their material code was removed [55][56].
- #1598: "the gltf loader is NOT fully implemented"; an instanced glTF truck
  lost its structure, the single model was fine [57].
- #693: draping renders the overlay top-down to a texture and projects it
  orthographically, so 3D is flattened; the maintainer declined draping of
  external 3D models and suggested reading the source data, or reproject plus
  masking the terrain under it [58].
- f8da52de9: GeometryCloud's per-model texture array became bindless textures
  with a LUT index per vertex; a follow-up fixed differing dimensions [59].
- 628d38244: ExtrudeGeometryFilter builds one geometry per state set; a tile
  build went from 8 s to under 1 s; `tagRange` on ObjectIndex for picking
  [60].

## Mapnik

- 4a9320942 (authored 2016, committed 2018): the building symbolizer projects
  and view-transforms first, then offsets by height in screen space (y -
  height); the deque of wall segments and its y-sort were removed, faces are
  emitted in ring order, the roof is the transformed polygon shifted by
  -height; segment.hpp deleted, about 76 lines fewer across three backends
  [61].

## OsmAnd-core

- GeometryModifiers.cpp: `maxMeshVertices = 4*1024*1024`, "Give up instead of
  exhausting memory on a pathological mesh (32 bytes per vertex)" [62].
- AtlasMapRenderer_OpenGL.cpp: stencil test on and colour, depth, stencil
  cleared every frame "because certain far volumetric symbols might need to be
  drawn in front of buildings" [63].
- PR 986: `getMinZoom()` delegates to the underlying provider and
  `obtainTiledData` returns an empty Buildings3D below z16; the Map3DObjects
  special cases in the resources manager were removed [64].
- Sequence after "Simple 3D buildings" (#925): transparent buildings (#970),
  no premultiplied alpha for buildings (#974), symbol order with buildings
  (#975), proper polygon colour (#983), z >= 16 (#986). PR bodies are empty
  [65][66][67][64].
- ebaace2a (#955): one Buildings3D vertex buffer and uint16 index buffer per
  tile, struct of arrays [68].

## Organic Maps

- PR 5397: the 3D position arrow loads from OBJ (fast_obj: positions, normals,
  one UV set); parsing on the backend renderer thread, GPU objects on the
  frontend thread; the default arrow is itself an OBJ; Phong with a fixed light
  direction; full depth for the arrow; Metal, Vulkan, OpenGL. "No changes" in
  frame rate for the default arrow; a higher-poly model can cost more [69].
