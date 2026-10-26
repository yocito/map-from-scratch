// Every road of Tokyo's 23 wards, native: C, EGL and OpenGL ES 3.0, nothing
// else. Each road segment is one instance of a 4-vertex strip, widened in the
// vertex shader, so the whole network is one draw call.
//
//   roads <roads.bin>            window (X11), drag to pan, wheel to zoom
//   roads --bench <roads.bin>    offscreen (EGL device), prints @mfs lines
#include <EGL/egl.h>
#include <EGL/eglext.h>
#include <GLES3/gl3.h>
#include <GLES2/gl2ext.h>
#include <X11/Xlib.h>
#include <fcntl.h>
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <sys/stat.h>
#include <time.h>
#include <unistd.h>

#define W0 1280
#define H0 800

static const char *VS =
  "#version 300 es\n"
  "layout(location=0) in vec2 a_p0;\n"
  "layout(location=1) in vec2 a_p1;\n"
  "layout(location=2) in float a_cls;\n"
  "uniform vec3 u_cam;\n"          // centre (grid 0..1), px per grid unit
  "uniform vec2 u_vp;\n"
  "uniform float u_w[5];\n"        // width in px per class
  "uniform vec3 u_col[5];\n"
  "flat out vec3 v_col;\n"
  "void main() {\n"
  "  if (a_cls > 254.5) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }\n"
  "  int c = int(a_cls);\n"
  "  vec2 s0 = (a_p0 - u_cam.xy) * u_cam.z, s1 = (a_p1 - u_cam.xy) * u_cam.z;\n"
  "  vec2 d = s1 - s0;\n"
  "  float len = length(d);\n"
  "  vec2 dir = len > 0.0 ? d / len : vec2(1.0, 0.0), nrm = vec2(-dir.y, dir.x);\n"
  "  float w = u_w[c] * 0.5;\n"
  // square caps: each segment overhangs by half its width, hiding the joints
  "  vec2 p = (gl_VertexID < 2 ? s0 - dir * w : s1 + dir * w) + nrm * (gl_VertexID % 2 == 0 ? -w : w);\n"
  "  gl_Position = vec4(p.x / u_vp.x * 2.0, -p.y / u_vp.y * 2.0, 0.0, 1.0);\n"
  "  v_col = u_col[c];\n"
  "}\n";
static const char *FS =
  "#version 300 es\n"
  "precision mediump float;\n"
  "flat in vec3 v_col;\n"
  "out vec4 o;\n"
  "void main() { o = vec4(v_col, 1.0); }\n";

static const float BASE_W[5] = {6.0f, 5.0f, 4.0f, 2.0f, 1.2f};
static const float COLORS[15] = {
  0.88f, 0.38f, 0.35f,   // motorway, trunk
  0.95f, 0.65f, 0.35f,   // primary
  0.97f, 0.85f, 0.57f,   // secondary, tertiary
  1.00f, 1.00f, 1.00f,   // local
  0.72f, 0.70f, 0.65f,   // paths
};
static const float BG[3] = {0.91f, 0.90f, 0.86f};

static struct { GLuint prog; GLint cam, vp, w, col; GLsizei segs; int width, height; float mx, my; } R;
static struct { float x, y, zoom; } cam = {0.5f, 0.4f, 1.0f};

static double now_ms(void) {
  struct timespec ts;
  clock_gettime(CLOCK_MONOTONIC, &ts);
  return ts.tv_sec * 1e3 + ts.tv_nsec / 1e6;
}

// Resident memory now, in MB: shows what the driver costs before we load
// anything, apart from what the data adds.
static double rss_mb(void) {
  FILE *f = fopen("/proc/self/status", "r");
  char line[256];
  double kb = 0;
  while (f && fgets(line, sizeof line, f)) if (!strncmp(line, "VmRSS:", 6)) kb = atof(line + 6);
  if (f) fclose(f);
  return kb / 1024;
}

static void die(const char *msg) {
  printf("@mfs {\"error\":\"%s\"}\n", msg);
  fflush(stdout);
  exit(1);
}

static GLuint shader(GLenum type, const char *src) {
  GLuint s = glCreateShader(type);
  glShaderSource(s, 1, &src, NULL);
  glCompileShader(s);
  GLint ok;
  glGetShaderiv(s, GL_COMPILE_STATUS, &ok);
  if (!ok) {
    char log[1024];
    glGetShaderInfoLog(s, sizeof log, NULL, log);
    fprintf(stderr, "%s\n", log);
    die("shader compile failed");
  }
  return s;
}

