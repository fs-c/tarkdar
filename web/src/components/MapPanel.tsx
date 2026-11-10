// Map view of the side panel: which floor to show and which layers to draw.

import type { TrailPrefs } from "../hooks";
import type { Layers } from "../render";

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
}

const TRAIL_LENGTHS: (number | null)[] = [1, 5, 15, null];

const LAYERS: { key: keyof Layers; label: string; hint: string }[] = [
  { key: "loot", label: "Loot", hint: "Loose items, quest items, corpses" },
  { key: "containers", label: "Containers", hint: "Containers and airdrops" },
  { key: "exfils", label: "Exfils", hint: "Extraction points and their status" },
  { key: "explosives", label: "Explosives", hint: "Grenades and tripwires" },
];

export function MapPanel(p: Props) {
  const floorOptions: (number | null)[] = [null, ...Array.from({ length: p.floors }, (_, i) => i)];
  return (
    <div className="panel-body">
      <section>
        <h3>Floor</h3>
        {p.floors < 2 ? (
          <p className="muted">This map has a single floor.</p>
        ) : (
          <div className="segmented" role="radiogroup">
            {floorOptions.map((l) => (
              <button
                key={String(l)}
                role="radio"
                aria-checked={l === p.manualLayer}
                className={[l === p.manualLayer && "active", l === p.layer && "current"].filter(Boolean).join(" ") || undefined}
                title={l === null ? "Follow the local player's floor" : l === p.layer ? "Shown now" : undefined}
                onClick={() => p.onPickFloor(l)}
              >
                {l === null ? "Auto" : l + 1}
              </button>
            ))}
          </div>
        )}
      </section>
      <section>
        <h3>Layers</h3>
        {LAYERS.map(({ key, label, hint }) => (
          <label key={key} className="toggle-row">
            <input type="checkbox" className="switch" checked={p.layers[key]} onChange={() => p.onToggleLayer(key)} />
            <span>
              {label}
              <small>{hint}</small>
            </span>
          </label>
        ))}
      </section>
      <section>
        <h3>Trails</h3>
        <label className="toggle-row">
          <input type="checkbox" className="switch" checked={p.trails.selected} onChange={() => p.onTrails({ ...p.trails, selected: !p.trails.selected })} />
          <span>
            Selected player
            <small>Where they've been this raid</small>
          </span>
        </label>
        <label className="toggle-row">
          <input type="checkbox" className="switch" checked={p.trails.all} onChange={() => p.onTrails({ ...p.trails, all: !p.trails.all })} />
          <span>
            Everyone
            <small>Recent paths of all players (those the list's filters let through)</small>
          </span>
        </label>
        {p.trails.all && (
          <div className="segmented" role="radiogroup" title="Length of everyone's trails">
            {TRAIL_LENGTHS.map((m) => (
              <button
                key={String(m)}
                role="radio"
                aria-checked={m === p.trails.minutes}
                className={m === p.trails.minutes ? "active" : undefined}
                onClick={() => p.onTrails({ ...p.trails, minutes: m })}
              >
                {m === null ? "Whole raid" : `${m} min`}
              </button>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
