// Harness page: one dataset through the radar's own 3D core (web/src/map3d), nothing else.
//   ?data=<name>   dataset folder (harness/data/<name>, else maps/3d/<name>)
//   ?color=1       material colours (default: category colours, so geometry is compared)
//   ?style=plan    the plan style (default: realistic)
//   ?bg=11161c     background colour (default: the harness blue-grey)
// capture.mjs drives it through window.__map.

import { Map3D } from "../../../../web/src/map3d/Map3D";
import { DEFAULT_MAP_SETTINGS, PLAN_PALETTES } from "../../../../web/src/map3d/settings";

const params = new URLSearchParams(location.search);
const map = new Map3D(document.getElementById("app")!, Number.parseInt(params.get("bg") ?? "9aacbd", 16));
const globals = window as unknown as { __map?: Map3D; __mapError?: string; __defaults?: unknown; __palettes?: unknown };
globals.__palettes = PLAN_PALETTES;
globals.__defaults = DEFAULT_MAP_SETTINGS;

map.load(`/data/${params.get("data") ?? "customs"}`).then(
  () => {
    map.setSettings({ ...DEFAULT_MAP_SETTINGS, colored: params.get("color") === "1", trees: false, style: params.get("style") === "plan" ? "plan" : "realistic" });
    globals.__map = map;
  },
  (e: unknown) => (globals.__mapError = e instanceof Error ? e.message : String(e)),
);