// The linked program is kept next to the data (<data>.prog) and reused on
// the next start: loading a program binary does not bring in the driver's
// GLSL compiler, which costs ~60 MB of resident memory and its compile time.
// A binary the driver no longer accepts fails to link and is rebuilt.
static int from_cache;
static GLuint program(const char *data) {
  char cache[512];
  snprintf(cache, sizeof cache, "%s.prog", data);
  GLuint p = glCreateProgram();
  FILE *f = fopen(cache, "rb");
  if (f) {
    GLenum fmt;
    fseek(f, 0, SEEK_END);
    long len = ftell(f) - (long)sizeof fmt;
    fseek(f, 0, SEEK_SET);
    void *bin = len > 0 ? malloc(len) : NULL;
    if (bin && fread(&fmt, sizeof fmt, 1, f) == 1 && fread(bin, 1, len, f) == (size_t)len) glProgramBinary(p, fmt, bin, (GLsizei)len);
    free(bin);
    fclose(f);
    GLint ok = 0;
    glGetProgramiv(p, GL_LINK_STATUS, &ok);
    if (ok) { from_cache = 1; return p; }
  }
  glAttachShader(p, shader(GL_VERTEX_SHADER, VS));
  glAttachShader(p, shader(GL_FRAGMENT_SHADER, FS));
  glProgramParameteri(p, GL_PROGRAM_BINARY_RETRIEVABLE_HINT, GL_TRUE);
  glLinkProgram(p);
  GLint len = 0;
  glGetProgramiv(p, GL_PROGRAM_BINARY_LENGTH, &len);
  if (len > 0 && (f = fopen(cache, "wb"))) {
    void *bin = malloc(len);
    GLenum fmt;
    glGetProgramBinary(p, len, NULL, &fmt, bin);
    fwrite(&fmt, sizeof fmt, 1, f);
    fwrite(bin, 1, len, f);
    fclose(f);
    free(bin);
  }
  return p;
}

// Map the file, upload it, unmap it: the data never stays in process memory.
static void load(const char *path) {
  int fd = open(path, O_RDONLY);
  if (fd < 0) die("cannot open roads.bin");
  struct stat st;
  fstat(fd, &st);
  const unsigned char *p = mmap(NULL, st.st_size, PROT_READ, MAP_PRIVATE, fd, 0);
  close(fd);
  uint32_t n;
  memcpy(&n, p, 4);
  R.segs = (GLsizei)n - 1;

  GLuint vao, buf[2];
  glGenVertexArrays(1, &vao);
  glBindVertexArray(vao);
  glGenBuffers(2, buf);
  glBindBuffer(GL_ARRAY_BUFFER, buf[0]);
  glBufferData(GL_ARRAY_BUFFER, (GLsizeiptr)n * 4, p + 8, GL_STATIC_DRAW);
  // The same vertex array, read twice one vertex apart: segment i is (v[i], v[i+1]).
  glVertexAttribPointer(0, 2, GL_UNSIGNED_SHORT, GL_TRUE, 4, (void *)0);
  glVertexAttribPointer(1, 2, GL_UNSIGNED_SHORT, GL_TRUE, 4, (void *)4);
  glBindBuffer(GL_ARRAY_BUFFER, buf[1]);
  glBufferData(GL_ARRAY_BUFFER, n, p + 8 + (size_t)n * 4, GL_STATIC_DRAW);
  glVertexAttribPointer(2, 1, GL_UNSIGNED_BYTE, GL_FALSE, 1, (void *)0);
  for (int i = 0; i < 3; i++) {
    glEnableVertexAttribArray(i);
    glVertexAttribDivisor(i, 1);
  }
  // Remember one motorway vertex for the functional check in bench mode.
  for (uint32_t i = 0; i < n; i++) {
    if (p[8 + (size_t)n * 4 + i] == 0) {
      uint16_t xy[2];
      memcpy(xy, p + 8 + (size_t)i * 4, 4);
      R.mx = xy[0] / 65535.0f;
      R.my = xy[1] / 65535.0f;
      break;
    }
  }
  munmap((void *)p, st.st_size);
  if (getenv("MFS_OUT")) printf("@mfs {\"metric\":\"rss_uploaded_mb\",\"value\":%.2f}\n", rss_mb());

  R.prog = program(path);
  glUseProgram(R.prog);
  R.cam = glGetUniformLocation(R.prog, "u_cam");
  R.vp = glGetUniformLocation(R.prog, "u_vp");
  R.w = glGetUniformLocation(R.prog, "u_w");
  R.col = glGetUniformLocation(R.prog, "u_col");
  glUniform3fv(R.col, 5, COLORS);
  if (getenv("MFS_OUT")) printf("@mfs {\"metric\":\"rss_compiled_mb\",\"value\":%.2f}\n", rss_mb());
}

