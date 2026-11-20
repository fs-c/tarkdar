// Stored settings: what a store is (key, schema version, defaults, migrations, checks) and how its
// stored form turns into the current one. Pure; the repository (repository.ts) does the storing.
//
// Stored as `{"$v": version, "data": …}`. Anything without `$v` is version 0: what older builds
// stored before there were versions. Loading runs the migrations from the stored version up to the
// current one, then `normalize`, which checks the result and fills in what's missing from the
// defaults. A new field with a default needs no migration (normalize fills it in); a rename, a
// restructure or a change of meaning does: bump `version` and add the step.

export interface StoreDef<T> {
  /** The storage key ("radar.list"). */
  key: string;
  /** The current schema version (≥ 1). */
  version: number;
  /** "user": the user's own (would follow them to another machine); "device": this screen's. */
  scope: "user" | "device";
  defaults: () => T;
  /** migrations[n] takes version n's data to version n + 1: pure functions on untrusted JSON. They
   *  run from the oldest one there is; data older than that is dropped for the defaults. */
  migrations: Readonly<Record<number, (old: any) => unknown>>;
  /** Run last on every load: checks the data, drops what's malformed, fills in the defaults. */
  normalize: (data: unknown) => T;
}

const registry = new Map<string, StoreDef<unknown>>();

/** Every store defined so far (for export, reset and the migration tests). */
export const allStores = (): StoreDef<unknown>[] => [...registry.values()];

export function defineStore<T>(def: StoreDef<T>): StoreDef<T> {
  if (!Number.isInteger(def.version) || def.version < 1) throw new Error(`${def.key}: version must be ≥ 1`);
  const steps = Object.keys(def.migrations).map(Number).sort((a, b) => a - b);
  steps.forEach((n, i) => {
    if (n !== def.version - steps.length + i) throw new Error(`${def.key}: migrations must run without gaps up to ${def.version - 1}`);
  });
  if (registry.has(def.key)) throw new Error(`${def.key}: defined twice`);
  registry.set(def.key, def as StoreDef<unknown>);
  return def;
}

export type DecodeStatus =
  /** Nothing stored. */
  | "empty"
  /** Stored at the current version. */
  | "current"
  /** Stored at an older version and migrated: to be written back. */
  | "migrated"
  /** Stored by a newer build: the defaults are used, and the stored data is left alone. */
  | "newer"
  /** Unreadable, too old, or a migration failed: the defaults (the stored data is to be backed up). */
  | "failed";

export interface Decoded<T> {
  value: T;
  status: DecodeStatus;
  /** The version it was stored at (0: no version). */
  from: number | null;
  error?: string;
}

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

export function decode<T>(def: StoreDef<T>, raw: string | null): Decoded<T> {
  if (raw === null) return { value: def.defaults(), status: "empty", from: null };
  let from: number | null = null;
  try {
    const parsed: unknown = JSON.parse(raw);
    const enveloped = isObject(parsed) && typeof parsed.$v === "number" && "data" in parsed;
    from = enveloped ? (parsed.$v as number) : 0;
    let data = enveloped ? parsed.data : parsed;
    if (from > def.version) return { value: def.defaults(), status: "newer", from };
    for (let v = from; v < def.version; v++) {
      const step = def.migrations[v];
      if (!step) throw new Error(`no migration from version ${v}`);
      data = step(data);
    }
    return { value: def.normalize(data), status: from === def.version ? "current" : "migrated", from };
  } catch (e) {
    return { value: def.defaults(), status: "failed", from, error: e instanceof Error ? e.message : String(e) };
  }
}

export const encode = <T>(def: StoreDef<T>, value: T): string => JSON.stringify({ $v: def.version, data: value });

/** Where `decode` puts stored data it couldn't use. */
export const backupKey = (key: string, from: number | null): string => `${key}@v${from ?? "?"}`;

/** A normalize for a flat settings object: each of the defaults' fields, taken from the stored data
 *  when it's of the same type (null counts as any type: nullable fields), else the default. */
export function flatNormalize<T extends object>(defaults: () => T): (data: unknown) => T {
  return (data) => {
    const out = defaults();
    if (!isObject(data)) return out;
    for (const k of Object.keys(out) as (keyof T & string)[]) {
      const v = data[k];
      const d = out[k] as unknown;
      if (v === undefined) continue;
      if (v === null || d === null || (typeof v === typeof d && Array.isArray(v) === Array.isArray(d))) out[k] = v as T[typeof k];
    }
    return out;
  };
}
