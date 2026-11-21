// Which items the local player's quests still need, and what to call those quests.
//
// Everything comes from the backend's `quests` message: per quest in progress its kind (story, side,
// daily, weekly), English name and item objectives (find, hand over, plant), read from the quest's
// template in game memory, with the completed conditions and hand-over progress. No quest data is
// downloaded. Older recordings have no objectives: then nothing is known, and every quest item shows.

import type { LootEntry, QuestKind, QuestObjective, QuestState } from "./protocol";

/** EQuestStatus: started (and not yet ready to hand in). */
export const QUEST_STARTED = 2;

export const QUEST_KINDS: readonly QuestKind[] = ["story", "side", "daily", "weekly"];

/** Roubles, dollars, euros: handed over from the stash, not looked for in a raid. */
const CURRENCIES = new Set(["5449016a4bdc2d6f028b456f", "5696686a4bdc2da3298b456a", "569668774bdc2da2298b4568"]);
/** An objective any of more items than this counts for is too broad to single its items out
 *  ("any medical item"): they're labelled, but not highlighted (QuestNeed.specific). */
export const SPECIFIC_ITEMS = 5;

/** Trader names (their ids don't change); the story's quests belong to a pseudo-trader. */
const TRADERS: Record<string, string> = {
  "54cb50c76803fa8b248b4571": "Prapor",
  "54cb57776803fa99248b456e": "Therapist",
  "579dc571d53a0658a154fbec": "Fence",
  "58330581ace78e27b8b10cee": "Skier",
  "5935c25fb3acc3127c3d8cd9": "Peacekeeper",
  "5a7c2eca46aef81a7ca2145d": "Mechanic",
  "5ac3b934156ae10c4430e83c": "Ragman",
  "5c0647fdd443bc2504c2d371": "Jaeger",
  "638f541a29ffd1183d187f57": "Lightkeeper",
  "656f0f98d80a697f855d34b1": "BTR Driver",
  "6617beeaa9cfa777ca915b7c": "Ref",
  "67f7af56c117b6140af2a607": "Story",
};
export const traderName = (id: string | undefined): string | undefined => (id ? TRADERS[id] : undefined);

/** What to call a quest: its name; else "Prapor daily", "Story", "Skier quest". */
export function questLabel(q: QuestState): string {
  if (q.name) return q.name;
  const trader = traderName(q.trader);
  if (q.kind === "story") return "Story";
  if (q.kind === "daily" || q.kind === "weekly") return trader ? `${trader} ${q.kind}` : q.kind === "daily" ? "Daily" : "Weekly";
  return trader ? `${trader} quest` : "Quest";
}

/** What to call the quest an objective is for: for story quests (often nameless), the objective's text. */
export const objectiveLabel = (q: QuestState, o: QuestObjective): string => (q.kind === "story" && o.text ? o.text : questLabel(q));

/** A started quest's objective that still needs an item. */
export interface QuestNeed {
  /** What it's for (objectiveLabel). */
  quest: string;
  kind: QuestKind;
  count: number;
  /** How many are handed over already, if the game counts it. */
  progress?: number;
  fir: boolean;
  /** How many different items count for the objective (any of them). */
  of: number;
}

/** At most SPECIFIC_ITEMS items count for the objective: worth highlighting. */
export const isSpecific = (n: QuestNeed): boolean => n.of <= SPECIFIC_ITEMS;

/** "Shooter Born in Heaven (×3, FIR)", "Charity (2/5, FIR)", "First in Line (×3, any of 60)". */
export function formatQuestNeed(n: QuestNeed): string {
  const amount = n.progress ? `${n.progress}/${n.count}` : n.count > 1 ? `×${n.count}` : "";
  const extra = [amount, n.fir ? "FIR" : "", n.of > 1 ? `any of ${n.of}` : ""].filter(Boolean).join(", ");
  return extra ? `${n.quest} (${extra})` : n.quest;
}

