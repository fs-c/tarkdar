// How things look, by what they are: the colours, sizes and emphasis of players, loot and exfils, in
// one place. The map's markers (with their figures), trails and the list all take their look from
// here. Highlights are drawn on top of this (render.ts), not part of it; when things are shown at
// all (layers, zoom, labels) is another matter (render.ts, see docs).
//
// Players: each type has a colour and a prominence. The prominence decides everything else (size,
// opacity, halo, label, draw order), so a type's look changes in one line of PLAYER_TYPES_LOOK.

import type { ValueTier } from "./items";
import type { LootKind } from "./protocol";
import type { PlayerType } from "./roles";
import { ui } from "./theme";

export const COLORS = {
  background: ui.bg,
  /** The grid shown where there is no map. */
  grid: "#1f2a33",
  local: ui.accent,
  dead: "#6b6b6b",
  label: "#e8eef2",
  labelHalo: "rgba(8, 12, 16, 0.85)",
  /** Points picked with the coordinate tool (map debugging). */
  debug: "#ff4fd8",
  exfilOpen: ui.accent,
  exfilClosed: ui.danger,
  exfilPending: ui.warn,
  exfilNeutral: "#e8eef2",
  exfilSecret: ui.secret,
  danger: "#ff3b30",
  vehicle: "#f2c14e",
};

// ---- Players ----

/**
 * How much a player stands out, least to most:
 * - minor: many, rarely what matters (plain AI scavs, infected): smaller, fainter, dimmed in the list.
 * - normal: PMCs, player scavs, anything unclassified.
 * - special: worth calling out (guards, raiders, rogues, cultists, BD): a halo, their name in colour.
 * - boss: like special, bigger and bolder.
 * - self: the local player.
 */
export type Prominence = "minor" | "normal" | "special" | "boss" | "self";

export const PLAYER_TYPES_LOOK: Record<PlayerType, { color: string; prominence: Prominence }> = {
  self: { color: ui.accent, prominence: "self" },
  usec: { color: ui.link, prominence: "normal" },
  bear: { color: ui.danger, prominence: "normal" },
  "p-scav": { color: ui.gold, prominence: "normal" },
  "ai-scav": { color: ui.gold, prominence: "minor" },
  boss: { color: "#ff4fd8", prominence: "boss" },
  follower: { color: ui.warn, prominence: "special" },
  raider: { color: "#4de1ff", prominence: "special" },
  rogue: { color: "#38e8c0", prominence: "special" },
  cultist: { color: "#b26bff", prominence: "special" },
  bd: { color: "#ff7a1a", prominence: "special" },
  zombie: { color: "#9bd14b", prominence: "minor" },
  other: { color: "#c0c0c0", prominence: "normal" },
};

export interface PlayerLook {
  color: string;
  prominence: Prominence;
  /** Marker radius (px). */
  radius: number;
  /** Facing line length (px): from the marker's centre; for figures, beyond the head. */
  facing: number;
  facingFromHead: number;
  /** 0..1 */
  alpha: number;
  /** A ring around the marker (or the figure's head). */
  halo: { gap: number; width: number } | null;
  /** The type's name goes in the label, not just the id. */
  namedLabel: boolean;
  labelColor: string;
  labelFont: string;
  /** Draw order: higher on top. */
  order: number;
  /** Trails: the most opaque part (0..1). */
  trailAlpha: number;
  /** List: dimmed row. */
  dim: boolean;
}

const PROMINENCE: Record<Prominence, Omit<PlayerLook, "color" | "prominence" | "labelColor"> & { coloredLabel?: boolean }> = {
  minor: { radius: 4, facing: 11, facingFromHead: 9, alpha: 0.55, halo: null, namedLabel: false, labelFont: "10px sans-serif", order: 0, trailAlpha: 0.35, dim: true },
  normal: { radius: 5.5, facing: 18, facingFromHead: 14, alpha: 1, halo: null, namedLabel: false, labelFont: "11px sans-serif", order: 2, trailAlpha: 0.6, dim: false },
  special: { radius: 5.5, facing: 18, facingFromHead: 14, alpha: 1, halo: { gap: 3, width: 1.5 }, namedLabel: true, coloredLabel: true, labelFont: "11px sans-serif", order: 3, trailAlpha: 0.6, dim: false },
  boss: { radius: 7, facing: 18, facingFromHead: 14, alpha: 1, halo: { gap: 4, width: 2 }, namedLabel: true, coloredLabel: true, labelFont: "bold 12px sans-serif", order: 3, trailAlpha: 0.6, dim: false },
  self: { radius: 7, facing: 28, facingFromHead: 22, alpha: 1, halo: null, namedLabel: false, labelFont: "11px sans-serif", order: 4, trailAlpha: 0.6, dim: false },
};

/** A player's look by type and state: the dead are grey (and drawn low), those who left faded. */
export function playerLook(type: PlayerType, state: { dead?: boolean; absent?: boolean } = {}): PlayerLook {
  const { color, prominence } = PLAYER_TYPES_LOOK[type];
  const { coloredLabel, ...base } = PROMINENCE[prominence];
  const dead = !!state.dead;
  return {
    ...base,
    prominence,
    color: dead ? COLORS.dead : color,
    labelColor: coloredLabel && !dead ? color : COLORS.label,
    order: dead && prominence !== "self" ? 1 : base.order,
    alpha: base.alpha * (state.absent ? 0.35 : 1),
  };
}

// ---- Loot ----

/** Loose items by value tier: colour and side length (px). Unpriced items count as low. */
export const ITEM_LOOK: Record<ValueTier, { color: string; size: number }> = {
  low: { color: "#8b969f", size: 3 },
  mid: { color: "#e8eef2", size: 4 },
  high: { color: ui.gold, size: 5 },
};

/** Everything else on the loot layers, by kind: colour and size (px; shapes in render.ts). */
export const LOOT_LOOK: Record<Exclude<LootKind, "item">, { color: string; size: number }> = {
  quest: { color: ui.quest, size: 5 },
  container: { color: "#b08a5a", size: 3 },
  airdrop: { color: "#4de1ff", size: 5 },
  corpse: { color: "#9a9a9a", size: 3 },
};

// ---- Exfils ----

export function exfilColor(kind: "regular" | "secret", tone: "open" | "closed" | "pending" | "neutral"): string {
  if (kind === "secret") return COLORS.exfilSecret;
  return { open: COLORS.exfilOpen, closed: COLORS.exfilClosed, pending: COLORS.exfilPending, neutral: COLORS.exfilNeutral }[tone];
}
