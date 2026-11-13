// Player types: one field that says who a player is (us, a PMC, a scav, a boss, ...), derived from
// what the backend reads (local, ai, side, role, voice, group). The raw inputs stay available
// (`identityText`) so a misclassified player, or one that falls through to "other", can be traced
// to the rule that should catch it.
//
// Sources, strongest first:
//  - role: the game's EFT.WildSpawnType. Full EFT.Player objects (us, bots simulated on this machine)
//    carry it in their profile; observed players (network replicas) through their AI data
//    (unverified, see docs/protocol.md). Only meaningful for AI: humans carry a default.
//  - group: bots spawned together share a group id, so an AI in a boss's group is one of its guards.
//  - voice: the voice preset. Bosses, cultists and zombies have their own; guards, raiders, snipers
//    and plain scavs mostly share the six Scav_N voices (per SPT's bot database), so a Scav_N voice
//    alone can't tell them apart.
//
// Role values are SPT's (WildSpawnType in SPTarkov.Server.Core's LocationBase.cs, up to 67). The game
// has more (blackDivision, vsRF, bossWedge, ... after tagillaHelperAgro); their values come from an
// il2cpp-dump with literal values (docs/offset-tools.md) and show as "role N" until mapped here.

import type { Player } from "./protocol";

export type PlayerType =
  | "self"
  | "usec"
  | "bear"
  | "p-scav"
  | "ai-scav"
  | "boss"
  | "follower"
  | "raider"
  | "rogue"
  | "cultist"
  | "bd"
  | "zombie"
  | "other";

/** In display/sort order. */
export const PLAYER_TYPES: readonly PlayerType[] = [
  "self", "usec", "bear", "p-scav", "boss", "follower", "raider", "rogue", "cultist", "bd", "zombie", "ai-scav", "other",
];

export interface PlayerTypeInfo {
  type: PlayerType;
  /** Display name: "Killa", "Reshala guard", "Scav", "USEC bot", ... */
  label: string;
  /** Which rule decided it, e.g. "role 6 (bossKilla)", "voice Scav_3", "in Reshala's group". */
  reason: string;
}

/** What a classification needs from a player. */
export type PlayerIdentity = Pick<Player, "local" | "ai" | "side" | "voice" | "role" | "nickname" | "groupId" | "kind">;

type Entry = [name: string, label: string, type: PlayerType];

