// Item data from tarkov.dev's JSON API, cached in the browser.
//
// Two feeds: `items` (all item data; names are translation keys like "<id> Name") and `items_en`
// (key → English text). Only id → name, short name, a price, handbook categories, the size in the
// inventory and a few stats the display rules can match on are kept: avg24hPrice (flea average), or
// basePrice (the game's base value) for items without flea data, e.g. currencies; the handbook categories
// (the game's handbook / flea market tree) with their names; ammo's penetration and damage, armor's class. The slim catalogue is
// cached (cache.ts) and refreshed when older than MAX_AGE_MS, so the large download happens at
// most once a day. If the download fails, a stale cache is better than nothing.

import { type Cache, type CacheDef, feedCache, isFresh, readCache, writeCache } from "./cache";
import type { ItemCatalog, ItemCategory, ItemInfo } from "./items";

export const FEED_BASE = "https://json.tarkov.dev/pvp-season";
const CACHE: CacheDef = { key: "items", version: 4 };
const MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** id → [name, shortName, price (0 = unknown), price is basePrice (1) or avg24hPrice (0), handbook
 *  category ids (the item's own and those above it; 0 when there are none), inventory slots (width ×
 *  height; weapons: as assembled by default), stats]. Everything from the categories on is left out
 *  when there's nothing to say (no categories, one slot, no stats). */
export type SlimItems = Record<string, [string, string, number, 0 | 1, (string[] | 0)?, number?, SlimStats?]>;

/** [penetration, damage, armor damage, armor class]; 0 = none. */
export type SlimStats = [number, number, number, number];

/** Handbook category id → [name, parent id (null at the top)] */
export type SlimCategories = Record<string, [string, string | null]>;

export interface CachedCatalog {
  items: SlimItems;
  categories: SlimCategories;
}

export interface CatalogStatus {
  state: "loading" | "ready" | "stale" | "unavailable";
  count: number;
  fetchedAt: number | null;
  error?: string;
}

/** Reduces the two feeds to the slim form. Unknown translation keys fall back to the key itself. */
export function slimItems(itemsFeed: unknown, translationsFeed: unknown): SlimItems {
  const items = (itemsFeed as { data?: { items?: Record<string, Record<string, unknown>> } })?.data?.items;
  const en = (translationsFeed as { data?: Record<string, string> })?.data ?? {};
  if (!items || typeof items !== "object") throw new Error("unexpected items feed format");
  const out: SlimItems = {};
  for (const [id, item] of Object.entries(items)) {
    const nameKey = String(item.name ?? id);
    const shortKey = String(item.shortName ?? nameKey);
    const positive = (v: unknown) => (typeof v === "number" && v > 0 ? v : 0);
    const flea = positive(item.avg24hPrice);
    const base = positive(item.basePrice);
    const entry: SlimItems[string] = [en[nameKey] ?? nameKey, en[shortKey] ?? shortKey, flea || base, flea ? 0 : base ? 1 : 0];
    const cats = Array.isArray(item.handbookCategories) ? item.handbookCategories.filter((c): c is string => typeof c === "string") : [];
    const props = (item.properties && typeof item.properties === "object" ? item.properties : {}) as Record<string, unknown>;
    // Weapons: their base item's size is the bare receiver's; as found, they're assembled.
    const w = positive(props.defaultWidth) || positive(item.width) || 1;
    const h = positive(props.defaultHeight) || positive(item.height) || 1;
    const slots = w * h;
    const stats: SlimStats = [positive(item.penetrationPower), positive(item.damage), positive(item.armorDamage), positive(props.class)];
    const hasStats = stats.some((v) => v > 0);
    if (cats.length || slots > 1 || hasStats) entry.push(cats.length ? cats : 0, slots);
    if (hasStats) entry.push(stats);
    out[id] = entry;
  }
  return out;
}

/** The handbook category tree. Names are translation keys too (the bare id); a missing translation
 *  falls back to the normalized name. An unexpected format gives no categories, not an error. */
