// A theme as CSS custom properties on the page: colours (--bg, --border-strong, ...), the canvas's
// (--canvas-label, ...), fonts (--font, --mono, --font-canvas) and --color-scheme. CSS never has a
// raw colour or font family: it uses these.

import type { Theme } from "./themes";

const kebab = (s: string) => s.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);

export function themeVariables(theme: Theme): Record<string, string> {
  const vars: Record<string, string> = {
    "--color-scheme": theme.colorScheme,
    "--font": theme.fonts.ui,
    "--mono": theme.fonts.mono,
    "--font-canvas": theme.fonts.canvas,
  };
  for (const [k, v] of Object.entries(theme.colors)) vars[`--${kebab(k)}`] = v;
  for (const [k, v] of Object.entries(theme.canvas)) vars[`--canvas-${kebab(k)}`] = v;
  return vars;
}

export function applyTheme(theme: Theme, root: { style: Pick<CSSStyleDeclaration, "setProperty"> } = document.documentElement): void {
  for (const [name, value] of Object.entries(themeVariables(theme))) root.style.setProperty(name, value);
}
