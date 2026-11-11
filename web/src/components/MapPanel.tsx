// Map view of the side panel: which floor to show and which layers to draw.

import type { LootPrefs, TrailPrefs } from "../hooks";
import { formatPrice } from "../items";
import type { Layers } from "../render";
import { PanelBody, Section, Segmented, type SegmentedOption, ToggleRow } from "../ui";

interface Props {
  /** Number of map floors (no floor picker below 2). */
  floors: number;
  /** Floor shown now, and the floor picked by hand (null: auto). */
  layer: number;
  manualLayer: number | null;
  onPickFloor: (layer: number | null) => void;
  layers: Layers;
  onToggleLayer: (key: keyof Layers) => void;
  trails: TrailPrefs;
  onTrails: (t: TrailPrefs) => void;
  loot: LootPrefs;
  onLoot: (l: LootPrefs) => void;
}

const LABEL_PRICES = [0, 10_000, 25_000, 50_000, 100_000];

const TRAIL_LENGTHS: (number | null)[] = [1, 5, 15, null];

const LAYERS: { key: keyof Layers; label: string; hint: string }[] = [
  { key: "loot", label: "Loot", hint: "Loose items, quest items, corpses" },
  { key: "containers", label: "Containers", hint: "Containers and airdrops" },
  { key: "exfils", label: "Exfils", hint: "Extraction points and their status" },
  { key: "explosives", label: "Explosives", hint: "Grenades and tripwires" },
];

export function MapPanel(p: Props) {
  const floorOptions: SegmentedOption<number | null>[] = [
    { value: null, label: "Auto", title: "Follow the local player's floor" },
    ...Array.from({ length: p.floors }, (_, i) => ({ value: i, label: i + 1, title: i === p.layer ? "Shown now" : undefined })),
  ];
  return (
    <PanelBody>
      <Section title="Floor">
        {p.floors < 2 ? (
          <p className="muted">This map has a single floor.</p>
        ) : (
          <Segmented label="Floor" options={floorOptions} value={p.manualLayer} marked={p.layer} onChange={p.onPickFloor} />
        )}
      </Section>
      <Section title="Layers">
        {LAYERS.map(({ key, label, hint }) => (
          <ToggleRow key={key} label={label} hint={hint} checked={p.layers[key]} onChange={() => p.onToggleLayer(key)} />
        ))}
        {p.layers.loot && (
          <Segmented
            label="Label items worth at least"
            title="Label items worth at least (per unit)"
            options={LABEL_PRICES.map((v) => ({ value: v, label: v === 0 ? "All" : `≥${formatPrice(v)}` }))}
            value={p.loot.minLabelPrice}
            onChange={(v) => p.onLoot({ ...p.loot, minLabelPrice: v })}
          />
        )}
      </Section>
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
            label="Length of everyone's trails"
            title="Length of everyone's trails"
            options={TRAIL_LENGTHS.map((m) => ({ value: m, label: m === null ? "Whole raid" : `${m} min` }))}
            value={p.trails.minutes}
            onChange={(m) => p.onTrails({ ...p.trails, minutes: m })}
          />
        )}
      </Section>
    </PanelBody>
  );
}
