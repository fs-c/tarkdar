// The UI's stored settings (persist/): how the map is shown, trails, loot, the timeline's filters, the
// overlay, the side panel. The list's are in list/useListRows.ts, the rules' in rules/store.ts.
//
// Version 1 of each is what was stored before there were versions, as it was; migrations[0] makes
// the few changes older builds needed.

import { DEFAULT_EVENT_GROUPS, type EventGroup } from "./events";
import { DEFAULT_MAP_SETTINGS, type MapSettings, type PlanPalette } from "./map3d/settings";
import { DEFAULT_OVERLAY_PREFS, type OverlayPrefs } from "./overlay/marks";
import { defineStore, flatNormalize } from "./persist";
import { usePersisted } from "./persist/react";

const same = (d: unknown) => d;
const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** How the 3D map is shown, and the map debugging tools. */
export interface MapPrefs extends MapSettings {
  /** The palette the user made (the last one they edited), kept while a pre-made one is in use. */
  customPalette: PlanPalette | null;
  /** Clicking the 3D map (not a marker) records the world position under the cursor. */
  coordinatePick: boolean;
  /** Up close, players are drawn as figures from their skeleton (3D map). */
  bodies: boolean;
}

const mapDefaults = (): MapPrefs => ({ ...DEFAULT_MAP_SETTINGS, customPalette: null, coordinatePick: false, bodies: true });
/** Palettes stored before a colour was added get the default's. */
const fullPalette = (p: unknown): PlanPalette => ({ ...DEFAULT_MAP_SETTINGS.palette, ...(isObject(p) ? p : {}) });

export const mapStore = defineStore<MapPrefs>({
  key: "radar.map",
  version: 1,
  scope: "user",
  defaults: mapDefaults,
  migrations: { 0: same },
  normalize: (data) => {
    const p = flatNormalize(mapDefaults)(data);
    return { ...p, palette: fullPalette(p.palette), customPalette: p.customPalette && fullPalette(p.customPalette) };
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
  migrations: { 0: same },
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
  migrations: { 0: same },
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
  migrations: { 0: same },
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
  migrations: { 0: same },
  normalize: flatNormalize(() => ({ ...DEFAULT_OVERLAY_PREFS })),
});

export const useOverlayPrefs = () => usePersisted(overlayStore);

export const SECTIONS = ["list", "map", "raids", "debug", "settings"] as const;
export type Section = (typeof SECTIONS)[number];

/** The side panel: open or collapsed, and which section it shows (for "list", the list tab in the
 *  list's prefs). The Raids section has two levels: the list of raids, and the shown raid's timeline. */
export interface SidebarPrefs {
  open: boolean;
  section: Section;
  raidsLevel: "list" | "timeline";
}

const sidebarDefaults = (): SidebarPrefs => ({ open: false, section: "list", raidsLevel: "list" });

export const sidebarStore = defineStore<SidebarPrefs>({
  key: "radar.sidebar",
  version: 1,
  scope: "device",
  defaults: sidebarDefaults,
  // The timeline was a section of its own: now inside Raids.
  migrations: { 0: (d) => (isObject(d) && d.section === "timeline" ? { ...d, section: "raids", raidsLevel: "timeline" } : d) },
  normalize: (data) => {
    const p = flatNormalize(sidebarDefaults)(data);
    return {
      open: p.open,
      section: SECTIONS.includes(p.section) ? p.section : "list",
      raidsLevel: p.raidsLevel === "timeline" ? "timeline" : "list",
    };
  },
});

export const useSidebarPrefs = () => usePersisted(sidebarStore);

/** The side panel's width (px). */
export const DEFAULT_SIDEBAR_WIDTH = 420;

const sidebarSizeDefaults = () => ({ width: DEFAULT_SIDEBAR_WIDTH });

export const sidebarSizeStore = defineStore<{ width: number }>({
  key: "radar.sidebarSize",
  version: 1,
  scope: "device",
  defaults: sidebarSizeDefaults,
  migrations: { 0: same },
  normalize: flatNormalize(sidebarSizeDefaults),
});

export const useSidebarSize = () => usePersisted(sidebarSizeStore);
