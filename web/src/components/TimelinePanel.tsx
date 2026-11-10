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
      <button
        className={["item", "timeline-indicator", atLive && "live", !live && "replay", open && "open"].filter(Boolean).join(" ")}
        title={live ? (atLive ? "Live, recording: open the timeline" : "Behind live: open the timeline") : "Replaying a recording: open its timeline"}
        onClick={onClick}
      >
        <Icon size={13} />
        {!live && <span className="tag">replay · {replay}</span>}
        <span className="time">{timeLabel(range, playback.cursor, live)}</span>
        {playback.playing && <span className="speed">▶ {playback.speed}×</span>}
      </button>
      {!live && (
        <button className="item exit-replay" title="Stop replaying, back to the live raid" onClick={onExitReplay}>
          <X size={13} /> Exit replay
        </button>
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
    <div className="tl-back">
      <button className="icon" title="All raids" onClick={onBack}>
        <ChevronLeft size={16} />
      </button>
      <div className="tl-title">
        <span>{title}</span>
        <small className="muted">{subtitle}</small>
      </div>
    </div>
  );

  if (!timeline || !range) {
    return (
      <div id="timeline">
        {back}
        <p className="muted pad">No raid right now. Raids are recorded while the backend reads the game.</p>
      </div>
    );
  }

  const atLive = live && playback.cursor === null;
  const toggleGroup = (g: EventGroup) => setPrefs((p) => ({ ...p, groups: { ...groups, [g]: !groups[g] } }));
  const selectedKey = selection && selectionKey(selection);

  return (
    <div id="timeline">
      {back}
      <div className="tl-head">
        <button
          className="tl-play"
          disabled={atLive}
          title={playback.playing ? "Pause (space)" : atLive ? "Live: go back in time to replay" : "Play (space)"}
          onClick={playback.toggle}
        >
          {playback.playing ? <Pause size={16} /> : <Play size={16} />}
        </button>
        <div className="tl-time">
          <span className="big">{timeLabel(range, playback.cursor, live)}</span>
          <small className="muted">
            {live ? (atLive ? "live" : "behind live") : "replay"}
            {loading && " · loading the raid so far…"}
          </small>
        </div>
        {live ? (
          <button className={atLive ? "tl-live on" : "tl-live"} disabled={atLive} title="Back to live" onClick={() => seek(null)}>
            <Radio size={14} /> Live
          </button>
        ) : (
          <button className="tl-exit" title="Stop replaying, back to the live raid" onClick={onExitReplay}>
            <X size={14} /> Exit replay
          </button>
        )}
      </div>
      <div className="tl-controls">
        <div className="segmented" role="radiogroup" aria-label="Playback speed">
          {SPEEDS.map((s) => (
            <button key={s} role="radio" aria-checked={s === playback.speed} className={s === playback.speed ? "active" : undefined} onClick={() => playback.setSpeed(s)}>
              {s}×
            </button>
          ))}
        </div>
        <span className="muted hint">space play · [ ] ±10 s</span>
      </div>
      <div className="tl-filters">
        {(Object.keys(EVENT_GROUPS) as EventGroup[]).map((g) => (
          <button key={g} className={groups[g] ? "chip on" : "chip"} aria-pressed={groups[g]} onClick={() => toggleGroup(g)}>
            {EVENT_GROUPS[g].label}
          </button>
        ))}
        <button
          className={prefs.selectedOnly ? "chip on" : "chip"}
          aria-pressed={prefs.selectedOnly}
          title="Only events about the selected player, item or exfil"
          onClick={() => setPrefs((p) => ({ ...p, selectedOnly: !p.selectedOnly }))}
        >
          Selected only
        </button>
      </div>
      <div className="tl-body">
        <Rail range={range} at={at ?? range[1]} live={live} events={timeline.events} selection={selection} onSeek={seek} />
        <div ref={scrollRef} className="tl-scroll" onScroll={onScroll}>
          <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
            {virtualizer.getVirtualItems().map((v) => {
              const row = rowAt(v.index);
              const style = { transform: `translateY(${v.start}px)`, height: ROW_HEIGHT };
              if (row.kind === "now")
                return (
                  <div key="now" className="tl-now" style={style}>
                    <span className="t">{at !== null ? formatDuration(at - range[0]) : ""}</span>
                    <span className="line" />
                    <span className="label">{atLive ? "now" : "shown"}</span>
                  </div>
                );
              const e = row.e;
              const d = describeEvent(e, timeline, catalog);
              return (
                <button
                  key={v.key}
                  className={`log-row ${d.tone}${v.index > nowIndex ? " future" : ""}${selectedKey === selectionKey(d.sel) ? " selected" : ""}`}
                  style={style}
                  title={d.text}
                  onClick={() => {
                    follow.current = true;
                    onPick(e);
                  }}
                >
                  <span className="t">{formatDuration(e.t - range[0])}</span>
                  <span className="dot" />
                  <span className="text">{d.text}</span>
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
      className="tl-rail"
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
      <div className="track">
        <div className="fill" style={{ height: `${frac(at) * 100}%` }} />
      </div>
      {ticks.map((e, i) => (
        <span
          key={i}
          className={`tick ${selection !== null && eventConcerns(e, selection) ? "sel" : e.kind}`}
          style={{ top: `${frac(e.t) * 100}%` }}
        />
      ))}
      <span className="thumb" style={{ top: `${frac(at) * 100}%` }} />
      {hover !== null && (
        <span className="hover" style={{ top: `${frac(hover) * 100}%` }}>
          {live ? (hover >= to - span * 0.005 ? "live" : `−${formatDuration(to - hover)}`) : formatDuration(hover - from)}
        </span>
      )}
    </div>
  );
}
