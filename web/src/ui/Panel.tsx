// Building blocks of the side panel's views.

import type { ReactNode } from "react";
import s from "./Panel.module.css";
import { cx } from "./cx";

/** The scrolling body of a side panel view. */
export function PanelBody({ children }: { children: ReactNode }) {
  return <div className={s.body}>{children}</div>;
}

/** A titled section; consecutive sections are separated by a rule. */
export function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className={s.section}>
      <h3 className={s.title}>{title}</h3>
      {children}
    </section>
  );
}

/** A row of buttons. */
export function Actions({ children }: { children: ReactNode }) {
  return <div className={s.actions}>{children}</div>;
}

/** A padded line of text: an empty state (muted) or a problem (alert). */
export function Note({ tone = "muted", children }: { tone?: "muted" | "alert"; children: ReactNode }) {
  return <p className={cx(s.note, tone === "muted" ? "muted" : s.alert)}>{children}</p>;
}
