import { describe, expect, it } from "vitest";
import { type ItemCatalog, type ItemInfo, emptyCatalog } from "../items";
import type { LootEntry, Player } from "../protocol";
import { DEFAULT_FILTERS, type TabFilter, buildRows, filterRows, isFiltered, normalizeFilters, rowKeys, tabOf, withDistances } from "./rows";

const info: Record<string, ItemInfo> = {
  ledx: { name: "LEDX Skin Transilluminator", shortName: "LEDX", price: 900_000, priceSource: "flea" },
  bolts: { name: "Bolts", shortName: "Bolts", price: 12_000, priceSource: "flea" },
  rub: { name: "Roubles", shortName: "RUB", price: 1, priceSource: "base" },
  m4: { name: "Colt M4A1 5.56x45 assault rifle", shortName: "M4A1", price: 40_000, priceSource: "flea" },
  helmet: { name: "Altyn bulletproof helmet", shortName: "Altyn", price: 60_000, priceSource: "flea" },
};
const catalog: ItemCatalog = { ...emptyCatalog, lookup: (tpl) => info[tpl] };

const player = (id: number, extra: Partial<Player> = {}): Player =>
  ({ id, local: false, ai: true, side: "savage", dead: false, absent: false, pos: [0, 0, 0], yaw: 0, pitch: 0, ...extra });
const loot = (id: number, kind: LootEntry["kind"], tpl: string, extra: Partial<LootEntry> = {}): LootEntry =>
  ({ id, kind, tpl, obj: "", pos: [10, 0, 0], ...extra });

const state = {
  players: [player(1, { local: true, ai: false, side: "usec", pos: [0, 5, 0] }), player(2, { voice: "BossBully", dead: true }), player(3, { ai: false, side: "bear", pos: [30, 9, 40] })],
  loot: [
    loot(10, "item", "ledx"),
    loot(11, "item", "bolts"),
    loot(12, "quest", "unknown"),
    loot(20, "container", "578f8782245977354405a1e3"),
    loot(21, "corpse", "", { contents: [{ tpl: "m4", slot: "FirstPrimaryWeapon" }, { tpl: "helmet", slot: "Headwear" }] }),
  ],
  exfils: [{ id: 1, kind: "regular" as const, name: "Gate 3", status: 4, pos: null }],
  explosives: { grenades: [{ id: 1, pos: [1, 0, 1] as [number, number, number] }], tripwires: [{ id: 1, from: [0, 0, 0] as [number, number, number], to: [4, 0, 0] as [number, number, number] }] },
  equipment: new Map([[3, { id: 3, slots: [{ tpl: "m4", slot: "FirstPrimaryWeapon" }] }]]),
};

describe("buildRows", () => {
  const rows = buildRows(state, catalog);

  it("splits loot into items and containers (corpses count as containers)", () => {
    expect(rows.items.map((r) => r.sel.id)).toEqual([10, 11, 12]);
    expect(rows.containers.map((r) => [r.sel.id, r.kind])).toEqual([[20, "container"], [21, "corpse"]]);
  });

  it("knows what players and corpses carry (and what it's worth); containers carry nothing", () => {
    expect(rows.containers[0]).toMatchObject({ name: "Safe", subject: "container", tpls: [] });
    expect(rows.containers[0]!.value).toBeUndefined();
    expect(rows.containers[1]).toMatchObject({ subject: "corpse", tpls: ["m4", "helmet"], value: 100_000 });
    expect(rows.players[2]).toMatchObject({ subject: "player", tpls: ["m4"], value: 40_000 });
    expect(rows.items[0]).toMatchObject({ subject: "item", tpls: ["ledx"], value: 900_000 });
    expect(rows.items[2]).toMatchObject({ subject: "quest", value: undefined });
  });

  it("names things from the catalogue, with fallbacks", () => {
    expect(rows.items[0]).toMatchObject({ shortName: "LEDX" });
    expect(rows.items[2]).toMatchObject({ name: "quest item", kind: "quest" });
    expect(rows.players.map((p) => p.name)).toEqual(["You", "#2", "#3"]);
    expect(rows.players[1]).toMatchObject({ type: "boss", typeLabel: "Reshala", state: "dead" });
  });

  it("puts tripwires at their midpoint, with their length", () => {
    expect(rows.explosives[1]).toMatchObject({ kind: "tripwire", pos: [2, 0, 0], length: 4 });
  });
});

