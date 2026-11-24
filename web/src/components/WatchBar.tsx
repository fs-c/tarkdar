// The watch bar (top left of the map, or /): the watchlist as it shows on the map, and the way to add
// to it. A search field with the entries as chips in front of it: each its level and colour, name and
// how many there are now; clicking one opens its menu under it (level, on/off, show the nearest,
// remove). What doesn't fit goes behind "+N", the least important first (off, then by level, then
// the oldest). Focusing the field opens what's under it: while typing, what the text could mean
// (Enter watches it, at High); otherwise every entry, with its switch, level and remove.

import { Crosshair, ScrollText, Search, Trash2, X } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ItemCatalog } from "../model/items";
import { matchingRows } from "../highlight/match";
import { type Suggestion, suggest } from "../highlight/suggest";
import type { AnyRow } from "../list/rows";
import { useDismiss, useHotkeys } from "../ui";
import { LEVEL_TEXT, levelRank } from "../watch/levels";
import type { WatchEntry } from "../watch/prefs";
import { LevelGlyph, LevelPicker } from "./LevelPicker";
import f from "./Floating.module.css";
import s from "./WatchBar.module.css";

/** A quest that can be tracked from the search. */
export interface QuestChoice {
  id: string;
  name: string;
  /** "Therapist", "story" */
  detail: string;
  /** What tracking it watches. */
  query: string;
}

/** What the search can add: a suggestion (a query), or a quest to track. */
type Choice = { kind: "query"; sg: Suggestion } | { kind: "quest"; quest: QuestChoice };

interface Props {
  entries: readonly WatchEntry[];
  /** Entry id → what it has on the map now. */
  hits: ReadonlyMap<string, AnyRow[]>;
  /** Everything there is (the suggestions' counts). */
  rows: readonly AnyRow[];
  catalog: ItemCatalog;
  /** Quests that need items (and whether each is tracked): "Track" from the search. */
  quests: readonly QuestChoice[];
  onAdd: (sg: Suggestion) => void;
  onTrack: (quest: QuestChoice) => void;
  onChange: (id: string, patch: Partial<WatchEntry>) => void;
  onRemove: (id: string) => void;
  /** The query to preview on the map while searching (null: none). */
  onPreview: (query: string | null) => void;
  /** Show the entry's nearest match, then the next. */
  onStep: (e: WatchEntry) => void;
  /** Open the Watch view. */
  onOpenView: () => void;
}

/** Least important first: off ones, then by level, then the oldest. */
const byUnimportance = (entries: readonly WatchEntry[]) =>
  entries.map((e, i) => ({ e, i })).sort((a, b) => Number(a.e.on) - Number(b.e.on) || levelRank(a.e.level) - levelRank(b.e.level) || a.i - b.i).map((x) => x.e);

