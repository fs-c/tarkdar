// Tests: styles for a scene through the real rules (the built-in ones, given the Map panel's settings,
// plus any extra ones on top).

import { allRows } from "../highlight/match";
import { type ItemCatalog, emptyCatalog } from "../items";
import { buildRows } from "../list/rows";
import type { Exfil, ExplosivesData, LootEntry, Player } from "../protocol";
import { type MapDisplayPrefs, builtinRules } from "./defaults";
import { type Rule, type Style, applyRules } from "./rules";

export const ALL_LAYERS = { loot: true, containers: true, exfils: true, explosives: true };

export interface Things {
  players?: Player[];
  loot?: LootEntry[];
  exfils?: Exfil[];
  explosives?: ExplosivesData;
}

export function stylesFor(
  things: Things,
  prefs: Partial<MapDisplayPrefs> = {},
  extra: Rule[] = [],
  catalog: ItemCatalog = emptyCatalog,
): Map<string, Style> {
  const rows = buildRows(
    {
      players: things.players ?? [],
      loot: things.loot ?? [],
      exfils: things.exfils ?? [],
      explosives: things.explosives ?? { grenades: [], tripwires: [] },
      equipment: new Map(),
    },
    catalog,
  );
  const rules = [...builtinRules({ layers: ALL_LAYERS, density: "all", minLabelPrice: 0, ...prefs }), ...extra];
  return applyRules(allRows(rows), rules, catalog).styles;
}
