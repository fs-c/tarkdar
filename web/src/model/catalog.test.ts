import { describe, expect, it, vi } from "vitest";
import { memoryCache } from "./cache";
import { SlimCatalog, estimatePrice, loadCatalog, slimCategories, slimItems } from "./catalog";
import { totalValue } from "./items";

const itemsFeed = {
  data: {
    items: {
      a: { id: "a", name: "a Name", shortName: "a ShortName", avg24hPrice: 1200, handbookCategories: ["elec", "barter"], width: 2, height: 1 },
      ammo: { id: "ammo", name: "ammo", shortName: "ammo", penetrationPower: 40, damage: 50, armorDamage: 45, width: 1, height: 1 },
      gun: { id: "gun", name: "gun", shortName: "gun", width: 2, height: 1, properties: { defaultWidth: 4, defaultHeight: 2 } },
      plate: { id: "plate", name: "plate", shortName: "plate", properties: { class: 5 } },
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


const okFetch = () =>
  vi.fn(async (url: string) => ({
    ok: true,
    status: 200,
    json: async () => (url.endsWith("items_en") ? enFeed : itemsFeed),
  })) as unknown as typeof fetch;

describe("slimItems", () => {
  it("resolves translations and keeps only name, short name, price, size and stats", () => {
    const slim = slimItems(itemsFeed, enFeed);
    expect(slim.a).toEqual({ name: "Alpha thing", shortName: "Alpha", price: 1200, priceSource: "flea", categories: ["elec", "barter"], slots: 2 });
    expect(slim.b).toEqual({ name: "Bravo", shortName: "b ShortName", price: 120, priceSource: "base" }); // missing translation → key
    expect(slim.c).toEqual({ name: "c Name", shortName: "c ShortName" }); // no price at all
    expect(slim.d).toMatchObject({ price: 900, priceSource: "flea" }); // flea price preferred over base price
    const cat = new SlimCatalog(slim);
    expect(cat.lookup("a")).toMatchObject({ price: 1200, priceSource: "flea" });
    expect(cat.lookup("b")).toMatchObject({ price: 120, priceSource: "base" });
    expect(cat.lookup("c")?.price).toBeUndefined();
    expect(cat.lookup("zzz")).toBeUndefined();
    expect(cat.lookup("constructor")).toBeUndefined();
    expect(cat.lookup("a")?.slots).toBe(2);
    expect(cat.lookup("b")?.slots).toBeUndefined();
    expect(cat.lookup("ammo")).toMatchObject({ penetration: 40, damage: 50, armorDamage: 45 });
    expect(cat.lookup("gun")?.slots).toBe(8); // as assembled
    expect(cat.lookup("plate")).toMatchObject({ armorClass: 5 });
    expect(cat.lookup("plate")?.categories).toBeUndefined();
  });
  it("keeps the handbook categories, with names and parents", () => {
    const cat = new SlimCatalog(slimItems(itemsFeed, enFeed), slimCategories(itemsFeed, enFeed));
    expect(cat.lookup("a")?.categories).toEqual(["elec", "barter"]);
    expect(cat.lookup("b")?.categories).toBeUndefined();
    expect(cat.categories()).toEqual([
      { id: "barter", name: "Barter items", parent: null, path: "" },
      { id: "elec", name: "electronics", parent: "barter", path: "Barter items" }, // untranslated: normalized name
    ]);
    expect([...cat.items()].map(([id]) => id)).toEqual(["a", "ammo", "gun", "plate", "b", "c", "d"]);
    expect(slimCategories({ data: {} }, enFeed)).toEqual({});
  });
  it("rejects an unexpected format", () => {
    expect(() => slimItems({ nope: 1 }, enFeed)).toThrow();
  });
});

describe("estimatePrice", () => {
  // Cases from tarkov.dev's PvP feed (2026-11-24).
  const trader = (price: number) => [{ trader: "54cb50c76803fa8b248b4571", priceRUB: price }];
  it("is the flea price in a steady market", () => {
    expect(estimatePrice({ avg24hPrice: 61183, lastLowPrice: 65000, changeLast48h: -14645, lastOfferCount: 15 })).toEqual({ price: 65000, source: "flea" });
    expect(estimatePrice({ avg24hPrice: 900 })).toEqual({ price: 900, source: "flea" });
  });
  it("is no more than the cheapest offer: nobody buys above it", () => {
    // Blue Folders: one 2.2M offer pulled the average up
    expect(estimatePrice({ avg24hPrice: 531222, lastLowPrice: 300000, changeLast48h: 42689, lastOfferCount: 20 })?.price).toBe(300000);
    // Radian Model 1: a 1.25M average yesterday, 555k today, but it's offered at 50k
    expect(estimatePrice({ avg24hPrice: 555555, lastLowPrice: 50000, changeLast48h: -700000, lastOfferCount: 3 })?.price).toBe(50000);
  });
  it("ignores a lone troll offer as the cheapest", () => {
    // USEC cottage key: the only offer is at 200k, it sold for ~26k
    expect(estimatePrice({ avg24hPrice: 26333, lastLowPrice: 200000, changeLast48h: -3000, lastOfferCount: 1 })?.price).toBe(29333);
    // the average is a troll offer, no history (change 0): the lower of the two
    expect(estimatePrice({ avg24hPrice: 100000, lastLowPrice: 5000, changeLast48h: 0, lastOfferCount: 2 })?.price).toBe(5000);
  });
  it("caps a thin market at 10× what traders sell it for", () => {
    // HK 416 buffer tube: one offer at 1M, Peacekeeper sells it for 6238
    const tube = { avg24hPrice: 1004074, lastLowPrice: 1004074, changeLast48h: 0, lastOfferCount: 1, buyFromTrader: trader(6238) };
    expect(estimatePrice(tube)).toEqual({ price: 62380, source: "flea" });
    expect(estimatePrice({ ...tube, lastOfferCount: 9 })?.price).toBe(1004074); // a liquid market is trusted
  });
  it("is at least what a trader pays", () => {
    // SCAR-L upper dumped at 70 ₽, Mechanic pays 2925
    const upper = { avg24hPrice: 70, lastLowPrice: 70, lastOfferCount: 1, sellToTrader: [...trader(1200), ...trader(2925)] };
    expect(estimatePrice(upper)).toEqual({ price: 2925, source: "trader" });
    expect(estimatePrice({ basePrice: 18397, sellToTrader: trader(8278) })).toEqual({ price: 8278, source: "trader" }); // no flea data
    expect(estimatePrice({ basePrice: 18397, sellToTrader: [{ trader: "flea-market", priceRUB: 9000 }] })?.source).toBe("base");
  });
  it("falls back to the base price, or nothing", () => {
    expect(estimatePrice({ basePrice: 122 })).toEqual({ price: 122, source: "base" });
    expect(estimatePrice({ avg24hPrice: null, basePrice: 0, sellToTrader: [] })).toBeUndefined();
  });
});

describe("loadCatalog", () => {
  it("downloads once, then serves from cache until it's a day old", async () => {
    const cache = memoryCache();
    const fetchFn = okFetch();
    const first = await loadCatalog({ now: 1000, cache, fetchFn });
    expect(first.status.state).toBe("ready");
    expect(fetchFn).toHaveBeenCalledTimes(2);
    const second = await loadCatalog({ now: 1000 + 3600_000, cache, fetchFn });
    expect(second.catalog?.lookup("a")?.shortName).toBe("Alpha");
    expect(fetchFn).toHaveBeenCalledTimes(2); // cached
    await loadCatalog({ now: 1000 + 25 * 3600_000, cache, fetchFn });
    expect(fetchFn).toHaveBeenCalledTimes(4); // refreshed
  });
  it("falls back to a stale cache, or reports unavailable", async () => {
    const cache = memoryCache();
    await loadCatalog({ now: 0, cache, fetchFn: okFetch() });
    const failing = vi.fn(async () => ({ ok: false, status: 503 })) as unknown as typeof fetch;
    const stale = await loadCatalog({ now: 48 * 3600_000, cache, fetchFn: failing });
    expect(stale.status.state).toBe("stale");
    expect(stale.catalog?.lookup("a")).toBeDefined();
    const none = await loadCatalog({ now: 0, cache: memoryCache(), fetchFn: failing });
    expect(none.status.state).toBe("unavailable");
    expect(none.catalog).toBeNull();
  });
});

describe("totalValue", () => {
  it("multiplies by stack count and recurses", () => {
    const cat = new SlimCatalog({ ammo: { name: "Ammo", shortName: "A", price: 100, priceSource: "base" }, gun: { name: "Gun", shortName: "G", price: 50000, priceSource: "flea" } });
    expect(totalValue([{ tpl: "gun", items: [{ tpl: "ammo", count: 30 }, { tpl: "unknown" }] }], cat)).toBe(53000);
  });
});
