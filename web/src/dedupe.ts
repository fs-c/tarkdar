// Duplicate loot: the game (SPT, at least) has some loot several times over, as separate objects of the
// same item at the same spot. Quest items often come in threes, many containers in twos. The backend
// reports each object it finds, so the copies are merged here, before anything is shown or counted.

import type { LootEntry, LootKind } from "./protocol";

/** Copies are at most this far apart (m). Seen so far: exactly the same position. */
export const DUPLICATE_DISTANCE = 0.1;

/** Kinds that can have copies. Corpses and airdrops are one of a kind (each has its own contents). */
const MERGED: ReadonlySet<LootKind> = new Set(["item", "quest", "container"]);

/**
 * Loot with the copies left out: of the same kind and template within DUPLICATE_DISTANCE of each other,
 * the one with the lowest id stays. Returns the same array if there are none.
 */
export function withoutDuplicateLoot(loot: LootEntry[], distance = DUPLICATE_DISTANCE): LootEntry[] {
  // Grid cells of `distance`: a copy is in the same cell or a neighbouring one.
  const cell = (v: number) => Math.floor(v / distance);
  const cells = new Map<string, LootEntry[]>();
  const key = (l: LootEntry, x: number, y: number, z: number) => `${l.kind}|${l.tpl}|${x}|${y}|${z}`;
  const dropped = new Set<LootEntry>();
  for (const l of [...loot].sort((a, b) => a.id - b.id)) {
    if (!MERGED.has(l.kind) || !l.tpl) continue;
    const [cx, cy, cz] = l.pos.map(cell) as [number, number, number];
    let copy = false;
    for (let dx = -1; dx <= 1 && !copy; dx++)
      for (let dy = -1; dy <= 1 && !copy; dy++)
        for (let dz = -1; dz <= 1 && !copy; dz++)
          copy = !!cells.get(key(l, cx + dx, cy + dy, cz + dz))?.some((o) => Math.hypot(o.pos[0] - l.pos[0], o.pos[1] - l.pos[1], o.pos[2] - l.pos[2]) <= distance);
    if (copy) {
      dropped.add(l);
      continue;
    }
    const k = key(l, cx, cy, cz);
    const list = cells.get(k);
    if (list) list.push(l);
    else cells.set(k, [l]);
  }
  return dropped.size ? loot.filter((l) => !dropped.has(l)) : loot;
}
