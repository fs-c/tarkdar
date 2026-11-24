// Rows: one flat record per thing the radar knows about, with the facts the list, its filters and
// the highlights (highlight/) work with. Grouped into the list's tabs. Pure functions, so they can be
// tested without React.

import type { RadarState } from "../stream/connection";
import { isObject } from "../persist/store";
import { type ItemCatalog, containerName, equipmentValue, slotValue } from "../model/items";
import { exfilStatus } from "../model/exfils";
import { type Selection, midpoint, selectionKey } from "../draw/pick";
import type { Exfil, ExplosivesData, ItemNode, LootEntry, Player, PlayerEquipment, Vehicle, WorldPos } from "../model/protocol";
import { type NeedKind, type QuestNeed, carriedNeeds, formatQuestNeed, isOpen, neededKinds, needsFir } from "../model/quests";
import { type PlayerType, SPECIAL_TYPES, bossGroups, identityText, playerType } from "../model/roles";

export type TabId = "players" | "items" | "containers" | "exfils";
export const TAB_IDS: readonly TabId[] = ["players", "items", "containers", "exfils"];

/** What a thing is, across tabs. */
export type SubjectKind = "player" | "item" | "quest" | "container" | "airdrop" | "corpse" | "exfil" | "grenade" | "tripwire" | "vehicle";

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
  /** Templates the thing is (loose items, containers) or carries (players and corpses: their
   *  equipment, as far as it could be read). */
  tpls: readonly string[];
  /** Roubles: a loose item's value per inventory slot (items.ts slotValue); the equipment value of
   *  players and corpses. Undefined when unknown (unpriced, not read). */
  value?: number;
  /** Roubles: a loose item's unit price. */
  price?: number;
  /** Lowercase text the search matches against: names, kinds, carried items' names. */
  search: string;
  /** Loose items a started quest still needs, or what players and corpses carry that one does: what
   *  for, e.g. "Shooter Born in Heaven (×3, FIR)". */
  questNeeds?: readonly string[];
  /** A started quest needs it: a quest item, or an ordinary item one of whose needs is specific (an
   *  objective few items count for): `is:needed`, the "Needed for quests" rule. Players (but you) and
   *  corpses: they carry such an item (the "Carrying needed items" rule). */
  questNeeded?: boolean;
  /** One of those needs is found-in-raid (quest items: any), so buying won't do: `is:fir`, what the
   *  default rules highlight. Gear taken off a body is found in raid, so carried items count. */
  questFir?: boolean;
  /** The kinds of quest those needs are for: `quest:story` etc. */
  questKinds?: readonly NeedKind[];
  /** The names and ids (lowercase) of the quests that still need it, or what's carried (not covered
   *  by what's owned): `quest:"<name>"`, a tracked quest. */
  questNames?: readonly string[];
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
  /** Inventory slots it takes. */
  slots: number;
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

export interface VehicleRow extends RowBase {
  kind: Vehicle["kind"];
}

