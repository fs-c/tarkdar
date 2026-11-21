import type { ComponentProps } from "react";
import { questDebugReport } from "../model/quests.debug";
import type { MapEntry } from "../model/maps";
import type { MapView } from "../map3d/Map3D";
import type { SidebarPrefs } from "../persist/prefs";
import type { RadarState } from "../stream/connection";
import type { ItemCatalog } from "../model/items";
import type { Selection } from "../draw/pick";
import type { Playback } from "../stream/playback";
import type { Timeline, TimelineEvent } from "../stream/timeline";
import type { LootEntry } from "../model/protocol";
import type { useConnection } from "../stream/useConnection";
import { FiltersPanel } from "./FiltersPanel";
import { ListPanel } from "./ListPanel";
import { MapPanel } from "./MapPanel";
import { QuestsPanel } from "./QuestsPanel";
import { RaidsPanel } from "./RaidsPanel";
import { SettingsPanel } from "./SettingsPanel";
import { TimelinePanel } from "./TimelinePanel";
import type { Review } from "./useReplay";

type ListProps = ComponentProps<typeof ListPanel>;
type FiltersProps = ComponentProps<typeof FiltersPanel>;
type MapProps = ComponentProps<typeof MapPanel>;
type SettingsProps = ComponentProps<typeof SettingsPanel>;
type RaidsProps = ComponentProps<typeof RaidsPanel>;
type QuestsProps = ComponentProps<typeof QuestsPanel>;

interface Props {
  section: SidebarPrefs["section"];
  raidsLevel: SidebarPrefs["raidsLevel"];
  /** What the panels show: the raid (live or replayed) with quest items filtered. */
  state: RadarState;
  catalog: ItemCatalog;
  selection: Selection | null;
  // List
  list: ListProps["list"];
  listPrefs: ListProps["prefs"];
  setListPrefs: ListProps["setPrefs"];
  styles: ListProps["styles"];
  focusListSearch: ListProps["focusRef"];
  onActivate: ListProps["onActivate"];
  onHover: ListProps["onHover"];
  // Quests
  questPrefs: QuestsProps["prefs"];
  setQuestPrefs: QuestsProps["onPrefs"];
  questNeeds: QuestsProps["needs"];
  owned: QuestsProps["owned"];
  // Filters
  ruleStore: FiltersProps["rules"];
  setRuleStore: FiltersProps["setRules"];
  pinned: FiltersProps["pinned"];
  setPinned: FiltersProps["setPinned"];
  matched: FiltersProps["matched"];
  onHoverRule: FiltersProps["onHoverRule"];
  lootPrefs: FiltersProps["loot"];
  setLootPrefs: FiltersProps["onLoot"];
  questInfo: string;
  syntaxHelp: boolean;
  setSyntaxHelp: FiltersProps["onHelp"];
  // Map
  mapPrefs: MapProps["prefs"];
  setMapPrefs: MapProps["onPrefs"];
  trailPrefs: MapProps["trails"];
  setTrailPrefs: MapProps["onTrails"];
  // Raids
  conn: { live: boolean; overlay: boolean };
  live: ReturnType<typeof useConnection>["live"];
  review: Review | null;
  timeline: Timeline | null;
  range: [number, number] | null;
  playback: Playback;
  locationId: string | null;
  mapName: RaidsProps["mapName"];
  loadingRecording: string | null;
  recordingError: string | null;
  openRecording: RaidsProps["onOpen"];
  openCurrent: () => void;
  onBackToList: () => void;
  onPickEvent: (e: TimelineEvent) => void;
  // Settings
  overlayPrefs: SettingsProps["overlay"]["prefs"];
  setOverlayPrefs: SettingsProps["overlay"]["onPrefs"];
  overlayMarks: number | null;
  map: MapEntry | null;
  mapStats: string | null;
  mapView: MapView | null;
  pickOutput: () => string;
  onClearPicks: () => void;
  /** The state before quest filtering and merging copies, and the merged loot (the quest report). */
  unfilteredState: RadarState;
  dedupedLoot: LootEntry[];
  filterQuest: boolean;
}

