import type { ReactNode } from "react";
import s from "./Chip.module.css";

/** A small on/off filter toggle. */
export function Chip({ on, onClick, title, children }: { on: boolean; onClick: () => void; title?: string; children: ReactNode }) {
  return (
    <button type="button" className={s.chip} aria-pressed={on} title={title} onClick={onClick}>
      {children}
    </button>
  );
}
