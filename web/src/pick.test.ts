import { describe, expect, it } from "vitest";
import { pick, selectedPosition } from "./pick";
import { type Exfil, JOINT_COUNT, Joint, type LootEntry, type Player, type WorldPos } from "./protocol";
import type { Layers } from "./render";
import { topDownProjector } from "./projector.fixture";

// 2 px/m, north up, 200×200 centred on the origin: world (x, z) lands at screen (100 + 2x, 100 − 2z).
const view = topDownProjector(200, 200, 2);
const player = (id: number, x: number, z: number): Player =>
  ({ id, local: false, ai: true, side: "savage", dead: false, absent: false, pos: [x, 0, z], yaw: 0, pitch: 0 });
const loot = (id: number, kind: LootEntry["kind"], x: number, z: number): LootEntry => ({ id, kind, tpl: "", obj: "", pos: [x, 0, z] });
const exfil = (id: number, x: number, z: number): Exfil => ({ id, kind: "regular", name: "e", status: 4, pos: [x, 0, z] });
const none = { grenades: [], tripwires: [] };
const all: Layers = { loot: true, containers: true, exfils: true, explosives: true };

describe("pick", () => {
  it("picks the nearest marker within its radius", () => {
    const src = { players: [player(1, 0, 0), player(2, 3, 0)], exfils: [], loot: [], explosives: none };
    expect(pick(view, src, all, 105, 100)).toEqual({ kind: "player", id: 2 });
    expect(pick(view, src, all, 101, 100)).toEqual({ kind: "player", id: 1 });
    expect(pick(view, src, all, 150, 150)).toBeNull();
  });

  it("picks a player drawn as a figure by its chest and head too", () => {
    const joints = new Float32Array(JOINT_COUNT * 3);
    joints[Joint.head * 3] = 20; // 40 px east of the feet (flat projection: only x and z show)
    const src = { players: [{ ...player(1, 0, 0), joints }], exfils: [], loot: [], explosives: none };
    expect(pick(view, src, all, 140, 100)).toEqual({ kind: "player", id: 1 });
    expect(pick(view, src, all, 120, 100)).toBeNull();
  });

  it("skips hidden layers", () => {
    const src = { players: [], exfils: [exfil(1, 0, 0)], loot: [loot(2, "item", 0, 0), loot(3, "container", 0, 0)], explosives: none };
    expect(pick(view, src, { ...all, exfils: false, containers: false }, 100, 100)).toEqual({ kind: "loot", id: 2 });
    expect(pick(view, src, { ...all, exfils: false, loot: false }, 100, 100)).toEqual({ kind: "loot", id: 3 });
    expect(pick(view, src, { ...all, loot: false, containers: false }, 100, 100)).toEqual({ kind: "exfil", id: 1 });
  });


  it("picks tripwires at their midpoint, only with the explosives layer on", () => {
    const wire = { id: 4, from: [-10, 0, 0] as WorldPos, to: [10, 0, 0] as WorldPos };
    const s = { players: [], exfils: [], loot: [], explosives: { grenades: [], tripwires: [wire] } };
    expect(pick(view, s, all, 100, 100)).toEqual({ kind: "tripwire", id: 4 });
    expect(pick(view, s, { ...all, explosives: false }, 100, 100)).toBeNull();
    expect(selectedPosition({ kind: "tripwire", id: 4 }, s)).toEqual([0, 0, 0]);
  });
});

describe("selectedPosition", () => {
  it("finds the selected thing, or null when it's gone", () => {
    const src = { players: [player(1, 5, 6)], exfils: [], loot: [], explosives: none };
    expect(selectedPosition({ kind: "player", id: 1 }, src)).toEqual([5, 0, 6]);
    expect(selectedPosition({ kind: "player", id: 2 }, src)).toBeNull();
    expect(selectedPosition(null, src)).toBeNull();
  });
});
