# Patterns that paid off

Each pattern names the example where it is implemented and measured.

## Data, at bake time

- **Project at bake time.** The renderer's vertex shader is then an affine
  camera. Choose the projection for the request: Equal Earth for a
  choropleth (area on screen is area on the ground, 02, 03), a local
  equirectangular grid scaled by cos(latitude) for a city (04, 05, 06).
- **Quantise to the precision the view needs.** 16-bit coordinates over the
  bounding box are enough for a world map on a phone at 32x (02) and for a
  city at street level (04, 05). Check the bounding box first: stray features
  far away coarsen every step (04 found 1,872 nodes 1,500 km out).
- **Delta-code for gzip.** Store each value as the difference from the
  previous one, wrapping mod 2^16 or 2^32; decoding is one addition per value.
  Planar layout (all x, then all y) helps further. 02: 1.32 MB → 474 KB gzip.
- **Do not ship what can be rebuilt.** Border segments are consecutive ring
  vertices: ship ring lengths, rebuild indices at load (02). Segments of a
  polyline are consecutive vertices: read the vertex array twice, one vertex
  apart, as two instance attributes (05).
- **Decide draw order at bake time.** Minor roads first, major on top (05,
  06): no sorting at run time.
- **Sort by Morton code** to make neighbours neighbours in the file; the code
  carries both coordinates, so sorting the codes sorts the points (04).
- **Let the platform parse.** SVG path strings go straight into `Path2D`
  (01). For a microcontroller, generate C source with const arrays so the
  data is linked into flash (06).

## Drawing

- **Draw only when something changed** (02, 03 paused, 05): one rAF request
  per change, nothing when idle.
- **Put all the data on the GPU once and change uniforms per frame.** The
  earthquake playback updates one float per frame; the vertex shader decides
  visibility, size and fade from the event's age (03).
- **One draw call for a network**: instanced 4-vertex strips widened in the
  vertex shader, square caps to hide joints (05).
- **Count on the GPU, normalise on the GPU**: additive blend into R32F, max
  reduced 4x4 at a time to 1x1, colour pass reads the 1x1 texel. Nothing goes
  back to the CPU (04).
- **Spread contention**: points drawn in spatial order blend into the same
  pixel back to back. Dealing them over 128 strides cut the all-in-view GPU
  time from 11.7 to 2.6 ms; the optimum was U-shaped (04).
- **Strip rendering** for a microcontroller: a 240x16 RGB565 buffer (7.5 KB)
  instead of a frame buffer; cull roads by baked bounding boxes per strip;
  Cohen–Sutherland then Bresenham (06).

## Interaction

- **Picking with a 1x1 id render**: set the camera centre to the tapped point,
  render ids into a 1x1 framebuffer, read one pixel (02, p95 0.9 ms on a 4x
  throttled phone).
- **isPointInPath** for a few dozen shapes: no index needed (01, 0.01 ms).
- **Text in the DOM**, not on the GPU, when the request needs only a caption
  or a name on tap (01, 02, 03).

## Native start-up and memory

- **mmap, upload, munmap**: no copy of the data stays in the process (05).
- **Cache the linked program** with `glProgramBinary` next to the data. The
  NVIDIA GLSL compiler costs ~59 MB resident and ~75 ms; a cached binary
  avoids loading it. Fall back to compiling when the driver rejects the
  binary (05).
- **EGL device platform** for an offscreen bench: no X, no Wayland (05).
- **Freestanding objects**: build the microcontroller renderer with
  `-ffreestanding` and fail the build if it needs any symbol besides its
  data (06). Keep coordinates small enough for int32 instead of reaching for
  64-bit division.
