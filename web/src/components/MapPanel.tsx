// Map view of the side panel: which layers to draw, loot markers and labels, trails.

import { DEFAULT_LOOT_DENSITY, LOOT_DENSITY, type LootDensity } from "../declutter";
import type { LootPrefs, TrailPrefs } from "../hooks";
import { formatPrice } from "../items";
import type { Layers } from "../render";
import { PanelBody, Section, Segmented, ToggleRow } from "../ui";
import s from "./MapPanel.module.css";

interface Props {
  layers: Layers;
  onToggleLayer: (key: keyof Layers) => void;
  trails: TrailPrefs;
  onTrails: (t: TrailPrefs) => void;
  loot: LootPrefs;
  onLoot: (l: LootPrefs) => void;
}

const LABEL_PRICES = [0, 10_000, 25_000, 50_000, 100_000];

const TRAIL_LENGTHS: (number | null)[] = [0.5, 1, 2, 5, 10, 15, 30, null];

const LAYERS: { key: keyof Layers; label: string; hint: string }[] = [
  { key: "loot", label: "Loot", hint: "Loose items and quest items" },
  { key: "containers", label: "Containers", hint: "Containers, airdrops and corpses" },
  { key: "exfils", label: "Exfils", hint: "Extraction points and their status" },
  { key: "explosives", label: "Explosives", hint: "Grenades and tripwires" },
];

export function MapPanel(p: Props) {
  return (
    <PanelBody>
      <Section title="Layers">
        {LAYERS.map(({ key, label, hint }) => (
          <ToggleRow key={key} label={label} hint={hint} checked={p.layers[key]} onChange={() => p.onToggleLayer(key)} />
        ))}
      </Section>
      {p.layers.loot && (
        <Section title="Loose items">
          <div className={s.field}>
            <span className={s.caption}>Markers when zoomed out</span>
            <Segmented
              label="Markers when zoomed out"
              title="Which loose items keep their marker as you zoom out (quest items and highlighted ones always do)"
              options={(Object.keys(LOOT_DENSITY) as LootDensity[]).map((v) => ({ value: v, label: LOOT_DENSITY[v].label, title: LOOT_DENSITY[v].hint }))}
              value={p.loot.density in LOOT_DENSITY ? p.loot.density : DEFAULT_LOOT_DENSITY}
              onChange={(v) => p.onLoot({ ...p.loot, density: v })}
            />
          </div>
          <div className={s.field}>
            <span className={s.caption}>Labels for items worth at least (zoomed in)</span>
            <Segmented
              label="Label items worth at least"
              title="Label items worth at least (per unit)"
              options={LABEL_PRICES.map((v) => ({ value: v, label: v === 0 ? "All" : `≥${formatPrice(v)}` }))}
              value={p.loot.minLabelPrice}
              onChange={(v) => p.onLoot({ ...p.loot, minLabelPrice: v })}
            />
          </div>
        </Section>
      )}
      <Section title="Trails">
        <ToggleRow
          label="Selected player"
          hint="Where they've been this raid"
          checked={p.trails.selected}
          onChange={() => p.onTrails({ ...p.trails, selected: !p.trails.selected })}
        />
        <ToggleRow
          label="Everyone"
          hint="Recent paths of all players (those the list's filters let through)"
          checked={p.trails.all}
          onChange={() => p.onTrails({ ...p.trails, all: !p.trails.all })}
        />
        {p.trails.all && (
          <Segmented
            label="Trail duration"
            title="How far back everyone's trails reach (the selected player's always shows the whole raid)"
            options={TRAIL_LENGTHS.map((m) => ({ value: m, label: m === null ? "Whole raid" : m < 1 ? `${m * 60} s` : `${m} min` }))}
            value={p.trails.minutes}
            onChange={(m) => p.onTrails({ ...p.trails, minutes: m })}
          />
        )}
      </Section>
    </PanelBody>
  );
}
