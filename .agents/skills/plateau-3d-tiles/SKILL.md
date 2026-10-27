---
name: plateau-3d-tiles
description: Work with Project PLATEAU's streamed 3D Tiles in a purpose-built browser renderer. Use for PLATEAU tileset.json, b3dm/glb decoding, sparse building coverage, long tile loading, or browser/GPU cache problems. For general HLOD or point clouds, use 3d-tiles-and-hlod instead.
---

# PLATEAU 3D Tiles in a dedicated renderer

Use this with [3d-tiles-and-hlod](../3d-tiles-and-hlod/SKILL.md) when implementing or repairing a PLATEAU viewer. Example 22 is a working, limited implementation: [source](../../../examples/22-plateau-tokyo-tiles/main.ts), [decoder](../../../examples/22-plateau-tokyo-tiles/decode.ts), [renderer](../../../examples/22-plateau-tokyo-tiles/render.ts), and [observations](../../../examples/22-plateau-tokyo-tiles/REQUEST.md). Its Tokyo-specific values are observations, not defaults for other datasets.

## Establish the data contract

- Read the actual root and child `tileset.json` before designing traversal. Record content URLs, `refine` (`REPLACE` or `ADD`, inherited by children), `geometricError`, `boundingVolume`, transforms, available content formats, and any implicit tiling. Follow the [3D Tiles specification](https://github.com/CesiumGS/3d-tiles/blob/main/specification/README.adoc); do not assume every PLATEAU tileset has the structure of example 22.
- `region` longitude and latitude are in radians. Compute culling and camera distance in a consistent coordinate frame. For a city-scale WebGL renderer, keep ECEF-to-local calculations in double precision before uploading local float vertices. Decode the content format actually served, including b3dm or direct glb, and apply glTF/3D Tiles coordinate transforms once.
- The PLATEAU distribution API and `latest` aliases can change. Check the current [PLATEAU data service](https://docs.plateauview.mlit.go.jp/api/rest/) and its attribution before using or documenting an endpoint.

## Make coverage and loading measurable

- Select tiles by frustum and screen-space error (SSE) using distance to the bounding volume. Treat a leaf as the final available detail. For `REPLACE`, retain a renderable parent until the visible replacement children are ready; for `ADD`, draw parent and children together. Keep queued requests tied to the current view, prioritize useful visible tiles, and bound concurrent downloads and decoding.
- Compare **the same camera and viewport** with a reference viewer before accepting an SSE threshold. A large threshold can make a view finish quickly while leaving only sparse parent geometry. A low threshold can require hundreds of megabytes and keep communication active for minutes. Check visible coverage in screenshots as well as requests, bytes, pending count, selected depths, and time until the queue is empty.
- If a parent was evicted after its children loaded, do not force a parent refetch before traversing those children. Revisit the same viewpoint after moving away to detect network or GPU cache churn.
- Give disk and GPU caches separate budgets. Inspect the size of tiles that miss the browser cache: a per-file cutoff can silently exclude the largest b3dm files even when the entry count is below its limit. Cache Storage is subject to browser quota and does not guarantee persistence. Evict GPU resources only when they are no longer needed by the current view; a small budget can cause repeated upload or fetch cycles.

## What example 22 established

- In its Tokyo Station view, a distance-dependent threshold reaching 64 px ended loading quickly but left a conspicuously sparse scene. A 3.5 km initial distance, 70° pitch, and 16 px threshold rendered much denser building coverage. At 1280×800 on the measured local Chromium setup, the cold view had fetched 125 building tiles / 233 MiB and had no pending loads by 45 seconds. These are **case measurements**, not a general performance target.
- The former 8 MiB disk-cache cutoff excluded five tiles totalling 59.2 MiB on revisit. Raising the eligible size to 32 MiB and the count to 256 resulted in zero building-tile HTTP responses on the next revisit in that browser. Verify the quota and tile-size distribution for a different view or device.
- [PLATEAU VIEW 4.0](https://github.com/Project-PLATEAU/PLATEAU-VIEW-4.0/blob/main/extension/src/shared/reearth/layers/general.ts) and [5.0](https://github.com/Project-PLATEAU/PLATEAU-VIEW-5.0/blob/main/extension/src/shared/reearth/layers/general.ts) hand 3D Tiles to Cesium and set `cacheBytes: Infinity` in their layer defaults; the [5.0 Tileset component](https://github.com/Project-PLATEAU/PLATEAU-VIEW-5.0/blob/main/editor/core/src/engines/Cesium/Feature/Tileset/index.tsx) passes that property to `Cesium3DTileset`. This is a useful reference for diagnosing eviction, not a universal memory setting for custom renderers. Compare against [Cesium's documented SSE and cache controls](https://cesium.com/learn/cesiumjs/ref-doc/Cesium3DTileset.html).

When the visual result matters, inspect a cold screenshot and a revisited view at the target viewport. Record what the comparison actually proves in the example's `REQUEST.md` and `spec.yaml`.
