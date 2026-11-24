// The Watch view: the watchlist (what the watch bar shows), each entry with its switch (the dot), its
// name and how many there are now, what it matches (the query, editable; for a tracked quest what it
// still needs), and its level. Clicking a row steps to the nearest match, then the next. Below, the
// tracked quests, with the new ones (started since they were last seen) to review, and the way to
// track one (the quest picker, next to the sidebar).

import { Pencil, Plus, X } from "lucide-react";
import { useState } from "react";
import type { WatchEntry } from "../watch/prefs";
import { type QuestEntry, needsLine } from "../watch/quests";
import { LevelPicker } from "./LevelPicker";
import v from "./views.module.css";
import s from "./WatchView.module.css";

interface Props {
  entries: readonly WatchEntry[];
  /** Entry id → how many it has on the map now. */
  counts: ReadonlyMap<string, number>;
  /** Quest id → the quest (tracked ones show what they still need). */
  quests: ReadonlyMap<string, QuestEntry>;
  /** Started since last seen, not tracked or dismissed. */
  newQuests: readonly QuestEntry[];
  pickerOpen: boolean;
  onStep: (e: WatchEntry) => void;
  onChange: (id: string, patch: Partial<WatchEntry>) => void;
  onRemove: (id: string) => void;
  /** Watch something: the watch bar's field. */
  onWatchSomething: () => void;
  /** Open (or close) the quest picker; "new": on its New tab. */
  onPicker: (tab?: "new") => void;
  onDismissNew: () => void;
}

export function WatchView({ entries, counts, quests, newQuests, pickerOpen, onStep, onChange, onRemove, onWatchSomething, onPicker, onDismissNew }: Props) {
  const [editing, setEditing] = useState<string | null>(null);
  const items = entries.filter((e) => !e.questId);
  const tracked = entries.filter((e) => e.questId);

  const row = (e: WatchEntry) => {
    const n = counts.get(e.id) ?? 0;
    const q = e.questId ? quests.get(e.questId) : undefined;
    return (
      <div key={e.id} className={s.entry} data-on={e.on} title={n ? "Show the nearest, then the next" : "None right now"} onClick={() => onStep(e)}>
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
          <span className={s.label}>{e.label}</span> <span className={s.n}>×{n}</span>
          {editing === e.id ? (
            <input
              autoFocus
              className={s.query}
              defaultValue={e.query}
              onClick={(ev) => ev.stopPropagation()}
              onBlur={(ev) => {
                if (ev.target.value.trim()) onChange(e.id, { query: ev.target.value.trim() });
                setEditing(null);
              }}
              onKeyDown={(ev) => {
                if (ev.key === "Enter") ev.currentTarget.blur();
                if (ev.key === "Escape") setEditing(null);
              }}
            />
          ) : (
            <span className={s.what} data-mono={!e.questId}>
              {e.questId ? (q ? needsLine(q) : "nothing left to find, or not in this raid's quests") : e.query}
            </span>
          )}
        </span>
        <span className={s.hover}>
          {!e.questId && (
            <button
              type="button"
              className={s.icon}
              title="Edit the query"
              onClick={(ev) => {
                ev.stopPropagation();
                setEditing(e.id);
              }}
            >
              <Pencil size={13} />
            </button>
          )}
          <button
            type="button"
            className={s.icon}
            title={e.questId ? "Stop tracking" : "Remove"}
            onClick={(ev) => {
              ev.stopPropagation();
              onRemove(e.id);
            }}
          >
            <X size={14} />
          </button>
        </span>
        <LevelPicker level={e.level} color={e.on ? e.color : "#8a96a0"} label={e.label} onChange={(level) => onChange(e.id, { level })} />
      </div>
    );
  };

  return (
    <div className={s.view}>
      {items.map(row)}
      <button type="button" className={s.add} onClick={onWatchSomething}>
        <Plus size={14} />
        <span>Watch something</span>
        <kbd>/</kbd>
      </button>
      <div className={v.group} data-static="true">
        <b>Quests</b>
        <span className={v.count}>{tracked.length}</span>
      </div>
      {newQuests.length > 0 && (
        <div className={s.callout}>
          <span className={s.calloutText}>
            <span className={s.calloutTitle}>
              {newQuests.length} new quest{newQuests.length > 1 ? "s" : ""} need items
            </span>
            <span className={s.what}>{newQuests.map((q) => q.name).join(", ")}</span>
          </span>
          <button type="button" className={s.review} onClick={() => onPicker("new")}>
            Review
          </button>
          <button type="button" className={s.icon} title="Not now" onClick={onDismissNew}>
            <X size={14} />
          </button>
        </div>
      )}
      {tracked.map(row)}
      <button type="button" className={s.add} aria-pressed={pickerOpen} onClick={() => onPicker()}>
        <Plus size={14} />
        <span>Track a quest</span>
      </button>
    </div>
  );
}
