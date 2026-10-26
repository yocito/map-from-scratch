// Road map for a 240x240 RGB565 LCD on a microcontroller without an FPU.
// Freestanding: no libc, no heap, no floating point, no mutable globals.
// The caller owns one strip buffer (MM_W x MM_STRIP pixels, 7.5 KB) and sends
// each strip to the panel as soon as it is drawn.
#ifndef MCUMAP_H
#define MCUMAP_H
#include <stdint.h>

#define MM_W 240
#define MM_H 240
#define MM_STRIP 16

typedef struct {
  int16_t minx, miny, maxx, maxy;   // bounding box, 0.5 m units
  uint32_t first;                   // index of the first point (pairs in mm_pts)
  uint16_t n;                       // number of points
  uint8_t cls;                      // 0 motorway .. 4 path
} mm_road;

extern const int16_t mm_pts[];
extern const mm_road mm_roads[];
extern const uint16_t mm_road_count;

// Centre in 0.5 m units; scale: screen px = (units - centre) * scale / 256.
// Bounds that keep all arithmetic in int32: |cx|, |cy| <= 5000 (the baked
// area), scale <= 192 (0.37 m a pixel), roads cut at 6250 units by the bake.
typedef struct { int32_t cx, cy, scale; } mm_view;
#define MM_MAX_SCALE 192

typedef struct { uint32_t roads_tested, segments_drawn, pixels; } mm_stats;

// Draw rows [y0, y0 + MM_STRIP) of the view into buf (row-major, RGB565).
void mm_render_strip(const mm_view *v, int y0, uint16_t *buf, mm_stats *st);

#endif