export interface TabRows {
  players: PlayerRow[];
  items: ItemRow[];
  containers: ContainerRow[];
  exfils: ExfilRow[];
  /** Not a tab (no list of their own), but on the map and matched by highlights. */
  explosives: ExplosiveRow[];
  /** Likewise: the BTR is on the map and matched by rules and highlights, but isn't listed. */
  vehicles: VehicleRow[];
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
    case "tripwire":
    case "vehicle": return undefined;
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

interface Gear {
  readonly tpls: readonly string[];
  /** The carried items' names, for the search text. */
  readonly text: string;
  /** equipmentValue; undefined when nothing was read or it's worth nothing known. */
  readonly value: number | undefined;
}

const NO_GEAR: Gear = { tpls: NO_TPLS, text: "", value: undefined };
/** Per catalogue, per item tree: equipment arrives far less often than positions (a new tree only
 *  with a new equipment message), so a players tick reuses what the last one worked out. */
const gearCache = new WeakMap<ItemCatalog, WeakMap<ItemNode[], Gear>>();

/** What a player or corpse carries: carried() and its value, cached per item tree. */
function gearOf(nodes: ItemNode[] | undefined, catalog: ItemCatalog): Gear {
  if (!nodes?.length) return NO_GEAR;
  let byTree = gearCache.get(catalog);
  if (!byTree) gearCache.set(catalog, (byTree = new WeakMap()));
  let gear = byTree.get(nodes);
  if (!gear) {
    const { tpls, names } = carried(nodes, catalog);
    byTree.set(nodes, (gear = { tpls, text: text(...names), value: equipmentValue(nodes, catalog) || undefined }));
  }
  return gear;
}

type NeedsMap = ReadonlyMap<string, readonly QuestNeed[]>;
const NO_NEEDS: NeedsMap = new Map();

/** What a player or corpse carries that quests need, as row fields; cached per needs map and gear. */
type GearNeeds = Pick<RowBase, "questNeeds" | "questNeeded" | "questFir" | "questKinds" | "questNames">;

/** The quests these needs are for, those still open: names (lowercase) and ids (for quests without a
 *  name of their own, e.g. story steps, a tracked one goes by its id). */
function questNamesOf(needs: readonly QuestNeed[] | undefined): string[] {
  return [...new Set((needs ?? []).filter(isOpen).flatMap((n) => [n.questName?.toLowerCase(), n.questId?.toLowerCase()].filter((x): x is string => !!x)))];
}
const NOT_NEEDED: GearNeeds = {};
const gearNeedsCache = new WeakMap<NeedsMap, WeakMap<Gear, GearNeeds>>();

function gearNeeds(gear: Gear, needs: NeedsMap): GearNeeds {
  if (!needs.size || !gear.tpls.length) return NOT_NEEDED;
  let byGear = gearNeedsCache.get(needs);
  if (!byGear) gearNeedsCache.set(needs, (byGear = new WeakMap()));
  let out = byGear.get(gear);
  if (!out) {
    const list = carriedNeeds(gear.tpls, needs);
    const kinds = neededKinds(list, true);
    const names = questNamesOf(list);
    out = list.length ? { questNeeds: list.map(formatQuestNeed), questNeeded: true, ...(needsFir(list, true) ? { questFir: true } : {}), questKinds: kinds, ...(names.length ? { questNames: names } : {}) } : NOT_NEEDED;
    byGear.set(gear, out);
  }
  return out;
}

/** Rows without distances, for all tabs. The per-category builders below let callers memoize each
 *  on its own input (loot changes rarely, players many times a second). */
export function buildRows(state: Pick<RadarState, "players" | "loot" | "exfils" | "explosives" | "vehicles" | "equipment">, catalog: ItemCatalog): TabRows {
  return {
    players: playerRows(state.players, state.equipment, catalog),
    ...lootRows(state.loot, catalog),
    exfils: exfilRows(state.exfils),
    explosives: explosiveRows(state.explosives),
    vehicles: vehicleRows(state.vehicles),
  };
}

/** `questNeeds`: template id → the started quests' objectives that still need it (quests.ts). */
export function playerRows(players: Player[], equipment: Map<number, PlayerEquipment>, catalog: ItemCatalog, questNeeds: NeedsMap = NO_NEEDS): PlayerRow[] {
  const groups = bossGroups(players);
  return players.map((p): PlayerRow => {
    const name = p.local ? "You" : `#${p.id}`;
    const t = playerType(p, groups);
    const st = p.dead ? "dead" : p.absent ? (p.extracted ? "extracted" : "left") : "alive";
    const gear = gearOf(equipment.get(p.id)?.slots, catalog);
    const raw = identityText(p);
    const search = text(name, `#${p.id}`, t.type, t.label, p.ai ? "ai bot" : "human", raw, st, gear.text);
    return {
      ...base({ kind: "player", id: p.id }, "player", p.pos, search, gear.tpls),
      value: gear.value,
      ...(p.local ? {} : gearNeeds(gear, questNeeds)),
      name, local: p.local, ai: p.ai, type: t.type, typeLabel: t.label, typeDetail: `${t.type}: ${t.reason}\n${raw}`,
      state: st,
    };
  });
}

/**
 * `questLabels`: quest item template id → the quests it's for (quests.ts), the quest item's name.
 * `questNeeds`: template id → the started quests' objectives that still need it (quests.ts).
 */
export function lootRows(
  loot: LootEntry[],
  catalog: ItemCatalog,
  questLabels: ReadonlyMap<string, string> = new Map(),
  questNeeds: NeedsMap = NO_NEEDS,
): Pick<TabRows, "items" | "containers"> {
  const items: ItemRow[] = [];
  const containers: ContainerRow[] = [];
  for (const l of loot) {
    const sel: Selection = { kind: "loot", id: l.id };
    if (l.kind === "corpse") {
      const gear = gearOf(l.contents, catalog);
      containers.push({
        ...base(sel, "corpse", l.pos, text("corpse body", gear.text), gear.tpls),
        value: gear.value,
        ...gearNeeds(gear, questNeeds),
        name: "corpse", kind: "corpse",
      });
    } else if (isContainerKind(l.kind)) {
      const name = l.kind === "container" ? (containerName(l.tpl) ?? "container") : l.kind;
      containers.push({ ...base(sel, l.kind, l.pos, text(name, l.kind, l.tpl), l.tpl ? [l.tpl] : NO_TPLS), name, kind: l.kind });
    } else {
      const info = catalog.lookup(l.tpl);
      const kind = l.kind === "quest" ? "quest" : "item";
      const name = info?.name ?? (kind === "quest" ? (questLabels.get(l.tpl) ?? "quest item") : l.tpl || "item");
      const needList = questNeeds.get(l.tpl);
      const needs = kind === "item" ? needList?.map(formatQuestNeed) : undefined;
      const kinds = neededKinds(needList, kind === "quest");
      const names = questNamesOf(needList);
      items.push({
        ...base(sel, kind, l.pos, text(name, info?.shortName, l.tpl, kind, ...(needs ?? [])), l.tpl ? [l.tpl] : NO_TPLS),
        value: slotValue(info),
        price: info?.price,
        slots: info?.slots ?? 1,
        name, shortName: info?.shortName ?? name, kind, basePrice: info?.priceSource === "base",
        ...(needs?.length ? { questNeeds: needs } : {}),
        ...(kinds.length ? { questNeeded: true, questKinds: kinds } : {}),
        ...(names.length ? { questNames: names } : {}),
        ...(needsFir(needList, kind === "quest") ? { questFir: true } : {}),
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

export const vehicleRows = (vehicles: Vehicle[]): VehicleRow[] =>
  vehicles.map((v): VehicleRow => ({ ...base({ kind: "vehicle", id: v.id }, "vehicle", v.pos, text(v.kind, "vehicle")), kind: v.kind }));

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
  /** Items: minimum value per slot (roubles). */
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
  if (!isObject(stored)) return out;
  for (const t of TAB_IDS) {
    const f = stored[t];
    if (isObject(f) && typeof f.text === "string") out[t] = cleanFilter(f, f.text, DEFAULT_FILTERS[t]);
  }
  return out;
}

/** One tab's stored filter: its fields (those the tab has) when of the right type, else the default's. */
function cleanFilter(_f: Record<string, unknown>, text: string, def: TabFilter): TabFilter {
  // Only the text: the players' chips and the items' minimum value are gone from the lists (UX rework),
  // so stored ones mustn't filter unseen.
  return { ...def, text };
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
        const isHuman = !p.ai;
        const isSpecial = SPECIAL_TYPES.has(p.type);
        const kindOk = (!f.humans && !f.special) || (!!f.humans && isHuman) || (!!f.special && isSpecial);
        return (!f.alive || p.state === "alive") && kindOk;
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