static void draw(void) {
  float scale = cam.zoom * (float)(R.width < R.height ? R.width : R.height);
  // Roads widen as you zoom in; never thinner than one pixel.
  float f = fminf(1.5f, 0.3f + cam.zoom / 16.0f), w[5];
  for (int i = 0; i < 5; i++) w[i] = fmaxf(1.0f, BASE_W[i] * f);
  glViewport(0, 0, R.width, R.height);
  glClearColor(BG[0], BG[1], BG[2], 1);
  glClear(GL_COLOR_BUFFER_BIT);
  glUniform3f(R.cam, cam.x, cam.y, scale);
  glUniform2f(R.vp, (float)R.width, (float)R.height);
  glUniform1fv(R.w, 5, w);
  glDrawArraysInstanced(GL_TRIANGLE_STRIP, 0, 4, R.segs);
}

static EGLDisplay egl_device_display(void) {
  PFNEGLQUERYDEVICESEXTPROC query = (PFNEGLQUERYDEVICESEXTPROC)eglGetProcAddress("eglQueryDevicesEXT");
  PFNEGLGETPLATFORMDISPLAYEXTPROC get = (PFNEGLGETPLATFORMDISPLAYEXTPROC)eglGetProcAddress("eglGetPlatformDisplayEXT");
  EGLDeviceEXT dev[8];
  EGLint n = 0;
  if (query && get && query(8, dev, &n) && n > 0) return get(EGL_PLATFORM_DEVICE_EXT, dev[0], NULL);
  return eglGetDisplay(EGL_DEFAULT_DISPLAY);
}

static EGLContext make_context(EGLDisplay dpy, EGLint surface_bit, EGLConfig *cfg) {
  if (!eglInitialize(dpy, NULL, NULL)) die("eglInitialize failed");
  eglBindAPI(EGL_OPENGL_ES_API);
  EGLint attr[] = {EGL_SURFACE_TYPE, surface_bit, EGL_RENDERABLE_TYPE, EGL_OPENGL_ES3_BIT,
                   EGL_RED_SIZE, 8, EGL_GREEN_SIZE, 8, EGL_BLUE_SIZE, 8,
                   EGL_SAMPLE_BUFFERS, 1, EGL_SAMPLES, 4, EGL_NONE};
  EGLint n;
  if (!eglChooseConfig(dpy, attr, cfg, 1, &n) || n == 0) die("no EGL config");
  EGLint ctx[] = {EGL_CONTEXT_MAJOR_VERSION, 3, EGL_NONE};
  EGLContext c = eglCreateContext(dpy, *cfg, EGL_NO_CONTEXT, ctx);
  if (c == EGL_NO_CONTEXT) die("eglCreateContext failed");
  return c;
}

// ---- bench mode -------------------------------------------------------

static PFNGLGETQUERYOBJECTUI64VEXTPROC get_query_u64;

static void emit_values(const char *name, const double *v, int n) {
  printf("@mfs {\"metric\":\"%s\",\"values\":[", name);
  for (int i = 0; i < n; i++) printf("%s%.4f", i ? "," : "", v[i]);
  printf("]}\n");
}

// Draw `steps` frames; frame_ms waits for the GPU (glFinish), gpu_ms comes
// from GL_EXT_disjoint_timer_query.
static void bench(const char *prefix, int steps, void (*setup)(int, int)) {
  double *cpu = malloc(steps * sizeof *cpu), *frame = malloc(steps * sizeof *frame), *gpu = malloc(steps * sizeof *gpu);
  GLuint *q = malloc(steps * sizeof *q);
  glGenQueries(steps, q);
  for (int i = -10; i < steps; i++) {
    setup(i < 0 ? 0 : i, steps);
    double t0 = now_ms();
    if (i >= 0 && get_query_u64) glBeginQuery(GL_TIME_ELAPSED_EXT, q[i]);
    draw();
    if (i >= 0 && get_query_u64) glEndQuery(GL_TIME_ELAPSED_EXT);
    double t1 = now_ms();
    glFinish();
    double t2 = now_ms();
    if (i < 0) continue;
    cpu[i] = t1 - t0;
    frame[i] = t2 - t0;
  }
  char name[64];
  snprintf(name, sizeof name, "%scpu_ms", prefix);
  emit_values(name, cpu, steps);
  snprintf(name, sizeof name, "%sframe_ms", prefix);
  emit_values(name, frame, steps);
  if (get_query_u64) {
    for (int i = 0; i < steps; i++) {
      GLuint64 ns = 0;
      get_query_u64(q[i], GL_QUERY_RESULT, &ns);
      gpu[i] = ns / 1e6;
    }
    snprintf(name, sizeof name, "%sgpu_ms", prefix);
    emit_values(name, gpu, steps);
  }
  glDeleteQueries(steps, q);
  free(cpu); free(frame); free(gpu); free(q);
}

