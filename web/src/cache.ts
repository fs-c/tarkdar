// Cached downloads (the item feed), kept apart from the settings (persist/): disposable,
// so no migrations: an entry of another version is just not there. In IndexedDB, which holds far more
// than localStorage and doesn't share its quota with the settings.

import { isObject } from "./persist/store";

export interface CacheDef {
  key: string;
  /** Bumped when what's cached changes shape: older entries are ignored (and overwritten). */
  version: number;
}

export interface Cached<T> {
  fetchedAt: number; // ms since epoch
  data: T;
}

/** Entries by key: { version, fetchedAt, data }. */
export interface Cache {
  get(key: string): Promise<unknown>;
  put(key: string, entry: unknown): Promise<void>;
  delete(key: string): Promise<void>;
}

/** The entry if it's of this version and its data passes `check`. */
export async function readCache<T>(cache: Cache, def: CacheDef, check: (data: unknown) => data is T): Promise<Cached<T> | null> {
  try {
    const e = await cache.get(def.key);
    return isObject(e) && e.version === def.version && typeof e.fetchedAt === "number" && check(e.data) ? { fetchedAt: e.fetchedAt, data: e.data } : null;
  } catch {
    return null;
  }
}

export async function writeCache<T>(cache: Cache, def: CacheDef, data: T, now: number): Promise<void> {
  try {
    await cache.put(def.key, { version: def.version, fetchedAt: now, data });
  } catch (e) {
    console.warn(`couldn't cache ${def.key}`, e);
  }
}

/** Younger than maxAgeMs (an entry from the future, after a clock change, isn't). */
export const isFresh = (c: Cached<unknown>, now: number, maxAgeMs: number): boolean => now - c.fetchedAt >= 0 && now - c.fetchedAt < maxAgeMs;

/** IndexedDB (opened on first use). Unavailable: nothing is cached. */
export function idbCache(dbName = "radar", storeName = "cache"): Cache {
  let db: Promise<IDBDatabase> | null = null;
  const open = () =>
    (db ??= new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open(dbName, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(storeName);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    }));
  const run = async <R,>(mode: IDBTransactionMode, op: (s: IDBObjectStore) => IDBRequest<R>): Promise<R> => {
    const tx = (await open()).transaction(storeName, mode);
    return new Promise<R>((resolve, reject) => {
      const req = op(tx.objectStore(storeName));
      tx.oncomplete = () => resolve(req.result);
      tx.onerror = tx.onabort = () => reject(tx.error ?? req.error);
    });
  };
  return {
    get: (key) => run("readonly", (s) => s.get(key)),
    put: async (key, entry) => void (await run("readwrite", (s) => s.put(entry, key))),
    delete: async (key) => void (await run("readwrite", (s) => s.delete(key))),
  };
}

/** In memory (tests). */
export function memoryCache(): Cache & { data: Map<string, unknown> } {
  const data = new Map<string, unknown>();
  return { data, get: async (k) => data.get(k), put: async (k, e) => void data.set(k, e), delete: async (k) => void data.delete(k) };
}

/** The app's cache. */
export const feedCache: Cache = idbCache();

/** Feeds no longer downloaded: their entries are removed. ("quests": tarkov.dev's tasks feed, replaced
 *  by quest templates read from game memory.) */
export async function dropRetiredCaches(cache: Cache = feedCache): Promise<void> {
  try {
    await cache.delete("quests");
  } catch {
    // unavailable: nothing to remove
  }
}

/** Older builds cached the feeds in localStorage (radar.items.v4, radar.quests.v5, …): removed. */
export function dropLocalStorageCaches(storage: Storage = localStorage): void {
  try {
    const old: string[] = [];
    for (let i = 0; i < storage.length; i++) {
      const key = storage.key(i);
      if (key && /^radar\.(items|quests)\.v\d+$/.test(key)) old.push(key);
    }
    old.forEach((k) => storage.removeItem(k));
  } catch {
    // storage unavailable: nothing to remove
  }
}
