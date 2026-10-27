// Tokyo's 23 wards from PLATEAU's composite 3D Tiles, drawn by our WebGL2
// renderer. Only the Draco codec is vendored; Cesium is not involved.
import { at, regionSphere, type Region } from './geo.ts';
import { decodeB3dm } from './decode.ts';
import { cameraEye, createRenderer, type Mesh, type Camera } from './render.ts';

const SOURCE = 'https://api.plateauview.mlit.go.jp/datacatalog/3dtiles/13-bldg-lod1-latest/tileset.json';
const canvas = document.getElementById('map') as HTMLCanvasElement;
const status = document.getElementById('status')!;
const scale = document.getElementById('scale')!;
const renderer = createRenderer(canvas);
const camera: Camera = { x: 0, y: 0, distance: 25000, yaw: 0, pitch: 56, width: 1, height: 1 };
interface Box { center: [number, number, number]; radius: number }
interface Tile { box: Box; error: number; depth: number; url: string | null; children: Tile[]; mesh: Mesh | null; loading: boolean; failed: boolean; lastUse: number }
interface City { url: string; box: Box; root: Tile | null; loading: boolean; failed: boolean }
let cities: City[] = [], scheduled = false, pending = 0, cityPending = 0, gpuBytes = 0, received = 0, requests = 0, lastError = '';
const queue = new Set<Tile>();
const loaded = new Set<Tile>();
const cityQueue = new Set<City>();

function node(raw: any, base: string, depth = 0): Tile {
  if (!raw.boundingVolume?.region) throw new Error('region 以外の 3D Tiles 境界です');
  return { box: regionSphere(raw.boundingVolume.region as Region), error: raw.geometricError ?? 0, depth,
    url: raw.content?.uri ? new URL(raw.content.uri, base).href : null,
    children: (raw.children ?? []).map((child: any) => node(child, base, depth + 1)), mesh: null, loading: false, failed: false, lastUse: 0 };
}
function schedule() {
  if (scheduled) return;
  scheduled = true;
  requestAnimationFrame(() => { scheduled = false; draw(); });
}
function near(box: Box): boolean {
  const dx = box.center[0] - camera.x, dy = box.center[1] - camera.y;
  return Math.hypot(dx, dy) < box.radius + camera.distance * 1.4;
}
function requestCity(city: City) {
  if (city.root || city.loading || city.failed) return;
  cityQueue.add(city);
}
function pumpCities() {
  for (const city of cityQueue) {
    if (cityPending >= 4) break;
    cityQueue.delete(city);
    if (city.root || city.loading) continue;
    city.loading = true; cityPending++;
    fetch(city.url).then(async response => {
      if (!response.ok) throw new Error(`都市の tileset: HTTP ${response.status}`);
      return node((await response.json()).root, city.url);
    }).then(root => { city.root = root; })
      .catch(reason => { city.failed = true; lastError = String(reason); })
      .finally(() => { city.loading = false; cityPending--; schedule(); });
  }
}
function enqueue(tile: Tile) {
  if (tile.url && !tile.mesh && !tile.loading && !tile.failed) queue.add(tile);
}
function pumpTiles() {
  const targets = [...queue].sort((a, b) => {
    const da = Math.hypot(a.box.center[0] - camera.x, a.box.center[1] - camera.y);
    const db = Math.hypot(b.box.center[0] - camera.x, b.box.center[1] - camera.y);
    return a.depth - b.depth || da - db;
  });
  queue.clear();
  for (const tile of targets) {
    if (pending >= 5) break;
    if (!tile.url || tile.mesh || tile.loading || tile.failed) continue;
    tile.loading = true; pending++;
    fetch(tile.url).then(async response => {
      if (!response.ok) throw new Error(`建物タイル: HTTP ${response.status}`);
      const bytes = await response.arrayBuffer();
      received += bytes.byteLength; requests++;
      return decodeB3dm(bytes);
    }).then(geometry => {
      tile.mesh = renderer.upload(geometry);
      gpuBytes += tile.mesh.bytes;
      loaded.add(tile);
    }).catch(reason => { tile.failed = true; lastError = String(reason); })
      .finally(() => { tile.loading = false; pending--; schedule(); });
  }
}
function choose(tile: Tile, budget: { count: number }, eye: [number, number, number]): { ready: boolean; meshes: Mesh[] } {
  if (!near(tile.box)) return { ready: true, meshes: [] };
  if (budget.count >= 90) return { ready: false, meshes: [] };
  budget.count++;
  enqueue(tile);
  const distance = Math.max(1, Math.hypot(tile.box.center[0] - eye[0], tile.box.center[1] - eye[1], tile.box.center[2] - eye[2]) - tile.box.radius);
  const errorPixels = tile.error * Math.max(1, canvas.clientHeight) / (2 * Math.tan(Math.PI / 6) * distance);
  if (tile.children.length && errorPixels > 30 && budget.count < 90) {
    const children = tile.children.filter(child => near(child.box)).map(child => choose(child, budget, eye));
    if (children.length && children.every(child => child.ready)) return { ready: true, meshes: children.flatMap(child => child.meshes) };
    if (!tile.mesh) return { ready: false, meshes: children.flatMap(child => child.meshes) };
  }
  if (tile.mesh) { tile.lastUse = performance.now(); return { ready: true, meshes: [tile.mesh] }; }
  return { ready: false, meshes: [] };
}
function draw() {
  camera.width = canvas.clientWidth; camera.height = canvas.clientHeight;
  const nearby = cities.filter(city => near(city.box)).sort((a, b) => {
    const da = Math.hypot(a.box.center[0] - camera.x, a.box.center[1] - camera.y);
    const db = Math.hypot(b.box.center[0] - camera.x, b.box.center[1] - camera.y);
    return da - db;
  }).slice(0, camera.distance > 35000 ? 23 : 12);
  for (const city of nearby) requestCity(city);
  pumpCities();
  const eye = cameraEye(camera);
  const meshes = nearby.flatMap(city => city.root ? choose(city.root, { count: 0 }, eye).meshes : []);
  pumpTiles();
  renderer.draw(camera, meshes);
  if (gpuBytes > 160 * 1048576) {
    const old = [...loaded].filter(tile => performance.now() - tile.lastUse > 15000).sort((a, b) => a.lastUse - b.lastUse);
    for (const tile of old) {
      if (gpuBytes < 128 * 1048576) break;
      if (tile.mesh) { gpuBytes -= tile.mesh.bytes; renderer.remove(tile.mesh); tile.mesh = null; loaded.delete(tile); }
    }
  }
  scale.textContent = `視点距離 ${(camera.distance / 1000).toFixed(camera.distance < 10000 ? 1 : 0)} km`;
  status.textContent = `${nearby.length} 区 · ${meshes.length} 建物タイル表示 · 読込中 ${pending + cityPending} · ${(received / 1048576).toFixed(1)} MiB / ${requests} 件${lastError ? ` · ${lastError}` : ''}`;
}

