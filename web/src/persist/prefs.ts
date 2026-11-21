// The UI's stored settings (persist/): how the map is shown, trails, loot, the timeline's filters, the
// overlay, the side panel. The list's are in list/useListRows.ts, the rules' in rules/store.ts.
//
// Version 1 of each is what was stored before there were versions, as it was; migrations[0] makes
// the few changes older builds needed.

import { DEFAULT_EVENT_GROUPS, type EventGroup } from "../stream/events";
import { DEFAULT_MAP_SETTINGS, type MapSettings, type MapStyle, type PlanPalette } from "../map3d/settings";
import { DEFAULT_OVERLAY_PREFS, type OverlayPrefs } from "../overlay/marks";
import { defineStore, flatNormalize, isHexColor, isObject, oneOf, usePersisted } from "./";


/** How the 3D map is shown, and the map debugging tools. */
export interface MapPrefs extends MapSettings {
  /** The palette the user made (the last one they edited), kept while a pre-made one is in use. */
  customPalette: PlanPalette | null;
  /** Clicking the 3D map (not a marker) records the world position under the cursor. */
  coordinatePick: boolean;
  /** Up close, players are drawn as figures from their skeleton (3D map). */
  bodies: boolean;
}

const MAP_STYLES: readonly MapStyle[] = ["realistic", "plan"];
const MAP_CONTROLS: readonly MapSettings["controls"][] = ["map", "wasd"];

const mapDefaults = (): MapPrefs => ({ ...DEFAULT_MAP_SETTINGS, customPalette: null, coordinatePick: false, bodies: true });
/** Palettes stored before a colour was added get the default's, and so does any colour that isn't "#rrggbb". */
function fullPalette(p: unknown): PlanPalette {
  const out = { ...DEFAULT_MAP_SETTINGS.palette };
  if (isObject(p)) for (const k of Object.keys(out) as (keyof PlanPalette)[]) if (isHexColor(p[k])) out[k] = p[k];
  return out;
}

export const mapStore = defineStore<MapPrefs>({
  key: "radar.map",
  version: 1,
  scope: "user",
  defaults: mapDefaults,
  normalize: (data) => {
    const p = flatNormalize(mapDefaults)(data);
    return {
      ...p,
      style: oneOf(p.style, MAP_STYLES, DEFAULT_MAP_SETTINGS.style),
      controls: oneOf(p.controls, MAP_CONTROLS, DEFAULT_MAP_SETTINGS.controls),
      palette: fullPalette(p.palette),
      customPalette: p.customPalette && fullPalette(p.customPalette),
    };
  },
});

export const useMapPrefs = () => usePersisted(mapStore);

export interface TrailPrefs {
  /** The selected player's trail (whole raid). */
  selected: boolean;
  /** Everyone's trails. */
  all: boolean;
  /** Length of everyone's trails (minutes); null: the whole raid. */
  minutes: number | null;
}

const trailDefaults = (): TrailPrefs => ({ selected: true, all: false, minutes: 5 });

export const trailStore = defineStore<TrailPrefs>({
  key: "radar.trails",
  version: 1,
  scope: "user",
  defaults: trailDefaults,
  normalize: flatNormalize(trailDefaults),
});

export const useTrailPrefs = () => usePersisted(trailStore);

export interface LootPrefs {
  /** Quest items: only those a quest in progress still needs, or all of them. */
  questItems: "needed" | "all";
}

const lootDefaults = (): LootPrefs => ({ questItems: "needed" });

export const lootStore = defineStore<LootPrefs>({
  key: "radar.loot",
  version: 1,
  scope: "user",
  defaults: lootDefaults,
  // (v0 also held the loot density and label threshold of older builds, now rules: dropped.)
  normalize: (data) => {
    const p = flatNormalize(lootDefaults)(data);
    return p.questItems === "all" ? p : { questItems: "needed" };
  },
});

export const useLootPrefs = () => usePersisted(lootStore);

