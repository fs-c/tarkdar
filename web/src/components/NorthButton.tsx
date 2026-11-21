import type { Ref } from "react";
import s from "./Radar.module.css";

interface Props {
  /** The map's usual orientation (degrees at the top of the home view): 0 is north. */
  up: number;
  /** Current map heading (radians), for the needle until the next frame turns it. */
  heading: number;
  /** The needle, turned by the map's frames to point north on screen. */
  needleRef: Ref<SVGSVGElement>;
  onClick: () => void;
}

/** Shown while the map is turned away from its usual orientation: turns it back. */
export function NorthButton({ up, heading, needleRef, onClick }: Props) {
  return (
    <button
      className={s.north}
      title={`Turn the map ${up ? "back to its usual orientation" : "north up"} (stops following your view direction)`}
      onPointerDown={(e) => e.stopPropagation()}
      onPointerUp={(e) => e.stopPropagation()}
      onClick={onClick}
    >
      <svg ref={needleRef} style={{ transform: `rotate(${-heading}rad)` }} viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
        <path d="M12 2 L16 12 H8 Z" fill="var(--danger)" />
        <path d="M12 22 L8 12 H16 Z" fill="currentColor" />
      </svg>
    </button>
  );
}
