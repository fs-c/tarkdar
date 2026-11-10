// Raids view of the side panel: the backend's raid recordings. Opening one replays it on the map.

import { useEffect, useState } from "react";
import { type MapEntry, findMap } from "../maps";
import type { RecordingInfo } from "../protocol";
import { fetchRecordings } from "../recordings";
import { formatDuration } from "../playback";

interface Props {
  mapIndex: MapEntry[];
  /** The open recording's name; null: live. */
  open: string | null;
  /** Loading this one. */
  loading: string | null;
  error: string | null;
  onOpen: (rec: RecordingInfo) => void;
  /** The raid being recorded: that's the live raid. */
  onLive: () => void;
}

export function RaidsPanel({ mapIndex, open, loading, error, onOpen, onLive }: Props) {
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

  const mapName = (id: string | null) => (id ? (findMap(mapIndex, id)?.config.name ?? id) : "unknown map");

  return (
    <div className="panel-body raids">
      {open !== null && (
        <div className="row">
          <button className="primary" onClick={onLive}>
            Back to live
          </button>
        </div>
      )}
      {error && <p className="alert">{error}</p>}
      {listError && <p className="alert">Couldn't list recordings: {listError}</p>}
      {list?.length === 0 && (
        <p className="muted">
          No recordings yet. Every raid is recorded while the backend runs (<code>recordings/</code>).
        </p>
      )}
      <ul className="raid-list">
        {list?.map((r) => {
          const current = r.active ? open === null : open === r.name;
          return (
            <li key={r.name}>
              <button
                className={current ? "active" : undefined}
                disabled={loading !== null}
                title={r.name}
                onClick={() => (r.active ? onLive() : onOpen(r))}
              >
                <span className="what">
                  {mapName(r.locationId)}
                  {r.active && <span className="badge-rec">● recording</span>}
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
          );
        })}
      </ul>
    </div>
  );
}

function formatSize(bytes: number): string {
  return bytes >= 1e6 ? `${(bytes / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1e3))} kB`;
}
