import { describe, expect, it } from "vitest";
import { applyRules } from "../rules/rules";
import { emptyCatalog } from "../model/items";
import type { AnyRow } from "../list/rows";
import { markerStore, layerStore, type WatchEntry } from "./prefs";
import { watchRules, watchesPlayers } from "./rules";
import { tierOf } from "./tiers";

const item = (id: number, value?: number): AnyRow =>
  ({ key: `loot:${id}`, sel: { kind: "loot", id }, subject: "item", pos: [0, 0, 0], tpls: [], search: "ledx", value, name: "LEDX", shortName: "LEDX", kind: "item", basePrice: false, slots: 1 }) as AnyRow;
const boss = (id: number): AnyRow =>
  ({ key: `player:${id}`, sel: { kind: "player", id }, subject: "player", pos: [0, 0, 0], tpls: [], search: "killa", name: "Killa", local: false, ai: true, type: "boss", typeLabel: "Killa", typeDetail: "", state: "alive" }) as AnyRow;

const entry = (patch: Partial<WatchEntry>): WatchEntry => ({ id: "1", label: "x", query: "ledx", color: "#ff8a3d", level: "high", on: true, ...patch });

describe("watch rules", () => {
  const markers = markerStore.defaults();
  const layers = layerStore.defaults();

  it("tells entries for players from entries for things", () => {
    expect(watchesPlayers("is:boss")).toBe(true);
    expect(watchesPlayers("is:raider,rogue")).toBe(true);
    expect(watchesPlayers("is:item value>=50k")).toBe(false);
    expect(watchesPlayers("ledx")).toBe(false);
  });

  it("lets the highest level win, whatever the order", () => {
    // A valuable item (layer: High, white) watched at Low stays High; watched at Top it's the entry's.
    const low = watchRules(markers, layers, [entry({ level: "low" })]);
    expect(applyRules([item(1, 500_000)], low, emptyCatalog).styles.get("loot:1")).toMatchObject({ color: "#ffffff", emphasis: "strong" });
    const top = watchRules(markers, layers, [entry({ level: "top" })]);
    expect(applyRules([item(1, 500_000)], top, emptyCatalog).styles.get("loot:1")).toMatchObject({ color: "#ff8a3d", emphasis: "loud", ring: "#ff8a3d" });
  });

  it("shows watched things even when their layer is off", () => {
    const rules = watchRules(markers, { ...layers, loot: "off" }, [entry({ level: "normal" })]);
    expect(applyRules([item(1, 1000)], rules, emptyCatalog).styles.get("loot:1")?.show).not.toBeNull();
    expect(applyRules([item(1, 1000)], watchRules(markers, { ...layers, loot: "off" }, []), emptyCatalog).styles.get("loot:1")?.show).toBeNull();
  });

  it("gives players their tier's level, raised and ringed by an entry watching them", () => {
    expect(applyRules([boss(5)], watchRules(markers, layers, []), emptyCatalog).styles.get("player:5")).toMatchObject({ color: "#ff4fd8", emphasis: "loud" });
    const scavs = { ...markers, tiers: { ...markers.tiers, boss: { level: "low" as const, color: "#ff4fd8" } } };
    const st = applyRules([boss(5)], watchRules(scavs, layers, [entry({ query: "is:boss", level: "high" })]), emptyCatalog).styles.get("player:5");
    expect(st).toMatchObject({ emphasis: "strong", ring: "#ff8a3d" });
  });

  it("puts every player type in a tier, but the local player", () => {
    expect(tierOf("usec")).toBe("pmc");
    expect(tierOf("rogue")).toBe("raider");
    expect(tierOf("self")).toBeNull();
  });
});
