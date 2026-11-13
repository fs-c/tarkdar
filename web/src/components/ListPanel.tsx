// List views: everything the radar knows, in sortable, filterable tables (one per category, picked
// from the activity bar). Each tab has its own filters, and the map follows them (for that tab's kind
// of thing). Highlighted rows (highlight/, the global search) are marked in their colour.
// Hovering a row marks it on the map; clicking (or ↑/↓) selects it and centres the map on it.

import { type OnChangeFn, type SortingState, useTable } from "@tanstack/react-table";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import type { RadarState } from "../connection";
import { type TabDef, TABS, features } from "../list/columns";
import { DEFAULT_FILTERS, type RowBase, type TabFilter, type TabRows, isTabFiltered, selectionKey, tabOf, withDistances } from "../list/rows";
import type { ListPrefs, ListRows } from "../list/useListRows";
import type { Selection } from "../pick";
import { Button, Chip, cx, selectableRow } from "../ui";
import s from "./ListPanel.module.css";

const ROW_HEIGHT = 22;
const HEADER_HEIGHT = 24;
const MIN_VALUES = [0, 10_000, 25_000, 50_000, 100_000, 250_000];

interface Props {
  state: RadarState;
  /** Filtered rows (shared with the map, which shows only these). */
  list: ListRows;
  prefs: ListPrefs;
  setPrefs: (update: (prev: ListPrefs) => ListPrefs) => void;
  selection: Selection | null;
  /** Row clicked or stepped to: select it and bring it into view on the map. */
  onActivate: (sel: Selection) => void;
  onHover: (sel: Selection | null) => void;
  /** Row key → highlight colour. */
  highlights: ReadonlyMap<string, string>;
  /** Set by the panel: focuses its search (the L key). */
  focusRef: React.RefObject<(() => void) | undefined>;
}

export function ListPanel({ state, list, prefs, setPrefs, selection, onActivate, onHover, highlights, focusRef }: Props) {
  const { tab } = prefs;
  const filter = prefs.filters[tab];
  const { totals } = list;
  const filterRef = useRef<HTMLInputElement>(null);
  const stepRef = useRef<(dir: 1 | -1) => void>(undefined);

  const local = state.players.find((p) => p.local && p.pos)?.pos ?? null;
  const rows = useMemo(
    (): TabRows => ({
      players: withDistances(list.rows.players, local),
      items: withDistances(list.rows.items, local),
      containers: withDistances(list.rows.containers, local),
      exfils: withDistances(list.rows.exfils, local),
      explosives: withDistances(list.rows.explosives, local),
    }),
    [list.rows, local],
  );

  const setFilter = (patch: Partial<TabFilter>) =>
    setPrefs((p) => ({ ...p, filters: { ...p.filters, [p.tab]: { ...p.filters[p.tab], ...patch } } }));
  const onSortingChange: OnChangeFn<SortingState> = (update) =>
    setPrefs((p) => ({
      ...p,
      sorting: { ...p.sorting, [p.tab]: typeof update === "function" ? update(p.sorting[p.tab]) : update },
    }));

  // A selection made on the map switches to its tab (the table then scrolls to it).
  const selKey = selection ? selectionKey(selection) : null;
  useEffect(() => {
    const t = selection && tabOf(selection, state);
    if (t) setPrefs((p) => (p.tab === t ? p : { ...p, tab: t }));
    // Only on selection changes, not on every data update.
  }, [selKey]);

  useLayoutEffect(() => {
    focusRef.current = () => {
      filterRef.current?.focus();
      filterRef.current?.select();
    };
    return () => {
      focusRef.current = undefined;
    };
  }, [focusRef]);

  useEffect(() => () => onHover(null), []); // closing the list ends any hover

  const empty = totals[tab] === 0 ? "nothing here (yet)" : "no matches";
  const common = { empty, sorting: prefs.sorting[tab], onSortingChange, selectedKey: selKey, onActivate, onHover, stepRef, highlights };
  const filtered = isTabFiltered(filter);

  return (
    <div className={s.list}>
      <div className={s.filters}>
        <input
          ref={filterRef}
          className={s.search}
          type="search"
          placeholder={`filter ${TABS[tab].label.toLowerCase()}  ( L )`}
          value={filter.text}
          onChange={(e) => setFilter({ text: e.target.value })}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              if (filter.text) setFilter({ text: "" });
              else e.currentTarget.blur();
            } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
              e.preventDefault();
              stepRef.current?.(e.key === "ArrowDown" ? 1 : -1);
            }
          }}
        />
        {tab === "players" && (
          <>
            <Chip on={!!filter.alive} onClick={() => setFilter({ alive: !filter.alive })}>alive</Chip>
            <Chip on={!!filter.humans} onClick={() => setFilter({ humans: !filter.humans })}>humans</Chip>
            <Chip on={!!filter.special} onClick={() => setFilter({ special: !filter.special })}>special</Chip>
          </>
        )}
        {tab === "items" && (
          <select value={filter.minValue ?? 0} title="Minimum price (per unit)" onChange={(e) => setFilter({ minValue: Number(e.target.value) })}>
            {MIN_VALUES.map((v) => (
              <option key={v} value={v}>{v === 0 ? "any ₽" : `≥ ${v / 1000}k ₽`}</option>
            ))}
          </select>
        )}
      </div>
      {tab === "players" && <TabTable key={tab} def={TABS.players} rows={rows.players} {...common} />}
      {tab === "items" && <TabTable key={tab} def={TABS.items} rows={rows.items} {...common} />}
      {tab === "containers" && <TabTable key={tab} def={TABS.containers} rows={rows.containers} {...common} />}
      {tab === "exfils" && <TabTable key={tab} def={TABS.exfils} rows={rows.exfils} {...common} />}
      {tab === "explosives" && <TabTable key={tab} def={TABS.explosives} rows={rows.explosives} {...common} />}
      <div className={s.footer}>
        <span>
          {filtered ? `${rows[tab].length} of ${totals[tab]}` : `${totals[tab]}`}
          {filtered && (
            <Button variant="link" className={s.clear} onClick={() => setFilter(DEFAULT_FILTERS[tab])}>clear filter</Button>
          )}
        </span>
        <span className="muted">{filtered && "map shows matches only · "}click: show on map · ↑↓ step · L close</span>
      </div>
    </div>
  );
}

