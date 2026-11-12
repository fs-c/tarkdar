// 3D map dataset, format 2 (tools/maps3d/t3d/dataset.py): index.json + a binary chunk.
// MapData wraps the "instanced" chunk and derives what rendering needs per instance and per slot.
// A slot is one (instance, part) pair, i.e. one material slot of one placed mesh: the unit that
// has a category and gets drawn. In an overview dataset the "meshes" are merged map cells, each
// placed once.

import { decodePack, type NumericArray, type Pack } from "./container";

export interface Bounds {
  min: [number, number, number];
  max: [number, number, number];
}

export interface ChunkRef {
  file: string;
  kind: string;
  byteLength: number;
}

export interface DatasetIndex {
  format: number;
  map: string;
  label: string;
  profile: string;
  /** Profile-specific build parameters. */
  build?: { cells?: { size: number; error: number; hiddenSurfaceRemoval: boolean } };
  categories: string[];
  bounds: Bounds;
  /** The playable area: what the camera frames. */
  focusBounds: Bounds;
  stats: { meshCount: number; instanceCount: number; uniqueTriangles: number; instancedTriangles: number };
  chunks: ChunkRef[];
}

export interface MeshTexture {
  file: string;
  /** Local XZ rectangle [x0, z0, size x, size z]: u = (x - x0) / size x, v = (z - z0) / size z. */
  rect: [number, number, number, number];
}

export interface ChunkMeta {
  kind: string;
  meshNames: string[];
  /** Colour images draped over meshes (terrain), by mesh index. */
  meshTextures?: Record<string, MeshTexture>;
}

export const DATASET_FORMAT = 2;
/** mesh_flags bit: shade per face; the mesh has no usable normals. */
export const MESH_FLAT = 1;

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
    let lo = matrix[matrixOffset + 9 + axis]!;
    let hi = lo;
    for (let col = 0; col < 3; col++) {
      const m = matrix[matrixOffset + col * 3 + axis]!;
      const a = m * bounds[boundsOffset + col]!;
      const b = m * bounds[boundsOffset + 3 + col]!;
      lo += Math.min(a, b);
      hi += Math.max(a, b);
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
  readonly meshIndexWide: Uint8Array;
  readonly meshPartStart: Uint32Array;
  readonly meshPartCount: Uint32Array;
  readonly meshBounds: Float32Array;
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
  readonly instSlotStart: Uint32Array;
  /** Column-major 3x4 world matrix, 12 floats per instance. */
  readonly instMatrix: Float32Array;
  /** World AABB (min xyz, max xyz), 6 floats per instance. */
  readonly instBox: Float32Array;

  readonly slotCount: number;
  readonly slotCategory: Uint8Array;
  /** sRGB bytes; alpha 0 = no colour known. */
  readonly slotColor: Uint8Array;
  readonly slotInstance: Uint32Array;
  /** Global part index (into partRange / partMesh). */
  readonly slotPart: Uint32Array;

  constructor(
    readonly index: DatasetIndex,
    pack: Pack<ChunkMeta>,
  ) {
    if (pack.meta.kind !== "instanced") throw new Error(`unsupported chunk kind "${pack.meta.kind}"`);
    this.meshNames = pack.meta.meshNames;
    this.meshTextures = new Map(Object.entries(pack.meta.meshTextures ?? {}).map(([mesh, t]) => [Number(mesh), t]));
    this.meshCount = this.meshNames.length;
    this.meshVertexStart = typed(pack, "mesh_vertex_start", Uint32Array);
    this.meshVertexCount = typed(pack, "mesh_vertex_count", Uint32Array);
    this.meshIndexStart = typed(pack, "mesh_index_start", Uint32Array);
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
    this.instSlotStart = typed(pack, "inst_slot_start", Uint32Array);
    this.instMatrix = typed(pack, "inst_matrix", Float32Array);
    this.slotCategory = typed(pack, "slot_category", Uint8Array);
    this.slotColor = typed(pack, "slot_color", Uint8Array);

    this.partMesh = new Uint32Array(this.partRange.length / 2);
    for (let mesh = 0; mesh < this.meshCount; mesh++) {
      const start = this.meshPartStart[mesh]!;
      for (let k = 0; k < this.meshPartCount[mesh]!; k++) this.partMesh[start + k] = mesh;
    }

    const n = (this.instanceCount = this.instMesh.length);
    this.slotCount = this.slotCategory.length;
    this.slotInstance = new Uint32Array(this.slotCount);
    this.slotPart = new Uint32Array(this.slotCount);
    this.instBox = new Float32Array(n * 6);
    for (let i = 0; i < n; i++) {
      const mesh = this.instMesh[i]!;
      const slot0 = this.instSlotStart[i]!;
      const part0 = this.meshPartStart[mesh]!;
      for (let k = 0; k < this.meshPartCount[mesh]!; k++) {
        this.slotInstance[slot0 + k] = i;
        this.slotPart[slot0 + k] = part0 + k;
      }
      worldBox(this.meshBounds, mesh * 6, this.instMatrix, i * 12, this.instBox, i * 6);
    }
  }

  categoryId(name: string): number {
    return this.index.categories.indexOf(name);
  }

  /** Column-major 4x4 (three.js Matrix4.elements layout). */
  matrix16(instance: number, out: number[] | Float32Array): void {
    const m = this.instMatrix;
    const o = instance * 12;
    for (let col = 0; col < 4; col++) {
      out[col * 4] = m[o + col * 3]!;
      out[col * 4 + 1] = m[o + col * 3 + 1]!;
      out[col * 4 + 2] = m[o + col * 3 + 2]!;
      out[col * 4 + 3] = col === 3 ? 1 : 0;
    }
  }

  /**
   * Slots to draw: those of the given categories (ids), in instance order. `null` = all.
   */
  slotsOf(categories: Set<number> | null): Uint32Array {
    if (!categories) return Uint32Array.from({ length: this.slotCount }, (_, s) => s);
    const out = new Uint32Array(this.slotCount);
    let count = 0;
    for (let s = 0; s < this.slotCount; s++) if (categories.has(this.slotCategory[s]!)) out[count++] = s;
    return out.subarray(0, count);
  }
}

async function fetchChecked(url: string, signal?: AbortSignal): Promise<Response> {
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} — ${url}`);
  return res;
}

async function fetchBinary(url: string, onProgress?: (received: number) => void, signal?: AbortSignal): Promise<ArrayBuffer> {
  const res = await fetchChecked(url, signal);
  if (!res.body) return res.arrayBuffer();
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.byteLength;
    onProgress?.(received);
  }
  const out = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out.buffer;
}

/** Loads a dataset folder. `onProgress` gets the fraction of the geometry downloaded (0..1). */
export async function loadMapData(base: string, onProgress?: (fraction: number) => void, signal?: AbortSignal): Promise<MapData> {
  const index = (await (await fetchChecked(`${base}/index.json`, signal)).json()) as DatasetIndex;
  if (index.format !== DATASET_FORMAT) throw new Error(`dataset format ${index.format}, expected ${DATASET_FORMAT}: rebuild it`);
  const chunk = index.chunks.find((c) => c.kind === "instanced");
  if (!chunk) throw new Error("dataset has no instanced chunk");
  const buffer = await fetchBinary(`${base}/${chunk.file}`, (received) => onProgress?.(Math.min(1, received / chunk.byteLength)), signal);
  return new MapData(index, decodePack<ChunkMeta>(buffer));
}