describe("withDistances", () => {
  it("adds horizontal distance and height difference; leaves unknown positions alone", () => {
    const rows = buildRows(state, catalog);
    const p = withDistances(rows.players, [0, 5, 0]);
    expect(p[2]).toMatchObject({ dist: 50, dh: 4 });
    const e = withDistances(rows.exfils, [0, 5, 0]);
    expect(e[0]!.dist).toBeUndefined();
    expect(withDistances(rows.players, null)).toBe(rows.players);
  });
});

describe("filterRows", () => {
  const rows = buildRows(state, catalog);
  const f = (patch: Partial<TabFilter>): TabFilter => ({ text: "", ...patch });

  it("matches every term, case-insensitively, including carried equipment", () => {
    expect(filterRows("items", rows.items, f({ text: "ledx" })).map((r) => r.sel.id)).toEqual([10]);
    expect(filterRows("items", rows.items, f({ text: "skin LED" })).map((r) => r.sel.id)).toEqual([10]);
    expect(filterRows("items", rows.items, f({ text: "skin bolts" }))).toEqual([]);
    expect(filterRows("containers", rows.containers, f({ text: "altyn" })).map((r) => r.sel.id)).toEqual([21]);
    expect(filterRows("players", rows.players, f({ text: "reshala" })).map((r) => r.sel.id)).toEqual([2]);
    expect(filterRows("players", rows.players, f({ text: "m4a1" })).map((r) => r.sel.id)).toEqual([3]);
  });

  it("applies the per-tab toggles", () => {
    expect(filterRows("players", rows.players, f({ alive: true })).map((r) => r.sel.id)).toEqual([1, 3]);
    expect(filterRows("players", rows.players, f({ humans: true })).map((r) => r.sel.id)).toEqual([1, 3]);
    expect(filterRows("items", rows.items, f({ minValue: 50_000 })).map((r) => r.sel.id)).toEqual([10]);
  });

  it("returns the rows as they are when nothing filters", () => {
    expect(filterRows("items", rows.items, DEFAULT_FILTERS.items)).toBe(rows.items);
  });
});

describe("tabOf", () => {
  it("finds the tab of a selection", () => {
    const s = { ...state, connected: true, protocolMismatch: false, live: true, status: null, raid: 1, playersAt: 0 };
    expect(tabOf({ kind: "loot", id: 20 }, s)).toBe("containers");
    expect(tabOf({ kind: "loot", id: 10 }, s)).toBe("items");
    expect(tabOf({ kind: "loot", id: 99 }, s)).toBeUndefined();
    expect(tabOf({ kind: "tripwire", id: 1 }, s)).toBeUndefined(); // no explosives tab
  });
});

describe("map filtering helpers", () => {
  it("counts blank text as unfiltered", () => {
    expect(isFiltered(DEFAULT_FILTERS)).toBe(false);
    expect(isFiltered({ ...DEFAULT_FILTERS, items: { text: "  " } })).toBe(false);
    expect(isFiltered({ ...DEFAULT_FILTERS, players: { text: "", humans: true } })).toBe(true);
  });
  it("collects the keys of all tabs' rows", () => {
    const rows = buildRows(state, catalog);
    const keys = rowKeys({ ...rows, items: filterRows("items", rows.items, { text: "ledx" }) });
    expect(keys.has("loot:10")).toBe(true);
    expect(keys.has("loot:11")).toBe(false);
    expect(keys.has("player:3")).toBe(true);
    expect(keys.has("grenade:1")).toBe(true);
  });
});

describe("special filter", () => {
  const players = buildRows(
    { ...state, players: [player(1, { role: 1 }), player(2, { role: 6 }), player(3, { ai: false, side: "bear" })] },
    catalog,
  ).players;
  it("keeps special bots, or special bots and humans together", () => {
    expect(filterRows("players", players, { text: "", special: true }).map((r) => r.sel.id)).toEqual([2]);
    expect(filterRows("players", players, { text: "", special: true, humans: true }).map((r) => r.sel.id)).toEqual([2, 3]);
  });
});

describe("normalizeFilters", () => {
  it("replaces filters stored by older versions (one set for all tabs) with the defaults", () => {
    expect(normalizeFilters({ text: "ledx", aliveOnly: true, minValue: 0 })).toEqual(DEFAULT_FILTERS);
    expect(normalizeFilters(null)).toEqual(DEFAULT_FILTERS);
  });
  it("keeps per-tab filters, filling in what's missing", () => {
    const f = normalizeFilters({ items: { text: "gpu" }, players: "nonsense" });
    expect(f.items).toEqual({ text: "gpu", minValue: 0 });
    expect(f.players).toEqual(DEFAULT_FILTERS.players);
  });
});
