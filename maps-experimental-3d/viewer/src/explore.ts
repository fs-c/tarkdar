// Explore mode's strip-down panel: edits a FilterState and asks for a rebuild.

import type { MapData } from "./dataset";
import { $, copyText, flashButton } from "./dom";
import {
  categoryCounts,
  defaultFilter,
  filterReport,
  groupCounts,
  MAX_SIZE,
  NOISE_CATEGORIES,
  type FilterState,
  type VisibleStats,
} from "./filter";

const nf = new Intl.NumberFormat("en-US");

export interface ExploreHooks {
  /** Rebuild now / shortly (debounced, for typing and checkbox bursts). */
  rebuild(): void;
  schedule(): void;
  visible(): VisibleStats;
  mapName: string;
}

function checkboxRow(text: string, countText: string, checked: boolean, onChange: (on: boolean) => void) {
  const label = document.createElement("label");
  const input = document.createElement("input");
  input.type = "checkbox";
  input.checked = checked;
  input.addEventListener("change", () => onChange(input.checked));
  const name = document.createElement("span");
  name.textContent = text;
  const count = document.createElement("span");
  count.className = "count";
  count.textContent = countText;
  label.append(input, name, count);
  return { label, input };
}

export function initExploreUI(data: MapData, filter: FilterState, hooks: ExploreHooks): void {
  const minSize = $<HTMLInputElement>("filter-min-size");
  const maxSize = $<HTMLInputElement>("filter-max-size");
  const meshText = $<HTMLInputElement>("filter-mesh-text");
  const meshMode = $<HTMLSelectElement>("filter-mesh-mode");
  const categoryInputs = new Map<number, HTMLInputElement>();
  const groupInputs = new Map<number, HTMLInputElement>();

  const categoryList = $("filter-categories");
  categoryList.replaceChildren();
  for (const c of categoryCounts(data)) {
    const row = checkboxRow(c.name, `${nf.format(c.slots)} / ${nf.format(c.triangles)} tri`, filter.categories.has(c.id), (on) => {
      if (on) filter.categories.add(c.id);
      else filter.categories.delete(c.id);
      hooks.schedule();
    });
    categoryInputs.set(c.id, row.input);
    categoryList.append(row.label);
  }

  const sceneList = $("filter-scenes");
  sceneList.replaceChildren();
  for (const g of groupCounts(data)) {
    const row = checkboxRow(g.name, nf.format(g.instances), !filter.hiddenGroups.has(g.id), (on) => {
      if (on) filter.hiddenGroups.delete(g.id);
      else filter.hiddenGroups.add(g.id);
      hooks.schedule();
    });
    groupInputs.set(g.id, row.input);
    sceneList.append(row.label);
  }

  /** Push the state back into the controls after a preset or reset. */
  const sync = () => {
    for (const [id, input] of categoryInputs) input.checked = filter.categories.has(id);
    for (const [id, input] of groupInputs) input.checked = !filter.hiddenGroups.has(id);
    minSize.value = String(filter.minSize);
    maxSize.value = String(filter.maxSize);
    meshText.value = filter.meshText;
    meshMode.value = filter.meshMode;
  };
  const apply = () => {
    sync();
    hooks.rebuild();
  };

  minSize.addEventListener("input", () => {
    filter.minSize = Number(minSize.value) || 0;
    hooks.schedule();
  });
  maxSize.addEventListener("input", () => {
    filter.maxSize = Number(maxSize.value) || MAX_SIZE;
    hooks.schedule();
  });
  meshText.addEventListener("input", () => {
    filter.meshText = meshText.value;
    hooks.schedule();
  });
  meshMode.addEventListener("change", () => {
    filter.meshMode = meshMode.value === "only" ? "only" : "hide";
    hooks.schedule();
  });
  $("filter-apply").addEventListener("click", hooks.rebuild);
  $("filter-huge").addEventListener("click", () => {
    filter.minSize = 100;
    filter.maxSize = MAX_SIZE;
    apply();
  });
  $("filter-tiny").addEventListener("click", () => {
    filter.minSize = 0;
    filter.maxSize = 0.5;
    apply();
  });
  $("filter-noise").addEventListener("click", () => {
    for (const name of NOISE_CATEGORIES) filter.categories.delete(data.categoryId(name));
    apply();
  });
  $("filter-reset").addEventListener("click", () => {
    Object.assign(filter, defaultFilter(data, "explore"));
    apply();
  });
  flashButton($("filter-copy"), () => copyText(filterReport(data, filter, hooks.visible(), hooks.mapName)));
  sync();
}

export function renderExploreStats(s: VisibleStats): void {
  $("explore-visible").textContent = `${nf.format(s.instances)} inst`;
  $("explore-stats").textContent =
    `visible ${nf.format(s.instances)} instances · ${nf.format(s.triangles)} tris · ${nf.format(s.meshes)} mesh types`;
}
