// Notices over the bottom of the map: what the status bar used to say that still matters while the
// map works (a problem with the data, the map loading or missing). One line each, centred above the
// playback bar; a problem can carry an action (Retry), most can be dismissed for the session.

import { Info, TriangleAlert, X } from "lucide-react";
import { useState } from "react";
import { cx } from "../ui";
import f from "./Floating.module.css";
import s from "./MapNotices.module.css";

export interface Notice {
  /** Stays the same while it's the same notice (dismissing goes by it). */
  id: string;
  /** warn: something's wrong; info: worth knowing. */
  tone: "info" | "warn";
  text: string;
  /** 0..1: shown as a progress bar (and the notice can't be dismissed). */
  progress?: number;
  action?: { label: string; run: () => void };
}

export function MapNotices({ notices, above }: { notices: readonly Notice[]; above: boolean }) {
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(new Set());
  const shown = notices.filter((n) => !dismissed.has(n.id));
  if (!shown.length) return null;
  return (
    <div className={f.notices} data-above={above}>
      {shown.map((n) => (
        <div key={n.id} className={cx(f.surface, s.notice)} data-tone={n.tone} role={n.tone === "warn" ? "alert" : "status"}>
          <span className={s.icon}>{n.tone === "warn" ? <TriangleAlert size={15} /> : <Info size={15} />}</span>
          <span className={s.text}>{n.text}</span>
          {n.progress !== undefined && (
            <>
              <span className={s.progress}>
                <i style={{ width: `${Math.round(n.progress * 100)}%` }} />
              </span>
              <span className={s.percent}>{Math.round(n.progress * 100)} %</span>
            </>
          )}
          {n.action && (
            <button type="button" className={s.action} onClick={n.action.run}>
              {n.action.label}
            </button>
          )}
          {n.progress === undefined && (
            <button type="button" className={s.dismiss} title="Dismiss" onClick={() => setDismissed((d) => new Set(d).add(n.id))}>
              <X size={13} />
            </button>
          )}
        </div>
      ))}
    </div>
  );
}
