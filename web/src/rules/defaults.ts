// The built-in rules: how things look out of the box, as rules (rules.ts) instead of tables in code.
// Players by type, loose items by value, the other loot kinds, explosives. Then what the Map panel's
// settings say (layers, loot density, labels by price), as rules too, generated from those settings.

import { VALUE_TIERS, type ValueTier } from "../items";
import { LOOT_DENSITY, type LootDensity } from "../declutter";
import type { Match } from "../highlight/match";
import type { Layers } from "../render";
import type { PlayerType } from "../roles";
import { COLORS } from "../style";
import { ui } from "../theme";
import type { Emphasis, Rule, StyleProps } from "./rules";

export type RuleGroup = "Players" | "Loot" | "Containers" | "Exfils" | "Explosives";

export interface BuiltinRule extends Rule {
  group: RuleGroup;
}

const rule = (group: RuleGroup, id: string, label: string, match: Match, style: StyleProps): BuiltinRule => ({ group, id, label, match, style });

const player = (type: PlayerType, label: string, color: string, emphasis: Emphasis = "normal") =>
  rule("Players", `player.${type}`, label, { playerTypes: [type] }, { color, emphasis });

/** Players by type: colour and how much they stand out (style.ts draws the emphasis). */
export const PLAYER_RULES: readonly BuiltinRule[] = [
  player("usec", "USEC", ui.link),
  player("bear", "BEAR", ui.danger),
  player("p-scav", "Player scavs", ui.gold),
  player("ai-scav", "AI scavs", ui.gold, "faint"),
  player("boss", "Bosses", "#ff4fd8", "loud"),
  player("follower", "Guards", ui.warn, "strong"),
  player("raider", "Raiders", "#4de1ff", "strong"),
  player("rogue", "Rogues", "#38e8c0", "strong"),
  player("cultist", "Cultists", "#b26bff", "strong"),
  player("bd", "Black Division", "#ff7a1a", "strong"),
  player("zombie", "Infected", "#9bd14b", "faint"),
  player("other", "Other players", "#c0c0c0"),
];

const formatK = (v: number) => `${v / 1000}k`;

/** Loose items by value (unpriced ones count as cheap), and the other kinds of loot. */
export const LOOT_RULES: readonly BuiltinRule[] = [
  rule("Loot", "item.all", "Items", { subjects: ["item"] }, { color: "#e8eef2", emphasis: "normal" }),
  rule("Loot", "item.cheap", `Cheap items (< ${formatK(VALUE_TIERS.mid)})`, { subjects: ["item"], maxValue: VALUE_TIERS.mid }, { color: "#8b969f", emphasis: "faint" }),
  rule("Loot", "item.valuable", `Valuable items (≥ ${formatK(VALUE_TIERS.high)})`, { subjects: ["item"], minValue: VALUE_TIERS.high }, { color: ui.gold, emphasis: "strong" }),
  rule("Loot", "quest", "Quest items", { subjects: ["quest"] }, { color: ui.quest }),
  rule("Containers", "container", "Containers", { subjects: ["container"] }, { color: "#b08a5a" }),
  rule("Containers", "airdrop", "Airdrops", { subjects: ["airdrop"] }, { color: "#4de1ff" }),
  rule("Containers", "corpse", "Corpses", { subjects: ["corpse"] }, { color: "#9a9a9a" }),
  rule("Explosives", "explosive", "Grenades and tripwires", { subjects: ["grenade", "tripwire"] }, { color: COLORS.danger }),
];

/** The Map panel's settings, until they become rules of their own. */
export interface MapDisplayPrefs {
  layers: Layers;
  density: LootDensity;
  /** Items worth less than this (₽, per unit) get no label. */
  minLabelPrice: number;
}

const TIER_RANGE: Record<ValueTier, Match> = {
  low: { maxValue: VALUE_TIERS.mid },
  mid: { minValue: VALUE_TIERS.mid, maxValue: VALUE_TIERS.high },
  high: { minValue: VALUE_TIERS.high },
};

/** Loot density, label threshold and layers as rules, in that order (a hidden layer wins over both). */
export function prefRules({ layers, density, minLabelPrice }: MapDisplayPrefs): BuiltinRule[] {
  const out: BuiltinRule[] = [];
  const from = (LOOT_DENSITY[density] ?? LOOT_DENSITY.fewer).from;
  for (const tier of ["low", "mid", "high"] as const) {
    if (from[tier] > 0) out.push(rule("Loot", `density.${tier}`, `Zoomed out: ${tier} items`, { subjects: ["item"], ...TIER_RANGE[tier] }, { show: from[tier] }));
  }
  if (minLabelPrice > 0)
    out.push(rule("Loot", "label.minPrice", `No labels below ${formatK(minLabelPrice)}`, { subjects: ["item"], maxValue: minLabelPrice }, { label: "never" }));
  const hide = (group: RuleGroup, id: keyof Layers, label: string, match: Match) => {
    if (!layers[id]) out.push(rule(group, `layer.${id}`, label, match, { show: null }));
  };
  hide("Loot", "loot", "Loot layer off", { subjects: ["item", "quest"] });
  hide("Containers", "containers", "Containers layer off", { subjects: ["container", "airdrop", "corpse"] });
  hide("Exfils", "exfils", "Exfils layer off", { subjects: ["exfil"] });
  hide("Explosives", "explosives", "Explosives layer off", { subjects: ["grenade", "tripwire"] });
  return out;
}

/** All built-in rules, bottom to top. */
export function builtinRules(prefs: MapDisplayPrefs): BuiltinRule[] {
  return [...PLAYER_RULES, ...LOOT_RULES, ...prefRules(prefs)];
}
