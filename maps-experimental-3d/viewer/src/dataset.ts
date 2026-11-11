// Dataset format 2 (see extract/t3d/dataset.py): index.json + binary chunks.
// MapData wraps the single "instanced" chunk and derives what the viewer
// needs per instance and per slot. A slot is one (instance, part) pair, i.e.
// one material slot of one placed renderer: the unit that has a category and
// that gets drawn, filtered and picked.

import { decodePack, type NumericArray, type Pack } from "./container";

export interface Bounds {
  min: [number, number, number];
  max: [number, number, number];
}

export interface ChunkRef {
  file: string;
  kind: string;
  level: number;
  error: number;
  cell: string | null;
  bounds: Bounds;
  byteLength: number;
}

export interface MaterialInfo {
  name: string | null;
  shader: string | null;
  queue: number | null;
}

export interface DatasetIndex {
  format: number;
  map: string;
  label: string;
  tag: string;
  source: string;
  profile: string;
  /** Profile-specific build parameters. */
  build?: { cells?: { size: number; error: number; hiddenSurfaceRemoval: boolean } };
  categories: string[];
  flags: { cutout: number; transparent: number };
  scenes: { level: string; path: string }[];
  materials: MaterialInfo[];
  bounds: Bounds;
  focusBounds: Bounds;
  stats: {
    sceneCount: number;
    meshCount: number;
    instanceCount: number;
    sourceInstances: number;
    uniqueVertices: number;
    uniqueTriangles: number;
    instancedTriangles: number;
    categories: Record<string, { slots: number; triangles: number }>;
  };
  chunks: ChunkRef[];
  sources: string;
}

export interface ChunkMeta {
  kind: string;
  level: number;
  error: number;
  cell: string | null;
  meshNames: string[];
  /** Colour images draped over meshes (terrain), by mesh index. */
  meshTextures?: Record<string, MeshTexture>;
}

export interface MeshTexture {
  file: string;
  /** Local XZ rectangle [x0, z0, size x, size z]: u = (x - x0) / size x, v = (z - z0) / size z. */
  rect: [number, number, number, number];
}

export const DATASET_FORMAT = 2;
export const MESH_FLAT = 1;

/** "City_Areas/<area>/..." -> area, otherwise the scene file name. */
export function sceneGroupName(path: string): string {
  const cityArea = path.match(/City_Areas\/([^/]+)/i);
  if (cityArea) return cityArea[1];
  const base = path.split("/").pop() || path;
  return base.replace(/\.unity$/i, "");
}

/** World AABB of a local box (min xyz, max xyz) under a column-major 3x4 matrix. */
export function worldBox(
  bounds: ArrayLike<number>,
  boundsOffset: number,
  matrix: ArrayLike<number>,
  matrixOffset: number,
  out: Float32Array | number[],
  outOffset: number,
): void {
  for (let axis = 0; axis < 3; axis++) {
    let lo = matrix[matrixOffset + 9 + axis];
    let hi = lo;
    for (let col = 0; col < 3; col++) {
      const m = matrix[matrixOffset + col * 3 + axis];
      const a = m * bounds[boundsOffset + col];
      const b = m * bounds[boundsOffset + 3 + col];
      if (a < b) {
        lo += a;
        hi += b;
      } else {
        lo += b;
        hi += a;
      }
    }
    out[outOffset + axis] = lo;
    out[outOffset + 3 + axis] = hi;
  }
}

function typed<T extends NumericArray>(pack: Pack, name: string, ctor: { new (...args: never[]): T }): T {
  const entry = pack.arrays[name];
  if (!entry) throw new Error(`chunk has no array "${name}"`);
  if (!(entry.data instanceof ctor)) throw new Error(`chunk array "${name}" has an unexpected type`);
  return entry.data as T;
}

