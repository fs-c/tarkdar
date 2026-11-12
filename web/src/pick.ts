// Hit-testing clicks on the radar: which marker (player, exfil, loot) is under the cursor.

import type { Exfil, ExplosivesData, LootEntry, Player, WorldPos } from "./protocol";
import type { Layers } from "./render";
import type { Projector } from "./projector";

export type Selection =
  | { kind: "player"; id: number }
  | { kind: "loot"; id: number }
  | { kind: "exfil"; id: number }
  | { kind: "grenade"; id: number }
  | { kind: "tripwire"; id: number };

export const selectionKey = (sel: Selection): string => `${sel.kind}:${sel.id}`;

export interface Pickable {
  players: Player[];
  exfils: Exfil[];
  loot: LootEntry[];
  explosives: ExplosivesData;
}

export const isContainerLoot = (l: LootEntry): boolean => l.kind === "container" || l.kind === "airdrop";

/** The nearest visible player, exfil or loot marker within a few pixels of screen position (x, y). */
export function pick(pr: Projector, src: Pickable, layers: Layers, x: number, y: number): Selection | null {
  let best: { sel: Selection; d: number } | null = null;
  const consider = (sel: Selection, pos: WorldPos | null | undefined, radius: number) => {
    if (!pos) return;
    const [sx, sy] = pr.toScreen(pos);
    const d = Math.hypot(sx - x, sy - y);
    if (d <= radius && (!best || d < best.d)) best = { sel, d };
  };
  for (const p of src.players) consider({ kind: "player", id: p.id }, p.pos, 12);
  if (layers.exfils) for (const e of src.exfils) consider({ kind: "exfil", id: e.id }, e.pos, 12);
  if (layers.explosives) {
    for (const g of src.explosives.grenades) consider({ kind: "grenade", id: g.id }, g.pos, 10);
    for (const w of src.explosives.tripwires) consider({ kind: "tripwire", id: w.id }, midpoint(w.from, w.to), 10);
  }
  for (const l of src.loot) if (isContainerLoot(l) ? layers.containers : layers.loot) consider({ kind: "loot", id: l.id }, l.pos, 8);
  return (best as { sel: Selection } | null)?.sel ?? null;
}

/** World position of the selected thing, or null when it's gone. */
export function selectedPosition(sel: Selection | null, src: Pickable): WorldPos | null {
  if (!sel) return null;
  switch (sel.kind) {
    case "player": return src.players.find((p) => p.id === sel.id)?.pos ?? null;
    case "loot": return src.loot.find((l) => l.id === sel.id)?.pos ?? null;
    case "exfil": return src.exfils.find((e) => e.id === sel.id)?.pos ?? null;
    case "grenade": return src.explosives.grenades.find((g) => g.id === sel.id)?.pos ?? null;
    case "tripwire": {
      const w = src.explosives.tripwires.find((x) => x.id === sel.id);
      return w ? midpoint(w.from, w.to) : null;
    }
  }
}

export function midpoint(a: WorldPos, b: WorldPos): WorldPos {
  return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
}
