// WebGL2 renderer for PLATEAU buildings around Tokyo Station.
// One VAO per tile and level (u16 positions, u16 indices, as decoded), the
// ground as one grid of u16 heights (positions from gl_VertexID). No normals
// are stored: the fragment shader takes the face normal from the screen
// derivatives of the eye-relative position (maptalks.js layer-3dtiles
// s3m.frag does the same), which also lets the bake weld every corner.
// Light is fixed in the local east-north-up frame: a sun at azimuth 210
// (south-south-west), altitude 45, diffuse 0.6, plus a hemisphere ambient
// (0.34 below to 0.54 above); roofs warm grey, walls cool grey. From the
// first view (camera to the south-east) south walls are lit and east walls
// in shade, so neighbouring faces differ.
import { frame, type Cam, type Frame } from './camera.ts';
import type { Header, Ground, Mesh, Loader } from './plb.ts';

const BUILDING_VS = `#version 300 es
layout(location=0) in vec3 a_q;
uniform mat4 u_vp; uniform vec3 u_eye, u_min;
out vec3 v_rel;
void main() { vec3 p = u_min + a_q * 0.01; v_rel = p - u_eye; gl_Position = u_vp * vec4(p, 1.0); }`;
const GROUND_VS = `#version 300 es
layout(location=0) in float a_h;
uniform mat4 u_vp; uniform vec3 u_eye; uniform vec4 u_g;   // half, step, z0, n
out vec3 v_rel;
void main() {
  float i = float(gl_VertexID), r = floor(i / u_g.w), c = i - r * u_g.w;
  vec3 p = vec3(c * u_g.y - u_g.x, r * u_g.y - u_g.x, u_g.z + a_h * 0.01);
  v_rel = p - u_eye; gl_Position = u_vp * vec4(p, 1.0);
}`;
export const SKY = [0.8, 0.86, 0.92];
const FS = `#version 300 es
precision highp float;
in vec3 v_rel;
uniform int u_kind; uniform vec2 u_fog;
out vec4 o;
const vec3 SUN = vec3(-0.35355, -0.61237, 0.70711);
void main() {
  vec3 n = normalize(cross(dFdx(v_rel), dFdy(v_rel)));
  if (dot(n, v_rel) > 0.0) n = -n;
  vec3 albedo = u_kind == 1 ? vec3(0.66, 0.72, 0.6) : n.z > 0.7 ? vec3(0.86, 0.8, 0.72) : vec3(0.74, 0.77, 0.84);
  vec3 c = albedo * (0.6 * max(dot(n, SUN), 0.0) + mix(0.34, 0.54, n.z * 0.5 + 0.5));
  o = vec4(mix(c, vec3(${SKY.join(', ')}), smoothstep(u_fog.x, u_fog.y, length(v_rel))), 1.0);
}`;
const FOG = [1500, 6000];

interface Part { vao: WebGLVertexArrayObject; n: number; bufs: WebGLBuffer[]; bytes: number }
export interface Override { vp: Float64Array; eye: number[]; fog: boolean; visible?: number[] }
export type View = Awaited<ReturnType<typeof createView>>;

