// The quest browser: the Watch view's second level ("Track a quest", "Review"), like a raid's timeline
// is the Raids view's. Quests that still need items, by trader (and Story, Repeatable, Imported), each
// a group to unfold, with a search over all of them; new ones (started since last seen) in a group of
// their own on top. The star tracks a quest: a watch entry for what it still needs. Each quest lists
// its first few objectives; more on demand. Opened at a quest (from the watch bar), it unfolds that
// quest's group, scrolls to it with all its objectives, and marks it for a moment.

import { ChevronDown, ChevronLeft, Search, Star, X } from "lucide-react";
import { useLayoutEffect, useRef, useState } from "react";
import { Button, PanelBody } from "../ui";
import { type QuestEntry, itemsLeft } from "../watch/quests";
import v from "./views.module.css";
import s from "./QuestBrowser.module.css";

/** The browser, opened: at a quest (or not), the nth time (opening it at the same quest again shows it again). */
export interface QuestBrowse {
  focus: string | null;
  n: number;
}

interface Props {
  focus: QuestBrowse;
  quests: readonly QuestEntry[];
  newIds: ReadonlySet<string>;
  /** Quest id → tracked. */
  tracked: ReadonlySet<string>;
  onTrack: (q: QuestEntry) => void;
  onUntrack: (q: QuestEntry) => void;
  onDismiss: (id: string) => void;
  onBack: () => void;
}

const SHOWN = 3;
const NEW = "New";
const GROUP_ORDER = ["Prapor", "Therapist", "Fence", "Skier", "Peacekeeper", "Mechanic", "Ragman", "Jaeger", "Ref", "Lightkeeper", "BTR Driver", "Other", "Story", "Repeatable", "Imported"];

export function QuestBrowser({ focus, quests, newIds, tracked, onTrack, onUntrack, onDismiss, onBack }: Props) {
  const [term, setTerm] = useState("");
  // Group → unfolded (New is, the rest aren't, until clicked).
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [more, setMore] = useState<string | null>(null);
  const [marked, setMarked] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const t = term.trim().toLowerCase();
  const groupOf = (q: QuestEntry) => (newIds.has(q.id) ? NEW : q.tab);

  // Opened at a quest: its group unfolds, all its objectives show, the search goes; then it's scrolled to.
  const [focused, setFocused] = useState<QuestBrowse | null>(null);
  if (focused !== focus) {
    setFocused(focus);
    const q = focus.focus ? quests.find((x) => x.id === focus.focus) : undefined;
    if (q) {
      setTerm("");
      setOpen((o) => ({ ...o, [groupOf(q)]: true }));
      setMore(q.id);
      setMarked(q.id);
    }
  }
  useLayoutEffect(() => {
    if (!marked) return;
    listRef.current?.querySelector(`[data-id="${CSS.escape(marked)}"]`)?.scrollIntoView({ block: "center" });
  }, [marked, focus]);
  const names = [...new Set(quests.map(groupOf))].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
  const groups = names
    .map((name) => ({
      name,
      all: quests.filter((q) => groupOf(q) === name),
      list: quests
        .filter((q) => groupOf(q) === name && (!t || q.name.toLowerCase().includes(t)))
        .sort((a, b) => Number(tracked.has(b.id)) - Number(tracked.has(a.id)) || a.name.localeCompare(b.name)),
    }))
    .filter((g) => g.list.length);
  const nTracked = quests.filter((q) => tracked.has(q.id)).length;

  const quest = (q: QuestEntry, where: boolean) => {
    const on = tracked.has(q.id);
    const isNew = newIds.has(q.id);
    const allFir = q.open.every((o) => o.fir);
    const left = itemsLeft(q);
    const objectives = more === q.id ? q.open : q.open.slice(0, SHOWN);
    return (
      <div key={q.id} data-id={q.id} className={s.item} data-marked={marked === q.id} onAnimationEnd={() => setMarked(null)}>
        <div className={s.quest} title={on ? "Tracked: what it still needs is watched (click: stop)" : "Track: watch what it still needs"} onClick={() => (on ? onUntrack(q) : onTrack(q))}>
          <span className={s.star} data-on={on}>
            <Star size={15} fill={on ? "currentColor" : "none"} />
          </span>
          <span className={s.name}>
            {q.name}
            {where && <span className={s.where}> · {q.tab}</span>}
          </span>
          <span className={s.meta}>
            {left} item{left === 1 ? "" : "s"}
            {allFir ? " · FIR" : ""}
          </span>
          {isNew ? (
            <button
              type="button"
              className={s.icon}
              title="Not now"
              onClick={(e) => {
                e.stopPropagation();
                onDismiss(q.id);
              }}
            >
              <X size={13} />
            </button>
          ) : (
            <span />
          )}
        </div>
        <div className={s.objectives}>
          {objectives.map((o, i) => (
            <div key={i}>
              {o.count > 1 ? `${o.count}× ` : ""}
              {o.what}
              {o.fir && !allFir && <span className={s.fir}>FIR</span>}
              {o.have > 0 && <span className={s.have}>have {o.have}</span>}
            </div>
          ))}
          {q.open.length > SHOWN && (
            <button type="button" className={s.more} onClick={() => setMore((m) => (m === q.id ? null : q.id))}>
              {more === q.id ? "Show less" : `${q.open.length - SHOWN} more`}
            </button>
          )}
        </div>
      </div>
    );
  };

  return (
    <>
      <div className={s.back}>
        <Button variant="icon" title="Back to the watchlist" onClick={onBack}>
          <ChevronLeft size={16} />
        </Button>
        <div className={s.titles}>
          <span>Track a quest</span>
          <small className="muted ellipsis">
            {quests.length} need items · {nTracked} tracked
          </small>
        </div>
      </div>
      <label className={v.find}>
        <Search size={14} />
        <input autoFocus placeholder="Search quests" value={term} onChange={(e) => setTerm(e.target.value)} onKeyDown={(e) => e.key === "Escape" && (term ? setTerm("") : onBack())} />
      </label>
      <PanelBody>
        <div ref={listRef} className={s.list}>
          {groups.map(({ name, all, list }) => {
            const folded = !t && !(open[name] ?? name === NEW);
            const on = all.filter((q) => tracked.has(q.id)).length;
            return (
              <div key={name}>
                <div className={v.group} data-folded={folded} onClick={() => setOpen((o) => ({ ...o, [name]: folded }))}>
                  <b>{name}</b>
                  <span className={v.count}>{t ? list.length : all.length}</span>
                  {on > 0 && <span className={s.on}>{on} tracked</span>}
                  <span className={v.grow} />
                  <span className={v.chev}>
                    <ChevronDown size={13} />
                  </span>
                </div>
                {!folded && list.map((q) => quest(q, name === NEW))}
              </div>
            );
          })}
          {!groups.length && <p className={v.empty}>{quests.length ? "No quest by that name" : "No started quest needs items (or the quests weren't read: not in a raid)."}</p>}
        </div>
      </PanelBody>
    </>
  );
}

/** A group's place: New first, then the traders, then the rest (unknown ones before Story). */
function rank(name: string): number {
  if (name === NEW) return -1;
  const i = GROUP_ORDER.indexOf(name);
  return i < 0 ? GROUP_ORDER.indexOf("Other") + 0.5 : i;
}
