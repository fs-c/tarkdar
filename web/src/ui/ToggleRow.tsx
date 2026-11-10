import type { ReactNode } from "react";
import s from "./ToggleRow.module.css";

/** A labelled on/off switch, with an optional hint line. */
export function ToggleRow({ checked, onChange, label, hint }: { checked: boolean; onChange: () => void; label: ReactNode; hint?: ReactNode }) {
  return (
    <label className={s.row}>
      <input type="checkbox" role="switch" className={s.switch} checked={checked} onChange={onChange} />
      <span>
        {label}
        {hint && <small className={s.hint}>{hint}</small>}
      </span>
    </label>
  );
}
