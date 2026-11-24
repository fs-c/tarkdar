// A dialog in the middle of the map when there's no raid to show: not connected, a page out of
// date, no game (offline), or waiting for a raid. The map behind it is the plain grid. Icon on the
// left, then a title, a line or two, details in monospace, and what to do.

import type { LucideIcon } from "lucide-react";
import { cx } from "../ui";
import f from "./Floating.module.css";
import s from "./StateDialog.module.css";

export interface StateDialogProps {
  /** error: something's broken; info: nothing wrong, just nothing to show. */
  tone: "error" | "info";
  icon: LucideIcon;
  /** The icon turns (waiting). */
  spin?: boolean;
  title: string;
  text: string;
  /** A line of details (an address, a command). */
  meta?: string;
  actions: { label: string; icon?: LucideIcon; primary?: boolean; run: () => void }[];
}

export function StateDialog({ tone, icon: Icon, spin = false, title, text, meta, actions }: StateDialogProps) {
  return (
    <div className={cx(f.centre, f.card, s.dialog)} data-tone={tone} role={tone === "error" ? "alertdialog" : "dialog"} aria-label={title}>
      <div className={s.icon} data-spin={spin}>
        <Icon size={20} />
      </div>
      <h2 className={s.title}>{title}</h2>
      <p className={s.text}>{text}</p>
      {meta && <div className={s.meta}>{meta}</div>}
      {actions.length > 0 && (
        <div className={s.actions}>
          {actions.map(({ label, icon: A, primary, run }) => (
            <button key={label} type="button" className={s.action} data-primary={!!primary} onClick={run}>
              {A && <A size={13} />} {label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
