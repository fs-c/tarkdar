// What's kept of the rules (localStorage): every rule (made from the defaults, then changed, moved,
// duplicated, removed or added in the Filters view), the categories switched off, and the pinned rules of
// the current raid. And how that turns into the rules to apply, bottom to top: the rules by category
// (defaults.ts CATEGORIES), then the pinned ones. Highlights go on top of all of them (useRules.ts).
//
// Stored rules of format version 3 (the first with every rule stored) become settings version 1;
// older ones are dropped for the defaults. Version 2 added the Vehicles category's rule.

import { useEffect } from "react";
import { defineStore, isObject, usePersisted } from "../persist";
import type { SubjectKind } from "../list/rows";
import { CATEGORIES, type Category, DEFAULT_HIDDEN, DEFAULT_RULES, HIDEABLE } from "./defaults";
import { EMPHASES, type Rule, type StyleProps } from "./rules";

export interface StoredRule {
  id: string;
  /** The default it was made from (unchanged, it counts as that default). */
  origin?: string;
  category: Category;
  label: string;
  query: string;
  style: StyleProps;
  on: boolean;
}

export interface RuleStore {
  /** In order within each category, bottom to top. */
  rules: StoredRule[];
  /** Categories switched off: what's in them is hidden, except what's ringed (highlights). */
  hidden: Category[];
}

const fromDefault = (d: (typeof DEFAULT_RULES)[number], id = d.id): StoredRule => ({
  id, origin: d.id, category: d.category, label: d.label, query: d.query, style: { ...d.style }, on: true,
});

export const defaultStore = (): RuleStore => ({ rules: DEFAULT_RULES.map((d) => fromDefault(d)), hidden: [...DEFAULT_HIDDEN] });

const byCategory = (a: StoredRule, b: StoredRule) => CATEGORIES.indexOf(a.category) - CATEGORIES.indexOf(b.category);

export const asRule = (r: StoredRule): Rule => ({ id: r.id, label: r.label, query: r.query, style: r.style, on: r.on });

/** The rules to apply, bottom to top: by category, then the pinned ones (without highlights). */
export function storedRules(store: RuleStore, pinned: readonly StoredRule[] = []): Rule[] {
  return [...[...store.rules].sort(byCategory), ...pinned].map(asRule); // sort is stable: order within a category kept
}

/** The kinds of thing switched off. */
export function hiddenKinds(store: RuleStore): Set<SubjectKind> {
  return new Set(store.hidden.flatMap((c) => HIDEABLE[c] ?? []));
}

// ---- Changes (pure, for the Filters view) ----

let counter = 0;
export const newRuleId = (): string => `r:${Date.now().toString(36)}${(counter++).toString(36)}`;

export const updateRule = (rules: StoredRule[], id: string, patch: Partial<StoredRule>): StoredRule[] =>
  rules.map((r) => (r.id === id ? { ...r, ...patch } : r));

export const removeRule = (rules: StoredRule[], id: string): StoredRule[] => rules.filter((r) => r.id !== id);

/** Up (+1, wins over more) or down (−1): within its category, or (pinned rules) in the whole list. */
export function moveRule(rules: StoredRule[], id: string, dir: -1 | 1, withinCategory = true): StoredRule[] {
  const i = rules.findIndex((r) => r.id === id);
  if (i < 0) return rules;
  let j = i + dir;
  while (withinCategory && j >= 0 && j < rules.length && rules[j]!.category !== rules[i]!.category) j += dir;
  if (j < 0 || j >= rules.length) return rules;
  const out = [...rules];
  [out[i], out[j]] = [out[j]!, out[i]!];
  return out;
}

/** A copy right above it (winning over it). */
export function duplicateRule(rules: StoredRule[], id: string): StoredRule[] {
  const i = rules.findIndex((r) => r.id === id);
  if (i < 0) return rules;
  const { origin: _, ...copy } = rules[i]!;
  const out = [...rules];
  out.splice(i + 1, 0, { ...copy, id: newRuleId(), label: `${copy.label} (copy)`, style: { ...copy.style } });
  return out;
}

