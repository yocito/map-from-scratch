# Label placement, engine by engine

Detail behind ../SKILL.md. Numbers in brackets refer to the Sources list at
the end of ../SKILL.md. Read the section for the engine whose situation is
closest to the request.

## MapLibre GL JS

- Placement architecture: workers shape text and build static buffers; the
  main thread places into one viewport-aligned `CollisionIndex` and updates
  only small opacity buffers. Before that, per-tile `CollisionTile`s in
  workers approximated perspective and regenerated large buffers; the
  stopgaps (pitch padding boxes, re-placing at most every 300 ms, re-placing
  on pan only above 25 degrees pitch) were abandoned [1][2].
- Grid instead of R-tree: insertions under 0.1x, queries up to 1.3x slower,
  combined place-and-insert time down to 2/3 [3]. Cells of 25 px over the
  viewport plus `viewportPadding = 100` on each side [4].
- Cross-tile identity (`CrossTileSymbolIndex`) carries fade state between
  tiles of different zooms. It uses KDBush only above 128 instances per key;
  later a per-query sort was replaced by one O(n) pass, after the sort became
  the dominant placement cost on dense layers and also mis-ordered ids
  lexicographically. With `promoteId` the feature id goes into the key; an
  approach with one pre-assigned id per feature rendered a fixture blank [15].
- Opacity-buffer reuse between placement commits: 260 to 38 buckets
  rewritten per frame, reusable call 0.014 ms vs 0.14 ms, the first call
  after a commit ~20% slower, ~120 KB of recorded inputs for 2,880 symbols;
  frames over 33 ms 89 to 37 on Tokyo z15 pitch 60 under 4x throttle [5].
- Time-sliced placement (~2 ms budget), forced full when `fadeDuration` is 0
  [6]. Symbol queries go through the global index of the last placement,
  fixing hover flicker and missed symbols at tile edges [7].
- Pitch: anchors with w <= 0 are hidden on the CPU and clipped in the shader
  [8]; line-label glyphs are placed on the CPU along the whole line, point
  labels stay in shaders [12]; a label twice as far is drawn at 75% size and
  line labels beyond camera distance 1.5 are hidden [13].
- Point labels in the tile buffer are skipped before shaping and glyph
  requests, since the neighbour tile labels them [9].
- Collision groups in the style (April 2018) were removed in May 2018 for one
  `crossSourceCollisions` option [10][11]. Line-aligned icons went back from
  several boxes to one [1].
- `symbol-sort-key` splits draw calls only when overlap is allowed, since
  placed symbols cannot overlap otherwise [14].
- A one-line type check (`bucket.type` vs `bucket.layers[0].type`) re-placed
  every bucket on rotate and caused a severe regression: bench the rotate and
  pitch paths specifically [103].
- Symbol data became transferable typed arrays (`StructArray`) to cut worker
  transfer; access through accessors is slower [104].
- Overzoom: since 6.0 vector tiles are sliced for 4 levels past maxzoom
  instead of scaling the parent, better for dense labels at high zoom and
  avoiding Safari crashes, with small changes to polygon centre labels [105].

## MapLibre Native

- Ported the GL JS global placement; `CollisionTile`, `FrameHistory` and
  `PlacementConfig` were deleted. Geometry tiles are not drawn until their
  symbols are loaded, so the cross-tile index can prevent flicker [17].
- Line labels collide as circles projected at collision time; icons along a
  line are always one box, which may misalign rotated icons [18].
