// The importance level, everywhere one is shown or set (tier headers, watch entries, Settings →
// Markers): four markers growing in size, the fourth ringed, the current one in its colour. The
// marker alone (LevelGlyph) stands for a level where it can't be changed (the watch bar's chips).

import { LEVELS, LEVEL_HINT, LEVEL_TEXT, type Level, levelRank } from "../watch/levels";
import s from "./LevelPicker.module.css";

const RADIUS = [1.8, 2.8, 4, 3.3];

/** What a level looks like on the map: size, and a ring at Top. */
export function LevelGlyph({ level, color = "currentColor", dim = false }: { level: Level; color?: string; dim?: boolean }) {
  const i = levelRank(level);
  return (
    <svg className={s.glyph} width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
      <circle cx="7" cy="7" r={RADIUS[i]} fill={color} opacity={dim || i === 0 ? 0.7 : 1} />
      {i === 3 && <circle cx="7" cy="7" r="6.1" fill="none" stroke={color} strokeWidth="1.4" />}
    </svg>
  );
}

interface Props {
  level: Level;
  /** The current level's colour (the entry's, the tier's). */
  color: string;
  onChange: (level: Level) => void;
  /** What it sets, for the tooltips ("PMCs", "LEDX"). */
  label: string;
  /** Clicking the current level again (tier headers: opens the colour). */
  onCurrent?: () => void;
}

export function LevelPicker({ level, color, onChange, label, onCurrent }: Props) {
  return (
    <span className={s.picker} role="radiogroup" aria-label={`${label}: level`} onClick={(e) => e.stopPropagation()}>
      {LEVELS.map((l) => (
        <button
          key={l}
          type="button"
          role="radio"
          aria-checked={l === level}
          className={s.level}
          title={`${LEVEL_TEXT[l]}: ${LEVEL_HINT[l]}`}
          onClick={() => (l === level ? onCurrent?.() : onChange(l))}
        >
          <LevelGlyph level={l} color={l === level ? color : "#56626b"} />
        </button>
      ))}
    </span>
  );
}
