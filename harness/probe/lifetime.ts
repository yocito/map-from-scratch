export {};

// Do WebGL contexts survive? Creates one at load, another 3 s later, and
// reports which GPU each got and whether each is still alive later.
const emit = (o: object): void => ((window as any).__mfsEmit ? (window as any).__mfsEmit(JSON.stringify(o)) : console.log(o));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const make = () => {
  const gl = document.createElement('canvas').getContext('webgl2')!;
  const dbg = gl.getExtension('WEBGL_debug_renderer_info');
  gl.clear(gl.COLOR_BUFFER_BIT);
  let lostAt: number | null = null;
  gl.canvas.addEventListener('webglcontextlost', () => { lostAt = performance.now(); });
  return { gl, gpu: gl.getParameter(dbg!.UNMASKED_RENDERER_WEBGL), lost: () => lostAt };
};
const a = make();
await sleep(3000);
const b = make();
await sleep(3000);
emit({ info: { first_gpu: a.gpu, first_lost_at: a.lost(), second_gpu: b.gpu, second_lost_at: b.lost(), now: performance.now() } });
emit({ done: true });
