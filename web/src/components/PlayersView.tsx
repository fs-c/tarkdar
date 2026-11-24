// The Players view: everyone in the raid, grouped by tier (watch/tiers.ts) in the order they matter,
// each group headed by its colour, its count of the living and its level (which sets how its players
// look on the map). Low tiers start folded. In a group: the living by distance (bosses first), then
// the dead and those who left, struck through. Each row: name and id, the distance right after it
// with an arrow pointing at them from where you look, and a mark per watched thing they carry.

import { ChevronDown, Search } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Selection } from "../draw/pick";
import type { WorldPos } from "../model/protocol";
import { type PlayerRow, selectionKey, withDistances } from "../list/rows";
import type { SetStored } from "../persist";
import type { CarriedMark } from "../watch/rules";
import type { MarkerPrefs } from "../watch/prefs";
import { WATCH_COLORS } from "../watch/prefs";
import { TIERS, TIER_ORDER, type Tier, tierOf } from "../watch/tiers";
import { cx } from "../ui";
import { LevelPicker } from "./LevelPicker";
import v from "./views.module.css";

interface Props {
  players: readonly PlayerRow[];
  /** The local player: distances, and the arrows' "ahead". */
  local: Viewpoint;
  markers: MarkerPrefs;
  setMarkers: SetStored<MarkerPrefs>;
  /** Player id → the watched things they carry. */
  carried: ReadonlyMap<number, CarriedMark[]>;
  selection: Selection | null;
  onActivate: (sel: Selection) => void;
  onHover: (sel: Selection | null) => void;
  /** Set by the view: focuses its filter (the L key). */
  focusRef: React.RefObject<(() => void) | undefined>;
}

const alive = (p: PlayerRow) => p.state === "alive";

export function PlayersView({ players, local, markers, setMarkers, carried, selection, onActivate, onHover, focusRef }: Props) {
  const [filter, setFilter] = useState("");
  /** Folded or unfolded by hand; otherwise Low tiers are folded. */
  const [folded, setFolded] = useState<Partial<Record<Tier, boolean>>>({});
  const [colorMenu, setColorMenu] = useState<Tier | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const selKey = selection ? selectionKey(selection) : null;

  useLayoutEffect(() => {
    focusRef.current = () => {
      inputRef.current?.focus();
      inputRef.current?.select();
    };
    return () => void (focusRef.current = undefined);
  }, [focusRef]);
  useEffect(() => () => onHover(null), []);

  const groups = useMemo(() => {
    const term = filter.trim().toLowerCase();
    const rows = withDistances(players.filter((p) => !p.local), local?.pos ?? null).filter(
      (p) => !term || `${p.typeLabel} ${p.name} ${p.sel.id} ${p.search}`.toLowerCase().includes(term),
    );
    return TIER_ORDER.map((tier) => {
      const list = rows.filter((p) => tierOf(p.type) === tier);
      list.sort((a, b) => Number(!alive(a)) - Number(!alive(b)) || (alive(a) ? Number(b.type === "boss") - Number(a.type === "boss") || (a.dist ?? 0) - (b.dist ?? 0) : b.sel.id - a.sel.id));
      return { tier, list, living: list.filter(alive).length };
    });
  }, [players, local?.pos, filter]);

  const setTier = (tier: Tier, patch: Partial<MarkerPrefs["tiers"][Tier]>) =>
    setMarkers((m) => ({ ...m, tiers: { ...m.tiers, [tier]: { ...m.tiers[tier], ...patch } } }));

  return (
    <>
      <label className={v.find}>
        <Search size={14} />
        <input
          ref={inputRef}
          placeholder="Filter players"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              if (filter) setFilter("");
              else e.currentTarget.blur();
            }
          }}
        />
      </label>
      {groups.map(({ tier, list, living }) => {
        const { level, color } = markers.tiers[tier];
        const isFolded = !filter.trim() && (folded[tier] ?? level === "low");
        return (
          <div key={tier}>
            <div className={v.group} data-folded={isFolded} onClick={() => setFolded((f) => ({ ...f, [tier]: !isFolded }))}>
              <button
                type="button"
                className={v.tick}
                style={{ background: color }}
                title="Colour"
                onClick={(e) => {
                  e.stopPropagation();
                  setColorMenu((m) => (m === tier ? null : tier));
                }}
              />
              <b>{TIERS[tier].name}</b>
              <span className={v.count}>{living}</span>
              <span className={v.grow} />
              <LevelPicker level={level} color={color} label={TIERS[tier].name} onChange={(l) => setTier(tier, { level: l })} onCurrent={() => setColorMenu((m) => (m === tier ? null : tier))} />
              <span className={v.chev}>
                <ChevronDown size={13} />
              </span>
            </div>
            {colorMenu === tier && (
              <div className={v.swatches} role="radiogroup" aria-label={`${TIERS[tier].name}: colour`}>
                {[...new Set([TIERS[tier].color, color, ...WATCH_COLORS, "#d5dde3"])].map((c) => (
                  <button key={c} type="button" role="radio" aria-checked={c === color} className={v.swatch} style={{ background: c }} onClick={() => setTier(tier, { color: c })} />
                ))}
              </div>
            )}
            {!isFolded &&
              list.map((p) => (
                <PlayerLine key={p.key} p={p} from={local} marks={carried.get(p.sel.id)} selected={p.key === selKey} onActivate={onActivate} onHover={onHover} />
              ))}
          </div>
        );
      })}
    </>
  );
}

