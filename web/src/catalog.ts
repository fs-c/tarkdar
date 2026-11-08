// Item data from tarkov.dev's JSON API, cached in the browser.
//
// Two feeds: `items` (all item data; names are translation keys like "<id> Name") and `items_en`
// (key → English text). Only id → name, short name and a price are kept: avg24hPrice (flea average),
// or basePrice (the game's base value) for items without flea data, e.g. currencies. The slim catalogue is
// cached in localStorage and refreshed when older than MAX_AGE_MS, so the large download happens at
// most once a day. If the download fails, a stale cache is better than nothing.

import type { ItemCatalog, ItemInfo } from "./items";

export const FEED_BASE = "https://json.tarkov.dev/pvp-season";
const STORAGE_KEY = "radar.items.v2";
const MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** id → [name, shortName, price (0 = unknown), price is basePrice (1) or avg24hPrice (0)] */
export type SlimItems = Record<string, [string, string, number, 0 | 1]>;

export interface CachedCatalog {
  fetchedAt: number; // ms since epoch
  items: SlimItems;
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
    out[id] = [en[nameKey] ?? nameKey, en[shortKey] ?? shortKey, flea || base, flea ? 0 : base ? 1 : 0];
  }
  return out;
}

export class SlimCatalog implements ItemCatalog {
  constructor(private readonly items: SlimItems) {}
  get size(): number {
    return Object.keys(this.items).length;
  }
  lookup(templateId: string): ItemInfo | undefined {
    if (!Object.hasOwn(this.items, templateId)) return undefined;
    const e = this.items[templateId];
    if (!e) return undefined;
    if (e[2] <= 0) return { name: e[0], shortName: e[1] };
    return { name: e[0], shortName: e[1], price: e[2], priceSource: e[3] === 1 ? "base" : "flea" };
  }
}

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function readCache(storage: StorageLike): CachedCatalog | null {
  try {
    const c = JSON.parse(storage.getItem(STORAGE_KEY) ?? "null") as CachedCatalog | null;
    return c && typeof c.fetchedAt === "number" && c.items ? c : null;
  } catch {
    return null;
  }
}

/**
 * Returns the catalogue: from the cache if it's fresh, otherwise freshly downloaded (and cached),
 * otherwise the stale cache. `fetchFn` and `storage` are injectable for tests.
 */
export async function loadCatalog(
  opts: { now?: number; storage?: StorageLike; fetchFn?: typeof fetch; force?: boolean } = {},
): Promise<{ catalog: SlimCatalog | null; status: CatalogStatus }> {
  const now = opts.now ?? Date.now();
  const storage = opts.storage ?? localStorage;
  const fetchFn = opts.fetchFn ?? fetch.bind(globalThis);
  const cached = readCache(storage);
  const age = cached ? now - cached.fetchedAt : Infinity;
  if (cached && !opts.force && age >= 0 && age < MAX_AGE_MS) {  // a future timestamp (clock change) is stale
    const catalog = new SlimCatalog(cached.items);
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
    try {
      storage.setItem(STORAGE_KEY, JSON.stringify({ fetchedAt: now, items: slim } satisfies CachedCatalog));
    } catch (e) {
      console.warn("couldn't cache item data", e);
    }
    const catalog = new SlimCatalog(slim);
    return { catalog, status: { state: "ready", count: catalog.size, fetchedAt: now } };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    if (cached) {
      const catalog = new SlimCatalog(cached.items);
      return { catalog, status: { state: "stale", count: catalog.size, fetchedAt: cached.fetchedAt, error } };
    }
    return { catalog: null, status: { state: "unavailable", count: 0, fetchedAt: null, error } };
  }
}
