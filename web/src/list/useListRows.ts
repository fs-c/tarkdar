// List state shared by the list panel and the map: persisted prefs and the rows, filtered (the map
// shows only what the list's filters let through) and not (highlights match against everything).

import type { SortingState } from "@tanstack/react-table";
import { useMemo } from "react";
import { defineStore, usePersisted } from "../persist";
import type { RadarState } from "../stream/connection";
import type { ItemCatalog } from "../model/items";
import type { QuestNeed } from "../model/quests";
import { TABS, columnIds } from "./columns";
import {
  DEFAULT_FILTERS,
  type ListFilters,
  TAB_IDS,
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

export interface ListPrefs {
  tab: TabId;
  sorting: Record<TabId, SortingState>;
  filters: ListFilters;
}

export const DEFAULT_PREFS: ListPrefs = {
  tab: "players",
  sorting: {
    players: TABS.players.defaultSort,
    items: TABS.items.defaultSort,
    containers: TABS.containers.defaultSort,
    exfils: TABS.exfils.defaultSort,
  },
  filters: DEFAULT_FILTERS,
};

/** Stored prefs, checked: columns have come and gone; filters of older builds (one set for all tabs)
 *  or garbage give the defaults. */
export function normalizeListPrefs(stored: unknown): ListPrefs {
  const p = (stored && typeof stored === "object" ? stored : {}) as Partial<ListPrefs>;
  const tab = p.tab && TAB_IDS.includes(p.tab) ? p.tab : DEFAULT_PREFS.tab;
  const sorting = { ...DEFAULT_PREFS.sorting };
  for (const t of TAB_IDS) {
    const ids = columnIds(TABS[t]);
    const s = (p.sorting as Partial<Record<TabId, SortingState>> | undefined)?.[t];
    const valid = Array.isArray(s) ? s.filter((x) => !!x && typeof x === "object" && ids.has(x.id)) : [];
    if (valid.length) sorting[t] = valid;
  }
  return { tab, sorting, filters: normalizeFilters(p.filters) };
}

export const listStore = defineStore<ListPrefs>({
  key: "radar.list",
  version: 1,
  scope: "user",
  defaults: () => DEFAULT_PREFS,
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
