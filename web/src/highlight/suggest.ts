// The global search's suggestions: what a query could mean, as highlight rules. Free text first (what
// you typed, matched like the list's search), then the more specific readings: a value threshold,
// kinds of players and things, item categories, single items.

import type { ItemCatalog } from "../items";
import type { SubjectKind } from "../list/rows";
import { type PlayerType, SPECIAL_TYPES } from "../roles";
import type { Match } from "./match";

export interface Suggestion {
  /** Pill and list text. */
  label: string;
  group: "Text" | "Value" | "Players" | "Things" | "Category" | "Item";
  /** Secondary text: a category's parents, an item's full name. */
  detail?: string;
  match: Match;
}

interface Preset {
  label: string;
  /** Extra words it's found by. */
  words?: string;
  group: "Players" | "Things";
  match: Match;
}

const players = (label: string, types: PlayerType[], words?: string): Preset => ({ label, words, group: "Players", match: { playerTypes: types } });
const things = (label: string, subjects: SubjectKind[], words?: string): Preset => ({ label, words, group: "Things", match: { subjects } });

const PRESETS: Preset[] = [
  players("Special", [...SPECIAL_TYPES], "bosses guards raiders rogues cultists bd"),
  players("PMCs", ["usec", "bear"], "usec bear"),
  players("USEC", ["usec"]),
  players("BEAR", ["bear"]),
  players("Player scavs", ["p-scav"], "pscav"),
  players("Bosses", ["boss"]),
  players("Guards", ["follower"], "followers"),
  players("Raiders", ["raider"]),
  players("Rogues", ["rogue"]),
  players("Cultists", ["cultist"]),
  players("Black Division", ["bd"], "bd"),
  players("Infected", ["zombie"], "zombies"),
  players("AI scavs", ["ai-scav"], "bots"),
  things("Quest items", ["quest"], "task"),
  things("Airdrops", ["airdrop"], "drop"),
  things("Corpses", ["corpse"], "bodies dead"),
  things("Containers", ["container"], "crates"),
  things("Exfils", ["exfil"], "extracts exits"),
  things("Explosives", ["grenade", "tripwire"], "grenades tripwires mines"),
];

const MAX_CATEGORIES = 5;
const MAX_ITEMS = 8;

/** "≥50k", ">50k", "50k", "1.5m", ">= 20000" → roubles; null for anything else (a bare number is text). */
export function parseValue(q: string): number | null {
  const m = /^(?:(>=?|≥)\s*)?(\d+(?:[.,]\d+)?)\s*([km])?\s*(?:₽|rub)?$/i.exec(q.trim());
  if (!m || (!m[1] && !m[3])) return null;
  const n = Number(m[2]!.replace(",", "."));
  const unit = m[3]?.toLowerCase() === "m" ? 1_000_000 : m[3] ? 1_000 : 1;
  return Math.round(n * unit);
}

const formatValue = (v: number) => (v >= 1_000_000 ? `${+(v / 1_000_000).toFixed(2)}M` : v >= 1_000 ? `${+(v / 1_000).toFixed(1)}k` : `${v}`);

export function suggest(query: string, catalog: ItemCatalog): Suggestion[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const out: Suggestion[] = [{ label: `"${query.trim()}"`, group: "Text", detail: "anything mentioning it", match: { text: q } }];

  const value = parseValue(q);
  if (value !== null) {
    out.push({ label: `Items ≥ ${formatValue(value)}`, group: "Value", detail: "loose items, per unit", match: { subjects: ["item"], minValue: value } });
    out.push({ label: `Gear ≥ ${formatValue(value)}`, group: "Value", detail: "players and corpses, equipment value", match: { subjects: ["player", "corpse"], minValue: value } });
    return out;
  }

  for (const p of PRESETS) {
    const words = `${p.label} ${p.words ?? ""}`.toLowerCase().split(/\s+/);
    if (words.some((w) => w.startsWith(q))) out.push({ label: p.label, group: p.group, match: p.match });
  }

  if (q.length >= 2) {
    const cats = catalog
      .categories()
      .filter((c) => c.name.toLowerCase().includes(q))
      .sort((a, b) => rank(a.name, q) - rank(b.name, q) || a.path.length - b.path.length)
      .slice(0, MAX_CATEGORIES);
    for (const c of cats) out.push({ label: c.name, group: "Category", detail: c.path || undefined, match: { categories: [c.id] } });

    const items: { tpl: string; name: string; shortName: string; r: number }[] = [];
    for (const [tpl, info] of catalog.items()) {
      const r = Math.min(rank(info.shortName, q), rank(info.name, q) + 1);
      if (r < 9) items.push({ tpl, name: info.name, shortName: info.shortName, r });
    }
    items.sort((a, b) => a.r - b.r || a.shortName.length - b.shortName.length || a.shortName.localeCompare(b.shortName));
    // Items that share a name (variants of one thing) are one suggestion.
    const byName = new Map<string, Suggestion & { match: { tpls: string[] } }>();
    for (const it of items) {
      const known = byName.get(it.name);
      if (known) known.match.tpls.push(it.tpl);
      else if (byName.size < MAX_ITEMS) byName.set(it.name, { label: it.shortName, group: "Item", detail: it.name, match: { tpls: [it.tpl] } });
    }
    out.push(...byName.values());
  }
  return out;
}

/** How well `text` matches `q`: 0 exact, 1 prefix, 2 word prefix, 3 anywhere, 9 not at all. */
function rank(text: string, q: string): number {
  const t = text.toLowerCase();
  if (t === q) return 0;
  if (t.startsWith(q)) return 1;
  if (t.split(/[\s\-()/.,]+/).some((w) => w.startsWith(q))) return 2;
  return t.includes(q) ? 3 : 9;
}
