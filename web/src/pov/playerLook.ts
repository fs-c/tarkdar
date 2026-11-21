// How the player's view (components/PovPage.tsx) draws a player: the colour the display rules give them
// on the map, named by their type, like the map and the list. Rules that hide a player hide them here too.
// (The map's zoom levels don't apply: anything shown from some zoom on is shown.)

import { COLORS, DEFAULT_COLOR } from "../draw/style";
import type { PlayerRow } from "../list/rows";
import { BASE, type Style } from "../rules/rules";

export interface PovPlayerLook {
  color: string;
  label: string;
}

/** `style`: the player's, from the rules (the player's own base style without one); null: not drawn. The
 *  dead are grey, as on the map, and labelled so. */
export function povPlayerLook(row: PlayerRow, style: Style = BASE.player): PovPlayerLook | null {
  if (style.show === null) return null;
  if (row.state === "dead") return { color: COLORS.dead, label: "dead" };
  return { color: style.color ?? DEFAULT_COLOR, label: row.typeLabel };
}
