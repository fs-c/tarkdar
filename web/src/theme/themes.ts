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
  control: string; // switch track, count badges
  overlay: string; // floating buttons over the map
  overlaySurface: string; // floating panels over the map
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

  // status bar: lost the backend
  warnBar: string;
  warnBarText: string;
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

/** What the app looked like before there were themes. */
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
    surface: "#141a20",
    raised: "#1b232b",
    hover: "#1f2830",
    control: "#2b3742",
    overlay: "rgba(11, 15, 19, 0.88)",
    overlaySurface: "rgba(20, 26, 32, 0.95)",
    shadow: "rgba(0, 0, 0, 0.4)",
    swatchRing: "rgba(0, 0, 0, 0.35)",

    border: "#26313b",
    borderStrong: "#33424f",
    borderHover: "#46596a",

    text: "#e3e9ee",
    muted: "#94a3af",
    faint: "#66757f",

    accent: "#4cd964",
    accentSoft: "rgba(76, 217, 100, 0.16)",
    accentText: "#8ff0a4",
    onAccent: "#062b10",

    link: "#4aa3ff",
    linkSoft: "rgba(74, 163, 255, 0.18)",
    linkLine: "rgba(74, 163, 255, 0.5)",
    linkText: "#8cc4ff",
    linkHover: "#7cbcff",
    onLink: "#06223f",

    warn: "#ff9f40",
    danger: "#ff5a52",
    dangerText: "#ffb3ae",
    gold: "#f5c542",
    goldBase: "#a8915a",
    quest: "#ffd84d",
    secret: "#e45cff",

    warnBar: "#3a1f12",
    warnBarText: "#ffd2b0",
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

/** A dark theme with an amber accent and a monospace UI. */
const amber: Theme = {
  ...dark,
  id: "amber",
  name: "Amber terminal",
  fonts: {
    ui: 'ui-monospace, "SF Mono", Menlo, Consolas, monospace',
    mono: 'ui-monospace, "SF Mono", Menlo, Consolas, monospace',
    canvas: 'ui-monospace, "SF Mono", Menlo, Consolas, monospace',
  },
  colors: {
    ...dark.colors,
    chrome: "#0d0b08",
    bg: "#141109",
    surface: "#17140c",
    raised: "#221d12",
    hover: "#2a2417",
    control: "#3a3220",
    overlay: "rgba(13, 11, 8, 0.88)",
    overlaySurface: "rgba(23, 20, 12, 0.95)",
    border: "#33291a",
    borderStrong: "#47391f",
    borderHover: "#66532c",
    text: "#efe6d2",
    muted: "#a89c80",
    faint: "#75694f",
    accent: "#ffb000",
    accentSoft: "rgba(255, 176, 0, 0.16)",
    accentText: "#ffd37a",
    onAccent: "#2b1d00",
  },
  canvas: {
    ...dark.canvas,
    label: "#f2ead8",
    labelHalo: "rgba(12, 10, 6, 0.85)",
    grid: "#2a2314",
    gridMajor: "#3a301c",
  },
};

/** Light surfaces, dark text. Labels get a light halo: markers keep the colours the rules give them. */
const light: Theme = {
  id: "light",
  name: "Light",
  colorScheme: "light",
  fonts: {
    ui: '"Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
    mono: 'ui-monospace, "SF Mono", Menlo, Consolas, monospace',
    canvas: '"Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
  },
  colors: {
    chrome: "#e1e6eb",
    bg: "#e9edf1",
    surface: "#f5f7f9",
    raised: "#e8edf1",
    hover: "#dce3e9",
    control: "#c3ced8",
    overlay: "rgba(245, 247, 249, 0.9)",
    overlaySurface: "rgba(255, 255, 255, 0.96)",
    shadow: "rgba(20, 30, 40, 0.25)",
    swatchRing: "rgba(0, 0, 0, 0.35)",

    border: "#d0d8df",
    borderStrong: "#b8c3cd",
    borderHover: "#8fa0ae",

    text: "#1c2630",
    muted: "#4f5f6d",
    faint: "#7a8996",

    accent: "#1f9d3a",
    accentSoft: "rgba(31, 157, 58, 0.14)",
    accentText: "#17782c",
    onAccent: "#ffffff",

    link: "#1a6fd1",
    linkSoft: "rgba(26, 111, 209, 0.14)",
    linkLine: "rgba(26, 111, 209, 0.5)",
    linkText: "#14589f",
    linkHover: "#2a7fe0",
    onLink: "#ffffff",

    warn: "#c76a00",
    danger: "#d63a32",
    dangerText: "#a82822",
    gold: "#a67c00",
    goldBase: "#8a7440",
    quest: "#a88a00",
    secret: "#b020d0",

    warnBar: "#ffe3cc",
    warnBarText: "#6b3200",
  },
  canvas: {
    label: "#1b232b",
    labelHalo: "rgba(255, 255, 255, 0.85)",
    selection: "#11161c",
    hoverFill: "rgba(0, 0, 0, 0.12)",
    outline: "#000",
    bodyOutline: "rgba(0, 0, 0, 0.85)",
    grid: "#d5dce2",
    gridMajor: "#c2ccd5",
  },
};

export const DEFAULT_THEME_ID = dark.id;

/** The presets, in the order Settings lists them. */
export const THEMES: readonly Theme[] = [dark, amber, light];

export const THEME_IDS: readonly string[] = THEMES.map((t) => t.id);

/** The theme with this id; the default for an unknown one. */
export const findTheme = (id: unknown): Theme => THEMES.find((t) => t.id === id) ?? THEMES[0]!;