/** The side panel's body: the view the activity bar picked, with its props built from the app's state. */
export function SidePanelContent(p: Props) {
  switch (p.section) {
    case "list":
      return (
        <ListPanel
          state={p.state}
          list={p.list}
          prefs={p.listPrefs}
          setPrefs={p.setListPrefs}
          selection={p.selection}
          onActivate={p.onActivate}
          onHover={p.onHover}
          styles={p.styles}
          focusRef={p.focusListSearch}
        />
      );
    case "quests":
      return (
        <QuestsPanel
          quests={p.unfilteredState.quests}
          catalog={p.catalog}
          prefs={p.questPrefs}
          onPrefs={p.setQuestPrefs}
          questInfo={p.questInfo}
          needs={p.questNeeds}
          owned={p.owned}
        />
      );
    case "filters":
      return (
        <FiltersPanel
          rules={p.ruleStore}
          setRules={p.setRuleStore}
          pinned={p.pinned}
          setPinned={p.setPinned}
          matched={p.matched}
          catalog={p.catalog}
          onHoverRule={p.onHoverRule}
          loot={p.lootPrefs}
          onLoot={p.setLootPrefs}
          questInfo={p.questInfo}
          help={p.syntaxHelp}
          onHelp={p.setSyntaxHelp}
        />
      );
    case "map":
      return <MapPanel prefs={p.mapPrefs} onPrefs={p.setMapPrefs} trails={p.trailPrefs} onTrails={p.setTrailPrefs} />;
    case "raids": {
      const { review, live, conn } = p;
      return p.raidsLevel === "timeline" ? (
        <TimelinePanel
          timeline={p.timeline}
          range={p.range}
          live={!review}
          title={review ? p.mapName(review.info.locationId) : "Current raid"}
          subtitle={review ? (review.info.start ? new Date(review.info.start).toLocaleString() : review.info.name) : p.mapName(p.locationId)}
          onBack={p.onBackToList}
          loading={!review && live.backfilling}
          playback={p.playback}
          catalog={p.catalog}
          selection={p.selection}
          onPick={p.onPickEvent}
        />
      ) : (
        <RaidsPanel
          current={{
            available: conn.live,
            inRaid: !!live.timeline,
            mapName: live.timeline ? p.mapName(live.timeline.locationId) : null,
            elapsed: live.timeline && !Number.isNaN(live.timeline.start) ? live.timeline.end - live.timeline.range()[0] : null,
          }}
          viewing={review?.info.name ?? null}
          loading={p.loadingRecording}
          error={p.recordingError}
          mapName={p.mapName}
          onOpen={p.openRecording}
          onCurrent={p.openCurrent}
        />
      );
    }
    case "settings": {
      const { map } = p;
      return (
        <SettingsPanel
          overlay={{ available: p.conn.overlay, prefs: p.overlayPrefs, onPrefs: p.setOverlayPrefs, marks: p.overlayMarks }}
          debug={{
            prefs: p.mapPrefs,
            onPrefs: p.setMapPrefs,
            mapShown: !!map,
            stats: map ? p.mapStats : null,
            mapInfo: map && { folder: map.folder, name: map.config.name, locationId: p.locationId, up: map.config.up ?? 0 },
            view: map ? p.mapView : null,
            pickOutput: p.pickOutput(),
            onClearPicks: p.onClearPicks,
            quests: questDebugReport({
              quests: p.unfilteredState.quests,
              loot: p.dedupedLoot,
              filterOn: p.filterQuest,
              itemName: (tpl) => p.catalog.lookup(tpl)?.name,
            }),
            duplicates: p.unfilteredState.loot.length - p.dedupedLoot.length,
          }}
        />
      );
    }
  }
}
