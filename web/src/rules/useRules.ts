// The display rules as App applies them (watch/rules.ts: the tiers, the layers and the watchlist, then
// the search's preview on top). Applied per tab, so loot (thousands of rows, changing rarely) isn't
// matched again every time players move.

import { useMemo } from "react";
import type { ItemCatalog } from "../model/items";
import type { AnyRow, SubjectKind, TabRows } from "../list/rows";
import { type Rule, type Style, applyRules } from "./rules";

/** Rule id of the search's preview (the watch bar's active suggestion, marked on the map). */
export const PREVIEW_ID = "highlight:preview";

export interface RuleState {
  /** Row key → its style. */
  styles: Map<string, Style>;
  /** Row key → the ring it gets (highlighted things). */
  rings: Map<string, string>;
  /** Rule id → the rows it matches. */
  matched: Map<string, AnyRow[]>;
}

export function useRules(all: TabRows, rules: readonly Rule[], catalog: ItemCatalog, hidden: ReadonlySet<SubjectKind>): RuleState {
  const players = useMemo(() => applyRules(all.players, rules, catalog, hidden), [all.players, rules, catalog, hidden]);
  const items = useMemo(() => applyRules(all.items, rules, catalog, hidden), [all.items, rules, catalog, hidden]);
  const containers = useMemo(() => applyRules(all.containers, rules, catalog, hidden), [all.containers, rules, catalog, hidden]);
  const rest = useMemo(() => applyRules([...all.exfils, ...all.explosives, ...all.vehicles], rules, catalog, hidden), [all.exfils, all.explosives, all.vehicles, rules, catalog, hidden]);
  return useMemo(() => {
    const parts = [players, items, containers, rest];
    const styles = new Map<string, Style>();
    const rings = new Map<string, string>();
    for (const p of parts)
      for (const [k, s] of p.styles) {
        styles.set(k, s);
        if (s.ring) rings.set(k, s.ring);
      }
    const matched = new Map<string, AnyRow[]>();
    for (const r of rules) matched.set(r.id, parts.flatMap((p) => p.matched.get(r.id) ?? []));
    return { styles, rings, matched };
  }, [players, items, containers, rest, rules]);
}
