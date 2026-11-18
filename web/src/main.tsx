// Global styles first: they declare the cascade layers the component styles go into.
import "./styles/global.css";
import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./components/App";
import { PovPage } from "./components/PovPage";
import { applyTheme } from "./theme";

applyTheme();

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

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
