// Quests as the Watch view and its quest browser see them: started quests (and imported ones, not
// started yet) that still need items, each with its open objectives; and the watch entry that tracks
// one (watching what it still needs, `quest:"<name>"`, or its id for quests without a name).

import type { ItemCatalog } from "../model/items";
import type { QuestState } from "../model/protocol";
import type { ImportedQuest } from "../model/taskFeed";
import { type NeedKind, type QuestNeeds, QUEST_STARTED, openObjectives, questLabel, traderName } from "../model/quests";

export interface QuestItemNeed {
  /** "Salewa first aid kit", or "any of 6 items" */
  what: string;
  /** Item names, for the line ("Salewa"), short. */
  short: string;
  count: number;
  /** Handed over (or owned and set aside) so far. */
  have: number;
  fir: boolean;
}

export interface QuestEntry {
  id: string;
  name: string;
  /** The picker's tab: a trader's name, "Story", "Repeatable", "Imported". */
  tab: string;
  kind: NeedKind;
  open: QuestItemNeed[];
  /** What a watch entry tracking it matches. */
  query: string;
}

const listed = 3;

/** Started quests (and imported ones not started) with items still to find, by name. */
export function questEntries(quests: readonly QuestState[] | null, imported: readonly ImportedQuest[], needs: QuestNeeds | null, catalog: ItemCatalog): QuestEntry[] {
  const out: QuestEntry[] = [];
  const name = (tpl: string, names?: Record<string, string>) => names?.[tpl] ?? catalog.lookup(tpl)?.name ?? "quest item";
  const short = (tpl: string, names?: Record<string, string>) => names?.[tpl] ?? catalog.lookup(tpl)?.shortName ?? "quest item";
  const needOf = (q: { id: string; objectives?: unknown }, oid: string) => needs?.objectives.get(`${q.id}/${oid}`);
  const live = new Set<string>();
  for (const q of quests ?? []) {
    live.add(q.id);
    if (q.status !== QUEST_STARTED || !q.objectives) continue;
    const open = openObjectives(q).flatMap(({ objective: o, items, progress }): QuestItemNeed[] => {
      const need = needOf(q, o.id);
      const have = Math.max(progress ?? 0, (progress ?? 0) + (need?.have ?? 0));
      if (need?.covered) return [];
      return [{ what: items.length > listed ? `any of ${items.length} items` : items.map((t) => name(t)).join(" / "), short: items.length > 2 ? `${items.length} items` : items.map((t) => short(t)).join("/"), count: o.count, have, fir: !!o.fir }];
    });
    if (!open.length) continue;
    const kind = q.kind ?? "side";
    const tab = kind === "story" ? "Story" : kind === "daily" || kind === "weekly" ? "Repeatable" : (traderName(q.trader) ?? "Other");
    const label = questLabel(q);
    out.push({ id: q.id, name: label, tab, kind, open, query: q.name ? `quest:${quote(q.name)}` : `quest:${q.id}` });
  }
  for (const q of imported) {
    if (live.has(q.id)) continue;
    const open = openObjectives({ id: q.id, status: QUEST_STARTED, done: [], objectives: q.objectives }).map(({ objective: o, items }): QuestItemNeed => ({
      what: items.length > listed ? `any of ${items.length} items` : items.map((t) => name(t, q.itemNames)).join(" / "),
      short: items.length > 2 ? `${items.length} items` : items.map((t) => short(t, q.itemNames)).join("/"),
      count: o.count,
      have: needOf(q, o.id)?.have ?? 0,
      fir: !!o.fir,
    }));
    if (open.length) out.push({ id: q.id, name: q.name, tab: "Imported", kind: "imported", open, query: `quest:${quote(q.name)}` });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

const quote = (s: string) => (/[\s,"]/.test(s) ? `"${s.replaceAll('"', "")}"` : s);

/** What a quest still needs, short: "Salewa 1/3, Bolts 0/6 · FIR", or "5 items to find · FIR". */
export function needsLine(q: QuestEntry): string {
  const fir = q.open.some((o) => o.fir) ? " · FIR" : "";
  if (q.open.length > 3) return `${q.open.length} items to find${fir}`;
  return q.open.map((o) => `${o.short} ${o.have}/${o.count}`).join(", ") + fir;
}

/** Items still to find, over all its objectives. */
export const itemsLeft = (q: QuestEntry): number => q.open.reduce((n, o) => n + Math.max(0, o.count - o.have), 0);
