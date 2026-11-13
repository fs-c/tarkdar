// Highlights as App keeps them: the rules (session memory only, for now), the search's live preview,
// and what they match. Evaluated per tab, so loot (thousands of rows, changing rarely) isn't matched
// again every time players move.

import { useMemo } from "react";
import type { ItemCatalog } from "../items";
import type { AnyRow, TabRows } from "../list/rows";
import { type Highlight, type HighlightState, type Match, evaluateHighlights, nextColor } from "./match";

/** Id of the search's preview among the evaluated highlights. */
export const PREVIEW_ID = -1;

export function useHighlights(all: TabRows, highlights: readonly Highlight[], preview: Match | null, catalog: ItemCatalog): HighlightState {
  // The preview goes last: what's highlighted already keeps its colour.
  const rules = useMemo(
    () => (preview ? [...highlights, { id: PREVIEW_ID, label: "", group: "", match: preview, color: nextColor(highlights), on: true }] : highlights),
    [highlights, preview],
  );
  const players = useMemo(() => evaluateHighlights(all.players, rules, catalog), [all.players, rules, catalog]);
  const items = useMemo(() => evaluateHighlights(all.items, rules, catalog), [all.items, rules, catalog]);
  const containers = useMemo(() => evaluateHighlights(all.containers, rules, catalog), [all.containers, rules, catalog]);
  const rest = useMemo(() => evaluateHighlights([...all.exfils, ...all.explosives], rules, catalog), [all.exfils, all.explosives, rules, catalog]);
  return useMemo(() => {
    const parts = [players, items, containers, rest];
    const colors = new Map<string, string>();
    for (const p of parts) for (const [k, c] of p.colors) colors.set(k, c);
    const matched = new Map<number, AnyRow[]>();
    for (const h of rules) matched.set(h.id, parts.flatMap((p) => p.matched.get(h.id) ?? []));
    return { colors, matched };
  }, [players, items, containers, rest, rules]);
}
