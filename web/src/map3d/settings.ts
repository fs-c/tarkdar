// Display settings of the 3D map. Separate from Map3D.ts so that using them does not pull the
// renderer (three.js) into the main bundle.

export interface MapSettings {
  /** Material colours (and the terrain's ground colours) instead of one colour per category. */
  colored: boolean;
  trees: boolean;
  contours: boolean;
  wireframe: boolean;
}

export const DEFAULT_MAP_SETTINGS: MapSettings = { colored: true, trees: true, contours: true, wireframe: false };
