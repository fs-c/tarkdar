import type { ReactNode } from "react";
import s from "./Segmented.module.css";
import { cx } from "./cx";

export interface SegmentedOption<T> {
  value: T;
  label: ReactNode;
  title?: string;
}

interface Props<T> {
  options: SegmentedOption<T>[];
  /** The picked option. */
  value: T;
  onChange: (value: T) => void;
  /** Another option to mark (e.g. what "auto" resolved to). */
  marked?: T;
  /** Accessible name of the group. */
  label?: string;
  title?: string;
  className?: string;
}

/** A row of mutually exclusive options (a radio group). */
export function Segmented<T>({ options, value, onChange, marked, label, title, className }: Props<T>) {
  return (
    <div className={cx(s.segmented, className)} role="radiogroup" aria-label={label} title={title}>
      {options.map((o) => (
        <button
          key={String(o.value)}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          data-marked={marked !== undefined && o.value === marked}
          className={s.option}
          title={o.title}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