// Shibuya station on the baked grid, and the same zoom path as the browser
// examples: in from the whole city and back out while panning.
static float shx, shy;
static void path(int i, int n) {
  double u = (double)i / (n - 1), w = 0.5 - 0.5 * cos(2 * M_PI * u);
  cam.x = shx + 0.002f * (float)sin(2 * M_PI * u);
  cam.y = shy + 0.001f * (float)sin(4 * M_PI * u);
  cam.zoom = (float)(1.0 + (128.0 - 1.0) * w);
}
static void whole(int i, int n) { (void)i; (void)n; cam.x = 0.5f; cam.y = 0.4f; cam.zoom = 1.0f; }
static void street(int i, int n) { (void)i; (void)n; cam.x = shx; cam.y = shy; cam.zoom = 128.0f; }

static void to_grid(double lon, double lat, float *x, float *y) {
  const double W = 139.50, S = 35.48, E = 139.98, N = 35.85;
  double k = cos((S + N) / 2 * M_PI / 180), span = fmax((E - W) * k, N - S);
  *x = (float)((lon - W) * k / span);
  *y = (float)((N - lat) / span);
}

static void write_ppm(const char *dir) {
  char path[512];
  snprintf(path, sizeof path, "%s/screenshot.ppm", dir);
  unsigned char *px = malloc((size_t)R.width * R.height * 4);
  glReadPixels(0, 0, R.width, R.height, GL_RGBA, GL_UNSIGNED_BYTE, px);
  FILE *f = fopen(path, "wb");
  if (!f) { free(px); return; }
  fprintf(f, "P6\n%d %d\n255\n", R.width, R.height);
  for (int y = R.height - 1; y >= 0; y--)
    for (int x = 0; x < R.width; x++) fwrite(px + ((size_t)y * R.width + x) * 4, 1, 3, f);
  fclose(f);
  free(px);
}

static int run_bench(const char *data) {
  printf("@mfs {\"mark\":\"main\"}\n");
  // The first iteration is a first launch: no program binary yet.
  if (getenv("MFS_ITERATION") && !strcmp(getenv("MFS_ITERATION"), "0")) {
    char cache[512];
    snprintf(cache, sizeof cache, "%s.prog", data);
    unlink(cache);
  }
  printf("@mfs {\"metric\":\"rss_main_mb\",\"value\":%.2f}\n", rss_mb());
  fflush(stdout);
  EGLDisplay dpy = egl_device_display();
  EGLConfig cfg;
  EGLContext ctx = make_context(dpy, EGL_PBUFFER_BIT, &cfg);
  EGLint pb[] = {EGL_WIDTH, W0, EGL_HEIGHT, H0, EGL_NONE};
  EGLSurface surf = eglCreatePbufferSurface(dpy, cfg, pb);
  eglMakeCurrent(dpy, surf, surf, ctx);
  R.width = W0;
  R.height = H0;
  printf("@mfs {\"mark\":\"gl_ready\"}\n");
  printf("@mfs {\"metric\":\"rss_gl_ready_mb\",\"value\":%.2f}\n", rss_mb());
  fflush(stdout);

  load(data);
  draw();
  glFinish();
  printf("@mfs {\"mark\":\"first_frame\"}\n");
  printf("@mfs {\"metric\":\"rss_first_frame_mb\",\"value\":%.2f}\n", rss_mb());
  printf("@mfs {\"info\":{\"gpu\":\"%s\",\"segments\":%d}}\n", (const char *)glGetString(GL_RENDERER), R.segs);
  printf("@mfs {\"metric\":\"program_from_cache\",\"value\":%d}\n", from_cache);
  fflush(stdout);

  if (strstr((const char *)glGetString(GL_EXTENSIONS), "GL_EXT_disjoint_timer_query"))
    get_query_u64 = (PFNGLGETQUERYOBJECTUI64VEXTPROC)eglGetProcAddress("glGetQueryObjectui64vEXT");
  to_grid(139.7016, 35.6580, &shx, &shy);
  bench("", 600, path);
  bench("whole_", 60, whole);
  bench("street_", 60, street);

  // Functional check: the first motorway vertex in the data, centred at
  // street zoom, must come out motorway red.
  cam.x = R.mx; cam.y = R.my; cam.zoom = 128.0f;
  draw();
  unsigned char px[4];
  glReadPixels(R.width / 2, R.height / 2, 1, 1, GL_RGBA, GL_UNSIGNED_BYTE, px);
  printf("@mfs {\"info\":{\"motorway_rgb\":\"%d,%d,%d\"}}\n", px[0], px[1], px[2]);
  if (!(px[0] > 180 && px[1] < 140)) printf("@mfs {\"error\":\"a motorway vertex is not drawn red (%d,%d,%d)\"}\n", px[0], px[1], px[2]);

  const char *out = getenv("MFS_OUT");
  cam.x = shx; cam.y = shy; cam.zoom = 24.0f;
  draw();
  if (out && getenv("MFS_ITERATION") && !strcmp(getenv("MFS_ITERATION"), "0")) write_ppm(out);
  printf("@mfs {\"done\":true}\n");
  eglTerminate(dpy);
  return 0;
}

