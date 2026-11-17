// Hit-testing clicks on the radar: which marker (player, exfil, loot) is under the cursor.

import { type Exfil, type ExplosivesData, Joint, type LootEntry, type Player, type WorldPos } from "./protocol";
import { BASE, type Style } from "./rules/rules";
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

/**
 * The nearest player, exfil or loot marker within a few pixels of screen position (x, y), among those
 * the display rules don't hide (`styles`, by selection key; at any zoom: a marker dropped when zoomed
 * out can still be clicked).
 */
export function pick(pr: Projector, src: Pickable, styles: ReadonlyMap<string, Style>, x: number, y: number): Selection | null {
  let best: { sel: Selection; d: number } | null = null;
  const consider = (sel: Selection, pos: WorldPos | null | undefined, radius: number) => {
    if (!pos) return;
    const [sx, sy] = pr.toScreen(pos);
    const d = Math.hypot(sx - x, sy - y);
    if (d <= radius && (!best || d < best.d)) best = { sel, d };
  };
  const hidden = (sel: Selection, kind: keyof typeof BASE) => (styles.get(selectionKey(sel)) ?? BASE[kind]).show === null;
  for (const p of src.players) {
    const sel: Selection = { kind: "player", id: p.id };
    if (!p.local && hidden(sel, "player")) continue;
    consider(sel, p.pos, 12);
    // Drawn as a figure (3D, close up): its chest and head count too.
    if (p.pos && p.joints)
      for (const j of [Joint.chest, Joint.head]) {
        const o = j * 3;
        consider(sel, [p.pos[0] + p.joints[o]!, p.pos[1] + p.joints[o + 1]!, p.pos[2] + p.joints[o + 2]!], 12);
      }
  }
  for (const e of src.exfils) {
    const sel: Selection = { kind: "exfil", id: e.id };
    if (!hidden(sel, "exfil")) consider(sel, e.pos, 12);
  }
  for (const g of src.explosives.grenades) {
    const sel: Selection = { kind: "grenade", id: g.id };
    if (!hidden(sel, "grenade")) consider(sel, g.pos, 10);
  }
  for (const w of src.explosives.tripwires) {
    const sel: Selection = { kind: "tripwire", id: w.id };
    if (!hidden(sel, "tripwire")) consider(sel, midpoint(w.from, w.to), 10);
  }
  for (const l of src.loot) {
    const sel: Selection = { kind: "loot", id: l.id };
    if (!hidden(sel, l.kind)) consider(sel, l.pos, 8);
  }
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
