// List state shared by the Loot view and the map: persisted prefs and the rows, filtered (what the
// Loot view's filter lets through, marked on the map while it's set) and not (the rules match against
// everything).

import { useMemo } from "react";
import { defineStore, isObject, oneOf, usePersisted } from "../persist";
import type { RadarState } from "../stream/connection";
import type { ItemCatalog } from "../model/items";
import type { QuestNeed } from "../model/quests";
import {
  DEFAULT_FILTERS,
  type ListFilters,
  type TabId,
  type TabRows,
  explosiveRows,
  exfilRows,
  filterRows,
  lootRows,
  normalizeFilters,
  playerRows,
  vehicleRows,
} from "./rows";

/** The Loot view's lists. */
export type LootTab = "items" | "containers";
/** How the items are sorted: by value per slot (then nearest), or nearest first. */
export type ItemSort = "value" | "dist";

export interface ListPrefs {
  tab: LootTab;
  sort: ItemSort;
  /** Only the items' and containers' text is set (the Loot view's filter); the rest stays at the defaults. */
  filters: ListFilters;
}

export const DEFAULT_PREFS: ListPrefs = { tab: "items", sort: "value", filters: DEFAULT_FILTERS };

/** Stored prefs, checked. */
export function normalizeListPrefs(stored: unknown): ListPrefs {
  const p = isObject(stored) ? stored : {};
  const f = normalizeFilters(p.filters);
  return {
    tab: oneOf(p.tab, ["items", "containers"], "items"),
    sort: oneOf(p.sort, ["value", "dist"], "value"),
    filters: { ...DEFAULT_FILTERS, items: f.items, containers: f.containers },
  };
}

export const listStore = defineStore<ListPrefs>({
  key: "radar.list",
  version: 2,
  scope: "user",
  defaults: () => DEFAULT_PREFS,
  migrations: {
    // A sortable table per tab (Players, Items, Containers, Exfils) became the Loot view (items and
    // containers): the tab, if it was one of those, and the items' sort if it was by distance stay.
    1: (d) => {
      if (!isObject(d)) return d;
      const { sorting, ...rest } = d;
      const first = isObject(sorting) && Array.isArray(sorting.items) && isObject(sorting.items[0]) ? sorting.items[0] : null;
      return { ...rest, sort: first?.id === "dist" ? "dist" : "value" };
    },
  },
  normalize: normalizeListPrefs,
});

export const useListPrefs = () => usePersisted(listStore);

export interface ListRows {
  /** Filtered rows, without distances. */
  rows: TabRows;
  /** All rows, without distances. */
  all: TabRows;
  /** Unfiltered row counts per tab. */
  totals: Record<TabId, number>;
}

/** Rows per category, each rebuilt only when its source changes (loot rarely, players many times a second). */
export function useListRows(
  state: RadarState,
  catalog: ItemCatalog,
  questLabels: ReadonlyMap<string, string>,
  questNeeds: ReadonlyMap<string, readonly QuestNeed[]>,
  filters: ListFilters,
): ListRows {
  const players = useMemo(() => playerRows(state.players, state.equipment, catalog, questNeeds), [state.players, state.equipment, catalog, questNeeds]);
  const loot = useMemo(() => lootRows(state.loot, catalog, questLabels, questNeeds), [state.loot, catalog, questLabels, questNeeds]);
  const exfils = useMemo(() => exfilRows(state.exfils), [state.exfils]);
  const explosives = useMemo(() => explosiveRows(state.explosives), [state.explosives]);
  const vehicles = useMemo(() => vehicleRows(state.vehicles), [state.vehicles]);
  return useMemo(() => {
    const all: TabRows = { players, items: loot.items, containers: loot.containers, exfils, explosives, vehicles };
    return {
      all,
      rows: {
        players: filterRows("players", players, filters.players),
        items: filterRows("items", loot.items, filters.items),
        containers: filterRows("containers", loot.containers, filters.containers),
        exfils: filterRows("exfils", exfils, filters.exfils),
        explosives,
        vehicles,
      },
      totals: {
        players: players.length,
        items: loot.items.length,
        containers: loot.containers.length,
        exfils: exfils.length,
      },
    };
  }, [players, loot, exfils, explosives, vehicles, filters]);
}
