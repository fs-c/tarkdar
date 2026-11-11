import { decodePack } from "./container";

/** Mirror of extract/t3d/pack.py `encode` (no compression). */
export function encodePack(meta: unknown, arrays: Record<string, { dtype: string; shape: number[]; bytes: Uint8Array }>): ArrayBuffer {
  const descr: Record<string, { offset: number; dtype: string; shape: number[] }> = {};
  const blobs: { offset: number; bytes: Uint8Array }[] = [];
  let offset = 0;
  for (const name of Object.keys(arrays).sort()) {
    offset += (16 - (offset % 16)) % 16;
    descr[name] = { offset, dtype: arrays[name].dtype, shape: arrays[name].shape };
    blobs.push({ offset, bytes: arrays[name].bytes });
    offset += arrays[name].bytes.byteLength;
  }
  const header = new TextEncoder().encode(JSON.stringify({ meta, arrays: descr }));
  let base = 12 + header.byteLength;
  base += (16 - (base % 16)) % 16;
  const out = new Uint8Array(base + offset);
  out.set(new TextEncoder().encode("T3DP"), 0);
  const view = new DataView(out.buffer);
  view.setUint32(4, 1, true);
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
    expect(pack.arrays.f.data).toBeInstanceOf(Float32Array);
    expect([...pack.arrays.f.data]).toEqual([1, 2, 3, 4, 5, 6]);
    expect(pack.arrays.f.shape).toEqual([2, 3]);
    expect([...pack.arrays.b.data]).toEqual([7, 8, 9]);
    expect([...pack.arrays.i.data]).toEqual([-127, 127]);
    expect([...pack.arrays.w.data]).toEqual([70000]);
    expect([...pack.arrays.s.data]).toEqual([1, 65535]);
    expect([...pack.arrays.n.data]).toEqual([-1]);
    expect(pack.arrays.e.data.length).toBe(0);
    // zero-copy: views into the original buffer
    expect(pack.arrays.f.data.buffer).toBe(buffer);
    expect(pack.arrays.f.data.byteOffset % 16).toBe(0);
  });

  it("rejects other data", () => {
    expect(() => decodePack(new ArrayBuffer(4))).toThrow(/too short/);
    expect(() => decodePack(new Uint8Array(32).buffer)).toThrow(/not a T3DP/);
    const wrongVersion = new Uint8Array(encodePack({}, {}));
    wrongVersion[4] = 9;
    expect(() => decodePack(wrongVersion.buffer)).toThrow(/version=9/);
  });

  it("rejects big-endian, unknown and truncated arrays", () => {
    const one = (dtype: string) => encodePack({}, { a: { dtype, shape: [1], bytes: new Uint8Array(8) } });
    expect(() => decodePack(one(">f4"))).toThrow(/unsupported/);
    expect(() => decodePack(one("<c8"))).toThrow(/unsupported/);
    const truncated = encodePack({}, { a: { dtype: "<f8", shape: [4], bytes: new Uint8Array(8) } });
    expect(() => decodePack(truncated)).toThrow(/past the end/);
  });
});