interface TableProps<R extends RowBase> {
  def: TabDef<R>;
  rows: R[];
  /** Shown when there are no rows. */
  empty: string;
  sorting: SortingState;
  onSortingChange: OnChangeFn<SortingState>;
  selectedKey: string | null;
  onActivate: (sel: Selection) => void;
  onHover: (sel: Selection | null) => void;
  /** Set by the table: step the selection through its (sorted) rows. */
  stepRef: React.RefObject<((dir: 1 | -1) => void) | undefined>;
  highlights: ReadonlyMap<string, string>;
}

function TabTable<R extends RowBase>({ def, rows, empty, sorting, onSortingChange, selectedKey, onActivate, onHover, stepRef, highlights }: TableProps<R>) {
  const table = useTable({
    features,
    columns: def.columns,
    data: rows,
    state: { sorting },
    onSortingChange,
    getRowId: (r) => r.key,
    enableSortingRemoval: false,
  });
  const sorted = table.getRowModel().rows;
  const scrollRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: sorted.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    getItemKey: (i) => sorted[i]!.id,
    overscan: 12,
    scrollMargin: HEADER_HEIGHT, // the sticky header sits above the rows inside the scroller
    scrollPaddingStart: HEADER_HEIGHT,
  });
  const numeric = new Set(def.numeric);
  const grid = { gridTemplateColumns: def.template };

  const sortedRef = useRef(sorted);
  useLayoutEffect(() => {
    sortedRef.current = sorted;
    stepRef.current = (dir) => {
      const list = sortedRef.current;
      if (!list.length) return;
      const at = list.findIndex((r) => r.id === selectedKey);
      const next = at < 0 ? (dir > 0 ? 0 : list.length - 1) : Math.min(list.length - 1, Math.max(0, at + dir));
      onActivate(list[next]!.original.sel);
    };
  });

  // Keep the selected row visible when the selection changes (not when rows merely re-sort).
  useEffect(() => {
    const i = selectedKey ? sortedRef.current.findIndex((r) => r.id === selectedKey) : -1;
    if (i >= 0) virtualizer.scrollToIndex(i, { align: "auto" });
  }, [selectedKey, virtualizer]);

  return (
    <div
      className={s.scroll}
      ref={scrollRef}
      tabIndex={0}
      role="grid"
      aria-rowcount={sorted.length}
      onMouseLeave={() => onHover(null)}
      onKeyDown={(e) => {
        if (e.key === "ArrowDown" || e.key === "ArrowUp") {
          e.preventDefault();
          stepRef.current?.(e.key === "ArrowDown" ? 1 : -1);
        }
      }}
    >
      <div className={cx(s.grid, s.head)} role="row" style={{ ...grid, height: HEADER_HEIGHT }}>
        {table.getHeaderGroups()[0]!.headers.map((h) => {
          const dir = h.column.getIsSorted();
          return (
            <div
              key={h.id}
              role="columnheader"
              aria-sort={dir === "asc" ? "ascending" : dir === "desc" ? "descending" : "none"}
              className={numeric.has(h.column.id) ? "num" : undefined}
              onClick={h.column.getToggleSortingHandler()}
              title="Sort (shift-click: add a secondary sort)"
            >
              <table.FlexRender header={h} />
              <span className={s.sort}>{dir === "asc" ? "▲" : dir === "desc" ? "▼" : ""}</span>
            </div>
          );
        })}
      </div>
      {sorted.length === 0 && <div className={cx(s.empty, "muted")}>{empty}</div>}
      <div style={{ height: virtualizer.getTotalSize() - HEADER_HEIGHT, position: "relative" }}>
        {virtualizer.getVirtualItems().map((item) => {
          const row = sorted[item.index]!;
          const hl = highlights.get(row.id);
          return (
            <div
              key={row.id}
              role="row"
              aria-selected={row.id === selectedKey}
              data-selected={row.id === selectedKey}
              data-dim={!!row.original.dim}
              data-hl={!!hl}
              className={cx(s.grid, s.row, selectableRow)}
              style={{ ...grid, height: ROW_HEIGHT, transform: `translateY(${item.start - HEADER_HEIGHT}px)`, ...(hl && { "--hl": hl }) }}
              onClick={() => onActivate(row.original.sel)}
              onMouseEnter={() => onHover(row.original.sel)}
            >
              {row.getAllCells().map((cell) => (
                <div key={cell.id} role="gridcell" className={numeric.has(cell.column.id) ? "num" : undefined}>
                  <table.FlexRender cell={cell} />
                </div>
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}
