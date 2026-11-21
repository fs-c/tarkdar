// Quests to import (Quests view): tarkov.dev's tasks feed, reduced to what a quest that isn't started
// yet needs: its name, trader and item objectives (find, hand over, plant; ordinary and quest items).
// Downloaded only when the import is opened, cached like the item catalogue. An imported quest keeps
// its own copy (persist/prefs.ts QuestPrefs), so it works without the feed. tarkov.dev doesn't have
// story, event or SPT-generated quests; the regular trader quests use the game's ids and condition ids.

import { type Cache, type CacheDef, feedCache, isFresh, readCache, writeCache } from "./cache";
import { FEED_BASE } from "./catalog";
import type { QuestObjective } from "./protocol";

const CACHE: CacheDef = { key: "tasks", version: 1 };
const MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** A quest as imported: what it needs, and names the item catalogue doesn't have (quest items). */
export interface ImportedQuest {
  id: string;
  name: string;
  /** Trader id. */
  trader?: string;
  objectives: QuestObjective[];
  /** Quest item template id → name. */
  itemNames?: Record<string, string>;
}

const TYPES: Record<string, QuestObjective["type"]> = {
  findItem: "find", giveItem: "handover", plantItem: "plant",
  findQuestItem: "find", giveQuestItem: "handover", plantQuestItem: "plant",
};

const str = (v: unknown): v is string => typeof v === "string" && v !== "";

/** Reduces the tasks feed (and its English texts) to importable quests, by name. */
export function slimTaskFeed(tasksFeed: unknown, translationsFeed: unknown): ImportedQuest[] {
  const data = (tasksFeed as { data?: { tasks?: unknown; questItems?: unknown } })?.data;
  const tasks = data?.tasks;
  if (!tasks || typeof tasks !== "object") throw new Error("unexpected tasks feed format");
  const en = (translationsFeed as { data?: Record<string, unknown> })?.data ?? {};
  const text = (key: unknown) => (str(key) && str(en[key]) ? (en[key] as string) : undefined);
  const questItems = (data?.questItems ?? {}) as Record<string, { name?: unknown; shortName?: unknown }>;
  const out: ImportedQuest[] = [];
  for (const [id, t] of Object.entries(tasks as Record<string, Record<string, unknown>>)) {
    const name = text(t?.name) ?? text(`${id} name`);
    if (!name) continue;
    const objectives: QuestObjective[] = [];
    const itemNames: Record<string, string> = {};
    for (const o of Array.isArray(t.objectives) ? (t.objectives as Record<string, unknown>[]) : []) {
      const type = str(o?.type) ? TYPES[o.type] : undefined;
      if (!type || !str(o.id) || o.optional === true) continue;
      const items = str(o.questItem) ? [o.questItem] : Array.isArray(o.items) ? o.items.filter(str) : [];
      if (!items.length) continue;
      if (str(o.questItem)) {
        const n = text(questItems[o.questItem]?.name) ?? text(questItems[o.questItem]?.shortName);
        if (n) itemNames[o.questItem] = n;
      }
      const objective: QuestObjective = { id: o.id, type, items, count: typeof o.count === "number" && o.count > 0 ? o.count : 1 };
      if (o.foundInRaid === true) objective.fir = true;
      const description = text(o.description);
      if (description) objective.text = description;
      objectives.push(objective);
    }
    const q: ImportedQuest = { id, name, objectives };
    if (str(t.trader)) q.trader = t.trader;
    if (Object.keys(itemNames).length) q.itemNames = itemNames;
    out.push(q);
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

const isList = (d: unknown): d is ImportedQuest[] => Array.isArray(d);

export interface TaskFeed {
  quests: ImportedQuest[];
  /** Set when the download failed (the quests are then the stale cache's, or none). */
  error?: string;
}

/** The importable quests: cached if fresh, else downloaded, else the stale cache. */
export async function loadTaskFeed(opts: { now?: number; cache?: Cache; fetchFn?: typeof fetch } = {}): Promise<TaskFeed> {
  const now = opts.now ?? Date.now();
  const cache = opts.cache ?? feedCache;
  const fetchFn = opts.fetchFn ?? fetch.bind(globalThis);
  const cached = await readCache(cache, CACHE, isList);
  if (cached && isFresh(cached, now, MAX_AGE_MS)) return { quests: cached.data };
  try {
    const get = async (feed: string) => {
      const res = await fetchFn(`${FEED_BASE}/${feed}`);
      if (!res.ok) throw new Error(`${feed}: HTTP ${res.status}`);
      return res.json();
    };
    const [tasks, en] = await Promise.all([get("tasks"), get("tasks_en")]);
    const quests = slimTaskFeed(tasks, en);
    await writeCache(cache, CACHE, quests, now);
    return { quests };
  } catch (e) {
    return { quests: cached?.data ?? [], error: e instanceof Error ? e.message : String(e) };
  }
}
