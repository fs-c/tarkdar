// Global styles first: they declare the cascade layers the component styles go into.
import "./styles/global.css";
import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { dropLocalStorageCaches, dropRetiredCaches } from "./model/cache";
import { App } from "./components/App";
import { PovPage } from "./components/PovPage";
import { localStorageBackend, settings } from "./persist";
import { DEFAULT_THEME_ID, applyTheme, findTheme } from "./theme";
import { startTheme } from "./theme/sync";

// The default look until the stored theme is known (just below, before the first render).
applyTheme(findTheme(DEFAULT_THEME_ID));

/** The radar, or the experimental player's view (#pov). */
function Root() {
  const [hash, setHash] = useState(location.hash);
  useEffect(() => {
    const changed = () => setHash(location.hash);
    addEventListener("hashchange", changed);
    return () => removeEventListener("hashchange", changed);
  }, []);
  return hash === "#pov" ? <PovPage /> : <App />;
}

dropLocalStorageCaches();
void dropRetiredCaches();

// Stored settings are read synchronously once loaded (instant from localStorage).
void settings.init(localStorageBackend()).then(() => {
  startTheme();
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <Root />
    </StrictMode>,
  );
});
