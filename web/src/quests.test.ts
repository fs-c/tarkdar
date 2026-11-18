import { describe, expect, it } from "vitest";
import type { LootEntry, QuestState } from "./protocol";
import {
  SPECIFIC_ITEMS,
  formatQuestNeed,
  isSpecific,
  knownQuestItems,
  loadQuestData,
  neededItems,
  neededQuestItems,
  questItemLabels,
  questNames,
  slimItemObjectives,
  slimTasks,
  withoutUnneededQuestItems,
} from "./quests";

const feed = {
  data: {
    questItems: { itemB: { shortName: "itemB ShortName" }, orphan: { shortName: "orphan ShortName" }, untranslated: { shortName: "x" } },
    tasks: {
      q1: {
        name: "q1 name",
        objectives: [
          { id: "o1", type: "findQuestItem", questItem: "itemA" },
          { id: "o2", type: "giveQuestItem", questItem: "itemA" },
          { id: "o3", type: "findQuestItem", questItem: "itemB" },
        ],
      },
      q2: { name: "q2 name", objectives: [{ id: "o4", type: "findQuestItem", questItem: "itemC" }] },
      q4: { name: "q4 name", objectives: [{ id: "o6", type: "findQuestItem", questItem: "itemB" }] },
      q3: { objectives: [{ id: "o5", type: "visit" }] },
    },
  },
};
const en = { data: { "q1 name": "First", "q2 name": "Second", "q3 name": "Third", "q4 name": "Fourth", "itemB ShortName": "B", "orphan ShortName": "Orphan" } };
const NAMES = { quests: { q1: "First", q2: "Second", q4: "Fourth" }, items: { itemB: "B", orphan: "Orphan" } };

const quest = (id: string, status: number, done: string[] | null = []): QuestState => ({ id, status, done });
const loot = (id: number, kind: LootEntry["kind"], tpl: string): LootEntry => ({ id, kind, tpl, obj: "", pos: [0, 0, 0] });

describe("quests", () => {
  it("keeps only find-quest-item objectives, and every quest", () => {
    expect(slimTasks(feed)).toEqual({ q1: [["o1", "itemA"], ["o3", "itemB"]], q2: [["o4", "itemC"]], q3: [], q4: [["o6", "itemB"]] });
    expect(() => slimTasks({})).toThrow();
  });

  it("needs the items of started quests' open objectives", () => {
    const tasks = slimTasks(feed);
    expect(neededQuestItems(null, tasks)).toBeNull();
    expect(neededQuestItems([], null)).toBeNull();
    // q1 started with o1 done; q2 ready to hand in (3): nothing needed from it.
    expect(neededQuestItems([quest("q1", 2, ["o1"]), quest("q2", 3), quest("q3", 2)], tasks)).toEqual({
      items: new Set(["itemB"]), complete: true, started: 2,
    });
    // Unreadable completed conditions: every objective counts as open.
    expect(neededQuestItems([quest("q1", 2, null)], tasks)?.items).toEqual(new Set(["itemA", "itemB"]));
    // A started quest the data doesn't know.
    expect(neededQuestItems([quest("unknown", 2)], tasks)).toEqual({ items: new Set(), complete: false, started: 1 });
  });

  it("names quests with quest items to find and quest items, only those with a translation", () => {
    const tasks = slimTasks(feed);
    expect(questNames(feed, en, tasks)).toEqual(NAMES);
    expect(questNames(feed, { data: { "q2 name": "Second" } }, tasks)).toEqual({ quests: { q2: "Second" }, items: {} });
  });

  it("labels quest items with the started quests that still need them, else every quest", () => {
    const tasks = slimTasks(feed);
    const names = questNames(feed, en, tasks);
    expect(questItemLabels(null, tasks, null).size).toBe(0);
    // No quest state: every quest with a find objective for it.
    expect(questItemLabels(null, tasks, names)).toEqual(new Map([["itemA", "First"], ["itemB", "First / Fourth"], ["itemC", "Second"], ["orphan", "Orphan"]]));
    // q4 started and needing itemB: only q4; q1 started but itemA done: still labelled from all quests.
    const labels = questItemLabels([quest("q1", 2, ["o1", "o3"]), quest("q4", 2)], tasks, names);
    expect(labels.get("itemB")).toBe("Fourth");
    expect(labels.get("itemA")).toBe("First");
    // An untranslated quest gives no label.
    // An untranslated quest: the item's own name, or nothing.
    expect(questItemLabels(null, tasks, { quests: { q1: "First" }, items: { itemB: "B" } }).get("itemC")).toBeUndefined();
    expect(questItemLabels(null, tasks, { quests: { q2: "Second" }, items: { itemB: "B" } }).get("itemB")).toBe("B");
  });

  it("drops quest items nobody needs, and unknown ones only when every started quest is known", () => {
    const tasks = slimTasks(feed);
    const known = knownQuestItems(tasks);
    const all = [loot(1, "quest", "itemA"), loot(2, "quest", "itemB"), loot(3, "quest", "modded"), loot(4, "item", "itemA")];
    const ids = (l: LootEntry[]) => l.map((x) => x.id);
    expect(ids(withoutUnneededQuestItems(all, { items: new Set(["itemB"]), complete: true, started: 1 }, known))).toEqual([2, 4]);
    expect(ids(withoutUnneededQuestItems(all, { items: new Set(["itemB"]), complete: false, started: 2 }, known))).toEqual([2, 3, 4]);
    expect(withoutUnneededQuestItems(all, null, known)).toBe(all);
    const nothingToDrop = [loot(2, "quest", "itemB")];
    expect(withoutUnneededQuestItems(nothingToDrop, { items: new Set(["itemB"]), complete: true, started: 1 }, known)).toBe(nothingToDrop);
  });

  it("loads from the feed, then the cache, and falls back to a stale cache", async () => {
    const store = new Map<string, string>();
    const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) };
    let calls = 0;
    const ok = (async (url: string) => (calls++, new Response(JSON.stringify(url.endsWith("_en") ? en : feed)))) as typeof fetch;
    const failing = (async () => (calls++, new Response("", { status: 503 }))) as typeof fetch;

    const first = await loadQuestData({ now: 1000, storage, fetchFn: ok });
    expect(first.status.state).toBe("ready");
    expect(first.tasks?.q2).toEqual([["o4", "itemC"]]);
    expect(first.items).toEqual({});
    const cached = await loadQuestData({ now: 2000, storage, fetchFn: failing });
    expect(cached.status.state).toBe("ready");
    expect(first.names).toEqual(NAMES);
    expect(cached.names).toEqual(first.names);
    expect(calls).toBe(2);
    const stale = await loadQuestData({ now: 1000 + 2 * 24 * 3600 * 1000, storage, fetchFn: failing });
    expect(stale.status.state).toBe("stale");
    expect(stale.tasks).toEqual(first.tasks);
    const none = await loadQuestData({ now: 0, storage: { getItem: () => null, setItem: () => {} }, fetchFn: failing });
    expect(none).toMatchObject({ tasks: null, items: null, names: null, status: { state: "unavailable" } });
  });
});

