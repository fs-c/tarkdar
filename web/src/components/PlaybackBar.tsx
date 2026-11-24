// The playback controls, floating across the bottom of the map: play, the shown moment, a scrubber
// track over the whole raid, speed, and the way back (to live, or out of a replay). The same bar for
// a replay and the live raid; live, a LIVE marker (red at live, click it to get back there) and a
// way to hide it. It's up while replaying, behind live, or while the Raids view shows the live raid.

import { Pause, Play, X } from "lucide-react";
import { useRef, useState } from "react";
import { eventConcerns } from "../stream/events";
import type { Selection } from "../draw/pick";
import { type Playback, SPEEDS, formatDuration } from "../stream/playback";
import type { TimelineEvent } from "../stream/timeline";
import { cx, useDismiss } from "../ui";
import f from "./Floating.module.css";
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
  /** Live: hides the bar (and goes back to live). */
  onHide: () => void;
}

export function PlaybackBar({ range, playback, replay, events, selection, onExitReplay, onHide }: Props) {
  const live = !replay;
  const atLive = live && playback.cursor === null;
  const at = playback.cursor ?? range[1];

  return (
    <div className={cx(f.surface, f.bottom, s.pill)} data-mode={replay ? "replay" : atLive ? "live" : "behind"} role="toolbar" aria-label="Playback">
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
        <>
          <button type="button" className={s.toLive} disabled={atLive} title={atLive ? "Live" : "Back to live"} onClick={() => playback.seek(null)}>
            <span className={s.liveDot} /> LIVE
          </button>
          <button
            type="button"
            className={s.exit}
            title="Hide (back to live)"
            onClick={() => {
              playback.seek(null);
              onHide();
            }}
          >
            <X size={15} />
          </button>
        </>
      )}
    </div>
  );
}

/** The speed button; a menu of the speeds opens above it. */
function SpeedMenu({ speed, onChange }: { speed: number; onChange: (speed: number) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useDismiss(ref, open, () => setOpen(false));

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
    (e) => e.kind === "died" || e.kind === "left" || e.kind === "extracted" || (selection !== null && eventConcerns(e, selection)),
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
