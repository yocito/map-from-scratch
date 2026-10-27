// A stable East-North-Up frame for Tokyo's buildings. Work in doubles until
// subtracting the origin; only local, small coordinates go to WebGL.
const A = 6378137;
const E2 = 6.69437999014e-3;
const RAD = Math.PI / 180;
const LON = 139.76712 * RAD, LAT = 35.68124 * RAD;
const sl = Math.sin(LON), cl = Math.cos(LON), sp = Math.sin(LAT), cp = Math.cos(LAT);
const east = [-sl, cl, 0], north = [-sp * cl, -sp * sl, cp], up = [cp * cl, cp * sl, sp];

export function ecef(lon: number, lat: number, height: number): [number, number, number] {
  const c = Math.cos(lat), s = Math.sin(lat), n = A / Math.sqrt(1 - E2 * s * s);
  return [(n + height) * c * Math.cos(lon), (n + height) * c * Math.sin(lon), (n * (1 - E2) + height) * s];
}
const origin = ecef(LON, LAT, 0);
export function local(x: number, y: number, z: number): [number, number, number] {
  const d = [x - origin[0], y - origin[1], z - origin[2]];
  return [d[0] * east[0] + d[1] * east[1], d[0] * north[0] + d[1] * north[1] + d[2] * north[2], d[0] * up[0] + d[1] * up[1] + d[2] * up[2]];
}
export function normal(x: number, y: number, z: number): [number, number, number] {
  return [x * east[0] + y * east[1], x * north[0] + y * north[1] + z * north[2], x * up[0] + y * up[1] + z * up[2]];
}
export function at(lon: number, lat: number, height = 0): [number, number, number] {
  return local(...ecef(lon * RAD, lat * RAD, height));
}
export type Region = [number, number, number, number, number, number];
export function regionSphere(region: Region): { center: [number, number, number]; radius: number } {
  const [west, south, eastLon, northLat, low, high] = region;
  const center = local(...ecef((west + eastLon) / 2, (south + northLat) / 2, (low + high) / 2));
  let radius = 0;
  for (const lon of [west, eastLon]) for (const lat of [south, northLat]) for (const h of [low, high]) {
    const p = local(...ecef(lon, lat, h));
    radius = Math.max(radius, Math.hypot(p[0] - center[0], p[1] - center[1], p[2] - center[2]));
  }
  return { center, radius };
}
