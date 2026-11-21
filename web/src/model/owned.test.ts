import { describe, expect, it } from "vitest";
import { type Owned, ownedItems, ownedKey } from "./owned";
import type { LootEntry, QuestObjective, QuestState, StashData } from "./protocol";
import { carriedNeeds, formatQuestNeed, neededKinds, questNeeds, withoutUnneededQuestItems } from "./quests";
import type { ImportedQuest } from "./taskFeed";

const obj = (id: string, items: string[], count: number, fir = false): QuestObjective => ({ id, type: "handover", items, count, ...(fir ? { fir } : {}) });
const quest = (id: string, objectives: QuestObjective[]): QuestState => ({ id, status: 2, done: [], kind: "side", name: id, objectives });
const owned = (entries: Record<string, [count: number, fir: number]>): Owned =>
  new Map(Object.entries(entries).map(([tpl, [count, fir]]) => [tpl, { count, fir }]));
const need = (quests: QuestState[], o: Owned, imported: ImportedQuest[] = []) => questNeeds(quests, { imported }, o)!;

describe("ownedItems", () => {
  const stash: StashData = { profile: "p", stash: [{ tpl: "a", count: 5, fir: 2 }, { tpl: "b", count: 1 }], equipment: [{ tpl: "a", count: 1, fir: 1 }] };

  it("adds the stash's equipment when no live gear is given", () => {
    expect(ownedItems(stash)).toEqual(owned({ a: [6, 3], b: [1, 0] }));
  });

  it("uses the live gear instead, nested items and stacks included", () => {
    const gear = [{ tpl: "rig", slot: "TacticalVest", items: [{ tpl: "a", count: 3, fir: true }, { tpl: "c" }] }];
    expect(ownedItems(stash, gear)).toEqual(owned({ a: [8, 5], b: [1, 0], rig: [1, 0], c: [1, 0] }));
  });

  it("is null when nothing is known, and keyed by contents", () => {
    expect(ownedItems(null)).toBeNull();
    expect(ownedItems(null, [])).toEqual(new Map());
    expect(ownedKey(owned({ a: [1, 0], b: [2, 2] }))).toBe(ownedKey(owned({ b: [2, 2], a: [1, 0] })));
    expect(ownedKey(owned({ a: [1, 0] }))).not.toBe(ownedKey(owned({ a: [1, 1] })));
  });
});

describe("owned items cover quest needs", () => {
  it("covers what's left after hand-in progress", () => {
    const n = need([quest("q", [{ ...obj("o", ["a"], 5), progress: 3 }])], owned({ a: [2, 0] }));
    const got = n.objectives.get("q/o")!;
    expect(got).toMatchObject({ have: 2, covered: true });
    expect(neededKinds(n.items.get("a"), false)).toEqual([]);
    expect(formatQuestNeed(got)).toBe("q (3/5, have all)");
  });

  it("FIR objectives only take found-in-raid units", () => {
    const n = need([quest("q", [obj("o", ["a"], 3, true)])], owned({ a: [10, 2] }));
    expect(n.objectives.get("q/o")).toMatchObject({ have: 2 });
    expect(n.objectives.get("q/o")!.covered).toBeUndefined();
    expect(neededKinds(n.items.get("a"), false)).toEqual(["side"]);
    expect(formatQuestNeed(n.objectives.get("q/o")!)).toBe("q (×3, FIR, have 2)");
  });

  it("gives FIR units to FIR objectives first, plain ones to the others", () => {
    // 2 plain + 2 FIR. In list order the plain objective would take FIR units it doesn't need.
    const n = need([quest("q1", [obj("plain", ["a"], 3)]), quest("q2", [obj("fir", ["a"], 2, true)])], owned({ a: [4, 2] }));
    expect(n.objectives.get("q2/fir")).toMatchObject({ have: 2, covered: true });
    expect(n.objectives.get("q1/plain")).toMatchObject({ have: 2 });
    expect(n.objectives.get("q1/plain")!.covered).toBeUndefined();
  });

  it("counts every unit once, started quests before imported ones", () => {
    const imported: ImportedQuest[] = [{ id: "later", name: "Later", objectives: [obj("o", ["a"], 1)] }];
    const n = need([quest("q", [obj("o", ["a"], 1)])], owned({ a: [1, 0] }), imported);
    expect(n.objectives.get("q/o")!.covered).toBe(true);
    expect(n.objectives.get("later/o")!.covered).toBeUndefined();
    expect(neededKinds(n.items.get("a"), false)).toEqual(["imported"]);
  });

  it("serves specific objectives before broad ones", () => {
    const broad = Array.from({ length: 10 }, (_, i) => (i === 0 ? "a" : `x${i}`));
    const n = need([quest("q1", [obj("broad", broad, 1)]), quest("q2", [obj("one", ["a"], 1)])], owned({ a: [1, 0] }));
    expect(n.objectives.get("q2/one")!.covered).toBe(true);
    expect(n.objectives.get("q1/broad")!.covered).toBeUndefined();
  });

  it("covered quest items are filtered out, and nobody carrying them is of interest", () => {
    const n = need([quest("q", [{ id: "f", type: "find", items: ["key"], count: 1 }])], owned({ key: [1, 0] }));
    const loot: LootEntry[] = [{ id: 1, kind: "quest", tpl: "key", obj: "o", pos: [0, 0, 0] }];
    expect(withoutUnneededQuestItems(loot, n)).toEqual([]);
    expect(carriedNeeds(["key"], n.items)).toEqual([]);
  });

  it("without owned items, nothing is covered", () => {
    const n = questNeeds([quest("q", [obj("o", ["a"], 1)])])!;
    expect(n.objectives.get("q/o")).not.toHaveProperty("covered");
  });
});
