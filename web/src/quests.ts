// Quest data from tarkov.dev's JSON API ("tasks" feed), cached in the browser like the item catalogue,
// and which quest items the local player still needs.
//
// Only what the quest item filter, the "needed for quests" rule and labels need is kept: per quest, its
// "find quest item" objectives (objective id → the quest item's template id), its objectives for
// ordinary items (find, hand over, plant: objective id → the items that count), and English names (the
// `tasks_en` feed: names in `tasks` are translation keys like "<id> name") of the quests that have any
// and of the quest items, which the item catalogue doesn't have. Objective ids are the game's condition
// ids, so together with the backend's `quests` message (quests in progress and their completed
// conditions) they tell which items on the map are still wanted. SPT uses the live game's quest ids.

import { FEED_BASE } from "./catalog";
import type { LootEntry, QuestState } from "./protocol";

const STORAGE_KEY = "radar.quests.v5";
const MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** EQuestStatus: started (and not yet ready to hand in). */
export const QUEST_STARTED = 2;

/** Quest id → its find-quest-item objectives: [objective id, quest item template id]. */
export type SlimTasks = Record<string, [string, string][]>;

/**
 * An objective for ordinary items: [objective id, the items that count (any of them), how many, found in
 * raid only].
 */
export type ItemObjective = [string, string[], number, boolean];
/** Quest id → its objectives for ordinary items. */
export type ItemObjectives = Record<string, ItemObjective[]>;

/** Quest id → every objective it has, of any type: [objective id, type]. For the debug view: which of
 *  the game's completed condition ids the quest data knows. */
export type QuestOutline = Record<string, [string, string][]>;

/** Objective types for ordinary items that can be picked up in a raid. (sellItem, mark, useItem and
 *  buildWeapon involve items too, but not loot.) */
const ITEM_OBJECTIVE_TYPES = new Set(["findItem", "giveItem", "plantItem"]);
/** Roubles, dollars, euros: handed over from the stash, not looked for in a raid. */
const CURRENCIES = new Set(["5449016a4bdc2d6f028b456f", "5696686a4bdc2da3298b456a", "569668774bdc2da2298b4568"]);
/** An objective any of more items than this counts for is too broad to single its items out
 *  ("any medical item"): they're labelled, but not highlighted (QuestNeed.specific). */
export const SPECIFIC_ITEMS = 5;

