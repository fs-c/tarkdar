// Stored settings (see store.ts). `settings` is the app's repository: main.tsx initialises it with
// localStorage before the first render.

export { settings } from "./settings";
export { defineStore, flatNormalize, isHexColor, isObject, oneOf, type StoreDef } from "./store";
export { localStorageBackend } from "./backend";
export { usePersisted, type SetStored } from "./react";
