// The built-in rules: how things look out of the box, as rules (rules.ts) instead of tables in code.
// Players by type, loose items by value, the other kinds of loot, exfils, explosives. They can be
// changed (rules/store.ts keeps the changes), not removed.

import { VALUE_TIERS } from "../items";
import type { Match } from "../highlight/match";
import type { SubjectKind } from "../list/rows";
import type { PlayerType } from "../roles";
import { COLORS } from "../style";
import { ui } from "../theme";
import type { Emphasis, Rule, StyleProps } from "./rules";

/** The groups the rules view shows rules in (Mine: standing rules, pinned highlights). */
export type RuleGroup = "Mine" | "Players" | "Loot" | "Containers" | "Exfils" | "Explosives";

/** Groups that can be switched off as a whole (the old map layers), and what that hides. */
export const HIDEABLE: Partial<Record<RuleGroup, SubjectKind[]>> = {
  Loot: ["item", "quest"],
  Containers: ["container", "airdrop", "corpse"],
  Exfils: ["exfil"],
  Explosives: ["grenade", "tripwire"],
};

export interface GroupedRule extends Rule {
  group: RuleGroup;
}

const rule = (group: RuleGroup, id: string, label: string, match: Match, style: StyleProps): GroupedRule => ({ group, id, label, match, style });

const player = (type: PlayerType, label: string, color: string, emphasis: Emphasis = "normal") =>
  rule("Players", `player.${type}`, label, { playerTypes: [type] }, { color, emphasis });

/** Levels of detail (declutter.ts) a thing can be shown from, nearest last; null: hidden. */
export const SHOW_LEVELS = { always: 0, unlessFar: 0.4, mid: 1, close: 2.5 } as const;

/**
 * Bottom to top. Loose items: drawn from a level of detail on by value, so cheap ones drop out first
 * as you zoom out (unpriced ones count as cheap).
 */
export const BUILTIN_RULES: readonly GroupedRule[] = [
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
  rule("Loot", "item.all", "Items", { subjects: ["item"] }, { color: "#e8eef2", emphasis: "normal", show: SHOW_LEVELS.unlessFar }),
  rule("Loot", "item.cheap", "Cheap items", { subjects: ["item"], maxValue: VALUE_TIERS.mid }, { color: "#8b969f", emphasis: "faint", show: SHOW_LEVELS.mid }),
  rule("Loot", "item.valuable", "Valuable items", { subjects: ["item"], minValue: VALUE_TIERS.high }, { color: ui.gold, emphasis: "strong", show: SHOW_LEVELS.always }),
  rule("Loot", "quest", "Quest items", { subjects: ["quest"] }, { color: ui.quest }),
  // Ordinary items a started quest still needs (to find, hand over or plant): over the value rules.
  rule("Loot", "item.quest-needed", "Needed for quests", { subjects: ["item"], questNeeded: true }, { color: ui.quest, emphasis: "strong", show: SHOW_LEVELS.always }),
  rule("Containers", "container", "Containers", { subjects: ["container"] }, { color: "#b08a5a" }),
  rule("Containers", "airdrop", "Airdrops", { subjects: ["airdrop"] }, { color: "#4de1ff" }),
  rule("Containers", "corpse", "Corpses", { subjects: ["corpse"] }, { color: "#9a9a9a" }),
  rule("Exfils", "exfil", "Exfils", { subjects: ["exfil"] }, {}),
  rule("Explosives", "explosive", "Grenades and tripwires", { subjects: ["grenade", "tripwire"] }, { color: COLORS.danger }),
];

/** Groups hidden out of the box (the map's loot and container layers were off by default). */
export const DEFAULT_HIDDEN: readonly RuleGroup[] = ["Loot", "Containers"];
