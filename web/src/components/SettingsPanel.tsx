// Settings view of the side panel. For now: map calibration.

import { Actions, Button, PanelBody, Section } from "../ui";
import s from "./SettingsPanel.module.css";

interface Props {
  calibrating: boolean;
  onToggleCalibrate: () => void;
  /** Calibration output (or the last error) to paste into map.json. */
  calibrationOutput: string;
  onClearCalibration: () => void;
}

export function SettingsPanel({ calibrating, onToggleCalibrate, calibrationOutput, onClearCalibration }: Props) {
  return (
    <PanelBody>
      <Section title="Calibration">
        <p className="muted">
          Stand somewhere recognisable, then click that spot on the map. Repeat at 2–3 places far apart, and paste the
          result into the map's <code>map.json</code>.
        </p>
        <Actions>
          <Button variant="primary" pressed={calibrating} onClick={onToggleCalibrate}>
            {calibrating ? "Stop calibrating" : "Calibrate this map"}
          </Button>
          {calibrating && <Button onClick={onClearCalibration}>Clear points</Button>}
        </Actions>
        {calibrating && <textarea className={s.output} readOnly rows={12} value={calibrationOutput} />}
      </Section>
    </PanelBody>
  );
}
