// Settings view of the side panel: the overlay, then debugging tools (DebugPanel). (How the map looks: MapPanel.)

import type { OverlayPrefs } from "../overlay/marks";
import { DebugSections, type DebugProps } from "./DebugPanel";
import { PanelBody, Section, SliderRow, ToggleRow } from "../ui";
import type { SetStored } from "../persist";

interface Props {
  /** The overlay: whether the backend runs it, its settings, and how many things it's told to mark. */
  overlay: { available: boolean; prefs: OverlayPrefs; onPrefs: SetStored<OverlayPrefs>; marks: number | null };
  debug: DebugProps;
}

export function SettingsPanel(p: Props) {
  return (
    <PanelBody>
      <OverlaySection {...p.overlay} />
      <DebugSections {...p.debug} />
    </PanelBody>
  );
}

/** The overlay's settings. They configure the backend's overlay window; the radar doesn't use them. */
function OverlaySection({ available, prefs, onPrefs, marks }: Props["overlay"]) {
  const set = <K extends keyof OverlayPrefs>(key: K, value: OverlayPrefs[K]) => onPrefs((o) => ({ ...o, [key]: value }));
  return (
    <Section title="Overlay">
      <p className="muted">
        The player's view drawn by the backend in a transparent window over the game&apos;s picture (Wayland: KDE Plasma,
        wlroots compositors). It marks what the map shows, as the rules style it: players, exfils, and loot that stands
        out.
      </p>
      {!available ? (
        <p className="muted">Not running: start radar-backend with --overlay.</p>
      ) : (
        <>
          <ToggleRow
            label="Show the overlay"
            hint={prefs.on ? `Configured from this browser${marks !== null ? `: ${marks} marked` : ""}` : "Settings from this browser; the last browser to change them wins"}
            checked={prefs.on}
            onChange={() => set("on", !prefs.on)}
          />
          <ToggleRow label="Other players" hint="Players the rules don't mark yet, in white" checked={prefs.otherPlayers} onChange={() => set("otherPlayers", !prefs.otherPlayers)} />
          <ToggleRow label="Ground grid" hint="For checking the alignment" checked={prefs.grid} onChange={() => set("grid", !prefs.grid)} />
          <SliderRow label="Delay (s)" value={prefs.delayMs / 1000} min={0} max={0.15} step={0.005} onChange={(v) => set("delayMs", Math.round(v * 1000))} />
          <SliderRow label="Loot range (km)" value={prefs.lootRange / 1000} min={0.01} max={0.5} step={0.01} onChange={(v) => set("lootRange", Math.round(v * 1000))} />
          <SliderRow label="Scope circle" value={prefs.scopeRadius} min={0.1} max={0.5} step={0.01} onChange={(v) => set("scopeRadius", v)} />
          <p className="muted">
            Delay: if marks run ahead of the picture as you turn, raise it until they stay on their targets. Scope circle: the
            size of the scope&apos;s picture (share of the screen height); marks inside it are placed through the scope.
          </p>
        </>
      )}
    </Section>
  );
}
