---
name: 3d-buildings-and-meshes
description: How 20 map engines build, store, order, light and cull extruded buildings and imported 3D meshes (OSM/PLATEAU buildings, glTF models, TINs), and what they reverted. Load it when a map-from-scratch request mentions 3D buildings, extrusion, height, tilt/pitch, oblique or 2.5D views, shadows, glTF/OBJ models or mesh export, before writing the bake step's wall/mesh layout or the renderer's depth and lighting.
---

# 3D buildings and meshes: bake the prisms, keep the depth, light in the local frame

Extruding a footprint looks like one loop over ring edges, but every engine
that added it then had to deal with these problems, roughly in this order:
precision of heights and coordinates far from the origin, wall winding,
triangulation that fails on dirty rings, draw order against other layers and
labels, a tile coverage that drops tall buildings whose base is off-screen,
memory for millions of wall vertices, and lighting that changes with longitude
or camera shear. OsmAnd's "simple 3D buildings" alone took follow-ups for
transparency, premultiplied alpha, symbol order, polygon colour and a zoom
cut [65][66][67][64]. The engines solved most of these at run time. A
renderer that serves one request can solve most of them in `bake.ts`.

Numbers in brackets refer to the Sources list. Per-engine detail, with the
same numbering, is in [references/engines.md](references/engines.md).
Sibling skills go deeper where this one only touches: depth and layer order
in [../draw-order-and-depth](../draw-order-and-depth/SKILL.md), local origins
and quantisation in [../float-precision](../float-precision/SKILL.md), dirty
rings and earcut in [../polygon-triangulation](../polygon-triangulation/SKILL.md),
PLATEAU-style 3D Tiles in [../3d-tiles-and-hlod](../3d-tiles-and-hlod/SKILL.md).

## Decisions the engines made

### Mesh layout and memory

- **One buffer per tile or per material, not per building.** OsmAnd merged a
  tile's buildings into one vertex and uint16 index buffer, struct of arrays,
  "draw call optimization", with no numbers [68]. osgEarth built one geometry
  per state set directly instead of merging per-feature drawables, and tile
  build went from 8 s to under 1 s; picking moved to index-range tags [60].
  Cost: uint16 indices cap a tile at 65,535 vertices, and changing one building
  means rebuilding the buffer [68].
- **Instanced walls (maplibre-native, Metal and Vulkan only).** One instance per
  wall edge: int16 position, a fraction field with a packed discard bit, and
  edgeDistance. The non-instanced path stores a 2D normal scaled by 2^14 and a
  top/bottom bit on 4 vertices per edge; the instanced path drops the normal
  and derives it in the shader [3][4][5]. Cost: a backend-specific path and
  separate instance segments; OpenGL still uses per-vertex walls [5].
- **Collapse invalid vertices in the vertex stage.** deck.gl's side walls set
  `gl_Position = vec4(0.)` for invalid side vertices instead of passing an
  `isValid` varying to a fragment `discard`; the commit is titled only as a
  side-polygon shader performance improvement [12].
- **A GPU-ready quantised format, baked offline (ortho-earth, PLATEAU).**
  Positions u16 over the batch bounding box, delta zigzag varints, normals
  i8x3, implicit or delta-coded indices. Minato's 32 tiles: 15.25 MB of typed
  arrays to 2.95 MB gzip, 1.4 cm position error, 28 ms unpack; raw b3dm was
  341 MB per ward, 60% of it batch-table JSON that is never drawn [16]. Welding
  vertices whose quantised position and normal are equal (Int32Array
  open-address hash; a JS `Map` of millions of entries costs hundreds of MB of
  heap; skipped when it saves under 15%) took Komae batch 0 from 3.12M to
  1.62M vertices and Minato to 1.94 MB gzip; flat normals keep corners as
  separate vertices, so the image is unchanged [17].
- **int8 normals.** ortho-earth went from float32x3 (12 B) to int8 xyz + pad
  (4 B) as a normalised attribute, about 2/3 less storage, transfer and upload,
  with no shader change because the fragment shader normalises [18]. iTowns
  stopped recomputing normals that glTF already carries, because recomputing
  overwrote KHR_mesh_quantization int8 normals [52].
