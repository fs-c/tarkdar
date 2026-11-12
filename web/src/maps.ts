// Map folders served by the backend: maps/2d/<folder>/ (map.json plus the layer images) and
// maps/3d/<folder>/ (map.json plus a 3D dataset). Formats: docs/maps.md, docs/maps3d.md.

import { type Affine, type ControlPoint, fitTransform } from "./calibration";

export interface MapLayer {
  image: string;
  /** Upper bound (world y, metres) of this layer; omitted for the top layer. */
  maxY?: number;
}

export interface MapConfig {
  name: string;
  ids: string[];
  calibration: { points: ControlPoint[] };
  layers: MapLayer[];
  layerHysteresis?: number;
}

/** A folder of maps/2d: map images with a calibration. */
export interface Map2DEntry {
  kind: "2d";
  folder: string;
  config: MapConfig;
}

/** A folder of maps/3d: a 3D dataset (map3d/dataset.ts). World coordinates are the game's, no calibration. */
export interface Map3DEntry {
  kind: "3d";
  folder: string;
  config: { name: string; ids: string[] };
}

export type MapEntry = Map2DEntry | Map3DEntry;

export interface LoadedMap {
  folder: string;
  config: MapConfig;
  transform: Affine;
  images: (HTMLImageElement | null)[]; // per layer; null while loading or on error
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
  const c = entry?.config as Partial<MapConfig> | undefined;
  const common =
    typeof entry?.folder === "string" && !!c && typeof c.name === "string" && Array.isArray(c.ids) && c.ids.every((x) => typeof x === "string");
  const ok =
    common &&
    (entry?.kind === "3d" ||
      (entry?.kind === "2d" &&
        Array.isArray(c.layers) &&
        c.layers.length > 0 &&
        c.layers.every((l) => typeof l?.image === "string" && (l.maxY === undefined || typeof l.maxY === "number")) &&
        Array.isArray(c.calibration?.points) &&
        c.calibration.points.every(
          (p) => Array.isArray(p?.world) && p.world.length === 2 && Array.isArray(p?.pixel) && p.pixel.length === 2,
        )));
  if (!ok) console.warn(`maps: ignoring malformed map folder ${String(entry?.kind)}/${String(entry?.folder)}`, e);
  return ok;
}

/**
 * The map whose ids contain the location id (case-insensitive). When a location has both, the 3D
 * map wins unless `prefer2d`.
 */
export function findMap(index: MapEntry[], locationId: string, prefer2d = false): MapEntry | undefined {
  const id = locationId.toLowerCase();
  const matches = index.filter((m) => m.config.ids.some((x) => x.toLowerCase() === id));
  const first = prefer2d ? "2d" : "3d";
  return matches.find((m) => m.kind === first) ?? matches[0];
}

/** URL of a 3D map's dataset folder. */
export const map3dUrl = (entry: Map3DEntry): string => `/maps/3d/${encodeURIComponent(entry.folder)}`;

export function loadMap(entry: Map2DEntry, onImageLoaded: () => void): LoadedMap {
  const map: LoadedMap = {
    folder: entry.folder,
    config: entry.config,
    transform: fitTransform(entry.config.calibration.points),
    images: entry.config.layers.map(() => null),
  };
  entry.config.layers.forEach((layer, i) => {
    const img = new Image();
    img.onload = () => {
      map.images[i] = img;
      onImageLoaded();
    };
    img.onerror = () => console.warn(`map ${entry.folder}: failed to load ${layer.image}`);
    img.src = `/maps/2d/${encodeURIComponent(entry.folder)}/${encodeURIComponent(layer.image)}`;
  });
  return map;
}

/**
 * Layer for height y: the first layer whose maxY is above y (the last layer has no bound).
 * Hysteresis: stay on the current layer until y is more than `hysteresis` beyond its bounds, so
 * walking on a staircase near a boundary doesn't flicker.
 */
export function selectLayer(layers: MapLayer[], y: number, current: number | null, hysteresis = 0.5): number {
  if (layers.length === 0) return 0;
  const lower = (i: number) => (i === 0 ? -Infinity : (layers[i - 1]!.maxY ?? Infinity));
  const upper = (i: number) => layers[i]!.maxY ?? Infinity;
  if (current !== null && current >= 0 && current < layers.length) {
    if (y >= lower(current) - hysteresis && y < upper(current) + hysteresis) return current;
  }
  for (let i = 0; i < layers.length; i++) if (y < upper(i)) return i;
  return layers.length - 1;
}