export function WatchBar({ entries, hits, rows, catalog, quests, onAdd, onTrack, onChange, onRemove, onPreview, onStep: step, onOpenView }: Props) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const barRef = useRef<HTMLDivElement>(null);
  /** The chip whose menu is open, and where (from the left of the bar). */
  const [menu, setMenu] = useState<{ id: string; left: number } | null>(null);

  // ---- what the text could mean ----
  const choices = useMemo((): Choice[] => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    const out: Choice[] = suggest(query, catalog).map((sg) => ({ kind: "query", sg }));
    const qs = quests.filter((x) => x.name.toLowerCase().includes(q)).slice(0, 4);
    // Quests after the free text and the presets, before single items.
    const at = out.findIndex((c) => c.kind === "query" && (c.sg.group === "Category" || c.sg.group === "Item"));
    out.splice(at < 0 ? out.length : at, 0, ...qs.map((quest): Choice => ({ kind: "quest", quest })));
    return out;
  }, [query, catalog, quests]);
  const counts = useMemo(() => choices.map((c) => (c.kind === "query" ? matchingRows(rows, c.sg.query, catalog).length : null)), [choices, rows, catalog]);
  const current = open ? choices[Math.min(active, choices.length - 1)] : undefined;
  const previewQuery = current?.kind === "query" && !current.sg.error ? current.sg.query : current?.kind === "quest" ? current.quest.query : null;

  useEffect(() => onPreview(previewQuery), [previewQuery]);
  useEffect(() => () => onPreview(null), []);

  useHotkeys([
    {
      key: "/",
      repeat: true,
      description: "Watch something",
      handler: (e) => {
        e.preventDefault();
        inputRef.current?.focus();
      },
    },
  ]);

  // A click elsewhere closes what's under the bar.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [open]);
  useDismiss(rootRef, !!menu, () => setMenu(null));

  const toggleMenu = (e: WatchEntry, chip: HTMLElement) => {
    if (menu?.id === e.id) return setMenu(null);
    const bar = barRef.current!.getBoundingClientRect();
    setOpen(false);
    setQuery("");
    setMenu({ id: e.id, left: chip.getBoundingClientRect().left - bar.left });
  };

  const close = () => {
    setOpen(false);
    setQuery("");
    inputRef.current?.blur();
  };

  const pick = (c: Choice) => {
    if (c.kind === "query") {
      if (c.sg.error) return;
      onAdd(c.sg);
    } else onTrack(c.quest);
    setQuery("");
    setActive(0);
    close();
  };

  // ---- fitting: the least important entries go behind "+N" until the bar fits ----
  const [hidden, setHidden] = useState<readonly string[]>([]);
  const [width, setWidth] = useState(0);
  const fitKey = `${entries.map((e) => `${e.id}:${e.on}:${e.level}:${e.label}`).join("|")}/${width}/${open}`;
  useLayoutEffect(() => setHidden([]), [fitKey]);
  useLayoutEffect(() => {
    const bar = barRef.current;
    if (!bar || bar.scrollWidth <= bar.clientWidth + 1) return;
    const next = byUnimportance(entries).find((e) => !hidden.includes(e.id));
    if (next) setHidden((h) => [...h, next.id]);
  });
  useEffect(() => {
    const el = rootRef.current?.parentElement;
    if (!el) return;
    const observer = new ResizeObserver(() => setWidth(el.clientWidth));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const shown = entries.filter((e) => !hidden.includes(e.id));
  const behind = entries.filter((e) => hidden.includes(e.id));
  const n = (e: WatchEntry) => hits.get(e.id)?.length ?? 0;
  // Its chip went behind "+N" or the entry is gone: so is its menu.
  const menuEntry = menu ? shown.find((e) => e.id === menu.id) : undefined;

  return (
    <div className={f.topLeft} ref={rootRef}>
      <div className={s.wrap}>
        <div ref={barRef} className={f.surface + " " + s.bar} data-open={open} onClick={(e) => e.target === e.currentTarget && inputRef.current?.focus()}>
          {shown.map((e) => (
            <button
              key={e.id}
              type="button"
              className={s.chip}
              data-on={e.on}
              aria-expanded={menu?.id === e.id}
              title={`${e.label}: ${LEVEL_TEXT[e.level]}${e.on ? "" : " (off)"}, ${n(e) || "none"} now`}
              onClick={(ev) => toggleMenu(e, ev.currentTarget)}
            >
              <LevelGlyph level={e.level} color={e.on ? e.color : "#56626b"} />
              {e.questId && <ScrollText size={11} className={s.questIcon} />}
              {e.label}
              <span className={s.n}>{n(e)}</span>
            </button>
          ))}
          {behind.length > 0 && (
            <button
              type="button"
              className={s.chip + " " + s.more}
              title={behind.map((e) => e.label).join(", ")}
              onClick={() => {
                setOpen((o) => !o || !!query);
                setQuery("");
                inputRef.current?.focus();
              }}
            >
              <span className={s.dots}>
                {behind.slice(0, 4).map((e) => (
                  <i key={e.id} style={{ background: e.on ? e.color : "transparent", boxShadow: `inset 0 0 0 1.5px ${e.color}` }} />
                ))}
              </span>
              +{behind.length}
            </button>
          )}
          <Search size={16} className={s.icon} />
          <input
            ref={inputRef}
            className={s.input}
            placeholder={entries.length ? "Watch more" : "Watch something"}
            value={query}
            onFocus={() => {
              setMenu(null);
              setOpen(true);
            }}
            onChange={(e) => {
              setQuery(e.target.value);
              setActive(0);
              setOpen(true);
            }}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.preventDefault();
                if (query) setQuery("");
                else close();
              } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                e.preventDefault();
                const len = choices.length;
                if (len) setActive((a) => (Math.min(a, len - 1) + (e.key === "ArrowDown" ? 1 : len - 1)) % len);
              } else if (e.key === "Enter" && current) {
                e.preventDefault();
                pick(current);
              }
            }}
          />
          {/* Kept while open (only hidden), so the bar doesn't change size. */}
          <kbd className={s.kbd} data-hidden={open}>
            /
          </kbd>
        </div>
        {menuEntry && (
          <div key={menuEntry.id} className={f.card + " " + s.menu + " " + s.pop} style={{ left: menu!.left }} data-on={menuEntry.on}>
            <div className={s.menuHead}>
              <button
                type="button"
                className={s.switch}
                style={{ "--c": menuEntry.color } as React.CSSProperties}
                title={menuEntry.on ? "On: click to switch off" : "Off: click to switch on"}
                onClick={() => onChange(menuEntry.id, { on: !menuEntry.on })}
              />
              <span className={s.name}>
                {menuEntry.questId && <ScrollText size={11} className={s.questIcon} />} <span className={s.entryLabel}>{menuEntry.label}</span>{" "}
                <span className={s.times}>×{n(menuEntry)}</span>
              </span>
            </div>
            <div className={s.menuRow}>
              <LevelPicker
                level={menuEntry.level}
                color={menuEntry.on ? menuEntry.color : "#8a96a0"}
                label={menuEntry.label}
                onChange={(level) => onChange(menuEntry.id, { level })}
              />
              <span className={s.levelText}>{LEVEL_TEXT[menuEntry.level]}</span>
            </div>
            <div className={s.menuActions}>
              <button type="button" className={s.action} disabled={!n(menuEntry)} title="Show the nearest, then the next" onClick={() => step(menuEntry)}>
                <Crosshair size={13} /> Show nearest
              </button>
              <button
                type="button"
                className={s.action + " " + s.danger}
                onClick={() => {
                  setMenu(null);
                  onRemove(menuEntry.id);
                }}
              >
                <Trash2 size={13} /> {menuEntry.questId ? "Stop tracking" : "Remove"}
              </button>
            </div>
          </div>
        )}
        {open && (
          <div className={f.card + " " + s.drop + " " + s.pop}>
            {query.trim() ? (
              <ul className={s.suggestions} role="listbox">
                {choices.map((c, i) => (
                  <li
                    key={c.kind === "query" ? `${c.sg.group}:${c.sg.label}:${i}` : `quest:${c.quest.id}`}
                    role="option"
                    aria-selected={c === current}
                    data-error={c.kind === "query" && !!c.sg.error}
                    className={s.suggestion}
                    onPointerEnter={() => setActive(i)}
                    onClick={() => pick(c)}
                  >
                    <span className={s.group}>{c.kind === "query" ? c.sg.group : "Quest"}</span>
                    <span className={s.label} title={c.kind === "query" ? c.sg.detail : c.quest.detail}>
                      {c.kind === "query" ? c.sg.label : c.quest.name}
                      {(c.kind === "query" ? c.sg.detail : c.quest.detail) && <span className={s.detail}> {c.kind === "query" ? c.sg.detail : c.quest.detail}</span>}
                    </span>
                    <span className={s.count}>{c.kind === "query" ? counts[i] : "track"}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <>
                {entries.map((e) => (
                  <div key={e.id} className={s.entry} data-on={e.on} title={n(e) ? "Show the nearest, then the next" : "None right now"} onClick={() => step(e)}>
                    <button
                      type="button"
                      className={s.switch}
                      style={{ "--c": e.color } as React.CSSProperties}
                      title={e.on ? "On: click to switch off" : "Off: click to switch on"}
                      onClick={(ev) => {
                        ev.stopPropagation();
                        onChange(e.id, { on: !e.on });
                      }}
                    />
                    <span className={s.name}>
                      {e.questId && <ScrollText size={11} className={s.questIcon} />} <span className={s.entryLabel}>{e.label}</span> <span className={s.times}>×{n(e)}</span>
                    </span>
                    <button
                      type="button"
                      className={s.remove}
                      title={e.questId ? "Stop tracking" : "Remove"}
                      onClick={(ev) => {
                        ev.stopPropagation();
                        onRemove(e.id);
                      }}
                    >
                      <X size={13} />
                    </button>
                    <LevelPicker level={e.level} color={e.on ? e.color : "#8a96a0"} label={e.label} onChange={(level) => onChange(e.id, { level })} />
                  </div>
                ))}
                {!entries.length && <p className={s.hint}>Type an item, a category, a quest, 100k or a kind of player. Enter watches it.</p>}
                <div className={s.foot}>
                  <span>Type to watch more</span>
                  <span className={s.grow} />
                  <button
                    type="button"
                    className={s.link}
                    onClick={() => {
                      close();
                      onOpenView();
                    }}
                  >
                    Watch view
                  </button>
                </div>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