- **A hard budget on generated geometry.** OsmAnd gives up on a mesh that would
  exceed 4,194,304 vertices (32 B each, about 128 MB) [62].

### Heights and coordinate precision

- **Heights as integers in a chosen unit.** Tangram multiplies heights by 16
  (1/16 m) before packing and divides in the vertex shader [36]. maptalks
  moved from decimetres to centimetres when its tile unit changed [41]. The
  unit trades resolution against the attribute's range [36][41].
- **Precision qualifiers fail on some GPUs only.** MapLibre GL JS moved
  extrusion base and height from lowp to highp in the vertex shader after
  heights over 65,536 m failed on some devices [2].
- **Vertices relative to a local origin.** iTowns stores feature coordinates in
  a local East-North-Up frame at parse time: no jitter, one fewer transform
  [48]. openglobus moved from a high/low split for everything to per-segment
  relative-to-centre vertices, so every consumer (bounds, hit tests) must add
  the centre back [42][43][44][45].

### Triangulation and winding

- **Normalise winding as an explicit step.** Marble's wall culling assumes
  clockwise rings; OSM guarantees no order, and the old clipper had normalised
  it as a side effect. When the clipper switched to Clipper2's rectangular mode
  to keep vertex order stable, walls rendered inside out [35][34].
- **Dirty rings break the triangulator.** QGIS's poly2tri rejects repeated
  points within epsilon (often unprojected lat/lon), so QGIS simplifies, then
  skips the polygon; that path later lost vertical walls and needed a fix
  [23][24][25].
- **earcut gave correct shapes; frame rate was a feature-count problem.** In
  iTowns' abandoned WFS PR, CVML left holes; with earcut more buildings were
  shown and it "works fine", but the frame rate was very low because too many buildings were loaded even when
  the camera was far away [49].
- **Keep triangles that already exist.** QGIS added PolyhedralSurface and TIN
  types (GDAL RFC 64) so they no longer pass through multipolygons [21][22].

### Walls, tiles and zoom

- **Drop walls on tile seams.** harp.gl turned tile-boundary walls off by
  default because they caused artefacts with shadows [40].
- **Tile coverage must include tall geometry.** tangram-es rasterises an extra
  triangle from the point under the view centre to the two near corners, so
  tiles whose base is off-screen but whose buildings are visible stay loaded
  [37].
- **Gate buildings to a zoom band.** iTowns requested WFS buildings at one
  suitable zoom and the drag lag disappeared [51]. OsmAnd returns empty
  building tiles below z16 instead of special-casing the layer in its loader
  [64].
- **Height-ordered indices give LOD for free.** ortho-earth sorts each batch's
  triangles by building height (descending) and stores the draw count for each
  height threshold; the renderer picks the threshold from metres per pixel
  and draws a prefix, dropping sub-pixel buildings with no CPU or shader work
  [18].

### Depth and draw order

- **Use a depth buffer for extrusions.** RustGIS first draped CPU-drawn bands
  (35 fps mid-drag vs about 3), then moved to a GPU view-projection (26 ms vs
  316 ms per frame), then added depth for extrusions because far-to-near
  painter's order fails where features interlock; with 4x MSAA and
  Depth24PlusStencil8 the whole frame of the extruded World Atlas sample at
  60deg pitch takes about 20 ms [7][8][9].
- **Group offscreen passes and keep depth across extrusion layers.** MapLibre
  GL JS renders all extrusion textures before other layers and no longer
  clears depth between extrusion layers [1].
- **Symbols over buildings.** OsmAnd enables stencil every frame because some
  far volumetric symbols must appear in front of buildings [63]; it also fixed
  symbol order after adding buildings [67].
- **2.5D without depth.** Marble culls back-facing walls (about 20% faster)
  [31], draws buildings flat at level 17 to cut draw calls [32], and switches to
  the cheaper fake-3D mode earlier on high-DPI mobiles [33]. Mapnik projects
  first, offsets the roof by the height in screen pixels, and dropped its
  per-wall y-sort, with no visual comparison recorded [61].

### Lighting, shadows, AO

