// The quest debug view's report: the local player's quests and why each quest item shows or not.

import type { LootEntry, QuestKind, QuestObjective, QuestState } from "./protocol";
import { QUEST_KINDS, QUEST_STARTED, isOpen, isSpecific, openObjectives, questItemLabels, questLabel, questNeeds, traderName } from "./quests";

/** One objective of a quest in progress. */
export interface QuestDebugObjective {
  id: string;
  type: QuestObjective["type"];
  text?: string;
  /** Item names. */
  items: string[];
  count: number;
  progress?: number;
  fir: boolean;
  done: boolean;
  /** Still needs items (openObjectives). */
  open: boolean;
}

export interface QuestDebugQuest {
  id: string;
  label: string;
  kind: QuestKind | null;
  trader: string | null;
  hidden: boolean;
  status: number;
  /** The template was read (objectives known). */
  known: boolean;
  /** Completed condition ids as read; null if they couldn't be read. */
  done: string[] | null;
  objectives: QuestDebugObjective[];
}

/** One kind of quest item on the map, and whether the filter keeps it. */
export interface QuestDebugItem {
  tpl: string;
  label: string | null;
  obj: string;
  /** How many there are (after duplicates are merged). */
  count: number;
  needed: boolean;
  shown: boolean;
  why: string;
}

export interface QuestDebug {
  /** The backend's quest list: "unread" until it was read (or an old recording without one). */
  backend: "unread" | "read";
  filter: { on: boolean; effect: string };
  started: number;
  readyToHandIn: number;
  byKind: Record<QuestKind, number>;
  /** Started quests whose template couldn't be read. */
  unknown: string[];
  quests: QuestDebugQuest[];
  questItems: QuestDebugItem[];
  /** Loose ordinary items on the map that a started quest needs: all, and those the rule highlights. */
  neededItemsOnMap: { all: number; specific: number };
}

const STATUS_NAMES: Record<number, string> = { 2: "started", 3: "ready to hand in" };
export const questStatusName = (status: number): string => STATUS_NAMES[status] ?? `status ${status}`;

/**
 * The local player's quests and why each quest item on the map shows or not, for the debug view.
 * `loot` is the loot before the quest item filter; `itemName` names items.
 */
export function questDebugReport(input: {
  quests: readonly QuestState[] | null;
  loot: readonly LootEntry[];
  filterOn: boolean;
  itemName: (tpl: string) => string | undefined;
}): QuestDebug {
  const { quests, loot, filterOn, itemName } = input;
  const needs = questNeeds(quests);
  const labels = questItemLabels(needs);
  const name = (tpl: string) => itemName(tpl) ?? tpl;
  const byKind: Record<QuestKind, number> = { story: 0, side: 0, daily: 0, weekly: 0 };

  const debugQuests = (quests ?? []).map((q): QuestDebugQuest => {
    if (q.status === QUEST_STARTED && q.kind) byKind[q.kind]++;
    const open = new Set(openObjectives(q).map((o) => o.objective.id));
    const done = new Set(q.done ?? []);
    return {
      id: q.id,
      label: questLabel(q),
      kind: q.kind ?? null,
      trader: traderName(q.trader) ?? q.trader ?? null,
      hidden: !!q.hidden,
      status: q.status,
      known: !!q.objectives,
      done: q.done,
      objectives: (q.objectives ?? []).map((o) => ({
        id: o.id,
        type: o.type,
        ...(o.text ? { text: o.text } : {}),
        items: o.items.map(name),
        count: o.count,
        ...(o.progress !== undefined ? { progress: o.progress } : {}),
        fir: !!o.fir,
        done: done.has(o.id),
        open: open.has(o.id),
      })),
    };
  });
  // Unknown quests first, then by kind and label.
  const kindOrder = (k: QuestKind | null) => (k ? QUEST_KINDS.indexOf(k) : -1);
  debugQuests.sort((a, b) => Number(a.known) - Number(b.known) || kindOrder(a.kind) - kindOrder(b.kind) || a.label.localeCompare(b.label));

  const byTpl = new Map<string, { obj: string; count: number }>();
  for (const l of loot) {
    if (l.kind !== "quest") continue;
    const e = byTpl.get(l.tpl);
    if (e) e.count++;
    else byTpl.set(l.tpl, { obj: l.obj, count: 1 });
  }
  const questItems = [...byTpl].map(([tpl, { obj, count }]): QuestDebugItem => {
    const list = needs?.items.get(tpl);
    const needed = !!list?.some(isOpen);
    let shown = true;
    let why: string;
    if (!filterOn) why = "filter off: all quest items show";
    else if (!needs) why = "quests not read: all show";
    else if (needed) why = "a started quest needs it";
    else if (list?.length && !needs.complete) why = "owned already (some started quests' objectives unknown: kept)";
    else if (!needs.complete) why = "some started quests' objectives unknown: kept";
    else {
      shown = false;
      why = list?.length ? "owned already" : "no started quest needs it";
    }
    return { tpl, label: labels.get(tpl) ?? null, obj, count, needed, shown, why };
  });
  questItems.sort((a, b) => Number(b.shown) - Number(a.shown) || Number(b.needed) - Number(a.needed) || (a.label ?? a.obj).localeCompare(b.label ?? b.obj));

  let all = 0, specific = 0;
  for (const l of loot) {
    const n = l.kind === "item" ? needs?.items.get(l.tpl) : undefined;
    if (!n?.some(isOpen)) continue;
    all++;
    if (n.some((x) => isOpen(x) && isSpecific(x))) specific++;
  }

  const unknown = (quests ?? []).filter((q) => q.status === QUEST_STARTED && !q.objectives).map((q) => q.id);
  const effect = !filterOn
    ? "off: all quest items show"
    : !needs
      ? "quests not read: all quest items show"
      : needs.complete
        ? "only quest items started quests need show"
        : `${unknown.length} started quests' objectives unknown: all quest items show`;
  return {
    backend: quests ? "read" : "unread",
    filter: { on: filterOn, effect },
    started: (quests ?? []).filter((q) => q.status === QUEST_STARTED).length,
    readyToHandIn: (quests ?? []).filter((q) => q.status !== QUEST_STARTED).length,
    byKind,
    unknown,
    quests: debugQuests,
    questItems,
    neededItemsOnMap: { all, specific },
  };
}