interface LineProps {
  p: PlayerRow;
  from: Viewpoint;
  marks?: CarriedMark[];
  selected: boolean;
  onActivate: (sel: Selection) => void;
  onHover: (sel: Selection | null) => void;
}

function PlayerLine({ p, from, marks, selected, onActivate, onHover }: LineProps) {
  const gone = !alive(p);
  const what = p.state === "dead" ? "dead" : p.state === "extracted" ? "extracted" : p.state === "left" ? "left the raid" : "";
  return (
    <div
      className={cx(v.row, v.player)}
      data-selected={selected}
      data-gone={gone}
      title={gone ? `${p.typeLabel} ${p.sel.id}: ${what}` : p.typeDetail}
      onClick={() => onActivate(p.sel)}
      onPointerEnter={() => onHover(p.sel)}
      onPointerLeave={() => onHover(null)}
    >
      <span className={cx(p.type === "boss" && !gone && v.bold)}>
        <span className={v.name}>{p.typeLabel}</span> <span className={v.id}>{p.sel.id}</span>
      </span>
      <span>
        {p.state !== "extracted" && p.state !== "left" && <Distance row={p} from={from} />}
        {marks?.map((m) => <span key={m.entryId} className={v.pip} style={{ background: m.color }} title={`Carries ${m.label}`} />)}
      </span>
    </div>
  );
}

/** Where you are and look: the distances' arrows point from there (up: ahead). */
export type Viewpoint = { pos: WorldPos; yaw: number } | null;

/** "↗ 34 m": the distance, and an arrow pointing at it from where you look (up: ahead); the farther,
 *  the dimmer. */
export function Distance({ row, from }: { row: { dist?: number; pos: WorldPos | null; dh?: number }; from: Viewpoint }) {
  if (row.dist === undefined) return null;
  const d = row.dist;
  const fade = Math.max(0.4, Math.min(1, 1.15 - d / 400));
  // The direction to it (0 = +z, 90 = +x, like yaw), relative to where you look.
  const bearing = from && row.pos ? (Math.atan2(row.pos[0] - from.pos[0], row.pos[2] - from.pos[2]) * 180) / Math.PI - from.yaw : null;
  return (
    <span className={v.far} style={{ opacity: fade }} title={row.dh !== undefined && Math.abs(row.dh) >= 2 ? `${Math.round(Math.abs(row.dh))} m ${row.dh > 0 ? "above" : "below"} you` : undefined}>
      {bearing !== null && d >= 1 && (
        <svg className={v.arrow} viewBox="0 0 24 24" style={{ transform: `rotate(${bearing}deg)` }} aria-hidden="true">
          <path d="M12 3l6 16-6-4-6 4z" />
        </svg>
      )}
      {Math.round(d)} m
    </span>
  );
}
