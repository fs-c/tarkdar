// The watch model as display rules (rules/rules.ts): the tiers (players), the layers (loot,
// containers, corpses, exfils, ...) and the watchlist, each at a level. The rules engine's cascade lets
// later rules win, so they're ordered by level: the highest level that applies to a thing decides its
// look, colour and all. Players carrying something watched get a mark of their own (carriedMarks):
// the entry's rule itself only applies to things (an LEDX in a backpack isn't an LEDX on the floor).

import type { ItemCatalog } from "../model/items";
import { compileQuery } from "../highlight/query";
import type { AnyRow, PlayerRow } from "../list/rows";
import type { Rule, StyleProps } from "../rules/rules";
import { EMPHASIS, type Level, levelRank, playerStyle, thingStyle } from "./levels";
import type { LayerPrefs, MarkerPrefs, WatchEntry } from "./prefs";
import { TIERS, TIER_ORDER } from "./tiers";

/** Items quests need (the "All started" quest layer). */
export const QUEST_COLOR = "#ffd84d";

/** What a watch entry for things applies to: loose items, quest items, containers, airdrops, corpses. */
const THINGS = "is:loot,container,airdrop,corpse";

/** `is:` values that are kinds of player: an entry of only these watches players, not things. */
const PLAYER_KINDS = new Set(["player", "players", "pmc", "pmcs", "usec", "bear", "pscav", "scav", "scavs", "boss", "bosses", "guard", "guards", "follower", "followers",
  "raider", "raiders", "rogue", "rogues", "cultist", "cultists", "bd", "infected", "zombie", "zombies", "other", "special", "human", "ai"]);

/** The entry watches kinds of player ("is:boss"), rather than things (and who carries them). */
export function watchesPlayers(query: string): boolean {
  const terms = query.trim().split(/\s+/);
  return terms.length > 0 && terms.every((t) => /^is:[a-z,]+$/i.test(t) && t.slice(3).toLowerCase().split(",").every((v) => PLAYER_KINDS.has(v)));
}

export const watchRuleId = (entryId: string): string => `watch.${entryId}`;

const k = (v: number) => (v % 1000 === 0 ? `${v / 1000}k` : String(v));

/** Bottom to top: by level (the highest wins), the tiers and layers before the watchlist at the same level. */
export function watchRules(markers: MarkerPrefs, layers: LayerPrefs, entries: readonly WatchEntry[]): Rule[] {
  const out: { level: Level; rule: Rule }[] = [];
  const add = (level: Level, id: string, label: string, query: string, style: StyleProps, on = true) => out.push({ level, rule: { id, label, query, style, on } });

  for (const t of TIER_ORDER) {
    const { level, color } = markers.tiers[t];
    add(level, `tier.${t}`, TIERS[t].name, TIERS[t].query, playerStyle(level, color));
  }

  if (layers.loot === "all") {
    add("low", "layer.items", "Items", "is:item", thingStyle("low", "#76818a"));
    add("normal", "layer.items.ordinary", "Ordinary items", `is:item value>=${k(markers.ordinary)}`, thingStyle("normal", "#b9c3ca"));
  }
  if (layers.loot !== "off") add("high", "layer.items.valuable", "Valuable items", `is:item value>=${k(markers.valuable)}`, thingStyle("high", "#ffffff"));
  if (layers.quest === "started") {
    add("normal", "layer.quest", "Quest items", "is:quest is:needed", thingStyle("normal", QUEST_COLOR));
    add("normal", "layer.quest.fir", "Needed for quests (FIR)", "is:item is:fir", thingStyle("normal", QUEST_COLOR));
  }
  if (layers.containers) {
    add("normal", "layer.containers", "Containers", "is:container", thingStyle("normal", "#b08a5a"));
    add("high", "layer.airdrops", "Airdrops", "is:airdrop", thingStyle("high", "#4de1ff"));
  }
  if (layers.corpses) add("normal", "layer.corpses", "Corpses", "is:corpse", thingStyle("normal", "#9a9a9a"));
  if (layers.exfils) add("high", "layer.exfils", "Exfils", "is:exfil", { show: 0 });
  if (layers.explosives) add("high", "layer.explosives", "Grenades and tripwires", "is:explosive", { color: "#ff3b30", show: 0 });
  add("high", "layer.vehicles", "Vehicles", "is:vehicle", { color: "#f2c14e", show: 0 });

  for (const e of entries) {
    if (watchesPlayers(e.query)) add(e.level, watchRuleId(e.id), e.label, e.query, { emphasis: EMPHASIS[e.level], ring: e.color }, e.on);
    else add(e.level, watchRuleId(e.id), e.label, `${e.query} ${THINGS}`, thingStyle(e.level, e.color), e.on);
  }

  return out.sort((a, b) => levelRank(a.level) - levelRank(b.level)).map((x) => x.rule); // sort is stable
}

