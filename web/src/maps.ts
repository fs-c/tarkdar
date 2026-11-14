// Map folders served by the backend: maps/3d/<folder>/ (map.json plus a 3D dataset). Format:
// docs/maps3d.md.

/** A folder of maps/3d: a 3D dataset (map3d/dataset.ts). World coordinates are the game's. */
export interface MapEntry {
  folder: string;
  config: { name: string; ids: string[] };
}

export async function fetchMapIndex(): Promise<MapEntry[]> {
  const res = await fetch("/maps/index.json", { cache: "no-cache" });
  if (!res.ok) throw new Error(`maps/index.json: HTTP ${res.status}`);
  const data: unknown = await res.json();
  return Array.isArray(data) ? data.filter(validEntry) : [];
}

/** Drops malformed map folders (with a console warning) instead of breaking the page. */
export function validEntry(e: unknown): e is MapEntry {
  const entry = e as Partial<MapEntry> | null;
  const c = entry?.config as Partial<MapEntry["config"]> | undefined;
  const ok =
    typeof entry?.folder === "string" && !!c && typeof c.name === "string" && Array.isArray(c.ids) && c.ids.every((x) => typeof x === "string");
  if (!ok) console.warn(`maps: ignoring malformed map folder ${String(entry?.folder)}`, e);
  return ok;
}

/** The map whose ids contain the location id (case-insensitive). */
export function findMap(index: MapEntry[], locationId: string): MapEntry | undefined {
  const id = locationId.toLowerCase();
  return index.find((m) => m.config.ids.some((x) => x.toLowerCase() === id));
}

/** URL of a map's dataset folder. */
export const mapUrl = (entry: MapEntry): string => `/maps/3d/${encodeURIComponent(entry.folder)}`;
