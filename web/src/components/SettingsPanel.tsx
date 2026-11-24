// Settings view of the side panel, as tabs: Markers (how the tiers and loot look), Map (the 3D map's
// look and trails: MapPanel), Quests (owned items, imported quests), Overlay (deprecated), Keys,
// Status (connection, game, data), Debug (DebugPanel).

import type { ComponentProps } from "react";
import type { OverlayPrefs } from "../overlay/marks";
import { DebugSections, type DebugProps } from "./DebugPanel";
import { MapPanel } from "./MapPanel";
import { QuestSettings } from "./QuestSettings";
import { LevelPicker } from "./LevelPicker";
import { PanelBody, Section, Segmented, SliderRow, ToggleRow } from "../ui";
import type { SetStored } from "../persist";
import { formatPrice } from "../model/items";
import { ORDINARY_CHOICES, VALUABLE_CHOICES, type MarkerPrefs } from "../watch/prefs";
import { TIERS, TIER_ORDER } from "../watch/tiers";
import s from "./SettingsPanel.module.css";

export type SettingsTab = "markers" | "map" | "quests" | "overlay" | "keys" | "status" | "debug";

const TABS: { id: SettingsTab; label: string }[] = [
  { id: "markers", label: "Markers" },
  { id: "map", label: "Map" },
  { id: "quests", label: "Quests" },
  { id: "overlay", label: "Overlay" },
  { id: "keys", label: "Keys" },
  { id: "status", label: "Status" },
  { id: "debug", label: "Debug" },
];

/** One line of Settings → Status: how something is, and what to do about it. */
export interface StatusLine {
  label: string;
  tone: "ok" | "info" | "warn" | "error" | "off";
  text: string;
  action?: { label: string; run: () => void };
}

interface Props {
  tab: SettingsTab;
  onTab: (tab: SettingsTab) => void;
  markers: MarkerPrefs;
  setMarkers: SetStored<MarkerPrefs>;
  map: ComponentProps<typeof MapPanel>;
  quests: ComponentProps<typeof QuestSettings>;
  /** The overlay: whether the backend runs it, its settings, and how many things it's told to mark. */
  overlay: { available: boolean; prefs: OverlayPrefs; onPrefs: SetStored<OverlayPrefs>; marks: number | null };
  status: StatusLine[];
  debug: DebugProps;
}

const KEYS: [string[], string][] = [
  [["/"], "Watch something"],
  [["L"], "Open the panel's filter, or close the panel"],
  [["F"], "Follow you, or stop"],
  [["M"], "Realistic or plan map"],
  [["Space"], "Play or pause"],
  [["[", "]"], "Back or forward 10 s"],
  [["PgUp", "PgDn"], "Floor up or down"],
  [["+", "−", "0"], "Zoom in, out, reset"],
  [["Esc"], "Deselect"],
];

export function SettingsPanel(p: Props) {
  const warn = p.status.some((l) => l.tone === "warn" || l.tone === "error");
  return (
    <PanelBody>
      <div className={s.tabs} role="tablist">
        {TABS.map((t) => (
          <button key={t.id} type="button" role="tab" aria-selected={p.tab === t.id} className={s.tab} onClick={() => p.onTab(t.id)}>
            {t.label}
            {t.id === "status" && warn && <span className={s.warnDot} />}
          </button>
        ))}
      </div>
      {p.tab === "markers" && <MarkersTab markers={p.markers} setMarkers={p.setMarkers} />}
      {p.tab === "map" && <MapPanel {...p.map} />}
      {p.tab === "quests" && <QuestSettings {...p.quests} />}
      {p.tab === "overlay" && (
        <>
          <div className={s.callout}>
            <b>Deprecated</b> The overlay isn&apos;t maintained and will be removed. Its settings still work for now.
          </div>
          <OverlaySection {...p.overlay} />
        </>
      )}
      {p.tab === "keys" && (
        <Section title="Keys">
          {KEYS.map(([keys, what]) => (
            <div key={what} className={s.key}>
              <span>
                {keys.map((k) => (
                  <kbd key={k}>{k}</kbd>
                ))}
              </span>
              <span>{what}</span>
            </div>
          ))}
        </Section>
      )}
      {p.tab === "status" && (
        <Section title="Status">
          {p.status.map((l) => (
            <div key={l.label} className={s.status}>
              <span className={s.dot} data-tone={l.tone} />
              <span className={s.statusLabel}>{l.label}</span>
              <span className={s.statusText}>{l.text}</span>
              {l.action && (
                <button type="button" className={s.statusAction} onClick={l.action.run}>
                  {l.action.label}
                </button>
              )}
            </div>
          ))}
        </Section>
      )}
      {p.tab === "debug" && <DebugSections {...p.debug} />}
    </PanelBody>
  );
}

/** How the tiers' players and loot look: each tier's level (its colour: the Players view's headers),
 *  and from which value per slot loot counts as valuable, or ordinary. */
function MarkersTab({ markers, setMarkers }: { markers: MarkerPrefs; setMarkers: SetStored<MarkerPrefs> }) {
  return (
    <>
      <Section title="Players">
        {TIER_ORDER.map((t) => {
          const { level, color } = markers.tiers[t];
          return (
            <div key={t} className={s.tier}>
              <span>
                <span className={s.tierDot} style={{ background: color }} />
                {TIERS[t].name}
              </span>
              <LevelPicker level={level} color={color} label={TIERS[t].name} onChange={(l) => setMarkers((m) => ({ ...m, tiers: { ...m.tiers, [t]: { ...m.tiers[t], level: l } } }))} />
            </div>
          );
        })}
      </Section>
      <Section title="Loot">
        <div className={s.tier}>
          <span>
            Valuable <span className="muted">from, per slot: High</span>
          </span>
          <Segmented label="Valuable" options={VALUABLE_CHOICES.map((v) => ({ value: v, label: formatPrice(v).toLowerCase() }))} value={markers.valuable} onChange={(valuable) => setMarkers((m) => ({ ...m, valuable }))} />
        </div>
        <div className={s.tier}>
          <span>
            Ordinary <span className="muted">from: Normal; below it Low</span>
          </span>
          <Segmented label="Ordinary" options={ORDINARY_CHOICES.map((v) => ({ value: v, label: formatPrice(v).toLowerCase() }))} value={markers.ordinary} onChange={(ordinary) => setMarkers((m) => ({ ...m, ordinary }))} />
        </div>
      </Section>
    </>
  );
}

/** The overlay's settings. They configure the backend's overlay window; the radar doesn't use them. */
function OverlaySection({ available, prefs, onPrefs, marks }: Props["overlay"]) {
  const set = <K extends keyof OverlayPrefs>(key: K, value: OverlayPrefs[K]) => onPrefs((o) => ({ ...o, [key]: value }));
  return (
    <Section title="Overlay">
      <p className="muted">
        The player&apos;s view drawn by the backend in a transparent window over the game&apos;s picture (Wayland: KDE Plasma,
        wlroots compositors). It marks what the map shows: players, exfils, and loot that stands out.
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
