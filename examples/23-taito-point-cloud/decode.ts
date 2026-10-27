// Point Cloud PNG 1.0/1.0.1. Values are losslessly stored in RGB pixels,
// followed by column-major point records. The image may itself be WebP.
export interface Origin { x: number; y: number; scale: number }
export interface Cloud { positions: Float32Array; colors: Uint8Array; count: number }
interface Coordinate { pixels: number; offset: number; factor: number }

export function decodePcpng(rgba: Uint8ClampedArray, width: number, height: number, origin: Origin): Cloud {
  const capacity = width * height;
  if (rgba.length < capacity * 4 || capacity < 12) throw new Error('truncated point cloud image');
  const rgb = (pixel: number) => {
    if (pixel < 0 || pixel >= capacity) throw new Error('truncated point cloud columns');
    const i = pixel * 4;
    return rgba[i] * 65536 + rgba[i + 1] * 256 + rgba[i + 2];
  };
  const signed = (pixel: number, pixels: number) => {
    const value = pixels === 2 ? rgb(pixel) * 16777216 + rgb(pixel + 1) : rgb(pixel);
    const bits = pixels * 24;
    return value >= 2 ** (bits - 1) ? value - 2 ** bits : value;
  };
  if (rgb(0) !== 0x010101) throw new Error('unsupported point cloud PNG version');
  const headerLength = rgb(1);
  const count = rgb(2) * 16777216 + rgb(3);
  if (headerLength > capacity || count > capacity) throw new Error('truncated point cloud columns');
  let cursor = 5;
  const coordinate = (): Coordinate => {
    const info = rgb(cursor++), n = (info >> 16) & 15, offsetPixels = (info >> 8) & 255;
    if ((info >> 20) !== 3 || n < 1 || n > 2 || offsetPixels > 2) throw new Error('unsupported coordinate encoding');
    const offset = offsetPixels ? signed(cursor, offsetPixels) : 0;
    cursor += offsetPixels;
    const factorByte = info & 255;
    return { pixels: n, offset, factor: 10 ** (factorByte < 128 ? factorByte : factorByte - 256) };
  };
  const x = coordinate(), y = coordinate();
  // The subtype follows the optional z and color field definitions. The
  // mixed GSJ tiles contain both, with no id or class columns.
  const z = coordinate();
  const colorInfo = rgb(cursor++);
  if (colorInfo !== 0x110000) throw new Error('point colors are required');
  const subtype = rgb(cursor++), flags = subtype >> 16;
  const projection = (subtype >> 8) & 255, order = subtype & 255;
  if (projection !== 1 || order > 47) throw new Error('unsupported point cloud projection');
  if ((flags & 12) !== 12 || (flags & 3) !== 0 || cursor > headerLength) throw new Error('unsupported point cloud columns');
  const xStart = headerLength, yStart = xStart + count * x.pixels;
  const zStart = yStart + count * y.pixels, colorStart = zStart + count * z.pixels;
  if (colorStart + count > capacity) throw new Error('truncated point cloud columns');
  const positions = new Float32Array(count * 3), colors = new Uint8Array(count * 3);
  const meter = origin.scale / 2 ** order;
  for (let i = 0; i < count; i++) {
    const px = (signed(xStart + i * x.pixels, x.pixels) + x.offset) / x.factor;
    const py = (signed(yStart + i * y.pixels, y.pixels) + y.offset) / y.factor;
    positions[i * 3] = px * meter - origin.x;
    positions[i * 3 + 1] = origin.y - py * meter;
    positions[i * 3 + 2] = (signed(zStart + i * z.pixels, z.pixels) + z.offset) / z.factor;
    const c = (colorStart + i) * 4;
    colors[i * 3] = rgba[c]; colors[i * 3 + 1] = rgba[c + 1]; colors[i * 3 + 2] = rgba[c + 2];
  }
  return { positions, colors, count };
}
