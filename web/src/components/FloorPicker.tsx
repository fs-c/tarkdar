import { ChevronDown, ChevronUp } from "lucide-react";
import { cx } from "../ui";
import f from "./Floating.module.css";
import s from "./Radar.module.css";

interface Props {
  /** The height picked by hand; null: the local player's floor. */
  picked: number | null;
  onStep: (direction: 1 | -1) => void;
  onAuto: () => void;
}

/** Indoor maps: the floor buttons (also Page Up / Page Down). */
export function FloorPicker({ picked, onStep, onAuto }: Props) {
  return (
    <div className={cx(f.surface, f.aboveCorner, s.floor)} onPointerDown={(e) => e.stopPropagation()} onPointerUp={(e) => e.stopPropagation()}>
      <button title="Show a higher floor (Page Up)" onClick={() => onStep(1)}>
        <ChevronUp size={18} />
      </button>
      <button
        className={s.floorLevel}
        disabled={picked === null}
        title={picked === null ? "The map is cut open at your floor" : "Showing the floor at this height: click to follow your floor again"}
        onClick={onAuto}
      >
        {picked === null ? "Auto" : `${picked} m`}
      </button>
      <button title="Show a lower floor (Page Down)" onClick={() => onStep(-1)}>
        <ChevronDown size={18} />
      </button>
    </div>
  );
}
