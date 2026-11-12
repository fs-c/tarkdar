import { decodePack } from "./container";
import { bytesOf, encodePack } from "./container.test";
import { srgbBytesToLinear } from "./color";
import { CHUNK_ARRAYS, CHUNK_BASE64, CHUNK_GROUND } from "./chunk.fixture";
import { MapData, decodeChunk, expandChunk, worldBox, type ChunkMeta, type DatasetIndex } from "./dataset";
import { groupRuns } from "./instances";
import { COLOR_SCHEMES, DEFAULT_MAP_SETTINGS, PLAN_PALETTES, paletteOf, schemeOf } from "./settings";

const CATEGORIES = ["structure", "terrain", "foliage", "water", "glass", "shadow", "decal", "background"];

// Two meshes: "wall" (2 parts: structure + decal) and "pine01" (1 part).
// Instances: wall @ x=10 (scene 0), wall scaled x2 @ x=100 (scene 1), pine @ z=-50 (scene 1).
function fixture(ground = false): MapData {
  const u32 = (v: number[], shape = [v.length]) => ({ dtype: "<u4", shape, bytes: bytesOf(new Uint32Array(v)) });
  const identityAt = (x: number, y: number, z: number, s = 1) => [s, 0, 0, 0, s, 0, 0, 0, s, x, y, z];
  const buffer = encodePack(
    { kind: "instanced", meshNames: ["wall", "pine01"], ...(ground && { ground: { origin: [-8, 4], cell: 1 } }) } satisfies ChunkMeta,
    {
      ...(ground && {
        ground_height: { dtype: "<f4", shape: [2, 3], bytes: bytesOf(new Float32Array([0, 1, 2, 3, 4, 5])) },
        ground_building: { dtype: "|u1", shape: [2, 3], bytes: new Uint8Array([0, 255, 0, 0, 0, 255]) },
      }),
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
    format: 3,
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

describe("plan palettes", () => {
  it("names a pre-made palette and nothing else", () => {
    expect(paletteOf(DEFAULT_MAP_SETTINGS.palette)).toBe("paper");
    expect(paletteOf({ ...PLAN_PALETTES.night })).toBe("night");
    expect(paletteOf({ ...PLAN_PALETTES.night, water: "#123456" })).toBeNull();
  });

  it("has every colour as #rrggbb", () => {
    for (const palette of Object.values(PLAN_PALETTES)) {
      expect(Object.keys(palette)).toEqual(Object.keys(PLAN_PALETTES.paper));
      for (const colour of Object.values(palette)) expect(colour).toMatch(/^#[0-9a-f]{6}$/);
    }
  });
});

describe("ground map", () => {
  it("is optional", () => {
    expect(fixture().ground).toBeNull();
  });

  it("is a grid of rows along x", () => {
    const ground = fixture(true).ground!;
    expect([ground.columns, ground.rows, ground.cell, ...ground.origin]).toEqual([3, 2, 1, -8, 4]);
    expect(ground.heights[1 * ground.columns + 2]).toBe(5);
    expect(ground.building[1]).toBe(255);
  });
});

describe("a chunk file", () => {
  const file = Uint8Array.from(atob(CHUNK_BASE64), (c) => c.charCodeAt(0)).buffer;

  it("decodes to what the pipeline reads back from it", async () => {
    const pack = await decodeChunk(file);
    for (const [name, expected] of Object.entries(CHUNK_ARRAYS)) {
      expect([...pack.arrays[name]!.data], name).toEqual(expected);
    }
    expect(pack.arrays.positions!.data).toBeInstanceOf(Float32Array);
    expect(pack.arrays.positions!.shape).toEqual([11, 3]);
    expect(pack.arrays.normals!.shape).toEqual([11, 3]);
    expect(pack.meta.ground).toEqual(CHUNK_GROUND);
  });

  it("makes a MapData", async () => {
    const data = new MapData({ format: 3, categories: CATEGORIES } as unknown as DatasetIndex, await decodeChunk(file));
    expect(data.meshNames).toEqual(["cell_0_0_structure", "Terrain_slice"]);
    expect([data.ground!.rows, data.ground!.columns]).toEqual([2, 3]);
    expect(data.ground!.heights[3]).toBe(70);
    expect([...data.instBox.subarray(6, 12)]).toEqual([-5, 2, -1, 11, 6, 7]);
  });

  it("is also read when it is not gzipped", async () => {
    const plain = await new Response(new Blob([file]).stream().pipeThrough(new DecompressionStream("gzip"))).arrayBuffer();
    expect([...(await decodeChunk(plain)).arrays.indices16!.data]).toEqual(CHUNK_ARRAYS.indices16);
  });
});

describe("expandChunk", () => {
  const u32 = (v: number[]) => ({ data: new Uint32Array(v), shape: [v.length] });
  const pack = (flags: number[]) => ({
    meta: { kind: "instanced", meshNames: ["a", "b"], ground: { origin: [0, 0] as [number, number], cell: 1, heightBase: -10, heightStep: 0.5 } },
    arrays: {
      mesh_vertex_start: u32([0, 1]),
      mesh_vertex_count: u32([1, 2]),
      mesh_bounds: { data: new Float32Array([0, 0, 0, 0, 0, 0, 10, -4, 100, 20, 4, 100]), shape: [2, 6] },
      mesh_flags: { data: new Uint8Array(flags), shape: [2] },
      positions: { data: new Uint16Array([7, 7, 7, 0, 0, 0, 0, 0, 65535, 65535, 9, 0]), shape: [3, 4] },
      normals: { data: new Int8Array([1, 2, 3, 0, 4, 5, 6, 0, -7, -8, -9, 0]), shape: [3, 4] },
      ground_height: { data: new Uint16Array([20, 1, 65535, 0, 3, 65533]), shape: [2, 3] },
    },
  });

  it("places positions within their mesh's bounds", () => {
    const out = expandChunk(pack([0, 0]));
    // a mesh without extent: all at its one point; the other from corner to corner (flat in z)
    expect([...out.arrays.positions!.data]).toEqual([0, 0, 0, 10, -4, 100, 20, 4, 100]);
    expect(out.arrays.positions!.shape).toEqual([3, 3]);
  });

  it("drops the padding of normals, and the normals of flat shaded meshes", () => {
    expect([...expandChunk(pack([0, 0])).arrays.normals!.data]).toEqual([1, 2, 3, 4, 5, 6, -7, -8, -9]);
    expect([...expandChunk(pack([1, 0])).arrays.normals!.data]).toEqual([0, 0, 0, 4, 5, 6, -7, -8, -9]);
  });

  it("adds up ground heights along each row", () => {
    const heights = expandChunk(pack([0, 0])).arrays.ground_height!;
    expect(heights.data).toBeInstanceOf(Float32Array);
    expect([...heights.data]).toEqual([0, 0.5, 0, -10, -8.5, -10]); // 20, 21, 20 and 0, 3, 0 steps
  });
});

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

  it("names the scheme a grade equals", () => {
    expect(schemeOf(DEFAULT_MAP_SETTINGS)).toBe("standard");
    expect(schemeOf({ ...COLOR_SCHEMES.muted })).toBe("muted");
    expect(schemeOf({ ...COLOR_SCHEMES.standard, lift: 0.37 })).toBeNull();
  });
});
