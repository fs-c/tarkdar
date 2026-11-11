import * as THREE from "three";
import { loadIndex, loadMapData, loadSources, type DatasetIndex, type MapData } from "./dataset";
import { $, copyText, flashButton } from "./dom";
import { initExploreUI, renderExploreStats } from "./explore";
import { defaultFilter, summarize, visibleSlots, type FilterState, type VisibleStats } from "./filter";
import { InstanceRenderer } from "./instances";
import { Picker } from "./picker";
import { Stage } from "./scene";
import { buildUrl, hasInspect, parseUrl } from "./url";
import "./style.css";

const URL_STATE = parseUrl(location.search);
const { mode: MODE, map: MAP, dataset: DATASET } = URL_STATE;
const DATA_BASE = `/data/${DATASET}`;
const nf = new Intl.NumberFormat("en-US");

function setTitle(label: string, tag: string): void {
  const title = document.querySelector(".hud-top-left h1");
  if (!title?.firstChild) return;
  title.firstChild.nodeValue = `${label} `;
  const span = title.querySelector("span");
  if (span) {
    span.textContent = tag;
    span.style.display = tag ? "" : "none";
  }
}

function setupNavigation(): void {
  const select = $<HTMLSelectElement>("map-select");
  select.value = MAP;
  select.addEventListener("change", () => {
    location.href = buildUrl(location.pathname, MODE === "inspect" && !hasInspect(select.value) ? "overview" : MODE, select.value);
  });

  const explore = $("btn-explore");
  explore.style.display = MODE === "inspect" ? "none" : "";
  explore.textContent = MODE === "explore" ? "Overview" : "Explore";
  explore.addEventListener("click", () => {
    location.href = buildUrl(location.pathname, MODE === "explore" ? "overview" : "explore", MAP);
  });

  const inspect = $("btn-mode");
  inspect.style.display = MODE !== "explore" && hasInspect(MAP) ? "" : "none";
  inspect.textContent = MODE === "inspect" ? "Overview" : "Inspect";
  inspect.addEventListener("click", () => {
    location.href = buildUrl(location.pathname, MODE === "inspect" ? "overview" : "inspect", MAP);
  });
}

function showHeader(index: DatasetIndex): void {
  if (MODE === "explore") setTitle(`${index.label || MAP} explore`, "EXPLORE");
  else setTitle(index.label || MAP, index.tag || "");
  const sub = document.querySelector(".sub");
  if (sub) {
    const cells = index.build?.cells;
    if (MODE === "explore") sub.textContent = "Explore mode · start full, strip categories/scenes/size";
    else if (MODE === "inspect") sub.textContent = "Inspect mode · click objects to identify · LOD0 data";
    else if (cells) sub.textContent = `Merged ${cells.size} m cells · ${Math.round(cells.error * 100)} cm error bound`;
    else sub.textContent = `${index.profile} profile`;
  }
  $("stat-unique").textContent = nf.format(index.stats.uniqueTriangles);
  $("stat-instanced").textContent = nf.format(index.stats.instancedTriangles);
  $("stat-instances").textContent = nf.format(index.stats.instanceCount);
}

