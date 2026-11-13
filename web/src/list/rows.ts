// Rows: one flat record per thing the radar knows about, with the facts the list, its filters and
// the highlights (highlight/) work with. Grouped into the list's tabs. Pure functions, so they can be
// tested without React.

import type { RadarState } from "../connection";
import { type ItemCatalog, containerName, equipmentValue, exfilStatus } from "../items";
import { type Selection, midpoint, selectionKey } from "../pick";
import type { Exfil, ExplosivesData, ItemNode, LootEntry, Player, PlayerEquipment, WorldPos } from "../protocol";
import { type PlayerType, SPECIAL_TYPES, bossGroups, identityText, playerType } from "../roles";
import { playerLook } from "../style";

export type TabId = "players" | "items" | "containers" | "exfils";
export const TAB_IDS: readonly TabId[] = ["players", "items", "containers", "exfils"];

/** What a thing is, across tabs. */
export type SubjectKind = "player" | "item" | "quest" | "container" | "airdrop" | "corpse" | "exfil" | "grenade" | "tripwire";

export interface RowBase {
  /** Stable id: selection kind + id. */
  key: string;
  sel: Selection;
  subject: SubjectKind;
  pos: WorldPos | null;
  /** Horizontal distance from the local player (m); undefined without a local position. */
  dist?: number;
  /** Height above the local player (m). */
  dh?: number;
  /** Item templates the thing is (loose items) or carries (players and corpses: their equipment, as
   *  far as it could be read). */
  tpls: readonly string[];
  /** Roubles: a loose item's unit price; the equipment value of players and corpses. Undefined when
   *  unknown (unpriced, not read). */
  value?: number;
  /** Lowercase text the search matches against: names, kinds, carried items' names. */
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
  state: "alive" | "dead" | "left" | "extracted";
}

export interface ItemRow extends RowBase {
  name: string;
  shortName: string;
  kind: "item" | "quest";
  basePrice: boolean;
}

export interface ContainerRow extends RowBase {
  name: string;
  kind: "container" | "airdrop" | "corpse";
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
  /** Not a tab (no list of their own), but on the map and matched by highlights. */
  explosives: ExplosiveRow[];
}

export type AnyRow = TabRows[keyof TabRows][number];

const isContainerKind = (k: LootEntry["kind"]): k is ContainerRow["kind"] =>
  k === "container" || k === "airdrop" || k === "corpse";

/** The tab a selection's row lives in (undefined if the thing is gone). */
export function tabOf(sel: Selection, state: Pick<RadarState, "loot">): TabId | undefined {
  switch (sel.kind) {
    case "player": return "players";
    case "exfil": return "exfils";
    case "grenade":
    case "tripwire": return undefined;
    case "loot": {
      const l = state.loot.find((x) => x.id === sel.id);
      return l ? (isContainerKind(l.kind) ? "containers" : "items") : undefined;
    }
  }
}

export { selectionKey };

const text = (...parts: (string | undefined | false)[]) => parts.filter(Boolean).join(" ").toLowerCase();

const NO_TPLS: readonly string[] = [];

function base(sel: Selection, subject: SubjectKind, pos: WorldPos | null, search: string, tpls = NO_TPLS): RowBase {
  return { key: selectionKey(sel), sel, subject, pos, search, tpls };
}

/** Templates and names of everything in an item tree (equipment), for matching and search. */
export function carried(nodes: ItemNode[] | undefined, catalog: ItemCatalog): { tpls: string[]; names: string[] } {
  const tpls: string[] = [];
  const names: string[] = [];
  const walk = (ns: ItemNode[]) => {
    for (const n of ns) {
      tpls.push(n.tpl);
      const info = catalog.lookup(n.tpl);
      if (info) names.push(info.name, info.shortName);
      if (n.items?.length) walk(n.items);
    }
  };
  if (nodes) walk(nodes);
  return { tpls, names };
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
    const st = p.dead ? "dead" : p.absent ? (p.extracted ? "extracted" : "left") : "alive";
    const slots = equipment.get(p.id)?.slots;
    const gear = carried(slots, catalog);
    const raw = identityText(p);
    const search = text(name, `#${p.id}`, t.type, t.label, p.ai ? "ai bot" : "human", raw, st, ...gear.names);
    return {
      ...base({ kind: "player", id: p.id }, "player", p.pos, search, gear.tpls),
      value: slots?.length ? equipmentValue(slots, catalog) || undefined : undefined,
      name, local: p.local, ai: p.ai, type: t.type, typeLabel: t.label, typeDetail: `${t.type}: ${t.reason}\n${raw}`,
      state: st, dim: playerLook(t.type).dim,
    };
  });
}

