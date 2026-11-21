import { Suspense, lazy, useLayoutEffect, useMemo, useRef, useState } from "react";
import { type RadarState, wsUrl } from "../stream/connection";
import { useCatalog } from "../model/useCatalog";
import { useMapIndex } from "../model/useMapIndex";
import { useConnection } from "../stream/useConnection";
import { cx, useHotkeys } from "../ui";
import { useLootPrefs, useMapPrefs, useOverlayPrefs, useQuestPrefs, useSidebarPrefs, useTrailPrefs } from "../persist/prefs";
import { overlayData, overlayMarks } from "../overlay/marks";
import { useOverlaySync } from "../overlay/useOverlaySync";
import { findMap, mapUrl } from "../model/maps";
import { type Highlight, allRows } from "../highlight/match";
import { categoryFor } from "../rules/defaults";
import { highlightStyle } from "../rules/rules";
import { hiddenKinds, newRuleId, storedRules, usePinned, useRuleStore } from "../rules/store";
import { highlightId, highlightRules, useRules } from "../rules/useRules";
import { isFiltered, rowKeys } from "../list/rows";
import { withoutGunners } from "../model/vehicles";
import { useListPrefs, useListRows } from "../list/useListRows";
import { type Selection, selectionKey } from "../draw/pick";
import { usePlayback } from "../stream/playback";
import { buildScene, trailScene } from "../draw/scene";
import { DetailsPanel } from "./DetailsPanel";
import { Highlights } from "./Highlights";
import { FollowButton } from "./FollowButton";
import type { RadarHandle } from "./Radar";
import { SidePanelContent } from "./SidePanelContent";
import { StyleSwitch } from "./StyleSwitch";
import { PlaybackBar } from "./PlaybackBar";
import { ActivityBar, SidePanel, type ViewId } from "./Sidebar";
import { formatStart } from "./format";
import s from "./App.module.css";
import f from "./Floating.module.css";
import { StatusBar, StatusButton } from "./StatusBar";
import { useMapDebug } from "./useMapDebug";
import { useOwned } from "./useOwned";
import { useQuestState } from "./useQuestState";
import { useReplay } from "./useReplay";
import { useSelection } from "./useSelection";

// The radar brings the renderer (three.js) with it: loaded after the rest of the page.
const Radar = lazy(() => import("./Radar").then((m) => ({ default: m.Radar })));


