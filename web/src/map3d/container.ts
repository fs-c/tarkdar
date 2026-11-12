// Decoder for the t3d pack container written by tools/maps3d/t3d/pack.py:
//   "T3DP" | u32 version | u32 header length | header JSON | pad to 16 | arrays
// The header describes each array by offset (relative to the padded end of the
// header), numpy dtype string and shape. Arrays are 16-byte aligned, so they
// are returned as views into the buffer without copying.
// In a version 2 pack an array can be stored through a meshoptimizer codec ("codec" and
// "segments" in its header entry: pieces of [elements, bytes], stored back to back). Those
// are decoded into arrays of their own, by the decoder the caller passes in.

export type NumericArray =
  | Float32Array
  | Float64Array
  | Uint8Array
  | Int8Array
  | Uint16Array
  | Int16Array
  | Uint32Array
  | Int32Array;

export interface PackArray {
  data: NumericArray;
  shape: number[];
}

export interface Pack<M = unknown> {
  meta: M;
  arrays: Record<string, PackArray>;
}

/** The two functions of the meshopt decoder (three/addons/libs/meshopt_decoder.module.js) a pack needs. */
export interface PackDecoder {
  decodeVertexBuffer(target: Uint8Array, count: number, size: number, source: Uint8Array): void;
  decodeIndexBuffer(target: Uint8Array, count: number, size: number, source: Uint8Array): void;
}

const MAGIC = "T3DP";
const VERSIONS = [1, 2];
const PREFIX_BYTES = 12;

type ArrayCtor = {
  new (buffer: ArrayBuffer, byteOffset: number, length: number): NumericArray;
  new (length: number): NumericArray;
  BYTES_PER_ELEMENT: number;
};

interface ArrayEntry {
  offset: number;
  dtype: string;
  shape: number[];
  codec?: string;
  segments?: [number, number][];
}

const DTYPES: Record<string, ArrayCtor> = {
  f4: Float32Array,
  f8: Float64Array,
  u1: Uint8Array,
  i1: Int8Array,
  u2: Uint16Array,
  i2: Int16Array,
  u4: Uint32Array,
  i4: Int32Array,
};

function arrayCtor(dtype: string): ArrayCtor {
  const order = dtype[0];
  const ctor = DTYPES[dtype.slice(1)];
  if (!ctor || order === ">") throw new Error(`unsupported array dtype ${dtype}`);
  return ctor;
}

/** Decodes one stored array into an array of its own. */
function decodeCoded(name: string, d: ArrayEntry, ctor: ArrayCtor, buffer: ArrayBuffer, start: number, decoder?: PackDecoder): NumericArray {
  if (!decoder) throw new Error(`array ${name} is stored with ${d.codec}: a decoder is needed`);
  const count = d.shape.reduce((a, b) => a * b, 1);
  const out = new ctor(count);
  const target = new Uint8Array(out.buffer);
  // A piece's elements: rows for vertices, single indices for a triangle list.
  const elementBytes = d.codec === "meshopt-vertex" ? (count / (d.shape[0] || 1)) * ctor.BYTES_PER_ELEMENT : ctor.BYTES_PER_ELEMENT;
  let done = 0;
  let offset = start;
  for (const [elements, bytes] of d.segments ?? []) {
    if (offset + bytes > buffer.byteLength || (done + elements) * elementBytes > target.byteLength) {
      throw new Error(`array ${name} runs past the end of the pack`);
    }
    const piece = target.subarray(done * elementBytes, (done + elements) * elementBytes);
    const source = new Uint8Array(buffer, offset, bytes);
    if (d.codec === "meshopt-vertex") decoder.decodeVertexBuffer(piece, elements, elementBytes, source);
    else if (d.codec === "meshopt-index") decoder.decodeIndexBuffer(piece, elements, elementBytes, source);
    else throw new Error(`array ${name}: unknown codec ${d.codec}`);
    done += elements;
    offset += bytes;
  }
  if (done * elementBytes !== target.byteLength) throw new Error(`array ${name}: its pieces do not add up`);
  return out;
}

/** `decoder` is needed for a pack with arrays stored through a codec (and must be ready). */
export function decodePack<M = unknown>(buffer: ArrayBuffer, decoder?: PackDecoder): Pack<M> {
  if (buffer.byteLength < PREFIX_BYTES) throw new Error("not a T3DP pack: too short");
  const view = new DataView(buffer);
  const magic = String.fromCharCode(view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3));
  const version = view.getUint32(4, true);
  if (magic !== MAGIC || !VERSIONS.includes(version)) {
    throw new Error(`not a T3DP v${VERSIONS.join("/")} pack (magic=${JSON.stringify(magic)}, version=${version})`);
  }
  const headerLength = view.getUint32(8, true);
  const headerBytes = new Uint8Array(buffer, PREFIX_BYTES, headerLength);
  const header = JSON.parse(new TextDecoder().decode(headerBytes)) as { meta: M; arrays: Record<string, ArrayEntry> };
  let base = PREFIX_BYTES + headerLength;
  base += (16 - (base % 16)) % 16;

  const arrays: Record<string, PackArray> = {};
  for (const [name, d] of Object.entries(header.arrays)) {
    const ctor = arrayCtor(d.dtype);
    const offset = base + d.offset;
    if (d.codec) {
      arrays[name] = { data: decodeCoded(name, d, ctor, buffer, offset, decoder), shape: d.shape };
      continue;
    }
    const count = d.shape.reduce((a, b) => a * b, 1);
    if (offset + count * ctor.BYTES_PER_ELEMENT > buffer.byteLength) {
      throw new Error(`array ${name} runs past the end of the pack`);
    }
    arrays[name] = { data: new ctor(buffer, offset, count), shape: d.shape };
  }
  return { meta: header.meta, arrays };
}
