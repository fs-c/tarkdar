import { describe, expect, it } from "vitest";
import { withoutDuplicateLoot } from "./dedupe";
import type { LootEntry, WorldPos } from "./protocol";

const loot = (id: number, kind: LootEntry["kind"], tpl: string, pos: WorldPos): LootEntry => ({ id, kind, tpl, obj: "", pos });

describe("withoutDuplicateLoot", () => {
  it("keeps the lowest id of copies at the same spot", () => {
    const l = [loot(5, "quest", "a", [1, 2, 3]), loot(2, "quest", "a", [1, 2, 3]), loot(9, "quest", "a", [1.05, 2, 3])];
    expect(withoutDuplicateLoot(l).map((x) => x.id)).toEqual([2]);
  });

  it("merges across grid cell borders", () => {
    const l = [loot(1, "item", "a", [0.099, 0, 0]), loot(2, "item", "a", [0.101, 0, 0])];
    expect(withoutDuplicateLoot(l)).toHaveLength(1);
  });

  it("keeps different items, distant copies, other kinds, corpses and airdrops", () => {
    const l = [
      loot(1, "item", "a", [0, 0, 0]),
      loot(2, "item", "b", [0, 0, 0]),
      loot(3, "item", "a", [0.5, 0, 0]),
      loot(4, "container", "a", [0, 0, 0]),
      loot(5, "corpse", "", [0, 0, 0]),
      loot(6, "corpse", "", [0, 0, 0]),
      loot(7, "airdrop", "", [9, 9, 9]),
      loot(8, "airdrop", "", [9, 9, 9]),
    ];
    expect(withoutDuplicateLoot(l)).toBe(l);
  });
});
