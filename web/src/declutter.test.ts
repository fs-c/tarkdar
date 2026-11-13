import { describe, expect, it } from "vitest";
import { itemMarkerShown } from "./declutter";
import { type ItemCatalog, emptyCatalog } from "./items";
import { flatProjector } from "./projector";
import type { Exfil, LootEntry, Player } from "./protocol";
import { NO_MAP_TRANSFORM, type Scene, renderMarkers } from "./render";
import { View } from "./view";

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

const prices: Record<string, number> = { cheap: 5_000, mid: 50_000, dear: 500_000 };
const catalog: ItemCatalog = { ...emptyCatalog, lookup: (tpl) => (tpl in prices ? { name: tpl, shortName: tpl, price: prices[tpl] } : undefined) };
const player = (id: number): Player => ({ id, local: false, ai: false, side: "usec", dead: false, absent: false, pos: [0, 0, 0], yaw: 0, pitch: 0 });
const loot = (id: number, kind: LootEntry["kind"], tpl = ""): LootEntry => ({ id, kind, tpl, obj: "", pos: [0, 0, 0] });
const exfil: Exfil = { id: 1, kind: "regular", name: "Gate", status: 4, pos: [0, 0, 0] };

function draw(zoom: number, patch: Partial<Scene>) {
  const view = Object.assign(new View(), { width: 200, height: 200, zoom });
  const scene: Scene = {
    map: null, layer: 0, players: [], catalog, exfils: [], explosives: { grenades: [], tripwires: [] }, loot: [],
    layers: { loot: true, containers: true, exfils: true, explosives: true }, minLabelPrice: 0, lootDensity: "all",
    selected: null, hovered: null, highlights: new Map(), calibrationPixels: [], debugPoints: [], trails: null, bodies: false,
    ...patch,
  };
  const f = fakeCtx();
  renderMarkers(f.ctx, flatProjector(view, NO_MAP_TRANSFORM), scene);
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
    expect(draw(0.5, { loot: items, lootDensity: "all" }).rects).toHaveLength(3);
    expect(draw(0.5, { loot: items, lootDensity: "fewer" }).rects).toHaveLength(2);
    expect(draw(0.2, { loot: items, lootDensity: "fewer" }).rects).toHaveLength(1);
    expect(draw(1.5, { loot: items, lootDensity: "fewest" }).rects).toHaveLength(2);
  });

  it("keep highlighted items whatever their price", () => {
    expect(draw(0.2, { loot: items, lootDensity: "fewest", highlights: new Map([["loot:1", "#f00"]]) }).rects).toHaveLength(2);
  });

  it("fall back to the default for an unknown stored setting", () => {
    expect(itemMarkerShown("low", 0.5, "bogus" as never)).toBe(false);
    expect(itemMarkerShown("mid", 0.5, "bogus" as never)).toBe(true);
  });
});
