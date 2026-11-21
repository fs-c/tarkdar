import { describe, expect, it } from "vitest";
import { type ItemCatalog, type ItemInfo, emptyCatalog } from "../model/items";
import { buildRows } from "../list/rows";
import type { LootEntry, Player } from "../model/protocol";
import type { Style } from "../rules/rules";
import { DEFAULT_OVERLAY_PREFS, OTHER_PLAYERS, hexColor, overlayData, overlayMarks } from "./marks";

const info: Record<string, ItemInfo> = {
  ledx: { name: "LEDX Skin Transilluminator", shortName: "LEDX", price: 900_000, priceSource: "flea" },
  bolts: { name: "Bolts", shortName: "Bolts", price: 12_000, priceSource: "flea" },
};
const catalog: ItemCatalog = { ...emptyCatalog, lookup: (tpl) => info[tpl] };

const player = (id: number, extra: Partial<Player> = {}): Player =>
  ({ id, local: false, ai: true, side: "savage", dead: false, absent: false, pos: [0, 0, 0], yaw: 0, pitch: 0, ...extra });
const loot = (id: number, kind: LootEntry["kind"], tpl: string): LootEntry => ({ id, kind, tpl, obj: "", pos: [10, 0, 0] });

const rows = buildRows(
  {
    players: [player(1, { local: true, side: "usec" }), player(2, { voice: "BossKilla" }), player(3, { dead: true }), player(4, { side: "bear", ai: false })],
    loot: [loot(10, "item", "ledx"), loot(11, "item", "bolts"), loot(12, "quest", "x"), loot(13, "airdrop", "")],
    exfils: [{ id: 1, kind: "regular", name: "Gate 3", status: 4, pos: [1, 2, 3] }],
    explosives: { grenades: [], tripwires: [] },
    vehicles: [],
    equipment: new Map(),
  },
  catalog,
);

const style = (s: Partial<Style>): Style => ({ show: 0, emphasis: "normal", label: "room", labelFrom: 0, ...s });

describe("overlayMarks", () => {
  const styles = new Map<string, Style>([
    ["player:2", style({ color: "#ff00aa", emphasis: "loud" })],
    ["player:4", style({ color: "#f00", show: null })], // hidden on the map
    ["loot:10", style({ color: "#ffd84d", emphasis: "strong" })],
    ["loot:11", style({ color: "#888888" })], // plain: not marked
    ["loot:12", style({})],
    ["loot:13", style({})],
    ["exfil:1", style({})],
  ]);
  const marks = overlayMarks(rows, styles);

  it("marks living players the map shows, not the local player, in their colour and type", () => {
    const players = marks.filter((m) => m.kind === "player");
    expect(players).toEqual([{ kind: "player", id: 2, color: "#ff00aa", label: "Killa", emphasis: "loud" }]);
  });

  it("marks loot that stands out: emphasised, quest items, airdrops", () => {
    expect(marks.filter((m) => m.kind === "loot").map((m) => [m.id, m.label])).toEqual([[10, "LEDX"], [12, "quest item"], [13, "airdrop"]]);
  });

  it("marks exfils in their status colour", () => {
    const exfil = marks.find((m) => m.kind === "exfil");
    expect(exfil?.label).toBe("Gate 3");
    expect(exfil?.color).toMatch(/^#[0-9a-f]{6}$/i);
  });

  it("highlighted loot takes its ring's colour", () => {
    const ringed = overlayMarks(rows, new Map([["loot:11", style({ color: "#888888", ring: "#00ffcc" })]]));
    expect(ringed.find((m) => m.id === 11)?.color).toBe("#00ffcc");
  });
});

describe("overlayData", () => {
  const marks = overlayMarks(rows, new Map());
  it("is off, with nothing marked, unless on and in a raid", () => {
    expect(overlayData(DEFAULT_OVERLAY_PREFS, 3, marks)).toMatchObject({ on: false, marks: [] });
    expect(overlayData({ ...DEFAULT_OVERLAY_PREFS, on: true }, null, marks)).toMatchObject({ on: false, marks: [] });
    const on = overlayData({ ...DEFAULT_OVERLAY_PREFS, on: true, delayMs: 20 }, 3, marks);
    expect(on).toMatchObject({ on: true, raid: 3, delayMs: 20, otherPlayers: OTHER_PLAYERS });
    expect(on.marks.length).toBe(marks.length);
    expect(overlayData({ ...DEFAULT_OVERLAY_PREFS, on: true, otherPlayers: false }, 3, marks).otherPlayers).toBeNull();
  });
});

describe("hexColor", () => {
  it("keeps #rrggbb[aa], expands #rgb, replaces the rest", () => {
    expect(hexColor("#A1b2C3")).toBe("#A1b2C3");
    expect(hexColor("#a1b2c380")).toBe("#a1b2c380");
    expect(hexColor("#abc")).toBe("#aabbcc");
    expect(hexColor("red", "#123456")).toBe("#123456");
    expect(hexColor(undefined, "#123456")).toBe("#123456");
  });
});
