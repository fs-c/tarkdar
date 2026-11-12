// Draws a set of slots as InstancedMeshes. Vertex buffers are shared per mesh and each draw is an
// index sub-range: a run of adjacent parts of one instance that share a category (usually the
// whole mesh, so one draw per mesh).

import * as THREE from "three";
import { liftColor, srgbBytesToLinear } from "./color";
import { MESH_FLAT, type MapData } from "./dataset";
import type { Stage } from "./stage";

interface MeshBuffers {
  position: THREE.BufferAttribute;
  /** null for flat-shaded meshes: the shader derives face normals. */
  normal: THREE.BufferAttribute | null;
  color: THREE.BufferAttribute | null;
  box: THREE.Box3;
  sphere: THREE.Sphere;
}

/** A run of slots drawn together: parts first..last of one instance. */
export interface Run {
  firstPart: number;
  lastPart: number;
  category: number;
  /** First slot of the run, one entry per instance. */
  slots: number[];
}

/**
 * Group slots into draws. Adjacent parts of an instance with the same category are merged into
 * one index range; with `split` every part is drawn on its own (needed when each slot has its
 * own colour).
 */
export function groupRuns(data: MapData, slots: Uint32Array, split: boolean): Run[] {
  const partTotal = data.partMesh.length;
  const categoryCount = data.index.categories.length;
  const runs = new Map<number, Run>();
  let i = 0;
  while (i < slots.length) {
    const first = slots[i]!;
    const category = data.slotCategory[first]!;
    const instance = data.slotInstance[first]!;
    let j = i + 1;
    if (!split) {
      while (
        j < slots.length &&
        slots[j] === slots[j - 1]! + 1 &&
        data.slotInstance[slots[j]!] === instance &&
        data.slotCategory[slots[j]!] === category
      ) {
        j++;
      }
    }
    const firstPart = data.slotPart[first]!;
    const lastPart = data.slotPart[slots[j - 1]!]!;
    const key = (firstPart * partTotal + lastPart) * categoryCount + category;
    let run = runs.get(key);
    if (!run) runs.set(key, (run = { firstPart, lastPart, category, slots: [] }));
    run.slots.push(first);
    i = j;
  }
  return [...runs.values()];
}

export class InstanceRenderer {
  private readonly meshes: THREE.InstancedMesh[] = [];
  private readonly buffers = new Map<number, MeshBuffers>();
  private readonly geometries = new Map<number, THREE.BufferGeometry>();
  /** Geometries with texture coordinates, for meshes with a draped image. */
  private readonly draped = new Map<number, THREE.BufferGeometry>();
  /** Baked vertex colours converted to linear (what three.js expects), if any. */
  private readonly linearColors: Uint8Array | null;

  constructor(
    private readonly stage: Stage,
    private readonly data: MapData,
    /** Dataset URL, for the draped images. */
    private readonly base: string,
  ) {
    this.linearColors = data.colors ? srgbBytesToLinear(data.colors, true) : null;
    stage.setVertexColors(this.linearColors !== null);
  }

  private meshBuffers(mesh: number): MeshBuffers {
    let b = this.buffers.get(mesh);
    if (!b) {
      const d = this.data;
      const v0 = d.meshVertexStart[mesh]! * 3;
      const v1 = v0 + d.meshVertexCount[mesh]! * 3;
      const o = mesh * 6;
      const box = new THREE.Box3(
        new THREE.Vector3(d.meshBounds[o], d.meshBounds[o + 1], d.meshBounds[o + 2]),
        new THREE.Vector3(d.meshBounds[o + 3], d.meshBounds[o + 4], d.meshBounds[o + 5]),
      );
      b = {
        position: new THREE.BufferAttribute(d.positions.subarray(v0, v1), 3),
        normal: d.meshFlags[mesh]! & MESH_FLAT ? null : new THREE.BufferAttribute(d.normals.subarray(v0, v1), 3, true),
        color: this.linearColors
          ? new THREE.BufferAttribute(this.linearColors.subarray((v0 / 3) * 4, (v1 / 3) * 4), 4, true)
          : null,
        box,
        sphere: box.getBoundingSphere(new THREE.Sphere()),
      };
      this.buffers.set(mesh, b);
    }
    return b;
  }

