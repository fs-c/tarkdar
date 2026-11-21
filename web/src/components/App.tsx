import { Locate, LocateFixed, Navigation } from "lucide-react";
import { Suspense, lazy, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { type RadarState, wsUrl } from "../stream/connection";
import { useCatalog } from "../model/useCatalog";
import { useMapIndex } from "../model/useMapIndex";
import { useConnection } from "../stream/useConnection";
import { isTyping } from "../ui";
import { useLootPrefs, useMapPrefs, useOverlayPrefs, useSidebarPrefs, useTrailPrefs } from "../persist/prefs";
import { questDebugReport } from "../model/quests.debug";
import { type QuestNeed, questItemLabels, questNeeds as readQuestNeeds, withoutUnneededQuestItems } from "../model/quests";
import { withoutDuplicateLoot } from "../model/dedupe";
import { describeEvent } from "../stream/events";
import { overlayData, overlayMarks } from "../overlay/marks";
import { useOverlaySync } from "../overlay/useOverlaySync";
import type { MapStats, MapView } from "../map3d/Map3D";
import { findMap, mapUrl } from "../model/maps";
import { type Highlight, allRows } from "../highlight/match";
import { categoryFor } from "../rules/defaults";
import { explainStyle, highlightStyle } from "../rules/rules";
import { hiddenKinds, newRuleId, storedRules, usePinned, useRuleStore } from "../rules/store";
import { highlightId, highlightRules, useRules } from "../rules/useRules";
import { isFiltered, rowKeys } from "../list/rows";
import { withoutGunners } from "../model/vehicles";
import { useListPrefs, useListRows } from "../list/useListRows";
import { type Selection, pick, selectedPosition, selectionKey } from "../draw/pick";
import { usePlayback } from "../stream/playback";
import type { RecordingInfo, WorldPos } from "../model/protocol";
import { loadRecording } from "../stream/recordings";
import type { Timeline, TimelineEvent } from "../stream/timeline";
import type { Scene } from "../draw/render";
import { DetailsPanel } from "./DetailsPanel";
import { Highlights } from "./Highlights";
import { ListPanel } from "./ListPanel";
import { FiltersPanel } from "./FiltersPanel";
import { MapPanel } from "./MapPanel";
import { RaidsPanel } from "./RaidsPanel";
import type { RadarHandle } from "./Radar";
import { SettingsPanel } from "./SettingsPanel";
import { StyleSwitch } from "./StyleSwitch";
import { PlaybackBar } from "./PlaybackBar";
import { ActivityBar, SidePanel, type ViewId } from "./Sidebar";
import s from "./App.module.css";
import { StatusBar, StatusButton } from "./StatusBar";
import { TimelinePanel } from "./TimelinePanel";

// No quest needs (quests not read): a stable empty map.
const NO_NEEDS: ReadonlyMap<string, readonly QuestNeed[]> = new Map();

// The radar brings the renderer (three.js) with it: loaded after the rest of the page.
const Radar = lazy(() => import("./Radar").then((m) => ({ default: m.Radar })));


export function App() {
  const { state: conn, live, liveVersion, conn: connection } = useConnection(wsUrl());

  // What's shown: the live raid, or a recording opened from the Raids view; either at the cursor.
  const [review, setReview] = useState<{ info: RecordingInfo; timeline: Timeline } | null>(null);
  const [loadingRecording, setLoadingRecording] = useState<string | null>(null);
  const [recordingError, setRecordingError] = useState<string | null>(null);
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

  // Copies of the same loot at the same spot are merged, and quest items nobody needs are left out
  // everywhere (map, list, search), unless all are wanted.
  const deduped = useMemo(() => withoutDuplicateLoot(unfiltered.loot), [unfiltered.loot]);
  // What started quests still need (quest items and ordinary ones): the filter, the "Needed for quests"
  // rule, labels on the map, in the list and details.
  const needs = useMemo(() => readQuestNeeds(unfiltered.quests), [unfiltered.quests]);
  const questLabels = useMemo(() => questItemLabels(needs), [needs]);
  const questNeeds = needs?.items ?? NO_NEEDS;
  const filterQuest = lootPrefs.questItems !== "all";
  const state: RadarState = useMemo(() => {
    const loot = withoutUnneededQuestItems(deduped, filterQuest ? needs : null);
    return loot === unfiltered.loot ? unfiltered : { ...unfiltered, loot };
  }, [unfiltered, deduped, filterQuest, needs]);
  const plural = (n: number, what: string) => `${n} ${what}${n === 1 ? "" : "s"}`;
  const questInfo = !needs
    ? "quests unknown: all shown"
    : !needs.complete
      ? `${plural(needs.started, "quest")} started, objectives unknown: all shown`
      : `${plural(needs.started, "quest")} started, ${plural(needs.items.size, "item")} needed`;

  const openRecording = (info: RecordingInfo) => {
    if (review?.info.name === info.name) return setUi((u) => ({ ...u, raidsLevel: "timeline" }));
    setLoadingRecording(info.name);
    setRecordingError(null);
    loadRecording(info.name).then(
      (t) => {
        setReview({ info, timeline: t });
        setLoadingRecording(null);
        setUi((u) => ({ ...u, raidsLevel: "timeline" }));
      },
      (e: unknown) => {
        setRecordingError(`Couldn't load ${info.name}: ${String(e)}`);
        setLoadingRecording(null);
      },
    );
  };
  /** Out of a replay: the Raids view back to its list. */
  const backToLive = () => {
    setReview(null);
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
    if (v === "filters" || v === "map" || v === "raids" || v === "settings") return setUi((u) => ({ ...u, open: true, section: v }));
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

  // Ids restart every raid: a selection from another raid (or recording) would point at something else.
  const raid = `${review?.info.name ?? "live"}:${state.status?.state === "inRaid" ? state.raid : null}`;
  const [picked, setPicked] = useState<{ raid: string | null; sel: Selection | null }>({ raid: null, sel: null });
  const selection = picked.raid === raid ? picked.sel : null;
  // Why the selected thing looks the way it does (the details panel).
  const selectedRow = useMemo(() => (selection ? everything.find((r) => r.key === selectionKey(selection)) : undefined), [selection, everything]);
  const selectedLook = useMemo(() => (selectedRow ? explainStyle(selectedRow, rules, catalog, hidden) : null), [selectedRow, rules, catalog, hidden]);
  const select = (sel: Selection | null) => setPicked({ raid, sel });

  /** Selects something and brings it into view: centred. */
  const showOnMap = (sel: Selection) => {
    select(sel);
    centerOn(selectedPosition(sel, state));
  };

  /** Shows an event: its moment, its subject selected and centred. */
  const pickEvent = (e: TimelineEvent) => {
    if (!timeline) return;
    const d = describeEvent(e, timeline, catalog);
    playback.seek(d.showAt);
    select(d.sel);
    centerOn(d.pos);
  };

  const centerOn = (pos: [number, number, number] | null) => {
    if (!pos) return;
    stopFollowing();
    radar.current?.centerOn(pos);
  };

  // Map debugging: with the coordinate pick on, a click that hits no marker records the world
  // position of the map surface under it, to describe where something on the map is wrong.
  const [debugPicks, setDebugPicks] = useState<{ pos: WorldPos; mesh: string }[]>([]);
  const onTap = (x: number, y: number) => {
    const r = radar.current;
    if (!r) return;
    const hit = pick(r.projector(), shown, styled.styles, x, y);
    const surface = !hit && mapPrefs.coordinatePick ? r.pickSurface(x, y) : null;
    if (surface) setDebugPicks((picks) => [...picks, surface]);
    else select(hit);
  };
  const pickOutput = () => {
    const r = (v: WorldPos) => v.map((c) => round(c, 2));
    const pose = radar.current?.pose();
    return JSON.stringify(
      {
        map: map?.folder ?? null,
        camera: pose ? { position: r(pose.position), target: r(pose.target) } : null,
        points: debugPicks.map((p, i) => ({ n: i + 1, world: r(p.pos), mesh: p.mesh })),
      },
      null,
      2,
    );
  };
  const [mapStats, setMapStats] = useState<string | null>(null);
  const [mapView, setMapView] = useState<MapView | null>(null);
  const lastStats = useRef(0);
  const pendingStats = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onMapStats = (st: MapStats) => {
    const report = () => {
      pendingStats.current = null;
      lastStats.current = performance.now();
      // A top-down orthographic view is drawn from tiles: a few squares, not the map's triangles.
      const drawn = st.fromTiles ? `${st.drawCalls} tiles` : `${st.drawCalls} draw calls · ${(st.triangles / 1e6).toFixed(1)}M triangles`;
      setMapStats(`${drawn} · ${st.frames} frames drawn`);
      setMapView(radar.current?.view() ?? null);
    };
    // At most every half second, but always the last frame: the readout shows where the camera stopped.
    const wait = 500 - (performance.now() - lastStats.current);
    if (wait <= 0) report();
    else pendingStats.current ??= setTimeout(report, wait);
  };
  useEffect(() => () => void (pendingStats.current && clearTimeout(pendingStats.current)), []);

  const playbackRef = useRef(playback);
  playbackRef.current = playback;
  const rangeRef = useRef(range);
  rangeRef.current = range;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTyping(e) || e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.repeat && e.key !== "[" && e.key !== "]") return; // holding a toggle key toggles once; seeking repeats
      const pb = playbackRef.current, r = rangeRef.current;
      if (e.key === "Escape") setPicked((p) => ({ ...p, sel: null }));
      else if (e.key === "f") followRef.current ? stopFollowing() : setFollow(true);
      else if (e.key === "l") {
        e.preventDefault(); // the search it focuses mustn't get the "l"
        toggleList();
      }
      else if (e.key === "m") setMapPrefs((p) => ({ ...p, style: p.style === "plan" ? "realistic" : "plan" }));
      else if (e.key === " " && (e.target === document.body || e.target instanceof HTMLCanvasElement)) {
        e.preventDefault();
        pb.toggle();
      } else if ((e.key === "[" || e.key === "]") && r) {
        const step = (e.key === "[" ? -10_000 : 10_000) * pb.speed;
        pb.seek((pb.cursor ?? r[1]) + step);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // Safe with [] deps: the handler only reads refs (playbackRef, rangeRef, followRef, uiRef via toggleList) and stable setters.
  }, []);

  const trailScene = (): Scene["trails"] => {
    if (!timeline || at === null) return null;
    const since = new Map<number, number>();
    if (trailPrefs.all) {
      const from = trailPrefs.minutes === null ? -Infinity : at - trailPrefs.minutes * 60_000;
      for (const p of shown.players) since.set(p.id, from);
    }
    const selectedPlayer = selection?.kind === "player" ? selection.id : null;
    if (trailPrefs.selected && selectedPlayer !== null) since.set(selectedPlayer, -Infinity);
    return since.size ? { timeline, at, since, selected: selectedPlayer } : null;
  };

  const scene: Scene = {
    players: shown.players,
    catalog,
    exfils: shown.exfils,
    explosives: shown.explosives,
    vehicles: state.vehicles,
    loot: shown.loot,
    questLabels,
    styles: styled.styles,
    selected: selectedPosition(selection, state),
    hovered: listShown ? selectedPosition(hovered, state) : null,
    debugPoints: map && mapPrefs.coordinatePick ? debugPicks.map((p) => p.pos) : [],
    marked: hoverRule ? (styled.matched.get(hoverRule) ?? []).flatMap((r) => (r.pos ? [r.pos] : [])) : [],
    trails: trailScene(),
    bodies: mapPrefs.bodies,
  };

  const panelBody = () => {
    switch (ui.section) {
      case "list":
        return (
          <ListPanel
            state={state}
            list={list}
            prefs={listPrefs}
            setPrefs={setListPrefs}
            selection={selection}
            onActivate={showOnMap}
            onHover={setHovered}
            styles={styled.styles}
            focusRef={focusListSearch}
          />
        );
      case "filters":
        return (
          <FiltersPanel
            rules={ruleStore}
            setRules={setRuleStore}
            pinned={pinned}
            setPinned={setPinned}
            matched={styled.matched}
            catalog={catalog}
            onHoverRule={setHoverRule}
            loot={lootPrefs}
            onLoot={setLootPrefs}
            questInfo={questInfo}
            help={syntaxHelp}
            onHelp={setSyntaxHelp}
          />
        );
      case "map":
        return <MapPanel prefs={mapPrefs} onPrefs={setMapPrefs} trails={trailPrefs} onTrails={setTrailPrefs} />;
      case "raids":
        return ui.raidsLevel === "timeline" ? (
          <TimelinePanel
            timeline={timeline}
            range={range}
            live={!review}
            title={review ? mapName(review.info.locationId) : "Current raid"}
            subtitle={review ? (review.info.start ? new Date(review.info.start).toLocaleString() : review.info.name) : mapName(locationId)}
            onBack={() => setUi((u) => ({ ...u, raidsLevel: "list" }))}
            loading={!review && live.backfilling}
            playback={playback}
            catalog={catalog}
            selection={selection}
            onPick={pickEvent}
          />
        ) : (
          <RaidsPanel
            current={{
              available: conn.live,
              inRaid: !!live.timeline,
              mapName: live.timeline ? mapName(live.timeline.locationId) : null,
              elapsed: live.timeline && !Number.isNaN(live.timeline.start) ? live.timeline.end - live.timeline.range()[0] : null,
            }}
            viewing={review?.info.name ?? null}
            loading={loadingRecording}
            error={recordingError}
            mapName={mapName}
            onOpen={openRecording}
            onCurrent={openCurrent}
          />
        );
      case "settings":
        return (
          <SettingsPanel
            overlay={{ available: conn.overlay, prefs: overlayPrefs, onPrefs: setOverlayPrefs, marks: overlayConfig?.marks.length ?? null }}
            debug={{
              prefs: mapPrefs,
              onPrefs: setMapPrefs,
              mapShown: !!map,
              stats: map ? mapStats : null,
              mapInfo: map && { folder: map.folder, name: map.config.name, locationId, up: map.config.up ?? 0 },
              view: map ? mapView : null,
              pickOutput: pickOutput(),
              onClearPicks: () => setDebugPicks([]),
              quests: questDebugReport({
                quests: unfiltered.quests,
                loot: deduped,
                filterOn: filterQuest,
                itemName: (tpl) => catalog.lookup(tpl)?.name,
              }),
              duplicates: unfiltered.loot.length - deduped.length,
            }}
          />
        );
    }
  };

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
            {panelBody()}
          </SidePanel>
        )}
        <main className={s.main} data-style-switch={!!map} data-details={!!selection}>
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
          {/* Off: flies to the local player and follows. Following: turns the map with their view
              direction, or not. Moving the map by hand (or F) stops following. */}
          <button
            className={s.follow}
            aria-pressed={follow}
            data-heading={heading}
            title={
              !follow
                ? "Follow the local player (F)"
                : heading
                    ? "Following your view direction: click for a fixed direction. Drag the map or press F to stop following."
                    : "Following you: click to follow your view direction too. Drag the map or press F to stop following."
            }
            onClick={() => {
              if (!follow) setFollow(true);
              else setFollowHeading((h) => !h);
            }}
          >
            {heading ? <Navigation size={20} /> : follow ? <LocateFixed size={20} /> : <Locate size={20} />}
          </button>
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

/** "10 Nov 19:03" */
function formatStart(ms: number): string {
  return new Date(ms).toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

function round(v: number, digits: number): number {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}
