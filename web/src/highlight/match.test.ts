import { describe, expect, it } from "vitest";
import { type ItemCatalog, type ItemInfo, emptyCatalog } from "../items";
import { buildRows } from "../list/rows";
import type { LootEntry, Player } from "../protocol";
import { type Highlight, HIGHLIGHT_COLORS, allRows, evaluateHighlights, matchingRows, nextColor } from "./match";

const info: Record<string, ItemInfo> = {
  ledx: { name: "LEDX Skin Transilluminator", shortName: "LEDX", price: 900_000, categories: ["medsupplies", "barter"] },
  gpu: { name: "Graphics card", shortName: "GPU", price: 400_000, categories: ["electronics", "barter"] },
  bolts: { name: "Bolts", shortName: "Bolts", price: 12_000, categories: ["building", "barter"] },
  m4: { name: "Colt M4A1", shortName: "M4A1", price: 40_000, categories: ["rifles", "weapons"] },
};
const catalog: ItemCatalog = { ...emptyCatalog, lookup: (tpl) => info[tpl] };

const player = (id: number, extra: Partial<Player> = {}): Player =>
  ({ id, local: false, ai: true, side: "savage", dead: false, absent: false, pos: [0, 0, 0], yaw: 0, pitch: 0, ...extra });
const loot = (id: number, kind: LootEntry["kind"], tpl: string, extra: Partial<LootEntry> = {}): LootEntry =>
  ({ id, kind, tpl, obj: "", pos: [10, 0, 0], ...extra });

const rows = allRows(
  buildRows(
    {
      players: [player(1, { local: true, ai: false, side: "usec" }), player(2, { role: 6 }), player(3, { ai: false, side: "bear" }), player(4, { role: 1 })],
      loot: [loot(10, "item", "ledx"), loot(11, "item", "gpu"), loot(12, "item", "bolts"), loot(13, "quest", "x"), loot(20, "corpse", "", { contents: [{ tpl: "m4" }] }), loot(21, "airdrop", "")],
      exfils: [],
      explosives: { grenades: [], tripwires: [] },
      equipment: new Map([[1, { id: 1, slots: [{ tpl: "m4" }] }], [3, { id: 3, slots: [{ tpl: "m4" }] }]]),
    },
    catalog,
  ),
);
const keys = (m: Parameters<typeof matchingRows>[1]) => matchingRows(rows, m, catalog).map((r) => r.key);

describe("matching", () => {
  it("matches items by category, and players and corpses carrying one (never us)", () => {
    expect(keys({ categories: ["barter"] })).toEqual(["loot:10", "loot:11", "loot:12"]);
    expect(keys({ categories: ["weapons"] })).toEqual(["player:3", "loot:20"]);
    expect(keys({ categories: ["electronics", "medsupplies"] })).toEqual(["loot:10", "loot:11"]);
  });
  it("matches templates, player types, kinds of things, values and text", () => {
    expect(keys({ tpls: ["gpu"] })).toEqual(["loot:11"]);
    expect(keys({ playerTypes: ["boss"] })).toEqual(["player:2"]);
    expect(keys({ subjects: ["quest", "airdrop"] })).toEqual(["loot:13", "loot:21"]);
    expect(keys({ subjects: ["item"], minValue: 100_000 })).toEqual(["loot:10", "loot:11"]);
    expect(keys({ text: "killa" })).toEqual(["player:2"]);
  });
  it("needs every given field to hold", () => {
    expect(keys({ categories: ["barter"], minValue: 500_000 })).toEqual(["loot:10"]);
  });
  it("matches nothing with an empty rule", () => {
    expect(keys({})).toEqual([]);
    expect(keys({ text: "  " })).toEqual([]);
  });
});

describe("evaluateHighlights", () => {
  const h = (id: number, color: string, match: Highlight["match"], on = true): Highlight => ({ id, label: "", group: "", match, color, on });

  it("colours each thing by the first highlight that's on and matches it; counts matches of all", () => {
    const st = evaluateHighlights(rows, [h(1, "red", { tpls: ["ledx"] }), h(2, "blue", { categories: ["barter"] }), h(3, "green", { tpls: ["gpu"] }, false)], catalog);
    expect(st.colors.get("loot:10")).toBe("red");
    expect(st.colors.get("loot:11")).toBe("blue");
    expect(st.colors.has("loot:20")).toBe(false);
    expect(st.matched.get(3)?.length).toBe(1);
  });

  it("hands out unused colours first", () => {
    expect(nextColor([])).toBe(HIGHLIGHT_COLORS[0]);
    expect(nextColor([h(1, HIGHLIGHT_COLORS[0]!, {})])).toBe(HIGHLIGHT_COLORS[1]);
  });
});