function start(index: DatasetIndex, data: MapData): VisibleStats {
  const stage = new Stage($("app"), index.categories);
  const instances = new InstanceRenderer(stage, data);
  const filter: FilterState = defaultFilter(data, MODE, URL_STATE.categories);
  const picker = new Picker(stage, data, $("pick-list"), $("pick-count"), () => loadSources(DATA_BASE, index));
  let visible: VisibleStats = { instances: 0, triangles: 0, meshes: 0 };
  let colored = false;
  let timer: number | undefined;

  const rebuild = () => {
    clearTimeout(timer);
    picker.clear();
    const slots = visibleSlots(data, filter);
    instances.rebuild(slots, colored);
    visible = summarize(data, slots);
    if (MODE === "explore") renderExploreStats(visible);
  };
  const schedule = () => {
    clearTimeout(timer);
    timer = window.setTimeout(rebuild, 120);
  };
  rebuild();

  const gridCell = stage.makeGrid(index.focusBounds);
  $("grid-scale").textContent = `grid ${Math.round(gridCell)} m`;
  stage.frame(index.focusBounds);

  // --- top bar -------------------------------------------------------------
  const toggle = (id: string, initial: boolean, apply: (on: boolean) => void) => {
    let on = initial;
    const button = $(id);
    button.classList.toggle("active", on);
    const flip = () => {
      on = !on;
      button.classList.toggle("active", on);
      apply(on);
    };
    button.addEventListener("click", flip);
    return flip;
  };
  const flipWire = toggle("btn-wire", false, (on) => stage.setWireframe(on));
  const flipGrid = toggle("btn-grid", true, (on) => {
    if (stage.grid) stage.grid.visible = on;
  });
  const flipVegetation = toggle("btn-veg", true, (on) => {
    const foliage = stage.group("foliage");
    if (foliage) foliage.visible = on;
  });
  const flipColor = toggle("btn-color", false, (on) => {
    colored = on;
    rebuild();
  });
  const flipPick = toggle("btn-pick", MODE !== "overview", (on) => {
    picker.enabled = on;
    $("picker").hidden = !on;
    if (!on) picker.clear();
  });
  picker.enabled = MODE !== "overview";
  $("picker").hidden = !picker.enabled;
  $("btn-reset").addEventListener("click", () => stage.lookFrom("home"));
  $("btn-top").addEventListener("click", () => stage.lookFrom("top"));

  window.addEventListener("keydown", (e) => {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const k = e.key.toLowerCase();
    if (k === "r") stage.lookFrom("home");
    else if (k === "t") stage.lookFrom("top");
    else if (k === "f") flipWire();
    else if (k === "g") flipGrid();
    else if (k === "v") flipVegetation();
    else if (k === "c") flipColor();
    else if (k === "p") flipPick();
    else if (k === "escape") picker.clear();
  });

  // --- picker panel --------------------------------------------------------
  flashButton($("pick-copy"), () => copyText(picker.report(DATASET, MODE)));
  $("pick-download").addEventListener("click", () => {
    const url = URL.createObjectURL(new Blob([picker.report(DATASET, MODE)], { type: "application/json" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `selection-${DATASET}.json`;
    a.click();
    URL.revokeObjectURL(url);
  });
  $("pick-clear").addEventListener("click", () => picker.clear());
  $("pick-hide").addEventListener("click", () => {
    for (const id of picker.meshIds()) filter.hiddenMeshes.add(id);
    schedule();
  });
  $("pick-solo").addEventListener("click", () => {
    filter.soloMeshes = picker.meshIds();
    schedule();
  });
  $("pick-showall").addEventListener("click", () => {
    filter.hiddenMeshes.clear();
    filter.soloMeshes = null;
    schedule();
  });

  // --- explore panel -------------------------------------------------------
  $("explore-panel").hidden = MODE !== "explore";
  if (MODE === "explore") {
    initExploreUI(data, filter, { rebuild, schedule, visible: () => visible, mapName: DATASET });
  }

  const perf = $("perf");
  if (URL_STATE.paused) {
    perf.textContent = "paused";
  } else {
    stage.start((fps, calls, triangles) => {
      perf.textContent = `${fps.toFixed(0)} fps · ${nf.format(calls)} calls · ${nf.format(triangles)} tris`;
    });
  }

  // Debug/measurement handle (used by the screenshot harness).
  Object.assign(window, { __map: { THREE, stage, data, index, filter, instances, rebuild, visible: () => visible } });
  return visible;
}

async function boot(): Promise<void> {
  const loader = $("loader");
  const text = $("loader-text");
  const sub = $("loader-sub");
  const fill = $("bar-fill");
  setupNavigation();

  try {
    text.textContent = "Loading metadata…";
    const index = await loadIndex(DATA_BASE);
    showHeader(index);

    text.textContent = "Downloading geometry…";
    const data = await loadMapData(DATA_BASE, index, (received, total) => {
      fill.style.width = `${Math.min(100, (received / total) * 100)}%`;
      sub.textContent = `${(received / 1e6).toFixed(1)} / ${(total / 1e6).toFixed(1)} MB`;
    });

    text.textContent = "Building meshes…";
    sub.textContent = `${nf.format(index.stats.meshCount)} unique meshes · ${nf.format(index.stats.instanceCount)} instances`;
    fill.style.width = "100%";
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

    const t0 = performance.now();
    const visible = start(index, data);
    sub.textContent = `${nf.format(visible.instances)} instances built in ${(performance.now() - t0).toFixed(0)} ms`;
    loader.classList.add("hidden");
    setTimeout(() => loader.remove(), 600);
  } catch (err) {
    console.error(err);
    text.textContent = "Failed to load map data";
    sub.textContent = err instanceof Error ? err.message : String(err);
    fill.style.width = "0%";
    fill.style.background = "#c25b4e";
  }
}

void boot();
