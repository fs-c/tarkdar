// The Loot view: loose items (by value per slot, or nearest first) or containers (nearest first), with
// a filter. What the filter lets through is marked on the map while it's set, and "Watch" keeps it as a
// watch entry. Each row: a mark when it's watched or a quest needs it (in that colour), the name (quest
// items in the quest colour), the value, and the distance with an arrow pointing at it. Hovering a row
// marks it on the map; clicking selects it and shows it there.

import { useVirtualizer } from "@tanstack/react-virtual";
import { Binoculars, Search } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import type { Selection } from "../draw/pick";
import { formatPrice } from "../model/items";
import { type ContainerRow, type ItemRow, selectionKey, tabOf, withDistances } from "../list/rows";
import type { ListPrefs, ListRows, LootTab } from "../list/useListRows";
import type { RadarState } from "../stream/connection";
import type { ThingMark } from "../watch/rules";
import { Button, cx, PanelBody, Segmented } from "../ui";
import { Distance, type Viewpoint } from "./PlayersView";
import v from "./views.module.css";

const ROW_HEIGHT = 25;

interface Props {
  state: Pick<RadarState, "loot">;
  /** The rows, filtered by the prefs' filters (`rows`) and not (`totals`). */
  list: ListRows;
  prefs: ListPrefs;
  setPrefs: (update: (prev: ListPrefs) => ListPrefs) => void;
  local: Viewpoint;
  /** Row key → its mark (watched, needed for a quest). */
  marks: ReadonlyMap<string, ThingMark>;
  /** How many of the filtered rows are marked on the map (at most). */
  markedMax: number;
  selection: Selection | null;
  onActivate: (sel: Selection) => void;
  onHover: (sel: Selection | null) => void;
  /** "Watch …": the filter text as a watch entry. */
  onWatch: (text: string) => void;
  /** Set by the view: focuses its filter (the L key). */
  focusRef: React.RefObject<(() => void) | undefined>;
}

type Row = ItemRow | ContainerRow;

