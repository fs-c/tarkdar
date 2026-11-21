// A stand-in camera for tests.

import type { Projector } from "./projector";

/**
 * Straight down, north up, `pxPerMetre` screen pixels per metre, world (0, 0) at the centre of a
 * `width` × `height` view. Its detail is the 3D map's for that scale (Map3D's DETAIL_PX_PER_METRE).
 */
export function topDownProjector(width: number, height: number, pxPerMetre: number): Projector {
  return {
    width,
    height,
    toScreen: (pos) => [width / 2 + pos[0] * pxPerMetre, height / 2 - pos[2] * pxPerMetre],
    pxPerMetre: () => pxPerMetre,
    detail: pxPerMetre / 4,
  };
}