export interface QuestNames {
  /** Quest id → name, for quests with items to find. */
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

/** Every quest's objectives, of any type: their ids and types. */
export function questOutline(tasksFeed: unknown): QuestOutline {
  const tasks = (tasksFeed as { data?: { tasks?: Record<string, { objectives?: unknown }> } })?.data?.tasks;
  if (!tasks || typeof tasks !== "object") throw new Error("unexpected tasks feed format");
  const out: QuestOutline = {};
  for (const [id, task] of Object.entries(tasks)) {
    const objectives = Array.isArray(task?.objectives) ? (task.objectives as Record<string, unknown>[]) : [];
    out[id] = objectives.filter((o) => typeof o?.id === "string").map((o) => [o.id as string, typeof o.type === "string" ? o.type : "?"]);
  }
  return out;
}

/**
 * Reduces the tasks feed to each quest's objectives for ordinary items. A hand-over or plant objective
 * for the same items as a find objective of its quest is left out: the find objective says whether
 * they still have to be found (once found, they're carried, not loot).
 */
export function slimItemObjectives(tasksFeed: unknown): ItemObjectives {
  const tasks = (tasksFeed as { data?: { tasks?: Record<string, { objectives?: unknown }> } })?.data?.tasks;
  if (!tasks || typeof tasks !== "object") throw new Error("unexpected tasks feed format");
  const out: ItemObjectives = {};
  const key = (items: string[]) => [...items].sort().join(",");
  for (const [id, task] of Object.entries(tasks)) {
    const objectives = Array.isArray(task?.objectives) ? (task.objectives as Record<string, unknown>[]) : [];
    const all: [...ItemObjective, string][] = []; // plus the objective type
    const found = new Set<string>();
    for (const o of objectives) {
      if (typeof o?.type !== "string" || !ITEM_OBJECTIVE_TYPES.has(o.type) || typeof o.id !== "string" || !Array.isArray(o.items)) continue;
      const items = o.items.filter((t): t is string => typeof t === "string" && t !== "" && !CURRENCIES.has(t));
      if (!items.length) continue;
      if (o.type === "findItem") found.add(key(items));
      all.push([o.id, items, typeof o.count === "number" && o.count > 0 ? o.count : 1, o.foundInRaid === true, o.type]);
    }
    const kept = all.filter((o) => o[4] === "findItem" || !found.has(key(o[1])));
    if (kept.length) out[id] = kept.map(([oid, items, count, fir]): ItemObjective => [oid, items, count, fir]);
  }
  return out;
}

/** The English names of the quests with items to find (quest items or ordinary ones), and of the quest
 *  items. Anything without a translation is left out (it gets a less specific label). */
export function questNames(tasksFeed: unknown, translationsFeed: unknown, tasks: SlimTasks, itemObjectives: ItemObjectives = {}): QuestNames {
  const data = (tasksFeed as { data?: { tasks?: Record<string, { name?: unknown }>; questItems?: Record<string, { shortName?: unknown }> } })?.data;
  const en = (translationsFeed as { data?: Record<string, string> })?.data ?? {};
  const translated = (key: unknown) => (typeof key === "string" && typeof en[key] === "string" && en[key] ? en[key] : null);
  const out: QuestNames = { quests: {}, items: {} };
  for (const [id, finds] of Object.entries(tasks)) {
    const name = finds.length || itemObjectives[id]?.length ? translated(data?.tasks?.[id]?.name ?? `${id} name`) : null;
    if (name) out.quests[id] = name;
  }
  for (const id of Object.keys(itemObjectives)) {
    if (Object.hasOwn(out.quests, id)) continue;
    const name = translated(data?.tasks?.[id]?.name ?? `${id} name`);
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

/** A started quest that still needs an item: its name (or id), and how many of the item, found in raid or
 *  not, the objective asks for (any of its items count). */
export interface QuestNeed {
  quest: string;
  /** The objective's total (the backend doesn't read how many are done). */
  count: number;
  fir: boolean;
  /** How many different items count for the objective (any of them). */
  of: number;
}

/** At most SPECIFIC_ITEMS items count for the objective: worth highlighting. */
export const isSpecific = (n: QuestNeed): boolean => n.of <= SPECIFIC_ITEMS;

/** "Shooter Born in Heaven (×3, FIR)", "First in Line (×3, any of 60)". */
export function formatQuestNeed(n: QuestNeed): string {
  const extra = [n.count > 1 ? `×${n.count}` : "", n.fir ? "FIR" : "", n.of > 1 ? `any of ${n.of}` : ""].filter(Boolean).join(", ");
  return extra ? `${n.quest} (${extra})` : n.quest;
}

/**
 * Ordinary items still needed, by template id: for every started quest, its open objectives for ordinary
 * items (all of them when its completed conditions couldn't be read). One entry per objective; several
 * objectives may need the same item.
 */
export function neededItems(quests: readonly QuestState[] | null, objectives: ItemObjectives | null, names: QuestNames | null): Map<string, QuestNeed[]> {
  const needs = new Map<string, QuestNeed[]>();
  if (!quests || !objectives) return needs;
  for (const q of quests) {
    if (q.status !== QUEST_STARTED || !Object.hasOwn(objectives, q.id)) continue;
    const quest = names?.quests[q.id] ?? q.id;
    for (const [objective, items, count, fir] of objectives[q.id]!) {
      if (q.done?.includes(objective)) continue;
      for (const tpl of items) {
        let list = needs.get(tpl);
        if (!list) needs.set(tpl, (list = []));
        list.push({ quest, count, fir, of: items.length });
      }
    }
  }
  return needs;
}

/** Everything loadQuestData provides; all null when there's no quest data. */
export interface QuestData {
  tasks: SlimTasks | null;
  items: ItemObjectives | null;
  outline: QuestOutline | null;
  names: QuestNames | null;
  status: QuestDataStatus;
}

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

interface CachedTasks {
  fetchedAt: number;
  tasks: SlimTasks;
  items: ItemObjectives;
  outline: QuestOutline;
  names: QuestNames;
}

function readCache(storage: StorageLike): CachedTasks | null {
  try {
    const c = JSON.parse(storage.getItem(STORAGE_KEY) ?? "null") as CachedTasks | null;
    return c && typeof c.fetchedAt === "number" && c.tasks && typeof c.tasks === "object" && c.items && typeof c.items === "object" && c.outline && typeof c.outline === "object" && c.names?.quests && c.names.items
      ? c
      : null;
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
): Promise<QuestData> {
  const now = opts.now ?? Date.now();
  const storage = opts.storage ?? localStorage;
  const fetchFn = opts.fetchFn ?? fetch.bind(globalThis);
  const cached = readCache(storage);
  const age = cached ? now - cached.fetchedAt : Infinity;
  if (cached && age >= 0 && age < MAX_AGE_MS)
    return { tasks: cached.tasks, items: cached.items, outline: cached.outline, names: cached.names, status: { state: "ready", fetchedAt: cached.fetchedAt } };
  try {
    const get = async (feed: string) => {
      const res = await fetchFn(`${FEED_BASE}/${feed}`);
      if (!res.ok) throw new Error(`${feed}: HTTP ${res.status}`);
      return res.json();
    };
    const [feed, en] = await Promise.all([get("tasks"), get("tasks_en")]);
    const tasks = slimTasks(feed);
    const items = slimItemObjectives(feed);
    const outline = questOutline(feed);
    const names = questNames(feed, en, tasks, items);
    try {
      storage.setItem(STORAGE_KEY, JSON.stringify({ fetchedAt: now, tasks, items, outline, names } satisfies CachedTasks));
    } catch (e) {
      console.warn("couldn't cache quest data", e);
    }
    return { tasks, items, outline, names, status: { state: "ready", fetchedAt: now } };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    if (cached)
      return { tasks: cached.tasks, items: cached.items, outline: cached.outline, names: cached.names, status: { state: "stale", fetchedAt: cached.fetchedAt, error } };
    return { tasks: null, items: null, outline: null, names: null, status: { state: "unavailable", fetchedAt: null, error } };
  }
}

// ---- debug view ----

/** One objective of a quest in progress, as the quest data has it. */
export interface QuestDebugObjective {
  id: string;
  type: string;
  done: boolean;
  /** Find-quest-item objectives: the quest item. Item objectives: the items that count. */
  items?: string[];
  count?: number;
  fir?: boolean;
}

/** A quest the backend reports in progress, and what the quest data says about it. */
export interface QuestDebugQuest {
  id: string;
  name: string | null;
  status: number;
  /** The quest data has this quest. */
  inData: boolean;
  /** Completed condition ids as read; null if they couldn't be read. */
  done: string[] | null;
  /** Completed condition ids that aren't objectives of the quest in the quest data (a different game
   *  version's ids?). */
  unknownDone: string[];
  objectives: QuestDebugObjective[];
}

/** One kind of quest item on the map, and whether the filter keeps it. */
export interface QuestDebugItem {
  tpl: string;
  label: string | null;
  obj: string;
  /** How many there are (after duplicates are merged). */
  count: number;
  /** Some quest in the quest data has a find objective for it. */
  known: boolean;
  /** A started quest still needs it. */
  needed: boolean;
  shown: boolean;
  why: string;
}

export interface QuestDebug {
  data: QuestDataStatus & { quests: number; withQuestItems: number; withItemObjectives: number };
  /** The backend's quest list: "unread" until it was read (or an old recording without one). */
  backend: "unread" | "read";
  /** The quest item filter's setting, and what it does now. */
  filter: { on: boolean; effect: string };
  started: number;
  readyToHandIn: number;
  /** Started quests the quest data doesn't have: while there are any, quest items it doesn't know stay. */
  missing: string[];
  quests: QuestDebugQuest[];
  questItems: QuestDebugItem[];
  /** Loose ordinary items on the map that a started quest needs: all, and those the rule highlights. */
  neededItemsOnMap: { all: number; specific: number };
}

const STATUS_NAMES: Record<number, string> = { 2: "started", 3: "ready to hand in" };
export const questStatusName = (status: number): string => STATUS_NAMES[status] ?? `status ${status}`;

/**
 * Everything about the quest data and the local player's quests, for the debug view: what the quest data
 * is, which quests the backend reports and how they match it, and why each quest item on the map shows or
 * not. `loot` is the loot before the quest item filter; `itemName` names ordinary items.
 */
export function questDebugReport(input: {
  data: QuestData;
  quests: readonly QuestState[] | null;
  loot: readonly LootEntry[];
  filterOn: boolean;
  itemName: (tpl: string) => string | undefined;
}): QuestDebug {
  const { data, quests, loot, filterOn, itemName } = input;
  const { tasks, items, outline, names } = data;
  const needed = neededQuestItems(quests, tasks);
  const known = knownQuestItems(tasks);
  const labels = questItemLabels(quests, tasks, names);
  const name = (tpl: string) => itemName(tpl) ?? names?.items[tpl] ?? tpl;

  const debugQuests: QuestDebugQuest[] = (quests ?? []).map((q) => {
    const inData = !!tasks && Object.hasOwn(tasks, q.id);
    const done = new Set(q.done ?? []);
    const finds = new Map((tasks?.[q.id] ?? []).map(([o, tpl]) => [o, tpl]));
    const itemObjs = new Map((items?.[q.id] ?? []).map((o) => [o[0], o]));
    const all = outline?.[q.id] ?? [];
    const objectiveIds = new Set(all.map(([id]) => id));
    const objectives = all.map(([id, type]): QuestDebugObjective => {
      const o: QuestDebugObjective = { id, type, done: done.has(id) };
      const tpl = finds.get(id);
      if (tpl) o.items = [name(tpl)];
      const io = itemObjs.get(id);
      if (io) Object.assign(o, { items: io[1].map(name), count: io[2], fir: io[3] });
      return o;
    });
    return {
      id: q.id,
      name: names?.quests[q.id] ?? null,
      status: q.status,
      inData,
      done: q.done,
      unknownDone: inData && outline ? (q.done ?? []).filter((d) => !objectiveIds.has(d)) : [],
      objectives,
    };
  });
  // Quests the data doesn't have first, then by name.
  debugQuests.sort((a, b) => Number(a.inData) - Number(b.inData) || (a.name ?? a.id).localeCompare(b.name ?? b.id));

  const byTpl = new Map<string, { obj: string; count: number }>();
  for (const l of loot) {
    if (l.kind !== "quest") continue;
    const e = byTpl.get(l.tpl);
    if (e) e.count++;
    else byTpl.set(l.tpl, { obj: l.obj, count: 1 });
  }
  const questItems = [...byTpl].map(([tpl, { obj, count }]): QuestDebugItem => {
    const isKnown = known.has(tpl);
    const isNeeded = !!needed?.items.has(tpl);
    let shown = true;
    let why: string;
    if (!filterOn) why = "filter off: all quest items show";
    else if (!tasks) why = "no quest data: all show";
    else if (!needed) why = "quests not read: all show";
    else if (isNeeded) why = "a started quest needs it";
    else if (!isKnown && !needed.complete) why = "unknown to the quest data, and some started quests are too: kept";
    else {
      shown = false;
      why = isKnown ? "no started quest needs it" : "unknown to the quest data";
    }
    return { tpl, label: labels.get(tpl) ?? null, obj, count, known: isKnown, needed: isNeeded, shown, why };
  });
  questItems.sort((a, b) => Number(b.shown) - Number(a.shown) || (a.label ?? a.obj).localeCompare(b.label ?? b.obj));

  const needs = neededItems(quests, items, names);
  let all = 0, specific = 0;
  for (const l of loot) {
    const n = l.kind === "item" ? needs.get(l.tpl) : undefined;
    if (!n?.length) continue;
    all++;
    if (n.some(isSpecific)) specific++;
  }

  const taskValues = Object.values(tasks ?? {});
  const missing = (quests ?? []).filter((q) => q.status === QUEST_STARTED && !(tasks && Object.hasOwn(tasks, q.id))).map((q) => q.id);
  const effect = !filterOn
    ? "off: all quest items show"
    : !tasks
      ? "no quest data: all quest items show"
      : !needed
        ? "quests not read: all quest items show"
        : needed.complete
          ? "only quest items started quests need show"
          : `${missing.length} started quests unknown to the quest data: quest items it doesn't know show too`;
  return {
    data: {
      ...data.status,
      quests: taskValues.length,
      withQuestItems: taskValues.filter((f) => f.length).length,
      withItemObjectives: Object.keys(items ?? {}).length,
    },
    backend: quests ? "read" : "unread",
    filter: { on: filterOn, effect },
    started: (quests ?? []).filter((q) => q.status === QUEST_STARTED).length,
    readyToHandIn: (quests ?? []).filter((q) => q.status !== QUEST_STARTED).length,
    missing,
    quests: debugQuests,
    questItems,
    neededItemsOnMap: { all, specific },
  };
}
