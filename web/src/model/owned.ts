// What the player owns, for what quests still need (quests.ts, questNeeds): the stash as of the raid's
// start (the backend's `stash` message, kept across raids, see useOwned) plus what the character has on
// right now (the local player's equipment). Out of a raid, the stash message's equipment stands in for
// the character's.

import type { ItemNode, OwnedItem, StashData } from "./protocol";

/** Units owned of an item, and how many of them are found in raid. */
export interface OwnedCount {
  count: number;
  fir: number;
}

/** Template id → what's owned of it. */
export type Owned = ReadonlyMap<string, OwnedCount>;

function add(into: Map<string, OwnedCount>, tpl: string, count: number, fir: number): void {
  const o = into.get(tpl);
  if (o) {
    o.count += count;
    o.fir += fir;
  } else into.set(tpl, { count, fir });
}

function addNodes(into: Map<string, OwnedCount>, nodes: readonly ItemNode[]): void {
  for (const n of nodes) {
    const count = n.count ?? 1;
    add(into, n.tpl, count, n.fir ? count : 0);
    if (n.items) addNodes(into, n.items);
  }
}

const addOwned = (into: Map<string, OwnedCount>, items: readonly OwnedItem[]) => {
  for (const o of items) add(into, o.tpl, o.count, Math.min(o.fir ?? 0, o.count));
};

/**
 * The stash plus the character's gear: `equipment` (the local player's, live in a raid) if given, else
 * the stash's. Null when neither is known.
 */
export function ownedItems(stash: StashData | null, equipment?: readonly ItemNode[]): Owned | null {
  if (!stash && !equipment) return null;
  const out = new Map<string, OwnedCount>();
  if (stash) addOwned(out, stash.stash);
  if (equipment) addNodes(out, equipment);
  else if (stash) addOwned(out, stash.equipment);
  return out;
}

/** A string that's equal for equal contents (to keep the same Owned while nothing changed). */
export function ownedKey(owned: Owned | null): string {
  if (!owned) return "";
  return [...owned].map(([tpl, o]) => `${tpl}:${o.count}:${o.fir}`).sort().join(",");
}
