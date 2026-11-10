// Settings view of the side panel. For now: map calibration.

interface Props {
  calibrating: boolean;
  onToggleCalibrate: () => void;
  /** Calibration output (or the last error) to paste into map.json. */
  calibrationOutput: string;
  onClearCalibration: () => void;
}

export function SettingsPanel({ calibrating, onToggleCalibrate, calibrationOutput, onClearCalibration }: Props) {
  return (
    <div className="panel-body">
      <section>
        <h3>Calibration</h3>
        <p className="muted">
          Stand somewhere recognisable, then click that spot on the map. Repeat at 2–3 places far apart, and paste the
          result into the map's <code>map.json</code>.
        </p>
        <div className="row">
          <button className={calibrating ? "primary active" : "primary"} onClick={onToggleCalibrate}>
            {calibrating ? "Stop calibrating" : "Calibrate this map"}
          </button>
          {calibrating && <button onClick={onClearCalibration}>Clear points</button>}
        </div>
        {calibrating && <textarea readOnly rows={12} value={calibrationOutput} />}
      </section>
    </div>
  );
}