export class MapData {
  readonly meshNames: string[];
  readonly meshTextures: Map<number, MeshTexture>;
  readonly meshCount: number;
  readonly meshVertexStart: Uint32Array;
  readonly meshVertexCount: Uint32Array;
  readonly meshIndexStart: Uint32Array;
  readonly meshIndexCount: Uint32Array;
  readonly meshIndexWide: Uint8Array;
  readonly meshPartStart: Uint32Array;
  readonly meshPartCount: Uint32Array;
  readonly meshBounds: Float32Array;
  /** Bit 1 (MESH_FLAT): shade per face; the mesh has no usable normals. */
  readonly meshFlags: Uint8Array;
  /** [first index, index count] per part, relative to the mesh's indices. */
  readonly partRange: Uint32Array;
  readonly partMesh: Uint32Array;
  readonly positions: Float32Array;
  readonly normals: Int8Array;
  readonly indices16: Uint16Array;
  readonly indices32: Uint32Array;
  /** Optional baked vertex colours: sRGB bytes, 4 per vertex. */
  readonly colors: Uint8Array | null;

  readonly instanceCount: number;
  readonly instMesh: Uint32Array;
  readonly instScene: Uint16Array;
  readonly instPath: Int32Array;
  readonly instSlotStart: Uint32Array;
  /** Column-major 3x4 world matrix, 12 floats per instance. */
  readonly instMatrix: Float32Array;
  /** World AABB (min xyz, max xyz), 6 floats per instance. */
  readonly instBox: Float32Array;
  /** Largest world AABB extent in metres. */
  readonly instSize: Float32Array;
  /** Index into sceneGroups. */
  readonly instGroup: Uint16Array;
  readonly sceneGroups: string[];

  readonly slotCount: number;
  readonly slotCategory: Uint8Array;
  readonly slotFlags: Uint8Array;
  /** sRGB bytes; alpha 0 = no colour known. */
  readonly slotColor: Uint8Array;
  readonly slotMaterial: Int32Array;
  readonly slotInstance: Uint32Array;
  /** Global part index (into partRange / partMesh). */
  readonly slotPart: Uint32Array;

  constructor(
    readonly index: DatasetIndex,
    pack: Pack<ChunkMeta>,
  ) {
    if (pack.meta.kind !== "instanced") throw new Error(`unsupported chunk kind "${pack.meta.kind}"`);
    this.meshNames = pack.meta.meshNames;
    this.meshCount = this.meshNames.length;
    this.meshTextures = new Map(Object.entries(pack.meta.meshTextures ?? {}).map(([mesh, t]) => [Number(mesh), t]));
    this.meshVertexStart = typed(pack, "mesh_vertex_start", Uint32Array);
    this.meshVertexCount = typed(pack, "mesh_vertex_count", Uint32Array);
    this.meshIndexStart = typed(pack, "mesh_index_start", Uint32Array);
    this.meshIndexCount = typed(pack, "mesh_index_count", Uint32Array);
    this.meshIndexWide = typed(pack, "mesh_index_wide", Uint8Array);
    this.meshPartStart = typed(pack, "mesh_part_start", Uint32Array);
    this.meshPartCount = typed(pack, "mesh_part_count", Uint32Array);
    this.meshBounds = typed(pack, "mesh_bounds", Float32Array);
    this.meshFlags = pack.arrays.mesh_flags ? typed(pack, "mesh_flags", Uint8Array) : new Uint8Array(this.meshCount);
    this.partRange = typed(pack, "part_range", Uint32Array);
    this.positions = typed(pack, "positions", Float32Array);
    this.normals = typed(pack, "normals", Int8Array);
    this.indices16 = typed(pack, "indices16", Uint16Array);
    this.indices32 = typed(pack, "indices32", Uint32Array);
    this.colors = pack.arrays.colors ? typed(pack, "colors", Uint8Array) : null;
    this.instMesh = typed(pack, "inst_mesh", Uint32Array);
    this.instScene = typed(pack, "inst_scene", Uint16Array);
    this.instPath = typed(pack, "inst_path", Int32Array);
    this.instSlotStart = typed(pack, "inst_slot_start", Uint32Array);
    this.instMatrix = typed(pack, "inst_matrix", Float32Array);
    this.slotCategory = typed(pack, "slot_category", Uint8Array);
    this.slotFlags = typed(pack, "slot_flags", Uint8Array);
    this.slotColor = typed(pack, "slot_color", Uint8Array);
    this.slotMaterial = typed(pack, "slot_material", Int32Array);

    const partCount = this.partRange.length / 2;
    this.partMesh = new Uint32Array(partCount);
    for (let mesh = 0; mesh < this.meshCount; mesh++) {
      const start = this.meshPartStart[mesh];
      for (let k = 0; k < this.meshPartCount[mesh]; k++) this.partMesh[start + k] = mesh;
    }

    const n = (this.instanceCount = this.instMesh.length);
    this.slotCount = this.slotCategory.length;
    this.slotInstance = new Uint32Array(this.slotCount);
    this.slotPart = new Uint32Array(this.slotCount);
    this.instBox = new Float32Array(n * 6);
    this.instSize = new Float32Array(n);
    this.instGroup = new Uint16Array(n);

    const groupOfScene = new Map<number, number>();
    this.sceneGroups = [];
    const groupIds = new Map<string, number>();
    for (let i = 0; i < n; i++) {
      const mesh = this.instMesh[i];
      const slot0 = this.instSlotStart[i];
      const part0 = this.meshPartStart[mesh];
      for (let k = 0; k < this.meshPartCount[mesh]; k++) {
        this.slotInstance[slot0 + k] = i;
        this.slotPart[slot0 + k] = part0 + k;
      }
      worldBox(this.meshBounds, mesh * 6, this.instMatrix, i * 12, this.instBox, i * 6);
      const b = i * 6;
      this.instSize[i] = Math.max(
        this.instBox[b + 3] - this.instBox[b],
        this.instBox[b + 4] - this.instBox[b + 1],
        this.instBox[b + 5] - this.instBox[b + 2],
      );
      const scene = this.instScene[i];
      let group = groupOfScene.get(scene);
      if (group === undefined) {
        const name = sceneGroupName(index.scenes[scene]?.path ?? `scene ${scene}`);
        group = groupIds.get(name);
        if (group === undefined) {
          group = this.sceneGroups.length;
          groupIds.set(name, group);
          this.sceneGroups.push(name);
        }
        groupOfScene.set(scene, group);
      }
      this.instGroup[i] = group;
    }
  }

