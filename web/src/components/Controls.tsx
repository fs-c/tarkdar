import type { Layers } from "../render";

interface Props {
  follow: boolean;
  onToggleFollow: () => void;
  /** Number of map floors (no floor buttons below 2). */
  floors: number;
  /** Floor shown now, and the floor picked by hand (null: auto). */
  layer: number;
  manualLayer: number | null;
  onPickFloor: (layer: number | null) => void;
  layers: Layers;
  onToggleLayer: (key: keyof Layers) => void;
  calibrating: boolean;
  onToggleCalibrate: () => void;
}

const LAYER_BUTTONS: { key: keyof Layers; label: string; title?: string }[] = [
  { key: "loot", label: "loot", title: "Loose items, quest items, corpses" },
  { key: "containers", label: "containers", title: "Containers and airdrops" },
  { key: "exfils", label: "exfils" },
  { key: "explosives", label: "explosives", title: "Grenades and tripwires" },
];

const cls = (flags: Record<string, boolean>) =>
  Object.keys(flags).filter((k) => flags[k]).join(" ") || undefined;

export function Controls(p: Props) {
  const floorOptions: (number | null)[] = p.floors < 2 ? [] : [null, ...Array.from({ length: p.floors }, (_, i) => i)];
  return (
    <div id="controls">
      <button className={cls({ active: p.follow })} title="Follow the local player (F)" onClick={p.onToggleFollow}>
        follow
      </button>
      <span id="floors">
        {floorOptions.map((l) => (
          <button
            key={String(l)}
            className={cls({ active: l === p.manualLayer, current: l === p.layer })}
            onClick={() => p.onPickFloor(l)}
          >
            {l === null ? "auto" : l + 1}
          </button>
        ))}
      </span>
      {LAYER_BUTTONS.map(({ key, label, title }) => (
        <button key={key} className={cls({ active: p.layers[key] })} title={title} onClick={() => p.onToggleLayer(key)}>
          {label}
        </button>
      ))}
      <button className={cls({ active: p.calibrating })} title="Calibrate the current map" onClick={p.onToggleCalibrate}>
        calibrate
      </button>
    </div>
  );
}
