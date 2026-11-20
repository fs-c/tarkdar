import { dropLocalStorageCaches, isFresh, memoryCache, readCache, writeCache } from "./cache";

const isList = (d: unknown): d is number[] => Array.isArray(d);

describe("cache", () => {
  it("serves entries of its version that pass the check", async () => {
    const cache = memoryCache();
    await writeCache(cache, { key: "k", version: 2 }, [1, 2], 100);
    expect(await readCache(cache, { key: "k", version: 2 }, isList)).toEqual({ fetchedAt: 100, data: [1, 2] });
    expect(await readCache(cache, { key: "k", version: 3 }, isList)).toBeNull();
    expect(await readCache(cache, { key: "k", version: 2 }, (d): d is string => typeof d === "string")).toBeNull();
    expect(await readCache(cache, { key: "other", version: 2 }, isList)).toBeNull();
  });

  it("is fresh for maxAge, never from the future", () => {
    expect(isFresh({ fetchedAt: 100, data: 0 }, 150, 100)).toBe(true);
    expect(isFresh({ fetchedAt: 100, data: 0 }, 200, 100)).toBe(false);
    expect(isFresh({ fetchedAt: 100, data: 0 }, 50, 100)).toBe(false);
  });

  it("removes the feeds older builds cached in localStorage", () => {
    const data = new Map([["radar.items.v4", "x"], ["radar.quests.v5", "y"], ["radar.list", "z"]]);
    const storage = {
      get length() { return data.size; },
      key: (i: number) => [...data.keys()][i] ?? null,
      removeItem: (k: string) => void data.delete(k),
    } as unknown as Storage;
    dropLocalStorageCaches(storage);
    expect([...data.keys()]).toEqual(["radar.list"]);
  });
});
