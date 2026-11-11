// URL state: ?mode=overview|explore|inspect & ?map=customs|streets
// -> which dataset directory to load. Any other dataset name works as ?map=
// too (e.g. ?map=customs-legacy).
//   ?cats=structure,terrain   start with only these categories visible
//   ?paused                   do not start the render loop (measurement harness
//                             renders single frames itself)

export type Mode = "overview" | "explore" | "inspect";

export interface UrlState {
  mode: Mode;
  /** Map as shown in the selector (customs, streets) or a dataset name. */
  map: string;
  /** Dataset directory under /data. */
  dataset: string;
  /** Category names to show initially; null = the mode's default. */
  categories: string[] | null;
  paused: boolean;
}

/** Maps that have a LOD0 "-inspect" dataset. */
const INSPECT_MAPS = new Set(["customs"]);

export function hasInspect(map: string): boolean {
  return INSPECT_MAPS.has(map);
}

export function datasetFor(mode: Mode, map: string): string {
  if (mode === "explore") return `${map.replace(/-.*$/, "")}-explore`;
  if (mode === "inspect" && hasInspect(map)) return `${map}-inspect`;
  return map;
}

export function parseUrl(search: string): UrlState {
  const params = new URLSearchParams(search);
  const rawMap = params.get("map") ?? "";
  const rawMode = params.get("mode");
  let mode: Mode = rawMode === "explore" || rawMode === "inspect" ? rawMode : "overview";
  // Dataset names are accepted as map names: ?map=customs-explore
  if (rawMap.endsWith("-explore")) mode = "explore";
  else if (rawMap.endsWith("-inspect") && mode === "overview") mode = "inspect";
  let map = rawMap.replace(/-(explore|inspect)$/, "") || "customs";
  if (mode === "explore") map = map.replace(/-.*$/, "");   // explore exists per map, not per variant
  const cats = params.get("cats");
  const categories = cats ? cats.split(",").map((c) => c.trim()).filter(Boolean) : null;
  return { mode, map, dataset: datasetFor(mode, map), categories, paused: params.has("paused") };
}

export function buildUrl(pathname: string, mode: Mode, map: string): string {
  const params = new URLSearchParams();
  if (mode !== "overview") params.set("mode", mode);
  if (map !== "customs") params.set("map", map);
  const query = params.toString();
  return query ? `${pathname}?${query}` : pathname;
}