export function lootRows(loot: LootEntry[], catalog: ItemCatalog): Pick<TabRows, "items" | "containers"> {
  const items: ItemRow[] = [];
  const containers: ContainerRow[] = [];
  for (const l of loot) {
    const sel: Selection = { kind: "loot", id: l.id };
    if (l.kind === "corpse") {
      const gear = carried(l.contents, catalog);
      containers.push({
        ...base(sel, "corpse", l.pos, text("corpse body", ...gear.names), gear.tpls),
        value: l.contents?.length ? equipmentValue(l.contents, catalog) || undefined : undefined,
        name: "corpse", kind: "corpse",
      });
    } else if (isContainerKind(l.kind)) {
      const name = l.kind === "container" ? (containerName(l.tpl) ?? "container") : l.kind;
      containers.push({ ...base(sel, l.kind, l.pos, text(name, l.kind, l.tpl)), name, kind: l.kind });
    } else {
      const info = catalog.lookup(l.tpl);
      const kind = l.kind === "quest" ? "quest" : "item";
      const name = info?.name ?? (kind === "quest" ? "quest item" : l.tpl || "item");
      items.push({
        ...base(sel, kind, l.pos, text(name, info?.shortName, l.tpl, kind), l.tpl ? [l.tpl] : NO_TPLS),
        value: info?.price,
        name, shortName: info?.shortName ?? name, kind, basePrice: info?.priceSource === "base",
      });
    }
  }
  return { items, containers };
}

export function exfilRows(exfils: Exfil[]): ExfilRow[] {
  return exfils.map((e): ExfilRow => {
    const s = exfilStatus(e.status);
    return { ...base({ kind: "exfil", id: e.id }, "exfil", e.pos, text(e.name, "exfil", e.kind, s.label)), name: e.name, kind: e.kind, status: s.label, tone: s.tone };
  });
}

export function explosiveRows(explosives: ExplosivesData): ExplosiveRow[] {
  return [
    ...explosives.grenades.map((g): ExplosiveRow => ({ ...base({ kind: "grenade", id: g.id }, "grenade", g.pos, "grenade"), kind: "grenade" })),
    ...explosives.tripwires.map((w): ExplosiveRow => ({
      ...base({ kind: "tripwire", id: w.id }, "tripwire", midpoint(w.from, w.to), "tripwire"),
      kind: "tripwire",
      length: Math.hypot(w.to[0] - w.from[0], w.to[1] - w.from[1], w.to[2] - w.from[2]),
    })),
  ];
}

/** Adds distance and height difference to the local player (a new array; rows are shared). */
export function withDistances<R extends RowBase>(rows: R[], local: WorldPos | null): R[] {
  if (!local) return rows;
  return rows.map((r) =>
    r.pos ? { ...r, dist: Math.hypot(r.pos[0] - local[0], r.pos[2] - local[2]), dh: r.pos[1] - local[1] } : r,
  );
}

// ---- List filters: per tab. The map follows them too (for that tab's kind of thing). ----

export interface TabFilter {
  /** Free text; every whitespace-separated term must match. */
  text: string;
  /** Players: alive only. */
  alive?: boolean;
  /** Players: humans only. */
  humans?: boolean;
  /** Players: bosses, guards, raiders, rogues, cultists only. */
  special?: boolean;
  /** Items: minimum unit price (roubles). */
  minValue?: number;
}

export type ListFilters = Record<TabId, TabFilter>;

export const DEFAULT_FILTERS: ListFilters = {
  players: { text: "", alive: false, humans: false, special: false },
  items: { text: "", minValue: 0 },
  containers: { text: "" },
  exfils: { text: "" },
};

export const isTabFiltered = (f: TabFilter): boolean =>
  f.text.trim() !== "" || !!f.alive || !!f.humans || !!f.special || (f.minValue ?? 0) > 0;

export const isFiltered = (f: ListFilters): boolean => TAB_IDS.some((t) => isTabFiltered(f[t]));

/** Stored filters from older versions (one set for all tabs) or garbage: the defaults. */
export function normalizeFilters(stored: unknown): ListFilters {
  const out = { ...DEFAULT_FILTERS };
  if (!stored || typeof stored !== "object") return out;
  for (const t of TAB_IDS) {
    const f = (stored as Record<string, unknown>)[t];
    if (f && typeof f === "object" && typeof (f as TabFilter).text === "string") out[t] = { ...DEFAULT_FILTERS[t], ...(f as TabFilter) };
  }
  return out;
}

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

export function filterRows<T extends TabId>(tab: T, rows: TabRows[T], f: TabFilter): TabRows[T] {
  if (!isTabFiltered(f)) return rows;
  const keep = (r: RowBase): boolean => {
    if (!matchesText(r, f.text)) return false;
    switch (tab) {
      case "players": {
        const p = r as PlayerRow;
        // humans + special: either kind (the two together mean "the ones that matter").
        const kind = !f.humans && !f.special ? true : (!!f.humans && !p.ai) || (!!f.special && SPECIAL_TYPES.has(p.type));
        return (!f.alive || p.state === "alive") && kind;
      }
      case "items": {
        const min = f.minValue ?? 0;
        return min === 0 || (r.value !== undefined && r.value >= min);
      }
      default:
        return true;
    }
  };
  return (rows as RowBase[]).filter(keep) as TabRows[T];
}
