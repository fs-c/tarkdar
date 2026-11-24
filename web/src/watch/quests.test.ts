import { describe, expect, it } from "vitest";
import { SlimCatalog } from "../model/catalog";
import { matchingRows } from "../highlight/match";
import { lootRows } from "../list/rows";
import { questNeeds } from "../model/quests";
import type { LootEntry, QuestObjective, QuestState } from "../model/protocol";
import { itemsLeft, needsLine, questEntries } from "./quests";

const catalog = new SlimCatalog(
  {
    salewa: { name: "Salewa first aid kit", shortName: "Salewa", price: 20_000, priceSource: "flea", categories: [] },
    bolts: { name: "Bolts", shortName: "Bolts", price: 12_000, priceSource: "flea", categories: [] },
  },
  {},
);
const obj = (id: string, items: string[], extra: Partial<QuestObjective> = {}): QuestObjective => ({ id, type: "find", items, count: 1, ...extra });
const quest = (id: string, name: string | undefined, objectives: QuestObjective[] | null, extra: Partial<QuestState> = {}): QuestState => ({ id, name, status: 2, done: [], kind: "side", objectives, ...extra });
const loot = (id: number, tpl: string): LootEntry => ({ id, kind: "item", tpl, obj: "", pos: [0, 0, 0] });

describe("tracked quests", () => {
  const quests = [
    quest("q1", "Shortage", [obj("o1", ["salewa"], { count: 3, fir: true })]),
    quest("q2", undefined, [obj("o2", ["bolts"])], { kind: "story" }),
    quest("q3", "Kill quest", []),
    quest("q4", "Unknown", null),
  ];
  const needs = questNeeds(quests)!;
  const entries = questEntries(quests, [], needs, catalog);

  it("lists started quests that still need items, with what they need", () => {
    expect(entries.map((q) => q.id).sort()).toEqual(["q1", "q2"]); // not the kill quest, nor one whose objectives are unknown
    const shortage = entries.find((q) => q.id === "q1")!;
    expect(needsLine(shortage)).toBe("Salewa 0/3 · FIR");
    expect(itemsLeft(shortage)).toBe(3);
    expect(entries.find((q) => q.id === "q2")?.tab).toBe("Story");
  });

  it("tracks a quest by its name, or by its id when it has none", () => {
    const rows = lootRows([loot(1, "salewa"), loot(2, "bolts")], catalog, new Map(), needs.items).items;
    const match = (q: string) => matchingRows(rows, q, catalog).map((r) => r.key);
    expect(entries.find((q) => q.id === "q1")?.query).toBe("quest:Shortage");
    expect(match(entries.find((q) => q.id === "q1")!.query)).toEqual(["loot:1"]);
    expect(entries.find((q) => q.id === "q2")?.query).toBe("quest:q2");
    expect(match(entries.find((q) => q.id === "q2")!.query)).toEqual(["loot:2"]);
  });
});
