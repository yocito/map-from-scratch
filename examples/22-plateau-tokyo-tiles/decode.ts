import { local, normal } from './geo.ts';

declare global { interface Window { DracoDecoderModule?: (options: { locateFile: (name: string) => string }) => Promise<any> } }
export interface Geometry { positions: Float32Array; normals: Float32Array; indices: Uint32Array }
let decoderPromise: Promise<any> | null = null;
function dracoModule(): Promise<any> {
  if (!window.DracoDecoderModule) throw new Error('Draco デコーダーが読み込まれていません');
  return decoderPromise ??= window.DracoDecoderModule({ locateFile: () => './draco_decoder.wasm' });
}

export async function decodeB3dm(bytes: ArrayBuffer): Promise<Geometry[]> {
  const data = new DataView(bytes);
  if (data.getUint32(0, true) !== 0x6d643362 || data.getUint32(4, true) !== 1) throw new Error('b3dm v1 ではありません');
  if (data.getUint32(8, true) !== bytes.byteLength) throw new Error('b3dm の長さが一致しません');
  const glbStart = 28 + data.getUint32(12, true) + data.getUint32(16, true) + data.getUint32(20, true) + data.getUint32(24, true);
  if (data.getUint32(glbStart, true) !== 0x46546c67) throw new Error('b3dm に GLB がありません');
  const jsonLength = data.getUint32(glbStart + 12, true);
  const gltf = JSON.parse(new TextDecoder().decode(new Uint8Array(bytes, glbStart + 20, jsonLength)));
  const binHeader = glbStart + 20 + jsonLength;
  if (data.getUint32(binHeader + 4, true) !== 0x004e4942) throw new Error('GLB に BIN がありません');
  const binStart = binHeader + 8;
  const rtc: number[] = gltf.extensions?.CESIUM_RTC?.center ?? [0, 0, 0];
  const draco = await dracoModule();
  const decoder = new draco.Decoder();
  const parts: Geometry[] = [];
  try {
    for (const mesh of gltf.meshes ?? []) for (const primitive of mesh.primitives ?? []) {
      const ext = primitive.extensions?.KHR_draco_mesh_compression;
      if (!ext || (primitive.mode ?? 4) !== 4) continue;
      const view = gltf.bufferViews[ext.bufferView];
      const encoded = new Int8Array(bytes, binStart + (view.byteOffset ?? 0), view.byteLength);
      const buffer = new draco.DecoderBuffer();
      buffer.Init(encoded, encoded.length);
      const decoded = new draco.Mesh();
      const result = decoder.DecodeBufferToMesh(buffer, decoded);
      draco.destroy(buffer);
      if (!result.ok()) { const message = result.error_msg(); draco.destroy(result); draco.destroy(decoded); throw new Error(`Draco 復号: ${message}`); }
      draco.destroy(result);
      const count = decoded.num_points();
      const attribute = (id: number | undefined, fallback = false): Float32Array => {
        if (id === undefined && fallback) return new Float32Array(count * 3);
        if (id === undefined) throw new Error('Draco POSITION がありません');
        const a = decoder.GetAttributeByUniqueId(decoded, id);
        const values = new draco.DracoFloat32Array();
        decoder.GetAttributeFloatForAllPoints(decoded, a, values);
        const out = new Float32Array(values.size());
        for (let i = 0; i < out.length; i++) out[i] = values.GetValue(i);
        draco.destroy(values);
        return out;
      };
      const xyz = attribute(ext.attributes.POSITION);
      const nrm = attribute(ext.attributes.NORMAL, true);
      const positions = new Float32Array(count * 3), normals = new Float32Array(count * 3);
      for (let i = 0; i < count; i++) {
        const k = 3 * i;
        const p = local(rtc[0] + xyz[k], rtc[1] + xyz[k + 1], rtc[2] + xyz[k + 2]);
        const n = normal(nrm[k], nrm[k + 1], nrm[k + 2]);
        positions.set(p, k); normals.set(n, k);
      }
      const indices = new Uint32Array(decoded.num_faces() * 3);
      const face = new draco.DracoInt32Array();
      for (let i = 0; i < decoded.num_faces(); i++) {
        decoder.GetFaceFromMesh(decoded, i, face);
        indices[3 * i] = face.GetValue(0);
        indices[3 * i + 1] = face.GetValue(1);
        indices[3 * i + 2] = face.GetValue(2);
      }
      draco.destroy(face); draco.destroy(decoded);
      parts.push({ positions, normals, indices });
    }
  } finally { draco.destroy(decoder); }
  if (!parts.length) throw new Error('描ける建物メッシュがありません');
  return parts;
}
