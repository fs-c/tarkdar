// Harness page: one dataset through the radar's own 3D core (web/src/map3d), nothing else.
//   ?data=<name>   dataset folder (harness/data/<name>, else maps/3d/<name>)
//   ?color=1       material colours (default: category colours, so geometry is compared)
// capture.mjs drives it through window.__map.

import { Map3D } from "../../../../web/src/map3d/Map3D";

const params = new URLSearchParams(location.search);
const map = new Map3D(document.getElementById("app")!, 0x9aacbd);
const globals = window as unknown as { __map?: Map3D; __mapError?: string };

map.load(`/data/${params.get("data") ?? "customs"}`).then(
  () => {
    map.setSettings({ colored: params.get("color") === "1", trees: false, contours: true, wireframe: false });
    globals.__map = map;
  },
  (e: unknown) => (globals.__mapError = e instanceof Error ? e.message : String(e)),
);