/** WildSpawnType value → [enum name, display name, type]. Gaps (31, 54–56) are in the enum too. */
export const WILD_SPAWN_TYPES: Record<number, Entry> = {
  0: ["marksman", "Sniper scav", "ai-scav"],
  1: ["assault", "Scav", "ai-scav"],
  2: ["bossTest", "Test boss", "boss"],
  3: ["bossBully", "Reshala", "boss"],
  4: ["followerTest", "Test guard", "follower"],
  5: ["followerBully", "Reshala guard", "follower"],
  6: ["bossKilla", "Killa", "boss"],
  7: ["bossKojaniy", "Shturman", "boss"],
  8: ["followerKojaniy", "Shturman guard", "follower"],
  9: ["pmcBot", "Raider", "raider"],
  10: ["cursedAssault", "Scav (cursed)", "ai-scav"],
  11: ["bossGluhar", "Glukhar", "boss"],
  12: ["followerGluharAssault", "Glukhar guard", "follower"],
  13: ["followerGluharSecurity", "Glukhar guard", "follower"],
  14: ["followerGluharScout", "Glukhar scout", "follower"],
  15: ["followerGluharSnipe", "Glukhar sniper", "follower"],
  16: ["followerSanitar", "Sanitar guard", "follower"],
  17: ["bossSanitar", "Sanitar", "boss"],
  18: ["test", "Test", "other"],
  19: ["assaultGroup", "Scav (group)", "ai-scav"],
  20: ["sectantWarrior", "Cultist", "cultist"],
  21: ["sectantPriest", "Cultist priest", "cultist"],
  22: ["bossTagilla", "Tagilla", "boss"],
  23: ["followerTagilla", "Tagilla guard", "follower"],
  24: ["exUsec", "Rogue", "rogue"],
  25: ["gifter", "Santa", "other"],
  26: ["bossKnight", "Knight", "boss"],
  // The Goons: followers in the enum, bosses in every other sense.
  27: ["followerBigPipe", "Big Pipe", "boss"],
  28: ["followerBirdEye", "Birdeye", "boss"],
  29: ["bossZryachiy", "Zryachiy", "boss"],
  30: ["followerZryachiy", "Zryachiy guard", "follower"],
  32: ["bossBoar", "Kaban", "boss"],
  33: ["followerBoar", "Kaban guard", "follower"],
  34: ["arenaFighter", "Arena fighter", "other"],
  35: ["arenaFighterEvent", "Bloodhound", "raider"],
  36: ["bossBoarSniper", "Kaban sniper", "follower"],
  37: ["crazyAssaultEvent", "Scav (crazy)", "ai-scav"],
  38: ["peacefullZryachiyEvent", "Zryachiy (peaceful)", "boss"],
  39: ["sectactPriestEvent", "Cultist priest (event)", "cultist"],
  40: ["ravangeZryachiyEvent", "Zryachiy (revenge)", "boss"],
  41: ["followerBoarClose1", "Kaban guard", "follower"],
  42: ["followerBoarClose2", "Kaban guard", "follower"],
  43: ["bossKolontay", "Kollontay", "boss"],
  44: ["followerKolontayAssault", "Kollontay guard", "follower"],
  45: ["followerKolontaySecurity", "Kollontay guard", "follower"],
  46: ["shooterBTR", "BTR gunner", "other"],
  47: ["bossPartisan", "Partisan", "boss"],
  48: ["spiritWinter", "Winter spirit", "other"],
  49: ["spiritSpring", "Spring spirit", "other"],
  50: ["peacemaker", "Peacemaker", "other"],
  51: ["pmcBEAR", "BEAR bot", "bear"],
  52: ["pmcUSEC", "USEC bot", "usec"],
  53: ["skier", "Skier", "other"],
  57: ["sectantPredvestnik", "Harbinger", "cultist"],
  58: ["sectantPrizrak", "Ghost", "cultist"],
  59: ["sectantOni", "Oni", "cultist"],
  60: ["infectedAssault", "Infected", "zombie"],
  61: ["infectedPmc", "Infected PMC", "zombie"],
  62: ["infectedCivil", "Infected civilian", "zombie"],
  63: ["infectedLaborant", "Infected lab worker", "zombie"],
  64: ["infectedTagilla", "Tagilla (infected)", "boss"],
  65: ["bossTagillaAgro", "Tagilla (vengeful)", "boss"],
  66: ["bossKillaAgro", "Killa (vengeful)", "boss"],
  67: ["tagillaHelperAgro", "Tagilla helper", "follower"],
};

/** Boss voice presets (lowercase, without underscores) → display name. */
const BOSS_VOICES: Record<string, string> = {
  bossbully: "Reshala",
  bosskilla: "Killa",
  bosssturman: "Shturman",
  bosskojaniy: "Shturman",
  bossgluhar: "Glukhar",
  bosssanitar: "Sanitar",
  bosstagilla: "Tagilla",
  bossagrotagilla: "Tagilla (vengeful)",
  bosszombietagilla: "Tagilla (infected)",
  bossknight: "Knight",
  bossbigpipe: "Big Pipe",
  bossbirdeye: "Birdeye",
  bosskaban: "Kaban",
  bossboar: "Kaban",
  bosskollontay: "Kollontay",
  bosskolontay: "Kollontay",
  bosspartizan: "Partisan",
};

const roleName = (role: number) => WILD_SPAWN_TYPES[role]?.[0];
const roleReason = (role: number) => `role ${role}${roleName(role) ? ` (${roleName(role)})` : ""}`;

/** Group id → boss label, for every AI boss among `players`. */
export function bossGroups(players: readonly PlayerIdentity[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const p of players) {
    if (!p.groupId || p.local || !p.ai) continue;
    const t = classify(p);
    if (t.type === "boss") out.set(p.groupId, t.label);
  }
  return out;
}

/**
 * The player's type. Pass `groups` (from bossGroups over all players) to detect guards by the group
 * they share with their boss; without it, guards with a plain scav voice and no role read as ai-scav.
 */
export function playerType(p: PlayerIdentity, groups?: ReadonlyMap<string, string>): PlayerTypeInfo {
  return classify(p, groups);
}

