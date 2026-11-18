// What's kept of the rules (localStorage): changes to the built-in rules, the groups switched off, and
// the standing rules (pinned highlights). And how that turns into the rules to apply, bottom to top:
// the built-in rules (with their changes), the hidden groups, the standing rules. Highlights go on top
// of all of them (useRules.ts).

import type { Match } from "../highlight/match";
import { isEmptyMatch } from "../highlight/match";
import { usePersistentState } from "../hooks";
import { useMemo } from "react";
import { BUILTIN_RULES, DEFAULT_HIDDEN, type GroupedRule, HIDEABLE, type RuleGroup, SHOW_LEVELS } from "./defaults";
import { EMPHASES, type StyleProps } from "./rules";

/** A change to a built-in rule: style properties, and its value bounds (rules that have them). */
export type RuleEdit = StyleProps & Pick<Match, "minValue" | "maxValue">;

/** A standing rule: made from a highlight, kept until removed. */
export interface StandingRule {
  id: string;
  label: string;
  /** What kind of rule it was made from ("Item", "Category", ...). */
  kind: string;
  match: Match;
  style: StyleProps;
  on: boolean;
}

export interface RuleStore {
  /** Built-in rule id → what's changed. */
  edits: Record<string, RuleEdit>;
  /** Groups switched off: what's in them is hidden, except what standing rules or highlights show. */
  hidden: RuleGroup[];
  /** Standing rules, bottom to top. */
  mine: StandingRule[];
}

export const EMPTY_STORE: RuleStore = { edits: {}, hidden: [...DEFAULT_HIDDEN], mine: [] };

/** A built-in rule with its changes. */
export function editedRule(r: GroupedRule, edit: RuleEdit | undefined): GroupedRule {
  if (!edit) return r;
  const { minValue, maxValue, ...style } = edit;
  const match = { ...r.match };
  if (minValue !== undefined && r.match.minValue !== undefined) match.minValue = minValue;
  if (maxValue !== undefined && r.match.maxValue !== undefined) match.maxValue = maxValue;
  return { ...r, match, style: { ...r.style, ...style } };
}

export const standingRuleId = (n: number) => `mine:${n}`;

/** The rules to apply, bottom to top (without highlights). */
export function storedRules(store: RuleStore): GroupedRule[] {
  const builtin = BUILTIN_RULES.map((r) => editedRule(r, store.edits[r.id]));
  const hidden = store.hidden.flatMap((g): GroupedRule[] => {
    const subjects = HIDEABLE[g];
    return subjects ? [{ group: g, id: `hidden.${g}`, label: `${g} off`, match: { subjects }, style: { show: null } }] : [];
  });
  const mine = store.mine.map((m): GroupedRule => ({ group: "Mine", id: m.id, label: m.label, match: m.match, style: m.style, on: m.on, track: true }));
  return [...builtin, ...hidden, ...mine];
}

// ---- Stored state: checked when read, and made from the old Map panel settings the first time ----

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

function cleanStyle(v: unknown): StyleProps {
  if (!isObject(v)) return {};
  const out: StyleProps = {};
  if (v.show === null || typeof v.show === "number") out.show = v.show;
  if (typeof v.color === "string") out.color = v.color;
  if (typeof v.ring === "string") out.ring = v.ring;
  if (EMPHASES.includes(v.emphasis as never)) out.emphasis = v.emphasis as StyleProps["emphasis"];
  if (v.label === "never" || v.label === "room" || v.label === "always") out.label = v.label;
  if (typeof v.labelFrom === "number") out.labelFrom = v.labelFrom;
  return out;
}

/** Stored rules as they are, minus anything unknown or malformed (from older versions, or garbage). */
export function normalizeStore(stored: unknown): RuleStore {
  if (!isObject(stored)) return EMPTY_STORE;
  const known = new Set(BUILTIN_RULES.map((r) => r.id));
  const edits: Record<string, RuleEdit> = {};
  if (isObject(stored.edits))
    for (const [id, e] of Object.entries(stored.edits)) {
      if (!known.has(id) || !isObject(e)) continue;
      const edit: RuleEdit = cleanStyle(e);
      if (typeof e.minValue === "number") edit.minValue = e.minValue;
      if (typeof e.maxValue === "number") edit.maxValue = e.maxValue;
      edits[id] = edit;
    }
  const hidden = Array.isArray(stored.hidden) ? stored.hidden.filter((g): g is RuleGroup => typeof g === "string" && g in HIDEABLE) : [...DEFAULT_HIDDEN];
  const mine = Array.isArray(stored.mine)
    ? stored.mine.flatMap((m): StandingRule[] =>
        isObject(m) && typeof m.id === "string" && isObject(m.match) && !isEmptyMatch(m.match as Match)
          ? [{ id: m.id, label: String(m.label ?? ""), kind: String(m.kind ?? ""), match: m.match as Match, style: cleanStyle(m.style), on: m.on !== false }]
          : [],
      )
    : [];
  return { edits, hidden, mine };
}

/** The old Map panel settings (radar.layers, radar.loot), as rules: hidden groups, and loose items'
 *  density and label threshold as changes to the item rules. */
export function fromLegacyPrefs(layers: unknown, loot: unknown): RuleStore {
  const store: RuleStore = { edits: {}, hidden: [...DEFAULT_HIDDEN], mine: [] };
  if (isObject(layers)) {
    const off: [string, RuleGroup][] = [["loot", "Loot"], ["containers", "Containers"], ["exfils", "Exfils"], ["explosives", "Explosives"]];
    store.hidden = off.filter(([k]) => layers[k] === false).map(([, g]) => g);
  }
  if (isObject(loot)) {
    // "fewer" is what the built-in rules say already.
    if (loot.density === "all") store.edits = { "item.all": { show: SHOW_LEVELS.always }, "item.cheap": { show: SHOW_LEVELS.always } };
    if (loot.density === "fewest") store.edits = { "item.all": { show: SHOW_LEVELS.mid }, "item.cheap": { show: SHOW_LEVELS.close } };
    // A label threshold: cheap items get none.
    if (typeof loot.minLabelPrice === "number" && loot.minLabelPrice > 0) store.edits["item.cheap"] = { ...store.edits["item.cheap"], label: "never" };
  }
  return store;
}

function legacyStore(): RuleStore {
  try {
    const read = (k: string) => JSON.parse(localStorage.getItem(k) ?? "null") as unknown;
    return fromLegacyPrefs(read("radar.layers"), read("radar.loot"));
  } catch {
    return EMPTY_STORE;
  }
}

const STORAGE_KEY = "radar.rules";

export type SetRuleStore = (update: (prev: RuleStore) => RuleStore) => void;

export function useRuleStore(): [RuleStore, SetRuleStore] {
  // The first time (nothing stored yet): made from the old settings.
  const initial = useMemo(() => (localStorage.getItem(STORAGE_KEY) === null ? legacyStore() : EMPTY_STORE), []);
  const [stored, setStored] = usePersistentState<RuleStore>(STORAGE_KEY, initial);
  const store = useMemo(() => normalizeStore(stored), [stored]);
  return [store, (update) => setStored((s) => update(normalizeStore(s)))];
}
