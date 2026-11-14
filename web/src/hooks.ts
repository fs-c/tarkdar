// React glue for the non-React modules: connection, item catalogue, maps, persisted settings.

import { useEffect, useState, useSyncExternalStore } from "react";
import { type CatalogStatus, loadCatalog } from "./catalog";
import { Connection, type RadarState } from "./connection";
import { type Backfill, LiveTimeline } from "./liveTimeline";
import { fetchRecordings, parseLine, readRecording } from "./recordings";
import { type ItemCatalog, emptyCatalog } from "./items";
import { DEFAULT_MAP_SETTINGS, type MapSettings, type PlanPalette } from "./map3d/settings";
import { type MapEntry, fetchMapIndex } from "./maps";
import { DEFAULT_LOOT_DENSITY, type LootDensity } from "./declutter";
import type { Layers } from "./render";

export interface LiveState {
  state: RadarState;
  /** The current raid's history (null outside a raid). */
  live: LiveTimeline;
  /** Changes whenever the live timeline does. */
  liveVersion: number;
}

const backfill: Backfill = {
  active: async () => (await fetchRecordings()).find((r) => r.active) ?? null,
  read: (name, into, signal) => readRecording(name, (line) => {
    const msg = parseLine(line);
    if (msg) into.ingest(msg);
  }, signal),
};

/** Connects on mount, disconnects on unmount; re-renders on every state change. */
export function useConnection(url: string): LiveState {
  const [live] = useState(() => new LiveTimeline(backfill));
  const [conn] = useState(() => new Connection(url, (msg) => live.handle(msg)));
  useEffect(() => {
    conn.start();
    return () => conn.stop();
  }, [conn]);
  const state = useSyncExternalStore(conn.subscribe, conn.getState);
  const liveVersion = useSyncExternalStore(live.subscribe, live.getVersion);
  return { state, live, liveVersion };
}

// Item data (names, prices): loaded once per page load from tarkov.dev, cached for a day. Shared
// promise, so StrictMode's double mount doesn't download the feeds twice.
let catalogLoad: ReturnType<typeof loadCatalog> | null = null;

export interface CatalogState {
  catalog: ItemCatalog;
  status: CatalogStatus;
}

export function useCatalog(): CatalogState {
  const [state, setState] = useState<CatalogState>({
    catalog: emptyCatalog,
    status: { state: "loading", count: 0, fetchedAt: null },
  });
  useEffect(() => {
    let live = true;
    void (catalogLoad ??= loadCatalog()).then(({ catalog, status }) => {
      if (!live) return;
      if (status.error) console.warn("item data:", status.error);
      setState({ catalog: catalog ?? emptyCatalog, status });
    });
    return () => void (live = false);
  }, []);
  return state;
}

export function useMapIndex(): MapEntry[] {
  const [index, setIndex] = useState<MapEntry[]>([]);
  useEffect(() => {
    let live = true;
    fetchMapIndex().then(
      (i) => live && setIndex(i),
      (e: unknown) => console.warn("couldn't load the map index", e),
    );
    return () => void (live = false);
  }, []);
  return index;
}

/** How the 3D map is shown, and the map debugging tools. */
export interface MapPrefs extends MapSettings {
  /** The palette the user made (the last one they edited), kept while a pre-made one is in use. */
  customPalette: PlanPalette | null;
  /** Clicking the 3D map (not a marker) records the world position under the cursor. */
  coordinatePick: boolean;
  /** Up close, players are drawn as figures from their skeleton (3D map). */
  bodies: boolean;
}

export function useMapPrefs() {
  return usePersistentState<MapPrefs>("radar.map", { ...DEFAULT_MAP_SETTINGS, customPalette: null, coordinatePick: false, bodies: true });
}

/** useState persisted to localStorage (merged over the default, so new fields get their defaults). */
export function usePersistentState<T extends object>(key: string, initial: T): [T, (update: T | ((prev: T) => T)) => void] {
  const [value, setValue] = useState<T>(() => {
    try {
      const stored = JSON.parse(localStorage.getItem(key) ?? "null") as Partial<T> | null;
      return stored && typeof stored === "object" ? { ...initial, ...stored } : initial;
    } catch {
      return initial;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      // storage unavailable: settings just don't persist
    }
  }, [key, value]);
  return [value, setValue];
}

export interface TrailPrefs {
  /** The selected player's trail (whole raid). */
  selected: boolean;
  /** Everyone's trails. */
  all: boolean;
  /** Length of everyone's trails (minutes); null: the whole raid. */
  minutes: number | null;
}

export function useTrailPrefs() {
  return usePersistentState<TrailPrefs>("radar.trails", { selected: true, all: false, minutes: 5 });
}

export interface LootPrefs {
  /** Items worth less than this (₽, per unit) never get a map label; unpriced items count as 0. */
  minLabelPrice: number;
  /** Which loose item markers drop out as you zoom out (declutter.ts). */
  density: LootDensity;
}

export function useLootPrefs() {
  return usePersistentState<LootPrefs>("radar.loot", { minLabelPrice: 0, density: DEFAULT_LOOT_DENSITY });
}

const DEFAULT_LAYERS: Layers = { loot: false, containers: false, exfils: true, explosives: true };

export function useLayers(): [Layers, (key: keyof Layers) => void] {
  const [layers, setLayers] = usePersistentState("radar.layers", DEFAULT_LAYERS);
  return [layers, (key) => setLayers((l) => ({ ...l, [key]: !l[key] }))];
}

/** Keyboard shortcuts must not fire while the user types into a field. */
export function isTyping(e: KeyboardEvent): boolean {
  const t = e.target;
  return t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement;
}
