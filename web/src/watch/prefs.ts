// What's kept of the watch model (localStorage): how the tiers and loot look (Settings → Markers),
// the map's layers (the map style's card), the watchlist, and which started quests have been seen
// (the "new quests" nudge). The display rules of before (radar.rules, radar.pinned) aren't carried
// over: the UX rework starts these afresh.

import { defineStore, isHexColor, isObject, oneOf, usePersisted } from "../persist";
import { LEVELS, type Level } from "./levels";
import { TIERS, TIER_ORDER, type Tier } from "./tiers";

// ---- Markers: tiers and loot ----

export interface MarkerPrefs {
  tiers: Record<Tier, { level: Level; color: string }>;
  /** Loose items from this value per slot (roubles) are valuable: High, and the "Valuable" layer. */
  valuable: number;
  /** ... from this, ordinary: Normal; cheaper ones Low (the "All" layer). */
  ordinary: number;
}

export const VALUABLE_CHOICES = [25_000, 50_000, 100_000] as const;
export const ORDINARY_CHOICES = [10_000, 15_000, 25_000] as const;

const markerDefaults = (): MarkerPrefs => ({
  tiers: Object.fromEntries(TIER_ORDER.map((t) => [t, { level: TIERS[t].level, color: TIERS[t].color }])) as MarkerPrefs["tiers"],
  valuable: 50_000,
  ordinary: 15_000,
});

const positive = (v: unknown, fallback: number) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : fallback);

export const markerStore = defineStore<MarkerPrefs>({
  key: "radar.markers",
  version: 1,
  scope: "user",
  defaults: markerDefaults,
  normalize: (data) => {
    const d = isObject(data) ? data : {};
    const def = markerDefaults();
    const stored = isObject(d.tiers) ? d.tiers : {};
    const tiers = Object.fromEntries(
      TIER_ORDER.map((t) => {
        const s = isObject(stored[t]) ? stored[t] : {};
        return [t, { level: oneOf(s.level, LEVELS, def.tiers[t].level), color: isHexColor(s.color) ? s.color : def.tiers[t].color }];
      }),
    ) as MarkerPrefs["tiers"];
    return { tiers, valuable: positive(d.valuable, def.valuable), ordinary: positive(d.ordinary, def.ordinary) };
  },
});

export const useMarkerPrefs = () => usePersisted(markerStore);

// ---- Layers: what the map shows on its own ----

export interface LayerPrefs {
  loot: "off" | "valuable" | "all";
  /** Items quests need: only tracked quests' (they're watch entries), or every started quest's. */
  quest: "tracked" | "started";
  corpses: boolean;
  containers: boolean;
  exfils: boolean;
  explosives: boolean;
}

const LOOT_LAYERS: readonly LayerPrefs["loot"][] = ["off", "valuable", "all"];
const QUEST_LAYERS: readonly LayerPrefs["quest"][] = ["tracked", "started"];

const layerDefaults = (): LayerPrefs => ({ loot: "valuable", quest: "tracked", corpses: true, containers: false, exfils: true, explosives: true });

export const layerStore = defineStore<LayerPrefs>({
  key: "radar.layers",
  version: 1,
  scope: "user",
  defaults: layerDefaults,
  normalize: (data) => {
    const d = isObject(data) ? data : {};
    const def = layerDefaults();
    const bool = (k: "corpses" | "containers" | "exfils" | "explosives") => (typeof d[k] === "boolean" ? (d[k] as boolean) : def[k]);
    return {
      loot: oneOf(d.loot, LOOT_LAYERS, def.loot),
      quest: oneOf(d.quest, QUEST_LAYERS, def.quest),
      corpses: bool("corpses"),
      containers: bool("containers"),
      exfils: bool("exfils"),
      explosives: bool("explosives"),
    };
  },
});

export const useLayerPrefs = () => usePersisted(layerStore);

// ---- The watchlist ----

export interface WatchEntry {
  id: string;
  /** "LEDX", "Info items", "Shortage" */
  label: string;
  /** What it matches (highlight/query.ts). */
  query: string;
  color: string;
  level: Level;
  on: boolean;
  /** A tracked quest: its id (the query is `quest:"<name>"`). */
  questId?: string;
}

export interface WatchPrefs {
  /** In the order they were added. */
  entries: WatchEntry[];
}

export const WATCH_COLORS = ["#ff8a3d", "#5ce1e6", "#c084fc", "#a3e635", "#f472b6", "#7aa7ff", "#fb7185", "#2dd4bf"];

/** The first colour no entry has yet (then round again). */
export function nextWatchColor(entries: readonly WatchEntry[]): string {
  const used = new Set(entries.map((e) => e.color));
  return WATCH_COLORS.find((c) => !used.has(c)) ?? WATCH_COLORS[entries.length % WATCH_COLORS.length]!;
}

let counter = 0;
export const newWatchId = (): string => `w:${Date.now().toString(36)}${(counter++).toString(36)}`;

export const watchStore = defineStore<WatchPrefs>({
  key: "radar.watch",
  version: 1,
  scope: "user",
  defaults: () => ({ entries: [] }),
  normalize: (data) => {
    const d = isObject(data) ? data : {};
    const ids = new Set<string>();
    const entries = (Array.isArray(d.entries) ? d.entries : []).flatMap((e): WatchEntry[] => {
      if (!isObject(e) || typeof e.id !== "string" || ids.has(e.id) || typeof e.query !== "string" || !e.query.trim()) return [];
      ids.add(e.id);
      const out: WatchEntry = {
        id: e.id,
        label: typeof e.label === "string" && e.label ? e.label : e.query,
        query: e.query,
        color: isHexColor(e.color) ? e.color : WATCH_COLORS[0]!,
        level: oneOf(e.level, LEVELS, "high"),
        on: e.on !== false,
      };
      if (typeof e.questId === "string") out.questId = e.questId;
      return [out];
    });
    return { entries };
  },
});

export const useWatchPrefs = () => usePersisted(watchStore);

// ---- Quests seen: the "new quests" nudge ----

export interface SeenQuests {
  /** Started quests with items to find that were around before: not new. Null: never looked yet
   *  (the first look takes every started quest as seen, so the nudge starts with what's new after). */
  ids: string[] | null;
}

export const seenQuestStore = defineStore<SeenQuests>({
  key: "radar.seenQuests",
  version: 1,
  scope: "user",
  defaults: () => ({ ids: null }),
  normalize: (data) => {
    const d = isObject(data) ? data : {};
    return { ids: Array.isArray(d.ids) ? [...new Set(d.ids.filter((x): x is string => typeof x === "string"))] : null };
  },
});

export const useSeenQuests = () => usePersisted(seenQuestStore);
