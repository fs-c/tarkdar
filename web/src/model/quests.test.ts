import { describe, expect, it } from "vitest";
import type { LootEntry, QuestObjective, QuestState } from "./protocol";
import {
  SPECIFIC_ITEMS,
  formatQuestNeed,
  isSpecific,
  neededKinds,
  openObjectives,
  questItemLabels,
  questLabel,
  questNeeds,
  withoutUnneededQuestItems,
} from "./quests";

const obj = (id: string, type: QuestObjective["type"], items: string[], extra: Partial<QuestObjective> = {}): QuestObjective => ({
  id, type, items, count: 1, ...extra,
});
const quest = (id: string, objectives: QuestObjective[] | null, extra: Partial<QuestState> = {}): QuestState => ({
  id, status: 2, done: [], kind: "side", objectives, ...extra,
});
const loot = (id: number, kind: LootEntry["kind"], tpl: string): LootEntry => ({ id, kind, tpl, obj: `obj${id}`, pos: [0, 0, 0] });

describe("questLabel", () => {
  it("uses the name, else what the quest is", () => {
    expect(questLabel(quest("q", [], { name: "Charity" }))).toBe("Charity");
    expect(questLabel(quest("q", [], { kind: "daily", trader: "54cb50c76803fa8b248b4571" }))).toBe("Prapor daily");
    expect(questLabel(quest("q", [], { kind: "weekly", trader: "58330581ace78e27b8b10cee" }))).toBe("Skier weekly");
    expect(questLabel(quest("q", [], { kind: "weekly", trader: "unknown" }))).toBe("Weekly");
    expect(questLabel(quest("q", [], { kind: "story", trader: "67f7af56c117b6140af2a607" }))).toBe("Story");
    expect(questLabel(quest("q", [], { trader: "5c0647fdd443bc2504c2d371" }))).toBe("Jaeger quest");
  });
});

describe("openObjectives", () => {
  it("leaves out completed objectives, and hand-overs/plants that a find objective covers", () => {
    const q = quest("q", [
      obj("find", "find", ["a"], { count: 3 }),
      obj("give", "handover", ["a"], { count: 3, progress: 1 }),
      obj("plant", "plant", ["b"]),
      obj("done", "find", ["c"]),
      obj("money", "handover", ["5449016a4bdc2d6f028b456f"], { count: 100000 }),
    ], { done: ["done"] });
    const open = openObjectives(q);
    expect(open.map((o) => o.objective.id)).toEqual(["find", "plant"]);
    expect(open[0]!.progress).toBe(1); // the hand-over's progress counts for the find
  });
  it("drops objectives whose progress is complete, and currencies", () => {
    const q = quest("q", [
      obj("give", "handover", ["a", "5449016a4bdc2d6f028b456f"], { count: 2, progress: 2 }),
      obj("give2", "handover", ["b", "5449016a4bdc2d6f028b456f"], { count: 2, progress: 1 }),
    ]);
    expect(openObjectives(q).map((o) => [o.objective.id, o.items])).toEqual([["give2", ["b"]]]);
  });
});

describe("questNeeds", () => {
  const quests: QuestState[] = [
    quest("side", [obj("o1", "find", ["questA"]), obj("o2", "find", ["boltsTpl"], { count: 2, fir: true })], { name: "Gunsmith" }),
    quest("story", [obj("o3", "find", ["questB"], { text: "Retrieve the flight recorder" })], { kind: "story" }),
    quest("daily", [obj("o4", "handover", ["boltsTpl"], { count: 5, progress: 2, fir: true })], { kind: "daily", trader: "54cb50c76803fa8b248b4571" }),
    quest("ready", [obj("o5", "find", ["questC"])], { status: 3 }), // ready to hand in: needs nothing
  ];

  it("collects what started quests still need, per objective", () => {
    const needs = questNeeds(quests)!;
    expect(needs.complete).toBe(true);
    expect(needs.started).toBe(3);
    expect([...needs.items.keys()].sort()).toEqual(["boltsTpl", "questA", "questB"]);
    expect(needs.items.get("boltsTpl")!.map(formatQuestNeed)).toEqual(["Gunsmith (×2, FIR)", "Prapor daily (2/5, FIR)"]);
    expect(needs.items.get("questB")).toEqual([{ quest: "Retrieve the flight recorder", kind: "story", count: 1, fir: false, of: 1 }]);
  });

  it("is incomplete while a started quest's objectives are unknown, and null without quests", () => {
    expect(questNeeds([...quests, quest("unknown", null)])!.complete).toBe(false);
    expect(questNeeds([{ id: "old", status: 2, done: [] }])!.complete).toBe(false); // an older recording
    expect(questNeeds(null)).toBeNull();
  });

  it("labels quest items with what they're for", () => {
    const labels = questItemLabels(questNeeds(quests));
    expect(labels.get("questA")).toBe("Gunsmith");
    expect(labels.get("questB")).toBe("Retrieve the flight recorder");
    expect(labels.has("questC")).toBe(false);
  });

  it("filters quest items by need, unless the needs aren't all known", () => {
    const l = [loot(1, "quest", "questA"), loot(2, "quest", "questC"), loot(3, "item", "x")];
    expect(withoutUnneededQuestItems(l, questNeeds(quests)).map((e) => e.id)).toEqual([1, 3]);
    expect(withoutUnneededQuestItems(l, questNeeds([...quests, quest("unknown", null)]))).toBe(l);
    expect(withoutUnneededQuestItems(l, null)).toBe(l);
    const onlyNeeded = [loot(1, "quest", "questA")];
    expect(withoutUnneededQuestItems(onlyNeeded, questNeeds(quests))).toBe(onlyNeeded);
  });

  it("tells which kinds of quest need an item; broad objectives don't count for ordinary items", () => {
    const broad = Array.from({ length: SPECIFIC_ITEMS + 1 }, (_, i) => `med${i}`);
    const needs = questNeeds([
      quest("s", [obj("o1", "find", broad)], { kind: "story" }),
      quest("d", [obj("o2", "find", ["med0"])], { kind: "daily" }),
    ])!;
    expect(isSpecific(needs.items.get("med1")![0]!)).toBe(false);
    expect(neededKinds(needs.items.get("med0"), false)).toEqual(["daily"]);
    expect(neededKinds(needs.items.get("med1"), false)).toEqual([]);
    expect(neededKinds(needs.items.get("med1"), true)).toEqual(["story"]);
  });
});

describe("formatQuestNeed", () => {
  it("says how many, whether found in raid, and how many items count", () => {
    expect(formatQuestNeed({ quest: "Q", kind: "side", count: 1, fir: false, of: 1 })).toBe("Q");
    expect(formatQuestNeed({ quest: "Q", kind: "side", count: 3, fir: true, of: 60 })).toBe("Q (×3, FIR, any of 60)");
    expect(formatQuestNeed({ quest: "Q", kind: "side", count: 5, progress: 2, fir: false, of: 1 })).toBe("Q (2/5)");
  });
});
