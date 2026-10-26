// Strip renderer for mcumap.h. Integer arithmetic only.
#include "mcumap.h"

#define RGB565(r, g, b) (uint16_t)((((r) >> 3) << 11) | (((g) >> 2) << 5) | ((b) >> 3))

static const uint16_t BG = RGB565(232, 229, 219);
static const uint16_t COLOR[5] = {
  RGB565(224, 97, 89), RGB565(242, 166, 90), RGB565(247, 217, 145), RGB565(255, 255, 255), RGB565(184, 178, 166),
};
static const uint8_t WIDTH[5] = {3, 3, 2, 1, 1};
// Smallest scale at which a class is drawn: zoomed out, paths and then local
// streets would only be noise (and cost).
static const int16_t MIN_SCALE[5] = {0, 0, 0, 16, 48};

typedef struct { uint16_t *buf; int w; uint16_t color; mm_stats *st; } pen;

// Square brush of width w centred on (x, y), clipped to the strip.
static void plot(const pen *p, int x, int y) {
  int x0 = x - p->w / 2, y0 = y - p->w / 2;
  for (int j = y0; j < y0 + p->w; j++) {
    if (j < 0 || j >= MM_STRIP) continue;
    for (int i = x0; i < x0 + p->w; i++) {
      if (i < 0 || i >= MM_W) continue;
      p->buf[j * MM_W + i] = p->color;
      p->st->pixels++;
    }
  }
}

enum { IN = 0, LEFT = 1, RIGHT = 2, TOP = 4, BOTTOM = 8 };
static int outcode(int x, int y, int x0, int y0, int x1, int y1) {
  return (x < x0 ? LEFT : x > x1 ? RIGHT : IN) | (y < y0 ? TOP : y > y1 ? BOTTOM : IN);
}

// Cohen–Sutherland to the strip (plus the brush margin), then Bresenham.
static void line(const pen *p, int ax, int ay, int bx, int by) {
  const int m = p->w, x0 = -m, y0 = -m, x1 = MM_W - 1 + m, y1 = MM_STRIP - 1 + m;
  int ca = outcode(ax, ay, x0, y0, x1, y1), cb = outcode(bx, by, x0, y0, x1, y1);
  while (ca | cb) {
    if (ca & cb) return;
    int c = ca ? ca : cb, x, y;
    // Products stay below 2^31 given the bounds in mcumap.h (|px| < 8,500).
    if (c & TOP)         { x = ax + (bx - ax) * (y0 - ay) / (by - ay); y = y0; }
    else if (c & BOTTOM) { x = ax + (bx - ax) * (y1 - ay) / (by - ay); y = y1; }
    else if (c & LEFT)   { y = ay + (by - ay) * (x0 - ax) / (bx - ax); x = x0; }
    else                 { y = ay + (by - ay) * (x1 - ax) / (bx - ax); x = x1; }
    if (c == ca) { ax = x; ay = y; ca = outcode(ax, ay, x0, y0, x1, y1); }
    else         { bx = x; by = y; cb = outcode(bx, by, x0, y0, x1, y1); }
  }
  p->st->segments_drawn++;
  int dx = bx > ax ? bx - ax : ax - bx, sx = ax < bx ? 1 : -1;
  int dy = by > ay ? ay - by : by - ay, sy = ay < by ? 1 : -1;
  int err = dx + dy;
  for (;;) {
    plot(p, ax, ay);
    if (ax == bx && ay == by) return;
    int e2 = 2 * err;
    if (e2 >= dy) { err += dy; ax += sx; }
    if (e2 <= dx) { err += dx; ay += sy; }
  }
}

void mm_render_strip(const mm_view *v, int y0, uint16_t *buf, mm_stats *st) {
  for (int i = 0; i < MM_W * MM_STRIP; i++) buf[i] = BG;
  // The strip in map units, widened by the widest brush.
  const int32_t s = v->scale, half = MM_W / 2;
  const int32_t ux0 = v->cx + (-half - 3) * 256 / s, ux1 = v->cx + (half + 3) * 256 / s;
  const int32_t uy0 = v->cy + (y0 - half - 3) * 256 / s, uy1 = v->cy + (y0 + MM_STRIP - half + 3) * 256 / s;
  for (uint16_t r = 0; r < mm_road_count; r++) {
    const mm_road *road = &mm_roads[r];
    if (s < MIN_SCALE[road->cls]) continue;
    st->roads_tested++;
    if (road->maxx < ux0 || road->minx > ux1 || road->maxy < uy0 || road->miny > uy1) continue;
    pen p = {buf, WIDTH[road->cls], COLOR[road->cls], st};
    const int16_t *q = &mm_pts[road->first * 2];
    int px = (q[0] - v->cx) * s / 256 + half, py = (q[1] - v->cy) * s / 256 + half - y0;
    for (uint16_t i = 1; i < road->n; i++) {
      int nx = (q[2 * i] - v->cx) * s / 256 + half, ny = (q[2 * i + 1] - v->cy) * s / 256 + half - y0;
      line(&p, px, py, nx, ny);
      px = nx;
      py = ny;
    }
  }
}