describe("ordinary items needed by quests", () => {
  const itemFeed = {
    data: {
      tasks: {
        // Find in raid, then hand over: the hand-over defers to the find.
        gun: {
          name: "gun name",
          objectives: [
            { id: "find", type: "findItem", items: ["salewa", "ifak"], count: 3, foundInRaid: true },
            { id: "give", type: "giveItem", items: ["ifak", "salewa"], count: 3, foundInRaid: true },
          ],
        },
        // Only a hand-over (and a plant); a sell objective isn't loot.
        drop: {
          name: "drop name",
          objectives: [
            { id: "hand", type: "giveItem", items: ["salewa"], count: 1, foundInRaid: false },
            // Money is handed over from the stash: left out (an objective with nothing else, entirely).
            { id: "pay", type: "giveItem", items: ["5449016a4bdc2d6f028b456f"], count: 100000 },
            { id: "plant", type: "plantItem", items: ["marker"], count: 2 },
            { id: "sell", type: "sellItem", items: ["salewa"], count: 9 },
            { id: "qi", type: "findQuestItem", questItem: "folder" },
          ],
        },
        none: { name: "none name", objectives: [{ id: "v", type: "visit" }] },
      },
    },
  };
  const itemEn = { data: { "gun name": "Gunsmith", "drop name": "Drop" } };

  it("keeps find, hand-over and plant objectives, a hand-over only without a matching find", () => {
    expect(slimItemObjectives(itemFeed)).toEqual({
      gun: [["find", ["salewa", "ifak"], 3, true]],
      drop: [["hand", ["salewa"], 1, false], ["plant", ["marker"], 2, false]],
    });
    expect(() => slimItemObjectives({})).toThrow();
  });

  it("singles out only objectives few items count for", () => {
    expect(isSpecific({ quest: "q", count: 1, fir: false, of: SPECIFIC_ITEMS })).toBe(true);
    expect(isSpecific({ quest: "q", count: 3, fir: false, of: 60 })).toBe(false);
    expect(formatQuestNeed({ quest: "First in Line", count: 3, fir: false, of: 60 })).toBe("First in Line (×3, any of 60)");
  });

  it("names quests with item objectives", () => {
    const names = questNames(itemFeed, itemEn, slimTasks(itemFeed), slimItemObjectives(itemFeed));
    expect(names.quests).toEqual({ gun: "Gunsmith", drop: "Drop" });
  });

  it("needs the items of started quests' open objectives", () => {
    const objectives = slimItemObjectives(itemFeed);
    const names = questNames(itemFeed, itemEn, slimTasks(itemFeed), objectives);
    expect(neededItems(null, objectives, names).size).toBe(0);
    // gun started, nothing done; drop started with the plant done; a finished quest needs nothing.
    const needs = neededItems([quest("gun", 2), quest("drop", 2, ["plant"]), quest("none", 4)], objectives, names);
    expect(needs.get("salewa")).toEqual([{ quest: "Gunsmith", count: 3, fir: true, of: 2 }, { quest: "Drop", count: 1, fir: false, of: 1 }]);
    expect(needs.get("ifak")?.map(formatQuestNeed)).toEqual(["Gunsmith (×3, FIR, any of 2)"]);
    expect(needs.has("marker")).toBe(false);
    // Not started (ready to hand in), or found already: nothing.
    expect(neededItems([quest("gun", 3)], objectives, names).size).toBe(0);
    expect(neededItems([quest("gun", 2, ["find"])], objectives, names).size).toBe(0);
    // Unreadable completed conditions: every objective open. Unnamed quests go by id.
    expect(neededItems([quest("drop", 2, null)], objectives, null).get("marker")).toEqual([{ quest: "drop", count: 2, fir: false, of: 1 }]);
  });
});
