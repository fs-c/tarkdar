// React glue for the non-React modules: connection, item catalogue, maps. (Stored settings: prefs.ts.)

import { useEffect, useState, useSyncExternalStore } from "react";
import { type CatalogStatus, loadCatalog } from "./catalog";
import { type QuestData, loadQuestData } from "./quests";
import { Connection, type RadarState } from "./connection";
import { type Backfill, LiveTimeline } from "./liveTimeline";
import { fetchRecordings, parseLine, readRecording } from "./recordings";
import { type ItemCatalog, emptyCatalog } from "./items";
import { type MapEntry, fetchMapIndex } from "./maps";

export interface LiveState {
  state: RadarState;
  /** The current raid's history (null outside a raid). */
  live: LiveTimeline;
  /** Changes whenever the live timeline does. */
  liveVersion: number;
  /** For sending to the backend (the overlay's configuration). */
  conn: Connection;
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
  return { state, live, liveVersion, conn };
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

// Quest data (which quest needs which quest item): like the item data, once per page load.
let questDataLoad: ReturnType<typeof loadQuestData> | null = null;

export function useQuestData(): QuestData {
  const [state, setState] = useState<QuestData>({ tasks: null, items: null, outline: null, names: null, status: { state: "loading", fetchedAt: null } });
  useEffect(() => {
    let live = true;
    void (questDataLoad ??= loadQuestData()).then((loaded) => {
      if (!live) return;
      if (loaded.status.error) console.warn("quest data:", loaded.status.error);
      setState(loaded);
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

/** Keyboard shortcuts must not fire while the user types into a field. */
export function isTyping(e: KeyboardEvent): boolean {
  const t = e.target;
  return t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement;
}
