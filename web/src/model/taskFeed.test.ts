import { describe, expect, it } from "vitest";
import { memoryCache } from "./cache";
import { loadTaskFeed, slimTaskFeed } from "./taskFeed";

const tasks = {
  data: {
    tasks: {
      q1: {
        name: "q1 name",
        trader: "54cb50c76803fa8b248b4571",
        objectives: [
          { id: "o1", description: "o1", type: "giveItem", count: 3, items: ["a", "b"], foundInRaid: true },
          { id: "o2", type: "findQuestItem", count: 1, questItem: "qi" },
          { id: "o3", type: "shoot", count: 10 },
          { id: "o4", type: "findItem", count: 1, items: ["c"], optional: true },
        ],
      },
      q2: { name: "q2 name", objectives: null },
      q3: { name: "untranslated", objectives: [] },
    },
    questItems: { qi: { name: "qi Name", shortName: "qi ShortName" } },
  },
};
const en = { data: { "q1 name": "Gunsmith", "q2 name": "Acclimatization", o1: "Hand over the items", "qi Name": "Secure folder" } };

describe("slimTaskFeed", () => {
  it("keeps named quests with their item objectives, quest items with their names", () => {
    expect(slimTaskFeed(tasks, en)).toEqual([
      { id: "q2", name: "Acclimatization", objectives: [] },
      {
        id: "q1", name: "Gunsmith", trader: "54cb50c76803fa8b248b4571", itemNames: { qi: "Secure folder" },
        objectives: [
          { id: "o1", type: "handover", items: ["a", "b"], count: 3, fir: true, text: "Hand over the items" },
          { id: "o2", type: "find", items: ["qi"], count: 1 },
        ],
      },
    ]);
    expect(() => slimTaskFeed({}, en)).toThrow();
  });
});

describe("loadTaskFeed", () => {
  it("downloads once a day; a failed download falls back to the cache", async () => {
    const cache = memoryCache();
    let calls = 0;
    const ok = (async (url: string) => (calls++, new Response(JSON.stringify(String(url).endsWith("_en") ? en : tasks)))) as unknown as typeof fetch;
    expect((await loadTaskFeed({ cache, fetchFn: ok, now: 1000 })).quests).toHaveLength(2);
    expect((await loadTaskFeed({ cache, fetchFn: ok, now: 2000 })).quests).toHaveLength(2);
    expect(calls).toBe(2);
    const down = (async () => new Response("", { status: 503 })) as unknown as typeof fetch;
    const stale = await loadTaskFeed({ cache, fetchFn: down, now: 1000 + 25 * 3600 * 1000 });
    expect(stale.quests).toHaveLength(2);
    expect(stale.error).toMatch(/503/);
  });
});
