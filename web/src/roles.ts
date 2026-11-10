// Bot roles: what kind of NPC a player is (boss, guard, raider, ...), for highlighting.
//
// Full EFT.Player objects (us and bots simulated on this machine) carry the game's role,
// Profile.Info.Settings.Role (EFT.WildSpawnType), as a number. The values below are SPT's
// (server/project/src/models/enums/WildSpawnTypeNumber.ts); the IL2CPP dump lists the same names in
// the same order, but not the numbers, and newer roles (after infectedTagilla) aren't mapped: those
// show as "role N". Observed players (network replicas) carry no role, only a voice preset, which
// bosses have their own of; that's a weaker fallback.

import type { Player } from "./protocol";

export type RoleCategory = "boss" | "guard" | "raider" | "rogue" | "cultist" | "scav" | "sniper" | "pmc" | "infected" | "event" | "other";

export interface RoleInfo {
  category: RoleCategory;
  /** Display name: "Killa", "Reshala guard", "Raider", ... */
  label: string;
  /** Where it came from: the game's role field, or guessed from the voice preset. */
  source: "role" | "voice";
}

type Entry = [name: string, label: string, category: RoleCategory];

/** WildSpawnType value → [enum name, display name, category]. Gaps (31, 54–56) are in the enum too. */
export const WILD_SPAWN_TYPES: Record<number, Entry> = {
  0: ["marksman", "Sniper scav", "sniper"],
  1: ["assault", "Scav", "scav"],
  2: ["bossTest", "Test boss", "boss"],
  3: ["bossBully", "Reshala", "boss"],
  4: ["followerTest", "Test guard", "guard"],
  5: ["followerBully", "Reshala guard", "guard"],
  6: ["bossKilla", "Killa", "boss"],
  7: ["bossKojaniy", "Shturman", "boss"],
  8: ["followerKojaniy", "Shturman guard", "guard"],
  9: ["pmcBot", "Raider", "raider"],
  10: ["cursedAssault", "Scav (cursed)", "scav"],
  11: ["bossGluhar", "Glukhar", "boss"],
  12: ["followerGluharAssault", "Glukhar guard", "guard"],
  13: ["followerGluharSecurity", "Glukhar guard", "guard"],
  14: ["followerGluharScout", "Glukhar scout", "guard"],
  15: ["followerGluharSnipe", "Glukhar sniper", "guard"],
  16: ["followerSanitar", "Sanitar guard", "guard"],
  17: ["bossSanitar", "Sanitar", "boss"],
  18: ["test", "Test", "other"],
  19: ["assaultGroup", "Scav (group)", "scav"],
  20: ["sectantWarrior", "Cultist", "cultist"],
  21: ["sectantPriest", "Cultist priest", "cultist"],
  22: ["bossTagilla", "Tagilla", "boss"],
  23: ["followerTagilla", "Tagilla guard", "guard"],
  24: ["exUsec", "Rogue", "rogue"],
  25: ["gifter", "Santa", "event"],
  26: ["bossKnight", "Knight", "boss"],
  27: ["followerBigPipe", "Big Pipe", "boss"],
  28: ["followerBirdEye", "Birdeye", "boss"],
  29: ["bossZryachiy", "Zryachiy", "boss"],
  30: ["followerZryachiy", "Zryachiy guard", "guard"],
  32: ["bossBoar", "Kaban", "boss"],
  33: ["followerBoar", "Kaban guard", "guard"],
  34: ["arenaFighter", "Arena fighter", "other"],
  35: ["arenaFighterEvent", "Bloodhound", "raider"],
  36: ["bossBoarSniper", "Kaban sniper", "guard"],
  37: ["crazyAssaultEvent", "Scav (crazy)", "scav"],
  38: ["peacefullZryachiyEvent", "Zryachiy (peaceful)", "event"],
  39: ["sectactPriestEvent", "Cultist priest (event)", "cultist"],
  40: ["ravangeZryachiyEvent", "Zryachiy (revenge)", "boss"],
  41: ["followerBoarClose1", "Kaban guard", "guard"],
  42: ["followerBoarClose2", "Kaban guard", "guard"],
  43: ["bossKolontay", "Kollontay", "boss"],
  44: ["followerKolontayAssault", "Kollontay guard", "guard"],
  45: ["followerKolontaySecurity", "Kollontay guard", "guard"],
  46: ["shooterBTR", "BTR gunner", "other"],
  47: ["bossPartisan", "Partisan", "boss"],
  48: ["spiritWinter", "Winter spirit", "event"],
  49: ["spiritSpring", "Spring spirit", "event"],
  50: ["peacemaker", "Peacemaker", "event"],
  51: ["pmcBEAR", "PMC (BEAR)", "pmc"],
  52: ["pmcUSEC", "PMC (USEC)", "pmc"],
  53: ["skier", "Skier", "event"],
  57: ["sectantPredvestnik", "Harbinger", "cultist"],
  58: ["sectantPrizrak", "Ghost", "cultist"],
  59: ["sectantOni", "Oni", "cultist"],
  60: ["infectedAssault", "Infected", "infected"],
  61: ["infectedPmc", "Infected PMC", "infected"],
  62: ["infectedCivil", "Infected civilian", "infected"],
  63: ["infectedLaborant", "Infected lab worker", "infected"],
  64: ["infectedTagilla", "Tagilla (infected)", "boss"],
};

