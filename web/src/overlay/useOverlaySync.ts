// Sends the overlay's configuration (overlay/marks.ts) to the backend: when it changes (at most every
// SEND_INTERVAL ms), and again after every reconnect. Only while the backend runs the overlay.

import { useEffect, useRef } from "react";
import type { Connection } from "../stream/connection";
import type { OverlayData } from "../model/protocol";

export const SEND_INTERVAL = 250;

/** `data` null: nothing to say now (e.g. replaying a recording): the overlay keeps what it has. */
export function useOverlaySync(conn: Connection, available: boolean, connected: boolean, data: OverlayData | null): void {
  const sent = useRef<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latest = useRef<string | null>(null);
  const latestData = useRef<OverlayData | null>(null);
  latest.current = data && JSON.stringify(data);
  latestData.current = data;

  // A new connection (or a backend without the overlay) knows nothing of what was sent.
  useEffect(() => {
    sent.current = null;
  }, [connected, available]);

  useEffect(() => {
    if (!available || !connected || latest.current === null || latest.current === sent.current || timer.current) return;
    const flush = () => {
      timer.current = null;
      const text = latest.current, d = latestData.current;
      if (text === null || d === null || text === sent.current) return;
      if (conn.send({ type: "overlay", data: d })) sent.current = text;
    };
    // The first change at once; later ones batched.
    if (sent.current === null) flush();
    else timer.current = setTimeout(flush, SEND_INTERVAL);
  });

  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);
}
