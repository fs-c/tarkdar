// Rows for the list view: one flat, sortable record per thing the radar knows about, grouped into
// tabs. Pure functions, so they can be tested without React.

import type { RadarState } from "../connection";
import { type ItemCatalog, containerName, exfilStatus, totalValue } from "../items";
import { type Selection, midpoint, selectionKey } from "../pick";
import type { Exfil, ExplosivesData, ItemNode, LootEntry, Player, PlayerEquipment, WorldPos } from "../protocol";
import { type PlayerType, SPECIAL_TYPES, bossGroups, identityText, playerType } from "../roles";

export type TabId = "players" | "items" | "containers" | "exfils" | "explosives";

export interface RowBase {
  /** Stable id: selection kind + id. */
  key: string;
  sel: Selection;
  pos: WorldPos | null;
  /** Horizontal distance from the local player (m); undefined without a local position. */
  dist?: number;
  /** Height above the local player (m). */
  dh?: number;
  /** Lowercase text the filter matches against. */
  search: string;
  /** Shown de-emphasized (plain AI scavs). */
  dim?: boolean;
}

export interface PlayerRow extends RowBase {
  name: string;
  local: boolean;
  ai: boolean;
  type: PlayerType;
  /** Display name for the type: "Killa", "Reshala guard", "USEC bot", ... */
  typeLabel: string;
  /** Tooltip: which rule decided the type, and the raw inputs (side, role, voice, ...). */
  typeDetail: string;
  state: "alive" | "dead" | "left";
  /** Equipment value; undefined when not read (yet) or unpriced. */
  value?: number;
}

export interface ItemRow extends RowBase {
  name: string;
  shortName: string;
  kind: "item" | "quest";
  price?: number;
  basePrice: boolean;
}

export interface ContainerRow extends RowBase {
  name: string;
  kind: "container" | "airdrop" | "corpse";
  /** Number of items, nested ones included. */
  count: number;
  value?: number;
}

export interface ExfilRow extends RowBase {
  name: string;
  kind: "regular" | "secret";
  status: string;
  tone: "open" | "closed" | "pending" | "neutral";
}

export interface ExplosiveRow extends RowBase {
  kind: "grenade" | "tripwire";
  /** Tripwires: wire length (m). */
  length?: number;
}

export interface TabRows {
  players: PlayerRow[];
  items: ItemRow[];
  containers: ContainerRow[];
  exfils: ExfilRow[];
  explosives: ExplosiveRow[];
}

const isContainerKind = (k: LootEntry["kind"]): k is ContainerRow["kind"] =>
  k === "container" || k === "airdrop" || k === "corpse";

/** The tab a selection's row lives in (undefined if the thing is gone). */
export function tabOf(sel: Selection, state: RadarState): TabId | undefined {
  switch (sel.kind) {
    case "player": return "players";
    case "exfil": return "exfils";
    case "grenade":
    case "tripwire": return "explosives";
    case "loot": {
      const l = state.loot.find((x) => x.id === sel.id);
      return l ? (isContainerKind(l.kind) ? "containers" : "items") : undefined;
    }
  }
}

export { selectionKey };

const text = (...parts: (string | undefined | false)[]) => parts.filter(Boolean).join(" ").toLowerCase();

function base(sel: Selection, pos: WorldPos | null, search: string): RowBase {
  return { key: selectionKey(sel), sel, pos, search };
}

/** Rows without distances, for all tabs. The per-category builders below let callers memoize each
 *  on its own input (loot changes rarely, players many times a second). */
export function buildRows(state: Pick<RadarState, "players" | "loot" | "exfils" | "explosives" | "equipment">, catalog: ItemCatalog): TabRows {
  return {
    players: playerRows(state.players, state.equipment, catalog),
    ...lootRows(state.loot, catalog),
    exfils: exfilRows(state.exfils),
    explosives: explosiveRows(state.explosives),
  };
}

export function playerRows(players: Player[], equipment: Map<number, PlayerEquipment>, catalog: ItemCatalog): PlayerRow[] {
  const groups = bossGroups(players);
  return players.map((p): PlayerRow => {
    const name = p.local ? "You" : `#${p.id}`;
    const t = playerType(p, groups);
    const st = p.dead ? "dead" : p.absent ? "left" : "alive";
    const slots = equipment.get(p.id)?.slots;
    const value = slots?.length ? totalValue(slots, catalog) || undefined : undefined;
    const scav = t.type === "ai-scav";
    const raw = identityText(p);
    return {
      ...base({ kind: "player", id: p.id }, p.pos, text(name, `#${p.id}`, t.type, t.label, p.ai ? "ai bot" : "human", raw, st)),
      name, local: p.local, ai: p.ai, type: t.type, typeLabel: t.label, typeDetail: `${t.type}: ${t.reason}\n${raw}`,
      state: st, value, dim: scav,
    };
  });
}

