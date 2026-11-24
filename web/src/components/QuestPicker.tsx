// The quest picker: a pop-out next to the sidebar, from the Watch view ("Track a quest", "Review").
// Quests that still need items, by trader (and Story, Repeatable, Imported), with a search over all of
// them; new ones (started since last seen) on a tab of their own. The star tracks a quest: a watch
// entry for what it still needs. Each quest lists its first few objectives; more on demand.

import { Search, Star, X } from "lucide-react";
import { useState } from "react";
import { cx } from "../ui";
import { type QuestEntry, itemsLeft } from "../watch/quests";
import f from "./Floating.module.css";
import v from "./views.module.css";
import s from "./QuestPicker.module.css";

interface Props {
  quests: readonly QuestEntry[];
  newIds: ReadonlySet<string>;
  /** Quest id → tracked. */
  tracked: ReadonlySet<string>;
  /** The tab to start on (New, while there are new quests). */
  startTab: string | null;
  onTrack: (q: QuestEntry) => void;
  onUntrack: (q: QuestEntry) => void;
  onDismiss: (id: string) => void;
  onClose: () => void;
}

const SHOWN = 3;
const TAB_ORDER = ["Prapor", "Therapist", "Fence", "Skier", "Peacekeeper", "Mechanic", "Ragman", "Jaeger", "Ref", "Lightkeeper", "BTR Driver", "Other", "Story", "Repeatable", "Imported"];

export function QuestPicker({ quests, newIds, tracked, startTab, onTrack, onUntrack, onDismiss, onClose }: Props) {
  const [term, setTerm] = useState("");
  const [tab, setTab] = useState<string | null>(startTab);
  const [more, setMore] = useState<string | null>(null);

  const t = term.trim().toLowerCase();
  const tabs = [...(newIds.size ? ["New"] : []), ...TAB_ORDER.filter((x) => quests.some((q) => q.tab === x)), ...[...new Set(quests.map((q) => q.tab))].filter((x) => !TAB_ORDER.includes(x))];
  const inTab = (q: QuestEntry, x: string) => (x === "New" ? newIds.has(q.id) : q.tab === x);
  const current = t ? null : tab && tabs.includes(tab) ? tab : (tabs[0] ?? null);
  const list = quests
    .filter((q) => (t ? q.name.toLowerCase().includes(t) : current !== null && inTab(q, current)))
    .sort((a, b) => Number(tracked.has(b.id)) - Number(tracked.has(a.id)) || a.name.localeCompare(b.name));

  return (
    <div className={cx(f.flyout, f.card, s.picker)}>
      <header className={s.head}>
        <span>Quests</span>
        <button type="button" className={s.icon} title="Close" onClick={onClose}>
          <X size={15} />
        </button>
      </header>
      <label className={v.find}>
        <Search size={14} />
        <input autoFocus placeholder="Search quests" value={term} onChange={(e) => setTerm(e.target.value)} onKeyDown={(e) => e.key === "Escape" && (term ? setTerm("") : onClose())} />
      </label>
      {!t && (
        <div className={s.tabs}>
          {tabs.map((x) => (
            <button key={x} type="button" className={s.tab} aria-pressed={x === current} onClick={() => setTab(x)}>
              {x}
              <span className={s.tabN}>{quests.filter((q) => inTab(q, x)).length}</span>
            </button>
          ))}
        </div>
      )}
      <div className={s.list}>
        {list.map((q) => {
          const on = tracked.has(q.id);
          const isNew = newIds.has(q.id);
          const allFir = q.open.every((o) => o.fir);
          const left = itemsLeft(q);
          const objectives = more === q.id ? q.open : q.open.slice(0, SHOWN);
          return (
            <div key={q.id}>
              <div className={s.quest} title={on ? "Tracked: what it still needs is watched (click: stop)" : "Track: watch what it still needs"} onClick={() => (on ? onUntrack(q) : onTrack(q))}>
                <span className={s.star} data-on={on}>
                  <Star size={15} fill={on ? "currentColor" : "none"} />
                </span>
                <span className={s.name}>
                  {q.name}
                  {isNew && <span className={s.new}>new</span>}
                  {(t || current === "New") && <span className={s.where}> · {q.tab}</span>}
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
        })}
        {!list.length && <p className={v.empty}>{quests.length ? "No quests here" : "No started quest needs items (or the quests weren't read: not in a raid)."}</p>}
      </div>
    </div>
  );
}
