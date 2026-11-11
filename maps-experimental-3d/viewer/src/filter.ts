// Which slots are visible: categories, scene groups, world size, mesh name and
// the picker's hide/solo sets. Pure logic over MapData, no rendering.

import type { MapData } from "./dataset";
import type { Mode } from "./url";

export interface FilterState {
  /** Visible category ids. */
  categories: Set<number>;
  /** Hidden scene-group ids. */
  hiddenGroups: Set<number>;
  minSize: number;
  maxSize: number;
  meshText: string;
  meshMode: "hide" | "only";
  hiddenMeshes: Set<number>;
  soloMeshes: Set<number> | null;
}

export const MAX_SIZE = 1e9;
/** Cosmetic geometry that only makes sense with textures. */
export const NOISE_CATEGORIES = ["shadow", "decal", "background"];

export function presentCategories(data: MapData): number[] {
  const seen = new Set<number>(data.slotCategory);
  return [...seen].sort((a, b) => a - b);
}

/**
 * Explore starts with everything visible; the other modes hide noise.
 * `only` (category names, e.g. from ?cats=) replaces that default.
 */
export function defaultFilter(data: MapData, mode: Mode, only: string[] | null = null): FilterState {
  let categories = new Set(presentCategories(data));
  if (only) {
    const wanted = new Set(only.map((name) => data.categoryId(name)));
    categories = new Set([...categories].filter((c) => wanted.has(c)));
  } else if (mode !== "explore") {
    for (const name of NOISE_CATEGORIES) categories.delete(data.categoryId(name));
  }
  return {
    categories,
    hiddenGroups: new Set(),
    minSize: 0,
    maxSize: MAX_SIZE,
    meshText: "",
    meshMode: "hide",
    hiddenMeshes: new Set(),
    soloMeshes: null,
  };
}

export function visibleSlots(data: MapData, st: FilterState): Uint32Array {
  const text = st.meshText.trim().toLowerCase();
  let meshMatch: Uint8Array | null = null;
  if (text) {
    meshMatch = new Uint8Array(data.meshCount);
    for (let m = 0; m < data.meshCount; m++) {
      if ((data.meshNames[m] || "").toLowerCase().includes(text)) meshMatch[m] = 1;
    }
  }
  const catVisible = new Uint8Array(256);
  for (const c of st.categories) catVisible[c] = 1;

  const out = new Uint32Array(data.slotCount);
  let count = 0;
  for (let i = 0; i < data.instanceCount; i++) {
    const mesh = data.instMesh[i];
    const size = data.instSize[i];
    if (size < st.minSize || size > st.maxSize) continue;
    if (st.hiddenGroups.has(data.instGroup[i])) continue;
    if (st.hiddenMeshes.has(mesh)) continue;
    if (st.soloMeshes && !st.soloMeshes.has(mesh)) continue;
    if (meshMatch) {
      if (st.meshMode === "hide" && meshMatch[mesh]) continue;
      if (st.meshMode === "only" && !meshMatch[mesh]) continue;
    }
    const start = data.instSlotStart[i];
    const end = start + data.meshPartCount[mesh];
    for (let s = start; s < end; s++) {
      if (catVisible[data.slotCategory[s]]) out[count++] = s;
    }
  }
  return out.subarray(0, count);
}

export interface VisibleStats {
  instances: number;
  triangles: number;
  meshes: number;
}

export function summarize(data: MapData, slots: Uint32Array): VisibleStats {
  const meshes = new Set<number>();
  let instances = 0;
  let triangles = 0;
  let last = -1;
  for (const s of slots) {
    const inst = data.slotInstance[s];
    if (inst !== last) {
      instances++;
      last = inst;
      meshes.add(data.instMesh[inst]);
    }
    triangles += data.slotTriangles(s);
  }
  return { instances, triangles, meshes: meshes.size };
}

export interface CategoryCount {
  id: number;
  name: string;
  slots: number;
  triangles: number;
}

export function categoryCounts(data: MapData): CategoryCount[] {
  const names = data.index.categories;
  const counts: CategoryCount[] = names.map((name, id) => ({ id, name, slots: 0, triangles: 0 }));
  for (let s = 0; s < data.slotCount; s++) {
    const c = counts[data.slotCategory[s]];
    if (!c) continue;
    c.slots++;
    c.triangles += data.slotTriangles(s);
  }
  return counts.filter((c) => c.slots > 0);
}

export interface GroupCount {
  id: number;
  name: string;
  instances: number;
}

export function groupCounts(data: MapData): GroupCount[] {
  const counts = data.sceneGroups.map((name, id) => ({ id, name, instances: 0 }));
  for (let i = 0; i < data.instanceCount; i++) counts[data.instGroup[i]].instances++;
  return counts.sort((a, b) => a.name.localeCompare(b.name));
}

export function filterReport(data: MapData, st: FilterState, visible: VisibleStats, map: string): string {
  const names = (ids: Iterable<number>) => [...ids].map((m) => data.meshNames[m]).filter(Boolean);
  return JSON.stringify(
    {
      map,
      mode: "explore",
      generatedAt: new Date().toISOString(),
      categories: [...st.categories].map((c) => data.index.categories[c]),
      size: [st.minSize, st.maxSize],
      scenes: data.sceneGroups.filter((_, id) => !st.hiddenGroups.has(id)),
      meshName: { text: st.meshText, mode: st.meshMode },
      hiddenMeshes: names(st.hiddenMeshes),
      soloMeshes: names(st.soloMeshes ?? []),
      visible,
    },
    null,
    2,
  );
}
