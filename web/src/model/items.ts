// Item and container naming. Item data (names, prices by template id) comes from an ItemCatalog
// (currently tarkov.dev, see catalog.ts). Containers aren't items there, so their names come from the
// small static table below.

/** Where an item's price comes from: the flea market, the best trader offer (better than the flea or
 *  no flea data), or the game's base price (neither). */
export type PriceSource = "flea" | "trader" | "base";

export interface ItemInfo {
  name: string;
  shortName: string;
  /** Per-unit value in roubles: what it realistically sells for, on the flea market or to a trader,
   *  or the game's base price if neither is known (e.g. currencies); see catalog.ts estimatePrice.
   *  Undefined if there's no price at all. */
  price?: number;
  priceSource?: PriceSource;
  /** Handbook category ids, the item's own and all above it ("Electronics", "Barter items"). */
  categories?: readonly string[];
  /** Inventory slots it takes (width × height); undefined: one. */
  slots?: number;
  /** Ammo. */
  penetration?: number;
  damage?: number;
  armorDamage?: number;
  /** Armor, plates, helmets, armored rigs. */
  armorClass?: number;
}

/** What an item is worth per inventory slot (roubles): how loose loot is priced. */
export function slotValue(info: ItemInfo | undefined): number | undefined {
  return info?.price === undefined ? undefined : Math.round(info.price / (info.slots ?? 1));
}

/** A handbook category: the tree the game's handbook and the flea market sort items into. */
export interface ItemCategory {
  id: string;
  name: string;
  parent: string | null;
  /** Names from the top down to this one's parent: "Barter items" for Electronics; "" at the top. */
  path: string;
}

export interface ItemCatalog {
  lookup(templateId: string): ItemInfo | undefined;
  /** Every item, for search. */
  items(): Iterable<[templateId: string, info: ItemInfo]>;
  categories(): readonly ItemCategory[];
}

/** Total value of items and their contents (price × stack count, recursively). */
export function totalValue(nodes: { tpl: string; count?: number; items?: unknown[] }[], catalog: ItemCatalog): number {
  let sum = 0;
  for (const n of nodes) {
    sum += (catalog.lookup(n.tpl)?.price ?? 0) * (n.count ?? 1);
    if (n.items?.length) sum += totalValue(n.items as typeof nodes, catalog);
  }
  return sum;
}

/** Equipment slots that don't count towards what a player carries (cosmetic, bound or junk). */
const UNVALUED_SLOTS = /^(Scabbard|SecuredContainer|Dogtag|ArmBand|SpecialSlot\d*)$/;

/** Value of a player's equipment: totalValue without the slots in UNVALUED_SLOTS. */
export function equipmentValue(slots: { slot?: string; tpl: string; count?: number; items?: unknown[] }[], catalog: ItemCatalog): number {
  return totalValue(slots.filter((n) => !n.slot || !UNVALUED_SLOTS.test(n.slot)), catalog);
}

/** "1.2M", "45k", "800" (roubles). */
/** Things this far (m) above or below us or more get their height said. */
export const HEIGHT_DIFF_MIN = 2;

/** "▲3" / "▼12": how far (m) above or below, or "" when about level (or unknown). */
export function formatHeightDiff(dy: number | undefined): string {
  if (dy === undefined || Math.abs(dy) < HEIGHT_DIFF_MIN) return "";
  return dy > 0 ? `▲${Math.round(dy)}` : `▼${Math.round(-dy)}`;
}

export function formatPrice(roubles: number): string {
  if (roubles >= 1_000_000) return `${(roubles / 1_000_000).toFixed(roubles >= 10_000_000 ? 0 : 1)}M`;
  if (roubles >= 1_000) return `${Math.round(roubles / 1_000)}k`;
  return `${Math.round(roubles)}`;
}

/** Loose items' value tiers (per slot, see slotValue): the built-in rules' cheap and valuable items. */
export const VALUE_TIERS = { mid: 10_000, high: 40_000 };

/** No item data loaded: every lookup misses. */
export const emptyCatalog: ItemCatalog = { lookup: () => undefined, items: () => [], categories: () => [] };

/** Container template ids → display name. */
const CONTAINERS: Record<string, string> = {
  "578f87a3245977356274f2cb": "Duffle Bag",
  "578f87b7245977356274f2cd": "Drawer",
  "578f8782245977354405a1e3": "Safe",
  "5909d89086f77472591234a0": "Weapon Box",
  "5909d7cf86f77470ee57d75a": "Weapon Box",
  "5909d76c86f77471e53d2adf": "Weapon Box",
  "5909d5ef86f77467974efbd8": "Weapon Box",
  "5d6fd45b86f774317075ed43": "Technical Crate",
  "5d6fd13186f77424ad2a8c69": "Ration Crate",
  "5d6fe50986f77449d97f7463": "Medical Crate",
  "578f8778245977358849a9b5": "Jacket",
  "5937ef2b86f77408a47244b3": "Jacket",
  "59387ac686f77401442ddd61": "Jacket",
  "5909d4c186f7746ad34e805a": "Med Package",
  "5909d24f86f77466f56e6855": "Med Box",
  "5909d50c86f774659e6aaebe": "Toolbox",
  "5909d36d86f774660f0bb900": "Grenade Box",
  "5d6d2bb386f774785b07a77a": "Buried Stash",
  "5d6d2b5486f774785c2ba8ea": "Ground Cache",
  "578f87ad245977356274f2cc": "Wooden Crate",
  "5c052cea86f7746b2101e8d8": "Suitcase",
  "5909d45286f77465a8136dc6": "Ammo Box",
  "5909e4b686f7747f5b744fa4": "Dead Body",
  "6582e6c6edf14c4c6023adf2": "Dead Body",
  "6582e6d7b14c3f72eb071420": "Dead Body",
  "59139c2186f77411564f8e42": "PC Block",
  "578f879c24597735401e6bc6": "Register",
};

export function containerName(templateId: string): string | undefined {
  return Object.hasOwn(CONTAINERS, templateId) ? CONTAINERS[templateId] : undefined;
}

/** The known kinds of container, by name: variants that share a name are one kind. */
export function containerTypes(): { name: string; tpls: string[] }[] {
  const byName = new Map<string, string[]>();
  for (const [tpl, name] of Object.entries(CONTAINERS)) {
    const tpls = byName.get(name);
    if (tpls) tpls.push(tpl);
    else byName.set(name, [tpl]);
  }
  return [...byName].map(([name, tpls]) => ({ name, tpls }));
}
