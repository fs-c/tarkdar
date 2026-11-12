// World position -> screen position. The markers (render.ts) and the hit test (pick.ts) only know
// this, so they work the same over the 2D map image and over the 3D map.

import { type Affine, pixelsPerMetre, worldToPixel } from "./calibration";
import type { WorldPos } from "./protocol";
import type { View } from "./view";

export interface Projector {
  /** Canvas size in CSS pixels. */
  width: number;
  height: number;
  /**
   * Screen position (CSS pixels) of a world position. [NaN, NaN] when it has none (behind a 3D
   * camera): bounds checks fail on NaN and Canvas ignores NaN coordinates, so callers need no
   * special case.
   */
  toScreen(pos: WorldPos): [number, number];
  /** Screen pixels per metre around a world position. */
  pxPerMetre(pos: WorldPos): number;
  /**
   * How closely the view is zoomed in, for deciding which labels to show: the 2D view's zoom
   * (screen pixels per map-image pixel); the 3D view reports a comparable number.
   */
  detail: number;
  /** Distance from the camera (any unit, larger is further), for drawing far before near; 3D only. */
  depth?(pos: WorldPos): number;
}

/** The 2D map: world x/z through the map's calibration, then the pan/zoom camera. */
export function flatProjector(view: View, t: Affine): Projector {
  const scale = pixelsPerMetre(t) * view.zoom;
  return {
    width: view.width,
    height: view.height,
    toScreen: (pos) => view.toScreen(...worldToPixel(t, pos[0], pos[2])),
    pxPerMetre: () => scale,
    detail: view.zoom,
  };
}