const itemsKey = (items: readonly string[]) => [...items].sort().join(",");

/**
 * A started quest's objectives that still need items, with the hand-over progress that counts for
 * them. A hand-over or plant objective for the same items as a find objective of its quest is left out:
 * the find objective says whether they still have to be found (once found, they're carried, not loot),
 * and takes the hand-over's progress.
 */
export function openObjectives(q: QuestState): { objective: QuestObjective; items: string[]; progress?: number }[] {
  const objectives = q.objectives ?? [];
  const finds = new Set(objectives.filter((o) => o.type === "find").map((o) => itemsKey(o.items)));
  const handed = new Map<string, number>();
  for (const o of objectives) if (o.type === "handover" && o.progress !== undefined) handed.set(itemsKey(o.items), o.progress);
  const out: ReturnType<typeof openObjectives> = [];
  for (const o of objectives) {
    const key = itemsKey(o.items);
    if (o.type !== "find" && finds.has(key)) continue;
    if (q.done?.includes(o.id)) continue;
    const progress = o.type === "find" ? handed.get(key) : o.progress;
    if ((progress ?? 0) >= o.count) continue;
    const items = o.items.filter((t) => t && !CURRENCIES.has(t));
    if (items.length) out.push({ objective: o, items, ...(progress !== undefined ? { progress } : {}) });
  }
  return out;
}

/** What the local player's quests still need. */
export interface QuestNeeds {
  /** Template id → the open objectives that need it (one entry per objective). */
  items: Map<string, QuestNeed[]>;
  /** Every started quest's objectives are known, so nothing else is needed. False when a template
   *  couldn't be read (or an older recording): then quest items can't be judged. */
  complete: boolean;
  /** Started quests. */
  started: number;
}

/** Null when it can't be told (the quests weren't read): then every quest item shows. */
export function questNeeds(quests: readonly QuestState[] | null): QuestNeeds | null {
  if (!quests) return null;
  const needs: QuestNeeds = { items: new Map(), complete: true, started: 0 };
  for (const q of quests) {
    if (q.status !== QUEST_STARTED) continue;
    needs.started++;
    if (!q.objectives) {
      needs.complete = false;
      continue;
    }
    const kind = q.kind ?? "side";
    for (const { objective: o, items, progress } of openObjectives(q)) {
      const need: QuestNeed = { quest: objectiveLabel(q, o), kind, count: o.count, fir: !!o.fir, of: items.length, ...(progress ? { progress } : {}) };
      for (const tpl of items) {
        let list = needs.items.get(tpl);
        if (!list) needs.items.set(tpl, (list = []));
        list.push(need);
      }
    }
  }
  return needs;
}

/**
 * Drops the quest items nobody needs; everything else stays. Unless every started quest's objectives
 * are known, nothing is dropped. Returns the same array if nothing goes.
 */
export function withoutUnneededQuestItems(loot: LootEntry[], needs: QuestNeeds | null): LootEntry[] {
  if (!needs?.complete) return loot;
  const keep = (l: LootEntry) => l.kind !== "quest" || needs.items.has(l.tpl);
  return loot.every(keep) ? loot : loot.filter(keep);
}

/** Quest item template id → its label: what the quests that need it are called (" / " between). */
export function questItemLabels(needs: QuestNeeds | null): Map<string, string> {
  const labels = new Map<string, string>();
  for (const [tpl, list] of needs?.items ?? []) labels.set(tpl, [...new Set(list.map((n) => n.quest))].join(" / "));
  return labels;
}

/** The kinds of quest that need an item; for ordinary items only objectives specific enough to
 *  highlight count (the "Needed for quests" rule). */
export function neededKinds(needs: readonly QuestNeed[] | undefined, questItem: boolean): QuestKind[] {
  const kinds = new Set<QuestKind>();
  for (const n of needs ?? []) if (questItem || isSpecific(n)) kinds.add(n.kind);
  return QUEST_KINDS.filter((k) => kinds.has(k));
}
