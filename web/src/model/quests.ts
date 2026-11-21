// Which items the local player's quests still need, and what to call those quests.
//
// Everything comes from the backend's `quests` message: per quest in progress its kind (story, side,
// daily, weekly), English name and item objectives (find, hand over, plant), read from the quest's
// template in game memory, with the completed conditions and hand-over progress. No quest data is
// downloaded. Older recordings have no objectives: then nothing is known, and every quest item shows.

import type { LootEntry, QuestKind, QuestObjective, QuestState } from "./protocol";
import type { Owned } from "./owned";
import type { ImportedQuest } from "./taskFeed";

/** EQuestStatus: started (and not yet ready to hand in). */
export const QUEST_STARTED = 2;
/** EQuestStatus: ready to hand in (needs nothing more). */
export const QUEST_READY = 3;

export const QUEST_KINDS: readonly QuestKind[] = ["story", "side", "daily", "weekly"];

/** What a need is for: a kind of started quest, or a quest imported from tarkov.dev (not started yet). */
export type NeedKind = QuestKind | "imported";
export const NEED_KINDS: readonly NeedKind[] = [...QUEST_KINDS, "imported"];

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
  kind: NeedKind;
  count: number;
  /** How many are handed over already, if the game counts it. */
  progress?: number;
  fir: boolean;
  /** How many different items count for the objective (any of them). */
  of: number;
  /** Owned units set aside for it (allocateOwned): found-in-raid ones only, for FIR objectives. */
  have?: number;
  /** What's owned covers what's left: the items aren't needed any more (not `is:needed`). */
  covered?: boolean;
}

/** Still to be found: not covered by what's owned. */
export const isOpen = (n: QuestNeed): boolean => !n.covered;

/** At most SPECIFIC_ITEMS items count for the objective: worth highlighting. */
export const isSpecific = (n: QuestNeed): boolean => n.of <= SPECIFIC_ITEMS;

/** "Shooter Born in Heaven (×3, FIR)", "Charity (2/5, FIR, have 1)", "First in Line (×3, any of 60, have all)". */
export function formatQuestNeed(n: QuestNeed): string {
  const amount = n.progress ? `${n.progress}/${n.count}` : n.count > 1 ? `×${n.count}` : "";
  const have = n.covered ? "have all" : n.have ? `have ${n.have}` : "";
  const extra = [amount, n.fir ? "FIR" : "", n.of > 1 ? `any of ${n.of}` : "", have].filter(Boolean).join(", ");
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
  /** Template id → the open objectives that need it (one entry per objective), also those covered by
   *  what's owned (QuestNeed.covered; isOpen). */
  items: Map<string, QuestNeed[]>;
  /** `${quest id}/${objective id}` → its need (the Quests view). */
  objectives: Map<string, QuestNeed>;
  /** Every started quest's objectives are known, so nothing else is needed. False when a template
   *  couldn't be read (or an older recording): then quest items can't be judged. */
  complete: boolean;
  /** Started quests. */
  started: number;
}

/** Which quests count (the Quests view): all started ones but those ignored (one by one, or their
 *  whole kind), plus the imported ones. */
export interface Counting {
  /** Quest ids that don't count. */
  ignored?: ReadonlySet<string>;
  /** Kinds that don't count at all. */
  ignoredKinds?: ReadonlySet<NeedKind>;
  /** Quests imported from tarkov.dev, not started yet: everything they need counts (unless ignored). */
  imported?: readonly ImportedQuest[];
}

const NO_IDS: ReadonlySet<string> = new Set();

/** Ignored quests (one by one, or by kind) need nothing. */
export const counts = (id: string, kind: NeedKind, c: Counting): boolean => !(c.ignored ?? NO_IDS).has(id) && !c.ignoredKinds?.has(kind);

/**
 * Null when it can't be told (the quests weren't read): then every quest item shows, also those of
 * imported quests. Quests that don't count (`counting`) need nothing, as if not started; an imported
 * quest that's in the game's list (started, or done in this raid) counts as that instead.
 */
export function questNeeds(quests: readonly QuestState[] | null, counting: Counting = {}, owned: Owned | null = null): QuestNeeds | null {
  if (!quests) return null;
  const needs: QuestNeeds = { items: new Map(), objectives: new Map(), complete: true, started: 0 };
  const claims: Claim[] = [];
  const add = (questId: string, objectiveId: string, items: string[], need: QuestNeed) => {
    needs.objectives.set(`${questId}/${objectiveId}`, need);
    claims.push({ need, items });
    for (const tpl of items) {
      let list = needs.items.get(tpl);
      if (!list) needs.items.set(tpl, (list = []));
      list.push(need);
    }
  };
  // Started quests first: what's owned goes to them before imported ones.
  for (const q of quests) {
    if (q.status !== QUEST_STARTED || !counts(q.id, q.kind ?? "side", counting)) continue;
    needs.started++;
    if (!q.objectives) {
      needs.complete = false;
      continue;
    }
    const kind = q.kind ?? "side";
    for (const { objective: o, items, progress } of openObjectives(q))
      add(q.id, o.id, items, { quest: objectiveLabel(q, o), kind, count: o.count, fir: !!o.fir, of: items.length, ...(progress ? { progress } : {}) });
  }
  const live = new Set(quests.map((q) => q.id));
  for (const q of counting.imported ?? []) {
    if (live.has(q.id) || !counts(q.id, "imported", counting)) continue;
    for (const { objective: o, items } of openObjectives({ id: q.id, status: QUEST_STARTED, done: [], objectives: q.objectives }))
      add(q.id, o.id, items, { quest: q.name, kind: "imported", count: o.count, fir: !!o.fir, of: items.length });
  }
  if (owned) allocateOwned(claims, owned);
  return needs;
}

