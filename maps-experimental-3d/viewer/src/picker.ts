// Click-to-identify: selection list, highlight boxes and the JSON report used
// to describe geometry problems.

import * as THREE from "three";
import type { MapData } from "./dataset";
import type { InstancedUserData } from "./instances";
import type { Stage } from "./scene";

const nf = new Intl.NumberFormat("en-US");
const MAX_SELECTION = 30;

export interface Selection {
  instance: number;
  slot: number;
  meshIndex: number;
  mesh: string;
  category: string;
  material: string | null;
  shader: string | null;
  scene: string;
  sceneIndex: number;
  path: string | null;
  position: number[];
  size: number[];
  scale: number[];
  /** Triangles of the whole mesh / of the clicked part. */
  tris: number;
  partTris: number;
  box: THREE.Box3;
}

/** Everything the report says about one slot; pure data, no rendering. */
export function describeSlot(data: MapData, slot: number, paths: string[] | null): Omit<Selection, "box"> {
  const instance = data.slotInstance[slot];
  const meshIndex = data.instMesh[instance];
  const m = data.instMatrix;
  const o = instance * 12;
  const b = instance * 6;
  const box = data.instBox;
  const material = data.index.materials[data.slotMaterial[slot]];
  const sceneIndex = data.instScene[instance];
  const pathIndex = data.instPath[instance];
  return {
    instance,
    slot,
    meshIndex,
    mesh: data.meshNames[meshIndex] ?? "",
    category: data.index.categories[data.slotCategory[slot]] ?? "?",
    material: material?.name ?? null,
    shader: material?.shader ?? null,
    scene: data.index.scenes[sceneIndex]?.level ?? `scene ${sceneIndex}`,
    sceneIndex,
    path: paths && pathIndex >= 0 ? (paths[pathIndex] ?? null) : null,
    position: [m[o + 9], m[o + 10], m[o + 11]],
    size: [box[b + 3] - box[b], box[b + 4] - box[b + 1], box[b + 5] - box[b + 2]],
    scale: [
      Math.hypot(m[o], m[o + 1], m[o + 2]),
      Math.hypot(m[o + 3], m[o + 4], m[o + 5]),
      Math.hypot(m[o + 6], m[o + 7], m[o + 8]),
    ],
    tris: data.meshIndexCount[meshIndex] / 3,
    partTris: data.slotTriangles(slot),
  };
}

export function selectionReport(selected: Omit<Selection, "box">[], map: string, mode: string): string {
  return JSON.stringify(
    {
      map,
      mode,
      generatedAt: new Date().toISOString(),
      selection: selected.map((s) => ({
        mesh: s.mesh,
        meshIndex: s.meshIndex,
        category: s.category,
        material: s.material,
        shader: s.shader,
        scene: s.scene,
        sceneIndex: s.sceneIndex,
        path: s.path,
        instance: s.instance,
        position: s.position.map((v) => Number(v.toFixed(2))),
        size: s.size.map((v) => Number(v.toFixed(2))),
        scale: s.scale.map((v) => Number(v.toFixed(3))),
        triangles: s.tris,
        partTriangles: s.partTris,
      })),
    },
    null,
    2,
  );
}

export class Picker {
  readonly selected: Selection[] = [];
  enabled = false;
  private paths: string[] | null = null;
  private pathsRequested = false;
  private readonly raycaster = new THREE.Raycaster();
  private readonly pointer = new THREE.Vector2();

  constructor(
    private readonly stage: Stage,
    private readonly data: MapData,
    private readonly list: HTMLElement,
    private readonly count: HTMLElement,
    private readonly loadPaths: () => Promise<string[]>,
  ) {
    const canvas = stage.renderer.domElement;
    let down: { x: number; y: number; t: number } | null = null;
    canvas.addEventListener("pointerdown", (e) => {
      if (e.button === 0) down = { x: e.clientX, y: e.clientY, t: performance.now() };
    });
    canvas.addEventListener("pointerup", (e) => {
      if (!down || e.button !== 0) return;
      const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
      const elapsed = performance.now() - down.t;
      down = null;
      // A drag or a long press is camera movement, not a pick.
      if (!this.enabled || moved > 6 || elapsed > 700) return;
      this.pickAt(e.clientX, e.clientY, e.shiftKey);
    });
  }

  meshIds(): Set<number> {
    return new Set(this.selected.map((s) => s.meshIndex));
  }

  clear(): void {
    this.selected.length = 0;
    this.render();
  }

  report(map: string, mode: string): string {
    return selectionReport(this.selected, map, mode);
  }

  private ensurePaths(): void {
    if (this.pathsRequested) return;
    this.pathsRequested = true;
    this.loadPaths()
      .then((paths) => {
        this.paths = paths;
        for (const s of this.selected) {
          const index = this.data.instPath[s.instance];
          s.path = index >= 0 ? (paths[index] ?? null) : null;
        }
        this.render();
      })
      .catch((err) => console.warn("picker: hierarchy paths unavailable", err));
  }

  private pickAt(clientX: number, clientY: number, additive: boolean): void {
    const rect = this.stage.renderer.domElement.getBoundingClientRect();
    this.pointer.set(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(this.pointer, this.stage.camera);
    const hits = this.raycaster.intersectObjects(
      this.stage.groups.filter((g) => g.visible),
      true,
    );
    const hit = hits[0];
    if (!hit) {
      if (!additive) this.clear();
      return;
    }
    const userData = hit.object.userData as Partial<InstancedUserData>;
    if (hit.instanceId === undefined || !userData.slots) return;
    const slot = userData.slots[hit.instanceId];
    this.ensurePaths();

    const info = describeSlot(this.data, slot, this.paths);
    const b = info.instance * 6;
    const ib = this.data.instBox;
    const box = new THREE.Box3(
      new THREE.Vector3(ib[b], ib[b + 1], ib[b + 2]),
      new THREE.Vector3(ib[b + 3], ib[b + 4], ib[b + 5]),
    );
    if (!additive) this.selected.length = 0;
    if (!this.selected.some((s) => s.instance === info.instance)) {
      this.selected.push({ ...info, box });
      if (this.selected.length > MAX_SELECTION) this.selected.shift();
    }
    this.render();
  }

  render(): void {
    this.list.replaceChildren();
    for (const s of this.selected) {
      const li = document.createElement("li");
      const name = document.createElement("div");
      name.className = "pick-name";
      name.textContent = s.mesh || "(unnamed mesh)";
      const meta = document.createElement("div");
      meta.className = "pick-meta";
      meta.textContent =
        `${s.category} · ${s.scene} · ${s.position.map((v) => v.toFixed(1)).join(", ")} · ` +
        `${s.size.map((v) => v.toFixed(1)).join("×")} m · ` +
        `scale ${s.scale.map((v) => v.toFixed(2)).join("×")} · ${nf.format(s.tris)} tris`;
      li.append(name, meta);
      if (s.shader || s.path) {
        const source = document.createElement("div");
        source.className = "pick-meta";
        source.textContent = [s.shader, s.path].filter(Boolean).join(" · ");
        li.append(source);
      }
      this.list.append(li);
    }
    this.count.textContent = String(this.selected.length);

    const highlights = this.stage.highlights;
    for (const child of [...highlights.children] as THREE.Box3Helper[]) {
      highlights.remove(child);
      child.geometry.dispose();
      (child.material as THREE.Material).dispose();
    }
    for (const s of this.selected) highlights.add(new THREE.Box3Helper(s.box, 0xffcc33));
  }
}
