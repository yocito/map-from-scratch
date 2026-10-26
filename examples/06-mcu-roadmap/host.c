// Host harness for the MCU renderer: the same mcumap.c, driven the way the
// device would drive it (15 strips a frame), with timing and work counters.
// Host time is not device time; the counters (roads tested, segments drawn,
// pixels written) are what carries over to the device.
#define _POSIX_C_SOURCE 199309L
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include "mcumap.h"

static double now_ms(void) {
  struct timespec ts;
  clock_gettime(CLOCK_MONOTONIC, &ts);
  return ts.tv_sec * 1e3 + ts.tv_nsec / 1e6;
}

static uint16_t strip[MM_W * MM_STRIP];   // the device's only frame memory
static uint16_t frame[MM_W * MM_H];       // host only: for the screenshot

static void render(const mm_view *v, mm_stats *st) {
  for (int y = 0; y < MM_H; y += MM_STRIP) {
    mm_render_strip(v, y, strip, st);
    memcpy(&frame[y * MM_W], strip, sizeof strip);   // the device would DMA here
  }
}

static void emit(const char *name, const double *v, int n) {
  printf("@mfs {\"metric\":\"%s\",\"values\":[", name);
  for (int i = 0; i < n; i++) printf("%s%.4f", i ? "," : "", v[i]);
  printf("]}\n");
}

// Button presses: scroll by a quarter screen, zoom by factors of two.
static const int SCALES[] = {12, 24, 48, 96, 192};

int main(int argc, char **argv) {
  (void)argc; (void)argv;
  enum { N = 400 };
  static double ms[N], roads[N], segs[N], px[N];
  for (int i = -20; i < N; i++) {
    int k = i < 0 ? 0 : i;
    // At each zoom level in turn, walk a square around the station in
    // steps of 1/16 screen (a quarter-screen scroll animated over 4 frames).
    int level = (k / 80) % 5, leg = (k % 80) / 20, t = k % 20;
    mm_view v = {0, 0, SCALES[level]};
    int gx = leg == 0 ? t : leg == 1 ? 20 : leg == 2 ? 20 - t : 0;
    int gy = leg == 0 ? 0 : leg == 1 ? t : leg == 2 ? 20 : 20 - t;
    int unit = MM_W / 16 * 256 / v.scale;
    v.cx = (gx - 10) * unit;
    v.cy = (gy - 10) * unit;
    mm_stats st = {0, 0, 0};
    double t0 = now_ms();
    render(&v, &st);
    double t1 = now_ms();
    if (i < 0) continue;
    ms[k] = t1 - t0;
    roads[k] = st.roads_tested;
    segs[k] = st.segments_drawn;
    px[k] = st.pixels;
  }
  emit("frame_ms", ms, N);
  emit("roads_tested", roads, N);
  emit("segments_drawn", segs, N);
  emit("pixels_written", px, N);
  printf("@mfs {\"metric\":\"strip_buffer_bytes\",\"value\":%zu}\n", sizeof strip);
  printf("@mfs {\"info\":{\"roads\":%u}}\n", mm_road_count);

  // Functional check: centred on the first motorway point at the closest
  // zoom, the middle of the screen must be motorway red (RGB565 0xE30B).
  for (uint16_t r = 0; r < mm_road_count; r++) {
    if (mm_roads[r].cls != 0) continue;
    const int16_t *q = &mm_pts[mm_roads[r].first * 2];
    if (q[0] < -5000 || q[0] > 5000 || q[1] < -5000 || q[1] > 5000) continue;
    mm_view v = {q[0], q[1], MM_MAX_SCALE};
    mm_stats st = {0, 0, 0};
    render(&v, &st);
    uint16_t c = frame[(MM_H / 2) * MM_W + MM_W / 2];
    printf("@mfs {\"info\":{\"motorway_rgb565\":\"0x%04X\"}}\n", c);
    if (c != 0xE30B) printf("@mfs {\"error\":\"motorway point not drawn red (0x%04X)\"}\n", c);
    break;
  }

  // Screenshot: the station at the default zoom.
  mm_view home = {0, 0, 48};
  mm_stats st = {0, 0, 0};
  render(&home, &st);
  const char *out = getenv("MFS_OUT");
  if (out && getenv("MFS_ITERATION") && !strcmp(getenv("MFS_ITERATION"), "0")) {
    char path[512];
    snprintf(path, sizeof path, "%s/screenshot.ppm", out);
    FILE *f = fopen(path, "wb");
    if (f) {
      fprintf(f, "P6\n%d %d\n255\n", MM_W, MM_H);
      for (int i = 0; i < MM_W * MM_H; i++) {
        uint16_t c = frame[i];
        unsigned char rgb[3] = {(unsigned char)((c >> 11) << 3), (unsigned char)(((c >> 5) & 63) << 2), (unsigned char)((c & 31) << 3)};
        fwrite(rgb, 1, 3, f);
      }
      fclose(f);
    }
  }
  printf("@mfs {\"done\":true}\n");
  return 0;
}