- Padding: 100 px, 200 px pitched, 1,024 px in tile mode ("larger padding
  increases label stability but is expensive"); tile-mode padding was raised
  after cross-tile labels were cut off [19][20].
- Items outside the collision grid are neither faded nor marked placed;
  otherwise offscreen symbols cascaded into the viewport [21].
- Re-placement at most every 300 ms, on distance change only above 25 degrees
  pitch, never for zoom at low pitch; unthrottled in still mode [22]. Zooming
  out shortens fades and places more often; pitched views place less often
  [90].
- Overscaled tiles: off-screen symbols are dropped before indexing [89].
- Tile mode: border-crossing symbols are placed first, ordered by which
  borders they cross, section length, anchor Y; the border test is memoised
  per id [91].
- Debug collision buffers allocated only when debug is on: `SymbolBucket`
  1,024 to 704 bytes, and a leak of unused debug vertices fixed [101].
  Copying the tile-layer index each frame by value cost so much CPU that a
  one-character fix (take by reference) was a notable win [102].
- With `symbol-sort-key` on ~1,000 symbols, zooming stuttered: 4 items
  visible but 996 drawables set up in one layer. Maintainers advised feeding
  fewer candidates (per-zoom filters, clustering) [16].

## maplibre-rs

- Text rendering was ported file by file from Native's symbol pipeline
  (~10k lines, `symbol_layout.rs` 1,895 lines, `collision_index.rs` 644)
  under `#![allow(dead_code, unused)]`; a justify bug in the port was fixed a
  week later [93]. Collision, text along lines and glyph caching were still
  open when SDF text merged; the maintainer: "text rendering = glyph
  rendering + text shaping" [92].

## navara (MapLibre, Three.js + Rust/WASM)

- `DeclutterManager` in TypeScript per view; the Rust kernel projects
  anchors, culls by horizon, sorts and claims grid cells in one call over a
  `Float64Array` (stride 11), returning a `Uint8Array` of hidden flags. 64 px
  cells, 128 px margin, 2 px padding, strict inequalities [23].
- Hysteresis: shown labels win exact priority ties and test with a box shrunk
  by `HYSTERESIS_PX = 6` per side while registering the full box; hidden
  labels must clear the full padded box; remaining ties broken by anchor
  position, not array order [23]. Tested in Rust `cfg(test)` [23][25].
- Default hidden: candidates behind the near plane, beyond the horizon, or
  outside viewport plus margin are hidden; a label fades in only after it
  claims space. The earlier "show when in doubt" made every label appear on
  load and faded the clutter away, and swept waves of labels in and out on
  each pan [23].
- `MIN_INTERVAL_MS = 150` between passes, only when dirty or the camera or
  viewport changed; 300 ms fades step every frame; a 16 ms retry must never
  be starved by the 150 ms timer [23].
- A tile-swap handoff carries declutter state when tiles are replaced, fixing
  MVT text flicker [26].
- Line anchors at nested levels (finest x 2^l, centred on the line midpoint),
  each with a scale band; a two-phase kernel rejects most labels in a cheap
  fit phase; flip with a deadband; fade state handed over between stack-mates
  at level boundaries to avoid blinking [24].

## OpenLayers

- `declutter` (#7328): priority by zIndex, rbush index; a Closure Compiler
  rename of minX/maxY silently disabled decluttering in the minified build,
  seen only as a performance drop [50]. Boxes rounded before the test caused
  false collisions; rounding moved after [56].
- 2020 rewrite: old decluttering deleted "for a fresh start", one rbush per
  frame shared across layers, top layer first [51]. Decluttered items were
  lifted above all layers (6.0) and put back in layer order in 9.0 [51].
  Icon and text of one feature form one unit; a declarative grouping option
  was dropped for an imperative prerender hint; render tests are
  font-sensitive and reliable only on Debian-like CI [95].
- Hit detection reuses the last frame's declutter tree [55]. Render buffer
  beyond the viewport considered to reduce pan flicker [52]. Multi-part
  features decluttered per part [53]. Polygon labels drawn only when they fit
  (`overflow` restores the old behaviour) [54].

## QGIS (PAL, cost-based solver)

- Candidate limits for extreme feature counts: 3,000 points, 30 s to 3 s
  [34]. Candidates per cm of line and per cm² of polygon [35]; polygon grid
  spacing from density [36]; defaults 8/8/8 to 16/50/30, reverted for broken
  reference images and reapplied [39].
- Obstacles: none registered for layers without labels or diagrams, ~60%
  less render time on point layers [38]; a feature is never an obstacle to
  its own label [42]; separate obstacle geometry, and polygons as obstacles by
  boundary only, for admin layers that cover everything [43]. Polygon
  obstacle cost by intersection area missed nothing but needed a performance
  fix later [107]; prepared intersects/within instead of overlaps/touches,
  which GEOS does not accelerate, gave a "huge speedup" [98].
- Conflict bounds (label plus minimum distance) cached so the same box is
  inserted and removed [41]; pairwise conflict results cached [44]; exact
  cost ties broken deterministically [40].
- Geometry: fast rectangle clip before repair, exact intersection only for
  rotated extents [99]; makeValid reverted to buffer(0) as much slower [45];
  perimeter labels from the unclipped boundary [37].
- More cancellation points, because cancelled renders kept labelling in
  background threads [46]. The label layer is cached as an image so
  unrelated layer changes do not re-solve labels [108]. Masks: one target set
  per layer, separate mask images per label source [109]. Whitespace in
  curved labels may be non-colliding, opt-in, ~1,000 lines across 25 files
  [106].

## tangram (JS) and tangram-es

- tangram: per-tile collision in workers, then a second main-thread pass over
  visible tiles; workers send only an oriented box and VBO byte ranges per
  label [71]. Before that, `move_into_tile` pulled labels inside their tile
  and buffered OpenMapTiles data drew "Eesti" over Lithuania [66]; labels of
  different sources never collided [79]. Collision in Mercator metres was
  tried and reverted [72].
- Re-collision at 1/3-zoom steps or when the tile or mesh set changes, tiles
  in build order [62][73]; collision runs immediately, not deferred on input,
  to avoid crowding on zoom out [76]; tiles held back until collided [100];
  border-crossing labels hidden until tiles load, at the cost of
  nondeterministic initial layout [74]; labels faded on proxy tiles during
  zoom [94].
- Repeat culling strict per tile, looser globally [111]; `repeat_distance`
  default 256 px [78]; points on lines by vertex, spacing or midpoint [110];
  text required by default [77]; 4 default anchors [68]; adaptive grid [75];
  epsilon on boxes [70]; narrow phase only when rotated [69].
- Curved labels as 2-3 letter quads with angles precomputed at +0.33, +0.66,
  +0.99 zoom and interpolated in the shader; placement tiers straight
  (overflow 1.5), curved, then straight with overflow 2.3 tuned by a
  cartographer on fixed locations [64]. Complex-shaping scripts stay straight;
  splitting by grapheme cluster widened curved labels, and a RegExp per
  character was "a noticeable slowdown" [65]. Centroids once per GeoJSON
  source [63]; near-vertical flip tolerance [67].
- tangram-es: greedy incremental collision after one sort [80]; hidden
  labels' boxes grown 2 px, last frame's winners first [81]; dynamic state
  in int16 (1/4 px, alpha x 32767, rotation x 4096), alpha-only updates when
  hidden [82]; complex scripts and mixed-direction curved labels refused
  [83]; w checked before the divide [84]; grid splits capped for overzoom
  [85]; picking returns one label with its own id [86]; flat labels need
  pre-projected vertices to avoid affine texture warp [87]. Skipping label
  updates by LoD left stale label meshes drawn, so it was disabled [112].

## Others

- protomaps-leaflet: layout labels into an rbush, paint back to front, then
  draw label closures; priority only by rule order [58]. Line labels as cells
  of twice the text height, minimum segment 20 px, repeat and dedup at 250 px
  doubled per overzoom past 4 [59]. Antimeridian handled by inserting a
  shifted duplicate [60][113]. Polygon label symbolizer removed in 2.0 [61].
- KDE Marble: icon in the collision box, float positions against flicker,
  popularity ranking [48]; split ways merged by OSM id [49]; visible-placemark
  cache with a margin and lazy label pixmaps [96].
- CesiumGS: SDF labels via bitmap-sdf after tiny-sdf; screen bounds from
  glyph metrics, not the padded SDF quad [30]; glyphs inherit the label's
  terrain-clamped position instead of clamping each glyph, after a revert
  [31].
- deck.gl: GPU collision by rendering picking colours, 7,000 points at
  120 fps [32]; declined basemap features such as labels along paths in its
  MVT layer [88].
- ortho-earth (GPL-3): placement and collision stay on the CPU; drawing goes
  through a sink; per-glyph `fillText` fell from 60 to 20 fps with ~600
  glyphs at 55 degrees tilt, a glyph atlas restored 60 fps; the GPU path uses
  an SDF atlas keyed by font and glyph only [33].
- reearth-papers (server tiles via MapLibre Native tile mode): fetch
  neighbour tiles, deterministic world-space collision; the declared pad of
  16 needed 128 [28]. Variable anchors near tile borders were refused by
  tile mode, leaving a label-wide no-place band on every edge; the server
  style pins anchors and makes POI text optional [29].
- RustGIS: MapLibre-style line spacing and max angle, polylabel for polygons,
  f64 priorities (f32 lost sort-key precision), grid collision [27].
- GRASS `d.vect`: vertical alignment by fixed fractions of font size, not
  per-string ink boxes, so baselines line up [47].
- Leaflet: faster centre computation; polylabel deferred, so centroids can
  fall outside concave polygons [57].
