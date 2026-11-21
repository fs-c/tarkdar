// The theme in use: a tiny store. Canvas code reads it when it draws (getTheme()), React through
// useTheme(). Applying it to the page (CSS variables) is apply.ts; keeping it in the settings is
// main.tsx's job: this module knows neither.

import { useSyncExternalStore } from "react";
import { type Theme, findTheme } from "./themes";

let current = findTheme(undefined);
const listeners = new Set<() => void>();

export const getTheme = (): Theme => current;

/** Switches to the theme with this id (the default for an unknown one) and tells the subscribers. */
export function setTheme(id: string): void {
  const next = findTheme(id);
  if (next === current) return;
  current = next;
  for (const l of [...listeners]) l();
}

/** Calls `listener` after every change of theme; returns the unsubscribe. */
export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export const useTheme = (): Theme => useSyncExternalStore(subscribe, getTheme);
