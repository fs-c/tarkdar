import type { ReactNode } from "react";
import s from "./Price.module.css";
import { cx } from "./cx";

/** A ₽ amount; `base`: from the base price (no flea data), shown dimmer. */
export function Price({ base = false, children }: { base?: boolean; children: ReactNode }) {
  return (
    <span className={cx(s.price, base && s.base)} title={base ? "base price (no flea data)" : undefined}>
      {children}
    </span>
  );
}
