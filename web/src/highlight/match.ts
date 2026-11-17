// Matching things: the condition half of a display rule (rules/), and of a highlight, the rules made in
// the global search (components/Highlights.tsx). A highlight never hides anything; it wins over what
// hides things (the list's filters, the built-in rules that hide layers).
//
// A Match: every field given must hold (AND); a list field holds when any of its values does (OR).

import type { ItemCatalog } from "../items";
import type { AnyRow, PlayerRow, RowBase, SubjectKind, TabRows } from "../list/rows";
import { matchesText } from "../list/rows";
import type { PlayerType } from "../roles";

export interface Match {
  /** Free text, as in the list's search: every term must appear. */
  text?: string;
  subjects?: SubjectKind[];
  /** Handbook category ids: the thing is, or carries, an item in one of them. */
  categories?: string[];
  /** Item templates: the thing is, or carries, one of them. */
  tpls?: string[];
  playerTypes?: PlayerType[];
  /** Minimum value (roubles, see RowBase.value). Unknown values don't match. */
  minValue?: number;
  /** Below this value (roubles). Unknown values count as 0 (unpriced items are cheap ones). */
  maxValue?: number;
}

export interface Highlight {
  id: number;
  /** Pill text: "LEDX", "Electronics", "Items ≥ 50k". */
  label: string;
  /** What kind of rule it is ("Item", "Category", ...), for the pill's tooltip. */
  group: string;
  match: Match;
  color: string;
  on: boolean;
}

/** Highlight colours, handed out in turn. Chosen to stand apart from the markers' own colours. */
export const HIGHLIGHT_COLORS = ["#ff8a3d", "#5ce1e6", "#c084fc", "#a3e635", "#f472b6", "#facc15"];

/** The colour a new highlight gets: the first one not in use (or the next in turn). */
export function nextColor(highlights: readonly Highlight[]): string {
  const used = new Set(highlights.map((h) => h.color));
  return HIGHLIGHT_COLORS.find((c) => !used.has(c)) ?? HIGHLIGHT_COLORS[highlights.length % HIGHLIGHT_COLORS.length]!;
}

export function matches(row: RowBase, m: Match, catalog: ItemCatalog): boolean {
  if (row.subject === "player" && (row as PlayerRow).local) return false; // we know where we are
  if (m.subjects && !m.subjects.includes(row.subject)) return false;
  if (m.playerTypes && (row.subject !== "player" || !m.playerTypes.includes((row as PlayerRow).type))) return false;
  if (m.minValue !== undefined && (row.value === undefined || row.value < m.minValue)) return false;
  if (m.maxValue !== undefined && (row.value ?? 0) >= m.maxValue) return false;
  if (m.tpls && !row.tpls.some((t) => m.tpls!.includes(t))) return false;
  if (m.categories && !row.tpls.some((t) => catalog.lookup(t)?.categories?.some((c) => m.categories!.includes(c)))) return false;
  if (m.text !== undefined && !matchesText(row, m.text)) return false;
  return true;
}

/** Whether a match says anything at all (an empty one would match everything). */
export const isEmptyMatch = (m: Match): boolean =>
  !m.text?.trim() && !m.subjects && !m.categories && !m.tpls && !m.playerTypes && m.minValue === undefined && m.maxValue === undefined;

export function allRows(rows: TabRows): AnyRow[] {
  return [...rows.players, ...rows.items, ...rows.containers, ...rows.exfils, ...rows.explosives];
}

export function matchingRows(rows: readonly AnyRow[], m: Match, catalog: ItemCatalog): AnyRow[] {
  return isEmptyMatch(m) ? [] : rows.filter((r) => matches(r, m, catalog));
}
