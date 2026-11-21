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
const CACHE: CacheDef = { key: "items", version: 5 }; // 5: objects, not tuples
const MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** id → what's known about the item; a field is left out when there's nothing to say (no price, no
 *  categories, one slot, no stats). Stored as is in the cache (IndexedDB: no need to squeeze it into
 *  tuples). */
export type SlimItems = Record<string, ItemInfo>;

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
    const info: ItemInfo = { name: en[nameKey] ?? nameKey, shortName: en[shortKey] ?? shortKey };
    if (flea || base) {
      info.price = flea || base;
      info.priceSource = flea ? "flea" : "base";
    }
    const cats = Array.isArray(item.handbookCategories) ? item.handbookCategories.filter((c): c is string => typeof c === "string") : [];
    if (cats.length) info.categories = cats;
    const props = (item.properties && typeof item.properties === "object" ? item.properties : {}) as Record<string, unknown>;
    // Weapons: their base item's size is the bare receiver's; as found, they're assembled.
    const w = positive(props.defaultWidth) || positive(item.width) || 1;
    const h = positive(props.defaultHeight) || positive(item.height) || 1;
    if (w * h > 1) info.slots = w * h;
    const set = (key: "penetration" | "damage" | "armorDamage" | "armorClass", v: unknown) => void (positive(v) && (info[key] = positive(v)));
    set("penetration", item.penetrationPower);
    set("damage", item.damage);
    set("armorDamage", item.armorDamage);
    set("armorClass", props.class);
    out[id] = info;
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
    return Object.hasOwn(this.slim, templateId) ? this.slim[templateId] : undefined;
  }
  *items(): Iterable<[string, ItemInfo]> {
    yield* Object.entries(this.slim);
  }
  categories(): readonly ItemCategory[] {
    return this.cats;
  }
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
