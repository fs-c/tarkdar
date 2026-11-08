import { type ControlPoint, worldToPixel } from "./calibration";
import { Connection } from "./connection";
import { type Selection, renderDetails } from "./details";
import { type CatalogStatus, loadCatalog } from "./catalog";
import { type ItemCatalog, emptyCatalog } from "./items";
import { type LoadedMap, type MapEntry, fetchMapIndex, findMap, loadMap, selectLayer } from "./maps";
import { type Layers, NO_MAP_TRANSFORM, render } from "./render";
import { View } from "./view";
import "./style.css";

const canvas = document.querySelector<HTMLCanvasElement>("#radar")!;
const statusEl = document.querySelector<HTMLDivElement>("#status")!;
const floorEl = document.querySelector<HTMLDivElement>("#floors")!;
const followBtn = document.querySelector<HTMLButtonElement>("#follow")!;
const calibrateBtn = document.querySelector<HTMLButtonElement>("#calibrate")!;
const calibPanel = document.querySelector<HTMLDivElement>("#calibration")!;
const calibOutput = document.querySelector<HTMLTextAreaElement>("#calibration-output")!;
const calibClear = document.querySelector<HTMLButtonElement>("#calibration-clear")!;
const detailsEl = document.querySelector<HTMLDivElement>("#details")!;
const ctx = canvas.getContext("2d")!;

const view = new View();
view.zoom = 0.75;
let mapIndex: MapEntry[] = [];
let map: LoadedMap | null = null;
let mapLocation: string | null = null;
let autoLayer: number | null = null;
let manualLayer: number | null = null;
let calibrating = false;
const calibrationPoints: ControlPoint[] = [];
let dirty = true;
let selection: Selection | null = null;
// Item data (names, prices): loaded once per page load from tarkov.dev, cached for a day.
let catalog: ItemCatalog = emptyCatalog;
let catalogStatus: CatalogStatus = { state: "loading", count: 0, fetchedAt: null };
void loadCatalog().then(({ catalog: c, status }) => {
  if (c) catalog = c;
  catalogStatus = status;
  if (status.error) console.warn("item data:", status.error);
  dirty = true;
});
const layers: Layers = loadLayers();

function loadLayers(): Layers {
  const defaults: Layers = { loot: false, containers: false, exfils: true, explosives: true };
  try {
    return { ...defaults, ...(JSON.parse(localStorage.getItem("radar.layers") ?? "{}") as Partial<Layers>) };
  } catch {
    return defaults;
  }
}

for (const key of Object.keys(layers) as (keyof Layers)[]) {
  const b = document.querySelector<HTMLButtonElement>(`#layer-${key}`)!;
  b.classList.toggle("active", layers[key]);
  b.onclick = () => {
    layers[key] = !layers[key];
    b.classList.toggle("active", layers[key]);
    localStorage.setItem("radar.layers", JSON.stringify(layers));
    dirty = true;
  };
}