  private rangeGeometry(firstPart: number, lastPart: number): THREE.BufferGeometry {
    const d = this.data;
    const key = firstPart * d.partMesh.length + lastPart;
    let geometry = this.geometries.get(key);
    if (!geometry) {
      const mesh = d.partMesh[firstPart]!;
      const b = this.meshBuffers(mesh);
      // Parts tile the mesh's index buffer in order, so a run is one range.
      const first = d.meshIndexStart[mesh]! + d.partRange[firstPart * 2]!;
      const end = d.meshIndexStart[mesh]! + d.partRange[lastPart * 2]! + d.partRange[lastPart * 2 + 1]!;
      const indices = (d.meshIndexWide[mesh] ? d.indices32 : d.indices16).subarray(first, end);
      geometry = new THREE.BufferGeometry();
      geometry.setAttribute("position", b.position);
      if (b.normal) geometry.setAttribute("normal", b.normal);
      if (b.color) geometry.setAttribute("color", b.color);
      geometry.setIndex(new THREE.BufferAttribute(indices, 1));
      // Bounds of the whole mesh: conservative for a part, and free.
      geometry.boundingBox = b.box;
      geometry.boundingSphere = b.sphere;
      this.geometries.set(key, geometry);
    }
    return geometry;
  }

  /** The run's geometry plus texture coordinates computed from the local XZ position. */
  private drapedGeometry(key: number, geometry: THREE.BufferGeometry, rect: number[]): THREE.BufferGeometry {
    let draped = this.draped.get(key);
    if (!draped) {
      const position = geometry.getAttribute("position");
      const [x0 = 0, z0 = 0, sx = 1, sz = 1] = rect;
      const uv = new Float32Array(position.count * 2);
      for (let i = 0; i < position.count; i++) {
        uv[i * 2] = (position.getX(i) - x0) / sx;
        uv[i * 2 + 1] = (position.getZ(i) - z0) / sz;
      }
      draped = new THREE.BufferGeometry();
      for (const name of ["position", "normal", "color"]) {
        if (geometry.hasAttribute(name)) draped.setAttribute(name, geometry.getAttribute(name));
      }
      draped.setIndex(geometry.getIndex());
      draped.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
      draped.boundingBox = geometry.boundingBox;
      draped.boundingSphere = geometry.boundingSphere;
      this.draped.set(key, draped);
    }
    return draped;
  }

  private clear(): void {
    for (const mesh of this.meshes) {
      mesh.parent?.remove(mesh);
      mesh.dispose();
    }
    this.meshes.length = 0;
  }

  /**
   * Replace everything drawn with the given slots. `colored` shows material colours instead of
   * category colours: baked vertex colours when the dataset has them, otherwise one per slot.
   */
  rebuild(slots: Uint32Array, colored: boolean): void {
    this.clear();
    const d = this.data;
    const perSlot = colored && !this.linearColors;
    const matrix = new THREE.Matrix4();
    const color = new THREE.Color();
    const rgb: [number, number, number] = [0, 0, 0];
    for (const run of groupRuns(d, slots, perSlot)) {
      const { category, slots: list } = run;
      const mesh = d.partMesh[run.firstPart]!;
      let geometry = this.rangeGeometry(run.firstPart, run.lastPart);
      let material = this.stage.material(category, colored, (d.meshFlags[mesh]! & MESH_FLAT) !== 0);
      const image = colored ? d.meshTextures.get(mesh) : undefined;
      if (image) {
        geometry = this.drapedGeometry(run.firstPart * d.partMesh.length + run.lastPart, geometry, image.rect);
        material = this.stage.texturedMaterial(category, `${this.base}/${image.file}`);
      }
      const inst = new THREE.InstancedMesh(geometry, material, list.length);
      list.forEach((s, i) => {
        d.matrix16(d.slotInstance[s]!, matrix.elements);
        inst.setMatrixAt(i, matrix);
        if (perSlot && !image) {
          const c = s * 4;
          if (d.slotColor[c + 3]) {
            rgb[0] = d.slotColor[c]!;
            rgb[1] = d.slotColor[c + 1]!;
            rgb[2] = d.slotColor[c + 2]!;
            liftColor(rgb);
            color.setRGB(rgb[0] / 255, rgb[1] / 255, rgb[2] / 255, THREE.SRGBColorSpace);
          } else {
            color.setHex(this.stage.categoryColor(category));
          }
          inst.setColorAt(i, color);
        }
      });
      inst.instanceMatrix.needsUpdate = true;
      inst.computeBoundingSphere();
      inst.name = d.meshNames[mesh] ?? "";
      this.stage.groups[category]?.add(inst);
      this.meshes.push(inst);
    }
  }

  dispose(): void {
    this.clear();
    for (const g of [...this.geometries.values(), ...this.draped.values()]) g.dispose();
  }
}
