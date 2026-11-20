// Stored settings (see store.ts). `settings` is the app's repository: main.tsx initialises it with
// localStorage before the first render.

import { Repository } from "./repository";

export const settings = new Repository();
export { defineStore, flatNormalize, type StoreDef } from "./store";
export { localStorageBackend } from "./backend";
