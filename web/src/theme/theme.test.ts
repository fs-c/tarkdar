import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_THEME_ID, THEMES, applyTheme, canvasFont, findTheme, getTheme, setTheme, subscribe, themeVariables } from "./index";
import { themeStore } from "../persist/prefs";

afterEach(() => setTheme(DEFAULT_THEME_ID));

describe("theme store", () => {
  it("starts on the default, switches by id and tells subscribers once per change", () => {
    const listener = vi.fn();
    const stop = subscribe(listener);
    expect(getTheme().id).toBe(DEFAULT_THEME_ID);
    setTheme("light");
    expect(getTheme().id).toBe("light");
    setTheme("light");
    expect(listener).toHaveBeenCalledTimes(1);
    stop();
    setTheme("amber");
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("takes an unknown id for the default", () => {
    setTheme("amber");
    setTheme("no-such-theme");
    expect(getTheme().id).toBe(DEFAULT_THEME_ID);
    expect(findTheme(undefined).id).toBe(DEFAULT_THEME_ID);
  });

  it("has unique ids, and a stored unknown id is the default", () => {
    expect(new Set(THEMES.map((t) => t.id)).size).toBe(THEMES.length);
    expect(themeStore.normalize({ id: "amber" })).toEqual({ id: "amber" });
    expect(themeStore.normalize({ id: "gone" })).toEqual({ id: DEFAULT_THEME_ID });
    expect(themeStore.normalize(null)).toEqual({ id: DEFAULT_THEME_ID });
  });
});

describe("applyTheme", () => {
  it("writes colours, canvas colours, fonts and the colour scheme as CSS variables", () => {
    const written = new Map<string, string>();
    const root = { style: { setProperty: (name: string, value: string) => void written.set(name, value) } };
    const light = findTheme("light");
    applyTheme(light, root);
    const get = (name: string) => written.get(name);
    expect(get("--bg")).toBe(light.colors.bg);
    expect(get("--border-strong")).toBe(light.colors.borderStrong);
    expect(get("--swatch-ring")).toBe(light.colors.swatchRing);
    expect(get("--canvas-label-halo")).toBe(light.canvas.labelHalo);
    expect(get("--font")).toBe(light.fonts.ui);
    expect(get("--mono")).toBe(light.fonts.mono);
    expect(get("--font-canvas")).toBe(light.fonts.canvas);
    expect(get("--color-scheme")).toBe("light");
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
  it("is the look from before there were themes", () => {
    const t = findTheme(DEFAULT_THEME_ID);
    expect(t.colorScheme).toBe("dark");
    expect(t.fonts).toEqual({ ui: "system-ui, sans-serif", mono: 'ui-monospace, "SF Mono", Menlo, Consolas, monospace', canvas: "sans-serif" });
    expect(t.colors).toEqual({
      chrome: "#0b0f13", bg: "#11161c", surface: "#141a20", raised: "#1b232b", hover: "#1f2830", control: "#2b3742",
      overlay: "rgba(11, 15, 19, 0.88)", overlaySurface: "rgba(20, 26, 32, 0.95)", shadow: "rgba(0, 0, 0, 0.4)", swatchRing: "rgba(0, 0, 0, 0.35)",
      border: "#26313b", borderStrong: "#33424f", borderHover: "#46596a",
      text: "#e3e9ee", muted: "#94a3af", faint: "#66757f",
      accent: "#4cd964", accentSoft: "rgba(76, 217, 100, 0.16)", accentText: "#8ff0a4", onAccent: "#062b10",
      link: "#4aa3ff", linkSoft: "rgba(74, 163, 255, 0.18)", linkLine: "rgba(74, 163, 255, 0.5)", linkText: "#8cc4ff", linkHover: "#7cbcff", onLink: "#06223f",
      warn: "#ff9f40", danger: "#ff5a52", dangerText: "#ffb3ae", gold: "#f5c542", goldBase: "#a8915a", quest: "#ffd84d", secret: "#e45cff",
      warnBar: "#3a1f12", warnBarText: "#ffd2b0",
    });
    expect(t.canvas).toEqual({
      label: "#e8eef2", labelHalo: "rgba(8, 12, 16, 0.85)", selection: "#ffffff", hoverFill: "rgba(255, 255, 255, 0.18)",
      outline: "#000", bodyOutline: "rgba(0, 0, 0, 0.85)", grid: "#1f2a33", gridMajor: "#2b3945",
    });
  });
});

describe("canvas fonts", () => {
  it("are size, weight and the theme's family in one string", () => {
    expect(canvasFont({ size: 11 })).toBe("11px sans-serif");
    expect(canvasFont({ size: 12, bold: true })).toBe("bold 12px sans-serif");
    expect(canvasFont({ size: 12 }, "system-ui, sans-serif")).toBe("12px system-ui, sans-serif");
    setTheme("amber");
    expect(canvasFont({ size: 10 })).toBe(`10px ${getTheme().fonts.canvas}`);
  });
});
