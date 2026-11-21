import { useEffect } from "react";
import type { Map3D } from "../map3d/Map3D";
import type { MapSettings } from "../map3d/settings";
import { isTyping, useHotkeys } from "../ui";

const MOVE_KEYS = new Set(["KeyW", "KeyA", "KeyS", "KeyD"]);

interface Options {
  mapRef: { readonly current: Map3D | null };
  controls: MapSettings["controls"];
  /** Indoor map: Page Up / Page Down step the floor. */
  interior: boolean;
  stepFloor: (direction: 1 | -1) => void;
}

/** The map's keyboard: zoom (+ - 0), floors (Page Up / Page Down), and WASD panning in that scheme. */
export function useMapKeys({ mapRef, controls, interior, stepFloor }: Options) {
  useHotkeys([
    ...(interior
      ? [
          { key: "PageUp", repeat: true, description: "Show a higher floor", handler: (e: KeyboardEvent) => { e.preventDefault(); stepFloor(1); } },
          { key: "PageDown", repeat: true, description: "Show a lower floor", handler: (e: KeyboardEvent) => { e.preventDefault(); stepFloor(-1); } },
        ]
      : []),
    { key: ["+", "="], repeat: true, description: "Zoom in", handler: () => mapRef.current?.zoomBy(1.25) },
    { key: "-", repeat: true, description: "Zoom out", handler: () => mapRef.current?.zoomBy(0.8) },
    { key: "0", repeat: true, description: "Reset the view", handler: () => mapRef.current?.resetView() },
  ]);

  // WASD scheme: held keys move the view. By key position (e.code), so it works on any layout.
  // Held keys, not key presses (keydown and keyup both), so it stays its own listener, not a hotkey.
  useEffect(() => {
    if (controls !== "wasd") return;
    const held = new Set<string>();
    let fast = false;
    const apply = () => {
      const axis = (plus: string, minus: string) => (held.has(plus) ? 1 : 0) - (held.has(minus) ? 1 : 0);
      mapRef.current?.setMotion(axis("KeyD", "KeyA"), axis("KeyW", "KeyS"), fast);
    };
    const onKey = (e: KeyboardEvent) => {
      const down = e.type === "keydown";
      fast = e.shiftKey;
      if (MOVE_KEYS.has(e.code)) {
        if (down && (isTyping(e) || e.ctrlKey || e.metaKey || e.altKey)) return;
        if (down) held.add(e.code);
        else held.delete(e.code);
      }
      apply();
    };
    const release = () => {
      held.clear();
      apply();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("keyup", onKey);
    window.addEventListener("blur", release);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("keyup", onKey);
      window.removeEventListener("blur", release);
      release();
    };
  }, [controls]);
}
