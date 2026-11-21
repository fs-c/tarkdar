import { useRef, useState } from "react";
import type { Map3D } from "../map3d/Map3D";
import type { Scene } from "../draw/render";

/** Indoor maps: the floor shown follows the local player once they are this far (metres) above or below it. */
const FLOOR_FOLLOW = 0.4;
/**
 * A floor shown this long (ms) is one the player stood on, not a step on the stairs: arriving
 * within FLOOR_FOLLOW of it later shows it again at exactly that height, which the map has kept.
 */
const FLOOR_SETTLED = 1000;
/** Floors remembered so, the latest last. */
const FLOOR_MEMORY = 8;
/** ... and the buttons move it by this much. */
const FLOOR_STEP = 1;

/**
 * Indoor maps are cut open at one floor: the local player's, or one picked by hand (a height).
 * `follow` runs in Radar's every-render layout effect; `reset` when a map is (re)created.
 */
export function useFloorFollow(mapRef: { readonly current: Map3D | null }) {
  const [interior, setInterior] = useState(false);
  const [pickedFloor, setPickedFloor] = useState<number | null>(null);
  const playerFloor = useRef<number | null>(null);
  const floorSince = useRef(0);
  const settledFloors = useRef<number[]>([]);

  /** A new map: no floor picked, none followed yet. */
  const reset = () => {
    setInterior(false);
    setPickedFloor(null);
    playerFloor.current = null;
    settledFloors.current = [];
  };

  /** Cuts the map open at the floor to show (the picked one, else the local player's). */
  const follow = (map: Map3D | null, scene: Scene) => {
    if (map?.loaded && interior) {
      // Not every step of a staircase: only once they have left the floor shown.
      const y = scene.players.find((p) => p.local && p.pos)?.pos?.[1];
      const now = performance.now();
      const shown = playerFloor.current;
      const settled = settledFloors.current;
      if (shown !== null && now - floorSince.current >= FLOOR_SETTLED && !settled.includes(shown)) {
        settled.push(shown);
        if (settled.length > FLOOR_MEMORY) settled.shift();
      }
      if (y === undefined) playerFloor.current = null;
      else if (shown === null || Math.abs(y - shown) > FLOOR_FOLLOW) {
        const near = settled.filter((f) => Math.abs(y - f) <= FLOOR_FOLLOW).sort((a, b) => Math.abs(y - a) - Math.abs(y - b));
        playerFloor.current = near[0] ?? y;
        floorSince.current = now;
      }
      map.setFloor(pickedFloor ?? playerFloor.current);
    }
  };

  /** One step up or down from the floor shown; from the whole map, down from its top. */
  const stepFloor = (direction: 1 | -1) => {
    const range = mapRef.current?.heights();
    if (!range) return;
    setPickedFloor((picked) => {
      const from = picked ?? playerFloor.current ?? range[1];
      return Math.min(range[1], Math.max(range[0], Math.round(from) + direction * FLOOR_STEP));
    });
  };

  return { interior, setInterior, pickedFloor, setPickedFloor, reset, follow, stepFloor };
}
