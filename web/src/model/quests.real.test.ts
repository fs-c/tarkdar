// The quest logic on real data: quests.fixture.json's `quests` is an SPT profile's 126 quests in
// progress (2026-11-20), as the backend sends them, converted from a quest probe dump (--quest-probe);
// completed conditions weren't in the dump, so none are done. Its `questLoot` is the quest items of an
// SPT raid on Reserve (2026-11-19, a day earlier), which come in copies (dedupe.ts).

import { describe, expect, it } from "vitest";
import { withoutDuplicateLoot } from "./dedupe";
import type { LootEntry, QuestState } from "./protocol";
import fixture from "./quests.fixture.json";
import { questDebugReport } from "./quests.debug";
import { questItemLabels, questLabel, questNeeds, withoutUnneededQuestItems } from "./quests";

const quests = fixture.quests as QuestState[];
const loot = fixture.questLoot as LootEntry[];

describe("quests on real data (SPT)", () => {
  it("merges the copies of quest items", () => {
    const merged = withoutDuplicateLoot(loot);
    expect(loot).toHaveLength(49);
    expect(merged).toHaveLength(18);
    expect(new Set(merged.map((l) => l.tpl)).size).toBe(18);
  });

  it("knows every started quest's objectives, so quest items can be filtered", () => {
    const needs = questNeeds(quests)!;
    expect(needs.started).toBe(126);
    expect(needs.complete).toBe(true);
    const merged = withoutDuplicateLoot(loot);
    expect(withoutUnneededQuestItems(merged, needs)).toHaveLength(3);
  });

  it("names quests, including those tarkov.dev doesn't have", () => {
    const byId = new Map(quests.map((q) => [q.id, q]));
    expect(questLabel(byId.get("5969f90786f77420d2328015")!)).toBe("Charity");
    expect(questLabel(byId.get("6a4f833633bd1e904c091ef2")!)).toBe("[KORD BREACH] Riding the Wave");
    expect(questLabel(byId.get("68cbd33676fe74b1e80bfd91")!)).toBe("Tour");
    const repeatables = quests.filter((q) => q.kind === "daily" || q.kind === "weekly").map(questLabel).sort();
    expect(repeatables).toEqual(["Jaeger weekly", "Mechanic daily", "Mechanic daily", "Skier daily", "Therapist daily"]);
  });

  it("counts hidden story steps as story", () => {
    const r = questDebugReport({ quests, loot: withoutDuplicateLoot(loot), filterOn: true, itemName: () => undefined });
    expect(r.byKind).toEqual({ story: 24, side: 97, daily: 4, weekly: 1 });
    expect(r.unknown).toEqual([]);
    const hidden = r.quests.filter((q) => q.hidden);
    expect(hidden).toHaveLength(9);
    expect(hidden.every((q) => q.kind === "story")).toBe(true);
    expect(r.questItems.filter((i) => i.shown).map((i) => i.label)).toEqual(["Disease History", "Disease History", "Story"]);
  });

  it("labels every needed quest item", () => {
    const needs = questNeeds(quests)!;
    const labels = questItemLabels(needs);
    for (const tpl of needs.items.keys()) expect(labels.get(tpl)).toBeTruthy();
  });
});
