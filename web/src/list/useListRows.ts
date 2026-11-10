// List state shared by the list panel and the map: persisted prefs and the filtered rows (the map
// shows only what the list's filters let through).

import type { SortingState } from "@tanstack/react-table";
import { useMemo } from "react";
import type { RadarState } from "../connection";
import type { ItemCatalog } from "../items";
import { TABS } from "./columns";
import { DEFAULT_FILTERS, type ListFilters, type TabId, type TabRows, explosiveRows, exfilRows, filterRows, lootRows, playerRows } from "./rows";

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
    explosives: TABS.explosives.defaultSort,
  },
  filters: DEFAULT_FILTERS,
};

export interface ListRows {
  /** Filtered rows, without distances. */
  rows: TabRows;
  /** Unfiltered row counts per tab. */
  totals: Record<TabId, number>;
}

/** Rows per category, each rebuilt only when its source changes (loot rarely, players many times a second). */
export function useListRows(state: RadarState, catalog: ItemCatalog, filters: ListFilters): ListRows {
  const players = useMemo(() => playerRows(state.players, state.equipment, catalog), [state.players, state.equipment, catalog]);
  const loot = useMemo(() => lootRows(state.loot, catalog), [state.loot, catalog]);
  const exfils = useMemo(() => exfilRows(state.exfils), [state.exfils]);
  const explosives = useMemo(() => explosiveRows(state.explosives), [state.explosives]);
  return useMemo(
    () => ({
      rows: {
        players: filterRows("players", players, filters),
        items: filterRows("items", loot.items, filters),
        containers: filterRows("containers", loot.containers, filters),
        exfils: filterRows("exfils", exfils, filters),
        explosives: filterRows("explosives", explosives, filters),
      },
      totals: {
        players: players.length,
        items: loot.items.length,
        containers: loot.containers.length,
        exfils: exfils.length,
        explosives: explosives.length,
      },
    }),
    [players, loot, exfils, explosives, filters],
  );
}
