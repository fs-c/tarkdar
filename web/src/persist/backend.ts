// Where stored settings live: raw strings by key. The repository only sees this interface, so
// localStorage can be swapped for something else (the backend server) without touching the stores.

export interface Backend {
  /** Everything stored, by key. */
  loadAll(): Promise<Map<string, string>>;
  /** null: remove. Backends that write remotely can batch. */
  save(key: string, raw: string | null): void;
  /** Changes made elsewhere (another tab). */
  subscribe?(onChange: (key: string, raw: string | null) => void): () => void;
}

/** The browser's localStorage: the keys starting with `prefix`. */
export function localStorageBackend(prefix = "radar.", storage: Storage = localStorage): Backend {
  let warned = false;
  return {
    loadAll: async () => {
      const out = new Map<string, string>();
      try {
        for (let i = 0; i < storage.length; i++) {
          const key = storage.key(i);
          const raw = key?.startsWith(prefix) ? storage.getItem(key) : null;
          if (key && raw !== null) out.set(key, raw);
        }
      } catch (e) {
        console.warn("settings storage unavailable", e);
      }
      return out;
    },
    save: (key, raw) => {
      try {
        if (raw === null) storage.removeItem(key);
        else storage.setItem(key, raw);
      } catch (e) {
        // Full or unavailable: settings just don't persist.
        if (!warned) console.warn(`couldn't store ${key}`, e);
        warned = true;
      }
    },
    subscribe: (onChange) => {
      const listener = (e: StorageEvent) => {
        if (e.storageArea === storage && e.key?.startsWith(prefix)) onChange(e.key, e.newValue);
      };
      addEventListener("storage", listener);
      return () => removeEventListener("storage", listener);
    },
  };
}

/** In memory (tests). */
export function memoryBackend(initial: Record<string, string> = {}): Backend & { data: Map<string, string> } {
  const data = new Map(Object.entries(initial));
  return {
    data,
    loadAll: async () => new Map(data),
    save: (key, raw) => void (raw === null ? data.delete(key) : data.set(key, raw)),
  };
}
