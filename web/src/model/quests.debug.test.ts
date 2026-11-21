import { describe, expect, it } from "vitest";
import type { LootEntry, QuestObjective, QuestState } from "./protocol";
import { questDebugReport } from "./quests.debug";

const obj = (id: string, type: QuestObjective["type"], items: string[], extra: Partial<QuestObjective> = {}): QuestObjective => ({
  id, type, items, count: 1, ...extra,
});
const quest = (id: string, objectives: QuestObjective[] | null, extra: Partial<QuestState> = {}): QuestState => ({
  id, status: 2, done: [], kind: "side", objectives, ...extra,
});
const loot = (id: number, kind: LootEntry["kind"], tpl: string): LootEntry => ({ id, kind, tpl, obj: `obj${id}`, pos: [0, 0, 0] });

describe("questDebugReport", () => {
  it("says what each quest needs and why each quest item shows", () => {
    const quests = [
      quest("side", [obj("o1", "find", ["questA"]), obj("o2", "handover", ["questA"])], { name: "Gunsmith", done: ["o1"] }),
      quest("hidden", [obj("o3", "find", ["questB"])], { kind: "story", hidden: true }),
      quest("unknown", null),
    ];
    const r = questDebugReport({ quests, loot: [loot(1, "quest", "questA"), loot(2, "quest", "questB"), loot(3, "quest", "questB")], filterOn: true, itemName: () => undefined });
    expect(r.backend).toBe("read");
    expect(r.started).toBe(3);
    expect(r.byKind).toEqual({ story: 1, side: 2, daily: 0, weekly: 0 });
    expect(r.unknown).toEqual(["unknown"]);
    expect(r.filter.effect).toMatch(/objectives unknown/);
    expect(r.quests[0]!.id).toBe("unknown"); // unknown first, then story before side
    expect(r.quests[1]!).toMatchObject({ id: "hidden", hidden: true, label: "Story" });
    expect(r.quests[2]!.objectives.map((o) => [o.id, o.done, o.open])).toEqual([["o1", true, false], ["o2", false, false]]);
    expect(r.questItems).toEqual([
      expect.objectContaining({ tpl: "questB", count: 2, needed: true, shown: true }),
      expect.objectContaining({ tpl: "questA", needed: false, shown: true, why: "some started quests' objectives unknown: kept" }),
    ]);
  });
});
