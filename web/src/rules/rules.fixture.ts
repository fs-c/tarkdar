// Tests: styles for a scene through the real rules (the defaults, as changed by a rule store, plus any
// extra ones on top).

import { allRows } from "../highlight/match";
import { type ItemCatalog, emptyCatalog } from "../items";
import { buildRows } from "../list/rows";
import type { Exfil, ExplosivesData, LootEntry, Player } from "../protocol";
import type { Category } from "./defaults";
import { SHOW_LEVELS } from "./defaults";
import { type Rule, type Style, applyRules } from "./rules";
import { type RuleStore, defaultStore, hiddenKinds, storedRules, updateRule } from "./store";

export interface Things {
  players?: Player[];
  loot?: LootEntry[];
  exfils?: Exfil[];
  explosives?: ExplosivesData;
}

/** What the old Map panel set: layers, loot density, label threshold. */
export interface LegacyPrefs {
  layers?: Partial<Record<"loot" | "containers" | "exfils" | "explosives", boolean>>;
  density?: "all" | "fewer" | "fewest";
  minLabelPrice?: number;
}

/** A store with these settings; by default every category on, every item at every zoom. */
export function storeFrom({ layers = {}, density = "all", minLabelPrice = 0 }: LegacyPrefs = {}): RuleStore {
  const store = defaultStore();
  const off: [keyof NonNullable<LegacyPrefs["layers"]>, Category][] = [["loot", "Loot"], ["containers", "Containers"], ["exfils", "Exfils"], ["explosives", "Explosives"]];
  store.hidden = off.filter(([k]) => layers[k] === false).map(([, c]) => c);
  const show = (id: string, v: number) => {
    const r = store.rules.find((x) => x.id === id)!;
    store.rules = updateRule(store.rules, id, { style: { ...r.style, show: v } });
  };
  if (density === "all") (show("item.all", SHOW_LEVELS.always), show("item.cheap", SHOW_LEVELS.always));
  if (density === "fewest") (show("item.all", SHOW_LEVELS.mid), show("item.cheap", SHOW_LEVELS.close));
  if (minLabelPrice > 0) {
    const r = store.rules.find((x) => x.id === "item.cheap")!;
    store.rules = updateRule(store.rules, "item.cheap", { style: { ...r.style, label: "never" } });
  }
  return store;
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
  return applyRules(allRows(rows), [...storedRules(store), ...extra], catalog, hiddenKinds(store)).styles;
}
