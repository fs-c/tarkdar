// The Exfils view: the raid's exfils, the usable ones first, nearest first. Each row: the name, its
// status (in its colour), and the distance with an arrow pointing at it. Hovering a row marks it on the
// map; clicking selects it and shows it there.

import { useEffect, useMemo } from "react";
import type { Selection } from "../draw/pick";
import { type ExfilRow, selectionKey, withDistances } from "../list/rows";
import { cx, PanelBody } from "../ui";
import { Distance, type Viewpoint } from "./PlayersView";
import v from "./views.module.css";

interface Props {
  exfils: readonly ExfilRow[];
  local: Viewpoint;
  selection: Selection | null;
  onActivate: (sel: Selection) => void;
  onHover: (sel: Selection | null) => void;
}

export function ExfilsView({ exfils, local, selection, onActivate, onHover }: Props) {
  const selKey = selection ? selectionKey(selection) : null;
  useEffect(() => () => onHover(null), []);

  const rows = useMemo(() => {
    const dist = (r: ExfilRow) => r.dist ?? Infinity;
    return withDistances([...exfils], local?.pos ?? null).sort((a, b) => Number(a.tone === "closed") - Number(b.tone === "closed") || dist(a) - dist(b));
  }, [exfils, local?.pos]);

  return (
    <PanelBody>
      <div className={v.top} />
      {rows.length === 0 && <p className={v.empty}>No exfils (yet)</p>}
      {rows.map((r) => (
        <div
          key={r.key}
          className={cx(v.row, v.exfil)}
          data-selected={r.key === selKey}
          title={`${r.name}${r.kind === "secret" ? " (secret)" : ""}`}
          onClick={() => onActivate(r.sel)}
          onPointerEnter={() => onHover(r.sel)}
          onPointerLeave={() => onHover(null)}
        >
          <span>{r.name}</span>
          <span className={cx("num", v.status)} data-tone={r.kind === "secret" ? "secret" : r.tone}>
            {r.kind === "secret" && r.status === "?" ? "secret" : r.status}
          </span>
          <span className="num">
            <Distance row={r} from={local} />
          </span>
        </div>
      ))}
    </PanelBody>
  );
}
