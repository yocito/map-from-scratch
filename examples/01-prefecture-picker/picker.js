// Prefecture picker: 47 baked SVG paths drawn with Canvas 2D.
// Parsing is Path2D's, hit testing is isPointInPath's.
// el receives a "prefecture" CustomEvent ({code, name}) on selection.
export async function mount(el, url) {
  const { w, h, p } = await (await fetch(url)).json();
  const prefs = p.map(([code, name, d]) => ({ code, name, path: new Path2D(d) }));
  const canvas = document.createElement('canvas');
  // CPU-backed on purpose: 47 paths raster cheaply on the CPU, and a
  // GPU-backed 2D canvas can lose its context (and with it the transform the
  // hit test relies on). Headless Chrome 156 drops it ~300 ms after creation.
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  canvas.style.display = 'block';
  el.append(canvas);
  let hover = -1, selected = -1, k = 1;

  // Repaint one prefecture over what is already there. Hover and selection
  // change one or two prefectures, so they never redraw the other 45.
  function paint(i) {
    if (i < 0) return;
    ctx.fillStyle = i === selected ? '#c8553d' : i === hover ? '#f2a65a' : '#8fb8a8';
    ctx.fill(prefs[i].path);
    ctx.stroke(prefs[i].path);
  }

  function draw() {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.setTransform(k, 0, 0, k, 0, 0);
    ctx.lineWidth = devicePixelRatio / k;
    ctx.strokeStyle = '#fff';
    prefs.forEach((_, i) => paint(i));
  }

  function setHover(i) {
    if (i === hover) return;
    const old = hover;
    hover = i;
    paint(old);
    paint(i);
  }

  function resize() {
    const cssW = el.clientWidth;
    k = (cssW * devicePixelRatio) / w;
    canvas.width = Math.round(w * k);
    canvas.height = Math.round(h * k);
    canvas.style.width = `${cssW}px`;
    draw();
  }

  // x, y in CSS pixels relative to the canvas. Returns an index or -1.
  function pick(x, y) {
    const dx = x * devicePixelRatio, dy = y * devicePixelRatio;
    for (let i = 0; i < prefs.length; i++) if (ctx.isPointInPath(prefs[i].path, dx, dy)) return i;
    return -1;
  }

  const at = (e) => {
    const r = canvas.getBoundingClientRect();
    return pick(e.clientX - r.left, e.clientY - r.top);
  };
  canvas.addEventListener('pointermove', (e) => {
    const i = at(e);
    canvas.style.cursor = i < 0 ? '' : 'pointer';
    setHover(i);
  });
  canvas.addEventListener('click', (e) => {
    const i = at(e);
    if (i < 0) return;
    const old = selected;
    selected = i;
    paint(old);
    paint(i);
    el.dispatchEvent(new CustomEvent('prefecture', { detail: { code: prefs[i].code, name: prefs[i].name } }));
  });
  new ResizeObserver(resize).observe(el);
  resize();

  return { ctx, prefs, pick, draw, setHover };
}