- **Light in the local tangent frame.** With an Earth-fixed light, ortho-earth's
  lit wall depended on longitude; a test with identical boxes in Tokyo and
  London now requires equal wall luminance (Tokyo S=176/N=218, London
  identical) [13].
- **Keep camera shear out of the normal matrix.** tangram-es builds the normal
  matrix from the unsheared view for its isometric camera; before, diffuse
  light changed as the camera moved [38][39].
- **Plausible PBR without assets.** ortho-earth integrates 96 sky directions
  of its own scattering model into SH9 diffuse sky and caches it by key, uses
  an analytic specular, screen-derivative tangents, both faces drawn, and a
  0.35 fixed fill so walls stay readable; WebGPU only [13].
- **Shadows: one window, cull casters, reuse the pass.** ortho-earth keeps one
  sun-orthographic 2048^2 map (16 MB; 1024^2 in low memory) up to about
  12 km, culls casters by the window rectangle and reuses the depth pass when
  static (339 of 375 frames). At Tokyo Station, z15/60deg, about 7.4M casting
  triangles cost 1.9 to 2.3 ms after culling. Three cascades (about 48 MB) were
  rejected because each level casts over a wider area; about 19% of the
  visible ground has no shadow [15]. iTowns made shadows opt-in, separate
  from atmospheric lighting; its first version spent most of the frame in
  picking, which the author's fast machine had hidden [50].
- **AO by blending, not by another target.** Half-resolution horizon AO, 4x4
  depth-weighted blur, then a multiply blend onto the existing target before
  line overlays; only two half-res r8 targets stay resident, against about
  12 MB for a full-res RGBA8 target at DPR 2 [13]. Its look was then tuned:
  strength 0.5 to 0.6 and radius 10% of the view distance; 0.7 looked dirty
  and a 15% radius barely differed [14].

### Imported models and export

- **Bake imported meshes into the renderer's own format.** In a GL3 core
  profile osgEarth has no default pipeline, so external models need generated
  shaders, and some textured tiles still render black [55][56]. osgEarth's
  glTF loader covers only what some 3D Tiles need; an instanced truck lost its
  wheels while the single model was fine [57]. Projected-texture draping
  flattens any 3D model; osgEarth recommends reading the source data instead
  [58]. iTowns lets each layer choose: vectors rasterised into the terrain
  tile texture (follows terrain, resolution bounded by the tile texture), or
  3D meshes placed with base altitude and extrusion height [46][47]. A GDAL
  3/PROJ 6 axis-order change tilted terrain-clamped models [54]. osgEarth's
  model textures moved from texture arrays to bindless textures, which is
  desktop GL only [59].
- **Parse off the render thread, upload on it.** Organic Maps parses an OBJ
  arrow on the backend thread and creates GPU objects on the frontend thread;
  the default arrow costs no frame rate [69].