/** An objective's claim on owned items: any of `items` counts. */
export interface Claim {
  need: QuestNeed;
  items: readonly string[];
}

/**
 * Sets each need's `have` and `covered` from what's owned, every unit counted once. Found-in-raid
 * objectives can only use FIR units, so they go first and take those; the others take non-FIR units
 * first, then FIR ones left over. Within that, in order (started quests before imported ones), and
 * objectives few items count for (isSpecific) before broad ones ("any of 60"), which would otherwise
 * use up items a specific one needs.
 */
export function allocateOwned(claims: readonly Claim[], owned: Owned): void {
  const left = new Map<string, { plain: number; fir: number }>();
  const pool = (tpl: string) => {
    let p = left.get(tpl);
    if (!p) {
      const o = owned.get(tpl);
      left.set(tpl, (p = { plain: o ? o.count - o.fir : 0, fir: o?.fir ?? 0 }));
    }
    return p;
  };
  const rank = (c: Claim) => (c.need.fir ? 0 : 2) + (isSpecific(c.need) ? 0 : 1);
  const ordered = claims.map((c, i) => ({ c, i })).sort((a, b) => rank(a.c) - rank(b.c) || a.i - b.i);
  for (const { c } of ordered) {
    let wanted = c.need.count - (c.need.progress ?? 0);
    let have = 0;
    for (const tpl of c.items) {
      if (wanted <= 0) break;
      const p = pool(tpl);
      if (!c.need.fir) {
        const n = Math.min(wanted, p.plain);
        p.plain -= n;
        wanted -= n;
        have += n;
      }
      const n = Math.min(wanted, p.fir);
      p.fir -= n;
      wanted -= n;
      have += n;
    }
    if (have > 0) c.need.have = have;
    if (wanted <= 0) c.need.covered = true;
  }
}

/**
 * Drops the quest items nobody needs (also those covered by what's owned); everything else stays. Unless every started quest's objectives
 * are known, nothing is dropped. Returns the same array if nothing goes.
 */
export function withoutUnneededQuestItems(loot: LootEntry[], needs: QuestNeeds | null): LootEntry[] {
  if (!needs?.complete) return loot;
  const keep = (l: LootEntry) => l.kind !== "quest" || !!needs.items.get(l.tpl)?.some(isOpen);
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
export function neededKinds(needs: readonly QuestNeed[] | undefined, questItem: boolean): NeedKind[] {
  const kinds = new Set<NeedKind>();
  for (const n of needs ?? []) if (isOpen(n) && (questItem || isSpecific(n))) kinds.add(n.kind);
  return NEED_KINDS.filter((k) => kinds.has(k));
}

/**
 * The carried items behind carriedNeeds: each template a quest needs (in the order first carried),
 * how many of it are carried, and the needs it's for.
 */
export function carriedNeededItems(
  tpls: readonly string[],
  needs: ReadonlyMap<string, readonly QuestNeed[]>,
): { tpl: string; count: number; needs: QuestNeed[] }[] {
  if (!needs.size) return [];
  const out = new Map<string, { tpl: string; count: number; needs: QuestNeed[] }>();
  for (const tpl of tpls) {
    const hit = out.get(tpl);
    if (hit) {
      hit.count++;
      continue;
    }
    const list = (needs.get(tpl) ?? []).filter((n) => isOpen(n) && isSpecific(n));
    if (list.length) out.set(tpl, { tpl, count: 1, needs: list });
  }
  return [...out.values()];
}

/**
 * What a player or corpse carries that a started quest needs: the needs specific enough to highlight
 * (isSpecific), one per objective. Gear taken off a body is found in raid, so FIR objectives count.
 */
export function carriedNeeds(tpls: readonly string[], needs: ReadonlyMap<string, readonly QuestNeed[]>): QuestNeed[] {
  if (!needs.size) return [];
  const out = new Set<QuestNeed>();
  for (const tpl of tpls) for (const n of needs.get(tpl) ?? []) if (isOpen(n) && isSpecific(n)) out.add(n);
  return [...out];
}
