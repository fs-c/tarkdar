// A raid's event log (the Raids view's second level): the events, oldest at the top, with a marker at
// the shown moment (later events dimmed). Clicking an event jumps there and shows it on the map.
// The playback controls float over the map (PlaybackBar).

import { useVirtualizer } from "@tanstack/react-virtual";
import { ChevronLeft } from "lucide-react";
import { useEffect, useMemo, useRef } from "react";
import { DEFAULT_EVENT_GROUPS, EVENT_GROUPS, type EventGroup, describeEvent, eventConcerns, eventGroup } from "../events";
import { usePersistentState } from "../hooks";
import type { ItemCatalog } from "../items";
import { type Selection, selectionKey } from "../pick";
import { type Playback, formatDuration } from "../playback";
import type { Timeline, TimelineEvent } from "../timeline";
import { Button, Chip, cx, Note, selectableRow } from "../ui";
import s from "./TimelinePanel.module.css";

const ROW_HEIGHT = 22;

// ---- panel -------------------------------------------------------------------------------------------

interface Props {
  timeline: Timeline | null;
  range: [number, number] | null;
  /** The live raid (else a recording). */
  live: boolean;
  /** "Current raid" or the recording's map, and a second line (map, date). */
  title: string;
  subtitle: string;
  /** Back to the list of raids. */
  onBack: () => void;
  /** Still loading the live raid so far. */
  loading: boolean;
  playback: Playback;
  catalog: ItemCatalog;
  selection: Selection | null;
  onPick: (e: TimelineEvent) => void;
}

interface Prefs {
  groups: Record<EventGroup, boolean>;
  selectedOnly: boolean;
}

type Row = { kind: "event"; e: TimelineEvent } | { kind: "now" };

export function TimelinePanel(props: Props) {
  const { timeline, range, live, title, subtitle, onBack, loading, playback, catalog, selection, onPick } = props;
  const [prefs, setPrefs] = usePersistentState<Prefs>("radar.log", { groups: DEFAULT_EVENT_GROUPS, selectedOnly: false });
  const groups = { ...DEFAULT_EVENT_GROUPS, ...prefs.groups };
  const at = playback.cursor ?? range?.[1] ?? null;
  const count = timeline?.events.length ?? 0;

  // Matching events, oldest first.
  const events = useMemo(() => {
    if (!timeline) return [];
    return timeline.events.filter(
      (e) => groups[eventGroup(e.kind)] && (!prefs.selectedOnly || (selection !== null && eventConcerns(e, selection))),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps -- events only grow (count)
  }, [timeline, count, JSON.stringify(groups), prefs.selectedOnly, selection]);

  // The "now" marker goes after the last event at or before the shown moment.
  const nowIndex = useMemo(() => {
    if (at === null) return events.length;
    let lo = 0, hi = events.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (events[mid]!.t <= at) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }, [events, at]);
  const rowAt = (i: number): Row => (i === nowIndex ? { kind: "now" } : { kind: "event", e: events[i < nowIndex ? i : i - 1]! });

  const scrollRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: events.length + 1,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 12,
  });

  // Keep the marker in view while it's in view: scrolling away stops that, until the next seek
  // (from the map's playback controls, or an event here). That effect goes first: it's read below.
  const follow = useRef(true);
  const programmatic = useRef(false);
  useEffect(() => {
    follow.current = true;
  }, [playback.seeks]);
  useEffect(() => {
    if (!follow.current) return;
    programmatic.current = true;
    virtualizer.scrollToIndex(nowIndex, { align: "center" });
  }, [nowIndex, virtualizer]);
  const onScroll = () => {
    if (programmatic.current) {
      programmatic.current = false;
      return;
    }
    const items = virtualizer.getVirtualItems();
    follow.current = items.some((v) => v.index === nowIndex);
  };

  const back = (
    <div className={s.back}>
      <Button variant="icon" title="All raids" onClick={onBack}>
        <ChevronLeft size={16} />
      </Button>
      <div className={s.titles}>
        <span>{title}</span>
        <small className="muted ellipsis">{subtitle}</small>
      </div>
    </div>
  );

  if (!timeline || !range) {
    return (
      <div className={s.timeline}>
        {back}
        <Note>No raid right now. Raids are recorded while the backend reads the game.</Note>
      </div>
    );
  }

  const atLive = live && playback.cursor === null;
  const toggleGroup = (g: EventGroup) => setPrefs((p) => ({ ...p, groups: { ...groups, [g]: !groups[g] } }));
  const selectedKey = selection && selectionKey(selection);

  return (
    <div className={s.timeline}>
      {back}
      {loading && <Note>Loading the raid so far…</Note>}
      <div className={s.filters}>
        {(Object.keys(EVENT_GROUPS) as EventGroup[]).map((g) => (
          <Chip key={g} on={groups[g]} onClick={() => toggleGroup(g)}>
            {EVENT_GROUPS[g].label}
          </Chip>
        ))}
        <Chip
          on={prefs.selectedOnly}
          title="Only events about the selected player, item or exfil"
          onClick={() => setPrefs((p) => ({ ...p, selectedOnly: !p.selectedOnly }))}
        >
          Selected only
        </Chip>
      </div>
      <div className={s.body}>
        <div ref={scrollRef} className={s.scroll} onScroll={onScroll}>
          <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
            {virtualizer.getVirtualItems().map((v) => {
              const row = rowAt(v.index);
              const style = { transform: `translateY(${v.start}px)`, height: ROW_HEIGHT };
              if (row.kind === "now")
                return (
                  <div key="now" className={s.marker} style={style}>
                    <span className={s.time}>{at !== null ? formatDuration(at - range[0]) : ""}</span>
                    <span className={s.markerLine} />
                    <span className={s.markerLabel}>{atLive ? "now" : "shown"}</span>
                  </div>
                );
              const e = row.e;
              const d = describeEvent(e, timeline, catalog);
              return (
                <button
                  key={v.key}
                  type="button"
                  className={cx(s.event, selectableRow)}
                  data-tone={d.tone}
                  data-future={v.index > nowIndex}
                  data-selected={selectedKey === selectionKey(d.sel)}
                  style={style}
                  title={d.text}
                  onClick={() => {
                    follow.current = true;
                    onPick(e);
                  }}
                >
                  <span className={s.time}>{formatDuration(e.t - range[0])}</span>
                  <span className={s.dot} />
                  <span className={s.text}>{d.text}</span>
                </button>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
