// The map style switcher in the map's top right corner: a button showing the current style that
// opens a row of the styles to its left, each with a small preview drawn in its own colours.

import { useEffect, useRef, useState } from "react";
import { PLAN_PALETTES, type MapStyle, type PlanPalette, type PlanPaletteName, paletteOf } from "../map3d/settings";
import s from "./StyleSwitch.module.css";

interface Props {
  style: MapStyle;
  palette: PlanPalette;
  /** The user's own palette, if they made one: offered next to the pre-made ones. */
  custom: PlanPalette | null;
  onChange: (style: MapStyle, palette: PlanPalette) => void;
}

export const PALETTE_LABELS: Record<PlanPaletteName, string> = {
  paper: "Paper",
  atlas: "Atlas",
  mono: "Mono",
  night: "Night",
  midnight: "Midnight",
  blueprint: "Blueprint",
};

/** The realistic style has no palette: these stand for the game's colours as the map shows them. */
const REALISTIC: PlanPalette = {
  ground: "#b5ad94", grass: "#98a86a", road: "#aaa69d", water: "#7fb6c9", floor: "#b9b4ab", cover: "#8f8a80",
  obstacle: "#b0694b", building: "#c9c4be", buildingTall: "#a59f98", tree: "#6f9a5c", outline: "#9a958c",
};

/** A scrap of map in a palette: ground, grass, water, a road, a building, a wall and some cover. */
function Preview({ palette: c, lines = true }: { palette: PlanPalette; lines?: boolean }) {
  const stroke = lines ? { stroke: c.outline, strokeWidth: 1 } : {};
  return (
    <svg className={s.preview} viewBox="0 0 40 40" aria-hidden="true">
      <rect width="40" height="40" fill={c.ground} />
      <path d="M0 22 Q10 16 17 26 T26 40 H0 Z" fill={c.grass} />
      <path d="M26 0 H40 V13 Q31 12 26 0 Z" fill={c.water} />
      <path d="M-2 13 L42 31" stroke={c.road} strokeWidth="6" fill="none" />
      <rect x="6" y="3" width="15" height="10" fill={c.building} {...stroke} />
      <rect x="24" y="29" width="9" height="8" fill={c.buildingTall} {...stroke} />
      <rect x="4" y="30" width="13" height="2" fill={c.obstacle} />
      <rect x="27" y="17" width="5" height="3" fill={c.cover} transform="rotate(22 29 18)" />
      <circle cx="10" cy="24" r="2" fill={c.tree} />
    </svg>
  );
}

export function StyleSwitch({ style, palette, custom, onChange }: Props) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const plan = style === "plan";
  const current = plan ? paletteOf(palette) : null;

  useEffect(() => {
    if (!open) return;
    const outside = (e: PointerEvent) => !root.current?.contains(e.target as Node) && setOpen(false);
    const escape = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("pointerdown", outside);
    window.addEventListener("keydown", escape);
    return () => {
      window.removeEventListener("pointerdown", outside);
      window.removeEventListener("keydown", escape);
    };
  }, [open]);

  const option = (key: string, label: string, colors: PlanPalette, selected: boolean, pick: () => void, lines = true) => (
    <button
      key={key}
      type="button"
      role="radio"
      aria-checked={selected}
      className={s.option}
      onClick={() => {
        pick();
        setOpen(false);
      }}
    >
      <Preview palette={colors} lines={lines} />
      <span>{label}</span>
    </button>
  );

  return (
    <div className={s.switch} ref={root} data-open={open}>
      <div className={s.options} role="radiogroup" aria-label="Map style" inert={!open}>
        {option("realistic", "Realistic", REALISTIC, !plan, () => onChange("realistic", palette), false)}
        {(Object.keys(PLAN_PALETTES) as PlanPaletteName[]).map((name) =>
          option(name, PALETTE_LABELS[name], PLAN_PALETTES[name], current === name, () => onChange("plan", PLAN_PALETTES[name])),
        )}
        {custom && option("custom", "Custom", custom, plan && current === null, () => onChange("plan", custom))}
      </div>
      <button
        type="button"
        className={s.button}
        aria-expanded={open}
        title={`Map style: ${plan ? (current ? PALETTE_LABELS[current] : "Custom") : "Realistic"} (M switches between realistic and plan)`}
        onClick={() => setOpen((o) => !o)}
      >
        <Preview palette={plan ? palette : REALISTIC} lines={plan} />
      </button>
    </div>
  );
}
