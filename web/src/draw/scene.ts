import type { RadarState } from "../stream/connection";
import type { Timeline } from "../stream/timeline";
import type { ItemCatalog } from "../model/items";
import type { WorldPos } from "../model/protocol";
import type { AnyRow } from "../list/rows";
import type { TrailPrefs } from "../persist/prefs";
import type { Style } from "../rules/rules";
import { type Selection, selectedPosition } from "./pick";
import type { Scene } from "./render";

/** What the map shows of the state (all of it: the display rules decide how, and whether, each thing shows). */
type Shown = Pick<Scene, "players" | "loot" | "exfils" | "explosives">;

interface TrailInput {
  timeline: Timeline | null;
  /** The shown moment; null: nothing yet. */
  at: number | null;
  prefs: TrailPrefs;
  players: Scene["players"];
  selection: Selection | null;
}

/** Where players have been: everyone's (a length of time) and the selected one's (the whole raid). */
export function trailScene({ timeline, at, prefs, players, selection }: TrailInput): Scene["trails"] {
  if (!timeline || at === null) return null;
  const since = new Map<number, number>();
  if (prefs.all) {
    const from = prefs.minutes === null ? -Infinity : at - prefs.minutes * 60_000;
    for (const p of players) since.set(p.id, from);
  }
  const selectedPlayer = selection?.kind === "player" ? selection.id : null;
  if (prefs.selected && selectedPlayer !== null) since.set(selectedPlayer, -Infinity);
  return since.size ? { timeline, at, since, selected: selectedPlayer } : null;
}

interface SceneInput {
  state: RadarState;
  shown: Shown;
  catalog: ItemCatalog;
  questLabels: ReadonlyMap<string, string>;
  styles: ReadonlyMap<string, Style>;
  selection: Selection | null;
  /** Hovered in the list; drawn only while the list is `listShown`. */
  hovered: Selection | null;
  listShown: boolean;
  /** Coordinate-tool picks: drawn only with a map and the tool on. */
  debugPoints: WorldPos[];
  /** Marked on the map (dashed rings): what a list's filter lets through, what the search previews. */
  hoverMatches: readonly AnyRow[];
  trails: Scene["trails"];
  bodies: boolean;
  carried?: Scene["carried"];
}

/** Everything the radar draws, from what the app knows. */
export function buildScene(i: SceneInput): Scene {
  return {
    players: i.shown.players,
    catalog: i.catalog,
    exfils: i.shown.exfils,
    explosives: i.shown.explosives,
    vehicles: i.state.vehicles,
    loot: i.shown.loot,
    questLabels: i.questLabels,
    styles: i.styles,
    selected: selectedPosition(i.selection, i.state),
    hovered: i.listShown ? selectedPosition(i.hovered, i.state) : null,
    debugPoints: i.debugPoints,
    marked: i.hoverMatches.flatMap((r) => (r.pos ? [r.pos] : [])),
    trails: i.trails,
    bodies: i.bodies,
    carried: i.carried,
  };
}
