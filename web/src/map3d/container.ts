// Decoder for the t3d pack container written by tools/maps3d/t3d/pack.py:
//   "T3DP" | u32 version | u32 header length | header JSON | pad to 16 | arrays
// The header describes each array by offset (relative to the padded end of the
// header), numpy dtype string and shape. Arrays are 16-byte aligned, so they
// are returned as views into the buffer without copying.

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

const MAGIC = "T3DP";
const VERSION = 1;
const PREFIX_BYTES = 12;

type ArrayCtor = { new (buffer: ArrayBuffer, byteOffset: number, length: number): NumericArray; BYTES_PER_ELEMENT: number };

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

export function decodePack<M = unknown>(buffer: ArrayBuffer): Pack<M> {
  if (buffer.byteLength < PREFIX_BYTES) throw new Error("not a T3DP pack: too short");
  const view = new DataView(buffer);
  const magic = String.fromCharCode(view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3));
  const version = view.getUint32(4, true);
  if (magic !== MAGIC || version !== VERSION) {
    throw new Error(`not a T3DP v${VERSION} pack (magic=${JSON.stringify(magic)}, version=${version})`);
  }
  const headerLength = view.getUint32(8, true);
  const headerBytes = new Uint8Array(buffer, PREFIX_BYTES, headerLength);
  const header = JSON.parse(new TextDecoder().decode(headerBytes)) as {
    meta: M;
    arrays: Record<string, { offset: number; dtype: string; shape: number[] }>;
  };
  let base = PREFIX_BYTES + headerLength;
  base += (16 - (base % 16)) % 16;

  const arrays: Record<string, PackArray> = {};
  for (const [name, d] of Object.entries(header.arrays)) {
    const ctor = arrayCtor(d.dtype);
    const count = d.shape.reduce((a, b) => a * b, 1);
    const offset = base + d.offset;
    if (offset + count * ctor.BYTES_PER_ELEMENT > buffer.byteLength) {
      throw new Error(`array ${name} runs past the end of the pack`);
    }
    arrays[name] = { data: new ctor(buffer, offset, count), shape: d.shape };
  }
  return { meta: header.meta, arrays };
}