const BOSS_VOICES: Record<string, string> = {
  bossbully: "Reshala",
  bosskojaniy: "Shturman",
  bossboar: "Kaban",
  bossbigpipe: "Big Pipe",
  bossbirdeye: "Birdeye",
  bosskolontay: "Kollontay",
};

/** The voice-preset fallback for players without a role (observed players). */
function fromVoice(p: Pick<Player, "side" | "ai" | "voice">): RoleInfo | null {
  const v = p.voice;
  if (!v || !p.ai) return null;
  const lower = v.toLowerCase();
  if (lower.startsWith("boss")) return { category: "boss", label: BOSS_VOICES[lower] ?? v.slice(4), source: "voice" };
  if (lower.startsWith("follower")) return { category: "guard", label: "Guard", source: "voice" };
  if (lower.startsWith("sectant")) return { category: "cultist", label: lower.includes("priest") ? "Cultist priest" : "Cultist", source: "voice" };
  if (lower.startsWith("scav_")) return { category: "scav", label: "Scav", source: "voice" };
  // Savage-side AI speaking with a PMC voice: raiders and rogues do (PMC bots are on usec/bear).
  if (p.side === "savage" && (lower.startsWith("usec") || lower.startsWith("bear")))
    return { category: "raider", label: "Raider/Rogue", source: "voice" };
  return null;
}

/** What kind of NPC this is, if known. Humans and our own player have none. */
export function roleInfo(p: Pick<Player, "local" | "side" | "ai" | "voice" | "role">): RoleInfo | null {
  if (p.local || !p.ai) return null;
  if (p.role !== undefined) {
    const e = WILD_SPAWN_TYPES[p.role];
    return e ? { category: e[2], label: e[1], source: "role" } : { category: "other", label: `role ${p.role}`, source: "role" };
  }
  return fromVoice(p);
}

/** Roles worth calling out on the map and in the list. */
export const SPECIAL_CATEGORIES: ReadonlySet<RoleCategory> = new Set(["boss", "guard", "raider", "rogue", "cultist"]);

export function specialRole(p: Pick<Player, "local" | "side" | "ai" | "voice" | "role">): RoleInfo | null {
  const r = roleInfo(p);
  return r && SPECIAL_CATEGORIES.has(r.category) ? r : null;
}

/** A plain AI scav (shown de-emphasized): savage-side AI whose role is a scav one, or, without a role,
 *  a "Scav_N" voice or none at all. Player scavs, simulated or not, aren't AI. */
export function isPlainScav(p: Pick<Player, "local" | "side" | "ai" | "voice" | "role">): boolean {
  if (p.local || p.side !== "savage" || !p.ai) return false;
  if (p.role !== undefined) {
    const c = roleInfo(p)?.category;
    return c === "scav" || c === "sniper";
  }
  return !p.voice || /^scav_/i.test(p.voice);
}
