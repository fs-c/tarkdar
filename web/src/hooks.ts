// React glue for the non-React modules: connection, item catalogue, maps, persisted settings.

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { type CatalogStatus, loadCatalog } from "./catalog";
import { Connection, type RadarState } from "./connection";
import { type ItemCatalog, emptyCatalog } from "./items";
import { type LoadedMap, type MapEntry, fetchMapIndex, findMap, loadMap, selectLayer } from "./maps";
import type { Layers } from "./render";

/** Connects on mount, disconnects on unmount; re-renders on every state change. */
export function useConnection(url: string): RadarState {
  const [conn] = useState(() => new Connection(url));
  useEffect(() => {
    conn.start();
    return () => conn.stop();
  }, [conn]);
  return useSyncExternalStore(conn.subscribe, conn.getState);
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

/** The map for the raid location (null: no raid, or no map folder for it). Reloads on location change. */
export function useRaidMap(index: MapEntry[], locationId: string | null): LoadedMap | null {
  const [map, setMap] = useState<LoadedMap | null>(null);
  const [, setImagesLoaded] = useState(0); // images load into `map` in place: re-render to draw them
  const entry = locationId ? findMap(index, locationId) : undefined;
  useEffect(() => {
    if (!entry) return setMap(null);
    let live = true;
    try {
      setMap(loadMap(entry, () => live && setImagesLoaded((n) => n + 1)));
    } catch (e) {
      console.warn(`map ${entry.folder}: invalid calibration`, e);
      setMap(null);
    }
    return () => void (live = false);
  }, [entry]);
  return map;
}

/**
 * The floor the local player is on, with hysteresis (so it depends on the previous result). Kept in
 * a ref updated during render: selectLayer is idempotent for the same input, so re-renders are safe.
 */
export function useAutoLayer(map: LoadedMap | null, localY: number | null): number | null {
  const ref = useRef<{ map: LoadedMap | null; layer: number | null }>({ map: null, layer: null });
  if (ref.current.map !== map) ref.current = { map, layer: null };
  if (map && localY !== null)
    ref.current.layer = selectLayer(map.config.layers, localY, ref.current.layer, map.config.layerHysteresis);
  return ref.current.layer;
}

const LAYERS_KEY = "radar.layers";
const DEFAULT_LAYERS: Layers = { loot: false, containers: false, exfils: true, explosives: true };

export function useLayers(): [Layers, (key: keyof Layers) => void] {
  const [layers, setLayers] = useState<Layers>(() => {
    try {
      return { ...DEFAULT_LAYERS, ...(JSON.parse(localStorage.getItem(LAYERS_KEY) ?? "{}") as Partial<Layers>) };
    } catch {
      return DEFAULT_LAYERS;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(LAYERS_KEY, JSON.stringify(layers));
    } catch {
      // storage unavailable: settings just don't persist
    }
  }, [layers]);
  return [layers, (key) => setLayers((l) => ({ ...l, [key]: !l[key] }))];
}