const wsUrl = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`;
const conn = new Connection(wsUrl, () => (dirty = true));
conn.start();

async function refreshMapIndex(): Promise<void> {
  try {
    mapIndex = await fetchMapIndex();
  } catch (e) {
    console.warn("couldn't load the map index", e);
    mapIndex = [];
  }
  mapLocation = null; // re-select
  dirty = true;
}
void refreshMapIndex();

/** Loads the map for the current raid location (once per location change). */
function updateMap(): void {
  const locationId = conn.state.status?.state === "inRaid" ? conn.state.status.locationId : null;
  if (locationId === mapLocation) return;
  mapLocation = locationId;
  autoLayer = null;
  manualLayer = null;
  const entry = locationId ? findMap(mapIndex, locationId) : undefined;
  try {
    map = entry ? loadMap(entry, () => (dirty = true)) : null;
  } catch (e) {
    console.warn(`map ${entry?.folder}: invalid calibration`, e);
    map = null;
  }
  buildFloorButtons();
}

function buildFloorButtons(): void {
  floorEl.replaceChildren();
  if (!map || map.config.layers.length < 2) return;
  const add = (label: string, layer: number | null) => {
    const b = document.createElement("button");
    b.textContent = label;
    b.onclick = () => {
      manualLayer = layer;
      dirty = true;
    };
    b.dataset.layer = String(layer);
    floorEl.append(b);
  };
  add("auto", null);
  map.config.layers.forEach((_, i) => add(String(i + 1), i));
}

function currentLayer(): number {
  if (!map) return 0;
  const local = conn.state.players.find((p) => p.local && p.pos);
  if (local?.pos) autoLayer = selectLayer(map.config.layers, local.pos[1], autoLayer, map.config.layerHysteresis);
  return manualLayer ?? autoLayer ?? 0;
}

function updateStatus(layer: number): void {
  const s = conn.state;
  const parts: string[] = [];
  if (!s.connected) parts.push("⚠ disconnected from backend");
  else if (s.protocolMismatch) parts.push("⚠ protocol version mismatch: rebuild the frontend");
  else if (!s.status) parts.push("connected");
  else {
    const labels: Record<string, string> = {
      waitingForProcess: "waiting for the game",
      waitingForModules: "game starting",
      waitingForRaid: s.status.raidPending ? "raid loading…" : "waiting for a raid",
      inRaid: `in raid: ${s.status.locationId ?? "?"}`,
      cooldown: "raid ended",
    };
    parts.push(labels[s.status.state] ?? s.status.state);
    if (s.status.state === "inRaid") {
      if (!map) parts.push("no map for this location");
      else if (map.config.layers.length > 1)
        parts.push(`${map.config.name}, floor ${layer + 1}/${map.config.layers.length}${manualLayer === null ? " (auto)" : ""}`);
      else parts.push(map.config.name);
      const alive = s.players.filter((p) => !p.dead && !p.absent).length;
      parts.push(`${alive} alive / ${s.players.length} players`);
      if (s.loot.length) parts.push(`${s.loot.length} loot`);
    }
    if (s.status.offsetsMismatch) parts.push("⚠ game build differs from the offsets' build");
    if (catalogStatus.state === "unavailable") parts.push("⚠ no item data");
    else if (catalogStatus.state === "stale") parts.push("item data stale");
  }
  statusEl.textContent = parts.join(" · ");
  for (const b of floorEl.querySelectorAll<HTMLButtonElement>("button")) {
    const l = b.dataset.layer === "null" ? null : Number(b.dataset.layer);
    b.classList.toggle("active", l === manualLayer);
    b.classList.toggle("current", l === layer);
  }
  followBtn.classList.toggle("active", view.follow);
}

function resize(): void {
  const dpr = window.devicePixelRatio || 1;
  view.width = canvas.clientWidth;
  view.height = canvas.clientHeight;
  canvas.width = Math.round(view.width * dpr);
  canvas.height = Math.round(view.height * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  dirty = true;
}
window.addEventListener("resize", resize);
resize();

let lastRaid: number | null = null;

function frame(): void {
  try {
    drawFrame();
  } catch (e) {
    console.error("frame failed", e);  // keep the loop alive
  }
  requestAnimationFrame(frame);
}

function drawFrame(): void {
  // Ids restart every raid: a selection from the previous raid would point at something else.
  const raid = conn.state.status?.state === "inRaid" ? conn.state.raid : null;
  if (raid !== lastRaid) {
    lastRaid = raid;
    selection = null;
    dirty = true;
  }
  updateMap();
  if (dirty) {
    dirty = false;
    const layer = currentLayer();
    const transform = map?.transform ?? NO_MAP_TRANSFORM;
    const local = conn.state.players.find((p) => p.local && p.pos);
    if (view.follow && local?.pos) [view.centerU, view.centerV] = worldToPixel(transform, local.pos[0], local.pos[2]);
    render(ctx, view, {
      map,
      layer,
      players: conn.state.players,
      catalog,
      exfils: conn.state.exfils,
      explosives: conn.state.explosives,
      loot: conn.state.loot,
      layers,
      selected: selectedPosition(),
      calibrationPixels: calibrationPoints.map((p) => p.pixel),
    });
    updateStatus(layer);
    renderDetails(detailsEl, selection, conn.state, catalog);
  }
}
requestAnimationFrame(frame);

// ---- interaction ----------------------------------------------------------------------------------
let drag: { x: number; y: number; moved: boolean } | null = null;
canvas.addEventListener("pointerdown", (e) => {
  drag = { x: e.clientX, y: e.clientY, moved: false };
  canvas.setPointerCapture(e.pointerId);
});
canvas.addEventListener("pointermove", (e) => {
  if (!drag) return;
  const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
  if (!drag.moved && Math.hypot(dx, dy) < 4) return;
  drag.moved = true;
  view.panBy(dx, dy);
  drag.x = e.clientX;
  drag.y = e.clientY;
  dirty = true;
});
canvas.addEventListener("pointercancel", () => {
  drag = null;
});
canvas.addEventListener("pointerup", (e) => {
  if (drag && !drag.moved) {
    if (calibrating) addCalibrationPoint(e.offsetX, e.offsetY);
    else select(e.offsetX, e.offsetY);
  }
  drag = null;
});
canvas.addEventListener(
  "wheel",
  (e) => {
    e.preventDefault();
    view.zoomAt(Math.exp(-e.deltaY * 0.0015), e.offsetX, e.offsetY);
    dirty = true;
  },
  { passive: false },
);
followBtn.onclick = () => {
  view.follow = !view.follow;
  dirty = true;
};
window.addEventListener("keydown", (e) => {
  if (e.target instanceof HTMLTextAreaElement) return;
  if (e.key === "f") followBtn.click();
  if (e.key === "+" || e.key === "=") view.zoomAt(1.25, view.width / 2, view.height / 2);
  if (e.key === "-") view.zoomAt(0.8, view.width / 2, view.height / 2);
  dirty = true;
});

// ---- selection --------------------------------------------------------------------------------------
/** Selects the nearest visible player, exfil or loot marker within a few pixels of (x, y). */
function select(x: number, y: number): void {
  const t = map?.transform ?? NO_MAP_TRANSFORM;
  let best: { sel: Selection; d: number } | null = null;
  const consider = (sel: Selection, pos: [number, number, number] | null | undefined, radius: number) => {
    if (!pos) return;
    const [sx, sy] = view.toScreen(...worldToPixel(t, pos[0], pos[2]));
    const d = Math.hypot(sx - x, sy - y);
    if (d <= radius && (!best || d < best.d)) best = { sel, d };
  };
  for (const p of conn.state.players) consider({ kind: "player", id: p.id }, p.pos, 12);
  if (layers.exfils) for (const e of conn.state.exfils) consider({ kind: "exfil", id: e.id }, e.pos, 12);
  for (const l of conn.state.loot) {
    const visible = l.kind === "container" || l.kind === "airdrop" ? layers.containers : layers.loot;
    if (visible) consider({ kind: "loot", id: l.id }, l.pos, 8);
  }
  selection = (best as { sel: Selection } | null)?.sel ?? null;
  dirty = true;
}

function selectedPosition(): [number, number, number] | null {
  if (!selection) return null;
  const s = conn.state;
  const id = selection.id;
  switch (selection.kind) {
    case "player": return s.players.find((p) => p.id === id)?.pos ?? null;
    case "loot": return s.loot.find((l) => l.id === id)?.pos ?? null;
    case "exfil": return s.exfils.find((e) => e.id === id)?.pos ?? null;
  }
}

window.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    selection = null;
    dirty = true;
  }
});

// ---- calibration mode -----------------------------------------------------------------------------
// Stand somewhere recognisable in game, click that spot on the map image: the click's image pixel is
// paired with the local player's current world position. Two points give a similarity transform;
// three or more a least-squares affine fit. Paste the output into the map's map.json.
calibrateBtn.onclick = () => {
  calibrating = !calibrating;
  calibrateBtn.classList.toggle("active", calibrating);
  calibPanel.hidden = !calibrating;
  view.follow = !calibrating && view.follow;
  dirty = true;
};
calibClear.onclick = () => {
  calibrationPoints.length = 0;
  updateCalibrationOutput();
  dirty = true;
};

function addCalibrationPoint(x: number, y: number): void {
  if (!map) {
    calibOutput.value = "No map loaded for this location. Create its map folder first (see docs/maps.md).";
    return;
  }
  const local = conn.state.players.find((p) => p.local && p.pos);
  if (!local?.pos) {
    calibOutput.value = "No local player position yet: be in a raid first.";
    return;
  }
  const [u, v] = view.toMap(x, y);
  calibrationPoints.push({
    world: [round(local.pos[0], 2), round(local.pos[2], 2)],
    pixel: [round(u, 1), round(v, 1)],
  });
  updateCalibrationOutput();
  dirty = true;
}

function updateCalibrationOutput(): void {
  const lines = calibrationPoints.map((p) => `      { "world": [${p.world.join(", ")}], "pixel": [${p.pixel.join(", ")}] }`);
  calibOutput.value =
    calibrationPoints.length === 0
      ? "Click the map where your character stands."
      : `"calibration": {\n  "points": [\n${lines.join(",\n")}\n  ]\n}` +
        (calibrationPoints.length < 2 ? "\n\n(add at least one more point, far from the first)" : "");
}
updateCalibrationOutput();

function round(v: number, digits: number): number {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}
