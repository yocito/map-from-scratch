---
name: map-from-scratch
description: Build the smallest, fastest map renderer for one request ("I want to do X, so make me a map"), almost from scratch, and prove it with measurements. Use when someone wants a map front end for a specific purpose, data set, device or performance target, rather than a general-purpose map engine.
argument-hint: "[the request: what the map is for, on what device, with what data]"
---

# /map-from-scratch: a renderer made for one request

A general map engine pays for every feature it might need. A renderer made for
one request pays only for that request. This skill writes such a renderer in
`examples/<nn>-<slug>/` of the map-from-scratch repository, measures it with
the harness, and keeps changing it until the numbers say it is small and fast
enough for what was asked.

Repository: `~/Workspaces/repos/__yuiseki/map-from-scratch` (below: the repo).
Everything runs in Docker through `bin/mfs`; the host needs only docker and,
for GPU examples, the nvidia container runtime.

## Rules

- One request, one renderer. Do not grow an earlier example into a shared
  engine. Copy the closest example and cut it down.
- No external dependencies, except earcut (vendored in `vendor/earcut`) for
  polygon triangulation. Platform APIs (Canvas 2D, WebGL2, WebGPU, EGL/GLES,
  X11, libc) are not dependencies. A general engine may appear only under
  `baselines/`, to measure against.
- Do the work at bake time, not at run time: projection, simplification,
  triangulation, draw order, quantisation and compression all happen in
  `bake.mjs`. The renderer receives data laid out for exactly what it draws.
- Every requirement becomes a number in `spec.json` `budgets`, with its
  reason in `REQUEST.md`. A requirement that cannot be measured is written
  down as such, not dropped.
- Every bench has a functional check that reads back what reached the
  screen. Fast numbers from a renderer that draws nothing are worthless, and
  this has happened (see references/pitfalls.md).

## Procedure

1. **Read the request into REQUEST.md.** Quote the request. Make a table of
   requirement → measured number (budget), and a list of what the renderer
   will not do (3D, tiles, labels, rotation, …). The "not do" list is where
   most of the savings come from: say it before writing code.
2. **Choose runtime and API from the requirements**, not from habit:

   | When the request says | Start from |
   | --- | --- |
   | embed in a page, tiny, no libraries, a few dozen shapes | Canvas 2D + Path2D (01) |
   | phone browser, pinch, tap to identify | WebGL2, on-demand drawing, id-buffer picking (02) |
   | animate over time, scrub | WebGL2, all data on the GPU, one uniform per frame (03) |
   | millions of points, recount per view | WebGL2 float target + additive blend + GPU reduction (04) |
   | desktop, no browser, instant start | C + EGL + GLES3, instanced segments, program binary cache (05) |
   | microcontroller, no FPU, little RAM | freestanding C, integers, strip rendering, data in flash (06) |

   WebGPU is a valid choice for a renderer, but in this harness headless
   Chromium only gets SwiftShader for WebGPU, so a WebGPU example cannot be
   measured on the GPU here yet. Say so if you choose it.
3. **Scaffold** by copying the closest example to `examples/<nn>-<slug>/`:
   `REQUEST.md`, `spec.json`, `bake.mjs`, the renderer, and for browser
   examples `index.html` with a `?bench` branch. Shared bake helpers are in
   `tools/` (`sources.mjs` for raw data, `geo.mjs` for projections,
   simplification, triangulation, clipping); add to them with tests.
4. **Bake**: `bin/mfs bake <nn>`. Print counts (features, vertices, bytes)
   and look at them: an outlier bounding box or a 10x larger file than
   expected is a bug in the bake, not a fact about the data.
5. **Write the renderer**, smallest first: get one frame on screen, then add
   interaction. The patterns that worked are in references/patterns.md.
6. **Write the bench branch**: first frame, a camera path (`zoomPath` in
   `harness/page/bench.js`, or the C equivalent), fixed views for the cheap
   and expensive ends, interaction costs (pick, redraw), and the functional
   checks. Report the GPU (`info.gpu`) so a software fallback is caught.
7. **Measure**: `bin/mfs bench <nn>`, then look at
   `results/<id>/screenshot.png`. Before believing a number, ask what it
   measures (references/pitfalls.md). Change one thing at a time; for a
   parameter sweep pass it through `MFS_PAGE_QUERY` and compare runs.
8. **Record** what was learnt in REQUEST.md under 計測で分かったこと, with
   the numbers, including the dead ends and the corrected mistakes.
9. **Optionally compare** with a general engine under `baselines/` (see
   `baselines/b02-maplibre`): same data, same viewport, same camera path.
10. **Commit** when tests pass and all budgets pass: `bin/mfs test`, then
    `bin/mfs bench <nn>`. `bin/mfs report` prints every example's latest
    numbers for the README.

## Harness reference

- `bin/mfs image | test | list | bake <id> | build <id> | bench <id|all> [-n N] | report | serve [port] | probe [lifetime]`
- Renderers report with one JSON object per line prefixed `@mfs `
  (native: stdout; browser: `window.__mfsEmit`): `{"metric":name,"value":x}`,
  `{"metric":name,"values":[…]}`, `{"mark":name}` (native; the harness
  timestamps it from process start), `{"info":{…}}`, `{"error":msg}`,
  `{"done":true}`.
- The harness adds: footprint (`code_bytes`, `code_gzip_bytes`, `data_bytes`,
  `data_gzip_bytes`, or `elf_text_bytes`, `elf_rodata_bytes`, `elf_ram_bytes`
  for microcontroller objects), `dependencies`; for browsers `js_heap_mb`,
  `transfer_kb`, `browser_rss_mb`; for native `wall_ms`, `process_cpu_ms`,
  `peak_rss_mb` (from wait4).
- `spec.json`: `id`, `request`, `runtime` (`browser`|`native`), `gpu`
  (`hardware`|`none`), `bake`, `build`, `run` (`page` + `viewport` +
  `cpuThrottle`, or `cmd`), `iterations`, `footprint` (`code`, `data`,
  `elf`), `dependencies`, `budgets` (`{"metric": {"stat": "p95", "max": x}}`).
- Results go to `results/<id>/` (latest.json, timestamped runs, screenshot,
  chrome.log). They are not committed.
