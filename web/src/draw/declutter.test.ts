import { describe, expect, it } from "vitest";
import { type ItemCatalog, emptyCatalog } from "../model/items";
import { topDownProjector } from "./projector.fixture";
import type { Exfil, LootEntry, Player } from "../model/protocol";
import { type Scene, renderMarkers } from "./render";
import { highlightRule } from "../rules/rules";
import { type LegacyPrefs, storeFrom, stylesFor } from "../rules/rules.fixture";

/** A canvas context that records the text and the filled rectangles drawn (text is 6 px a character). */
function fakeCtx() {
  const texts: string[] = [];
  const rects: number[][] = [];
  const target: Record<string | symbol, unknown> = {
    fillText: (t: string) => texts.push(t),
    fillRect: (...a: number[]) => rects.push(a),
    measureText: (t: string) => ({ width: t.length * 6 }),
  };
  const ctx = new Proxy(target, {
    get: (o, k) => (k in o ? o[k] : () => {}),
    set: (o, k, v) => {
      o[k] = v;
      return true;
    },
  });
  return { ctx: ctx as unknown as CanvasRenderingContext2D, texts, rects };
}

const prices: Record<string, number> = { cheap: 5_000, mid: 20_000, dear: 500_000 };
const catalog: ItemCatalog = { ...emptyCatalog, lookup: (tpl) => (tpl in prices ? { name: tpl, shortName: tpl, price: prices[tpl] } : undefined) };
const player = (id: number): Player => ({ id, local: false, ai: false, side: "usec", dead: false, absent: false, pos: [0, 0, 0], yaw: 0, pitch: 0 });
const loot = (id: number, kind: LootEntry["kind"], tpl = ""): LootEntry => ({ id, kind, tpl, obj: "", pos: [0, 0, 0] });
const exfil: Exfil = { id: 1, kind: "regular", name: "Gate", status: 4, pos: [0, 0, 0] };

/** Draws the scene at a level of detail (declutter.ts), styled by the built-in rules as made from these
 *  (old) Map panel settings, and a highlight. */
function draw(detail: number, patch: Partial<Scene>, prefs: LegacyPrefs = {}, highlight?: string) {
  const base: Scene = {
    players: [], catalog, exfils: [], explosives: { grenades: [], tripwires: [] }, vehicles: [], loot: [], questLabels: new Map(),
    styles: new Map(), selected: null, hovered: null, debugPoints: [], trails: null, bodies: false,
    ...patch,
  };
  const extra = highlight ? [highlightRule("h", "", highlight, "#f00", true)] : [];
  const scene = { ...base, styles: stylesFor(base, storeFrom(prefs), extra, catalog) };
  const f = fakeCtx();
  renderMarkers(f.ctx, topDownProjector(200, 200, 4 * detail), scene);
  return f;
}

describe("labels", () => {
  it("always label players and exfils, even on top of each other (crowded, an exfil's is just its name)", () => {
    const { texts } = draw(1, { players: [player(1), player(2), player(3)], exfils: [exfil] });
    expect(texts.sort()).toEqual(["1", "2", "3", "Gate"]);
  });

  it("give container labels only the room that's left", () => {
    // Seven containers on one spot: not enough places around it, so some go without (they used to overlap).
    const containers = Array.from({ length: 7 }, (_, i) => loot(i, "container", "578f8782245977354405a1e3"));
    const n = draw(2, { loot: containers }).texts.length;
    expect(n).toBeGreaterThan(0);
    expect(n).toBeLessThan(7);
  });

  it("always label airdrops; quest items only where there's room", () => {
    const drops = Array.from({ length: 7 }, (_, i) => loot(i, "airdrop"));
    expect(draw(2, { loot: drops }).texts).toHaveLength(7);
    const quests = Array.from({ length: 7 }, (_, i) => loot(i, "quest"));
    expect(draw(2, { loot: quests }).texts.length).toBeLessThan(7);
  });

  it("label quest items with their quest, else generically, and highlighted ones too", () => {
    const questLabels = new Map([["diary", "Missing Informant"]]);
    expect(draw(2, { loot: [loot(1, "quest", "diary")], questLabels }).texts).toEqual(["Missing Informant"]);
    expect(draw(2, { loot: [loot(1, "quest", "unknown")], questLabels }).texts).toEqual(["quest item"]);
    expect(draw(2, { loot: [loot(1, "quest", "diary")], questLabels }, {}, "diary").texts).toEqual(["Missing Informant"]);
  });

  it("place the more important labels first", () => {
    // An exfil and an item on one spot, zoomed in: the exfil keeps the spot to the right; the item moves.
    const { texts } = draw(3, { exfils: [exfil], loot: [loot(1, "item", "dear")] });
    expect(texts).toEqual(["Gate · open", "dear 500k"]);
  });

  it("shorten exfil labels to the name when zoomed out", () => {
    expect(draw(0.3, { exfils: [exfil] }).texts).toEqual(["Gate"]);
    expect(draw(0.6, { exfils: [exfil] }).texts).toEqual(["Gate · open"]);
  });
});

describe("item markers by zoom", () => {
  const items = [loot(1, "item", "cheap"), loot(2, "item", "mid"), loot(3, "item", "dear")];

  it("drop cheap items first as you zoom out", () => {
    expect(draw(0.5, { loot: items }, { density: "all" }).rects).toHaveLength(3);
    expect(draw(0.5, { loot: items }, { density: "fewer" }).rects).toHaveLength(2);
    expect(draw(0.2, { loot: items }, { density: "fewer" }).rects).toHaveLength(1);
    expect(draw(1.5, { loot: items }, { density: "fewest" }).rects).toHaveLength(2);
  });

  it("keep highlighted items whatever their price", () => {
    expect(draw(0.2, { loot: items }, { density: "fewest" }, "cheap").rects).toHaveLength(2);
  });

  it("fall back to the default for an unknown stored setting", () => {
    expect(draw(0.5, { loot: items }, { density: "bogus" as never }).rects).toHaveLength(2);
  });
});

describe("the old Map panel settings, as rules", () => {
  it("label only items worth at least the minimum price", () => {
    const items = [loot(1, "item", "cheap"), loot(2, "item", "dear")];
    expect(draw(3, { loot: items }, { minLabelPrice: 0 }).texts.sort()).toEqual(["cheap 5k", "dear 500k"]);
    expect(draw(3, { loot: items }, { minLabelPrice: 10_000 }).texts).toEqual(["dear 500k"]);
  });

  it("hide a layer that's off, except what's highlighted", () => {
    const things = { loot: [loot(1, "item", "cheap"), loot(2, "item", "dear")], exfils: [exfil] };
    const layers = { loot: false, containers: true, exfils: false, explosives: true };
    expect(draw(3, things, { layers }).texts).toEqual([]);
    expect(draw(3, things, { layers }, "dear").texts).toEqual(["dear 500k"]);
  });
});