// ---- window mode ------------------------------------------------------

static int run_window(const char *data) {
  Display *x = XOpenDisplay(NULL);
  if (!x) die("no X display (set DISPLAY, or use --bench)");
  Window win = XCreateSimpleWindow(x, DefaultRootWindow(x), 0, 0, W0, H0, 0, 0, 0);
  XStoreName(x, win, "Tokyo roads");
  XSelectInput(x, win, ExposureMask | StructureNotifyMask | ButtonPressMask | ButtonReleaseMask | PointerMotionMask | KeyPressMask);
  Atom del = XInternAtom(x, "WM_DELETE_WINDOW", False);
  XSetWMProtocols(x, win, &del, 1);
  XMapWindow(x, win);

  EGLDisplay dpy = eglGetDisplay((EGLNativeDisplayType)x);
  EGLConfig cfg;
  EGLContext ctx = make_context(dpy, EGL_WINDOW_BIT, &cfg);
  EGLSurface surf = eglCreateWindowSurface(dpy, cfg, (EGLNativeWindowType)win, NULL);
  eglMakeCurrent(dpy, surf, surf, ctx);
  eglSwapInterval(dpy, 1);
  R.width = W0;
  R.height = H0;
  load(data);

  int dragging = 0, lx = 0, ly = 0, dirty = 1;
  for (;;) {
    while (XPending(x) || !dirty) {
      XEvent e;
      XNextEvent(x, &e);
      float scale = cam.zoom * (float)(R.width < R.height ? R.width : R.height);
      if (e.type == ConfigureNotify) { R.width = e.xconfigure.width; R.height = e.xconfigure.height; dirty = 1; }
      else if (e.type == Expose) dirty = 1;
      else if (e.type == ClientMessage && (Atom)e.xclient.data.l[0] == del) goto out;
      else if (e.type == KeyPress && XLookupKeysym(&e.xkey, 0) == 0xff1b) goto out;   // Escape
      else if (e.type == ButtonPress && e.xbutton.button == 1) { dragging = 1; lx = e.xbutton.x; ly = e.xbutton.y; }
      else if (e.type == ButtonRelease && e.xbutton.button == 1) dragging = 0;
      else if (e.type == MotionNotify && dragging) {
        cam.x -= (e.xmotion.x - lx) / scale;
        cam.y -= (e.xmotion.y - ly) / scale;
        lx = e.xmotion.x; ly = e.xmotion.y;
        dirty = 1;
      } else if (e.type == ButtonPress && (e.xbutton.button == 4 || e.xbutton.button == 5)) {
        // Zoom about the cursor: the grid point under it stays put.
        float gx = cam.x + (e.xbutton.x - R.width / 2.0f) / scale, gy = cam.y + (e.xbutton.y - R.height / 2.0f) / scale;
        cam.zoom = fminf(2048.0f, fmaxf(0.5f, cam.zoom * (e.xbutton.button == 4 ? 1.25f : 0.8f)));
        float s2 = cam.zoom * (float)(R.width < R.height ? R.width : R.height);
        cam.x = gx - (e.xbutton.x - R.width / 2.0f) / s2;
        cam.y = gy - (e.xbutton.y - R.height / 2.0f) / s2;
        dirty = 1;
      }
    }
    draw();
    eglSwapBuffers(dpy, surf);
    dirty = 0;
  }
out:
  eglTerminate(dpy);
  XCloseDisplay(x);
  return 0;
}

int main(int argc, char **argv) {
  if (argc == 3 && !strcmp(argv[1], "--bench")) return run_bench(argv[2]);
  if (argc == 2) return run_window(argv[1]);
  fprintf(stderr, "usage: %s [--bench] roads.bin\n", argv[0]);
  return 2;
}
