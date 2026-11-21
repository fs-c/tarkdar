// The query language: what a display rule or a highlight matches, as text you can read and type.
//
//   ledx                      free text, as in the list's search (every word must appear)
//   "red rebel"               a phrase
//   is:boss  is:pmc,pscav     kinds of player and thing; a list means any of them
//   is:needed                 a loose item a started quest still needs, or a quest item one needs
//   quest:story,side          ... needed by that kind of quest: story side daily weekly (repeatable:
//                             daily and weekly)
//   item:LEDX  item:"Red Rebel ice pick"   items (short or full name) and kinds of container
//   cat:Electronics           handbook categories
//   value>=40k  price<5k      roubles: value per slot (loose items) or of the equipment (players,
//                             corpses); price per unit (loose items)
//   pen>=40  dmg>60  class>=5 ammo penetration and damage, armor class
//
// Terms are separated by spaces and must all hold (AND); a comma list holds when any value does (OR).
// Item conditions (item, cat, pen, dmg, class) hold for things that are, or carry, such an item.
// Comparisons: >= > <= < =; numbers take k and m. An empty query matches nothing.

import { type ItemCatalog, type ItemInfo, containerTypes } from "../model/items";
import type { QuestKind } from "../model/protocol";
import type { PlayerRow, RowBase, SubjectKind } from "../list/rows";
import { type PlayerType, SPECIAL_TYPES } from "../model/roles";

export type NumField = "value" | "price" | "pen" | "dmg" | "class";
export type Op = ">=" | ">" | "<=" | "<" | "=";

export type Term =
  | { kind: "text"; text: string }
  | { kind: "is"; values: string[] }
  | { kind: "item"; names: string[] }
  | { kind: "cat"; names: string[] }
  | { kind: "quest"; kinds: QuestKind[] }
  | { kind: "num"; field: NumField; op: Op; value: number };

const NUM_FIELDS: Record<string, NumField> = {
  value: "value", price: "price", pen: "pen", penetration: "pen", dmg: "dmg", damage: "dmg", class: "class", armor: "class",
};
const FIELDS = ["is", "item", "cat", "quest", ...Object.keys(NUM_FIELDS)];

/** What `quest:` takes: kinds of quest, and other names for them. */
const QUEST_KIND_NAMES: Record<string, QuestKind[]> = {
  story: ["story"], main: ["story"], side: ["side"], trader: ["side"], daily: ["daily"], dailies: ["daily"],
  weekly: ["weekly"], weeklies: ["weekly"], repeatable: ["daily", "weekly"], repeatables: ["daily", "weekly"],
};

/** What `is:` knows: a row test each. */
type RowTest = (row: RowBase) => boolean;
const subject = (...s: SubjectKind[]): RowTest => (r) => s.includes(r.subject);
const player = (test: (p: PlayerRow) => boolean): RowTest => (r) => r.subject === "player" && test(r as PlayerRow);
const types = (...t: PlayerType[]): RowTest => player((p) => t.includes(p.type));

const IS_VALUES: Record<string, RowTest> = {
  player: subject("player"),
  item: subject("item"),
  quest: subject("quest"),
  loot: subject("item", "quest"),
  container: subject("container"),
  airdrop: subject("airdrop"),
  corpse: subject("corpse"),
  exfil: subject("exfil"),
  grenade: subject("grenade"),
  tripwire: subject("tripwire"),
  explosive: subject("grenade", "tripwire"),
  usec: types("usec"),
  bear: types("bear"),
  pmc: types("usec", "bear"),
  pscav: types("p-scav"),
  scav: types("ai-scav"),
  boss: types("boss"),
  guard: types("follower"),
  raider: types("raider"),
  rogue: types("rogue"),
  cultist: types("cultist"),
  bd: types("bd"),
  infected: types("zombie"),
  other: types("other"),
  special: player((p) => SPECIAL_TYPES.has(p.type)),
  human: player((p) => !p.ai),
  ai: player((p) => p.ai),
  alive: player((p) => p.state === "alive"),
  dead: player((p) => p.state === "dead"),
  needed: (r) => !!r.questNeeded,
};
/** Plurals and other names `is:` takes too. */
const IS_ALIASES: Record<string, string> = {
  players: "player", items: "item", containers: "container", airdrops: "airdrop", corpses: "corpse", body: "corpse", bodies: "corpse",
  exfils: "exfil", extract: "exfil", extracts: "exfil", grenades: "grenade", tripwires: "tripwire", explosives: "explosive", pmcs: "pmc",
  scavs: "scav", bosses: "boss", guards: "guard", follower: "guard", followers: "guard", raiders: "raider", rogues: "rogue",
  cultists: "cultist", zombie: "infected", zombies: "infected", quests: "quest",
};

