// Display rules: how everything on the map (and in the list) looks, as one ordered list of rules. A rule
// is a query (highlight/query.ts) and the style properties it sets. Every thing starts from its kind's
// base style (BASE); each rule that matches it sets its properties on top, in order, so later rules win
// property by property: "BEAR: red" and "Gear ≥ 500k: ringed" together give a ringed red marker.
//
// The order, bottom to top: the rules (rules/defaults.ts out of the box, as changed in the Map view;
// rules/store.ts), the pinned ones, then highlights (the global search). Last, groups switched off hide
// their kinds of thing, except what's ringed: highlights (and rules that ring) beat hiding. What stays
// in code, outside the rules: shapes (how each kind is drawn), the state of a thing (the dead are grey,
// those who left faded, an exfil's colour is its status), the local player, and where labels go.

import type { ItemCatalog } from "../items";
import type { AnyRow, RowBase, SubjectKind } from "../list/rows";
import { LABEL_DETAIL } from "../declutter";
import { compileQuery } from "../highlight/query";

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
  /** A ring in this colour, and loot labelled in it at any zoom; shown even where its group is off. */
  ring?: string;
}

/** What a rule sets: any of the style's properties. */
export type StyleProps = Partial<Style>;

export interface Rule {
  /** Stable: rules made from the defaults keep theirs ("player.usec"). */
  id: string;
  /** "USEC", "Cheap items" */
  label: string;
  /** What it matches (highlight/query.ts). */
  query: string;
  style: StyleProps;
  /** Off: it doesn't apply (default: on). */
  on?: boolean;
}

/**
 * Each kind's style before any rule. Colours are rules (defaults.ts), so they can be changed. Only
 * players are shown without a rule (switching rules off never loses one); everything else is shown by
 * a rule, so switching off the rules that match a thing hides it ("Items" off: only the loot other
 * rules show is left).
 */
export const BASE: Record<SubjectKind, Style> = {
  player: { show: 0, emphasis: "normal", label: "always", labelFrom: 0 },
  item: { show: null, emphasis: "normal", label: "room", labelFrom: LABEL_DETAIL.items },
  quest: { show: null, emphasis: "normal", label: "room", labelFrom: 0 },
  container: { show: null, emphasis: "normal", label: "room", labelFrom: LABEL_DETAIL.containers },
  airdrop: { show: null, emphasis: "normal", label: "always", labelFrom: 0 },
  corpse: { show: null, emphasis: "normal", label: "never", labelFrom: 0 },
  exfil: { show: null, emphasis: "normal", label: "always", labelFrom: 0 },
  grenade: { show: null, emphasis: "normal", label: "never", labelFrom: 0 },
  tripwire: { show: null, emphasis: "normal", label: "never", labelFrom: 0 },
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
  /** Rule id → the rows it matches (on or off). */
  matched: Map<string, AnyRow[]>;
}

/** Applies the rules (bottom to top) to every row; then hides the `hidden` kinds, unless ringed. */
export function applyRules(rows: readonly AnyRow[], rules: readonly Rule[], catalog: ItemCatalog, hidden: ReadonlySet<SubjectKind> = NO_KINDS): Styled {
  const styles = new Map<string, Style>();
  const matched = new Map<string, AnyRow[]>();
  const compiled = rules.map((r) => ({ rule: r, test: compileQuery(r.query, catalog).test, on: r.on !== false, hits: [] as AnyRow[] }));
  for (const c of compiled) matched.set(c.rule.id, c.hits);
  for (const row of rows) {
    const s: Style = { ...BASE[row.subject] };
    for (const c of compiled) {
      if (!c.test(row)) continue;
      c.hits.push(row);
      if (c.on) setProps(s, c.rule.style);
    }
    if (hidden.has(row.subject) && !s.ring) s.show = null;
    styles.set(row.key, s);
  }
  return { styles, matched };
}

const NO_KINDS: ReadonlySet<SubjectKind> = new Set();

function setProps(s: Style, props: StyleProps): void {
  for (const k of Object.keys(props) as (keyof Style)[]) {
    const v = props[k];
    if (v !== undefined) (s as unknown as Record<string, unknown>)[k] = v;
  }
}

/** One rule's part in a thing's look: the properties it set, and which of them later ones overrode. */
export interface Contribution {
  rule: Rule;
  set: (keyof Style)[];
  overridden: (keyof Style)[];
}

/** Why a thing looks the way it does: the rules that match it, bottom to top, and whether its group
 *  being off hid it. */
export function explainStyle(row: RowBase, rules: readonly Rule[], catalog: ItemCatalog, hidden: ReadonlySet<SubjectKind> = NO_KINDS): { parts: Contribution[]; style: Style; hiddenByGroup: boolean } {
  const parts: Contribution[] = [];
  const s: Style = { ...BASE[row.subject] };
  const setBy = new Map<keyof Style, Contribution>();
  for (const rule of rules) {
    if (rule.on === false || !compileQuery(rule.query, catalog).test(row)) continue;
    const c: Contribution = { rule, set: [], overridden: [] };
    for (const k of Object.keys(rule.style) as (keyof Style)[]) {
      if (rule.style[k] === undefined) continue;
      const before = setBy.get(k);
      if (before) before.overridden.push(k);
      setBy.set(k, c);
      c.set.push(k);
    }
    setProps(s, rule.style);
    parts.push(c);
  }
  const hiddenByGroup = hidden.has(row.subject) && !s.ring;
  if (hiddenByGroup) s.show = null;
  return { parts, style: s, hiddenByGroup };
}

/** A highlight (the global search): its matches ringed in its colour and shown at every zoom, whatever
 *  the groups say; loot labelled in the ring's colour. */
export function highlightRule(id: string, label: string, query: string, color: string, on: boolean): Rule {
  return { id, label, query, style: highlightStyle(color), on };
}

export const highlightStyle = (color: string): StyleProps => ({ show: 0, ring: color });
