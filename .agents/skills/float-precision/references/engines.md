# Float precision, engine by engine

Bracketed numbers refer to the Sources list in [../SKILL.md](../SKILL.md).
Each item: what was decided, the alternative, the cost, and the evidence.

## MapLibre GL JS

- **Globe trig without atan/sin/cos.** sin(lat) = (t^2-1)/(t^2+1),
  cos(lat) = 2t/(t^2+1) with t = exp(PI - y*2PI). Before, the shader used
  2*atan(exp(..)) - PI/2, and a correction rendered a 1x1 framebuffer once a
  second, compared it with a CPU value and shifted the projection matrix; it
  fixed only atan, and only as one constant per view. The globe had been
  shifted by hundreds of metres at some latitudes; atan was inaccurate on
  some vendors, sin/cos non-monotonic on Mali, and subtracting PI/2 from a
  value near PI/2 destroys most of the significand near the equator [1][2].
- **Globe only below ~z12.** A `globeness` uniform blends to Mercator around
  z12, where tile-local coordinates keep precision; float32 over the
  circumference gives one value per ~2.5 m, and float64 in shaders is very
  slow where it exists [1].
- **highp** for symbol vertex shaders and SDF gamma (lowp gamma aliased large
  text on mobile; iOS precision bugs) [3]; for fill-extrusion base/height
  (heights over 65,536 m vanished on some devices) [5]; for hillshade
  positions and texture size (mediump showed bands and stair-stepped edges
  when overzoomed) [11].
- **Glyph offsets in 1/32 px** instead of 1/64 in a 16-bit attribute: twice
  the label width, half the sub-pixel precision [4].
- **Pixel-aligned matrix for rasters.** Camera x/y rounded to whole pixels,
  half-pixel shift for odd viewports, rotated with bearing; crisp tiles at
  0/90/180/270 degrees, a second cached matrix per tile [6].
- **Near plane = height/50** instead of 1: more depth precision (fixed
  deck.gl custom-layer z-fighting), but nearby 3D is clipped sooner; chosen
  by experiment [7].
- **Integer y sort key** for symbols so JS and Native agree despite float
  differences [8].
- **Line progress in an optional high-precision buffer**, only when line
  metrics are on; NEAREST ramp for step gradients [9].
- **Float32Array for uniforms**, float64 copies for CPU math; passing float64
  matrices to `uniformMatrix4fv` was slow in Chrome [10].

## MapLibre Native

- **Tile extent 8192**: with 512-px tiles one unit is 1/16 px; coordinates
  outside 0..8192 are allowed as buffer. The same doc shows low-precision
  matrix multiplication drifting from the exact result [12].
