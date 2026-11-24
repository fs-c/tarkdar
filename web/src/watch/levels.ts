// Importance: one axis, four steps, for everything the map shows. It replaces the rules' separate
// knobs (emphasis, shown from, label, ring, order): a level is a preset of them (rules/rules.ts Style).
// When several things apply to one thing, the highest level wins, colour and all (watch/rules.ts
// orders the rules by level for that).

import type { Emphasis, StyleProps } from "../rules/rules";
import { SHOW_LEVELS } from "../rules/defaults";

export type Level = "low" | "normal" | "high" | "top";
export const LEVELS: readonly Level[] = ["low", "normal", "high", "top"];

export const LEVEL_TEXT: Record<Level, string> = { low: "Low", normal: "Normal", high: "High", top: "Top" };

/** What a level looks like on the map: the level picker's tooltips. */
export const LEVEL_HINT: Record<Level, string> = {
  low: "only zoomed in, no label",
  normal: "from mid zoom on, labelled where there's room",
  high: "at every zoom, labelled where there's room",
  top: "at every zoom, always labelled, ringed",
};

export const levelRank = (l: Level): number => LEVELS.indexOf(l);

/** Players draw a level by emphasis (draw/style.ts: size, halo, label). */
export const EMPHASIS: Record<Level, Emphasis> = { low: "faint", normal: "normal", high: "strong", top: "loud" };

/** Loot, containers, corpses: shown from, labelled, ringed at Top (in its colour). */
export function thingStyle(level: Level, color: string | undefined): StyleProps {
  switch (level) {
    case "low":
      return { color, emphasis: "faint", show: SHOW_LEVELS.close, label: "never" };
    case "normal":
      return { color, emphasis: "normal", show: SHOW_LEVELS.mid, label: "room" };
    case "high":
      return { color, emphasis: "strong", show: SHOW_LEVELS.always, label: "room", labelFrom: 0 };
    case "top":
      return { color, emphasis: "loud", show: SHOW_LEVELS.always, label: "always", labelFrom: 0, ring: color };
  }
}

/** Players: their tier's colour and the level's emphasis. */
export const playerStyle = (level: Level, color: string): StyleProps => ({ color, emphasis: EMPHASIS[level] });