// The shaders are compiled while `data` (the archive's first read) is on
// the way; their status is asked for only after it arrived.
export async function createView(canvas: HTMLCanvasElement, data: Promise<{ h: Header; ground: Ground }>, opts: { sync?: boolean } = {}) {
  const ctx = canvas.getContext('webgl2', { antialias: true, alpha: false, powerPreference: 'high-performance' });
  if (!ctx) throw new Error('WebGL2 is not available');
  const gl: WebGL2RenderingContext = ctx;
  const program = (vs: string) => {
    const p = gl.createProgram();
    for (const [type, src] of [[gl.VERTEX_SHADER, vs], [gl.FRAGMENT_SHADER, FS]] as const) {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, src);
      gl.compileShader(s);
      gl.attachShader(p, s);
    }
    gl.linkProgram(p);
    return p;
  };
  const programs = [program(BUILDING_VS), program(GROUND_VS)];
  const { h, ground } = await data;
  const [bp, gp] = programs.map((p) => {
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p) ?? 'link failed');
    const u = (n: string) => gl.getUniformLocation(p, n);
    return { p, vp: u('u_vp'), eye: u('u_eye'), min: u('u_min'), g: u('u_g'), kind: u('u_kind'), fog: u('u_fog') };
  });

  let gpuBytes = 0;
  const buffer = (target: GLenum, data: ArrayBufferView): WebGLBuffer => {
    const b = gl.createBuffer();
    gl.bindBuffer(target, b);
    gl.bufferData(target, data, gl.STATIC_DRAW);
    gpuBytes += data.byteLength;
    return b;
  };
  const part = (attr: ArrayBufferView, size: number, idx: Uint16Array): Part => {
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    const bufs = [buffer(gl.ARRAY_BUFFER, attr), buffer(gl.ELEMENT_ARRAY_BUFFER, idx)];
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, size, gl.UNSIGNED_SHORT, false, 0, 0);
    gl.bindVertexArray(null);
    return { vao, n: idx.length, bufs, bytes: attr.byteLength + idx.byteLength };
  };

  // Ground: (n-1)^2 cells, two triangles each.
  const gn = ground.n, gi = new Uint16Array((gn - 1) * (gn - 1) * 6);
  for (let r = 0, k = 0; r < gn - 1; r++) for (let c = 0; c < gn - 1; c++, k += 6) {
    const a = r * gn + c;
    gi[k] = gi[k + 3] = a; gi[k + 1] = a + 1; gi[k + 2] = gi[k + 4] = a + gn + 1; gi[k + 5] = a + gn;
  }
  const groundPart = part(ground.h, 1, gi);
  let gmax = 0;
  for (const v of ground.h) gmax = Math.max(gmax, v);
  const z0 = ground.z0 / 100, step = (2 * h.half) / (gn - 1);
  const boxes = [{ lo: [-h.half, -h.half, z0], hi: [h.half, h.half, z0 + gmax / 100] },
    ...h.tiles.map((t) => ({ lo: t.min.map((v) => v / 100), hi: t.min.map((v, k) => (v + t.size[k]) / 100) }))];

  const parts: (Part | null)[] = new Array(h.tiles.length * 2).fill(null);
  const cam: Cam = { x: 0, y: 0, z: 0, yaw: 0, pitch: 45, dist: 1000 };
  let pending = false, armed = 0;

  const view = {
    gl, cam, h, boxes,
    loader: null as Loader | null,
    frames: 0,
    calls: [0, 0],          // draw calls per level in the last frame
    last: null as Frame | null,
    showL1: true,
    cull: false,
    onMark: null as ((name: 'first' | 'settled', t: number) => void) | null,
    get gpuBytes() { return gpuBytes; },
    has: (k: number): boolean => parts[k] !== null || (h.tiles[k >> 1].lv[k & 1].len === 0 && h.tiles[k >> 1].lv[k & 1].ni === 0),

    add(tile: number, level: number, m: Mesh): void {
      if (parts[2 * tile + level] || !m.idx.length) return;
      parts[2 * tile + level] = part(m.q, 3, m.idx);
      view.request();
    },

    // Forget every block (GPU buffers and loader state): a cold start for
    // the bench's close-up scenario.
    reset(): void {
      for (const p of parts) if (p) { for (const b of p.bufs) gl.deleteBuffer(b); gl.deleteVertexArray(p.vao); gpuBytes -= p.bytes; }
      parts.fill(null);
      view.loader?.reset();
      armed = 0;
    },

    request(): void {
      if (pending) return;
      pending = true;
      requestAnimationFrame(() => { pending = false; view.frames++; view.draw(); });
    },

    // Draws the camera's view, or `over` (the bench's fixed matrices).
    draw(over?: Override): Frame {
      const W = canvas.width, H = canvas.height;
      const f: Frame = over ? { vp: over.vp, eye: over.eye, near: 0, far: 0, visible: over.visible ?? h.tiles.map((_, i) => i) } : frame(cam, W / H, boxes);
      if (!over) view.last = f;
      gl.viewport(0, 0, W, H);
      gl.clearColor(SKY[0], SKY[1], SKY[2], 1);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      gl.enable(gl.DEPTH_TEST);
      gl.depthFunc(gl.LEQUAL);
      const vp = new Float32Array(f.vp), eye = new Float32Array(f.eye), fog = over && !over.fog ? [1e9, 2e9] : FOG;
      const common = (p: typeof bp, kind: number) => {
        gl.useProgram(p.p);
        gl.uniformMatrix4fv(p.vp, false, vp);
        gl.uniform3fv(p.eye, eye);
        gl.uniform1i(p.kind, kind);
        gl.uniform2f(p.fog, fog[0], fog[1]);
      };
      common(gp, 1);
      gl.uniform4f(gp.g, h.half, step, z0, gn);
      gl.enable(gl.POLYGON_OFFSET_FILL);
      gl.polygonOffset(1, 1);
      gl.bindVertexArray(groundPart.vao);
      gl.drawElements(gl.TRIANGLES, groundPart.n, gl.UNSIGNED_SHORT, 0);
      common(bp, 0);
      view.calls = [0, 0];
      for (let level = 0; level < (view.showL1 ? 2 : 1); level++) {
        // Installations sit on roofs and walls: pulled forward, not culled.
        gl.polygonOffset(-level, -level);
        if (level === 0 && view.cull) gl.enable(gl.CULL_FACE); else gl.disable(gl.CULL_FACE);
        for (const i of f.visible) {
          const p = parts[2 * i + level];
          if (!p) continue;
          const t = h.tiles[i];
          gl.uniform3f(bp.min, t.min[0] / 100, t.min[1] / 100, t.min[2] / 100);
          gl.bindVertexArray(p.vao);
          gl.drawElements(gl.TRIANGLES, p.n, gl.UNSIGNED_SHORT, 0);
          view.calls[level]++;
        }
      }
      gl.disable(gl.POLYGON_OFFSET_FILL);
      gl.disable(gl.CULL_FACE);
      gl.bindVertexArray(null);
      if (over) return f;

      // Ask for what the view lacks: every visible L0 nearest first, then L1.
      const dist = (i: number) => Math.hypot(...[0, 1, 2].map((k) => Math.max(boxes[i + 1].lo[k] - f.eye[k], 0, f.eye[k] - boxes[i + 1].hi[k])));
      const near = [...f.visible].sort((a, b) => dist(a) - dist(b));
      view.loader?.want([...near.map((i) => 2 * i), ...near.map((i) => 2 * i + 1)]);
      const done = (level: number) => f.visible.every((i) => view.has(2 * i + level));
      // Marks: 'first' when every visible tile has L0, 'settled' with L1 too.
      if (armed < 2 && done(0)) {
        const next = done(1) ? 2 : 1;
        if (next > armed) {
          if (opts.sync) gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4));
          const t = performance.now();
          if (armed < 1) view.onMark?.('first', t);
          if (next === 2) view.onMark?.('settled', t);
          armed = next;
        }
      }
      return f;
    },
  };
  return view;
}
