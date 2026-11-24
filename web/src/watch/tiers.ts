// Player tiers: the Players list's groups, in the order they matter (PMCs first), each a set of the
// player types model/roles.ts tells apart. A tier has a level and a colour (Settings → Markers, or its
// group header in Players); its players are shown that way. The subtype stays in the label ("Reshala
// guard", "Raider").

import type { PlayerType } from "../model/roles";
import type { Level } from "./levels";

export type Tier = "pmc" | "boss" | "guard" | "raider" | "bd" | "cultist" | "pscav" | "scav" | "infected" | "other";

export interface TierInfo {
  name: string;
  /** What `is:` calls its players (highlight/query.ts): its rule's query, and a watch entry's. */
  query: string;
  types: readonly PlayerType[];
  level: Level;
  color: string;
}

/** In the list's order; the levels and colours are the defaults. */
export const TIERS: Record<Tier, TierInfo> = {
  pmc: { name: "PMCs", query: "is:pmc", types: ["usec", "bear"], level: "high", color: "#ff5a52" },
  boss: { name: "Bosses", query: "is:boss", types: ["boss"], level: "top", color: "#ff4fd8" },
  guard: { name: "Boss guards", query: "is:guard", types: ["follower"], level: "high", color: "#ff4fd8" },
  raider: { name: "Raiders & rogues", query: "is:raider,rogue", types: ["raider", "rogue"], level: "high", color: "#38e8c0" },
  bd: { name: "Black Division", query: "is:bd", types: ["bd"], level: "high", color: "#6fa8ff" },
  cultist: { name: "Cultists", query: "is:cultist", types: ["cultist"], level: "high", color: "#b48cff" },
  pscav: { name: "Player scavs", query: "is:pscav", types: ["p-scav"], level: "normal", color: "#f5c542" },
  scav: { name: "Scavs", query: "is:scav", types: ["ai-scav"], level: "low", color: "#d5dde3" },
  infected: { name: "Infected", query: "is:infected", types: ["zombie"], level: "low", color: "#9bd14b" },
  other: { name: "Other", query: "is:other", types: ["other"], level: "normal", color: "#a3acb3" },
};

export const TIER_ORDER = Object.keys(TIERS) as Tier[];

const BY_TYPE = new Map<PlayerType, Tier>(TIER_ORDER.flatMap((t) => TIERS[t].types.map((ty) => [ty, t] as const)));

/** A player type's tier; null for the local player ("self"). */
export const tierOf = (type: PlayerType): Tier | null => BY_TYPE.get(type) ?? (type === "self" ? null : "other");
