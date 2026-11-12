import { decodePack } from "./container";
import { bytesOf, encodePack } from "./container.test";
import { desaturate, GAIN, LIFT, liftColor, srgbBytesToLinear } from "./color";
import { MapData, worldBox, type ChunkMeta, type DatasetIndex } from "./dataset";
import { groupRuns } from "./instances";

const CATEGORIES = ["structure", "terrain", "foliage", "water", "glass", "shadow", "decal", "background"];

// Two meshes: "wall" (2 parts: structure + decal) and "pine01" (1 part).
// Instances: wall @ x=10 (scene 0), wall scaled x2 @ x=100 (scene 1), pine @ z=-50 (scene 1).
function fixture(): MapData {
  const u32 = (v: number[], shape = [v.length]) => ({ dtype: "<u4", shape, bytes: bytesOf(new Uint32Array(v)) });
  const identityAt = (x: number, y: number, z: number, s = 1) => [s, 0, 0, 0, s, 0, 0, 0, s, x, y, z];
  const buffer = encodePack(
    { kind: "instanced", meshNames: ["wall", "pine01"] } satisfies ChunkMeta,
    {
      mesh_vertex_start: u32([0, 4]),
      mesh_vertex_count: u32([4, 3]),
      mesh_index_start: u32([0, 6]),
      mesh_index_count: u32([6, 3]),
      mesh_index_wide: { dtype: "|u1", shape: [2], bytes: new Uint8Array([0, 0]) },
      mesh_part_start: u32([0, 2]),
      mesh_part_count: u32([2, 1]),
      mesh_bounds: { dtype: "<f4", shape: [2, 6], bytes: bytesOf(new Float32Array([0, 0, 0, 2, 3, 0, -1, 0, -1, 1, 8, 1])) },
      part_range: u32([0, 3, 3, 3, 0, 3], [3, 2]),
      positions: { dtype: "<f4", shape: [7, 3], bytes: bytesOf(new Float32Array(21)) },
      normals: { dtype: "|i1", shape: [7, 3], bytes: bytesOf(new Int8Array(21)) },
      indices16: { dtype: "<u2", shape: [9], bytes: bytesOf(new Uint16Array([0, 2, 1, 0, 3, 2, 0, 1, 2])) },
      indices32: { dtype: "<u4", shape: [0], bytes: new Uint8Array(0) },
      inst_mesh: u32([0, 0, 1]),
      inst_scene: { dtype: "<u2", shape: [3], bytes: bytesOf(new Uint16Array([0, 1, 1])) },
      inst_path: { dtype: "<i4", shape: [3], bytes: bytesOf(new Int32Array([0, 1, -1])) },
      inst_slot_start: u32([0, 2, 4]),
      inst_matrix: {
        dtype: "<f4",
        shape: [3, 12],
        bytes: bytesOf(new Float32Array([...identityAt(10, 0, 0), ...identityAt(100, 0, 0, 2), ...identityAt(0, 0, -50)])),
      },
      slot_category: { dtype: "|u1", shape: [5], bytes: new Uint8Array([0, 6, 0, 6, 2]) },
      slot_flags: { dtype: "|u1", shape: [5], bytes: new Uint8Array([0, 0, 0, 0, 1]) },
      slot_color: { dtype: "|u1", shape: [5, 4], bytes: new Uint8Array(20) },
      slot_material: { dtype: "<i4", shape: [5], bytes: bytesOf(new Int32Array([0, 1, 0, 1, -1])) },
    },
  );
  const index = {
    format: 2,
    map: "test",
    categories: CATEGORIES,
    scenes: [
      { level: "level1", path: "Assets/Content/Locations/Custom/custom_Garage.unity" },
      { level: "level2", path: "Assets/Content/Locations/City/City_Areas/NE_01/NE_01_A.unity" },
    ],
    materials: [
      { name: "brick", shader: "p0/Reflective/Bumped Specular", queue: -1 },
      { name: "stain", shader: "Decal/Ultra Deferred Decal Of God 3000", queue: 2005 },
    ],
  } as unknown as DatasetIndex;
  return new MapData(index, decodePack<ChunkMeta>(buffer));
}

describe("worldBox", () => {
  it("transforms a box by a column-major 3x4 matrix", () => {
    const out = new Float32Array(6);
    // rotate 90 degrees about Y (x -> -z, z -> x), then translate by (10, 0, 0)
    worldBox([0, 0, 0, 2, 3, 1], 0, [0, 0, -1, 0, 1, 0, 1, 0, 0, 10, 0, 0], 0, out, 0);
    expect([...out]).toEqual([10, 0, -2, 11, 3, 0]);
  });
});

