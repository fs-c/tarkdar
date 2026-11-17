// Quest data from tarkov.dev's JSON API ("tasks" feed), cached in the browser like the item catalogue,
// and which quest items the local player still needs.
//
// Only what the quest item filter and labels need is kept: per quest, its "find quest item" objectives
// (objective id → the quest item's template id), and English names (the `tasks_en` feed: names in `tasks`
// are translation keys like "<id> name") of the quests that have any and of the quest items, which the
// item catalogue doesn't have. Objective ids are the game's condition ids, so together with the
// backend's `quests` message (quests in progress and their completed conditions) they tell which quest
// items on the map are still wanted. SPT uses the live game's quest ids.

import { FEED_BASE } from "./catalog";
import type { LootEntry, QuestState } from "./protocol";

const STORAGE_KEY = "radar.quests.v3";
const MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** EQuestStatus: started (and not yet ready to hand in). */
export const QUEST_STARTED = 2;

/** Quest id → its find-quest-item objectives: [objective id, quest item template id]. */
export type SlimTasks = Record<string, [string, string][]>;

export interface QuestNames {
  /** Quest id → name, for quests with quest items to find. */
  quests: Record<string, string>;
  /** Quest item template id → short name. */
  items: Record<string, string>;
}

export interface QuestDataStatus {
  state: "loading" | "ready" | "stale" | "unavailable";
  fetchedAt: number | null;
  error?: string;
}

/** Reduces the tasks feed to the slim form. Every quest is kept (most with no quest items to find):
 *  a started quest missing from it means the data is incomplete. */
export function slimTasks(tasksFeed: unknown): SlimTasks {
  const tasks = (tasksFeed as { data?: { tasks?: Record<string, { objectives?: unknown }> } })?.data?.tasks;
  if (!tasks || typeof tasks !== "object") throw new Error("unexpected tasks feed format");
  const out: SlimTasks = {};
  for (const [id, task] of Object.entries(tasks)) {
    const objectives = Array.isArray(task?.objectives) ? (task.objectives as Record<string, unknown>[]) : [];
    const finds: [string, string][] = [];
    for (const o of objectives) {
      if (o?.type === "findQuestItem" && typeof o.id === "string" && typeof o.questItem === "string") finds.push([o.id, o.questItem]);
    }
    out[id] = finds;
  }
  return out;
}

/** The English names of the quests with quest items to find, and of the quest items. Anything without a
 *  translation is left out (it gets a less specific label). */
export function questNames(tasksFeed: unknown, translationsFeed: unknown, tasks: SlimTasks): QuestNames {
  const data = (tasksFeed as { data?: { tasks?: Record<string, { name?: unknown }>; questItems?: Record<string, { shortName?: unknown }> } })?.data;
  const en = (translationsFeed as { data?: Record<string, string> })?.data ?? {};
  const translated = (key: unknown) => (typeof key === "string" && typeof en[key] === "string" && en[key] ? en[key] : null);
  const out: QuestNames = { quests: {}, items: {} };
  for (const [id, finds] of Object.entries(tasks)) {
    const name = finds.length ? translated(data?.tasks?.[id]?.name ?? `${id} name`) : null;
    if (name) out.quests[id] = name;
  }
  for (const [tpl, item] of Object.entries(data?.questItems ?? {})) {
    const name = translated(item?.shortName);
    if (name) out.items[tpl] = name;
  }
  return out;
}

/**
 * The quest items still needed, by template id. A quest item is needed while a started quest has a
 * find objective for it that isn't completed; a quest whose completed conditions couldn't be read
 * counts all its objectives as open.
 */
export interface NeededQuestItems {
  items: Set<string>;
  /** Every started quest is in the quest data, so no other quest item can be needed. False when one
   *  isn't (e.g. a modded or event quest): quest items the data doesn't know might be its. */
  complete: boolean;
  /** Started quests. */
  started: number;
}

/** Null when it can't be told (no quest state from the backend, e.g. an older recording, or no quest
 *  data): then every quest item shows. */
export function neededQuestItems(quests: readonly QuestState[] | null, tasks: SlimTasks | null): NeededQuestItems | null {
  if (!quests || !tasks) return null;
  const needed: NeededQuestItems = { items: new Set(), complete: true, started: 0 };
  for (const q of quests) {
    if (q.status !== QUEST_STARTED) continue;
    needed.started++;
    if (!Object.hasOwn(tasks, q.id)) {
      needed.complete = false;
      continue;
    }
    for (const [objective, tpl] of tasks[q.id]!) if (!q.done?.includes(objective)) needed.items.add(tpl);
  }
  return needed;
}

