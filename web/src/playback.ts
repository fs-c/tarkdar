// The time cursor over a timeline: where the radar is in a raid's history, and playing it back.

import { useEffect, useRef, useState } from "react";

export const SPEEDS = [1, 2, 4, 8, 16];

/** "m:ss", or "h:mm:ss" from an hour. */
export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  const mmss = `${String(m).padStart(h ? 2 : 1, "0")}:${String(sec).padStart(2, "0")}`;
  return h ? `${h}:${mmss}` : mmss;
}

export interface Playback {
  /** Shown moment (ms since the epoch); null: live (the newest state, straight from the stream). */
  cursor: number | null;
  playing: boolean;
  speed: number;
  /** Moves the cursor (clamped to the range); null, or the end when following live: back to live. */
  seek: (t: number | null) => void;
  toggle: () => void;
  setSpeed: (speed: number) => void;
}

/**
 * `range`: what can be shown. `followsLive`: the end is "now" (a live raid), so reaching it goes back
 * to live; otherwise (a recording) playback stops there. `source` identifies what's shown: when it
 * changes, the cursor starts over (live, or the start of the recording).
 */
export function usePlayback(range: [number, number] | null, followsLive: boolean, source: string): Playback {
  const [state, setState] = useState<{ source: string; cursor: number | null; playing: boolean }>({
    source,
    cursor: null,
    playing: false,
  });
  const [speed, setSpeed] = useState(1);
  const rangeRef = useRef(range);
  rangeRef.current = range;

  // A new source: start over. (Adjusting state during render, keyed by source.)
  let current = state;
  if (state.source !== source || (!followsLive && state.cursor === null && range)) {
    current = { source, cursor: followsLive ? null : (range?.[0] ?? null), playing: false };
    setState(current);
  }

  const clamp = (t: number): number | null => {
    const r = rangeRef.current;
    if (!r) return null;
    if (followsLive && t >= r[1]) return null;
    return Math.min(Math.max(t, r[0]), r[1]);
  };

  useEffect(() => {
    if (!state.playing) return;
    let last = performance.now();
    let raf = 0;
    const frame = (now: number) => {
      const dt = now - last;
      last = now;
      setState((s) => {
        if (!s.playing || s.cursor === null) return { ...s, playing: false };
        const r = rangeRef.current;
        if (!r) return { ...s, playing: false };
        const next = s.cursor + dt * speed;
        if (next >= r[1]) return { ...s, cursor: followsLive ? null : r[1], playing: false };
        return { ...s, cursor: next };
      });
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [state.playing, speed, followsLive]);

  return {
    cursor: current.cursor,
    playing: current.playing,
    speed,
    seek: (t) => setState((s) => ({ ...s, cursor: t === null ? (followsLive ? null : (rangeRef.current?.[1] ?? null)) : clamp(t) })),
    toggle: () =>
      setState((s) => {
        if (s.playing) return { ...s, playing: false };
        const r = rangeRef.current;
        if (!r || s.cursor === null) return s; // live: nothing to play
        // At the end of a recording: play from the start.
        return { ...s, cursor: s.cursor >= r[1] ? r[0] : s.cursor, playing: true };
      }),
    setSpeed,
  };
}
