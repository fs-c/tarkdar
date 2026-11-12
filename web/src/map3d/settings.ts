// Display settings of the 3D map. Separate from Map3D.ts so that using them does not pull the
// renderer (three.js) into the main bundle.

/**
 * How material colours from the game are turned into map colours. The game's colours are
 * albedo-texture means: dark on average (median luma ~0.3) and uneven, so they are lifted and
 * compressed into a narrower, lighter range. Applied in the shader: changing it costs one frame.
 */
export interface ColorGrade {
  /** Light on the whole scene (tone-mapping exposure). */
  exposure: number;
  /** Output luma = lift + contrast * input luma (sRGB, 0..1); the hue is kept. */
  lift: number;
  contrast: number;
  /** 0 = grey, 1 = as in the game. */
  saturation: number;
  /** Extra factor for the terrain's ground image (lifted grass comes out lime green). */
  groundSaturation: number;
}

export const COLOR_SCHEMES = {
  standard: { exposure: 1.05, lift: 0.36, contrast: 0.58, saturation: 1, groundSaturation: 0.6 },
  light: { exposure: 1.15, lift: 0.5, contrast: 0.45, saturation: 0.8, groundSaturation: 0.5 },
  muted: { exposure: 1.05, lift: 0.4, contrast: 0.5, saturation: 0.45, groundSaturation: 0.6 },
  game: { exposure: 1.3, lift: 0, contrast: 1, saturation: 1, groundSaturation: 1 },
} satisfies Record<string, ColorGrade>;

export type ColorSchemeName = keyof typeof COLOR_SCHEMES;

/** The scheme a grade equals, if any. */
export function schemeOf(grade: ColorGrade): ColorSchemeName | null {
  for (const [name, scheme] of Object.entries(COLOR_SCHEMES)) {
    if ((Object.keys(scheme) as (keyof ColorGrade)[]).every((k) => scheme[k] === grade[k])) return name as ColorSchemeName;
  }
  return null;
}

/**
 * "realistic": the game's material colours, lit: what the place looks like.
 * "plan": drawn like a map: flat colours by what a thing is (floor, obstacle, building, grass,
 * water) and outlines: where things are, at a glance.
 */
export type MapStyle = "realistic" | "plan";

/**
 * The colours of the plan style, as "#rrggbb". A level surface is drawn in exactly this colour
 * (the plan style is not lit or tone mapped); walls are a little darker.
 */
export interface PlanPalette {
  /** Bare terrain. */
  ground: string;
  grass: string;
  road: string;
  water: string;
  /** Structure at floor level: pavements, slabs, floors. Varies a little with the material. */
  floor: string;
  /** Obstacles up to 2 m: what one can look over. */
  cover: string;
  /** Taller but narrow: walls, fences, containers, vehicles. */
  obstacle: string;
  /** Buildings, from 2 m (`building`) to 24 m and more (`buildingTall`). */
  building: string;
  buildingTall: string;
  tree: string;
  outline: string;
}

export const PLAN_PALETTES = {
  paper: {
    ground: "#d6d3cc", grass: "#a9c78f", road: "#a3a6ab", water: "#74aede", floor: "#c4c4c4", cover: "#7a828f",
    obstacle: "#4d5260", building: "#ead2a6", buildingTall: "#c59d72", tree: "#5c8f57", outline: "#16181c",
  },
  atlas: {
    ground: "#d4d4d2", grass: "#7fa672", road: "#9c9c9c", water: "#5aa0d8", floor: "#c0c0be", cover: "#6a6a6a",
    obstacle: "#3c3c3c", building: "#e0a860", buildingTall: "#c58540", tree: "#4f7d48", outline: "#111111",
  },
  mono: {
    ground: "#dcdcdc", grass: "#cbd3c6", road: "#b6b6b6", water: "#adc0cf", floor: "#cecece", cover: "#8c8c8c",
    obstacle: "#555555", building: "#f6f6f6", buildingTall: "#c4c4c4", tree: "#9aa89a", outline: "#1a1a1a",
  },
  night: {
    ground: "#1b232b", grass: "#223a2c", road: "#313d49", water: "#15354f", floor: "#252e37", cover: "#4a5866",
    obstacle: "#6f7e8c", building: "#6a5f4d", buildingTall: "#9a8563", tree: "#2c5638", outline: "#05070a",
  },
  midnight: {
    ground: "#4b4e53", grass: "#4c7253", road: "#33363a", water: "#3b78b0", floor: "#5b5e63", cover: "#858a91",
    obstacle: "#b4b8be", building: "#57c79a", buildingTall: "#2f9a78", tree: "#3f6b47", outline: "#101214",
  },
  blueprint: {
    ground: "#12305a", grass: "#143c5c", road: "#1c416f", water: "#0b2140", floor: "#173763", cover: "#3a66a0",
    obstacle: "#6b97cc", building: "#234e88", buildingTall: "#3a6fb3", tree: "#23607a", outline: "#8fb4e6",
  },
} satisfies Record<string, PlanPalette>;

export type PlanPaletteName = keyof typeof PLAN_PALETTES;

/** The pre-made palette these colours equal, if any (otherwise it is a custom one). */
export function paletteOf(palette: PlanPalette): PlanPaletteName | null {
  for (const [name, preset] of Object.entries(PLAN_PALETTES)) {
    if ((Object.keys(preset) as (keyof PlanPalette)[]).every((k) => preset[k] === palette[k])) return name as PlanPaletteName;
  }
  return null;
}

export interface MapSettings extends ColorGrade {
  style: MapStyle;
  /** Colours of the plan style. */
  palette: PlanPalette;
  /** Material colours (and the terrain's ground colours) instead of one colour per category. */
  colored: boolean;
  trees: boolean;
  contours: boolean;
  wireframe: boolean;
  /** Parallel projection: no perspective, buildings never lean. */
  orthographic: boolean;
  /**
   * "map": drag moves the map, right-drag tilts and turns it.
   * "wasd": W A S D move, drag tilts and turns the camera, right-drag moves the map.
   */
  controls: "map" | "wasd";
}

export const DEFAULT_MAP_SETTINGS: MapSettings = {
  style: "realistic",
  palette: PLAN_PALETTES.paper,
  colored: true,
  trees: true,
  contours: true,
  wireframe: false,
  orthographic: false,
  controls: "map",
  ...COLOR_SCHEMES.standard,
};
