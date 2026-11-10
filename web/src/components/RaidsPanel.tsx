// Raids view of the side panel, list level: the current (live) raid, pinned, and the backend's past
// raid recordings. Picking one shows it on the map and opens its timeline (TimelinePanel).

import { useEffect, useState } from "react";
import { formatDuration } from "../playback";
import type { RecordingInfo } from "../protocol";
import { fetchRecordings } from "../recordings";

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
}

export function RaidsPanel({ current, viewing, loading, error, mapName, onOpen, onCurrent }: Props) {
  const [list, setList] = useState<RecordingInfo[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);

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

  return (
    <div className="panel-body raids">
      {error && <p className="alert pad">{error}</p>}
      {listError && <p className="alert pad">Couldn't list recordings: {listError}</p>}
      <ul className="raid-list">
        {current.available && (
          <li>
            <button
              className={["current", viewing === null && "active"].filter(Boolean).join(" ")}
              disabled={loading !== null}
              onClick={onCurrent}
            >
              <span className="what">
                Current raid
                {viewing === null && <span className="badge-viewing">viewing</span>}
              </span>
              <span className="when muted">
                {current.inRaid
                  ? `${current.mapName ?? "unknown map"} · in progress${current.elapsed !== null ? ` · ${formatDuration(current.elapsed)}` : ""}`
                  : "waiting for a raid"}
              </span>
            </button>
          </li>
        )}
        {past?.map((r) => (
          <li key={r.name}>
            <button
              className={viewing === r.name ? "active" : undefined}
              disabled={loading !== null}
              title={r.name}
              onClick={() => onOpen(r)}
            >
              <span className="what">
                {mapName(r.locationId)}
                {viewing === r.name && <span className="badge-viewing replay">replaying</span>}
                {loading === r.name && <span className="muted"> loading…</span>}
              </span>
              <span className="when muted">
                {r.start ? new Date(r.start).toLocaleString() : "?"}
                {" · "}
                {r.start && r.end ? formatDuration(r.end - r.start) : r.active ? "in progress" : "?"}
                {" · "}
                {formatSize(r.size)}
              </span>
            </button>
          </li>
        ))}
      </ul>
      {past?.length === 0 && (
        <p className="muted pad">
          No past raids yet. Every raid is recorded while the backend runs (<code>recordings/</code>).
        </p>
      )}
    </div>
  );
}

function formatSize(bytes: number): string {
  return bytes >= 1e6 ? `${(bytes / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1e3))} kB`;
}
