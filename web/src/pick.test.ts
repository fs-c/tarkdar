import { describe, expect, it } from "vitest";
import { pick, selectedPosition } from "./pick";
import type { Exfil, LootEntry, Player } from "./protocol";
import { NO_MAP_TRANSFORM, type Layers } from "./render";
import { View } from "./view";

// NO_MAP_TRANSFORM: 2 px/m, north up. View centred on the origin, 200×200, zoom 1: world (x, z)
// lands at screen (100 + 2x, 100 − 2z).
const view = Object.assign(new View(), { width: 200, height: 200 });
const player = (id: number, x: number, z: number): Player =>
  ({ id, local: false, ai: true, side: "savage", dead: false, absent: false, pos: [x, 0, z], yaw: 0, pitch: 0 });
const loot = (id: number, kind: LootEntry["kind"], x: number, z: number): LootEntry => ({ id, kind, tpl: "", obj: "", pos: [x, 0, z] });
const exfil = (id: number, x: number, z: number): Exfil => ({ id, kind: "regular", name: "e", status: 4, pos: [x, 0, z] });
const all: Layers = { loot: true, containers: true, exfils: true, explosives: true };

describe("pick", () => {
  it("picks the nearest marker within its radius", () => {
    const src = { players: [player(1, 0, 0), player(2, 3, 0)], exfils: [], loot: [] };
    expect(pick(view, NO_MAP_TRANSFORM, src, all, 105, 100)).toEqual({ kind: "player", id: 2 });
    expect(pick(view, NO_MAP_TRANSFORM, src, all, 101, 100)).toEqual({ kind: "player", id: 1 });
    expect(pick(view, NO_MAP_TRANSFORM, src, all, 150, 150)).toBeNull();
  });

  it("skips hidden layers", () => {
    const src = { players: [], exfils: [exfil(1, 0, 0)], loot: [loot(2, "item", 0, 0), loot(3, "container", 0, 0)] };
    expect(pick(view, NO_MAP_TRANSFORM, src, { ...all, exfils: false, containers: false }, 100, 100)).toEqual({ kind: "loot", id: 2 });
    expect(pick(view, NO_MAP_TRANSFORM, src, { ...all, exfils: false, loot: false }, 100, 100)).toEqual({ kind: "loot", id: 3 });
    expect(pick(view, NO_MAP_TRANSFORM, src, { ...all, loot: false, containers: false }, 100, 100)).toEqual({ kind: "exfil", id: 1 });
  });
});

describe("selectedPosition", () => {
  it("finds the selected thing, or null when it's gone", () => {
    const src = { players: [player(1, 5, 6)], exfils: [], loot: [] };
    expect(selectedPosition({ kind: "player", id: 1 }, src)).toEqual([5, 0, 6]);
    expect(selectedPosition({ kind: "player", id: 2 }, src)).toBeNull();
    expect(selectedPosition(null, src)).toBeNull();
  });
});
