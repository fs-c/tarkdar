// What the map shows when, so it stays readable: which markers and labels drop out as you zoom out,
// and in which order labels claim their space. How things look is style.ts; whether a kind of thing
// shows at all is the layer toggles and the list's filters; highlights always show.
//
// "Detail" is the projector's level of detail (see Map3D's DETAIL_PX_PER_METRE: 1 ≈ 4 screen px per
// metre).

import type { ValueTier } from "./items";

/** Labels show from these levels of detail on (and then only where there's room). */
export const LABEL_DETAIL = {
  /** Loose items (those above the "label items worth at least" setting). */
  items: 2.5,
  containers: 1.5,
};

/** Exfil labels say their status from this level of detail on; below, just the name (the marker's
 *  colour still tells the status). */
export const EXFIL_STATUS_DETAIL = 0.5;

/**
 * Loose item markers as you zoom out (a setting): the cheap ones go first. Each tier's marker shows
 * from its level of detail on. Quest items, containers and highlighted items aren't affected.
 */
export type LootDensity = "all" | "fewer" | "fewest";

export const LOOT_DENSITY: Record<LootDensity, { label: string; hint: string; from: Record<ValueTier, number> }> = {
  all: { label: "All", hint: "Every item at every zoom", from: { low: 0, mid: 0, high: 0 } },
  fewer: { label: "Fewer", hint: "Zoomed out: cheap items (< 20k) go, then mid-priced ones (< 100k)", from: { low: 1, mid: 0.4, high: 0 } },
  fewest: { label: "Fewest", hint: "Cheap items only once labels show; mid-priced ones from a moderate zoom", from: { low: 2.5, mid: 1, high: 0 } },
};

export const DEFAULT_LOOT_DENSITY: LootDensity = "fewer";

export function itemMarkerShown(tier: ValueTier, detail: number, density: LootDensity): boolean {
  return detail >= (LOOT_DENSITY[density] ?? LOOT_DENSITY[DEFAULT_LOOT_DENSITY]).from[tier];
}

/**
 * Who gets label space first (lower first; within a rank, higher `priority` first). Players and exfils
 * always get a label, at a fixed spot next to their marker (so it doesn't jump about as they move),
 * claiming it before anything else; airdrops always get one too, wherever it fits. The rest only where
 * there's room (quest items too: on some maps there are dozens, piled up when zoomed out).
 */
export const LABEL_RANK = {
  player: 0,
  exfil: 1,
  highlighted: 2,
  questOrAirdrop: 3,
  item: 4,
  container: 5,
} as const;