// ---- Parsing (no catalog needed) ----

/** Splits on spaces outside quotes; quotes stay in the words. */
function words(q: string): string[] {
  const out: string[] = [];
  let cur = "", quoted = false;
  for (const ch of q) {
    if (ch === '"') quoted = !quoted;
    if (!quoted && /\s/.test(ch)) {
      if (cur) out.push(cur);
      cur = "";
    } else cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}

/** A comma list, quotes removed. */
function list(v: string): string[] {
  const out: string[] = [];
  let cur = "", quoted = false;
  for (const ch of v) {
    if (ch === '"') quoted = !quoted;
    else if (ch === "," && !quoted) {
      out.push(cur.trim());
      cur = "";
    } else cur += ch;
  }
  out.push(cur.trim());
  return out.filter(Boolean);
}

/** "50k", "1.5m", "40" → a number; null for anything else. */
export function parseNumber(v: string): number | null {
  const m = /^(\d+(?:[.,]\d+)?)\s*([km])?$/i.exec(v.trim());
  if (!m) return null;
  const n = Number(m[1]!.replace(",", "."));
  return Math.round(n * (m[2]?.toLowerCase() === "m" ? 1_000_000 : m[2] ? 1_000 : 1));
}

export interface Parsed {
  terms: Term[];
  errors: string[];
}

export function parseQuery(q: string): Parsed {
  const terms: Term[] = [];
  const errors: string[] = [];
  for (const w of words(q)) {
    const m = /^([a-z]+)(:|>=|<=|>|<|=|≥|≤)(.*)$/i.exec(w);
    if (!m) {
      const text = w.replaceAll('"', "").toLowerCase().trim();
      if (text) terms.push({ kind: "text", text });
      continue;
    }
    const key = m[1]!.toLowerCase();
    const op = (m[2] === "≥" ? ">=" : m[2] === "≤" ? "<=" : m[2]) as Op | ":";
    const rest = m[3]!;
    if (op === ":" && key === "quest") {
      const values = list(rest).map((v) => v.toLowerCase());
      const unknown = values.filter((v) => !(v in QUEST_KIND_NAMES));
      if (!values.length) errors.push("quest: needs a value (story, side, daily, weekly)");
      else if (unknown.length) errors.push(`quest:${unknown.join(",")}: unknown (story, side, daily, weekly, repeatable)`);
      else terms.push({ kind: "quest", kinds: [...new Set(values.flatMap((v) => QUEST_KIND_NAMES[v]!))] });
      continue;
    }
    if (op === ":" && (key === "is" || key === "item" || key === "cat")) {
      const values = list(rest);
      if (!values.length) {
        errors.push(`${key}: needs a value`);
        continue;
      }
      if (key === "is") {
        const known = values.map((v) => IS_ALIASES[v.toLowerCase()] ?? v.toLowerCase());
        const unknown = known.filter((v) => !(v in IS_VALUES));
        if (unknown.length) errors.push(`is:${unknown.join(",")}: unknown (try ${suggestIs(unknown[0]!)})`);
        else terms.push({ kind: "is", values: known });
      } else terms.push({ kind: key, names: values });
      continue;
    }
    const field = NUM_FIELDS[key];
    if (field && op !== ":") {
      const value = parseNumber(rest);
      if (value === null) errors.push(`${w}: not a number`);
      else terms.push({ kind: "num", field, op, value });
      continue;
    }
    if (field) errors.push(`${key}: compares, e.g. ${key}>=${field === "value" || field === "price" ? "40k" : "4"}`);
    else if (op === ":") errors.push(`${key}: unknown field (${FIELDS.slice(0, 5).join(", ")}, …)`);
    else {
      // "x=1" with an unknown key: plain text.
      terms.push({ kind: "text", text: w.toLowerCase() });
    }
  }
  return { terms, errors };
}

function suggestIs(v: string): string {
  const all = [...Object.keys(IS_VALUES), ...Object.keys(IS_ALIASES)];
  const close = all.find((k) => k.startsWith(v.slice(0, 2)));
  return close ? `is:${close}` : "is:boss, is:item, …";
}

/** A value as it's written in a query: quoted when it has to be. */
export const quote = (v: string): string => (/^[^\s",]+$/.test(v) ? v : `"${v.replaceAll('"', "")}"`);

// ---- Compiling against the catalog: names resolved, item conditions as sets of templates ----

export interface Compiled {
  test: (row: RowBase) => boolean;
  errors: string[];
  /** Says nothing (matches nothing). */
  empty: boolean;
}

const NOTHING: Compiled = { test: () => false, errors: [], empty: true };

interface NameIndex {
  items: Map<string, string[]>;
  categories: Map<string, string[]>;
}

const indexes = new WeakMap<ItemCatalog, NameIndex>();
const compiled = new WeakMap<ItemCatalog, Map<string, Compiled>>();

function nameIndex(catalog: ItemCatalog): NameIndex {
  let ix = indexes.get(catalog);
  if (ix) return ix;
  const items = new Map<string, string[]>();
  const add = (map: Map<string, string[]>, name: string, id: string) => {
    const k = name.toLowerCase();
    const ids = map.get(k);
    if (!ids) map.set(k, [id]);
    else if (!ids.includes(id)) ids.push(id);
  };
  for (const [tpl, info] of catalog.items()) {
    add(items, info.name, tpl);
    add(items, info.shortName, tpl);
  }
  for (const c of containerTypes()) for (const tpl of c.tpls) add(items, c.name, tpl);
  const categories = new Map<string, string[]>();
  for (const c of catalog.categories()) add(categories, c.name, c.id);
  ix = { items, categories };
  indexes.set(catalog, ix);
  return ix;
}

const compare = (v: number, op: Op, x: number): boolean =>
  op === ">=" ? v >= x : op === ">" ? v > x : op === "<=" ? v <= x : op === "<" ? v < x : v === x;

const STAT: Record<"pen" | "dmg" | "class", (i: ItemInfo) => number | undefined> = {
  pen: (i) => i.penetration,
  dmg: (i) => i.damage,
  class: (i) => i.armorClass,
};

/** Templates whose item satisfies `ok`. */
function tplsWhere(catalog: ItemCatalog, ok: (i: ItemInfo) => boolean): Set<string> {
  const out = new Set<string>();
  for (const [tpl, info] of catalog.items()) if (ok(info)) out.add(tpl);
  return out;
}

const carries = (set: ReadonlySet<string>): RowTest => (r) => r.tpls.some((t) => set.has(t));

function compileTerm(t: Term, catalog: ItemCatalog, errors: string[]): RowTest {
  switch (t.kind) {
    case "text":
      return (r) => r.search.includes(t.text);
    case "is": {
      const tests = t.values.map((v) => IS_VALUES[v]!);
      return tests.length === 1 ? tests[0]! : (r) => tests.some((f) => f(r));
    }
    case "quest":
      return (r) => !!r.questKinds?.some((k) => t.kinds.includes(k));
    case "item": {
      const ix = nameIndex(catalog).items;
      const set = new Set<string>();
      for (const n of t.names) {
        const tpls = ix.get(n.toLowerCase());
        if (tpls) for (const tpl of tpls) set.add(tpl);
        else errors.push(ix.size ? `item:${quote(n)}: no such item` : "item data isn't loaded");
      }
      return carries(set);
    }
    case "cat": {
      const ix = nameIndex(catalog).categories;
      const ids = new Set<string>();
      for (const n of t.names) {
        const found = ix.get(n.toLowerCase());
        if (found) for (const id of found) ids.add(id);
        else errors.push(ix.size ? `cat:${quote(n)}: no such category` : "item data isn't loaded");
      }
      return carries(tplsWhere(catalog, (i) => !!i.categories?.some((c) => ids.has(c))));
    }
    case "num": {
      const { field, op, value } = t;
      if (field === "value" || field === "price") {
        // Unknown values count as 0 below a bound (unpriced items are cheap ones), and match no lower bound.
        const below = op === "<" || op === "<=";
        return (r) => {
          const v = field === "value" ? r.value : r.price;
          return v === undefined ? below : compare(v, op, value);
        };
      }
      const stat = STAT[field];
      return carries(tplsWhere(catalog, (i) => {
        const v = stat(i);
        return v !== undefined && compare(v, op, value);
      }));
    }
  }
}

/** The local player is never matched: we know where we are. */
const isLocal = (r: RowBase) => r.subject === "player" && (r as PlayerRow).local;

/** A query, ready to test rows with; cached per query and catalog. Errors make it match nothing. */
export function compileQuery(query: string, catalog: ItemCatalog): Compiled {
  let cache = compiled.get(catalog);
  if (!cache) compiled.set(catalog, (cache = new Map()));
  const hit = cache.get(query);
  if (hit) return hit;
  const { terms, errors } = parseQuery(query);
  let out: Compiled;
  if (!terms.length && !errors.length) out = NOTHING;
  else {
    const tests = terms.map((t) => compileTerm(t, catalog, errors));
    out = errors.length
      ? { test: () => false, errors, empty: false }
      : { test: (r) => !isLocal(r) && tests.every((f) => f(r)), errors, empty: false };
  }
  if (cache.size > 500) cache.clear(); // typed queries: don't keep every prefix forever
  cache.set(query, out);
  return out;
}

/** Whether a query uses the syntax (fields), not just free text. */
export const isStructured = (q: string): boolean => parseQuery(q).terms.some((t) => t.kind !== "text");

/** The fields, with an example and what they mean: the search's help, and suggestions while typing. */
export const QUERY_HELP: { example: string; text: string; words: string }[] = [
  { example: "is:boss", text: "kinds of player: pmc usec bear pscav scav boss guard raider rogue cultist bd infected special human", words: "is players kinds" },
  { example: "is:item", text: "kinds of thing: item quest container airdrop corpse exfil explosive", words: "is things kinds" },
  { example: "is:needed", text: "loose items a started quest still needs (and quest items one needs)", words: "needed quest" },
  { example: "quest:story", text: "needed by a kind of quest: story side daily weekly repeatable", words: "quest story side daily weekly repeatable task" },
  { example: "item:LEDX", text: "an item (short or full name), or a kind of container", words: "item" },
  { example: "cat:Electronics", text: "a handbook category", words: "cat category" },
  { example: "value>=40k", text: "value per slot (loose items), of the equipment (players, corpses)", words: "value" },
  { example: "price>=100k", text: "price per unit (loose items)", words: "price" },
  { example: "pen>=40", text: "ammo penetration (things that are or carry such ammo)", words: "pen penetration ammo" },
  { example: "dmg>=60", text: "ammo damage", words: "dmg damage ammo" },
  { example: "class>=5", text: "armor class (things that are or wear such armor)", words: "class armor" },
];
