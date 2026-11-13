import { describe, expect, it, vi } from "vitest";
import { SlimCatalog, loadCatalog, slimCategories, slimItems } from "./catalog";
import { totalValue } from "./items";

const itemsFeed = {
  data: {
    items: {
      a: { id: "a", name: "a Name", shortName: "a ShortName", avg24hPrice: 1200, handbookCategories: ["elec", "barter"] },
      b: { id: "b", name: "b Name", shortName: "b ShortName", avg24hPrice: null, basePrice: 120 },
      c: { id: "c", name: "c Name", shortName: "c ShortName" },
      d: { id: "d", name: "d Name", shortName: "d ShortName", avg24hPrice: 900, basePrice: 500 },
    },
    handbookCategories: {
      barter: { id: "barter", name: "barter", normalizedName: "barter-items", parent: null },
      elec: { id: "elec", name: "elec", normalizedName: "electronics", parent: "barter" },
    },
  },
};
const enFeed = { data: { "a Name": "Alpha thing", "a ShortName": "Alpha", "b Name": "Bravo", barter: "Barter items" } };

class MemoryStorage {
  data = new Map<string, string>();
  getItem(k: string) { return this.data.get(k) ?? null; }
  setItem(k: string, v: string) { this.data.set(k, v); }
}

const okFetch = () =>
  vi.fn(async (url: string) => ({
    ok: true,
    status: 200,
    json: async () => (url.endsWith("items_en") ? enFeed : itemsFeed),
  })) as unknown as typeof fetch;

describe("slimItems", () => {
  it("resolves translations and keeps only name, short name and price", () => {
    const slim = slimItems(itemsFeed, enFeed);
    expect(slim.a).toEqual(["Alpha thing", "Alpha", 1200, 0, ["elec", "barter"]]);
    expect(slim.b).toEqual(["Bravo", "b ShortName", 120, 1]); // missing translation → key; base price
    expect(slim.c![2]).toBe(0); // no price at all
    expect(slim.d![2]).toBe(900); // flea price preferred over base price
    const cat = new SlimCatalog(slim);
    expect(cat.lookup("a")).toMatchObject({ price: 1200, priceSource: "flea" });
    expect(cat.lookup("b")).toMatchObject({ price: 120, priceSource: "base" });
    expect(cat.lookup("c")?.price).toBeUndefined();
    expect(cat.lookup("zzz")).toBeUndefined();
    expect(cat.lookup("constructor")).toBeUndefined();
  });
  it("keeps the handbook categories, with names and parents", () => {
    const cat = new SlimCatalog(slimItems(itemsFeed, enFeed), slimCategories(itemsFeed, enFeed));
    expect(cat.lookup("a")?.categories).toEqual(["elec", "barter"]);
    expect(cat.lookup("b")?.categories).toBeUndefined();
    expect(cat.categories()).toEqual([
      { id: "barter", name: "Barter items", parent: null, path: "" },
      { id: "elec", name: "electronics", parent: "barter", path: "Barter items" }, // untranslated: normalized name
    ]);
    expect([...cat.items()].map(([id]) => id)).toEqual(["a", "b", "c", "d"]);
    expect(slimCategories({ data: {} }, enFeed)).toEqual({});
  });
  it("rejects an unexpected format", () => {
    expect(() => slimItems({ nope: 1 }, enFeed)).toThrow();
  });
});

describe("loadCatalog", () => {
  it("downloads once, then serves from cache until it's a day old", async () => {
    const storage = new MemoryStorage();
    const fetchFn = okFetch();
    const first = await loadCatalog({ now: 1000, storage, fetchFn });
    expect(first.status.state).toBe("ready");
    expect(fetchFn).toHaveBeenCalledTimes(2);
    const second = await loadCatalog({ now: 1000 + 3600_000, storage, fetchFn });
    expect(second.catalog?.lookup("a")?.shortName).toBe("Alpha");
    expect(fetchFn).toHaveBeenCalledTimes(2); // cached
    await loadCatalog({ now: 1000 + 25 * 3600_000, storage, fetchFn });
    expect(fetchFn).toHaveBeenCalledTimes(4); // refreshed
  });
  it("falls back to a stale cache, or reports unavailable", async () => {
    const storage = new MemoryStorage();
    await loadCatalog({ now: 0, storage, fetchFn: okFetch() });
    const failing = vi.fn(async () => ({ ok: false, status: 503 })) as unknown as typeof fetch;
    const stale = await loadCatalog({ now: 48 * 3600_000, storage, fetchFn: failing });
    expect(stale.status.state).toBe("stale");
    expect(stale.catalog?.lookup("a")).toBeDefined();
    const none = await loadCatalog({ now: 0, storage: new MemoryStorage(), fetchFn: failing });
    expect(none.status.state).toBe("unavailable");
    expect(none.catalog).toBeNull();
  });
});

describe("totalValue", () => {
  it("multiplies by stack count and recurses", () => {
    const cat = new SlimCatalog({ ammo: ["Ammo", "A", 100, 1], gun: ["Gun", "G", 50000, 0] });
    expect(totalValue([{ tpl: "gun", items: [{ tpl: "ammo", count: 30 }, { tpl: "unknown" }] }], cat)).toBe(53000);
  });
});
