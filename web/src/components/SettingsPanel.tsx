// Settings view of the side panel: how the 3D map looks, map debugging tools, 2D map calibration.

import type { MapPrefs } from "../hooks";
import { COLOR_SCHEMES, type ColorGrade, type ColorSchemeName, PLAN_PALETTES, type PlanPalette, type PlanPaletteName, paletteOf, schemeOf } from "../map3d/settings";
import { Actions, Button, PanelBody, Section, Segmented, SliderRow, ToggleRow } from "../ui";
import s from "./SettingsPanel.module.css";
import { PALETTE_LABELS } from "./StyleSwitch";

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

const SCHEMES: { value: ColorSchemeName; label: string; title: string }[] = [
  { value: "standard", label: "Standard", title: "Lightened game colours" },
  { value: "light", label: "Light", title: "Lighter and flatter" },
  { value: "muted", label: "Muted", title: "Mostly grey, a hint of colour" },
  { value: "game", label: "Game", title: "The game's colours as they are: dark" },
];

const GRADE: { key: keyof ColorGrade; label: string; min: number; max: number }[] = [
  { key: "exposure", label: "Exposure", min: 0.4, max: 2.5 },
  { key: "lift", label: "Lift", min: 0, max: 0.8 },
  { key: "contrast", label: "Contrast", min: 0, max: 1.2 },
  { key: "saturation", label: "Saturation", min: 0, max: 2 },
  { key: "groundSaturation", label: "Ground saturation", min: 0, max: 1.5 },
];

const DARK: PlanPaletteName[] = ["night", "midnight", "blueprint"];
const PALETTES = (Object.keys(PLAN_PALETTES) as PlanPaletteName[]).map((value) => ({
  value,
  label: PALETTE_LABELS[value] + (DARK.includes(value) ? " (dark)" : ""),
}));

const PALETTE_COLORS: { key: keyof PlanPalette; label: string; title?: string }[] = [
  { key: "ground", label: "Ground" },
  { key: "grass", label: "Grass" },
  { key: "road", label: "Road" },
  { key: "floor", label: "Floor", title: "Pavements, slabs, floors" },
  { key: "water", label: "Water" },
  { key: "tree", label: "Trees" },
  { key: "cover", label: "Cover", title: "Obstacles up to 2 m: what one can look over" },
  { key: "obstacle", label: "Obstacle", title: "Taller but narrow: walls, fences, containers, vehicles" },
  { key: "building", label: "Building" },
  { key: "buildingTall", label: "Tall building", title: "Buildings shade from Building to this at 24 m" },
  { key: "outline", label: "Outline" },
];