describe("MapData", () => {
  const data = fixture();

  it("derives slots and world boxes", () => {
    expect(data.instanceCount).toBe(3);
    expect(data.slotCount).toBe(5);
    expect([...data.slotInstance]).toEqual([0, 0, 1, 1, 2]);
    expect([...data.slotPart]).toEqual([0, 1, 0, 1, 2]);
    expect([...data.partMesh]).toEqual([0, 0, 1]);
    expect([...data.instBox.subarray(0, 6)]).toEqual([10, 0, 0, 12, 3, 0]);
    expect([...data.instBox.subarray(6, 12)]).toEqual([100, 0, 0, 104, 6, 0]);
    const m = new Array<number>(16);
    data.matrix16(1, m);
    expect(m).toEqual([2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 2, 0, 100, 0, 0, 1]);
  });

  it("selects slots by category", () => {
    expect([...data.slotsOf(null)]).toEqual([0, 1, 2, 3, 4]);
    expect([...data.slotsOf(new Set([data.categoryId("structure"), data.categoryId("foliage")]))]).toEqual([0, 2, 4]);
    expect([...data.slotsOf(new Set([data.categoryId("decal")]))]).toEqual([1, 3]);
    expect(data.categoryId("nope")).toBe(-1);
  });

  it("rejects other chunk kinds", () => {
    expect(() => new MapData(data.index, { meta: { kind: "merged" } as ChunkMeta, arrays: {} })).toThrow(/unsupported chunk/);
  });
});

describe("groupRuns", () => {
  const data = fixture();
  const all = new Uint32Array([0, 1, 2, 3, 4]);
  const shape = (slots: Uint32Array, split = false) =>
    groupRuns(data, slots, split).map((r) => [r.firstPart, r.lastPart, data.index.categories[r.category], r.slots]);

  it("draws each (part, category) once, instanced", () => {
    expect(shape(all)).toEqual([
      [0, 0, "structure", [0, 2]],
      [1, 1, "decal", [1, 3]],
      [2, 2, "foliage", [4]],
    ]);
  });

  it("merges adjacent parts of an instance that share a category", () => {
    data.slotCategory[1] = 0; // first wall: both parts structure
    try {
      expect(shape(all)).toEqual([
        [0, 1, "structure", [0]],
        [0, 0, "structure", [2]],
        [1, 1, "decal", [3]],
        [2, 2, "foliage", [4]],
      ]);
      // per-slot colours need every part drawn on its own
      expect(shape(all, true)).toEqual([
        [0, 0, "structure", [0, 2]],
        [1, 1, "structure", [1]],
        [1, 1, "decal", [3]],
        [2, 2, "foliage", [4]],
      ]);
      // a hidden part in between breaks the run
      data.slotCategory[3] = 0;
      expect(shape(new Uint32Array([0, 1, 2, 4]))).toEqual([
        [0, 1, "structure", [0]],
        [0, 0, "structure", [2]],
        [2, 2, "foliage", [4]],
      ]);
    } finally {
      data.slotCategory[1] = 6;
      data.slotCategory[3] = 6;
    }
  });
});

describe("colour", () => {
  it("converts sRGB to linear and keeps alpha", () => {
    expect([...srgbBytesToLinear(new Uint8Array([0, 255, 128, 77, 188, 10, 64, 255]))]).toEqual([0, 255, 55, 77, 128, 1, 13, 255]);
  });

  const luma = ([r = 0, g = 0, b = 0]: number[]) => (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;

  it("lifts luma into a lighter, narrower range and keeps the hue", () => {
    for (const input of [[40, 40, 40], [128, 128, 128], [230, 230, 230], [120, 60, 30]]) {
      const c = [...input];
      liftColor(c);
      expect(luma(c)).toBeCloseTo(LIFT + GAIN * luma(input), 1);
    }
    const brick = [120, 60, 30];
    liftColor(brick);
    const [r = 0, g = 0, b = 0] = brick;
    expect(r).toBeGreaterThan(g);
    expect(g).toBeGreaterThan(b);
    expect(g / r).toBeCloseTo(0.5, 1);
  });

  it("turns near-black into grey rather than amplifying noise", () => {
    const c = [3, 0, 0];
    liftColor(c);
    expect(Math.max(...c) - Math.min(...c)).toBeLessThan(12);
    expect(luma(c)).toBeCloseTo(LIFT, 1);
  });

  it("desaturates towards the colour's own grey", () => {
    const c = [200, 100, 0];
    desaturate(c, 0.5);
    expect(c).toEqual([157, 107, 57]);
    const grey = [80, 80, 80];
    desaturate(grey, 1);
    expect(grey).toEqual([80, 80, 80]);
  });

  it("optionally lifts while converting", () => {
    const lifted = srgbBytesToLinear(new Uint8Array([40, 40, 40, 255]), true);
    expect(lifted[0]).toBeGreaterThan(srgbBytesToLinear(new Uint8Array([40, 40, 40, 255]))[0]!);
  });
});