export function LootView({ state, list, prefs, setPrefs, local, marks, markedMax, selection, onActivate, onHover, onWatch, focusRef }: Props) {
  const tab = prefs.tab;
  const text = prefs.filters[tab].text;
  const term = text.trim();
  const inputRef = useRef<HTMLInputElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const selKey = selection ? selectionKey(selection) : null;

  const setText = (t: string) => setPrefs((p) => ({ ...p, filters: { ...p.filters, [tab]: { ...p.filters[tab], text: t } } }));
  const setTab = (t: LootTab) => setPrefs((p) => ({ ...p, tab: t }));

  useLayoutEffect(() => {
    focusRef.current = () => {
      inputRef.current?.focus();
      inputRef.current?.select();
    };
    return () => void (focusRef.current = undefined);
  }, [focusRef]);
  useEffect(() => () => onHover(null), []);

  // A selection made on the map switches to its list (which then scrolls to it).
  useEffect(() => {
    const t = selection && tabOf(selection, state);
    if (t === "items" || t === "containers") setPrefs((p) => (p.tab === t ? p : { ...p, tab: t }));
    // Only on selection changes, not on every data update.
  }, [selKey]);

  const rows: Row[] = useMemo(() => {
    const out: Row[] = withDistances<Row>(list.rows[tab], local?.pos ?? null);
    const dist = (r: Row) => r.dist ?? Infinity;
    const byValue = tab === "items" && prefs.sort === "value";
    return out.sort((a, b) => (byValue ? (b.value ?? -1) - (a.value ?? -1) : 0) || dist(a) - dist(b));
  }, [list.rows, tab, prefs.sort, local?.pos]);

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => bodyRef.current,
    estimateSize: () => ROW_HEIGHT,
    getItemKey: (i) => rows[i]!.key,
    overscan: 12,
  });
  // The rows start below the filter and the tools, in the same scroller.
  useLayoutEffect(() => {
    const top = listRef.current?.offsetTop ?? 0;
    if (virtualizer.options.scrollMargin !== top) virtualizer.setOptions({ ...virtualizer.options, scrollMargin: top });
  });

  // Keep the selected row in view when the selection changes (not when rows merely re-sort).
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  useEffect(() => {
    const i = selKey ? rowsRef.current.findIndex((r) => r.key === selKey) : -1;
    if (i >= 0) virtualizer.scrollToIndex(i, { align: "auto" });
  }, [selKey, tab, virtualizer]);

  const totals = list.totals;
  return (
    <PanelBody ref={bodyRef}>
      <label className={v.find}>
        <Search size={14} />
        <input
          ref={inputRef}
          placeholder={tab === "items" ? "Filter items" : "Filter containers"}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              if (text) setText("");
              else e.currentTarget.blur();
            }
          }}
        />
      </label>
      <div className={v.tools}>
        <Segmented
          label="Loot"
          options={[
            { value: "items" as const, label: <>Items <span className={v.count}>{totals.items}</span></> },
            { value: "containers" as const, label: <>Containers <span className={v.count}>{totals.containers}</span></> },
          ]}
          value={tab}
          onChange={setTab}
        />
        <span className={v.grow} />
        {tab === "items" && (
          <Segmented
            label="Sort"
            options={[
              { value: "value" as const, label: "By value", title: "The most valuable per inventory slot first" },
              { value: "dist" as const, label: "Nearest" },
            ]}
            value={prefs.sort}
            onChange={(sort) => setPrefs((p) => ({ ...p, sort }))}
          />
        )}
      </div>
      {term && rows.length > 0 && (
        <div className={v.tools}>
          <span className={v.faint}>{rows.length > markedMax ? `The first ${markedMax} of ${rows.length}` : rows.length} marked on the map</span>
          <span className={v.grow} />
          {tab === "items" && (
            <Button className={v.primary} title="Keep these as a watch entry" onClick={() => onWatch(term)}>
              <Binoculars size={13} /> Watch “{term}”
            </Button>
          )}
        </div>
      )}
      {rows.length === 0 && <p className={v.empty}>{totals[tab] === 0 ? (tab === "items" ? "No loose items (yet)" : "No containers (yet)") : "Nothing matches"}</p>}
      <div ref={listRef} style={{ height: virtualizer.getTotalSize(), position: "relative" }} onPointerLeave={() => onHover(null)}>
        {virtualizer.getVirtualItems().map((item) => {
          const r = rows[item.index]!;
          return (
            <LootLine
              key={r.key}
              r={r}
              from={local}
              mark={marks.get(r.key)}
              selected={r.key === selKey}
              top={item.start - virtualizer.options.scrollMargin}
              onActivate={onActivate}
              onHover={onHover}
            />
          );
        })}
      </div>
    </PanelBody>
  );
}

interface LineProps {
  r: Row;
  from: Viewpoint;
  mark?: ThingMark;
  selected: boolean;
  /** Offset in the list (px). */
  top: number;
  onActivate: (sel: Selection) => void;
  onHover: (sel: Selection | null) => void;
}

function LootLine({ r, from, mark, selected, top, onActivate, onHover }: LineProps) {
  const item = "shortName" in r ? r : null;
  const value = r.value !== undefined && r.value > 0 ? formatPrice(r.value) : "";
  const valueTitle = item
    ? item.price !== undefined
      ? `${formatPrice(item.price)} ₽ each, ${item.slots} slot${item.slots === 1 ? "" : "s"}${item.basePrice ? " (base price: no flea data)" : ""}`
      : undefined
    : r.subject === "corpse"
      ? "Equipment value"
      : undefined;
  const fullName = item ? item.name : `${r.name} (${r.kind})`;
  return (
    <div
      className={cx(v.row, v.thing)}
      style={{ position: "absolute", top: 0, left: 0, right: 0, transform: `translateY(${top}px)` }}
      data-selected={selected}
      onClick={() => onActivate(r.sel)}
      onPointerEnter={() => onHover(r.sel)}
    >
      <span>{mark && <span className={v.pip} style={{ background: mark.color }} title={mark.label} />}</span>
      <span title={r.questNeeds?.length ? `${fullName}\nNeeded for ${r.questNeeds.join(", ")}` : fullName} className={cx(item?.kind === "quest" && v.quest)}>
        {item ? item.shortName : r.name}
      </span>
      <span className={cx("num", v.value, item?.basePrice && v.base)} title={valueTitle}>
        {value}
      </span>
      <span className="num">
        <Distance row={r} from={from} />
      </span>
    </div>
  );
}