- **Update in place.** TerriaJS keeps stable glTF DataSource/Entity instances
  instead of recreating them on each trait change ("vastly improves the
  performance", no numbers) [53]. Cesium removed CPU instancing in 1.97 and
  kept GPU instancing only [10][11].
- **Export and tests.** QGIS kept exact golden OBJ/STL comparisons (triangles
  sorted first) but dropped the largest terrain STL; reviewers objected that
  40k-line files are impossible to debug and break on tessellator or tiling
  changes [19][20]. Its STL export ships open terrain and floating buildings,
  which need manual repair before printing [19].

## Tried and reverted

- Marble skipped walls under 1.4 px offset and simplified them under 5 px,
  claiming about 50% faster rendering at level 17; it was reverted the next day
  as "reinventing the wheel", without naming what it duplicated [29][30].
- QGIS reverted a special triangulation path for classified point clouds and
  used the plain colour-ramp settings for all modes [26][27][28].
- maplibre-rs's fixed-height extrusion behind a style flag (no OSM heights)
  went stale unmerged [6].
- openglobus wrote re-centring of segments as the camera moves, then left it
  commented out [42][45].
- ortho-earth rejected cascaded shadows (more area per level, not cheaper)
  [15], and replaced hemisphere-sample AO with horizon-based AO (HBAO; in a
  desk simulation, building feet went from 0.92 to 0.8) [13].

## Guidance for a renderer in this repository

Write the choice in `architecture_selection` and the measured result in
`performance_knowledge`, as SKILL.md of map-from-scratch asks.

1. **First decide whether the request needs real 3D.** A top-down map with
   "building heights" is a choropleth or a 2.5D offset. For 2.5D in Canvas 2D,
   do as Marble and Mapnik: offset roofs in screen pixels, cull walls by the
   sign of the edge cross product, no depth buffer [31][61]. Real 3D (free
   pitch, interlocking buildings) needs a depth buffer from the first frame
   [9]. List what is not done (shadows, AO, PBR, glTF, labels over buildings)
   in `not_doing`.
2. **Bake walls, normals and winding.** In `bake.ts`: project to the local
   grid the examples already use, so vertices are relative to the area's
   origin and no high/low split is needed [48][45]; dedupe vertices in
   projected units, then earcut roofs [23][49]; force ring orientation and
   test it as an invariant [34]; emit 4 vertices per wall edge with a flat
   int8 normal [5][18]; drop walls on tile or clip seams [40]. Instance walls
   per edge only when the wall vertex count is what blows a memory budget [3];
   for a few hundred buildings a baked mesh is simpler [3].
3. **Quantise heights from the error at the closest zoom.** Pick the unit (1/16 m,
   cm) and check the tallest feature fits the attribute: 1/16 m in int16
   leaves about 2,047 m [36][41]. Use highp for anything with a large range in
   the shader [2].
4. **Lay out indices for the cuts the request makes.** One buffer per tile or
   per colour [68][60]; uint32 indices (WebGL2 has them) or split at 65,535
   vertices [68]; triangles sorted by building height with a prefix count per
   threshold if the view zooms out over a city [18]. Weld identical
   quantised vertices at bake time and measure the saving [17].
5. **Cover tall geometry and gate by zoom.** With pitch, extend tile or chunk
   culling to the near-side triangle [37]; bind buildings to the zoom band where
   they are visible, at bake time [51][64].
6. **Light in the local frame, unsheared.** A fixed light in local
   east/north/up and a minimum fill keep walls readable [13][38]. Add a
   verification check modelled on ortho-earth's: two identical buildings in
   different places must give equal wall luminance [13].
7. **Shadows and AO only when asked**, and then count caster triangles first:
   ortho-earth's cost followed LOD2 density (about 7M triangles), not the
   technique [15]. Compose AO with a blend state, not a full-res target [13].
8. **Plan labels and blending before the first building.** OsmAnd's sequence
   shows that extrusions force changes to alpha and symbol order [65][66][67].
9. **Test invariants, not golden meshes**: triangle count, area, bounds,
   winding, watertightness if exported for printing, and pixel checks read back
   from the screen [19][20]. If the request is printing, close the mesh (walls
   and a base) at bake time [19].
10. **Imported models**: convert to the renderer's vertex format at bake time,
    support only the glTF subset the data uses, and test through the
    production path, instanced or not [55][57][58]. In WebGL2 there are no
    bindless textures: use an atlas or a texture array with sizes fixed at
    bake time [59]. Flat overlays on terrain can be rasterised into the
    terrain texture; buildings cannot [46][58].

## Sources

1. https://github.com/maplibre/maplibre-gl-js/commit/c48a56be0
2. https://github.com/maplibre/maplibre-gl-js/commit/460c28541
3. https://github.com/maplibre/maplibre-native/commit/6aa804f7e
4. https://github.com/maplibre/maplibre-native/commit/1b6ed3542
5. ref-repos/maplibre__maplibre-native/src/mln/renderer/buckets/fill_extrusion_bucket.hpp
6. https://github.com/maplibre/maplibre-rs/pull/192
7. https://github.com/opengeos/RustGIS/pull/433
8. https://github.com/opengeos/RustGIS/pull/489
9. https://github.com/opengeos/RustGIS/pull/492
10. ref-repos/CesiumGS__cesium/CHANGES.md
11. https://github.com/CesiumGS/cesium/pull/10589
12. https://github.com/visgl/deck.gl/commit/85298e97
13. https://github.com/kenjiyoshidahome2026-bit/ortho-earth/issues/46
14. https://github.com/kenjiyoshidahome2026-bit/ortho-earth/issues/63
15. https://github.com/kenjiyoshidahome2026-bit/ortho-earth/issues/112
16. https://github.com/kenjiyoshidahome2026-bit/ortho-earth/commit/1db85633
17. https://github.com/kenjiyoshidahome2026-bit/ortho-earth/commit/74b8d5f0
18. https://github.com/kenjiyoshidahome2026-bit/ortho-earth/commit/da8dc2f4
19. https://github.com/qgis/QGIS/pull/63444
20. https://github.com/qgis/QGIS/pull/63173
21. https://github.com/qgis/QGIS/pull/58583
22. https://gdal.org/en/latest/development/rfc/rfc64_triangle_polyhedralsurface_tin.html
23. https://github.com/qgis/QGIS/commit/7bce7ea9ca
24. https://github.com/qgis/QGIS/commit/35b37a228f
25. https://github.com/qgis/QGIS/commit/b773d617b1
26. https://github.com/qgis/QGIS/commit/127fabd093
27. https://github.com/qgis/QGIS/commit/434e7028dc
28. https://github.com/qgis/QGIS/commit/40df5696b5
29. https://github.com/KDE/marble/commit/8a9ba9981
30. https://github.com/KDE/marble/commit/60128d0bc
31. https://github.com/KDE/marble/commit/02645ed73
32. https://github.com/KDE/marble/commit/2777cef99
33. https://github.com/KDE/marble/commit/207765fd4
34. https://github.com/KDE/marble/commit/d3c923f75
35. https://github.com/KDE/marble/commit/48c412ef1
36. https://github.com/tangrams/tangram/commit/9c6123a3
37. ref-repos/tangrams__tangram-es/core/src/view/view.cpp
38. https://github.com/tangrams/tangram-es/pull/602
39. https://github.com/tangrams/tangram-es/issues/578
40. https://github.com/heremaps/harp.gl/commit/6e977615
41. https://github.com/maptalks/maptalks.js/commit/6768d1adf
42. https://github.com/openglobus/openglobus/issues/963
43. https://github.com/openglobus/openglobus/issues/824
44. https://github.com/openglobus/openglobus/commit/7e774ca7
45. ref-repos/openglobus__openglobus/src/segment/Segment.ts
46. ref-repos/iTowns__itowns/docs/tutorials/Fundamentals.md
47. https://github.com/iTowns/itowns/commit/f286b40
48. https://github.com/iTowns/itowns/pull/1662
49. https://github.com/iTowns/itowns/pull/195
50. https://github.com/iTowns/itowns/pull/2691
51. https://github.com/iTowns/itowns/commit/1f8323ff
52. https://github.com/iTowns/itowns/commit/082eda8e
53. https://github.com/TerriaJS/terriajs/commit/94bfb5dbc93939f77cf8e6b869112862a15cb843
54. https://github.com/pelicanmapping/osgearth/issues/1472
55. https://github.com/pelicanmapping/osgearth/issues/2046
56. https://github.com/pelicanmapping/osgearth/issues/2472
57. https://github.com/pelicanmapping/osgearth/issues/1598
58. https://github.com/pelicanmapping/osgearth/issues/693
59. https://github.com/pelicanmapping/osgearth/commit/f8da52de9
60. https://github.com/pelicanmapping/osgearth/commit/628d38244
61. https://github.com/mapnik/mapnik/commit/4a9320942
62. https://github.com/osmandapp/OsmAnd-core/blob/master/src/Map/GeometryModifiers.cpp
63. https://github.com/osmandapp/OsmAnd-core/blob/master/src/Map/OpenGL/AtlasMapRenderer_OpenGL.cpp
64. https://github.com/osmandapp/OsmAnd-core/pull/986
65. https://github.com/osmandapp/OsmAnd-core/pull/925
66. https://github.com/osmandapp/OsmAnd-core/pull/974
67. https://github.com/osmandapp/OsmAnd-core/pull/975
68. https://github.com/osmandapp/OsmAnd-core/commit/ebaace2a
69. https://github.com/organicmaps/organicmaps/pull/5397