const places: Record<string, [number, number, number]> = {
  tokyo: [139.76712, 35.68124, 25000], shinjuku: [139.7006, 35.6938, 10500],
  shibuya: [139.7016, 35.6580, 7500], ueno: [139.7774, 35.7138, 7500],
  odaiba: [139.7757, 35.6264, 11000], ikebukuro: [139.7109, 35.7289, 9000],
};
document.querySelectorAll<HTMLButtonElement>('[data-place]').forEach(button => button.addEventListener('click', () => {
  const place = places[button.dataset.place!];
  [camera.x, camera.y] = at(place[0], place[1]); camera.distance = place[2]; schedule();
}));
canvas.addEventListener('contextmenu', event => event.preventDefault());
let drag: { id: number; x: number; y: number; pan: boolean } | null = null;
canvas.addEventListener('pointerdown', event => { canvas.setPointerCapture(event.pointerId); drag = { id: event.pointerId, x: event.clientX, y: event.clientY, pan: event.button === 2 || event.shiftKey }; });
canvas.addEventListener('pointermove', event => {
  if (drag?.id !== event.pointerId) return;
  const dx = event.clientX - drag.x, dy = event.clientY - drag.y;
  drag.x = event.clientX; drag.y = event.clientY;
  if (drag.pan) {
    const units = camera.distance * 2 * Math.tan(Math.PI / 6) / Math.max(1, canvas.clientHeight);
    const yaw = camera.yaw * Math.PI / 180;
    camera.x -= (Math.cos(yaw) * dx + Math.sin(yaw) * dy) * units;
    camera.y -= (Math.sin(yaw) * dx - Math.cos(yaw) * dy) * units;
  } else {
    camera.yaw = (camera.yaw - dx * 0.3 + 360) % 360;
    camera.pitch = Math.max(15, Math.min(85, camera.pitch + dy * 0.25));
  }
  schedule();
});
canvas.addEventListener('pointerup', () => { drag = null; });
canvas.addEventListener('pointercancel', () => { drag = null; });
canvas.addEventListener('wheel', event => { event.preventDefault(); camera.distance = Math.max(300, Math.min(80000, camera.distance * Math.exp(event.deltaY * 0.0015))); schedule(); }, { passive: false });
new ResizeObserver(schedule).observe(canvas);

try {
  const response = await fetch(SOURCE);
  if (!response.ok) throw new Error(`PLATEAU データ一覧: HTTP ${response.status}`);
  const root = (await response.json()).root;
  cities = (root.children ?? []).filter((child: any) => {
    const code = child.content?.uri?.match(/\/(131\d\d)_/)?.[1];
    return code && Number(code) >= 13101 && Number(code) <= 13123;
  }).map((child: any) => ({ url: child.content.uri, box: regionSphere(child.boundingVolume.region as Region), root: null, loading: false, failed: false }));
  schedule();
} catch (reason) { status.textContent = String(reason); }
