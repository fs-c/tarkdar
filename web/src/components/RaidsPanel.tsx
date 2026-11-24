// Raids view of the side panel, list level: a filter (map, day, time), the current (live) raid under
// "Now", and the backend's past raid recordings by day. Picking one shows it on the map (playback controls float over it, PlaybackBar) and
// opens its event log (TimelinePanel).

import { Search } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { formatDuration } from "../stream/playback";
import type { RecordingInfo } from "../model/protocol";
import { fetchRecordings } from "../stream/recordings";
import { cx, Note, PanelBody } from "../ui";
import v from "./views.module.css";
import s from "./RaidsPanel.module.css";

export interface CurrentRaid {
  /** The backend reads a game (not --offline). */
  available: boolean;
  /** A raid is running; its map name and how long it's been going. */
  inRaid: boolean;
  mapName: string | null;
  elapsed: number | null;
}

interface Props {
  current: CurrentRaid;
  /** The recording being replayed; null: the live raid is shown. */
  viewing: string | null;
  /** Loading this one. */
  loading: string | null;
  error: string | null;
  mapName: (locationId: string | null) => string;
  onOpen: (rec: RecordingInfo) => void;
  onCurrent: () => void;
  /** Set by the view: focuses its filter (the L key). */
  focusRef: React.RefObject<(() => void) | undefined>;
}

export function RaidsPanel({ current, viewing, loading, error, mapName, onOpen, onCurrent, focusRef }: Props) {
  const [list, setList] = useState<RecordingInfo[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const term = filter.trim().toLowerCase();
  const inputRef = useRef<HTMLInputElement>(null);

  useLayoutEffect(() => {
    focusRef.current = () => {
      inputRef.current?.focus();
      inputRef.current?.select();
    };
    return () => void (focusRef.current = undefined);
  }, [focusRef]);

  useEffect(() => {
    let live = true;
    const refresh = () =>
      fetchRecordings().then(
        (l) => live && (setList(l), setListError(null)),
        (e: unknown) => live && setListError(String(e)),
      );
    void refresh();
    const timer = setInterval(refresh, 5000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, []);

  // The recording being written is the current raid: listed once, as that.
  const past = list?.filter((r) => !(r.active && current.available)) ?? null;

  // Past raids by day: "Today", "Yesterday", "Sat 21 Nov". Filtered: those whose map, day or time match.
  const days = new Map<string, RecordingInfo[]>();
  for (const r of [...(past ?? [])].sort((a, b) => (b.start ?? 0) - (a.start ?? 0))) {
    const day = r.start ? dayName(r.start) : "Unknown date";
    if (term && !`${mapName(r.locationId)} ${day} ${r.start ? timeOf(r.start) : ""} ${r.name}`.toLowerCase().includes(term)) continue;
    days.set(day, [...(days.get(day) ?? []), r]);
  }

  return (
    <PanelBody>
      <label className={v.find}>
        <Search size={14} />
        <input
          ref={inputRef}
          placeholder="Filter raids"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              if (filter) setFilter("");
              else e.currentTarget.blur();
            }
          }}
        />
      </label>
      {error && <Note tone="alert">{error}</Note>}
      {listError && <Note tone="alert">Couldn't list recordings: {listError}</Note>}
      {current.available && !term && (
        <>
          <div className={v.group} data-static="true">
            <b>Now</b>
          </div>
          <button
            className={cx(v.row, s.raid)}
            data-selected={viewing === null && current.inRaid}
            disabled={loading !== null || !current.inRaid}
            onClick={onCurrent}
            title={current.inRaid ? "The live raid: its events" : undefined}
          >
            <span>
              {current.inRaid ? (
                <>
                  <span className={s.live} />
                  {current.mapName ?? "unknown map"}
                  {viewing === null && <span className={s.pill}>viewing</span>}
                </>
              ) : (
                <span className="muted">Waiting for a raid</span>
              )}
            </span>
            <span className={s.when}>{current.inRaid ? "live" : ""}</span>
            <span className={cx(s.when, "num")}>{current.inRaid && current.elapsed !== null ? formatDuration(current.elapsed) : ""}</span>
          </button>
        </>
      )}
      {[...days].map(([day, list]) => (
        <div key={day}>
          <div className={v.group} data-static="true">
            <b>{day}</b>
            <span className={v.count}>{list.length}</span>
          </div>
          {list.map((r) => (
            <button
              key={r.name}
              className={cx(v.row, s.raid)}
              data-selected={viewing === r.name}
              disabled={loading !== null}
              title={`${r.name} · ${formatSize(r.size)}`}
              onClick={() => onOpen(r)}
            >
              <span>
                {mapName(r.locationId)}
                {viewing === r.name && <span className={s.pill}>replaying</span>}
                {loading === r.name && <span className="muted"> loading…</span>}
              </span>
              <span className={s.when}>{r.start ? timeOf(r.start) : ""}</span>
              <span className={cx(s.when, "num")}>{r.start && r.end ? formatDuration(r.end - r.start) : r.active ? "in progress" : ""}</span>
            </button>
          ))}
        </div>
      ))}
      {term && past?.length !== 0 && days.size === 0 && <p className={v.empty}>No raids match</p>}
      {past?.length === 0 && (
        <Note>
          No past raids yet. Every raid is recorded while the backend runs (<code>recordings/</code>).
        </Note>
      )}
    </PanelBody>
  );
}

/** "17:52" */
const timeOf = (ms: number) => new Date(ms).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });

/** "Today", "Yesterday", or "Sat 21 Nov". */
function dayName(ms: number): string {
  const d = new Date(ms), now = new Date();
  const days = Math.round((new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() - new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()) / 86_400_000);
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  return d.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
}

function formatSize(bytes: number): string {
  return bytes >= 1e6 ? `${(bytes / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1e3))} kB`;
}