  categoryId(name: string): number {
    return this.index.categories.indexOf(name);
  }

  slotTriangles(slot: number): number {
    return this.partRange[this.slotPart[slot] * 2 + 1] / 3;
  }

  /** Column-major 4x4 (three.js Matrix4.elements layout). */
  matrix16(instance: number, out: number[] | Float32Array): void {
    const m = this.instMatrix;
    const o = instance * 12;
    out[0] = m[o];
    out[1] = m[o + 1];
    out[2] = m[o + 2];
    out[3] = 0;
    out[4] = m[o + 3];
    out[5] = m[o + 4];
    out[6] = m[o + 5];
    out[7] = 0;
    out[8] = m[o + 6];
    out[9] = m[o + 7];
    out[10] = m[o + 8];
    out[11] = 0;
    out[12] = m[o + 9];
    out[13] = m[o + 10];
    out[14] = m[o + 11];
    out[15] = 1;
  }
}

async function fetchChecked(url: string): Promise<Response> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} — ${url}`);
  return res;
}

async function fetchBinary(url: string, onProgress?: (received: number, total: number) => void): Promise<ArrayBuffer> {
  const res = await fetchChecked(url);
  const total = Number(res.headers.get("content-length")) || 0;
  if (!res.body) return res.arrayBuffer();
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.byteLength;
    onProgress?.(received, total);
  }
  const out = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out.buffer;
}

export async function loadIndex(base: string): Promise<DatasetIndex> {
  const index = (await (await fetchChecked(`${base}/index.json`)).json()) as DatasetIndex;
  if (index.format !== DATASET_FORMAT) {
    throw new Error(`dataset format ${index.format}, expected ${DATASET_FORMAT}: rebuild with "make datasets"`);
  }
  return index;
}

export async function loadMapData(
  base: string,
  index: DatasetIndex,
  onProgress?: (received: number, total: number) => void,
): Promise<MapData> {
  const chunk = index.chunks.find((c) => c.kind === "instanced");
  if (!chunk) throw new Error("dataset has no instanced chunk");
  const buffer = await fetchBinary(`${base}/${chunk.file}`, (received, total) =>
    onProgress?.(received, total || chunk.byteLength),
  );
  return new MapData(index, decodePack<ChunkMeta>(buffer));
}

/** Hierarchy paths for the picker; fetched on first use. */
export async function loadSources(base: string, index: DatasetIndex): Promise<string[]> {
  const sources = (await (await fetchChecked(`${base}/${index.sources}`)).json()) as { paths: string[] };
  return sources.paths;
}
