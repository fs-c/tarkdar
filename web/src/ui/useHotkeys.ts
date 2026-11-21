import { useEffect, useRef } from "react";
import { isTyping } from "./isTyping";

export interface Hotkey {
  /** KeyboardEvent.key (one or several that do the same). */
  key: string | readonly string[];
  /** Fires again while the key is held (default: a held key acts once). */
  repeat?: boolean;
  /** For whoever reads the table. */
  description: string;
  /** The handler calls preventDefault itself where the key's default must not happen. */
  handler: (e: KeyboardEvent) => void;
}

/**
 * Global shortcuts, declared where the state lives. Shared guards, so every shortcut behaves alike:
 * ignored while typing in a field, with ctrl/meta/alt held, and (unless `repeat`) on key repeat.
 * The table may change every render: the newest one is used (one listener for the component's life).
 */
export function useHotkeys(keys: readonly Hotkey[]): void {
  const table = useRef(keys);
  table.current = keys;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTyping(e) || e.ctrlKey || e.metaKey || e.altKey) return;
      const hotkey = table.current.find((h) => (typeof h.key === "string" ? h.key === e.key : h.key.includes(e.key)));
      if (!hotkey || (e.repeat && !hotkey.repeat)) return;
      hotkey.handler(e);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}
