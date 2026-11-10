// Hit-testing clicks on the radar: which marker (player, exfil, loot) is under the cursor.

import { type Affine, worldToPixel } from "./calibration";
import type { Exfil, LootEntry, Player, WorldPos } from "./protocol";
import type { Layers } from "./render";
import type { View } from "./view";

export type Selection =
  | { kind: "player"; id: number }
  | { kind: "loot"; id: number }
  | { kind: "exfil"; id: number };

export interface Pickable {
  players: Player[];
  exfils: Exfil[];
  loot: LootEntry[];
}

export const isContainerLoot = (l: LootEntry): boolean => l.kind === "container" || l.kind === "airdrop";

/** The nearest visible player, exfil or loot marker within a few pixels of screen position (x, y). */
export function pick(view: View, t: Affine, src: Pickable, layers: Layers, x: number, y: number): Selection | null {
  let best: { sel: Selection; d: number } | null = null;
  const consider = (sel: Selection, pos: WorldPos | null | undefined, radius: number) => {
    if (!pos) return;
    const [sx, sy] = view.toScreen(...worldToPixel(t, pos[0], pos[2]));
    const d = Math.hypot(sx - x, sy - y);
    if (d <= radius && (!best || d < best.d)) best = { sel, d };
  };
  for (const p of src.players) consider({ kind: "player", id: p.id }, p.pos, 12);
  if (layers.exfils) for (const e of src.exfils) consider({ kind: "exfil", id: e.id }, e.pos, 12);
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
  }
}