/** The timeline's filters. */
export interface LogPrefs {
  groups: Record<EventGroup, boolean>;
  selectedOnly: boolean;
}

const logDefaults = (): LogPrefs => ({ groups: { ...DEFAULT_EVENT_GROUPS }, selectedOnly: false });

export const logStore = defineStore<LogPrefs>({
  key: "radar.log",
  version: 1,
  scope: "user",
  defaults: logDefaults,
  normalize: (data) => {
    const p = flatNormalize(logDefaults)(data);
    const groups = { ...DEFAULT_EVENT_GROUPS };
    for (const g of Object.keys(groups) as EventGroup[]) if (typeof p.groups[g] === "boolean") groups[g] = p.groups[g];
    return { ...p, groups };
  },
});

export const useLogPrefs = () => usePersisted(logStore);

/** The overlay's (Settings → Overlay): this machine's, like the overlay. */
export const overlayStore = defineStore<OverlayPrefs>({
  key: "radar.overlay",
  version: 1,
  scope: "device",
  defaults: () => ({ ...DEFAULT_OVERLAY_PREFS }),
  normalize: flatNormalize(() => ({ ...DEFAULT_OVERLAY_PREFS })),
});

export const useOverlayPrefs = () => usePersisted(overlayStore);

export const SECTIONS = ["list", "filters", "map", "raids", "settings"] as const;
export type Section = (typeof SECTIONS)[number];

/** The side panel: open or collapsed, and which section it shows (for "list", the list tab in the
 *  list's prefs). The Raids section has two levels: the list of raids, and the shown raid's timeline. */
export interface SidebarPrefs {
  open: boolean;
  section: Section;
  raidsLevel: "list" | "timeline";
}

/** Sections of version 1 that are now elsewhere. */
const SECTION_RENAMES: Record<string, Section> = { map: "filters", debug: "settings" };

const sidebarDefaults = (): SidebarPrefs => ({ open: false, section: "list", raidsLevel: "list" });

export const sidebarStore = defineStore<SidebarPrefs>({
  key: "radar.sidebar",
  version: 2,
  scope: "device",
  defaults: sidebarDefaults,
  migrations: {
    // The timeline was a section of its own: now inside Raids.
    0: (d) => (isObject(d) && d.section === "timeline" ? { ...d, section: "raids", raidsLevel: "timeline" } : d),
    // "map" was the display rules, now "filters"; "map" is the map's settings (from Settings) and trails.
    // Debug is part of Settings now.
    1: (d) => (isObject(d) && typeof d.section === "string" ? { ...d, section: SECTION_RENAMES[d.section] ?? d.section } : d),
  },
  normalize: (data) => {
    const p = flatNormalize(sidebarDefaults)(data);
    return {
      open: p.open,
      section: oneOf(p.section, SECTIONS, "list"),
      raidsLevel: oneOf(p.raidsLevel, ["list", "timeline"], "list"),
    };
  },
});

export const useSidebarPrefs = () => usePersisted(sidebarStore);

/** The side panel's width (px): its default, and the range a stored width is kept to (the narrowest
 *  the sash allows; the widest is generous, the sash itself leaves room for the map). */
export const DEFAULT_SIDEBAR_WIDTH = 420;
export const MIN_SIDEBAR_WIDTH = 260;
export const MAX_SIDEBAR_WIDTH = 2000;

const sidebarSizeDefaults = () => ({ width: DEFAULT_SIDEBAR_WIDTH });

export const sidebarSizeStore = defineStore<{ width: number }>({
  key: "radar.sidebarSize",
  version: 1,
  scope: "device",
  defaults: sidebarSizeDefaults,
  normalize: (data) => {
    const { width } = flatNormalize(sidebarSizeDefaults)(data);
    return { width: Number.isFinite(width) ? Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, width)) : DEFAULT_SIDEBAR_WIDTH };
  },
});

export const useSidebarSize = () => usePersisted(sidebarSizeStore);
