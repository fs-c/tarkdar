// Configuring the overlay (the backend's window over the game's picture, radar-backend --overlay): a
// job of its own for the frontend, next to drawing the radar. The overlay knows where things are and
// draws them right as the camera moves; what to mark and how is decided here, from the same rules and
// rows as the map, and sent to the backend for the overlay only (docs/protocol.md, `overlay`).

import type { AnyRow, TabRows } from "../list/rows";
import type { OverlayData, OverlayMark } from "../protocol";
import { BASE, type Style } from "../rules/rules";
import { DEFAULT_COLOR, exfilColor } from "../style";

/** The overlay's settings (Settings → Overlay), kept in this browser. */
export interface OverlayPrefs {
  /** Draw the overlay (configured from this browser). */
  on: boolean;
  /** The picture lags behind the camera by this much (Looking Glass, the compositor): ms. */
  delayMs: number;
  grid: boolean;
  /** Loot further than this isn't marked: m. */
  lootRange: number;
  /** The scope's picture while scoped: a circle of this radius, as a share of the screen's height. */
  scopeRadius: number;
  /** Players the rules don't mark (new since the last update): drawn plain rather than not at all. */
  otherPlayers: boolean;
}

export const DEFAULT_OVERLAY_PREFS: OverlayPrefs = { on: false, delayMs: 0, grid: false, lootRange: 150, scopeRadius: 0.36, otherPlayers: true };

/** Colour for players the marks don't cover. */
export const OTHER_PLAYERS = "#e0e0e0";

const HEX = /^#(?:[0-9a-f]{6}|[0-9a-f]{8})$/i;
const SHORT_HEX = /^#[0-9a-f]{3}$/i;

/** The overlay takes "#rrggbb[aa]": short hex is expanded, anything else falls back to the default. */
export function hexColor(c: string | undefined, fallback = DEFAULT_COLOR): string {
  if (c && HEX.test(c)) return c;
  if (c && SHORT_HEX.test(c)) return `#${[...c.slice(1)].map((d) => d + d).join("")}`;
  return fallback;
}

const styleOf = (styles: ReadonlyMap<string, Style>, row: AnyRow, base: Style) => styles.get(row.key) ?? base;

/**
 * What the overlay marks, from the rows and their styles (rules/useRules.ts):
 * - players the map shows, alive and still in the raid (not the local player), in their colour, named
 *   by their type ("Killa", "USEC");
 * - loot the map shows that stands out: highlighted (a ring), emphasised strong or loud by the rules
 *   (valuable, needed for quests), quest items and airdrops;
 * - exfils the map shows, in their status colour.
 */
export function overlayMarks(rows: TabRows, styles: ReadonlyMap<string, Style>): OverlayMark[] {
  const marks: OverlayMark[] = [];
  for (const r of rows.players) {
    if (r.local || r.state !== "alive" || r.sel.kind !== "player") continue;
    const st = styleOf(styles, r, BASE.player);
    if (st.show === null) continue;
    marks.push({ kind: "player", id: r.sel.id, color: hexColor(st.color), label: r.typeLabel, emphasis: st.emphasis });
  }
  for (const r of [...rows.items, ...rows.containers]) {
    if (r.sel.kind !== "loot") continue;
    const st = styleOf(styles, r, BASE[r.subject]);
    const standsOut = st.ring || st.emphasis === "strong" || st.emphasis === "loud" || r.subject === "quest" || r.subject === "airdrop";
    if (st.show === null || !standsOut) continue;
    const label = "shortName" in r ? r.shortName : r.name;
    marks.push({ kind: "loot", id: r.sel.id, color: hexColor(st.ring ?? st.color), label, emphasis: st.emphasis });
  }
  for (const r of rows.exfils) {
    if (r.sel.kind !== "exfil") continue;
    const st = styleOf(styles, r, BASE.exfil);
    if (st.show === null) continue;
    marks.push({ kind: "exfil", id: r.sel.id, color: hexColor(st.color ?? exfilColor(r.kind, r.tone)), label: r.name, emphasis: st.emphasis });
  }
  return marks;
}

/** The whole `overlay` message's data. Off (and nothing marked) outside a raid. */
export function overlayData(prefs: OverlayPrefs, raid: number | null, marks: OverlayMark[]): OverlayData {
  const on = prefs.on && raid !== null;
  return {
    on,
    raid,
    delayMs: prefs.delayMs,
    grid: prefs.grid,
    lootRange: prefs.lootRange,
    scopeRadius: prefs.scopeRadius,
    otherPlayers: prefs.otherPlayers ? OTHER_PLAYERS : null,
    marks: on ? marks : [],
  };
}
