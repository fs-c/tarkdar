// Raids view of the side panel, list level: the current (live) raid, pinned, and the backend's past
// raid recordings. Picking one shows it on the map and opens its timeline (TimelinePanel).

import { useEffect, useState } from "react";
import { formatDuration } from "../playback";
import type { RecordingInfo } from "../protocol";
import { fetchRecordings } from "../recordings";
import { cx, Note, PanelBody, selectableRow } from "../ui";
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
    <PanelBody>
      {error && <Note tone="alert">{error}</Note>}
      {listError && <Note tone="alert">Couldn't list recordings: {listError}</Note>}
      <ul className={s.list}>
        {current.available && (
          <li>
            <button
              className={cx(s.raid, selectableRow)}
              data-current
              data-selected={viewing === null}
              disabled={loading !== null}
              onClick={onCurrent}
            >
              <span className={s.what}>
                Current raid
                {viewing === null && <span className={s.pill}>viewing</span>}
              </span>
              <span className={cx(s.when, "muted")}>
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
              className={cx(s.raid, selectableRow)}
              data-selected={viewing === r.name}
              disabled={loading !== null}
              title={r.name}
              onClick={() => onOpen(r)}
            >
              <span className={s.what}>
                {mapName(r.locationId)}
                {viewing === r.name && <span className={s.pill} data-tone="replay">replaying</span>}
                {loading === r.name && <span className="muted"> loading…</span>}
              </span>
              <span className={cx(s.when, "muted")}>
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
        <Note>
          No past raids yet. Every raid is recorded while the backend runs (<code>recordings/</code>).
        </Note>
      )}
    </PanelBody>
  );
}

function formatSize(bytes: number): string {
  return bytes >= 1e6 ? `${(bytes / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1e3))} kB`;
}
