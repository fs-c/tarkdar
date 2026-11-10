export function CalibrationPanel({ output, onClear }: { output: string; onClear: () => void }) {
  return (
    <div id="calibration">
      <p>
        Stand somewhere recognisable, then click that spot on the map. Repeat at 2–3 places far apart. Paste the
        result into the map's <code>map.json</code>.
      </p>
      <textarea readOnly rows={10} value={output} />
      <button onClick={onClear}>clear points</button>
    </div>
  );
}
