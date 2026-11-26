// The built-in themes. A theme is one plain object: the UI's colours, the canvas's colours that aren't
// rules, the fonts and the shadow colour. Rule colours (rules/defaults.ts) and the 3D map's plan
// palettes (map3d/settings.ts) are not part of it. To add a theme: write an object here and list it
// in THEMES.

/** Chrome: surfaces, borders, text and the accents. Each becomes a CSS variable (`panelRaised` -> --panel-raised). */
export interface ChromeColors {
  // surfaces, darkest to lightest (in a light theme: the other way round)
  chrome: string; // activity bar, status bar, inputs
  bg: string; // the map's background (the page behind the 3D map)
  surface: string; // side panel
  raised: string; // headers, buttons
  hover: string;
  press: string; // pressed and selected controls, a step above hover
  control: string; // switch track, count badges
  overlay: string; // floating buttons over the map
  overlaySurface: string; // frosted glass: the control plane around the map, and the panels and menus over it
  shadow: string; // the colour of every shadow (--shadow-float, --shadow-pop)
  swatchRing: string; // the thin ring around a rule's colour swatch

  border: string;
  borderStrong: string;
  borderHover: string;

  text: string;
  muted: string;
  faint: string;

  accent: string;
  accentSoft: string;
  accentText: string;
  onAccent: string;

  link: string;
  linkSoft: string;
  linkLine: string;
  linkText: string;
  linkHover: string;
  onLink: string;

  warn: string;
  danger: string;
  dangerText: string;
  gold: string;
  goldBase: string;
  quest: string;
  secret: string;
}

/** What the canvases draw that no rule colours. Plain "#rrggbb" for `grid` and `gridMajor` (WebGL); the rest any CSS colour. */
export interface CanvasColors {
  label: string; // label text without a colour of its own
  labelHalo: string; // the outline that keeps a label readable over the map
  selection: string; // the selected and hovered marker's ring, and the marked ones
  hoverFill: string;
  outline: string; // the ring around a player's marker
  bodyOutline: string; // the outline around a player's figure
  grid: string; // the 3D map's grid when a map has no model
  gridMajor: string;
}

export interface Fonts {
  ui: string; // CSS font-family lists
  mono: string;
  canvas: string; // marker labels on the canvas
}

export interface Theme {
  /** Stored in the settings: never change one. */
  id: string;
  /** Shown in Settings. */
  name: string;
  /** Native controls (scrollbars, checkboxes, colour inputs) follow it. */
  colorScheme: "dark" | "light";
  fonts: Fonts;
  colors: ChromeColors;
  canvas: CanvasColors;
}

/** The one theme: dark glass over the map, an amber accent. (There were amber and light ones too; dropped with the UX rework.) */
const dark: Theme = {
  id: "dark",
  name: "Dark",
  colorScheme: "dark",
  fonts: {
    ui: "system-ui, sans-serif",
    mono: 'ui-monospace, "SF Mono", Menlo, Consolas, monospace',
    canvas: "sans-serif",
  },
  colors: {
    chrome: "#0b0f13",
    bg: "#11161c",
    surface: "rgba(19, 23, 27, 0.9)",
    raised: "rgba(255, 255, 255, 0.06)",
    hover: "rgba(255, 255, 255, 0.05)",
    press: "rgba(255, 255, 255, 0.09)",
    control: "rgba(255, 255, 255, 0.11)",
    overlay: "rgba(19, 23, 27, 0.86)",
    overlaySurface: "rgba(11, 15, 19, 0.82)",
    shadow: "rgba(0, 0, 0, 0.45)",
    swatchRing: "rgba(0, 0, 0, 0.35)",

    border: "rgba(255, 255, 255, 0.07)",
    borderStrong: "rgba(255, 255, 255, 0.13)",
    borderHover: "rgba(255, 255, 255, 0.24)",

    text: "#e3e9ee",
    muted: "#94a3af",
    faint: "#66757f",

    accent: "#ffb547",
    accentSoft: "rgba(255, 181, 71, 0.14)",
    accentText: "#ffc978",
    onAccent: "#1d1405",

    link: "#ffb547",
    linkSoft: "rgba(255, 181, 71, 0.14)",
    linkLine: "rgba(255, 181, 71, 0.45)",
    linkText: "#ffc978",
    linkHover: "#ffc978",
    onLink: "#1d1405",

    warn: "#ff9f40",
    danger: "#ff5a52",
    dangerText: "#ffb3ae",
    gold: "#f5c542",
    goldBase: "#a8915a",
    quest: "#ffd84d",
    secret: "#e45cff",
  },
  canvas: {
    label: "#e8eef2",
    labelHalo: "rgba(8, 12, 16, 0.85)",
    selection: "#ffffff",
    hoverFill: "rgba(255, 255, 255, 0.18)",
    outline: "#000",
    bodyOutline: "rgba(0, 0, 0, 0.85)",
    grid: "#1f2a33",
    gridMajor: "#2b3945",
  },
};

export const DEFAULT_THEME_ID = dark.id;

/** The presets, in the order Settings lists them. */
export const THEMES: readonly Theme[] = [dark];

export const THEME_IDS: readonly string[] = THEMES.map((t) => t.id);

/** The theme with this id; the default for an unknown one. */
export const findTheme = (id: unknown): Theme => THEMES.find((t) => t.id === id) ?? THEMES[0]!;
