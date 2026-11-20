// The default rules: how things look out of the box, as rules (rules.ts) instead of tables in code.
// Players by type, loose items by value per slot, the other kinds of loot, exfils, explosives. The rule
// store (rules/store.ts) starts from these; each can be changed, moved, duplicated and removed there,
// and reset to (or restored from) its default.

import { VALUE_TIERS, formatPrice } from "../items";
import type { SubjectKind } from "../list/rows";
import { COLORS } from "../style";
import { ui } from "../theme";
import type { Emphasis, Rule, StyleProps } from "./rules";

/**
 * The categories the Map view lists rules in. A rule's category is where it's listed (and what switching
 * the category off hides, for the hideable ones); the cascade goes by category in this order, bottom to
 * top, so General (rules that span kinds of thing) wins over the others.
 */
export type Category = "Players" | "Loot" | "Containers" | "Exfils" | "Explosives" | "General";
export const CATEGORIES: readonly Category[] = ["Players", "Loot", "Containers", "Exfils", "Explosives", "General"];

/** Categories that can be switched off as a whole (the old map layers), and what that hides. */
export const HIDEABLE: Partial<Record<Category, SubjectKind[]>> = {
  Loot: ["item", "quest"],
  Containers: ["container", "airdrop", "corpse"],
  Exfils: ["exfil"],
  Explosives: ["grenade", "tripwire"],
};

/** Where a rule about these kinds of thing belongs. */
export function categoryFor(kinds: readonly SubjectKind[]): Category {
  const of = (k: SubjectKind): Category =>
    k === "player" ? "Players" : ((Object.entries(HIDEABLE).find(([, ks]) => ks.includes(k))?.[0] as Category | undefined) ?? "General");
  const cats = new Set(kinds.map(of));
  return cats.size === 1 ? [...cats][0]! : "General";
}

export interface DefaultRule extends Rule {
  category: Category;
}

const rule = (category: Category, id: string, label: string, query: string, style: StyleProps): DefaultRule => ({ category, id, label, query, style });

const player = (is: string, id: string, label: string, color: string, emphasis: Emphasis = "normal") =>
  rule("Players", `player.${id}`, label, `is:${is}`, { color, emphasis });

// Except players, nothing is shown without a rule (rules.ts BASE): each kind's catch-all rule
// ("Items", "Containers", ...) is what shows it.

/** Levels of detail (declutter.ts) a thing can be shown from, nearest last; null: hidden. */
export const SHOW_LEVELS = { always: 0, unlessFar: 0.4, mid: 1, close: 2.5 } as const;

const k = (v: number) => formatPrice(v).toLowerCase();

/**
 * Bottom to top. Loose items: drawn from a level of detail on by value per slot, so cheap ones drop out
 * first as you zoom out (unpriced ones count as cheap).
 */
export const DEFAULT_RULES: readonly DefaultRule[] = [
  player("usec", "usec", "USEC", ui.link),
  player("bear", "bear", "BEAR", ui.danger),
  player("pscav", "p-scav", "Player scavs", ui.gold),
  player("scav", "ai-scav", "AI scavs", ui.gold, "faint"),
  player("boss", "boss", "Bosses", "#ff4fd8", "loud"),
  player("guard", "follower", "Guards", ui.warn, "strong"),
  player("raider", "raider", "Raiders", "#4de1ff", "strong"),
  player("rogue", "rogue", "Rogues", "#38e8c0", "strong"),
  player("cultist", "cultist", "Cultists", "#b26bff", "strong"),
  player("bd", "bd", "Black Division", "#ff7a1a", "strong"),
  player("infected", "zombie", "Infected", "#9bd14b", "faint"),
  player("other", "other", "Other players", "#c0c0c0"),
  rule("Loot", "item.all", "Items", "is:item", { color: "#e8eef2", emphasis: "normal", show: SHOW_LEVELS.unlessFar }),
  rule("Loot", "item.cheap", "Cheap items", `is:item value<${k(VALUE_TIERS.mid)}`, { color: "#8b969f", emphasis: "faint", show: SHOW_LEVELS.mid }),
  rule("Loot", "item.valuable", "Valuable items", `is:item value>=${k(VALUE_TIERS.high)}`, { color: ui.gold, emphasis: "strong", show: SHOW_LEVELS.always }),
  rule("Loot", "quest", "Quest items", "is:quest", { color: ui.quest, show: SHOW_LEVELS.always }),
  // Ordinary items a started quest still needs (to find, hand over or plant): over the value rules.
  rule("Loot", "item.quest-needed", "Needed for quests", "is:item is:needed", { color: ui.quest, emphasis: "strong", show: SHOW_LEVELS.always }),
  rule("Containers", "container", "Containers", "is:container", { color: "#b08a5a", show: SHOW_LEVELS.always }),
  rule("Containers", "airdrop", "Airdrops", "is:airdrop", { color: "#4de1ff", show: SHOW_LEVELS.always }),
  rule("Containers", "corpse", "Corpses", "is:corpse", { color: "#9a9a9a", show: SHOW_LEVELS.always }),
  rule("Exfils", "exfil", "Exfils", "is:exfil", { show: SHOW_LEVELS.always }),
  rule("Explosives", "explosive", "Grenades and tripwires", "is:explosive", { color: COLORS.danger, show: SHOW_LEVELS.always }),
];

/** Categories hidden out of the box (the map's loot and container layers were off by default). */
export const DEFAULT_HIDDEN: readonly Category[] = ["Loot", "Containers"];
