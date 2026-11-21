// The display rules as App applies them: the stored ones and the pinned ones, then the highlights (and
// the global search's live preview) on top; the categories switched off last. Applied per tab, so loot
// (thousands of rows, changing rarely) isn't matched again every time players move.

import { useMemo } from "react";
import type { Highlight } from "../highlight/match";
import { nextColor } from "../highlight/match";
import type { ItemCatalog } from "../model/items";
import type { AnyRow, SubjectKind, TabRows } from "../list/rows";
import { type Rule, type Style, applyRules, highlightRule } from "./rules";

/** Rule id of a highlight, and of the search's preview. */
export const highlightId = (id: number) => `highlight:${id}`;
export const PREVIEW_ID = "highlight:preview";

/**
 * Highlights as rules, bottom to top: the preview lowest (what's highlighted already keeps its colour),
 * then the pills from last to first (the first pill that matches a thing gives it its colour).
 */
export function highlightRules(highlights: readonly Highlight[], preview: string | null): Rule[] {
  const rules = highlights.map((h) => highlightRule(highlightId(h.id), h.label, h.query, h.color, h.on)).reverse();
  if (preview) rules.unshift(highlightRule(PREVIEW_ID, "", preview, nextColor(highlights), true));
  return rules;
}

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
  const rest = useMemo(() => applyRules([...all.exfils, ...all.explosives], rules, catalog, hidden), [all.exfils, all.explosives, rules, catalog, hidden]);
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
