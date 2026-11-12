import type { ReactNode } from "react";
import s from "./SliderRow.module.css";

interface Props {
  label: ReactNode;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (value: number) => void;
}

/** A labelled slider that shows its value. */
export function SliderRow({ label, value, min, max, step, onChange }: Props) {
  return (
    <label className={s.row}>
      <span className={s.label}>{label}</span>
      <input type="range" className={s.slider} min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} />
      <output className={s.value}>{value.toFixed(2)}</output>
    </label>
  );
}
