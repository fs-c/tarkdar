import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_THEME_ID, THEMES, applyTheme, canvasFont, findTheme, getTheme, setTheme, subscribe, themeVariables } from "./index";
import { themeStore } from "../persist/prefs";

afterEach(() => setTheme(DEFAULT_THEME_ID));

describe("theme store", () => {
  it("starts on the default and doesn't tell subscribers about a switch to the same theme", () => {
    const listener = vi.fn();
    const stop = subscribe(listener);
    expect(getTheme().id).toBe(DEFAULT_THEME_ID);
    setTheme(DEFAULT_THEME_ID);
    expect(listener).not.toHaveBeenCalled();
    stop();
  });

  it("takes an unknown id (such as the dropped amber and light themes) for the default", () => {
    setTheme("amber");
    expect(getTheme().id).toBe(DEFAULT_THEME_ID);
    setTheme("light");
    expect(getTheme().id).toBe(DEFAULT_THEME_ID);
    expect(findTheme(undefined).id).toBe(DEFAULT_THEME_ID);
  });

  it("has unique ids, and a stored unknown id is the default", () => {
    expect(new Set(THEMES.map((t) => t.id)).size).toBe(THEMES.length);
    expect(themeStore.normalize({ id: "amber" })).toEqual({ id: DEFAULT_THEME_ID });
    expect(themeStore.normalize({ id: "gone" })).toEqual({ id: DEFAULT_THEME_ID });
    expect(themeStore.normalize(null)).toEqual({ id: DEFAULT_THEME_ID });
  });
});

describe("applyTheme", () => {
  it("writes colours, canvas colours, fonts and the colour scheme as CSS variables", () => {
    const written = new Map<string, string>();
    const root = { style: { setProperty: (name: string, value: string) => void written.set(name, value) } };
    const dark = findTheme(DEFAULT_THEME_ID);
    applyTheme(dark, root);
    const get = (name: string) => written.get(name);
    expect(get("--bg")).toBe(dark.colors.bg);
    expect(get("--border-strong")).toBe(dark.colors.borderStrong);
    expect(get("--swatch-ring")).toBe(dark.colors.swatchRing);
    expect(get("--canvas-label-halo")).toBe(dark.canvas.labelHalo);
    expect(get("--font")).toBe(dark.fonts.ui);
    expect(get("--mono")).toBe(dark.fonts.mono);
    expect(get("--font-canvas")).toBe(dark.fonts.canvas);
    expect(get("--color-scheme")).toBe("dark");
  });

  it("writes every token of every theme", () => {
    for (const t of THEMES) {
      const vars = themeVariables(t);
      expect(Object.keys(vars)).toHaveLength(4 + Object.keys(t.colors).length + Object.keys(t.canvas).length);
      expect(Object.keys(vars)).toEqual(Object.keys(themeVariables(findTheme(DEFAULT_THEME_ID)))); // same tokens in each
    }
  });
});

describe("the default theme", () => {
  it("is dark, with the amber accent", () => {
    const t = findTheme(DEFAULT_THEME_ID);
    expect(t.colorScheme).toBe("dark");
    expect(t.colors.accent).toBe("#ffb547");
    expect(t.fonts).toEqual({ ui: "system-ui, sans-serif", mono: 'ui-monospace, "SF Mono", Menlo, Consolas, monospace', canvas: "sans-serif" });
  });
});

describe("canvas fonts", () => {
  it("are size, weight and the theme's family in one string", () => {
    expect(canvasFont({ size: 11 })).toBe("11px sans-serif");
    expect(canvasFont({ size: 12, bold: true })).toBe("bold 12px sans-serif");
    expect(canvasFont({ size: 12 }, "system-ui, sans-serif")).toBe("12px system-ui, sans-serif");
    expect(canvasFont({ size: 10 })).toBe(`10px ${getTheme().fonts.canvas}`);
  });
});
