// Tests: styles for a scene through the real rules (the built-in ones, as changed by a rule store,
// plus any extra ones on top).

import { allRows } from "../highlight/match";
import { type ItemCatalog, emptyCatalog } from "../items";
import { buildRows } from "../list/rows";
import type { Exfil, ExplosivesData, LootEntry, Player } from "../protocol";
import { type Rule, type Style, applyRules } from "./rules";
import { type RuleStore, fromLegacyPrefs, storedRules } from "./store";

export interface Things {
  players?: Player[];
  loot?: LootEntry[];
  exfils?: Exfil[];
  explosives?: ExplosivesData;
}

/** The old Map panel settings: layers, loot density, label threshold. */
export interface LegacyPrefs {
  layers?: Partial<Record<"loot" | "containers" | "exfils" | "explosives", boolean>>;
  density?: "all" | "fewer" | "fewest";
  minLabelPrice?: number;
}

/** A store as made from the old settings; by default every layer on, every item at every zoom. */
export function storeFrom({ layers, density = "all", minLabelPrice = 0 }: LegacyPrefs = {}): RuleStore {
  return fromLegacyPrefs({ loot: true, containers: true, exfils: true, explosives: true, ...layers }, { density, minLabelPrice });
}

export function stylesFor(things: Things, store: RuleStore = storeFrom(), extra: Rule[] = [], catalog: ItemCatalog = emptyCatalog): Map<string, Style> {
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
  return applyRules(allRows(rows), [...storedRules(store), ...extra], catalog).styles;
}
