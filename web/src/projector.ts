// World position -> screen position, through the map's current camera (map3d/Map3D). The markers
// (render.ts) and the hit test (pick.ts) only know this.

import type { WorldPos } from "./protocol";

export interface Projector {
  /** Canvas size in CSS pixels. */
  width: number;
  height: number;
  /**
   * Screen position (CSS pixels) of a world position. [NaN, NaN] when it has none (behind the
   * camera): bounds checks fail on NaN and Canvas ignores NaN coordinates, so callers need no
   * special case.
   */
  toScreen(pos: WorldPos): [number, number];
  /** Screen pixels per metre around a world position. */
  pxPerMetre(pos: WorldPos): number;
  /**
   * How closely the view is zoomed in, for deciding which labels to show: screen pixels per metre
   * at the centre of the view, divided by 4 (map3d/Map3D, DETAIL_PX_PER_METRE).
   */
  detail: number;
  /** Distance from the camera (any unit, larger is further), for drawing far before near. */
  depth?(pos: WorldPos): number;
}
