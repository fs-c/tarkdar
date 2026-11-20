// The stored settings, in memory: loaded from a backend once at startup (`init`), read synchronously
// from then on, written through to the backend on every change. Each store's data is decoded
// (migrated, checked) the first time it's used.

import type { Backend } from "./backend";
import { backupKey, decode, encode, type StoreDef } from "./store";

interface Entry {
  def: StoreDef<unknown>;
  value: unknown;
  /** Stored by a newer build: changes stay in memory, the stored data is left alone. */
  readOnly: boolean;
  /** What was last written (or read), to ignore our own changes coming back. */
  raw: string | null;
  listeners: Set<() => void>;
}

export class Repository {
  private backend: Backend | null = null;
  private raw = new Map<string, string>();
  private entries = new Map<string, Entry>();
  private unsubscribe: (() => void) | null = null;

  async init(backend: Backend): Promise<void> {
    this.raw = await backend.loadAll();
    this.entries.clear();
    this.unsubscribe?.();
    this.backend = backend;
    this.unsubscribe = backend.subscribe?.((key, raw) => this.changedElsewhere(key, raw)) ?? null;
  }

  get<T>(def: StoreDef<T>): T {
    return this.entry(def).value as T;
  }

  set<T>(def: StoreDef<T>, update: T | ((prev: T) => T)): void {
    const e = this.entry(def);
    const value = typeof update === "function" ? (update as (prev: T) => T)(e.value as T) : update;
    if (Object.is(value, e.value)) return;
    e.value = value;
    if (!e.readOnly) {
      e.raw = encode(def, value);
      this.backend!.save(def.key, e.raw);
    }
    e.listeners.forEach((l) => l());
  }

  /** Back to the defaults (also overwrites data stored by a newer build). */
  reset<T>(def: StoreDef<T>): void {
    this.entry(def).readOnly = false;
    this.set(def, def.defaults());
  }

  subscribe<T>(def: StoreDef<T>, listener: () => void): () => void {
    const e = this.entry(def);
    e.listeners.add(listener);
    return () => e.listeners.delete(listener);
  }

  private entry<T>(def: StoreDef<T>): Entry {
    let e = this.entries.get(def.key);
    if (e) return e;
    if (!this.backend) throw new Error(`settings: ${def.key} used before init`);
    e = { def: def as StoreDef<unknown>, value: undefined, readOnly: false, raw: null, listeners: new Set() };
    this.load(def, e, this.raw.get(def.key) ?? null);
    this.entries.set(def.key, e);
    return e;
  }

  private load<T>(def: StoreDef<T>, e: Entry, raw: string | null): void {
    const d = decode(def, raw);
    e.value = d.value;
    e.raw = raw;
    e.readOnly = d.status === "newer";
    if (d.status === "newer") console.warn(`settings: ${def.key} was stored by a newer version (${d.from}); using the defaults, leaving it as it is`);
    if (d.status === "failed" && raw !== null) {
      console.warn(`settings: couldn't read ${def.key} (${d.error}); using the defaults, kept as ${backupKey(def.key, d.from)}`);
      this.backend!.save(backupKey(def.key, d.from), raw);
    }
    if (d.status === "migrated" || (d.status === "failed" && raw !== null)) {
      e.raw = encode(def, d.value);
      this.backend!.save(def.key, e.raw);
    }
  }

  private changedElsewhere(key: string, raw: string | null): void {
    if (raw === null) this.raw.delete(key);
    else this.raw.set(key, raw);
    const e = this.entries.get(key);
    if (!e || raw === e.raw) return;
    this.load(e.def, e, raw);
    e.listeners.forEach((l) => l());
  }
}
