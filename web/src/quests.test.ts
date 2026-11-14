import { describe, expect, it } from "vitest";
import type { LootEntry, QuestState } from "./protocol";
import { knownQuestItems, loadQuestData, neededQuestItems, slimTasks, withoutUnneededQuestItems } from "./quests";

const feed = {
  data: {
    tasks: {
      q1: {
        objectives: [
          { id: "o1", type: "findQuestItem", questItem: "itemA" },
          { id: "o2", type: "giveQuestItem", questItem: "itemA" },
          { id: "o3", type: "findQuestItem", questItem: "itemB" },
        ],
      },
      q2: { objectives: [{ id: "o4", type: "findQuestItem", questItem: "itemC" }] },
      q3: { objectives: [{ id: "o5", type: "visit" }] },
    },
  },
};

const quest = (id: string, status: number, done: string[] | null = []): QuestState => ({ id, status, done });
const loot = (id: number, kind: LootEntry["kind"], tpl: string): LootEntry => ({ id, kind, tpl, obj: "", pos: [0, 0, 0] });

describe("quests", () => {
  it("keeps only find-quest-item objectives, and every quest", () => {
    expect(slimTasks(feed)).toEqual({ q1: [["o1", "itemA"], ["o3", "itemB"]], q2: [["o4", "itemC"]], q3: [] });
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
    const ok = (async () => (calls++, new Response(JSON.stringify(feed)))) as typeof fetch;
    const failing = (async () => (calls++, new Response("", { status: 503 }))) as typeof fetch;

    const first = await loadQuestData({ now: 1000, storage, fetchFn: ok });
    expect(first.status.state).toBe("ready");
    expect(first.tasks?.q2).toEqual([["o4", "itemC"]]);
    const cached = await loadQuestData({ now: 2000, storage, fetchFn: failing });
    expect(cached.status.state).toBe("ready");
    expect(calls).toBe(1);
    const stale = await loadQuestData({ now: 1000 + 2 * 24 * 3600 * 1000, storage, fetchFn: failing });
    expect(stale.status.state).toBe("stale");
    expect(stale.tasks).toEqual(first.tasks);
    const none = await loadQuestData({ now: 0, storage: { getItem: () => null, setItem: () => {} }, fetchFn: failing });
    expect(none).toMatchObject({ tasks: null, status: { state: "unavailable" } });
  });
});
