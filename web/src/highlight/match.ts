// Highlights: things picked out on the map and in the list, by rules made in the global search
// (components/Highlights.tsx). A highlight never hides anything; it wins over what hides things (the
// list's filters, the map's layers).
//
// A rule is a Match: every field given must hold (AND); a list field holds when any of its values
// does (OR).

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
  if (m.tpls && !row.tpls.some((t) => m.tpls!.includes(t))) return false;
  if (m.categories && !row.tpls.some((t) => catalog.lookup(t)?.categories?.some((c) => m.categories!.includes(c)))) return false;
  if (m.text !== undefined && !matchesText(row, m.text)) return false;
  return true;
}

/** Whether a match says anything at all (an empty one would match everything). */
export const isEmptyMatch = (m: Match): boolean =>
  !m.text?.trim() && !m.subjects && !m.categories && !m.tpls && !m.playerTypes && m.minValue === undefined;

export function allRows(rows: TabRows): AnyRow[] {
  return [...rows.players, ...rows.items, ...rows.containers, ...rows.exfils, ...rows.explosives];
}

export function matchingRows(rows: readonly AnyRow[], m: Match, catalog: ItemCatalog): AnyRow[] {
  return isEmptyMatch(m) ? [] : rows.filter((r) => matches(r, m, catalog));
}

export interface HighlightState {
  /** Row key → the colour it's highlighted in (the first highlight that matches it, in pill order). */
  colors: Map<string, string>;
  /** Highlight id → the rows it matches (on or off). */
  matched: Map<number, AnyRow[]>;
}

export function evaluateHighlights(rows: readonly AnyRow[], highlights: readonly Highlight[], catalog: ItemCatalog): HighlightState {
  const colors = new Map<string, string>();
  const matched = new Map<number, AnyRow[]>();
  for (const h of highlights) {
    const hits = matchingRows(rows, h.match, catalog);
    matched.set(h.id, hits);
    if (h.on) for (const r of hits) if (!colors.has(r.key)) colors.set(r.key, h.color);
  }
  return { colors, matched };
}