/** Added on top of its category. */
export function addRule(rules: StoredRule[], rule: StoredRule): StoredRule[] {
  let i = rules.length;
  let top = -1;
  rules.forEach((r, n) => {
    if (r.category === rule.category) top = n;
  });
  if (top >= 0) i = top + 1;
  else {
    // An empty category: before the first rule of a later one.
    const later = rules.findIndex((r) => CATEGORIES.indexOf(r.category) > CATEGORIES.indexOf(rule.category));
    if (later >= 0) i = later;
  }
  const out = [...rules];
  out.splice(i, 0, rule);
  return out;
}

export const defaultOf = (r: StoredRule) => (r.origin ? DEFAULT_RULES.find((d) => d.id === r.origin) : undefined);

/** Differs from the default it was made from. */
export function isChanged(r: StoredRule): boolean {
  const d = defaultOf(r);
  if (!d) return false;
  return r.label !== d.label || r.query !== d.query || r.category !== d.category || !r.on || JSON.stringify(sortKeys(r.style)) !== JSON.stringify(sortKeys(d.style));
}

const sortKeys = (o: object) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b)));

/** A category's rules differ from its defaults: one changed, removed, added or moved. */
export function categoryChanged(rules: readonly StoredRule[], category: Category): boolean {
  const mine = rules.filter((r) => r.category === category);
  const defaults = DEFAULT_RULES.filter((d) => d.category === category);
  return mine.length !== defaults.length || mine.some((r, i) => r.origin !== defaults[i]!.id || isChanged(r));
}

/** A category back to its defaults: its own rules go, the defaults come back as they were (in place). */
export function resetCategory(rules: readonly StoredRule[], category: Category): StoredRule[] {
  let out = rules.filter((r) => r.category !== category);
  for (const d of DEFAULT_RULES) if (d.category === category) out = addRule(out, fromDefault(d));
  return out;
}

/** The defaults that were removed: back where they'd be (after the default before them). */
export function restoreDefaults(rules: StoredRule[]): StoredRule[] {
  let out = [...rules];
  DEFAULT_RULES.forEach((d, n) => {
    if (out.some((r) => r.origin === d.id)) return;
    const present = (p: (typeof DEFAULT_RULES)[number]) => p.category === d.category && out.some((r) => r.origin === p.id);
    const before = DEFAULT_RULES.slice(0, n).reverse().find(present);
    const after = DEFAULT_RULES.slice(n + 1).find(present);
    if (before) out.splice(out.findIndex((r) => r.origin === before.id) + 1, 0, fromDefault(d));
    else if (after) out.splice(out.findIndex((r) => r.origin === after.id), 0, fromDefault(d));
    else out = addRule(out, fromDefault(d));
  });
  return out;
}

export const missingDefaults = (rules: readonly StoredRule[]): number => DEFAULT_RULES.filter((d) => !rules.some((r) => r.origin === d.id)).length;

// ---- Stored state: checked when read ----