export function lootRows(loot: LootEntry[], catalog: ItemCatalog): Pick<TabRows, "items" | "containers"> {
  const items: ItemRow[] = [];
  const containers: ContainerRow[] = [];
  for (const l of loot) {
    const sel: Selection = { kind: "loot", id: l.id };
    if (isContainerKind(l.kind)) {
      const name = l.kind === "container" ? (containerName(l.tpl) ?? "container") : l.kind;
      const contents = l.contents ?? [];
      const summary = summarize(contents, catalog);
      containers.push({
        ...base(sel, l.pos, text(name, l.kind, l.tpl, ...summary.names)),
        name, kind: l.kind, count: summary.count, value: summary.value || undefined,
      });
    } else {
      const info = catalog.lookup(l.tpl);
      const kind = l.kind === "quest" ? "quest" : "item";
      const name = info?.name ?? (kind === "quest" ? "quest item" : l.tpl || "item");
      items.push({
        ...base(sel, l.pos, text(name, info?.shortName, l.tpl, kind)),
        name, shortName: info?.shortName ?? name, kind, price: info?.price, basePrice: info?.priceSource === "base",
      });
    }
  }
  return { items, containers };
}

export function exfilRows(exfils: Exfil[]): ExfilRow[] {
  return exfils.map((e): ExfilRow => {
    const s = exfilStatus(e.status);
    return { ...base({ kind: "exfil", id: e.id }, e.pos, text(e.name, e.kind, s.label)), name: e.name, kind: e.kind, status: s.label, tone: s.tone };
  });
}

export function explosiveRows(explosives: ExplosivesData): ExplosiveRow[] {
  return [
    ...explosives.grenades.map((g): ExplosiveRow => ({ ...base({ kind: "grenade", id: g.id }, g.pos, "grenade"), kind: "grenade" })),
    ...explosives.tripwires.map((w): ExplosiveRow => ({
      ...base({ kind: "tripwire", id: w.id }, midpoint(w.from, w.to), "tripwire"),
      kind: "tripwire",
      length: Math.hypot(w.to[0] - w.from[0], w.to[1] - w.from[1], w.to[2] - w.from[2]),
    })),
  ];
}

function summarize(nodes: ItemNode[], catalog: ItemCatalog) {
  const names: string[] = [];
  let count = 0;
  const walk = (ns: ItemNode[]) => {
    for (const n of ns) {
      count++;
      const info = catalog.lookup(n.tpl);
      if (info) names.push(info.name, info.shortName);
      if (n.items?.length) walk(n.items);
    }
  };
  walk(nodes);
  return { names, count, value: totalValue(nodes, catalog) };
}

/** Adds distance and height difference to the local player (a new array; rows are shared). */
export function withDistances<R extends RowBase>(rows: R[], local: WorldPos | null): R[] {
  if (!local) return rows;
  return rows.map((r) =>
    r.pos ? { ...r, dist: Math.hypot(r.pos[0] - local[0], r.pos[2] - local[2]), dh: r.pos[1] - local[1] } : r,
  );
}

export interface ListFilters {
  /** Free text; every whitespace-separated term must match. */
  text: string;
  aliveOnly: boolean;
  humansOnly: boolean;
  /** Players: bosses, guards, raiders, rogues, cultists only. */
  specialOnly: boolean;
  /** Items: unit price; containers: total value (roubles). */
  minValue: number;
  hideEmpty: boolean;
}

export const DEFAULT_FILTERS: ListFilters = { text: "", aliveOnly: false, humansOnly: false, specialOnly: false, minValue: 0, hideEmpty: false };

export const isFiltered = (f: ListFilters): boolean =>
  f.text.trim() !== "" || f.aliveOnly || f.humansOnly || f.specialOnly || f.minValue > 0 || f.hideEmpty;

/** Keys of all rows, for showing only these on the map. */
export function rowKeys(rows: TabRows): Set<string> {
  const keys = new Set<string>();
  for (const list of Object.values(rows) as RowBase[][]) for (const r of list) keys.add(r.key);
  return keys;
}

export function matchesText(row: RowBase, query: string): boolean {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  return terms.every((t) => row.search.includes(t));
}

export function filterRows<T extends TabId>(tab: T, rows: TabRows[T], f: ListFilters): TabRows[T] {
  const keep = (r: RowBase): boolean => {
    if (!matchesText(r, f.text)) return false;
    switch (tab) {
      case "players": {
        const p = r as PlayerRow;
        const special = SPECIAL_TYPES.has(p.type);
        // humans + special: either kind (the two together mean "the ones that matter").
        const kind = !f.humansOnly && !f.specialOnly ? true : (f.humansOnly && !p.ai) || (f.specialOnly && special);
        return (!f.aliveOnly || p.state === "alive") && kind;
      }
      case "items":
        return (r as ItemRow).price !== undefined ? (r as ItemRow).price! >= f.minValue : f.minValue === 0;
      case "containers": {
        const c = r as ContainerRow;
        return (!f.hideEmpty || c.count > 0) && (c.value ?? 0) >= f.minValue;
      }
      default:
        return true;
    }
  };
  return (rows as RowBase[]).filter(keep) as TabRows[T];
}
