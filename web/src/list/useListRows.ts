// List state shared by the list panel and the map: persisted prefs and the rows, filtered (the map
// shows only what the list's filters let through) and not (highlights match against everything).

import type { SortingState } from "@tanstack/react-table";
import { useMemo } from "react";
import type { RadarState } from "../connection";
import { usePersistentState } from "../hooks";
import type { ItemCatalog } from "../items";
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

/** Prefs stored by older versions: filters were one set for all tabs, columns have come and gone. */
export function normalizeListPrefs(p: ListPrefs): ListPrefs {
  const tab = TAB_IDS.includes(p.tab) ? p.tab : DEFAULT_PREFS.tab;
  const sorting = { ...DEFAULT_PREFS.sorting };
  for (const t of TAB_IDS) {
    const ids = columnIds(TABS[t]);
    const s = (p.sorting as Partial<Record<TabId, SortingState>> | undefined)?.[t];
    const valid = Array.isArray(s) ? s.filter((x) => ids.has(x.id)) : [];
    if (valid.length) sorting[t] = valid;
  }
  return { tab, sorting, filters: normalizeFilters(p.filters) };
}

export function useListPrefs(): [ListPrefs, (update: (prev: ListPrefs) => ListPrefs) => void] {
  const [stored, setStored] = usePersistentState<ListPrefs>("radar.list", DEFAULT_PREFS);
  const prefs = useMemo(() => normalizeListPrefs(stored), [stored]);
  return [prefs, (update) => setStored((p) => update(normalizeListPrefs(p)))];
}

export interface ListRows {
  /** Filtered rows, without distances. */
  rows: TabRows;
  /** All rows, without distances. */
  all: TabRows;
  /** Unfiltered row counts per tab. */
  totals: Record<TabId, number>;
}

/** Rows per category, each rebuilt only when its source changes (loot rarely, players many times a second). */
export function useListRows(state: RadarState, catalog: ItemCatalog, filters: ListFilters): ListRows {
  const players = useMemo(() => playerRows(state.players, state.equipment, catalog), [state.players, state.equipment, catalog]);
  const loot = useMemo(() => lootRows(state.loot, catalog), [state.loot, catalog]);
  const exfils = useMemo(() => exfilRows(state.exfils), [state.exfils]);
  const explosives = useMemo(() => explosiveRows(state.explosives), [state.explosives]);
  return useMemo(() => {
    const all: TabRows = { players, items: loot.items, containers: loot.containers, exfils, explosives };
    return {
      all,
      rows: {
        players: filterRows("players", players, filters.players),
        items: filterRows("items", loot.items, filters.items),
        containers: filterRows("containers", loot.containers, filters.containers),
        exfils: filterRows("exfils", exfils, filters.exfils),
        explosives,
      },
      totals: {
        players: players.length,
        items: loot.items.length,
        containers: loot.containers.length,
        exfils: exfils.length,
      },
    };
  }, [players, loot, exfils, explosives, filters]);
}
