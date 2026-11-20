import { describe, expect, it } from "vitest";
import { SlimCatalog } from "../catalog";
import { buildRows, lootRows } from "../list/rows";
import type { LootEntry, Player } from "../protocol";
import { type Highlight, HIGHLIGHT_COLORS, allRows, matchingRows, nextColor } from "./match";
import { compileQuery, isStructured, parseNumber, parseQuery } from "./query";

const catalog = new SlimCatalog(
  {
    ledx: ["LEDX Skin Transilluminator", "LEDX", 900_000, 0, ["medsupplies", "barter"]],
    gpu: ["Graphics card", "GPU", 400_000, 0, ["electronics", "barter"], 2],
    bolts: ["Bolts", "Bolts", 12_000, 0, ["building", "barter"]],
    m4: ["Colt M4A1", "M4A1", 40_000, 0, ["rifles", "weapons"], 8],
    m995: ["5.56x45mm M995", "M995", 1_000, 0, ["ammo"], 1, [53, 49, 58, 0]],
    ps: ["5.45x39mm PS gs", "PS", 200, 0, ["ammo"], 1, [28, 51, 34, 0]],
    plate: ["Granit 4 plate", "Granit", 60_000, 0, ["armor"], 4, [0, 0, 0, 5]],
  },
  {
    barter: ["Barter items", null], medsupplies: ["Medical supplies", "barter"], electronics: ["Electronics", "barter"], building: ["Building materials", "barter"],
    weapons: ["Weapons", null], rifles: ["Assault rifles", "weapons"], ammo: ["Ammo", null], armor: ["Armor plates", null],
  },
);

const player = (id: number, extra: Partial<Player> = {}): Player =>
  ({ id, local: false, ai: true, side: "savage", dead: false, absent: false, pos: [0, 0, 0], yaw: 0, pitch: 0, ...extra });
const loot = (id: number, kind: LootEntry["kind"], tpl: string, extra: Partial<LootEntry> = {}): LootEntry =>
  ({ id, kind, tpl, obj: "", pos: [10, 0, 0], ...extra });

const rows = allRows(
  buildRows(
    {
      players: [player(1, { local: true, ai: false, side: "usec" }), player(2, { role: 6 }), player(3, { ai: false, side: "bear" }), player(4, { role: 1 })],
      loot: [
        loot(10, "item", "ledx"), loot(11, "item", "gpu"), loot(12, "item", "bolts"), loot(13, "quest", "x"), loot(14, "item", "m995"), loot(15, "item", "ps"),
        loot(20, "corpse", "", { contents: [{ tpl: "m4" }, { tpl: "plate" }] }), loot(21, "airdrop", ""),
        loot(22, "container", "578f8782245977354405a1e3"), loot(23, "container", "578f87b7245977356274f2cd"),
      ],
      exfils: [],
      explosives: { grenades: [], tripwires: [] },
      equipment: new Map([[1, { id: 1, slots: [{ tpl: "m4" }] }], [3, { id: 3, slots: [{ tpl: "m4" }, { tpl: "m995" }] }]]),
    },
    catalog,
  ),
);
const keys = (q: string) => matchingRows(rows, q, catalog).map((r) => r.key);