/** A player carrying something watched: the entry's colour, level and name. */
export interface CarriedMark {
  entryId: string;
  label: string;
  color: string;
  level: Level;
}

/** Players (but you, and the dead: their bodies are corpses, styled by the rules) carrying what an
 *  entry for things watches (Normal and up), the most important first: player id → marks. */
export function carriedMarks(players: readonly PlayerRow[], entries: readonly WatchEntry[], catalog: ItemCatalog): Map<number, CarriedMark[]> {
  const out = new Map<number, CarriedMark[]>();
  const watching = entries.filter((e) => e.on && e.level !== "low" && !watchesPlayers(e.query)).sort((a, b) => levelRank(b.level) - levelRank(a.level));
  if (!watching.length) return out;
  const tests = watching.map((e) => ({ e, test: compileQuery(e.query, catalog).test }));
  for (const p of players) {
    if (p.local || p.state !== "alive" || !p.tpls.length) continue;
    const marks = tests.filter(({ test }) => test(p)).map(({ e }) => ({ entryId: e.id, label: e.label, color: e.color, level: e.level }));
    if (marks.length) out.set(p.sel.id, marks);
  }
  return out;
}

/** What an entry has on the map now: what its rule matched, and players carrying it. */
export function entryMatches(entry: WatchEntry, matched: ReadonlyMap<string, AnyRow[]>, carried: ReadonlyMap<number, CarriedMark[]>, players: readonly PlayerRow[]): AnyRow[] {
  const own = matched.get(watchRuleId(entry.id)) ?? [];
  const carriers = players.filter((p) => carried.get(p.sel.id)?.some((m) => m.entryId === entry.id));
  return [...own, ...carriers];
}

/** A thing's mark in the Loot list: what makes it stand out, a watch entry or the quest layer. */
export interface ThingMark {
  color: string;
  /** "watched: LEDX", "tracked: Shooter Born in Heaven", "needed for a quest". */
  label: string;
}

const QUEST_MARK: ThingMark = { color: QUEST_COLOR, label: "needed for a quest" };

/** Row key → its mark: of the entries (on) and the quest layer that match a thing, the one at the
 *  highest level, as on the map. `rules`: watchRules' (bottom to top); `matched`: what each matched. */
export function thingMarks(rules: readonly Rule[], matched: ReadonlyMap<string, readonly AnyRow[]>, entries: readonly WatchEntry[]): Map<string, ThingMark> {
  const byRule = new Map(
    entries.filter((e) => e.on && !watchesPlayers(e.query)).map((e) => [watchRuleId(e.id), { color: e.color, label: `${e.questId ? "tracked" : "watched"}: ${e.label}` }]),
  );
  const out = new Map<string, ThingMark>();
  for (const r of rules) {
    const mark = byRule.get(r.id) ?? (r.id.startsWith("layer.quest") ? QUEST_MARK : undefined);
    if (mark) for (const row of matched.get(r.id) ?? []) if (row.subject !== "player") out.set(row.key, mark);
  }
  return out;
}
