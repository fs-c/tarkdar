import { memoryBackend } from "./backend";
import { Repository } from "./repository";
import { type StoreDef, backupKey, decode, defineStore, encode, flatNormalize } from "./store";

interface Prefs {
  size: number;
  name: string;
  limit: number | null;
}

const defaults = (): Prefs => ({ size: 1, name: "a", limit: 5 });

let n = 0;
/** v0 stored `width` (now `size`), v1 stored size as a string. */
const def = (version = 3): StoreDef<Prefs> =>
  defineStore<Prefs>({
    key: `test.${n++}`,
    version,
    scope: "user",
    defaults,
    migrations: Object.fromEntries(
      Object.entries({
        0: ({ width, ...rest }: any) => ({ ...rest, size: width }),
        1: (d: any) => ({ ...d, size: Number(d.size) }),
        2: (d: any) => d,
      }).filter(([v]) => Number(v) < version),
    ),
    normalize: flatNormalize(defaults),
  });

describe("defineStore", () => {
  it("wants migrations without gaps up to the current version", () => {
    expect(() => defineStore({ key: "gap", version: 3, scope: "user", defaults, migrations: { 0: (d) => d, 2: (d) => d }, normalize: flatNormalize(defaults) })).toThrow();
    expect(() => defineStore({ key: "short", version: 3, scope: "user", defaults, migrations: { 0: (d) => d }, normalize: flatNormalize(defaults) })).toThrow();
    expect(() => defineStore({ key: "fresh", version: 1, scope: "user", defaults, migrations: {}, normalize: flatNormalize(defaults) })).not.toThrow();
  });
});

describe("decode", () => {
  it("migrates unversioned (v0) and older data step by step", () => {
    const d = def();
    expect(decode(d, JSON.stringify({ width: "4", name: "b" }))).toEqual({ value: { size: 4, name: "b", limit: 5 }, status: "migrated", from: 0 });
    expect(decode(d, JSON.stringify({ $v: 2, data: { size: 7 } })).value).toEqual({ size: 7, name: "a", limit: 5 });
    expect(decode(d, encode(d, { size: 2, name: "c", limit: null }))).toEqual({ value: { size: 2, name: "c", limit: null }, status: "current", from: 3 });
  });

  it("gives the defaults for nothing, garbage, too old or newer data", () => {
    const d = def();
    expect(decode(d, null)).toEqual({ value: defaults(), status: "empty", from: null });
    expect(decode(d, "{nope").status).toBe("failed");
    expect(decode(d, JSON.stringify({ $v: 4, data: {} })).status).toBe("newer");
    const fresh = defineStore<Prefs>({ key: "fresh2", version: 2, scope: "user", defaults, migrations: { 1: (x) => x }, normalize: flatNormalize(defaults) });
    expect(decode(fresh, JSON.stringify({ size: 3 }))).toMatchObject({ value: defaults(), status: "failed", from: 0 });
  });
});

describe("flatNormalize", () => {
  it("keeps the defaults' fields of the same type (null: any)", () => {
    expect(flatNormalize(defaults)({ size: "big", name: "x", limit: null, extra: 1 })).toEqual({ size: 1, name: "x", limit: null });
    expect(flatNormalize(defaults)([1, 2])).toEqual(defaults());
  });
});

describe("Repository", () => {
  it("migrates and writes back, backs up what it can't read, leaves newer data alone", async () => {
    const [a, b, c] = [def(), def(), def()];
    const backend = memoryBackend({ [a.key]: JSON.stringify({ width: 3 }), [b.key]: "garbage", [c.key]: JSON.stringify({ $v: 9, data: {} }) });
    const repo = new Repository();
    await repo.init(backend);
    expect(repo.get(a).size).toBe(3);
    expect(JSON.parse(backend.data.get(a.key)!)).toEqual({ $v: 3, data: { size: 3, name: "a", limit: 5 } });
    expect(repo.get(b)).toEqual(defaults());
    expect(backend.data.get(backupKey(b.key, null))).toBe("garbage");
    expect(JSON.parse(backend.data.get(b.key)!)).toEqual({ $v: 3, data: defaults() });
    repo.set(c, (p) => ({ ...p, size: 10 }));
    expect(repo.get(c).size).toBe(10);
    expect(backend.data.get(c.key)).toBe(JSON.stringify({ $v: 9, data: {} }));
    repo.reset(c);
    expect(JSON.parse(backend.data.get(c.key)!).$v).toBe(3);
  });

  it("notifies on changes, here and from elsewhere", async () => {
    const d = def();
    let push: (key: string, raw: string | null) => void = () => {};
    const backend = { ...memoryBackend(), subscribe: (f: typeof push) => ((push = f), () => {}) };
    const repo = new Repository();
    await repo.init(backend);
    const seen = vi.fn();
    repo.subscribe(d, seen);
    repo.set(d, { size: 2, name: "b", limit: 1 });
    push(d.key, backend.data.get(d.key)!); // our own change coming back
    push(d.key, JSON.stringify({ width: 8 }));
    expect(seen).toHaveBeenCalledTimes(2);
    expect(repo.get(d).size).toBe(8);
  });

  it("refuses to be used before init", () => {
    expect(() => new Repository().get(def())).toThrow(/before init/);
  });
});