export function SettingsPanel(p: Props) {
  const toggle = (key: keyof MapPrefs) => () => p.onPrefs({ ...p.prefs, [key]: !p.prefs[key] });
  const wasd = p.prefs.controls === "wasd";
  const plan = p.prefs.style === "plan";
  // A stored palette may predate a colour added since.
  const palette: PlanPalette = { ...PLAN_PALETTES.paper, ...p.prefs.palette };
  return (
    <PanelBody>
      <Section title="3D map">
        <div className={s.choice}>
          <span>Style</span>
          <Segmented
            label="Style"
            options={[
              { value: "realistic" as const, label: "Realistic", title: "The game's colours, lit: what the place looks like" },
              { value: "plan" as const, label: "Plan", title: "Drawn like a map: buildings, cover and open ground in flat colours, with outlines" },
            ]}
            value={p.prefs.style}
            onChange={(style) => p.onPrefs({ ...p.prefs, style })}
          />
        </div>
        <p className="muted">
          {plan
            ? "Sand: buildings, darker the taller. Dark grey: walls, vehicles, containers. Grey: cover one can look over."
            : "The plan style is easier to read at a glance."}{" "}
          M switches.
        </p>
        <ToggleRow
          label="Material colours"
          hint={plan ? "The plan style has its own colours" : "Off: one colour per kind of object"}
          checked={p.prefs.colored}
          onChange={toggle("colored")}
        />
        <ToggleRow label="Trees" hint="Simple markers where trees stand" checked={p.prefs.trees} onChange={toggle("trees")} />
        <ToggleRow label="Contour lines" hint="Every 2 m of terrain height" checked={p.prefs.contours} onChange={toggle("contours")} />
        <ToggleRow
          label="Use the 2D map"
          hint="Where a location has both a 2D and a 3D map"
          checked={p.prefs.prefer2d}
          onChange={toggle("prefer2d")}
        />
        <div className={s.choice}>
          <span>Projection</span>
          <Segmented
            label="Projection"
            options={[
              { value: false, label: "Perspective" },
              { value: true, label: "Orthographic", title: "Parallel projection: buildings never lean" },
            ]}
            value={p.prefs.orthographic}
            onChange={(orthographic) => p.onPrefs({ ...p.prefs, orthographic })}
          />
        </div>
        <div className={s.choice}>
          <span>Controls</span>
          <Segmented
            label="Controls"
            options={[
              { value: "map" as const, label: "Map" },
              { value: "wasd" as const, label: "WASD" },
            ]}
            value={p.prefs.controls}
            onChange={(controls) => p.onPrefs({ ...p.prefs, controls })}
          />
        </div>
        <p className="muted">
          {wasd
            ? "W A S D move (Shift: faster), drag tilts and turns the camera, right-drag moves the map, the wheel zooms."
            : "Drag moves the map, the wheel zooms, right-drag tilts and turns it."}{" "}
          0 resets the view.
        </p>
      </Section>
      <Section title="Plan palette">
        <label className={s.choice}>
          <span>Palette</span>
          <select
            className={s.select}
            value={paletteOf(palette) ?? "custom"}
            onChange={(e) => {
              const picked = e.target.value === "custom" ? p.prefs.customPalette : PLAN_PALETTES[e.target.value as PlanPaletteName];
              if (picked) p.onPrefs({ ...p.prefs, palette: picked });
            }}
          >
            {PALETTES.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
            {(p.prefs.customPalette || !paletteOf(palette)) && <option value="custom">Custom</option>}
          </select>
        </label>
        <div className={s.swatches}>
          {PALETTE_COLORS.map((c) => (
            <label key={c.key} className={s.swatch} title={c.title}>
              <input type="color" value={palette[c.key]} onChange={(e) => {
                  const custom = { ...palette, [c.key]: e.target.value };
                  p.onPrefs({ ...p.prefs, palette: custom, customPalette: custom });
                }} />
              <span>{c.label}</span>
            </label>
          ))}
        </div>
        <p className="muted">
          {plan ? "" : "Used by the plan style (M). "}Change any colour to make the palette your own: it stays available as "Custom" next to
          the pre-made ones. A level surface has exactly the colour chosen, walls are a little darker.
        </p>
        <Actions>
          <Button onClick={() => void navigator.clipboard?.writeText(JSON.stringify(palette))} title="As JSON, to share or keep">
            Copy palette
          </Button>
        </Actions>
      </Section>
      <Section title="3D map colours">
        <div className={s.choice}>
          <Segmented
            label="Colour scheme"
            options={SCHEMES}
            value={schemeOf(p.prefs)}
            onChange={(name) => name && p.onPrefs({ ...p.prefs, ...COLOR_SCHEMES[name] })}
          />
        </div>
        {GRADE.map((g) => (
          <SliderRow
            key={g.key}
            label={g.label}
            value={p.prefs[g.key]}
            min={g.min}
            max={g.max}
            step={0.01}
            onChange={(value) => p.onPrefs({ ...p.prefs, [g.key]: value })}
          />
        ))}
        <p className="muted">
          Applied live to the material colours of the realistic style: map luma = lift + contrast × game luma. Exposure
          also lights the one-colour-per-kind view.
        </p>
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
