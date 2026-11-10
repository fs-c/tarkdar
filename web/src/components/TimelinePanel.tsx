// A raid's timeline (the Raids view's second level): the playback controls, a vertical scrubber
// rail and the events, oldest at the top, with a marker at the shown moment (later events dimmed).
// Clicking an event jumps there and shows it on the map. The status bar carries an indicator that
// opens it; while replaying a recording, that indicator turns into a replay banner with an exit.

import { useVirtualizer } from "@tanstack/react-virtual";
import { ChevronLeft, History, Pause, Play, Radio, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { DEFAULT_EVENT_GROUPS, EVENT_GROUPS, type EventGroup, describeEvent, eventConcerns, eventGroup } from "../events";
import { usePersistentState } from "../hooks";
import type { ItemCatalog } from "../items";
import { type Selection, selectionKey } from "../pick";
import { type Playback, SPEEDS, formatDuration } from "../playback";
import type { Timeline, TimelineEvent } from "../timeline";
import { Button, Chip, cx, Note, Segmented, selectableRow } from "../ui";
import { StatusButton } from "./StatusBar";
import s from "./TimelinePanel.module.css";

const ROW_HEIGHT = 22;

/** The shown moment as text: raid time when live, how far behind live, or position / length. */
function timeLabel(range: [number, number], cursor: number | null, live: boolean): string {
  const [from, to] = range;
  if (!live) return `${formatDuration((cursor ?? from) - from)} / ${formatDuration(to - from)}`;
  return cursor === null ? formatDuration(to - from) : `−${formatDuration(to - cursor)}`;
}

// ---- status bar indicator --------------------------------------------------------------------------

interface IndicatorProps {
  range: [number, number];
  playback: Playback;
  /** Replaying a recording: its name ("Customs · 10 Nov 19:03"); null for the live raid. */
  replay: string | null;
  open: boolean;
  onClick: () => void;
  onExitReplay: () => void;
}

export function TimelineIndicator({ range, playback, replay, open, onClick, onExitReplay }: IndicatorProps) {
  const live = replay === null;
  const atLive = live && playback.cursor === null;
  const Icon = live ? Radio : History;
  return (
    <>
      <StatusButton
        className={s.indicator}
        data-mode={live ? (atLive ? "live" : "behind") : "replay"}
        data-open={open}
        title={live ? (atLive ? "Live, recording: open the timeline" : "Behind live: open the timeline") : "Replaying a recording: open its timeline"}
        onClick={onClick}
      >
        <Icon size={13} />
        {!live && <span className={s.tag}>replay · {replay}</span>}
        <span className={s.clock}>{timeLabel(range, playback.cursor, live)}</span>
        {playback.playing && <span className={s.speed}>▶ {playback.speed}×</span>}
      </StatusButton>
      {!live && (
        <StatusButton className={s.exitReplay} title="Stop replaying, back to the live raid" onClick={onExitReplay}>
          <X size={13} /> Exit replay
        </StatusButton>
      )}
    </>
  );
}

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
  /** Recordings: stop replaying (back to live). */
  onExitReplay: () => void;
}

interface Prefs {
  groups: Record<EventGroup, boolean>;
  selectedOnly: boolean;
}

type Row = { kind: "event"; e: TimelineEvent } | { kind: "now" };

export function TimelinePanel(props: Props) {
  const { timeline, range, live, title, subtitle, onBack, loading, playback, catalog, selection, onPick, onExitReplay } = props;
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

  // Keep the marker in view while it's in view: scrolling away stops that, until the next seek.
  const follow = useRef(true);
  const programmatic = useRef(false);
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
  const seek = (t: number | null) => {
    follow.current = true;
    playback.seek(t);
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
      <div className={s.head}>
        <Button
          className={s.play}
          disabled={atLive}
          title={playback.playing ? "Pause (space)" : atLive ? "Live: go back in time to replay" : "Play (space)"}
          onClick={playback.toggle}
        >
          {playback.playing ? <Pause size={16} /> : <Play size={16} />}
        </Button>
        <div className={s.now}>
          <span className={s.nowTime}>{timeLabel(range, playback.cursor, live)}</span>
          <small className="muted ellipsis">
            {live ? (atLive ? "live" : "behind live") : "replay"}
            {loading && " · loading the raid so far…"}
          </small>
        </div>
        {live ? (
          <Button className={s.toLive} disabled={atLive} title="Back to live" onClick={() => seek(null)}>
            <Radio size={14} /> Live
          </Button>
        ) : (
          <Button className={s.exit} title="Stop replaying, back to the live raid" onClick={onExitReplay}>
            <X size={14} /> Exit replay
          </Button>
        )}
      </div>
      <div className={s.controls}>
        <Segmented
          className={s.speeds}
          label="Playback speed"
          options={SPEEDS.map((v) => ({ value: v, label: `${v}×` }))}
          value={playback.speed}
          onChange={playback.setSpeed}
        />
        <span className={cx("muted", s.hint)}>space play · [ ] ±10 s</span>
      </div>
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
        <Rail range={range} at={at ?? range[1]} live={live} events={timeline.events} selection={selection} onSeek={seek} />
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

// ---- vertical scrubber -----------------------------------------------------------------------------

interface RailProps {
  range: [number, number];
  at: number;
  live: boolean;
  events: TimelineEvent[];
  selection: Selection | null;
  onSeek: (t: number | null) => void;
}

/** The whole raid top to bottom: drag to move in time. Ticks: deaths, players leaving, and the selected thing's events. */
function Rail({ range, at, live, events, selection, onSeek }: RailProps) {
  const [from, to] = range;
  const span = Math.max(1, to - from);
  const frac = (t: number) => Math.min(1, Math.max(0, (t - from) / span));
  const ref = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  const [hover, setHover] = useState<number | null>(null);

  const timeAt = (clientY: number) => {
    const r = ref.current!.getBoundingClientRect();
    return from + Math.min(1, Math.max(0, (clientY - r.top) / r.height)) * span;
  };
  const seekTo = (clientY: number) => {
    const t = timeAt(clientY);
    onSeek(live && t >= to - span * 0.005 ? null : t);
  };
  const ticks = events.filter(
    (e) => e.kind === "died" || e.kind === "left" || (selection !== null && eventConcerns(e, selection)),
  );

  return (
    <div
      ref={ref}
      className={s.rail}
      onPointerDown={(e) => {
        dragging.current = true;
        e.currentTarget.setPointerCapture(e.pointerId);
        seekTo(e.clientY);
      }}
      onPointerMove={(e) => {
        setHover(timeAt(e.clientY));
        if (dragging.current) seekTo(e.clientY);
      }}
      onPointerUp={() => (dragging.current = false)}
      onPointerCancel={() => (dragging.current = false)}
      onPointerLeave={() => setHover(null)}
    >
      <div className={s.track}>
        <div className={s.fill} style={{ height: `${frac(at) * 100}%` }} />
      </div>
      {ticks.map((e, i) => (
        <span
          key={i}
          className={s.tick}
          data-kind={e.kind}
          data-selected={selection !== null && eventConcerns(e, selection)}
          style={{ top: `${frac(e.t) * 100}%` }}
        />
      ))}
      <span className={s.thumb} style={{ top: `${frac(at) * 100}%` }} />
      {hover !== null && (
        <span className={s.hover} style={{ top: `${frac(hover) * 100}%` }}>
          {live ? (hover >= to - span * 0.005 ? "live" : `−${formatDuration(to - hover)}`) : formatDuration(hover - from)}
        </span>
      )}
    </div>
  );
}
