// Timeline events as the log and the details panel show them: what to call things, what changed.

import { type ItemCatalog, containerName, exfilStatus } from "./items";
import type { Selection } from "./pick";
import type { ItemNode, LootEntry, WorldPos } from "./protocol";
import { type PlayerIdentity, playerType } from "./roles";
import type { EventKind, Timeline, TimelineEvent } from "./timeline";

/** Filter groups of the log, in display order. */
export const EVENT_GROUPS = {
  spawns: { label: "Spawns", kinds: ["playerSeen"] },
  deaths: { label: "Deaths", kinds: ["died"] },
  left: { label: "Left", kinds: ["left"] },
  taken: { label: "Loot gone", kinds: ["lootRemoved"] },
  changed: { label: "Contents", kinds: ["lootChanged"] },
  appeared: { label: "Loot new", kinds: ["lootAdded"] },
  exfils: { label: "Exfils", kinds: ["exfilStatus"] },
} satisfies Record<string, { label: string; kinds: EventKind[] }>;

export type EventGroup = keyof typeof EVENT_GROUPS;

/** New loot shows up in bulk while the raid's loot is still being read: off by default. */
export const DEFAULT_EVENT_GROUPS: Record<EventGroup, boolean> = {
  spawns: true, deaths: true, left: true, taken: true, changed: true, appeared: false, exfils: true,
};

export function eventGroup(kind: EventKind): EventGroup {
  for (const [g, def] of Object.entries(EVENT_GROUPS)) if ((def.kinds as EventKind[]).includes(kind)) return g as EventGroup;
  return "spawns";
}

export function playerName(p: PlayerIdentity | undefined, id: number): string {
  if (!p) return `#${id}`;
  if (p.local) return "You";
  const t = playerType(p);
  return t.label === "?" ? `#${id}` : `${t.label} #${id}`;
}

export function lootName(l: LootEntry, catalog: ItemCatalog): string {
  switch (l.kind) {
    case "container": return containerName(l.tpl) ?? "container";
    case "airdrop": return "airdrop";
    case "corpse": return "corpse";
    default: return catalog.lookup(l.tpl)?.shortName ?? (l.kind === "quest" ? "quest item" : l.tpl || "item");
  }
}

/** Item names that left and arrived between two item trees (counted by template, anywhere inside). */
export function contentsDelta(before: ItemNode[] | undefined, after: ItemNode[] | undefined, catalog: ItemCatalog): { removed: string[]; added: string[] } {
  const count = (nodes: ItemNode[] | undefined, into = new Map<string, number>()) => {
    for (const n of nodes ?? []) {
      into.set(n.tpl, (into.get(n.tpl) ?? 0) + 1);
      count(n.items, into);
    }
    return into;
  };
  const a = count(before), b = count(after);
  const name = (tpl: string, n: number) => `${catalog.lookup(tpl)?.shortName ?? tpl}${n > 1 ? ` ×${n}` : ""}`;
  const removed: string[] = [], added: string[] = [];
  for (const [tpl, n] of a) if (n > (b.get(tpl) ?? 0)) removed.push(name(tpl, n - (b.get(tpl) ?? 0)));
  for (const [tpl, n] of b) if (n > (a.get(tpl) ?? 0)) added.push(name(tpl, n - (a.get(tpl) ?? 0)));
  return { removed, added };
}

function listNames(names: string[], max = 3): string {
  return names.length > max ? `${names.slice(0, max).join(", ")} +${names.length - max} more` : names.join(", ");
}

export type EventTone = "spawn" | "death" | "left" | "loot" | "exfil";

export interface EventView {
  text: string;
  tone: EventTone;
  /** What the event is about. */
  sel: Selection;
  /** Where it happened (null: unknown). */
  pos: WorldPos | null;
  /** The moment to show for it (just before a removal, so the thing is still there). */
  showAt: number;
}

export function describeEvent(e: TimelineEvent, timeline: Timeline, catalog: ItemCatalog): EventView {
  const player = (id: number) => playerName(timeline.tracks.get(id)?.meta, id);
  switch (e.kind) {
    case "playerSeen":
      return { text: `${player(e.player)} appeared`, tone: "spawn", sel: { kind: "player", id: e.player },
        pos: timeline.tracks.get(e.player)?.poseAt(e.t + 1000)?.pos ?? null, showAt: e.t };
    case "died":
      return { text: `${player(e.player)} died`, tone: "death", sel: { kind: "player", id: e.player }, pos: e.pos, showAt: e.t };
    case "left":
      return { text: `${player(e.player)} left the raid`, tone: "left", sel: { kind: "player", id: e.player }, pos: e.pos, showAt: e.t };
    case "lootAdded":
      return { text: `${lootName(e.loot, catalog)} appeared`, tone: "loot", sel: { kind: "loot", id: e.loot.id }, pos: e.loot.pos, showAt: e.t };
    case "lootRemoved":
      return { text: `${lootName(e.loot, catalog)} gone`, tone: "loot", sel: { kind: "loot", id: e.loot.id }, pos: e.loot.pos, showAt: e.t - 1 };
    case "lootChanged": {
      const { removed, added } = contentsDelta(e.before.contents, e.loot.contents, catalog);
      const parts = [removed.length && `−${listNames(removed)}`, added.length && `+${listNames(added)}`].filter(Boolean);
      const what = parts.length ? parts.join("; ") : "contents changed";
      return { text: `${lootName(e.loot, catalog)}: ${what}`, tone: "loot", sel: { kind: "loot", id: e.loot.id }, pos: e.loot.pos, showAt: e.t };
    }
    case "exfilStatus": {
      const exfil = timeline.stateAt(e.t).exfils.find((x) => x.id === e.exfil);
      return { text: `${exfil?.name ?? `exfil ${e.exfil}`}: ${exfilStatus(e.from).label} → ${exfilStatus(e.to).label}`, tone: "exfil",
        sel: { kind: "exfil", id: e.exfil }, pos: exfil?.pos ?? null, showAt: e.t };
    }
  }
}

/** Whether the event is about the selected thing. */
export function eventConcerns(e: TimelineEvent, sel: Selection): boolean {
  switch (e.kind) {
    case "playerSeen":
    case "died":
    case "left":
      return sel.kind === "player" && sel.id === e.player;
    case "lootAdded":
    case "lootRemoved":
    case "lootChanged":
      return sel.kind === "loot" && sel.id === e.loot.id;
    case "exfilStatus":
      return sel.kind === "exfil" && sel.id === e.exfil;
  }
}
