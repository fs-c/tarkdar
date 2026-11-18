// Settings view of the side panel: how the map looks, and map debugging tools.

import type { MapPrefs } from "../hooks";
import type { MapView } from "../map3d/Map3D";
import type { OverlayPrefs } from "../overlay/marks";
import { COLOR_SCHEMES, type ColorGrade, type ColorSchemeName, PLAN_PALETTES, type PlanPalette, type PlanPaletteName, paletteOf, schemeOf } from "../map3d/settings";
import { Actions, Button, PanelBody, Section, Segmented, SliderRow, ToggleRow } from "../ui";
import s from "./SettingsPanel.module.css";
import { PALETTE_LABELS } from "./StyleSwitch";

interface Props {
  prefs: MapPrefs;
  onPrefs: (p: MapPrefs) => void;
  /** A map is on screen (not just the grid of a location without one). */
  mapShown: boolean;
  /** Render statistics of the map, when it is shown. */
  stats: string | null;
  /** The map shown: its folder of maps/3d, the raid's location id and the configured home heading. */
  mapInfo: { folder: string; name: string; locationId: string | null; up: number } | null;
  /** Where the camera is, when a map is shown. */
  view: MapView | null;
  /** Coordinate pick output to paste into a bug report. */
  pickOutput: string;
  onClearPicks: () => void;
  /** The overlay: whether the backend runs it, its settings, and how many things it's told to mark. */
  overlay: { available: boolean; prefs: OverlayPrefs; onPrefs: (p: OverlayPrefs) => void; marks: number | null };
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
      <Section title="Map colours">
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
      {p.mapShown && (
        <Section title="Map debugging">
          <ToggleRow
            label="Coordinate pick"
            hint="Click the map to record the world position under the cursor"
            checked={p.prefs.coordinatePick}
            onChange={toggle("coordinatePick")}
          />
          <ToggleRow label="Wireframe" checked={p.prefs.wireframe} onChange={toggle("wireframe")} />
          {p.mapInfo && <MapReadout info={p.mapInfo} view={p.view} />}
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
      <OverlaySection {...p.overlay} />
      <Section title="Experimental">
        <p className="muted">
          <a href="#pov">Player's view</a>: what the backend reads of the local player's camera and scope, as points
          projected from their eyes. For checking the camera offsets.
        </p>
      </Section>
    </PanelBody>
  );
}

/** The overlay's settings. They configure the backend's overlay window; the radar doesn't use them. */
function OverlaySection({ available, prefs, onPrefs, marks }: Props["overlay"]) {
  const set = <K extends keyof OverlayPrefs>(key: K, value: OverlayPrefs[K]) => onPrefs({ ...prefs, [key]: value });
  return (
    <Section title="Overlay">
      <p className="muted">
        The player's view drawn by the backend in a transparent window over the game&apos;s picture (Wayland: KDE Plasma,
        wlroots compositors). It marks what the map shows, as the rules style it: players, exfils, and loot that stands
        out.
      </p>
      {!available ? (
        <p className="muted">Not running: start radar-backend with --overlay.</p>
      ) : (
        <>
          <ToggleRow
            label="Show the overlay"
            hint={prefs.on ? `Configured from this browser${marks !== null ? `: ${marks} marked` : ""}` : "Settings from this browser; the last browser to change them wins"}
            checked={prefs.on}
            onChange={() => set("on", !prefs.on)}
          />
          <ToggleRow label="Other players" hint="Players the rules don't mark yet, in white" checked={prefs.otherPlayers} onChange={() => set("otherPlayers", !prefs.otherPlayers)} />
          <ToggleRow label="Ground grid" hint="For checking the alignment" checked={prefs.grid} onChange={() => set("grid", !prefs.grid)} />
          <SliderRow label="Delay (s)" value={prefs.delayMs / 1000} min={0} max={0.15} step={0.005} onChange={(v) => set("delayMs", Math.round(v * 1000))} />
          <SliderRow label="Loot range (km)" value={prefs.lootRange / 1000} min={0.01} max={0.5} step={0.01} onChange={(v) => set("lootRange", Math.round(v * 1000))} />
          <SliderRow label="Scope circle" value={prefs.scopeRadius} min={0.1} max={0.5} step={0.01} onChange={(v) => set("scopeRadius", v)} />
          <p className="muted">
            Delay: if marks run ahead of the picture as you turn, raise it until they stay on their targets. Scope circle: the
            size of the scope&apos;s picture (share of the screen height); marks inside it are placed through the scope.
          </p>
        </>
      )}
    </Section>
  );
}

/** Degrees in [0, 360). */
const compass = (deg: number) => ((deg % 360) + 360) % 360;
/** Degrees in (-180, 180]. */
const turn = (deg: number) => {
  const d = compass(deg);
  return d > 180 ? d - 360 : d;
};
const fixed = (v: number, digits = 1) => v.toFixed(digits);
const xyz = (v: [number, number, number]) => v.map((c) => fixed(c)).join(", ");

/** What map is shown and where the camera is: for setting a map's `up` (its home orientation). */
function MapReadout({ info, view }: { info: NonNullable<Props["mapInfo"]>; view: MapView | null }) {
  const heading = view && compass(view.heading);
  const off = view && turn(view.heading - info.up);
  const rows: [string, string, string?][] = [
    ["Map", `${info.name} (maps/3d/${info.folder})`],
    ["Location id", info.locationId ?? "–"],
    ["Home up", `${fixed(compass(info.up))}°`, "The map's up in map.json: the heading of the home view (0 resets it)"],
  ];
  if (view && heading !== null && off !== null) {
    rows.push(
      ["Heading", `${fixed(heading)}° (${off >= 0 ? "+" : ""}${fixed(off)}° from home)`, "Direction at the top of the screen, clockwise from north"],
      ["Tilt", `${fixed(view.tilt)}° from top-down`],
      ["Span", `${fixed(view.span, 0)} m`, "Ground across the height of the view"],
      ["Camera", xyz(view.position), "World coordinates: x east, y up, z north"],
      ["Target", xyz(view.target)],
    );
  }
  return (
    <>
      <dl className={s.readout}>
        {rows.map(([label, value, title]) => (
          <div key={label} title={title}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
      {heading !== null && (
        <>
          <p className="muted">
            To change the home orientation: turn the map until it looks right, then set <code>"up": {fixed(heading)}</code> in{" "}
            <code>maps/3d/{info.folder}/map.json</code>.
          </p>
          <Actions>
            <Button onClick={() => void navigator.clipboard?.writeText(fixed(heading))} title="The current heading, for map.json's up">
              Copy heading
            </Button>
          </Actions>
        </>
      )}
    </>
  );
}
