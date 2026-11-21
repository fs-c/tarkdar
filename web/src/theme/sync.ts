// Wires the theme to the page and the settings. Called once by main.tsx, after the settings are
// loaded and before the first render, so the first paint is in the stored theme.

import { settings } from "../persist";
import { themeStore } from "../persist/prefs";
import { applyTheme } from "./apply";
import { getTheme, setTheme, subscribe } from "./current";
import { clearTextWidths } from "./font";

/** Applies the stored theme, and from then on every change of it (this tab's, another's). Returns the stop. */
export function startTheme(): () => void {
  const apply = () => {
    applyTheme(getTheme());
    clearTextWidths();
  };
  const stops = [subscribe(apply), settings.subscribe(themeStore, () => setTheme(settings.get(themeStore).id))];
  setTheme(settings.get(themeStore).id);
  apply();
  // A font that finishes loading changes the widths of the texts.
  document.fonts?.addEventListener("loadingdone", clearTextWidths);
  void document.fonts?.ready.then(clearTextWidths);
  return () => {
    stops.forEach((s) => s());
    document.fonts?.removeEventListener("loadingdone", clearTextWidths);
  };
}
