// Map view of the side panel: how the map looks (style, palette, colours), how it's controlled, and
// trails. (What shows on it and how: FiltersPanel. The overlay: SettingsPanel.)

import type { MapPrefs, TrailPrefs } from "../persist/prefs";
import { COLOR_SCHEMES, type ColorGrade, type ColorSchemeName, PLAN_PALETTES, type PlanPalette, type PlanPaletteName, paletteOf, schemeOf } from "../map3d/settings";
import { Actions, Button, PanelBody, Section, Segmented, SliderRow, ToggleRow } from "../ui";
import s from "./MapPanel.module.css";
import { PALETTE_LABELS } from "./StyleSwitch";
import type { SetStored } from "../persist";

interface Props {
  prefs: MapPrefs;
  onPrefs: SetStored<MapPrefs>;
  trails: TrailPrefs;
  onTrails: SetStored<TrailPrefs>;
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

const TRAIL_LENGTHS: (number | null)[] = [0.5, 1, 2, 5, 10, 15, 30, null];

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

export function MapPanel(p: Props) {
  const toggle = (key: keyof MapPrefs) => () => p.onPrefs((m) => ({ ...m, [key]: !m[key] }));
  const wasd = p.prefs.controls === "wasd";
  const plan = p.prefs.style === "plan";
  // A stored palette may predate a colour added since.
  const palette: PlanPalette = { ...PLAN_PALETTES.paper, ...p.prefs.palette };
  return (
    <PanelBody>
      <Section title="Map">
        <div className={s.choice}>
          <span>Style</span>
          <Segmented
            label="Style"
            options={[
              { value: "realistic" as const, label: "Realistic", title: "The game's colours, lit: what the place looks like" },
              { value: "plan" as const, label: "Plan", title: "Drawn like a map: buildings, cover and open ground in flat colours, with outlines" },
            ]}
            value={p.prefs.style}
            onChange={(style) => p.onPrefs((m) => ({ ...m, style }))}
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
          label="Player figures"
          hint="Up close, players are drawn from their skeleton instead of as dots"
          checked={p.prefs.bodies}
          onChange={toggle("bodies")}
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
            onChange={(orthographic) => p.onPrefs((m) => ({ ...m, orthographic }))}
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
            onChange={(controls) => p.onPrefs((m) => ({ ...m, controls }))}
          />
        </div>
        <p className="muted">
          {wasd
            ? "W A S D move (Shift: faster), drag tilts and turns the camera, right-drag moves the map, the wheel zooms."
            : "Drag moves the map, the wheel zooms, right-drag tilts and turns it."}{" "}
          0 resets the view.
        </p>
      </Section>
      <Section title="Trails">
        <ToggleRow
          label="Selected player"
          hint="Where they've been this raid"
          checked={p.trails.selected}
          onChange={() => p.onTrails((t) => ({ ...t, selected: !t.selected }))}
        />
        <ToggleRow
          label="Everyone"
          hint="Recent paths of all players (those the list's filters let through)"
          checked={p.trails.all}
          onChange={() => p.onTrails((t) => ({ ...t, all: !t.all }))}
        />
        {p.trails.all && (
          <Segmented
            label="Trail duration"
            title="How far back everyone's trails reach (the selected player's always shows the whole raid)"
            options={TRAIL_LENGTHS.map((m) => ({ value: m, label: m === null ? "Whole raid" : m < 1 ? `${m * 60} s` : `${m} min` }))}
            value={p.trails.minutes}
            onChange={(m) => p.onTrails((t) => ({ ...t, minutes: m }))}
          />
        )}
      </Section>
      <Section title="Plan palette">
        <label className={s.choice}>
          <span>Palette</span>
          <select
            className={s.select}
            value={paletteOf(palette) ?? "custom"}
            onChange={(e) => {
              const picked = e.target.value === "custom" ? p.prefs.customPalette : PLAN_PALETTES[e.target.value as PlanPaletteName];
              if (picked) p.onPrefs((m) => ({ ...m, palette: picked }));
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
                  p.onPrefs((m) => ({ ...m, palette: custom, customPalette: custom }));
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
      <Section title="Map colours">
        <div className={s.choice}>
          <Segmented
            label="Colour scheme"
            options={SCHEMES}
            value={schemeOf(p.prefs)}
            onChange={(name) => name && p.onPrefs((m) => ({ ...m, ...COLOR_SCHEMES[name] }))}
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
            onChange={(value) => p.onPrefs((m) => ({ ...m, [g.key]: value }))}
          />
        ))}
        <p className="muted">
          Applied live to the material colours of the realistic style: map luma = lift + contrast × game luma. Exposure
          also lights the one-colour-per-kind view.
        </p>
      </Section>
    </PanelBody>
  );
}
