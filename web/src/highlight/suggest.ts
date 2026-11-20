// The global search's suggestions: what a query could mean, as queries (highlight/query.ts). Typed in
// the query syntax: that, as it is. Otherwise free text first (what you typed, matched like the list's
// search), then the more specific readings: a value threshold, kinds of players and things, examples of
// the syntax, kinds of container, item categories, single items.

import { type ItemCatalog, containerTypes, formatPrice } from "../items";
import { QUERY_HELP, isStructured, parseQuery, quote } from "./query";

export interface Suggestion {
  /** Pill and list text. */
  label: string;
  group: "Query" | "Text" | "Syntax" | "Value" | "Players" | "Things" | "Container" | "Category" | "Item";
  /** Secondary text: a category's parents, an item's full name, what's wrong with a query. */
  detail?: string;
  /** What it matches (highlight/query.ts). */
  query: string;
  /** The query doesn't work as typed. */
  error?: boolean;
}

interface Preset {
  label: string;
  /** Extra words it's found by. */
  words?: string;
  group: "Players" | "Things";
  query: string;
}

const players = (label: string, query: string, words?: string): Preset => ({ label, words, group: "Players", query });
const things = (label: string, query: string, words?: string): Preset => ({ label, words, group: "Things", query });

const PRESETS: Preset[] = [
  players("Special", "is:special", "bosses guards raiders rogues cultists bd"),
  players("PMCs", "is:pmc", "usec bear"),
  players("USEC", "is:usec"),
  players("BEAR", "is:bear"),
  players("Player scavs", "is:pscav", "pscav"),
  players("Bosses", "is:boss"),
  players("Guards", "is:guard", "followers"),
  players("Raiders", "is:raider"),
  players("Rogues", "is:rogue"),
  players("Cultists", "is:cultist"),
  players("Black Division", "is:bd", "bd"),
  players("Infected", "is:infected", "zombies"),
  players("AI scavs", "is:scav", "bots"),
  things("Quest items", "is:quest", "task"),
  things("Needed for quests", "is:item is:needed", "quest task"),
  things("Needed for the story", "quest:story", "quest task story main"),
  things("Needed for dailies and weeklies", "quest:repeatable", "quest task daily weekly repeatable"),
  things("Airdrops", "is:airdrop", "drop"),
  things("Corpses", "is:corpse", "bodies dead"),
  things("Containers", "is:container", "crates"),
  things("Exfils", "is:exfil", "extracts exits"),
  things("Explosives", "is:explosive", "grenades tripwires mines"),
];

const CONTAINER_TYPES = containerTypes();

const MAX_CONTAINERS = 5;
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

/** Value thresholds in queries: "50k", "1.5m". */
const formatValue = (v: number) => (v >= 1_000_000 ? `${+(v / 1_000_000).toFixed(2)}m` : v >= 1_000 ? `${+(v / 1_000).toFixed(1)}k` : `${v}`);

export function suggest(query: string, catalog: ItemCatalog): Suggestion[] {
  const raw = query.trim();
  const q = raw.toLowerCase();
  if (!q) return [];
  // Written in the query syntax (or meant to be): just that, as typed.
  const parsed = parseQuery(raw);
  if (parsed.errors.length) return [{ label: raw, group: "Query", detail: parsed.errors[0], query: raw, error: true }];
  if (isStructured(raw)) return [{ label: raw, group: "Query", query: raw }];

  const out: Suggestion[] = [{ label: `"${raw}"`, group: "Text", detail: "anything mentioning it", query: q }];

  const value = parseValue(q);
  if (value !== null) {
    const v = formatValue(value);
    out.push({ label: `Items ≥ ${formatPrice(value)}/slot`, group: "Value", detail: "loose items, per inventory slot", query: `is:item value>=${v}` });
    out.push({ label: `Gear ≥ ${formatPrice(value)}`, group: "Value", detail: "players and corpses, equipment value", query: `is:player,corpse value>=${v}` });
    return out;
  }

  for (const p of PRESETS) {
    const words = `${p.label} ${p.words ?? ""}`.toLowerCase().split(/\s+/);
    if (words.some((w) => w.startsWith(q))) out.push({ label: p.label, group: p.group, detail: p.query, query: p.query });
  }

  // Learning the syntax: a field's name gives an example of it.
  if (q.length >= 2 && !q.includes(" "))
    for (const h of QUERY_HELP) if (h.words.split(" ").some((w) => w.startsWith(q))) out.push({ label: h.example, group: "Syntax", detail: h.text, query: h.example });

  if (q.length >= 2) {
    const kinds = CONTAINER_TYPES.filter((c) => rank(c.name, q) < 9)
      .sort((a, b) => rank(a.name, q) - rank(b.name, q) || a.name.localeCompare(b.name))
      .slice(0, MAX_CONTAINERS);
    for (const c of kinds) out.push({ label: c.name, group: "Container", query: `is:container item:${quote(c.name)}` });

    const cats = catalog
      .categories()
      .filter((c) => c.name.toLowerCase().includes(q))
      .sort((a, b) => rank(a.name, q) - rank(b.name, q) || a.path.length - b.path.length)
      .slice(0, MAX_CATEGORIES);
    // Categories that share a name (in different branches) are one.
    const seen = new Set<string>();
    for (const c of cats) {
      if (seen.has(c.name.toLowerCase())) continue;
      seen.add(c.name.toLowerCase());
      out.push({ label: c.name, group: "Category", detail: c.path || undefined, query: `cat:${quote(c.name)}` });
    }

    const items: { tpl: string; name: string; shortName: string; r: number }[] = [];
    for (const [tpl, info] of catalog.items()) {
      const r = Math.min(rank(info.shortName, q), rank(info.name, q) + 1);
      if (r < 9) items.push({ tpl, name: info.name, shortName: info.shortName, r });
    }
    items.sort((a, b) => a.r - b.r || a.shortName.length - b.shortName.length || a.shortName.localeCompare(b.shortName));
    // Items that share a name (variants of one thing) are one suggestion: the name matches them all.
    const byName = new Map<string, Suggestion>();
    for (const it of items)
      if (!byName.has(it.name) && byName.size < MAX_ITEMS) byName.set(it.name, { label: it.shortName, group: "Item", detail: it.name, query: `item:${quote(it.name)}` });
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
