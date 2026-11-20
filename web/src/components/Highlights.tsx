// The global search (top left of the map, or /): highlights things across everything the radar knows,
// without hiding anything (filtering is the list's job). Typing suggests what the query could mean;
// the active suggestion previews on the map; Enter (or a click) keeps it as a pill. Pills: click to
// switch on/off, the count steps through the matches (nearest first), the pin keeps it as a pinned
// rule for this raid (the Filters view, where it can be edited and kept for good), × removes. The search
// takes the query syntax too (highlight/query.ts): "is:item pen>=40".

import { Highlighter, Pin, X } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { isTyping } from "../hooks";
import { type Highlight, matchingRows, nextColor } from "../highlight/match";
import { type Suggestion, suggest } from "../highlight/suggest";
import type { ItemCatalog } from "../items";
import type { AnyRow } from "../list/rows";
import type { Selection } from "../pick";
import type { WorldPos } from "../protocol";
import s from "./Highlights.module.css";

interface Props {
  highlights: Highlight[];
  setHighlights: (update: (prev: Highlight[]) => Highlight[]) => void;
  /** Highlight id → what it matches now. */
  matched: ReadonlyMap<number, AnyRow[]>;
  /** Everything there is (for the suggestions' counts). */
  rows: readonly AnyRow[];
  catalog: ItemCatalog;
  /** The local player's position: matches are stepped through nearest first. */
  local: WorldPos | null;
  /** The query to preview on the map while searching (null: none). */
  onPreview: (query: string | null) => void;
  /** Select a match and bring it into view. */
  onShow: (sel: Selection) => void;
  /** Pin it: a rule for this raid (the Filters view's "Pinned"). */
  onPin: (h: Highlight) => void;
}

let nextId = 1;

export function Highlights({ highlights, setHighlights, matched, rows, catalog, local, onPreview, onShow, onPin }: Props) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const steps = useRef(new Map<number, number>());

  const suggestions = useMemo(() => suggest(query, catalog), [query, catalog]);
  const counts = useMemo(() => suggestions.map((sg) => matchingRows(rows, sg.query, catalog).length), [suggestions, rows, catalog]);
  const current = open ? suggestions[Math.min(active, suggestions.length - 1)] : undefined;

  useEffect(() => onPreview(current && !current.error ? current.query : null), [current?.query, current?.error]);
  useEffect(() => () => onPreview(null), []);

  // Opened: the search takes the focus, its old text selected (typing replaces it). In the commit, not
  // a frame later, so keys typed right after "/" land in it.
  useLayoutEffect(() => {
    if (open) inputRef.current?.select();
  }, [open]);

  // "/" opens the search from anywhere (but not while typing elsewhere).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "/" || isTyping(e) || e.ctrlKey || e.metaKey || e.altKey) return;
      e.preventDefault();
      setOpen(true);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // A click elsewhere closes it.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [open]);

  const close = () => {
    setOpen(false);
    inputRef.current?.blur();
  };

  const add = (sg: Suggestion) => {
    if (sg.error) return;
    setHighlights((hs) => {
      const same = hs.find((h) => h.label === sg.label && h.group === sg.group);
      if (same) return hs.map((h) => (h === same ? { ...h, on: true } : h));
      return [...hs, { id: nextId++, label: sg.label, group: sg.group, query: sg.query, color: nextColor(hs), on: true }];
    });
    setQuery("");
    setActive(0);
    close();
  };

  const step = (h: Highlight) => {
    const hits = [...(matched.get(h.id) ?? [])].filter((r) => r.pos);
    if (!hits.length) return;
    if (local) {
      const d = (r: AnyRow) => Math.hypot(r.pos![0] - local[0], r.pos![2] - local[2]);
      hits.sort((a, b) => d(a) - d(b));
    }
    const i = (steps.current.get(h.id) ?? -1) + 1;
    steps.current.set(h.id, i % hits.length);
    onShow(hits[i % hits.length]!.sel);
  };

  const toggle = (id: number) => setHighlights((hs) => hs.map((h) => (h.id === id ? { ...h, on: !h.on } : h)));
  const remove = (id: number) => setHighlights((hs) => hs.filter((h) => h.id !== id));

  return (
    <div className={s.root} ref={rootRef}>
      <div className={s.bar}>
        <button
          type="button"
          className={s.open}
          aria-pressed={open}
          title="Highlight things on the map and in the list ( / )"
          onClick={() => {
            if (open) return close();
            setOpen(true);
          }}
        >
          <Highlighter size={18} />
        </button>
        {highlights.map((h) => {
          const n = matched.get(h.id)?.length ?? 0;
          return (
            <span key={h.id} className={s.pill} data-on={h.on} style={{ "--c": h.color } as React.CSSProperties}>
              <button type="button" className={s.pillLabel} title={`${h.group}: ${h.query}\n${h.on ? "Click to switch off" : "Off: click to switch on"}`} onClick={() => toggle(h.id)}>
                <span className={s.dot} />
                {h.label}
              </button>
              <button type="button" className={s.count} disabled={!n} title={n ? `Show the next one (${n} in all, nearest first)` : "Nothing matches right now"} onClick={() => step(h)}>
                {n}
              </button>
              <button type="button" className={s.pin} title="Pin for this raid (Filters view: edit it, or keep it for good)" onClick={() => onPin(h)}>
                <Pin size={11} />
              </button>
              <button type="button" className={s.remove} title="Remove" onClick={() => remove(h.id)}>
                <X size={12} />
              </button>
            </span>
          );
        })}
        {highlights.length > 1 && (
          <button type="button" className={s.clearAll} title="Remove all highlights" onClick={() => setHighlights(() => [])}>
            clear
          </button>
        )}
      </div>
      {open && (
        <div className={s.panel}>
          <input
            ref={inputRef}
            className={s.input}
            placeholder="highlight: item, category, boss, ≥50k, is:item pen>=40…"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setActive(0);
            }}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.preventDefault();
                if (query) setQuery("");
                else close();
              } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                e.preventDefault();
                const n = suggestions.length;
                if (n) setActive((a) => (Math.min(a, n - 1) + (e.key === "ArrowDown" ? 1 : n - 1)) % n);
              } else if (e.key === "Enter" && current) {
                e.preventDefault();
                add(current);
              }
            }}
          />
          {suggestions.length > 0 && (
            <ul className={s.suggestions} role="listbox">
              {suggestions.map((sg, i) => (
                <li
                  key={`${sg.group}:${sg.label}:${i}`}
                  role="option"
                  aria-selected={sg === current}
                  data-empty={counts[i] === 0}
                  data-error={!!sg.error}
                  className={s.suggestion}
                  onPointerEnter={() => setActive(i)}
                  onClick={() => add(sg)}
                >
                  <span className={s.group}>{sg.group}</span>
                  <span className={s.label} title={sg.detail}>
                    {sg.label}
                    {sg.detail && <span className={s.detail}> {sg.detail}</span>}
                  </span>
                  <span className={s.n} title="In the raid now">{counts[i]}</span>
                </li>
              ))}
            </ul>
          )}
          {!query && (
            <div className={s.hint}>
              Highlights mark things on the map and in the list, and show them even where filters or categories would hide them.
              Queries work too: <code>is:boss</code> <code>item:LEDX</code> <code>cat:Electronics</code> <code>value&gt;=40k</code> <code>pen&gt;=40</code> <code>class&gt;=5</code> (Filters view: Query syntax).
            </div>
          )}
        </div>
      )}
    </div>
  );
}
