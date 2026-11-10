// The colour palette: the single source for both the UI (as CSS custom properties, see applyTheme)
// and the canvas (render.ts COLORS). CSS never uses raw colours; it uses var(--<kebab-case key>).

export const ui = {
  // surfaces, darkest to lightest
  chrome: "#0b0f13", // activity bar, status bar, inputs
  bg: "#11161c", // the map's background
  surface: "#141a20", // side panel
  raised: "#1b232b", // headers, buttons
  hover: "#1f2830",
  control: "#2b3742", // switch track, count badges
  overlay: "rgba(11, 15, 19, 0.88)", // floating buttons over the map
  overlaySurface: "rgba(20, 26, 32, 0.95)", // floating panels over the map
  shadow: "rgba(0, 0, 0, 0.4)",

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

  // status bar modes
  warnBar: "#3a1f12",
  warnBarText: "#ffd2b0",
  replayBar: "#0f2740",
  replayBarLine: "#24476a",
  replayBarText: "#b9d7f5",
  replayBarStrong: "#e3f0fc",
} as const;

export type UiColor = keyof typeof ui;

const kebab = (s: string) => s.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);

/** Exposes the palette as CSS custom properties (--bg, --border-strong, …). Call before the first render. */
export function applyTheme(root: HTMLElement = document.documentElement): void {
  for (const [k, v] of Object.entries(ui)) root.style.setProperty(`--${kebab(k)}`, v);
}
