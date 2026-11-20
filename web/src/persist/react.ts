// React glue: a store's value, shared by everything that uses it (and by other tabs).

import { useCallback, useSyncExternalStore } from "react";
import { settings } from ".";
import type { StoreDef } from "./store";

export type SetStored<T> = (update: T | ((prev: T) => T)) => void;

export function usePersisted<T>(def: StoreDef<T>): [T, SetStored<T>] {
  const subscribe = useCallback((l: () => void) => settings.subscribe(def, l), [def]);
  const value = useSyncExternalStore(subscribe, () => settings.get(def));
  const set = useCallback<SetStored<T>>((update) => settings.set(def, update), [def]);
  return [value, set];
}
