// How things look: what an emphasis (rules/rules.ts) means for each kind of thing, and the colours that
// aren't rules (state, the local player, labels). Which thing gets which colour and emphasis, and when
// it shows at all, is decided by the display rules (rules/defaults.ts for the built-in ones). The
// map's markers (with their figures), trails and the list all take their look from here. For players
// the emphasis decides everything else (size, opacity, halo, label, draw order).

import type { Emphasis } from "../rules/rules";
import { getTheme } from "../theme/current";
import type { CanvasFont } from "../theme/font";

/** Colours of what isn't a rule. The text ones follow the theme (read when drawn); marker states
 *  (the local player, exfil states, the dead, ...) are the same in every theme, like the rules' colours. */
export const COLORS = {
  local: "#4cd964",
  dead: "#6b6b6b",
  /** Points picked with the coordinate tool (map debugging). */
  debug: "#ff4fd8",
  exfilOpen: "#4cd964",
  exfilClosed: "#ff5a52",
  exfilPending: "#ff9f40",
  exfilNeutral: "#e8eef2",
  exfilSecret: "#e45cff",
  /** Explosives (not the same red as the UI's danger). */
  danger: "#ff3b30",
  vehicle: "#f2c14e",
  get label() {
    return getTheme().canvas.label;
  },
  get labelHalo() {
    return getTheme().canvas.labelHalo;
  },
};

// ---- Players ----

/**
 * How much a player stands out (rules/rules.ts Emphasis), plus the local player, "self":
 * - faint: many, rarely what matters (plain AI scavs, infected): smaller, fainter, dimmed in the list.
 * - normal: PMCs, player scavs, anything unclassified.
 * - strong: worth calling out (guards, raiders, rogues, cultists, BD): a halo, their name in colour.
 * - loud: like strong, bigger and bolder (bosses).
 * Which player gets which (and its colour) is a rule (rules/defaults.ts).
 */
export type Prominence = Emphasis | "self";

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
  labelFont: CanvasFont;
  /** Draw order: higher on top. */
  order: number;
  /** Trails: the most opaque part (0..1). */
  trailAlpha: number;
  /** List: dimmed row. */
  dim: boolean;
}

const PROMINENCE: Record<Prominence, Omit<PlayerLook, "color" | "prominence" | "labelColor"> & { coloredLabel?: boolean }> = {
  faint: { radius: 4, facing: 11, facingFromHead: 9, alpha: 0.55, halo: null, namedLabel: false, labelFont: { size: 10 }, order: 0, trailAlpha: 0.35, dim: true },
  normal: { radius: 5.5, facing: 18, facingFromHead: 14, alpha: 1, halo: null, namedLabel: false, labelFont: { size: 11 }, order: 2, trailAlpha: 0.6, dim: false },
  strong: { radius: 5.5, facing: 18, facingFromHead: 14, alpha: 1, halo: { gap: 3, width: 1.5 }, namedLabel: true, coloredLabel: true, labelFont: { size: 11 }, order: 3, trailAlpha: 0.6, dim: false },
  loud: { radius: 7, facing: 18, facingFromHead: 14, alpha: 1, halo: { gap: 4, width: 2 }, namedLabel: true, coloredLabel: true, labelFont: { size: 12, bold: true }, order: 3, trailAlpha: 0.6, dim: false },
  self: { radius: 7, facing: 28, facingFromHead: 22, alpha: 1, halo: null, namedLabel: false, labelFont: { size: 11 }, order: 4, trailAlpha: 0.6, dim: false },
};

/** A player's look by prominence, colour and state: the dead are grey (and drawn low), those who left
 *  faded. The local player is always "self", in COLORS.local. */
export function playerLook(prominence: Prominence, color: string, state: { dead?: boolean; absent?: boolean } = {}): PlayerLook {
  const { coloredLabel, ...base } = PROMINENCE[prominence];
  const dead = !!state.dead;
  const own = prominence === "self" ? COLORS.local : color;
  return {
    ...base,
    prominence,
    color: dead ? COLORS.dead : own,
    labelColor: coloredLabel && !dead ? own : COLORS.label,
    order: dead && prominence !== "self" ? 1 : base.order,
    alpha: base.alpha * (state.absent ? 0.35 : 1),
  };
}

// ---- Loot and explosives ----

/** Marker sizes (px) at normal emphasis; other emphases scale them (EMPHASIS_SCALE). Loose items: the
 *  side of the square; the rest: half the marker's width (shapes in render.ts). */
export const MARKER_SIZE = { item: 4, quest: 5, container: 3, airdrop: 5, corpse: 3 } as const;

export const EMPHASIS_SCALE: Record<Emphasis, number> = { faint: 0.75, normal: 1, strong: 1.25, loud: 1.5 };

/** Things the rules give no colour. */
export const DEFAULT_COLOR = "#c0c0c0";

// ---- Exfils ----

export function exfilColor(kind: "regular" | "secret", tone: "open" | "closed" | "pending" | "neutral"): string {
  if (kind === "secret") return COLORS.exfilSecret;
  return { open: COLORS.exfilOpen, closed: COLORS.exfilClosed, pending: COLORS.exfilPending, neutral: COLORS.exfilNeutral }[tone];
}
