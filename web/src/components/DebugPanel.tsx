// The debugging sections of the Settings view: what's behind the quest item filter, and map debugging tools.

import type { MapPrefs } from "../prefs";
import type { MapView } from "../map3d/Map3D";
import { type QuestDebug, type QuestDebugQuest, questStatusName } from "../quests";
import { Actions, Button, Section, ToggleRow, cx } from "../ui";
import s from "./DebugPanel.module.css";

export interface DebugProps {
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
  quests: QuestDebug;
  /** Loot copies left out (dedupe.ts). */
  duplicates: number;
}

/** Sections, not a view: shown at the bottom of SettingsPanel. */
export function DebugSections(p: DebugProps) {
  const toggle = (key: keyof MapPrefs) => () => p.onPrefs({ ...p.prefs, [key]: !p.prefs[key] });
  return (
    <>
      <QuestSection report={p.quests} duplicates={p.duplicates} />
      {p.mapShown && (
        <Section title="Debug · Map">
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
      <Section title="Debug · Player's view">
        <p className="muted">
          <a href="#pov">Player's view</a>: what the backend reads of the local player's camera and scope, as points
          projected from their eyes. For checking the camera offsets.
        </p>
      </Section>
    </>
  );
}

function QuestSection({ report: r, duplicates }: { report: QuestDebug; duplicates: number }) {
  const k = r.byKind;
  const rows: [string, string, string?][] = [
    [
      "Backend",
      r.backend === "unread" ? "quests not read (no raid, or an older recording)" : `${r.started} started, ${r.readyToHandIn} ready to hand in`,
      "The local player's quests in progress (Profile.QuestsData), with their templates from game memory",
    ],
    ["Started", r.backend === "unread" ? "–" : `${k.story} story, ${k.side} side, ${k.daily} daily, ${k.weekly} weekly`],
    ["Objectives unknown", r.backend === "unread" ? "–" : `${r.unknown.length} of the started quests`, "Their template couldn't be read"],
    ["Filter", r.filter.effect, "Map panel → Loose items → Quest items"],
    [
      "On the map",
      `${r.questItems.reduce((n, i) => n + i.count, 0)} quest items (${r.questItems.filter((i) => i.shown).length} of ${r.questItems.length} kinds shown); ` +
        `${r.neededItemsOnMap.all} other items started quests need, ${r.neededItemsOnMap.specific} highlighted`,
      "Highlighted: \"Needed for quests\" rule, objectives that at most 5 different items count for",
    ],
    ["Copies merged", `${duplicates} loot entries`, "The same item at the same spot more than once (dedupe.ts)"],
  ];
  return (
    <Section title="Debug · Quests">
      <dl className={s.readout}>
        {rows.map(([label, value, title]) => (
          <div key={label} title={title}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
      <Actions>
        <Button onClick={() => void navigator.clipboard?.writeText(JSON.stringify(r, null, 2))} title="Everything below, as JSON">
          Copy report
        </Button>
        {r.unknown.length > 0 && (
          <Button onClick={() => void navigator.clipboard?.writeText(r.unknown.join("\n"))} title="Ids of the started quests whose objectives are unknown">
            Copy unknown ids
          </Button>
        )}
      </Actions>
      {r.questItems.length > 0 && (
        <details className={s.group} open>
          <summary>Quest items on the map ({r.questItems.length})</summary>
          <ul className={s.list}>
            {r.questItems.map((i) => (
              <li key={i.tpl} className={cx(!i.shown && s.off)} title={`${i.tpl}\n${i.obj}`}>
                <span className={s.mark}>{i.shown ? "●" : "○"}</span>
                <span>
                  {i.label ?? i.obj}
                  {i.count > 1 && ` ×${i.count}`}
                  <span className={s.why}>{i.why}</span>
                </span>
              </li>
            ))}
          </ul>
        </details>
      )}
      {r.quests.length > 0 && (
        <details className={s.group}>
          <summary>Quests in progress ({r.quests.length})</summary>
          <ul className={s.list}>
            {r.quests.map((q) => (
              <QuestRow key={q.id} q={q} />
            ))}
          </ul>
        </details>
      )}
    </Section>
  );
}

function QuestRow({ q }: { q: QuestDebugQuest }) {
  const done = q.objectives.filter((o) => o.done).length;
  const flags = [
    !q.known && "objectives unknown",
    q.hidden && "hidden",
    q.done === null && "completed conditions unreadable",
  ].filter(Boolean);
  return (
    <li className={s.quest}>
      <details>
        <summary>
          <span className={cx(!q.known && s.warn)}>{q.label}</span>
          <span className={s.why}>
            {[q.kind, q.trader, questStatusName(q.status)].filter(Boolean).join(", ")}
            {q.known && q.objectives.length > 0 && `, ${done}/${q.objectives.length} item objectives done`}
            {flags.length > 0 && ` · ${flags.join(", ")}`}
          </span>
        </summary>
        <div className={s.detail}>
          <code>{q.id}</code>
          {q.objectives.length > 0 && (
            <ul className={s.list}>
              {q.objectives.map((o) => (
                <li key={o.id} className={cx(!o.open && s.off)} title={o.id}>
                  <span className={s.mark}>{o.done ? "✓" : o.open ? "○" : "–"}</span>
                  <span>
                    {o.text ?? o.type}
                    {o.items.length > 0 && `: ${o.items.length > 5 ? `any of ${o.items.length} items` : o.items.join(", ")}`}
                    {o.progress !== undefined ? ` ${o.progress}/${o.count}` : o.count > 1 && ` ×${o.count}`}
                    {o.fir && " (FIR)"}
                  </span>
                </li>
              ))}
            </ul>
          )}
          {q.done && q.done.length > 0 && <p className={s.why}>Completed conditions: {q.done.join(", ")}</p>}
        </div>
      </details>
    </li>
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
function MapReadout({ info, view }: { info: NonNullable<DebugProps["mapInfo"]>; view: MapView | null }) {
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
