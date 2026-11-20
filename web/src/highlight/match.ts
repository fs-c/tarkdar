// Highlights: rules made in the global search (components/Highlights.tsx), matching by a query
// (highlight/query.ts). A highlight never hides anything; it wins over what hides things (the list's
// filters, the groups switched off in the Filters view).

import type { ItemCatalog } from "../items";
import type { AnyRow, TabRows } from "../list/rows";
import { compileQuery } from "./query";

export interface Highlight {
  id: number;
  /** Pill text: "LEDX", "Electronics", "Items ≥ 50k". */
  label: string;
  /** What kind of rule it is ("Item", "Category", ...), for the pill's tooltip. */
  group: string;
  query: string;
  color: string;
  on: boolean;
}

/** Highlight colours, handed out in turn. Chosen to stand apart from the markers' own colours. */
export const HIGHLIGHT_COLORS = ["#ff8a3d", "#5ce1e6", "#c084fc", "#a3e635", "#f472b6", "#facc15"];

/** The colour a new highlight gets: the first one not in use (or the next in turn). */
export function nextColor(highlights: readonly { color: string }[]): string {
  const used = new Set(highlights.map((h) => h.color));
  return HIGHLIGHT_COLORS.find((c) => !used.has(c)) ?? HIGHLIGHT_COLORS[highlights.length % HIGHLIGHT_COLORS.length]!;
}

export function allRows(rows: TabRows): AnyRow[] {
  return [...rows.players, ...rows.items, ...rows.containers, ...rows.exfils, ...rows.explosives];
}

export function matchingRows(rows: readonly AnyRow[], query: string, catalog: ItemCatalog): AnyRow[] {
  const q = compileQuery(query, catalog);
  return rows.filter(q.test);
}
