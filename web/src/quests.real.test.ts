// The quest logic on real data: quests.fixture.json is tarkov.dev's tasks feed (pvp-season, November
// 2026) trimmed to the quests that matter here, with the `quests` message and the quest items of an SPT
// raid on Reserve (recordings/2026-11-19_21-14-07_RezervBase). Its quest items come in copies (dedupe.ts),
// and 37 of the started quests aren't in the feed.

import { describe, expect, it } from "vitest";
import { withoutDuplicateLoot } from "./dedupe";
import type { LootEntry, QuestState } from "./protocol";
import fixture from "./quests.fixture.json";
import {
  type QuestData,
  knownQuestItems,
  neededQuestItems,
  questDebugReport,
  questItemLabels,
  questNames,
  questOutline,
  slimItemObjectives,
  slimTasks,
  withoutUnneededQuestItems,
} from "./quests";

const quests = fixture.quests as QuestState[];
const loot = fixture.questLoot as LootEntry[];
const tasks = slimTasks(fixture.tasks);
const items = slimItemObjectives(fixture.tasks);
const outline = questOutline(fixture.tasks);
const names = questNames(fixture.tasks, fixture.tasksEn, tasks, items);
const data: QuestData = { tasks, items, outline, names, status: { state: "ready", fetchedAt: 0 } };

describe("quests on real data (SPT, Reserve)", () => {
  it("merges the copies of quest items", () => {
    const merged = withoutDuplicateLoot(loot);
    expect(loot).toHaveLength(49);
    expect(merged).toHaveLength(18);
    expect(new Set(merged.map((l) => l.tpl)).size).toBe(18);
  });

  it("can't filter quest items while started quests are missing from the feed", () => {
    const needed = neededQuestItems(quests, tasks)!;
    expect(needed.started).toBe(110);
    expect(needed.complete).toBe(false);
    const merged = withoutDuplicateLoot(loot);
    const known = knownQuestItems(tasks);
    // 1 needed, 7 the feed doesn't know (kept), 10 left out.
    expect(merged.filter((l) => needed.items.has(l.tpl))).toHaveLength(1);
    expect(merged.filter((l) => !known.has(l.tpl))).toHaveLength(7);
    expect(withoutUnneededQuestItems(merged, needed, known)).toHaveLength(8);
  });

  it("labels quest items with their quest's name", () => {
    const labels = questItemLabels(quests, tasks, names);
    const merged = withoutDuplicateLoot(loot);
    const known = knownQuestItems(tasks);
    for (const l of merged.filter((l) => known.has(l.tpl))) expect(labels.get(l.tpl)).toBeTruthy();
  });

  it("reports the missing quests and why each quest item shows", () => {
    const r = questDebugReport({ data, quests, loot: withoutDuplicateLoot(loot), filterOn: true, itemName: () => undefined });
    expect(r.backend).toBe("read");
    expect(r.started).toBe(110);
    expect(r.readyToHandIn).toBe(3);
    expect(r.missing).toHaveLength(37);
    expect(r.filter.effect).toMatch(/37 started quests unknown/);
    // Missing quests are listed first.
    expect(r.quests.slice(0, 37).every((q) => !q.inData)).toBe(true);
    // The completed condition ids SPT reports are the feed's objective ids.
    expect(r.quests.flatMap((q) => q.unknownDone)).toEqual([]);
    expect(r.questItems).toHaveLength(18);
    expect(r.questItems.filter((i) => i.shown)).toHaveLength(8);
    expect(r.questItems.filter((i) => i.needed)).toHaveLength(1);
    expect(r.questItems.filter((i) => !i.shown).every((i) => i.why === "no started quest needs it")).toBe(true);
  });
});
