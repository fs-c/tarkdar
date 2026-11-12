import { decodePack } from "./container";

/** Mirror of tools/maps3d/t3d/pack.py `encode` (no compression). */
export function encodePack(
  meta: unknown,
  arrays: Record<string, { dtype: string; shape: number[]; bytes: Uint8Array; codec?: string; segments?: [number, number][] }>,
  version = 1,
): ArrayBuffer {
  const descr: Record<string, { offset: number; dtype: string; shape: number[]; codec?: string; segments?: [number, number][] }> = {};
  const blobs: { offset: number; bytes: Uint8Array }[] = [];
  let offset = 0;
  for (const [name, a] of Object.entries(arrays).sort(([x], [y]) => (x < y ? -1 : 1))) {
    offset += (16 - (offset % 16)) % 16;
    descr[name] = { offset, dtype: a.dtype, shape: a.shape, ...(a.codec && { codec: a.codec, segments: a.segments }) };
    blobs.push({ offset, bytes: a.bytes });
    offset += a.bytes.byteLength;
  }
  const header = new TextEncoder().encode(JSON.stringify({ meta, arrays: descr }));
  let base = 12 + header.byteLength;
  base += (16 - (base % 16)) % 16;
  const out = new Uint8Array(base + offset);
  out.set(new TextEncoder().encode("T3DP"), 0);
  const view = new DataView(out.buffer);
  view.setUint32(4, version, true);
  view.setUint32(8, header.byteLength, true);
  out.set(header, 12);
  for (const b of blobs) out.set(b.bytes, base + b.offset);
  return out.buffer;
}

export const bytesOf = (a: ArrayBufferView) => new Uint8Array(a.buffer, a.byteOffset, a.byteLength);

describe("decodePack", () => {
  it("decodes meta and typed arrays as views", () => {
    const buffer = encodePack(
      { kind: "x", names: ["é"] },
      {
        f: { dtype: "<f4", shape: [2, 3], bytes: bytesOf(new Float32Array([1, 2, 3, 4, 5, 6])) },
        b: { dtype: "|u1", shape: [3], bytes: new Uint8Array([7, 8, 9]) },
        i: { dtype: "|i1", shape: [2], bytes: bytesOf(new Int8Array([-127, 127])) },
        w: { dtype: "<u4", shape: [1], bytes: bytesOf(new Uint32Array([70000])) },
        s: { dtype: "<u2", shape: [2], bytes: bytesOf(new Uint16Array([1, 65535])) },
        n: { dtype: "<i4", shape: [1], bytes: bytesOf(new Int32Array([-1])) },
        e: { dtype: "<u2", shape: [0], bytes: new Uint8Array(0) },
      },
    );
    const pack = decodePack<{ kind: string; names: string[] }>(buffer);
    expect(pack.meta).toEqual({ kind: "x", names: ["é"] });
    expect(pack.arrays.f!.data).toBeInstanceOf(Float32Array);
    expect([...pack.arrays.f!.data]).toEqual([1, 2, 3, 4, 5, 6]);
    expect(pack.arrays.f!.shape).toEqual([2, 3]);
    expect([...pack.arrays.b!.data]).toEqual([7, 8, 9]);
    expect([...pack.arrays.i!.data]).toEqual([-127, 127]);
    expect([...pack.arrays.w!.data]).toEqual([70000]);
    expect([...pack.arrays.s!.data]).toEqual([1, 65535]);
    expect([...pack.arrays.n!.data]).toEqual([-1]);
    expect(pack.arrays.e!.data.length).toBe(0);
    // zero-copy: views into the original buffer
    expect(pack.arrays.f!.data.buffer).toBe(buffer);
    expect(pack.arrays.f!.data.byteOffset % 16).toBe(0);
  });

  it("rejects other data", () => {
    expect(() => decodePack(new ArrayBuffer(4))).toThrow(/too short/);
    expect(() => decodePack(new Uint8Array(32).buffer)).toThrow(/not a T3DP/);
    const wrongVersion = new Uint8Array(encodePack({}, {}));
    wrongVersion[4] = 9;
    expect(() => decodePack(wrongVersion.buffer)).toThrow(/version=9/);
  });

  it("decodes arrays stored through a codec piece by piece", () => {
    // A stand-in for the meshopt decoder: the "encoded" bytes are the data itself.
    const calls: string[] = [];
    const copy = (kind: string) => (target: Uint8Array, count: number, size: number, source: Uint8Array) => {
      calls.push(`${kind} ${count}x${size}`);
      target.set(source);
    };
    const decoder = { decodeVertexBuffer: copy("vertex"), decodeIndexBuffer: copy("index") };
    const rows = new Uint16Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    const indices = new Uint32Array([0, 1, 2, 2, 1, 3, 70000, 1, 2]);
    const buffer = encodePack(
      {},
      {
        v: { dtype: "<u2", shape: [3, 4], bytes: bytesOf(rows), codec: "meshopt-vertex", segments: [[2, 16], [1, 8]] },
        i: { dtype: "<u4", shape: [9], bytes: bytesOf(indices), codec: "meshopt-index", segments: [[6, 24], [3, 12]] },
        none: { dtype: "<u2", shape: [0], bytes: new Uint8Array(0), codec: "meshopt-index", segments: [] },
        raw: { dtype: "|u1", shape: [2], bytes: new Uint8Array([7, 8]) },
      },
      2,
    );
    const pack = decodePack(buffer, decoder);
    expect(pack.arrays.v!.data).toBeInstanceOf(Uint16Array);
    expect([...pack.arrays.v!.data]).toEqual([...rows]);
    expect([...pack.arrays.i!.data]).toEqual([...indices]);
    expect(pack.arrays.none!.data.length).toBe(0);
    expect([...pack.arrays.raw!.data]).toEqual([7, 8]);
    expect(calls).toEqual(["index 6x4", "index 3x4", "vertex 2x8", "vertex 1x8"]);
    expect(pack.arrays.v!.data.buffer).not.toBe(buffer);

    expect(() => decodePack(buffer)).toThrow(/decoder is needed/);
    const short = encodePack({}, { v: { dtype: "<u2", shape: [3, 4], bytes: bytesOf(rows), codec: "meshopt-vertex", segments: [[2, 16]] } }, 2);
    expect(() => decodePack(short, decoder)).toThrow(/do not add up/);
    const long = encodePack({}, { v: { dtype: "<u2", shape: [1, 4], bytes: bytesOf(rows), codec: "meshopt-vertex", segments: [[2, 16]] } }, 2);
    expect(() => decodePack(long, decoder)).toThrow(/past the end/);
    const unknown = encodePack({}, { v: { dtype: "<u2", shape: [1, 4], bytes: bytesOf(rows), codec: "zip", segments: [[1, 8]] } }, 2);
    expect(() => decodePack(unknown, decoder)).toThrow(/unknown codec/);
  });

  it("rejects big-endian, unknown and truncated arrays", () => {
    const one = (dtype: string) => encodePack({}, { a: { dtype, shape: [1], bytes: new Uint8Array(8) } });
    expect(() => decodePack(one(">f4"))).toThrow(/unsupported/);
    expect(() => decodePack(one("<c8"))).toThrow(/unsupported/);
    const truncated = encodePack({}, { a: { dtype: "<f8", shape: [4], bytes: new Uint8Array(8) } });
    expect(() => decodePack(truncated)).toThrow(/past the end/);
  });
});
