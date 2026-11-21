import { describe, expect, it } from "vitest";
import type { ItemCatalog } from "../model/items";
import { emptyCatalog } from "../model/items";
import type { AnyRow, SubjectKind } from "../list/rows";
import type { PlayerType } from "../model/roles";
import { EMPHASIS_SCALE, MARKER_SIZE } from "../draw/style";
import { DEFAULT_RULES } from "./defaults";
import { type Emphasis, type Style, applyRules } from "./rules";

// The looks as they were before they became rules (style.ts, f2193bc): the default rules must give
// exactly these (loose items: by value per slot now).
// What the colours were when they came from the UI palette.
const ui = { link: "#4aa3ff", danger: "#ff5a52", gold: "#f5c542", warn: "#ff9f40", quest: "#ffd84d" };
const OLD_PLAYER_TYPES_LOOK: Record<Exclude<PlayerType, "self">, { color: string; prominence: "minor" | "normal" | "special" | "boss" }> = {
  usec: { color: ui.link, prominence: "normal" },
  bear: { color: ui.danger, prominence: "normal" },
  "p-scav": { color: ui.gold, prominence: "normal" },
  "ai-scav": { color: ui.gold, prominence: "minor" },
  boss: { color: "#ff4fd8", prominence: "boss" },
  follower: { color: ui.warn, prominence: "special" },
  raider: { color: "#4de1ff", prominence: "special" },
  rogue: { color: "#38e8c0", prominence: "special" },
  cultist: { color: "#b26bff", prominence: "special" },
  bd: { color: "#ff7a1a", prominence: "special" },
  zombie: { color: "#9bd14b", prominence: "minor" },
  other: { color: "#c0c0c0", prominence: "normal" },
};
const OLD_ITEM_LOOK = { low: { color: "#8b969f", size: 3 }, mid: { color: "#e8eef2", size: 4 }, high: { color: ui.gold, size: 5 } };
const OLD_LOOT_LOOK = {
  quest: { color: ui.quest, size: 5 },
  container: { color: "#b08a5a", size: 3 },
  airdrop: { color: "#4de1ff", size: 5 },
  corpse: { color: "#9a9a9a", size: 3 },
};
const PROMINENCE_TO_EMPHASIS: Record<string, Emphasis> = { minor: "faint", normal: "normal", special: "strong", boss: "loud" };

const DEFAULTS = [...DEFAULT_RULES];

/** A row of just what the rules look at. */
const row = (key: string, subject: SubjectKind, extra: Partial<AnyRow> & Record<string, unknown> = {}) =>
  ({ key, subject, tpls: [], search: "", pos: null, sel: { kind: "loot", id: 0 }, ...extra }) as unknown as AnyRow;
const styleOf = (r: AnyRow, rules = DEFAULTS, catalog: ItemCatalog = emptyCatalog): Style => applyRules([r], rules, catalog).styles.get(r.key)!;

describe("default rules", () => {
  it("give each player type the colour and emphasis it had", () => {
    for (const [type, old] of Object.entries(OLD_PLAYER_TYPES_LOOK)) {
      const s = styleOf(row(`player:${type}`, "player", { type, local: false }));
      expect({ type, color: s.color, emphasis: s.emphasis }).toEqual({ type, color: old.color, emphasis: PROMINENCE_TO_EMPHASIS[old.prominence] });
    }
  });

  it("leave the local player to its own look", () => {
    const s = styleOf(row("player:1", "player", { type: "self", local: true }));
    expect(s.color).toBeUndefined();
  });

  it("give loose items the colour and size of their old value tier (unpriced: low)", () => {
    const cases: [number | undefined, keyof typeof OLD_ITEM_LOOK][] = [[undefined, "low"], [9_999, "low"], [10_000, "mid"], [39_999, "mid"], [40_000, "high"]];
    for (const [value, tier] of cases) {
      const s = styleOf(row("loot:1", "item", { value }));
      expect({ value, color: s.color, size: MARKER_SIZE.item * EMPHASIS_SCALE[s.emphasis] }).toEqual({ value, ...OLD_ITEM_LOOK[tier] });
    }
  });

  it("give the other kinds of loot their old colour and size", () => {
    for (const [kind, old] of Object.entries(OLD_LOOT_LOOK) as [keyof typeof OLD_LOOT_LOOK, { color: string; size: number }][]) {
      const s = styleOf(row("loot:1", kind));
      expect({ kind, color: s.color, size: MARKER_SIZE[kind] * EMPHASIS_SCALE[s.emphasis] }).toEqual({ kind, ...old });
    }
  });

  it("drop cheaper items first as you zoom out (the old default density, \"fewer\")", () => {
    expect(styleOf(row("loot:1", "item", { value: 5_000 })).show).toBe(1);
    expect(styleOf(row("loot:1", "item", { value: 20_000 })).show).toBe(0.4);
    expect(styleOf(row("loot:1", "item", { value: 500_000 })).show).toBe(0);
    expect(styleOf(row("loot:1", "quest")).show).toBe(0);
  });

  it("have unique ids", () => {
    expect(new Set(DEFAULTS.map((r) => r.id)).size).toBe(DEFAULTS.length);
  });
});
