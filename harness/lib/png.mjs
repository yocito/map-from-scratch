import { deflateSync, crc32 } from 'node:zlib';

// Native renderers write the easiest image there is (binary PPM); the
// harness turns it into a PNG so every example's screenshot looks the same.
export function parsePpm(buf) {
  if (buf.toString('ascii', 0, 2) !== 'P6') throw new Error('not a binary P6 PPM');
  const fields = [];
  let i = 2;
  while (fields.length < 3) {
    while (/\s/.test(String.fromCharCode(buf[i]))) i++;
    if (buf[i] === 0x23) { while (buf[i] !== 0x0a) i++; continue; }   // # comment
    let s = '';
    while (!/\s/.test(String.fromCharCode(buf[i]))) s += String.fromCharCode(buf[i++]);
    fields.push(Number(s));
  }
  const [width, height, max] = fields;
  if (max !== 255) throw new Error('only 8-bit PPM is supported');
  return { width, height, rgb: buf.subarray(i + 1, i + 1 + width * height * 3) };
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

export function ppmToPng(buf) {
  const { width, height, rgb } = parsePpm(buf);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 2;   // RGB
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) rgb.copy(raw, y * (width * 3 + 1) + 1, y * width * 3, (y + 1) * width * 3);
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
