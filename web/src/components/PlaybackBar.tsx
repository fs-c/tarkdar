// The playback controls, floating over the bottom of the map: play, the shown moment, a scrubber
// track over the whole raid, speed, and the way back (to live, or out of a replay).
// Live and at "now" it shrinks to a chip; clicking that opens the controls to go back in time.

import { Pause, Play, Radio, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { eventConcerns } from "../events";
import type { Selection } from "../pick";
import { type Playback, SPEEDS, formatDuration } from "../playback";
import type { TimelineEvent } from "../timeline";
import { cx } from "../ui";
import s from "./PlaybackBar.module.css";

/** The shown moment as text: raid time when live, how far behind live, or position / length. */
function timeLabel(range: [number, number], cursor: number | null, live: boolean): React.ReactNode {
  const [from, to] = range;
  if (!live) return <>{formatDuration((cursor ?? from) - from)}<span className={s.total}> / {formatDuration(to - from)}</span></>;
  return cursor === null ? formatDuration(to - from) : `−${formatDuration(to - cursor)}`;
}

interface Props {
  range: [number, number];
  playback: Playback;
  /** Replaying a recording (else the live raid). */
  replay: boolean;
  events: TimelineEvent[];
  selection: Selection | null;
  onExitReplay: () => void;
}

export function PlaybackBar({ range, playback, replay, events, selection, onExitReplay }: Props) {
  const live = !replay;
  const atLive = live && playback.cursor === null;
  const [expanded, setExpanded] = useState(false);

  if (atLive && !expanded)
    return (
      <button type="button" className={cx(s.pill, s.chip)} title="Live: go back in time" onClick={() => setExpanded(true)}>
        <Radio size={15} className={s.liveIcon} />
        <span className={s.liveTag}>Live</span>
        <span className={s.time}>{timeLabel(range, null, true)}</span>
      </button>
    );

  const at = playback.cursor ?? range[1];

  return (
    <div className={s.pill} data-mode={replay ? "replay" : atLive ? "live" : "behind"} role="toolbar" aria-label="Playback">
      <button
        type="button"
        className={s.round}
        disabled={atLive}
        title={playback.playing ? "Pause (space)" : atLive ? "Live: go back in time to replay" : "Play (space)"}
        onClick={playback.toggle}
      >
        {playback.playing ? <Pause size={16} /> : <Play size={16} />}
      </button>
      <span className={s.time} title="[ ] ±10 s">
        {timeLabel(range, playback.cursor, live)}
      </span>
      <Track range={range} at={at} live={live} events={events} selection={selection} onSeek={playback.seek} />
      <SpeedMenu speed={playback.speed} onChange={playback.setSpeed} />
      {replay ? (
        <button type="button" className={s.exit} title="Stop replaying, back to the live raid" onClick={onExitReplay}>
          <X size={15} /> <span className={s.label}>Exit replay</span>
        </button>
      ) : (
        <button
          type="button"
          className={s.toLive}
          title={atLive ? "Hide the controls" : "Back to live"}
          onClick={() => {
            playback.seek(null);
            setExpanded(false);
          }}
        >
          <Radio size={14} /> <span className={s.label}>Live</span>
        </button>
      )}
    </div>
  );
}

/** The speed button; a menu of the speeds opens above it. */
function SpeedMenu({ speed, onChange }: { speed: number; onChange: (speed: number) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // Closes on a click elsewhere, or Escape.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={ref} className={s.speedBox}>
      <button
        type="button"
        className={s.speed}
        aria-haspopup="menu"
        aria-expanded={open}
        title="Playback speed"
        onClick={() => setOpen((o) => !o)}
      >
        {speed}×
      </button>
      {open && (
        <div className={s.menu} role="menu" aria-label="Playback speed">
          {[...SPEEDS].reverse().map((v) => (
            <button
              key={v}
              type="button"
              role="menuitemradio"
              aria-checked={v === speed}
              className={s.option}
              onClick={() => {
                onChange(v);
                setOpen(false);
              }}
            >
              {v}×
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

interface TrackProps {
  range: [number, number];
  at: number;
  live: boolean;
  events: TimelineEvent[];
  selection: Selection | null;
  onSeek: (t: number | null) => void;
}

/** The whole raid left to right: drag to move in time. Ticks: deaths, players leaving, and the selected thing's events. */
function Track({ range, at, live, events, selection, onSeek }: TrackProps) {
  const [from, to] = range;
  const span = Math.max(1, to - from);
  const frac = (t: number) => Math.min(1, Math.max(0, (t - from) / span));
  const ref = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  const [hover, setHover] = useState<number | null>(null);

  const timeAt = (clientX: number) => {
    const r = ref.current!.getBoundingClientRect();
    return from + Math.min(1, Math.max(0, (clientX - r.left) / r.width)) * span;
  };
  const seekTo = (clientX: number) => {
    const t = timeAt(clientX);
    onSeek(live && t >= to - span * 0.005 ? null : t);
  };
  const ticks = events.filter(
    (e) => e.kind === "died" || e.kind === "left" || (selection !== null && eventConcerns(e, selection)),
  );

  return (
    <div
      ref={ref}
      className={s.track}
      onPointerDown={(e) => {
        dragging.current = true;
        e.currentTarget.setPointerCapture(e.pointerId);
        seekTo(e.clientX);
      }}
      onPointerMove={(e) => {
        setHover(timeAt(e.clientX));
        if (dragging.current) seekTo(e.clientX);
      }}
      onPointerUp={() => (dragging.current = false)}
      onPointerCancel={() => (dragging.current = false)}
      onPointerLeave={() => setHover(null)}
    >
      <div className={s.groove}>
        <div className={s.fill} style={{ width: `${frac(at) * 100}%` }} />
      </div>
      {ticks.map((e, i) => (
        <span
          key={i}
          className={s.tick}
          data-kind={e.kind}
          data-selected={selection !== null && eventConcerns(e, selection)}
          style={{ left: `${frac(e.t) * 100}%` }}
        />
      ))}
      <span className={s.thumb} style={{ left: `${frac(at) * 100}%` }} />
      {hover !== null && (
        <span className={s.hover} style={{ left: `${frac(hover) * 100}%` }}>
          {live ? (hover >= to - span * 0.005 ? "live" : `−${formatDuration(to - hover)}`) : formatDuration(hover - from)}
        </span>
      )}
    </div>
  );
}