/** Every quest item template the quest data knows (any quest's find objective). */
export function knownQuestItems(tasks: SlimTasks | null): Set<string> {
  const known = new Set<string>();
  for (const finds of Object.values(tasks ?? {})) for (const [, tpl] of finds) known.add(tpl);
  return known;
}

/**
 * Drops the quest items nobody needs; everything else stays. While a started quest isn't in the quest
 * data, quest items the data doesn't know can't be judged and stay too. Returns the same array if
 * nothing goes.
 */
export function withoutUnneededQuestItems(loot: LootEntry[], needed: NeededQuestItems | null, known: Set<string>): LootEntry[] {
  if (!needed) return loot;
  const keep = (l: LootEntry) => l.kind !== "quest" || needed.items.has(l.tpl) || (!needed.complete && !known.has(l.tpl));
  return loot.every(keep) ? loot : loot.filter(keep);
}

/**
 * Quest item template id → its label: the name of the quest it's for. Started quests that still need it
 * come first; failing that (not started, or no quest state), every quest with a find objective for it.
 * Several quests are joined with " / ". A quest item without a named quest gets its own name, if known.
 */
export function questItemLabels(quests: readonly QuestState[] | null, tasks: SlimTasks | null, names: QuestNames | null): Map<string, string> {
  const labels = new Map<string, string>();
  if (!tasks || !names) return labels;
  const add = (into: Map<string, Set<string>>, tpl: string, quest: string) => {
    if (!Object.hasOwn(names.quests, quest)) return;
    let set = into.get(tpl);
    if (!set) into.set(tpl, (set = new Set()));
    set.add(names.quests[quest]!);
  };
  const open = new Map<string, Set<string>>();
  for (const q of quests ?? []) {
    if (q.status !== QUEST_STARTED || !Object.hasOwn(tasks, q.id)) continue;
    for (const [objective, tpl] of tasks[q.id]!) if (!q.done?.includes(objective)) add(open, tpl, q.id);
  }
  const any = new Map<string, Set<string>>();
  for (const [quest, finds] of Object.entries(tasks)) for (const [, tpl] of finds) add(any, tpl, quest);
  for (const [tpl, all] of any) labels.set(tpl, [...(open.get(tpl) ?? all)].join(" / "));
  for (const [tpl, name] of Object.entries(names.items)) if (!labels.has(tpl)) labels.set(tpl, name);
  return labels;
}

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

interface CachedTasks {
  fetchedAt: number;
  tasks: SlimTasks;
  names: QuestNames;
}

function readCache(storage: StorageLike): CachedTasks | null {
  try {
    const c = JSON.parse(storage.getItem(STORAGE_KEY) ?? "null") as CachedTasks | null;
    return c && typeof c.fetchedAt === "number" && c.tasks && typeof c.tasks === "object" && c.names?.quests && c.names.items ? c : null;
  } catch {
    return null;
  }
}

/**
 * Returns the quest data: from the cache if it's fresh, otherwise freshly downloaded (and cached),
 * otherwise the stale cache. `fetchFn` and `storage` are injectable for tests.
 */
export async function loadQuestData(
  opts: { now?: number; storage?: StorageLike; fetchFn?: typeof fetch } = {},
): Promise<{ tasks: SlimTasks | null; names: QuestNames | null; status: QuestDataStatus }> {
  const now = opts.now ?? Date.now();
  const storage = opts.storage ?? localStorage;
  const fetchFn = opts.fetchFn ?? fetch.bind(globalThis);
  const cached = readCache(storage);
  const age = cached ? now - cached.fetchedAt : Infinity;
  if (cached && age >= 0 && age < MAX_AGE_MS) return { tasks: cached.tasks, names: cached.names, status: { state: "ready", fetchedAt: cached.fetchedAt } };
  try {
    const get = async (feed: string) => {
      const res = await fetchFn(`${FEED_BASE}/${feed}`);
      if (!res.ok) throw new Error(`${feed}: HTTP ${res.status}`);
      return res.json();
    };
    const [feed, en] = await Promise.all([get("tasks"), get("tasks_en")]);
    const tasks = slimTasks(feed);
    const names = questNames(feed, en, tasks);
    try {
      storage.setItem(STORAGE_KEY, JSON.stringify({ fetchedAt: now, tasks, names } satisfies CachedTasks));
    } catch (e) {
      console.warn("couldn't cache quest data", e);
    }
    return { tasks, names, status: { state: "ready", fetchedAt: now } };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    if (cached) return { tasks: cached.tasks, names: cached.names, status: { state: "stale", fetchedAt: cached.fetchedAt, error } };
    return { tasks: null, names: null, status: { state: "unavailable", fetchedAt: null, error } };
  }
}