function classify(p: PlayerIdentity, groups?: ReadonlyMap<string, string>): PlayerTypeInfo {
  if (p.local) return { type: "self", label: "You", reason: "our player" };
  if (!p.ai) {
    // Humans: the side says it all (their role field is a default).
    switch (p.side) {
      case "usec": return { type: "usec", label: "USEC", reason: "human, side usec" };
      case "bear": return { type: "bear", label: "BEAR", reason: "human, side bear" };
      case "savage": return { type: "p-scav", label: "Player scav", reason: "human, side savage" };
      default: return { type: "other", label: p.voice || "?", reason: `human, side ${p.side}` };
    }
  }

  const byRole = p.role !== undefined ? fromRole(p.role) : null;
  const byVoice = fromVoice(p);
  // Black Division has a role in the enum, but it may be unmapped or a default: the voice is exact.
  if (byVoice?.type === "bd" && (!byRole || byRole.type === "ai-scav" || byRole.type === "other")) return byVoice;
  if (byRole) {
    // An observed player's role comes from an unverified source that may hold a default (0,
    // marksman): when the voice clearly says otherwise, trust the voice.
    if (p.kind === "observed" && byRole.type === "ai-scav" && byVoice && byVoice.type !== "ai-scav")
      return { ...byVoice, reason: `${byVoice.reason}; ignored ${roleReason(p.role!)}` };
    return byRole;
  }

  const boss = p.groupId ? groups?.get(p.groupId) : undefined;
  if (boss && byVoice?.type !== "boss")
    return { type: "follower", label: `${boss} guard`, reason: `in ${boss}'s group${byVoice ? `, ${byVoice.reason}` : ""}` };

  if (byVoice) return byVoice;
  if (p.side === "usec") return { type: "usec", label: "USEC bot", reason: "AI, side usec" };
  if (p.side === "bear") return { type: "bear", label: "BEAR bot", reason: "AI, side bear" };
  if (p.side === "savage" && !p.voice) return { type: "ai-scav", label: "Scav", reason: "AI, side savage, no voice" };
  return { type: "other", label: p.voice || (p.role !== undefined ? `role ${p.role}` : "?"), reason: "no rule matched" };
}

function fromRole(role: number): PlayerTypeInfo {
  const e = WILD_SPAWN_TYPES[role];
  if (!e) return { type: "other", label: `role ${role}`, reason: `${roleReason(role)}: not mapped` };
  return { type: e[2], label: e[1], reason: roleReason(role) };
}

/** What the voice preset says about an AI player, if anything. */
function fromVoice(p: PlayerIdentity): PlayerTypeInfo | null {
  const v = p.voice;
  if (!v) return null;
  const key = v.toLowerCase().replace(/_/g, "");
  const reason = `voice ${v}`;
  if (key.startsWith("blackdivision")) return { type: "bd", label: "BD", reason };
  if (key.startsWith("boss")) return { type: "boss", label: BOSS_VOICES[key] ?? v.replace(/^boss_?/i, ""), reason };
  if (key.startsWith("follower")) return { type: "follower", label: "Guard", reason };
  // Zryachiy and his guards speak like cultist priests too; they have a role when it can be read.
  if (key.startsWith("sectant")) return { type: "cultist", label: key.includes("priest") ? "Cultist priest" : "Cultist", reason };
  if (key.startsWith("zombie")) return { type: "zombie", label: "Infected", reason };
  if (key.startsWith("scav")) {
    // Plain scavs, but also most guards, some raiders, snipers and event bots (SPT bot database).
    if (p.side === "savage") return { type: "ai-scav", label: "Scav", reason };
    return null;
  }
  if (p.side === "savage") {
    // Savage-side AI with a PMC voice: rogues speak Usec_*, raiders Usec_*/Bear_*/Scav_*.
    if (key.startsWith("usec")) return { type: "rogue", label: "Rogue/Raider", reason: `${reason}, side savage` };
    if (key.startsWith("bear")) return { type: "raider", label: "Raider", reason: `${reason}, side savage` };
  }
  return null;
}

/** Types worth calling out: the list's "special" filter, the "Special" highlight. (How types look,
 *  special ones included, is style.ts's business.) */
export const SPECIAL_TYPES: ReadonlySet<PlayerType> = new Set(["boss", "follower", "raider", "rogue", "cultist", "bd"]);

/** The raw inputs, one line, for tooltips: "AI · observed · side savage · role 5 (followerBully) · voice Scav_3 · …". */
export function identityText(p: PlayerIdentity): string {
  const parts = [p.local ? "local" : p.ai ? "AI" : "human"];
  if (p.kind) parts.push(p.kind);
  parts.push(`side ${p.side}`);
  if (p.role !== undefined) parts.push(roleReason(p.role));
  if (p.voice) parts.push(`voice ${p.voice}`);
  if (p.nickname) parts.push(`nick ${p.nickname}`);
  if (p.groupId) parts.push(`group ${p.groupId}`);
  return parts.join(" · ");
}
