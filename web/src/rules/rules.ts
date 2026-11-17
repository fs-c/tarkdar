// Display rules: how everything on the map (and in the list) looks, as one ordered list of rules. A rule
// is a Match (highlight/match.ts) and the style properties it sets. Every thing starts from its kind's
// base style (BASE); each rule that matches it sets its properties on top, in order, so later rules win
// property by property: "BEAR: red" and "Gear ≥ 500k: ringed" together give a ringed red marker.
//
// The order, bottom to top: the built-in rules (rules/defaults.ts: today's looks, layers, loot density,
// label thresholds), then highlights (the global search). What stays in code, outside the rules: shapes
// (how each kind is drawn), the state of a thing (the dead are grey, those who left faded, an exfil's
// colour is its status), the local player, and where labels go.

import type { ItemCatalog } from "../items";
import type { AnyRow, SubjectKind } from "../list/rows";
import { LABEL_DETAIL } from "../declutter";
import { type Match, isEmptyMatch, matches } from "../highlight/match";

/**
 * How much a thing stands out, least to most. Each kind draws it its own way: players by size, halo
 * and label (style.ts: faint = plain AI scavs, strong = guards and raiders, loud = bosses), loot and
 * the rest by marker size.
 */
export type Emphasis = "faint" | "normal" | "strong" | "loud";
export const EMPHASES: readonly Emphasis[] = ["faint", "normal", "strong", "loud"];

/**
 * Labels: never; only where there's room ("room"); or always, even on top of others ("always").
 * Where they go (players and exfils right of their marker, loot wherever it fits) is the kind's.
 */
export type LabelMode = "never" | "room" | "always";

export interface Style {
  /** Shown from this level of detail on (0: at every zoom; declutter.ts); null: hidden. */
  show: number | null;
  /** Undefined: the thing's own colour (exfils: by status). */
  color?: string;
  emphasis: Emphasis;
  label: LabelMode;
  /** Labels from this level of detail on. */
  labelFrom: number;
  /** A ring in this colour, and loot labelled in it at any zoom (highlights). */
  ring?: string;
}

/** What a rule sets: any of the style's properties. */
export type StyleProps = Partial<Style>;

export interface Rule {
  /** Stable: built-in rules keep theirs across versions ("player.usec"). */
  id: string;
  /** "USEC", "Cheap items" */
  label: string;
  match: Match;
  style: StyleProps;
  /** Off: it doesn't apply (default: on). */
  on?: boolean;
  /** Keep what it matches (on or off), e.g. for a highlight's count. */
  track?: boolean;
}

/** Each kind's style before any rule. Colours are rules (defaults.ts), so they can be changed. */
export const BASE: Record<SubjectKind, Style> = {
  player: { show: 0, emphasis: "normal", label: "always", labelFrom: 0 },
  item: { show: 0, emphasis: "normal", label: "room", labelFrom: LABEL_DETAIL.items },
  quest: { show: 0, emphasis: "normal", label: "room", labelFrom: 0 },
  container: { show: 0, emphasis: "normal", label: "room", labelFrom: LABEL_DETAIL.containers },
  airdrop: { show: 0, emphasis: "normal", label: "always", labelFrom: 0 },
  corpse: { show: 0, emphasis: "normal", label: "never", labelFrom: 0 },
  exfil: { show: 0, emphasis: "normal", label: "always", labelFrom: 0 },
  grenade: { show: 0, emphasis: "normal", label: "never", labelFrom: 0 },
  tripwire: { show: 0, emphasis: "normal", label: "never", labelFrom: 0 },
};

/** Shown at this level of detail. */
export const isShown = (s: Style, detail: number): boolean => s.show !== null && detail >= s.show;

/** Labelled at this level of detail: not at all (null), where there's room, or always (forced). */
export function labelAt(s: Style, detail: number): { forced: boolean } | null {
  if (s.label === "never" || detail < s.labelFrom) return null;
  return { forced: s.label === "always" };
}

export interface Styled {
  /** Row key → its style. */
  styles: Map<string, Style>;
  /** Rule id → the rows it matches (tracked rules only). */
  matched: Map<string, AnyRow[]>;
}

/** Applies the rules (bottom to top) to every row. */
export function applyRules(rows: readonly AnyRow[], rules: readonly Rule[], catalog: ItemCatalog): Styled {
  const styles = new Map<string, Style>();
  const matched = new Map<string, AnyRow[]>();
  const active = rules.filter((r) => r.on !== false || r.track);
  for (const r of active) if (r.track) matched.set(r.id, []);
  for (const row of rows) {
    const s: Style = { ...BASE[row.subject] };
    for (const rule of active) {
      if (!matches(row, rule.match, catalog)) continue;
      if (rule.track) matched.get(rule.id)!.push(row);
      if (rule.on !== false) setProps(s, rule.style);
    }
    styles.set(row.key, s);
  }
  return { styles, matched };
}

function setProps(s: Style, props: StyleProps): void {
  for (const k of Object.keys(props) as (keyof Style)[]) {
    const v = props[k];
    if (v !== undefined) (s as unknown as Record<string, unknown>)[k] = v;
  }
}

/** A highlight (the global search): its matches ringed in its colour, shown at every zoom and whatever
 *  the layers say, loot labelled. An empty match is nothing to highlight (it would match everything). */
export function highlightRule(id: string, label: string, match: Match, color: string, on: boolean): Rule {
  return { id, label, match: isEmptyMatch(match) ? { tpls: [] } : match, style: { show: 0, ring: color }, on, track: true };
}