export function App() {
  const { state: conn, live, liveVersion, conn: connection } = useConnection(wsUrl());

  // What's shown: the live raid, or a recording opened from the Raids view; either at the cursor.
  // `ui` (the side panel's state) is declared further down; this only runs later, from handlers.
  const replay = useReplay((raidsLevel) => setUi((u) => ({ ...u, raidsLevel })));
  const { review, loadingRecording, recordingError, openRecording } = replay;
  const timeline = review?.timeline ?? live.timeline;
  const range = timeline && !Number.isNaN(timeline.start) ? timeline.range() : null;
  const playback = usePlayback(range, !review, review ? `rec:${review.info.name}` : `live:${timeline?.raid ?? "-"}`);
  // Vehicle gunners (the BTR's) are part of the vehicle, not shown as players anywhere.
  const unfiltered: RadarState = useMemo(() => {
    // No timeline yet: the stream's state.
    if (!timeline || !range) return withoutGunners(conn);
    // Live and at "now": the stream's state as is, but players come from the timeline (it knows who extracted).
    if (!review && playback.cursor === null) return withoutGunners({ ...conn, ...timeline.playersAtTime(range[1]) });
    const at = timeline.stateAt(playback.cursor ?? range[1]);
    return withoutGunners(review ? { ...conn, connected: true, protocolMismatch: false, ...at } : { ...conn, ...at });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the timeline changes in place (liveVersion)
  }, [conn, timeline, review, playback.cursor, liveVersion]);
  /** The shown moment (the newest when live). */
  const at = playback.cursor ?? range?.[1] ?? null;
  const [trailPrefs, setTrailPrefs] = useTrailPrefs();
  const [lootPrefs, setLootPrefs] = useLootPrefs();

  const filterQuest = lootPrefs.questItems !== "all";
  const [questPrefs, setQuestPrefs] = useQuestPrefs();
  const ownedState = useOwned(unfiltered, conn.stash, questPrefs.ignoreOwned);
  const { state, deduped, needs, questLabels, questNeeds, questInfo } = useQuestState(unfiltered, filterQuest, questPrefs, ownedState.owned);

  /** Out of a replay: the Raids view back to its list. */
  const backToLive = () => {
    replay.leave();
    playback.seek(null);
    setUi((u) => ({ ...u, raidsLevel: "list" }));
  };
  /** The live raid, in the Raids view's timeline. */
  const openCurrent = () => {
    if (review) backToLive();
    setUi((u) => ({ ...u, raidsLevel: "timeline" }));
  };

  const { catalog, status: catalogStatus } = useCatalog();
  const mapIndex = useMapIndex();
  const locationId = state.status?.state === "inRaid" ? state.status.locationId : null;
  const mapName = (id: string | null) => (id ? (findMap(mapIndex, id)?.config.name ?? id) : "unknown map");
  // The location's map (maps/3d); without one, a grid of world coordinates.
  const [mapPrefs, setMapPrefs] = useMapPrefs();
  const map = (locationId ? findMap(mapIndex, locationId) : undefined) ?? null;
  const radar = useRef<RadarHandle>(null);
  const [follow, setFollow] = useState(true);
  // While following: the map turns with the local player's view direction.
  const [followHeading, setFollowHeading] = useState(false);
  const heading = follow && followHeading;
  const followRef = useRef(follow);
  followRef.current = follow;
  /** Stops following (and turning with the view direction, which only goes with following). */
  const stopFollowing = () => {
    setFollow(false);
    setFollowHeading(false);
  };
  const [hovered, setHovered] = useState<Selection | null>(null);
  const [listPrefs, setListPrefs] = useListPrefs();
  const list = useListRows(state, catalog, questLabels, questNeeds, listPrefs.filters);
  const focusListSearch = useRef<() => void>(undefined);

  // Highlights (the global search): kept for the session. The search's preview counts as one.
  const [highlights, setHighlights] = useState<Highlight[]>([]);
  const [preview, setPreview] = useState<string | null>(null);
  // The display rules (rules/): the stored ones (as changed in the Filters view), the pinned ones (this
  // raid's); highlights on top; categories switched off hide what isn't ringed.
  const [ruleStore, setRuleStore] = useRuleStore();
  const raidKey = !review && conn.raid !== null && locationId ? `${conn.raid}:${locationId}` : null;
  const [pinned, setPinned] = usePinned(raidKey);
  const stored = useMemo(() => storedRules(ruleStore, pinned), [ruleStore, pinned]);
  const hidden = useMemo(() => hiddenKinds(ruleStore), [ruleStore]);
  const rules = useMemo(() => [...stored, ...highlightRules(highlights, preview)], [stored, highlights, preview]);
  const styled = useRules(list.all, rules, catalog, hidden);
  /** A highlight becomes a pinned rule (on top of the others, for this raid): it looks just the same. */
  const pinHighlight = (h: Highlight) => {
    const kinds = [...new Set((styled.matched.get(highlightId(h.id)) ?? []).map((r) => r.subject))];
    setPinned((ps) => [...ps, { id: newRuleId(), category: categoryFor(kinds), label: h.label, query: h.query, style: highlightStyle(h.color), on: true }]);
    setHighlights((hs) => hs.filter((x) => x.id !== h.id));
  };
  // Hovering a rule in the Filters view marks what it matches.
  const [hoverRule, setHoverRule] = useState<string | null>(null);
  const highlightMatches = useMemo(() => new Map(highlights.map((h) => [h.id, styled.matched.get(highlightId(h.id)) ?? []])), [highlights, styled.matched]);
  const everything = useMemo(() => allRows(list.all), [list.all]);

  // The overlay (radar-backend --overlay): configured from here, from the live raid only (a replay
  // or an earlier moment leaves it as it was).
  const [overlayPrefs, setOverlayPrefs] = useOverlayPrefs();
  const overlayLive = conn.overlay && !review && playback.cursor === null;
  const marksForOverlay = useMemo(() => (overlayLive ? overlayMarks(list.all, styled.styles) : []), [overlayLive, list.all, styled.styles]);
  const overlayRaid = conn.status?.state === "inRaid" ? conn.raid : null;
  const overlayConfig = useMemo(
    () => (overlayLive ? overlayData(overlayPrefs, overlayRaid, marksForOverlay) : null),
    [overlayLive, overlayPrefs, overlayRaid, marksForOverlay],
  );
  useOverlaySync(connection, conn.overlay, conn.connected, overlayConfig);

  // Side panel: open or collapsed, and which section it shows (for "list", the list tab in listPrefs).
  // The Raids view has two levels: the list of raids, and the shown raid's timeline.
  const [ui, setUi] = useSidebarPrefs();
  // The Filters view's query syntax help: open from there, or from the highlight search's link.
  const [syntaxHelp, setSyntaxHelp] = useState(false);
  const view: ViewId = ui.section === "list" ? listPrefs.tab : ui.section;
  const listShown = ui.open && ui.section === "list";
  const togglePanel = () => setUi((u) => ({ ...u, open: !u.open }));
  const uiRef = useRef(ui);
  uiRef.current = ui;
  /** L: opens the list with its search focused; closes it when it's open. */
  const toggleList = () => {
    const u = uiRef.current;
    if (u.open && u.section === "list") return setUi((x) => ({ ...x, open: false }));
    wantListFocus.current = true;
    setUi((x) => ({ ...x, open: true, section: "list" }));
  };
  // In the commit that shows the list (the panel's own layout effects ran first), so keys typed right
  // after L land in the search rather than in the map's shortcuts.
  const wantListFocus = useRef(false);
  useLayoutEffect(() => {
    if (!listShown || !wantListFocus.current) return;
    wantListFocus.current = false;
    focusListSearch.current?.();
  }, [listShown]);
  const pickView = (v: ViewId) => {
    if (ui.open && v === view) return setUi((u) => ({ ...u, open: false }));
    if (v === "quests" || v === "filters" || v === "map" || v === "raids" || v === "settings") return setUi((u) => ({ ...u, open: true, section: v }));
    setListPrefs((p) => ({ ...p, tab: v }));
    setUi((u) => ({ ...u, open: true, section: "list" }));
  };

  // While the list is filtered, the map shows only what the filters let through (and us), panel open or
  // not. Each tab's filters only concern its own kind of thing; highlighted things always show.
  const filtered = isFiltered(listPrefs.filters);
  const shown = useMemo(() => {
    if (!filtered) return state;
    const keys = rowKeys(list.rows);
    const has = (kind: Selection["kind"], id: number) => {
      const key = selectionKey({ kind, id });
      return keys.has(key) || styled.rings.has(key);
    };
    return {
      players: state.players.filter((p) => p.local || has("player", p.id)),
      loot: state.loot.filter((l) => has("loot", l.id)),
      exfils: state.exfils.filter((e) => has("exfil", e.id)),
      explosives: {
        grenades: state.explosives.grenades.filter((g) => has("grenade", g.id)),
        tripwires: state.explosives.tripwires.filter((w) => has("tripwire", w.id)),
      },
    };
  }, [state, filtered, list.rows, styled.rings]);

  const local = state.players.find((p) => p.local && p.pos);

  const centerOn = (pos: [number, number, number] | null) => {
    if (!pos) return;
    stopFollowing();
    radar.current?.centerOn(pos);
  };
  const raid = `${review?.info.name ?? "live"}:${state.status?.state === "inRaid" ? state.raid : null}`;
  const { selection, selectedLook, select, clear: clearSelection, showOnMap, pickEvent } = useSelection({
    raid,
    state,
    everything,
    rules,
    catalog,
    hidden,
    timeline,
    playback,
    centerOn,
  });

  const debug = useMapDebug({ radar, map, shown, styles: styled.styles, coordinatePick: mapPrefs.coordinatePick, select });
  const { debugPicks, onTap, pickOutput, mapStats, mapView, onMapStats } = debug;

  const playbackRef = useRef(playback);
  playbackRef.current = playback;
  const rangeRef = useRef(range);
  rangeRef.current = range;
  // Holding a toggle key toggles once; seeking ([ and ]) repeats. The handlers only read refs
  // (playbackRef, rangeRef, followRef, uiRef via toggleList) and stable setters.
  const seekBy = (direction: 1 | -1) => {
    const pb = playbackRef.current, r = rangeRef.current;
    if (!r) return;
    pb.seek((pb.cursor ?? r[1]) + direction * 10_000 * pb.speed);
  };
  useHotkeys([
    { key: "Escape", description: "Deselect", handler: () => clearSelection() },
    { key: "f", description: "Follow the local player, or stop following", handler: () => (followRef.current ? stopFollowing() : setFollow(true)) },
    {
      key: "l",
      description: "Open the list with its search focused, or close it",
      handler: (e) => {
        e.preventDefault(); // the search it focuses mustn't get the "l"
        toggleList();
      },
    },
    { key: "m", description: "Switch the map between plan and realistic", handler: () => setMapPrefs((p) => ({ ...p, style: p.style === "plan" ? "realistic" : "plan" })) },
    {
      key: " ",
      description: "Play or pause the replay",
      handler: (e) => {
        if (!(e.target === document.body || e.target instanceof HTMLCanvasElement)) return;
        e.preventDefault();
        playbackRef.current.toggle();
      },
    },
    { key: "[", repeat: true, description: "Seek back 10 s (times the speed)", handler: () => seekBy(-1) },
    { key: "]", repeat: true, description: "Seek forward 10 s (times the speed)", handler: () => seekBy(1) },
  ]);

  const scene = buildScene({
    state,
    shown,
    catalog,
    questLabels,
    styles: styled.styles,
    selection,
    hovered,
    listShown,
    debugPoints: map && mapPrefs.coordinatePick ? debugPicks.map((p) => p.pos) : [],
    hoverMatches: hoverRule ? (styled.matched.get(hoverRule) ?? []) : [],
    trails: trailScene({ timeline, at, prefs: trailPrefs, players: shown.players, selection }),
    bodies: mapPrefs.bodies,
  });

  return (
    <>
      <div className={s.workbench}>
        <ActivityBar
          active={ui.open ? view : null}
          onPick={pickView}
          badges={{
            players: list.rows.players.length,
            items: list.rows.items.length,
            containers: list.rows.containers.length,
            exfils: list.rows.exfils.length,
            raids: !!review,
          }}
        />
        {ui.open && (
          <SidePanel view={view} onClose={togglePanel}>
            <SidePanelContent
              section={ui.section}
              raidsLevel={ui.raidsLevel}
              state={state}
              catalog={catalog}
              selection={selection}
              list={list}
              listPrefs={listPrefs}
              setListPrefs={setListPrefs}
              styles={styled.styles}
              focusListSearch={focusListSearch}
              onActivate={showOnMap}
              onHover={setHovered}
              questPrefs={questPrefs}
              setQuestPrefs={setQuestPrefs}
              questNeeds={needs}
              owned={ownedState}
              ruleStore={ruleStore}
              setRuleStore={setRuleStore}
              pinned={pinned}
              setPinned={setPinned}
              matched={styled.matched}
              onHoverRule={setHoverRule}
              lootPrefs={lootPrefs}
              setLootPrefs={setLootPrefs}
              questInfo={questInfo}
              syntaxHelp={syntaxHelp}
              setSyntaxHelp={setSyntaxHelp}
              mapPrefs={mapPrefs}
              setMapPrefs={setMapPrefs}
              trailPrefs={trailPrefs}
              setTrailPrefs={setTrailPrefs}
              conn={conn}
              live={live}
              review={review}
              timeline={timeline}
              range={range}
              playback={playback}
              locationId={locationId}
              mapName={mapName}
              loadingRecording={loadingRecording}
              recordingError={recordingError}
              openRecording={openRecording}
              openCurrent={openCurrent}
              onBackToList={() => setUi((u) => ({ ...u, raidsLevel: "list" }))}
              onPickEvent={pickEvent}
              overlayPrefs={overlayPrefs}
              setOverlayPrefs={setOverlayPrefs}
              overlayMarks={overlayConfig?.marks.length ?? null}
              map={map}
              mapStats={mapStats}
              mapView={mapView}
              pickOutput={pickOutput}
              onClearPicks={debug.clearPicks}
              unfilteredState={unfiltered}
              dedupedLoot={deduped}
              filterQuest={filterQuest}
            />
          </SidePanel>
        )}
        <main className={cx(s.main, f.area)} data-style-switch={!!map} data-details={!!selection}>
          <Suspense fallback={null}>
            <Radar
              ref={radar}
              url={map ? mapUrl(map) : null}
              up={map?.config.up}
              scene={scene}
              settings={mapPrefs}
              follow={follow}
              heading={heading}
              onPan={stopFollowing}
              onTurn={() => setFollowHeading(false)}
              onTap={onTap}
              onStats={ui.open && ui.section === "settings" ? onMapStats : undefined}
            />
          </Suspense>
          {timeline && range && (
            <PlaybackBar
              range={range}
              playback={playback}
              replay={!!review}
              events={timeline.events}
              selection={selection}
              onExitReplay={backToLive}
            />
          )}
          {map && (
            <StyleSwitch
              style={mapPrefs.style}
              palette={mapPrefs.palette}
              custom={mapPrefs.customPalette}
              onChange={(style, palette) => setMapPrefs((p) => ({ ...p, style, palette }))}
            />
          )}
          <FollowButton
            follow={follow}
            heading={heading}
            onClick={() => {
              if (!follow) setFollow(true);
              else setFollowHeading((h) => !h);
            }}
          />
          <Highlights
            highlights={highlights}
            setHighlights={setHighlights}
            matched={highlightMatches}
            rows={everything}
            catalog={catalog}
            local={local?.pos ?? null}
            onPreview={setPreview}
            onPin={pinHighlight}
            onShow={showOnMap}
            onSyntaxHelp={() => {
              setSyntaxHelp(true);
              setUi((u) => ({ ...u, open: true, section: "filters" }));
            }}
          />
          {selection && (
            <DetailsPanel
              selection={selection}
              state={state}
              catalog={catalog}
              questNeeds={questNeeds}
              look={selectedLook}
              history={timeline && range && at !== null ? { timeline, at, start: range[0], onPick: pickEvent } : null}
            />
          )}
        </main>
      </div>
      <StatusBar
        state={state}
        map={map?.config.name ?? null}
        catalog={catalogStatus}
        replay={review ? `${mapName(review.info.locationId)}${review.info.start ? ` · ${formatStart(review.info.start)}` : ""}` : null}
      >
        {!conn.live && !review && (
          <StatusButton tone="link" title="Open a recorded raid" onClick={() => setUi((u) => ({ ...u, open: true, section: "raids", raidsLevel: "list" }))}>
            ● open a recording
          </StatusButton>
        )}
        {filtered && (
          <StatusButton tone="link" title="The map shows filter matches only: open the list" onClick={() => setUi((u) => ({ ...u, open: true, section: "list" }))}>
            ● map filtered
          </StatusButton>
        )}
      </StatusBar>
    </>
  );
}
