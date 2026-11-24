// Building blocks of the side panel's views.

import type { ReactNode, Ref } from "react";
import s from "./Panel.module.css";
import { cx } from "./cx";

/** The scrolling body of a side panel view. */
export function PanelBody({ ref, children }: { ref?: Ref<HTMLDivElement>; children: ReactNode }) {
  return (
    <div ref={ref} className={s.body}>
      {children}
    </div>
  );
}

/** A titled section; consecutive sections are separated by a rule. `aside`: controls right of the title. */
export function Section({ title, aside, children }: { title: string; aside?: ReactNode; children: ReactNode }) {
  return (
    <section className={s.section}>
      {aside ? (
        <div className={s.head}>
          <h3 className={s.title}>{title}</h3>
          {aside}
        </div>
      ) : (
        <h3 className={s.title}>{title}</h3>
      )}
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
