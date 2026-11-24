// What the map shows on its own (the map style's card, StyleSwitch): loot by value, the items quests
// need, corpses, containers, exfils, explosives. Watched things show whatever these say; players
// always show (their tiers' levels say how).

import type { SetStored } from "../persist";
import type { LayerPrefs } from "../watch/prefs";
import { Segmented } from "../ui";
import s from "./LayersCard.module.css";

const CHECKS: { key: "corpses" | "containers" | "exfils" | "explosives"; label: string }[] = [
  { key: "corpses", label: "Corpses" },
  { key: "containers", label: "Containers" },
  { key: "exfils", label: "Exfils" },
  { key: "explosives", label: "Explosives" },
];

export function LayersCard({ layers, setLayers }: { layers: LayerPrefs; setLayers: SetStored<LayerPrefs> }) {
  return (
    <div className={s.layers}>
      <div className={s.row}>
        <span>Loot</span>
        <Segmented
          label="Loot"
          options={[
            { value: "off" as const, label: "Off" },
            { value: "valuable" as const, label: "Valuable" },
            { value: "all" as const, label: "All" },
          ]}
          value={layers.loot}
          onChange={(loot) => setLayers((l) => ({ ...l, loot }))}
        />
      </div>
      <div className={s.row}>
        <span>Quest items</span>
        <Segmented
          label="Quest items"
          title="Tracked: only what tracked quests need (Watch). All started: what every started quest needs, too."
          options={[
            { value: "tracked" as const, label: "Tracked" },
            { value: "started" as const, label: "All started" },
          ]}
          value={layers.quest}
          onChange={(quest) => setLayers((l) => ({ ...l, quest }))}
        />
      </div>
      <div className={s.checks}>
        {CHECKS.map(({ key, label }) => (
          <label key={key} className={s.check}>
            <input type="checkbox" checked={layers[key]} onChange={() => setLayers((l) => ({ ...l, [key]: !l[key] }))} /> {label}
          </label>
        ))}
      </div>
    </div>
  );
}