- SDF gamma lowp to highp (#7599) [13]; glyph offsets 1/64 to 1/32 px,
  port of GL JS #6375 (#11507) [14].

## maplibre-rs

- Tile transforms (`zoom_factor`, `Matrix4<f64>`) in f64, per-tile MVP cast
  to f32 for upload; geometry stays in tile EXTENT=4096 units [15].
- Zooming past ~32 (or out to -31) panicked with integer overflow in
  coords.rs:584. PR #273 clamps integer zoom to 0..31 in the core view state,
  not the input handler, and builds quadkeys by Morton encoding (~20
  instructions); still unmerged [16].

## MapLibre Tile (MLT) spec

- Geometry in signed integers on a per-layer grid (default 4096), may be
  negative or exceed extent, no world position in the tile: small deltas
  compress, seams keep shape, identical tiles stored once [19] (OMT 3.11
  planet z0-14: 34 M distinct tiles [18]).
- v2 3D streams: interleaved int32 (x,y,z), elevation = -10000 m +
  z*10^z_step; z=0 is the Terrain-RGB base, decimal metres exact (12.34 m at
  1 cm, against 12.34375 on a 2^-7 grid); at 1 dm, z equals
  R*65536+G*256+B. Morton and Delta2 not allowed on 3D streams [17].
- Floats: ALP removed because never implemented (#1128), Pseudodecimal
  removed (#1605); v2 adds framed, exception-free ALP with a mandatory
  bit-exact round trip. `--no-alp`: +0.0% (OMT) / +0.1% (Protomaps) size;
  `--no-float-dict`: +0.0% [18]. On synthetic decimal columns ALP gave
  -19.5% (7.4% after gzip); #1063 reverted storing doubles as floats [20].

## navara (MapLibre)

- **RTC for tiles, RTE for individual features.** RTC: 12 B/vertex, stock
  shaders, no per-frame update. RTE: 24 B/vertex, custom shader chunks, a
  camera encode every frame. Raw ECEF f32 is ~1 m at 6,371,000 m against
  ~0.00001 m at 0-100 m local coordinates [21]. Splat jitter was also fixed
  with RTC (PR 666); RTE is used for GeoJSON (PR 373) [23].
- **u_rteOne.** `(high-camHigh)*u_rteOne + (low-camLow)`; without it ANGLE
  Metal on Apple Silicon reassociated the sums to ~6.4e6 in f32, geometry
  froze then snapped 0.25-0.5 m at tens to hundreds of metres. A literal 1.0
  is folded; an unset uniform is 0.0, which zeroes the high part, so every
  shader must set it [21].
- **Dashes**: pattern unit = line width rounded up to a power of two metres,
  chosen once per period from a segment table; periods start mid-gap; length
  so far = multiples of 16384 m plus low, phase exact in u32. Per-pattern
  rounding, cross-fading sizes, per-fragment choice and f32 fract were
  measured and dropped (dash arrays collapsing, half-morphed still views,
  dashes cut along a line in pitched views, f32 failing after thousands of
  periods). Only for pitched/3D views [22].

## Cesium

- **Multi-frustum** (PR 261): bounded far/near per frustum, commands binned
  per frustum, near/far reused from last frame. Horizon view: 3 frustums, 2
  commands drawn 3x, 8 drawn 2x; FPS 225->221 global, 122->117 horizon,
  92->90 level 20; following Landsat7 one orbit: 2901 renders, 2 recomputes.
  Seams showed up later (green line, billboards behind terrain) [32].
- **Log depth** (1.45, PR 5851): near 0.1, far 1e10 drew 3 frustums before,
  1 after (2 with a molniya orbit); BIM tileset 383 commands against 483.
  Lost early-Z; long tilted triangles wrong until inverse depth was the
  varying; near-plane-only depth writes rejected; orthographic falls back to
  standard depth. Follow-up clipping and polyline bugs (#6701, #8600, #8703,
  #8706) and very long ranges still needing frustums (#8727) [26].
- **Quantised attributes decoded in the shader** (PR 3891) with a decode
  matrix per attribute; unpack-on-load was slower; folding into the model
  matrix breaks when attributes are quantised differently [29].
- **Draco**: `dequantizeInShader` (1.44) removed in 1.97; Draco 1.4.1 forced
  disabling attribute quantisation (1.86), partly restored (1.87); point
  clouds 2-3x smaller [27].
- **Float to RGBA8** when float textures are missing (1.28) [28]; clipping
  planes in a texture, stored untransformed and transformed in the shader,
  up to 2048, float path with RGBA8 fallback (PR 6201) [30].
- **Ground polylines** (PR 6615): centimetre jitter blamed on the 64+32-bit
  endpoint encoding was fragment precision from plane points 100 km below
  the ellipsoid; moving them onto the ellipsoid fixed it [31].
- **Oct-encoded normals** (2 bytes) cannot be linearly interpolated when
  upsampling; extensions framed by id + 32-bit length [33].
- **Glyph translate x4** in the packed attribute (0.25 px) fixed misaligned
  small text, range / 4 (#8474) [34].

## deck.gl

- **Projection on the GPU since 2015** (d929d5f0): no buffer rebuild on pan,
  but 32-bit Mercator wobbled around z18 [40].
- **fp64 emulation**: split/twoSum/twoProd, ~46-bit significand; add/sub <1
  ulp, mul ~1.5, div ~2, sqrt ~2.6, log ~11.6 ulps; ~10x shader time;
  NVIDIA optimised the error terms away until multiplied by a uniform ONE;
  `mix` rewritten as x+(y-x)*a [41]. Also 2x attribute storage, slow Windows
  compiles, untrusted drivers [35].
- **Unified project API** (v5.2): one `project_position_to_clipspace` for 32
  and 64 bit, low part always declared and zero in 32-bit mode; ArcLayer and
  PathLayer excluded [36].
- **Auto-offset** (RFC v6.1, a5dea825): low parts always generated for
  LNGLAT; above ~z12 subtract a viewport-centre origin and project the delta
  with a polynomial. Default in d06f13b5, back to the 6.0 mode in ec47556a,
  default again in 9629dc5c (no reason given); fp64 moved to an extension in
  2a893b75 [44]. "The current 32-bit projection is generally precise enough
  for almost all use cases" [35].
- **Offset modes**: origin projected in JS and added in clip space fixed the
  meter-offset wobble (07a35669); offset scale gets a first-order latitude
  term computed at the origin, linear error ~1% per 100 km from the centre
  (43fd968b) [42]. Offset systems are correct at city scale only; CPU
  reprojection is "costly and should be avoided" [39]. When |dy| > 0.25 deg
  the shader falls back to Mercator minus a CPU-projected origin instead of
  clamping dy (ec9feac5) [45].
- **Order**: apply project_offset to world position and low part separately;
  add the tile origin before the cell centre (#8454, #9518) [50].
- **Hi/lo where cancellation hurts**: heatmap positions as doubles, bbox via
  `Math.fround`; polygon side normals from high and low differences [47].
- **Meter sizes** per vertex via 1/cos(lat) Taylor series, error < 0.003
  [48]. CPU aggregation reads positions as doubles; CARTO tile reader stopped
  narrowing doubles to Float32Array [51].
- **Path spikes**: segments shorter than 0.1 px get zero direction; had to
  be ported to the fp64 shader separately [43].
- **Dashes** (RFC v9.4): `dashMode: 'path'` accumulates distance on the CPU
  over the rendered (subdivided, antimeridian-cut) geometry into
  [offset,totalLength]; the shader reduces modulo the period. Segment mode
  renders dense lines solid; the older `highPrecisionDash` measured source,
  not rendered, geometry and was wrong on globe and closed paths [38].
- **Pattern drift**: a 64-bit low part for the pattern origin (#7074) was
  not enough; the origin is reduced modulo the LCM of frame sizes x scale
  (#10633) [52].
- **MVT** tile offset moved from modelMatrix into `coordinateOrigin` [46].
- **GlobeView** has no high-precision rendering above z12 [37]; H3 hexagons
  draw one instanced template unless pentagons or mixed resolutions are
  found [49].

## ortho-earth (GPL-3; readable here)

- **Origin-relative integers** (Gint uint, exact longitude wrap),
  cos-1 = -2 sin^2(θ/2), small-angle Taylor `sinP`, `clipT` in f64 on the
  CPU. f32 139 deg is 1.5e-5 deg = 1.4 m = 3-4 px sawtooth at z17.5; floor
  test 9 px -> 0.003 px; checkerboard flicker 50% -> <1%; invMvp-based rays
  (entries ~7e4) gave 1-4 px sawtooth. Every packer recomputes origin terms
  in f64 (4 copies noted as debt) [54].
- **Jitter fix** (3f46a73e): Taylor sin for |x|<0.1 rad, origin quantised to
  1e-7 deg, antimeridian folded in uint. SwiftShader flushed sin below ~1e-7
  rad to zero (11 px steps); anchor mismatch 0.15 px at z20 to 1.3 px at z23;
  float folding gave a 2.8 m grid; result <= 0.02 px at z16-23 [57].
- **AO rays from a CPU f64 basis, expm1/log1p**: flat-ground AO ratio
  0.942 -> 0.998; pixels changing >2% on +0.0005 zoom 6.57% -> 0.47% [55].
- **Log depth per fragment in all 16 depth-writing modules**: vertex-only
  log depth bowed triangles (fake AO bands at z19); terrain-only created a
  new band; all-pass +0.38 ms (6.28 -> 6.66 ms) at Tokyo Station, none on
  Fuji; escape `?fd=0`; did not reproduce in SwiftShader [56][54].
- **Resampling on the GPU** with u32 integer sample positions (f32 drifted
  1e-4 texel over 3600); per-cell CPU 5.04 -> 0.58 ms; max delta 2.0 m at
  2098 m = 1 f16 ulp [53].

## QGIS

- Point-cloud and vector chunks relative to a per-chunk corner origin,
  bounds as double `QgsBox3D`, no axis flipping inside chunks [58].
- 3D tessellation projects polygons onto their Newell plane and offsets by
  origin and first point; the first version lost float precision with large
  numbers (roof/wall artefacts) [61].
- EPT offset/scale parsed at full precision; untwine writes them [62].
- Fast clip of long lines before painting; X11 overflow at 30000 in 2005;
  per-symbol opt-out because clipping breaks centroid fills [60].
- Coordinate operation chosen once, without the data extent; missing grids
  fall back silently to ~10 m class operations [59].

## GRASS GIS

- r.proj parallel path rounds through float32 on purpose to match serial
  output for integers above 2^24; kernels not merged because that changed
  bilinear/bicubic by 1-2 ULP [66].
- Geodesic area via GeographicLib: half-Finland polygon 251199344354.43 m^2
  against native 249566957499.688 (0.654% low); fast-math PROJ gave
  0.126272547475285 against MPFR 0.126347391348170 m^2; the signed result
  made v.import skip rings until made absolute [67].
- Kahan in r.univar (old reference values were wrong); Neumaier sums and
  Welford variance in r.in.pdal [69]. Text output keeps full precision at
  2.5% cost; '%.8f' lost D:M:S fidelity [68].
- No-data: separate null bitmap, NaN tested as x != x (bit-pattern match
  failed on computed NaNs) [64]; CELL 1-3+ bytes by range, FCELL 4, DCELL 8
  [63]; 3D tiles: zlib plus mantissa truncation, RLE writing removed [65].

## KDE Marble

- Clipping in 1e-7-degree int64 (OSM precision) for Clipper2 [70]; a bug
  applied the degree scale to radians, ~60x coarser, destroying sub-metre
  structures [70]. Attributes tracked in a side map keyed by integer
  coordinates instead of patching Clipper [72]. One gdInv per view cached
  (>99.99% hits) [71]; asin argument > 1 checked in inverse Lambert [73].

## OpenLayers and ol2

- WebGL vertices relative to the replay extent (28e51740c) [75], later view
  space at rebuild time with matrix = current x inverse(rebuild) (#9479)
  [76]; RTE borrowed from Cesium in #5462, circles still jittered far from
  centre [74].
- Tile positions round(origin - index*dx) (7f088c2eb) [77]; round to 4
  decimals before floor/ceil (255.99999999 -> 256) [78]; ring area from
  offsets to the first vertex [83]; line distance split low/high, each mod
  pattern length (artefacts above z20) [80]; float64 helpers for the pattern
  origin, tile-local render extents [81]; extent cropping skipped without
  fragment highp [82]; winding test reverted to shoelace [79].
- ol2: SVG MAX_PIXEL 15000 with recentring and redraw; Graticule moved to
  Canvas [84]; render extent = 3x view, recentred on moveend [86]; grid
  positions from origin + index fixed 1 px seams and cache misses on
  Mobile Safari (#587) [85]; centroid relative to the vertex mean [87].

## Leaflet and protomaps-leaflet

- Pixel origin per zoom; panes translated; reset at 2^23 px (Firefox bug,
  Chrome 1 px offset) [88]. Rounding for crisp tiles and DOM (#1085, #5148)
  [89]; circle radius rounded in the renderer, not the layer (#4582) [93];
  scale rounded instead of size (#4395), pan offset truncated not floored
  (#5821) [94]; centroid relative to the first point (#8784) [95].
- Projection round trip under Proj4 walked the map toward a bound with a
  1e-9 tolerance: EPSG:28992 needed ~1e-5, EPSG:31370 1e-3; compare in pixel
  space instead [92].
- GeoJSON 6 decimals by default, `false` to keep everything [90].
- protomaps-leaflet: Canvas 2D matrices are float32; labels drifted above
  z24 [96]; `1<<z` replaced by `2**z` [97].

## Tangram

- `gl.SHORT` 0..4096 per tile, heights x16 (1/16 m) [98]; width in
  style-zoom units (#267, PR #310) [101]; centroid relative to the first
  vertex (#550) [102]; highp detected from the GL API [103].
- 4,443 repeated indices drew short lines as triangles (#457) [99];
  quantised TopoJSON water polygons (78-point outer ring, 21 inner rings)
  became OGC-invalid and mis-tessellated, fixed by raising quantisation on
  the server (#456) [100]. Collision in Mercator metres reverted [104].

## Others

- RustGIS cuts geometry at lon0 ± 180 before projecting, 1e-9 deg inside;
  a Bessel towgs84 shift moved the edge ~290 m at the equator, so the edge is
  found by bisection every 5 deg latitude; 66 EPSG codes with +pm had wrong
  areas [24].
- reearth-papers: world-anchored noise floored into isize (32-bit on wasm32)
  overflowed at deep tiles; clipping to the tile took pencil-sketch z20 from
  14.1 s/266 MB to 4.2 s/76 MB and made z22 render (8.0 s) [25].
