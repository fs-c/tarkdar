// Settings view of the side panel: how the 3D map looks, map debugging tools, 2D map calibration.

import type { MapPrefs } from "../hooks";
import { Actions, Button, PanelBody, Section, ToggleRow } from "../ui";
import s from "./SettingsPanel.module.css";

interface Props {
  prefs: MapPrefs;
  onPrefs: (p: MapPrefs) => void;
  /** Which kind of map is on screen (null: none). */
  shown: "2d" | "3d" | null;
  /** Render statistics of the 3D map, when it is shown. */
  stats: string | null;
  /** Coordinate pick output to paste into a bug report. */
  pickOutput: string;
  onClearPicks: () => void;
  calibrating: boolean;
  onToggleCalibrate: () => void;
  /** Calibration output (or the last error) to paste into map.json. */
  calibrationOutput: string;
  onClearCalibration: () => void;
}

export function SettingsPanel(p: Props) {
  const toggle = (key: keyof MapPrefs) => () => p.onPrefs({ ...p.prefs, [key]: !p.prefs[key] });
  return (
    <PanelBody>
      <Section title="3D map">
        <ToggleRow label="Material colours" hint="Off: one colour per kind of object" checked={p.prefs.colored} onChange={toggle("colored")} />
        <ToggleRow label="Trees" hint="Simple markers where trees stand" checked={p.prefs.trees} onChange={toggle("trees")} />
        <ToggleRow label="Contour lines" hint="Every 2 m of terrain height" checked={p.prefs.contours} onChange={toggle("contours")} />
        <ToggleRow
          label="Use the 2D map"
          hint="Where a location has both a 2D and a 3D map"
          checked={p.prefs.prefer2d}
          onChange={toggle("prefer2d")}
        />
        <p className="muted">Drag moves the map, the wheel zooms, right-drag tilts and turns it. 0 resets the view.</p>
      </Section>
      {p.shown === "3d" && (
        <Section title="Map debugging">
          <ToggleRow
            label="Coordinate pick"
            hint="Click the map to record the world position under the cursor"
            checked={p.prefs.coordinatePick}
            onChange={toggle("coordinatePick")}
          />
          <ToggleRow label="Wireframe" checked={p.prefs.wireframe} onChange={toggle("wireframe")} />
          {p.stats && <p className="muted">{p.stats}</p>}
          {p.prefs.coordinatePick && (
            <>
              <Actions>
                <Button onClick={() => void navigator.clipboard?.writeText(p.pickOutput)}>Copy</Button>
                <Button onClick={p.onClearPicks}>Clear points</Button>
              </Actions>
              <textarea className={s.output} readOnly rows={12} value={p.pickOutput} />
            </>
          )}
        </Section>
      )}
      {p.shown === "2d" && (
        <Section title="Calibration">
          <p className="muted">
            Stand somewhere recognisable, then click that spot on the map. Repeat at 2–3 places far apart, and paste the
            result into the map's <code>map.json</code>.
          </p>
          <Actions>
            <Button variant="primary" pressed={p.calibrating} onClick={p.onToggleCalibrate}>
              {p.calibrating ? "Stop calibrating" : "Calibrate this map"}
            </Button>
            {p.calibrating && <Button onClick={p.onClearCalibration}>Clear points</Button>}
          </Actions>
          {p.calibrating && <textarea className={s.output} readOnly rows={12} value={p.calibrationOutput} />}
        </Section>
      )}
    </PanelBody>
  );
}