export function cleanStyle(v: unknown): StyleProps {
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

export function cleanRules(v: unknown): StoredRule[] {
  if (!Array.isArray(v)) return [];
  const ids = new Set<string>();
  return v.flatMap((r): StoredRule[] => {
    if (!isObject(r) || typeof r.id !== "string" || ids.has(r.id) || typeof r.query !== "string" || !CATEGORIES.includes(r.category as Category)) return [];
    ids.add(r.id);
    const out: StoredRule = { id: r.id, category: r.category as Category, label: String(r.label ?? ""), query: r.query, style: cleanStyle(r.style), on: r.on !== false };
    if (typeof r.origin === "string" && DEFAULT_RULES.some((d) => d.id === r.origin)) out.origin = r.origin;
    return [out];
  });
}

/** Stored rules as they are, minus anything malformed; garbage, or no list of rules: the defaults. */
export function normalizeStore(stored: unknown): RuleStore {
  if (!isObject(stored)) return defaultStore();
  const hidden = Array.isArray(stored.hidden) ? stored.hidden.filter((g): g is Category => typeof g === "string" && Object.hasOwn(HIDEABLE, g)) : [...DEFAULT_HIDDEN];
  return { rules: Array.isArray(stored.rules) ? cleanRules(stored.rules) : defaultStore().rules, hidden };
}

export const ruleStore = defineStore<RuleStore>({
  key: "radar.rules",
  version: 4,
  scope: "user",
  defaults: defaultStore,
  migrations: {
    // Unversioned: the rules' own format version inside.
    0: (d) => {
      if (!isObject(d) || d.version !== 3) throw new Error("rules of an older format");
      const { version: _, ...rest } = d;
      return rest;
    },
    // The Vehicles category: the BTR used to be drawn without a rule, so stored lists get its rule.
    1: (d) => {
      if (!isObject(d) || !Array.isArray(d.rules)) return d;
      const vehicle = { id: "vehicle", origin: "vehicle", category: "Vehicles", label: "Vehicles", query: "is:vehicle", style: { color: "#f2c14e", show: 0 }, on: true };
      return { ...d, rules: [...d.rules, vehicle] };
    },
    // Players and corpses carrying what a quest needs: a new General rule.
    2: (d) => {
      if (!isObject(d) || !Array.isArray(d.rules) || d.rules.some((r) => isObject(r) && r.origin === "gear.quest-needed")) return d;
      const gear = DEFAULT_RULES.find((r) => r.id === "gear.quest-needed")!;
      return { ...d, rules: [...d.rules, fromDefault(gear)] };
    },
    // Quest needs: only what has to be found in raid is singled out (is:fir), what can be bought isn't.
    // Rules still as their old default get the new one; changed ones stay.
    3: (d) => {
      if (!isObject(d) || !Array.isArray(d.rules)) return d;
      const old: Record<string, { label: string; query: string }> = {
        "item.quest-needed": { label: "Needed for quests", query: "is:item is:needed" },
        "gear.quest-needed": { label: "Carrying needed items", query: "is:player,corpse is:needed" },
      };
      const rules = d.rules.map((r) => {
        const was = isObject(r) && typeof r.origin === "string" ? old[r.origin] : undefined;
        const now = was && DEFAULT_RULES.find((x) => x.id === (r as { origin: string }).origin);
        if (!was || !now || !isObject(r)) return r;
        return { ...r, ...(r.query === was.query ? { query: now.query } : {}), ...(r.label === was.label ? { label: now.label } : {}) };
      });
      return { ...d, rules };
    },
  },
  normalize: normalizeStore,
});

export type SetRuleStore = (update: (prev: RuleStore) => RuleStore) => void;

export const useRuleStore = (): [RuleStore, SetRuleStore] => usePersisted(ruleStore);

// ---- Pinned rules: kept for one raid (across reloads), then dropped ----

export interface PinnedStore {
  /** The raid they're for (useRaidKey); null: none yet. */
  raid: string | null;
  rules: StoredRule[];
}

export type SetPinned = (update: (prev: StoredRule[]) => StoredRule[]) => void;

/** `raid`: the live raid's key, null outside one (the pinned rules then stay as they are). */
export const pinnedStore = defineStore<PinnedStore>({
  key: "radar.pinned",
  version: 1,
  scope: "user",
  defaults: () => ({ raid: null, rules: [] }),
  normalize: (d) => ({ raid: isObject(d) && typeof d.raid === "string" ? d.raid : null, rules: isObject(d) ? cleanRules(d.rules) : [] }),
});

export function usePinned(raid: string | null): [StoredRule[], SetPinned] {
  const [stored, setStored] = usePersisted(pinnedStore);
  // A new raid: the last one's pinned rules go.
  useEffect(() => {
    if (raid !== null && stored.raid !== raid) setStored((p) => ({ raid, rules: p.raid === null ? p.rules : [] }));
  }, [raid, stored.raid]);
  return [stored.rules, (update) => setStored((p) => ({ raid: p.raid ?? raid, rules: update(p.rules) }))];
}