export function slimCategories(itemsFeed: unknown, translationsFeed: unknown): SlimCategories {
  const cats = (itemsFeed as { data?: { handbookCategories?: Record<string, Record<string, unknown>> } })?.data?.handbookCategories;
  const en = (translationsFeed as { data?: Record<string, string> })?.data ?? {};
  const out: SlimCategories = {};
  if (!cats || typeof cats !== "object") return out;
  for (const [id, c] of Object.entries(cats)) {
    const key = String(c.name ?? id);
    const parent = typeof c.parent === "string" ? c.parent : null;
    out[id] = [en[key] ?? String(c.normalizedName ?? key), parent];
  }
  return out;
}

export class SlimCatalog implements ItemCatalog {
  private readonly cats: ItemCategory[];
  constructor(
    private readonly slim: SlimItems,
    categories: SlimCategories = {},
  ) {
    const name = (id: string | null) => (id && Object.hasOwn(categories, id) ? categories[id]![0] : null);
    const path = (id: string | null, depth = 0): string[] => {
      if (!id || depth > 16 || !Object.hasOwn(categories, id)) return [];
      return [...path(categories[id]![1], depth + 1), categories[id]![0]];
    };
    this.cats = Object.entries(categories).map(([id, [n, parent]]) => ({
      id, name: n, parent: name(parent) === null ? null : parent, path: path(parent).join(" › "),
    }));
  }
  get size(): number {
    return Object.keys(this.slim).length;
  }
  lookup(templateId: string): ItemInfo | undefined {
    if (!Object.hasOwn(this.slim, templateId)) return undefined;
    const e = this.slim[templateId];
    return e ? toInfo(e) : undefined;
  }
  *items(): Iterable<[string, ItemInfo]> {
    for (const [id, e] of Object.entries(this.slim)) yield [id, toInfo(e)];
  }
  categories(): readonly ItemCategory[] {
    return this.cats;
  }
}

function toInfo(e: SlimItems[string]): ItemInfo {
  const info: ItemInfo = { name: e[0], shortName: e[1] };
  if (e[2] > 0) Object.assign(info, { price: e[2], priceSource: e[3] === 1 ? "base" : "flea" });
  if (e[4]) info.categories = e[4];
  if (e[5] && e[5] > 1) info.slots = e[5];
  const st = e[6];
  if (st) {
    if (st[0]) info.penetration = st[0];
    if (st[1]) info.damage = st[1];
    if (st[2]) info.armorDamage = st[2];
    if (st[3]) info.armorClass = st[3];
  }
  return info;
}

const isCachedCatalog = (c: unknown): c is CachedCatalog =>
  !!c && typeof c === "object" && !!(c as CachedCatalog).items && typeof (c as CachedCatalog).categories === "object";

/**
 * Returns the catalogue: from the cache if it's fresh, otherwise freshly downloaded (and cached),
 * otherwise the stale cache. `fetchFn` and `cache` are injectable for tests.
 */
export async function loadCatalog(
  opts: { now?: number; cache?: Cache; fetchFn?: typeof fetch; force?: boolean } = {},
): Promise<{ catalog: SlimCatalog | null; status: CatalogStatus }> {
  const now = opts.now ?? Date.now();
  const cache = opts.cache ?? feedCache;
  const fetchFn = opts.fetchFn ?? fetch.bind(globalThis);
  const cached = await readCache(cache, CACHE, isCachedCatalog);
  if (cached && !opts.force && isFresh(cached, now, MAX_AGE_MS)) {
    const catalog = new SlimCatalog(cached.data.items, cached.data.categories);
    return { catalog, status: { state: "ready", count: catalog.size, fetchedAt: cached.fetchedAt } };
  }
  try {
    const get = async (feed: string) => {
      const res = await fetchFn(`${FEED_BASE}/${feed}`);
      if (!res.ok) throw new Error(`${feed}: HTTP ${res.status}`);
      return res.json();
    };
    const [items, en] = await Promise.all([get("items"), get("items_en")]);
    const slim = slimItems(items, en);
    const categories = slimCategories(items, en);
    await writeCache(cache, CACHE, { items: slim, categories } satisfies CachedCatalog, now);
    const catalog = new SlimCatalog(slim, categories);
    return { catalog, status: { state: "ready", count: catalog.size, fetchedAt: now } };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    if (cached) {
      const catalog = new SlimCatalog(cached.data.items, cached.data.categories);
      return { catalog, status: { state: "stale", count: catalog.size, fetchedAt: cached.fetchedAt, error } };
    }
    return { catalog: null, status: { state: "unavailable", count: 0, fetchedAt: null, error } };
  }
}
