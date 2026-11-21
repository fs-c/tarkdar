// React glue for the connection: connects on mount, re-renders on every state change.

import { useEffect, useState, useSyncExternalStore } from "react";
import { Connection, type RadarState } from "./connection";
import { type Backfill, LiveTimeline } from "./liveTimeline";
import { fetchRecordings, ingestLine, readRecording } from "./recordings";

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
  read: (name, into, signal) => readRecording(name, (line) => ingestLine(into, line), signal),
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