describe("parsing", () => {
  it("reads terms: text, phrases, fields with lists, comparisons", () => {
    expect(parseQuery('ledx "red rebel" is:boss,raider item:"Colt M4A1",GPU value>=40k pen>50 class≥4').terms).toEqual([
      { kind: "text", text: "ledx" },
      { kind: "text", text: "red rebel" },
      { kind: "is", values: ["boss", "raider"] },
      { kind: "item", names: ["Colt M4A1", "GPU"] },
      { kind: "num", field: "value", op: ">=", value: 40_000 },
      { kind: "num", field: "pen", op: ">", value: 50 },
      { kind: "num", field: "class", op: ">=", value: 4 },
    ]);
  });
  it("takes plurals and aliases", () => {
    expect(parseQuery("is:bosses,guards,bodies damage<60").terms).toEqual([
      { kind: "is", values: ["boss", "guard", "corpse"] },
      { kind: "num", field: "dmg", op: "<", value: 60 },
    ]);
  });
  it("says what's wrong", () => {
    expect(parseQuery("is:bos").errors[0]).toMatch(/is:bos: unknown \(try is:boss/);
    expect(parseQuery("foo:bar").errors[0]).toMatch(/foo: unknown field/);
    expect(parseQuery("pen>=x").errors[0]).toMatch(/not a number/);
    expect(parseQuery("value:40k").errors[0]).toMatch(/value: compares/);
    expect(parseQuery("item:").errors[0]).toMatch(/needs a value/);
  });
  it("reads numbers with k and m", () => {
    expect([parseNumber("50k"), parseNumber("1.5m"), parseNumber("40"), parseNumber("x")]).toEqual([50_000, 1_500_000, 40, null]);
  });
  it("tells syntax from free text", () => {
    expect([isStructured("ledx"), isStructured("is:boss"), isStructured("ledx value>=1")]).toEqual([false, true, true]);
  });
});

describe("matching", () => {
  it("matches items by category, and players and corpses carrying one (never us)", () => {
    expect(keys("cat:\"Barter items\"")).toEqual(["loot:10", "loot:11", "loot:12"]);
    expect(keys("cat:weapons")).toEqual(["player:3", "loot:20"]);
    expect(keys("cat:electronics,\"medical supplies\"")).toEqual(["loot:10", "loot:11"]);
  });
  it("matches items by short or full name, and kinds of container", () => {
    expect(keys("item:gpu")).toEqual(["loot:11"]);
    expect(keys('item:"LEDX Skin Transilluminator"')).toEqual(["loot:10"]);
    expect(keys("item:safe")).toEqual(["loot:22"]);
  });
  it("matches player types and kinds of things", () => {
    expect(keys("is:boss")).toEqual(["player:2"]);
    expect(keys("is:quest,airdrop")).toEqual(["loot:13", "loot:21"]);
    expect(keys("is:pmc")).toEqual(["player:3"]);
    expect(keys("is:human")).toEqual(["player:3"]);
  });
  it("matches value per slot and unit price; unknown values count as cheap", () => {
    expect(keys("is:item value>=100k")).toEqual(["loot:10", "loot:11"]); // the GPU: 400k over 2 slots
    expect(keys("is:item value>=250k")).toEqual(["loot:10"]);
    expect(keys("is:item price>=250k")).toEqual(["loot:10", "loot:11"]);
    expect(keys("is:item,quest value<5k")).toEqual(["loot:13", "loot:14", "loot:15"]);
  });
  it("matches ammo and armor stats, on loose items and on what's carried", () => {
    expect(keys("pen>=40")).toEqual(["player:3", "loot:14"]);
    expect(keys("is:item dmg>50")).toEqual(["loot:15"]);
    expect(keys("class>=5")).toEqual(["loot:20"]);
  });
  it("matches text, and needs every term to hold", () => {
    expect(keys("killa")).toEqual(["player:2"]);
    expect(keys("cat:\"barter items\" value>=500k")).toEqual(["loot:10"]);
  });
  it("matches loose items a started quest still needs, and finds them by the quest's name", () => {
    const needs = new Map([
      ["bolts", [{ quest: "Gunsmith", count: 2, fir: true, of: 1 }]],
      ["ledx", [{ quest: "Any meds", count: 3, fir: false, of: 60 }]], // too broad to highlight
    ]);
    const quested = lootRows([loot(12, "item", "bolts"), loot(13, "quest", "bolts"), loot(10, "item", "ledx")], catalog, new Map(), needs).items;
    expect(quested[0]!.questNeeds).toEqual(["Gunsmith (×2, FIR)"]);
    expect(matchingRows(quested, "is:item is:needed", catalog).map((r) => r.key)).toEqual(["loot:12"]);
    expect(matchingRows(quested, "gunsmith", catalog).map((r) => r.key)).toEqual(["loot:12"]);
    expect(keys("is:needed")).toEqual([]); // nothing needed without quest data
  });
  it("matches nothing with an empty query, or one with errors", () => {
    expect(keys("")).toEqual([]);
    expect(keys("  ")).toEqual([]);
    expect(keys("is:boss item:nonexistent")).toEqual([]);
    expect(compileQuery("item:nonexistent", catalog).errors).toEqual(['item:nonexistent: no such item']);
  });
});

describe("highlight colours", () => {
  const h = (id: number, color: string): Highlight => ({ id, label: "", group: "", query: "", color, on: true });

  it("hands out unused colours first", () => {
    expect(nextColor([])).toBe(HIGHLIGHT_COLORS[0]);
    expect(nextColor([h(1, HIGHLIGHT_COLORS[0]!)])).toBe(HIGHLIGHT_COLORS[1]);
  });
});
