import { Suspense, lazy, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { History, Loader, Play, RefreshCw, TriangleAlert, Unplug } from "lucide-react";
import { type RadarState, wsUrl } from "../stream/connection";
import { useCatalog } from "../model/useCatalog";
import { useMapIndex } from "../model/useMapIndex";
import { useConnection } from "../stream/useConnection";
import { cx, PanelBody, useHotkeys } from "../ui";
import { useMapPrefs, useOverlayPrefs, useQuestPrefs, useSidebarPrefs, useTrailPrefs } from "../persist/prefs";
import { overlayData, overlayMarks } from "../overlay/marks";
import { useOverlaySync } from "../overlay/useOverlaySync";
import { findMap, mapUrl } from "../model/maps";
import { allRows } from "../highlight/match";
import type { Suggestion } from "../highlight/suggest";
import type { Rule } from "../rules/rules";
import type { SubjectKind } from "../list/rows";
import { PREVIEW_ID, useRules } from "../rules/useRules";
import { withoutGunners } from "../model/vehicles";
import { useListPrefs, useListRows } from "../list/useListRows";
import type { Selection } from "../draw/pick";
import { usePlayback } from "../stream/playback";
import { buildScene, trailScene } from "../draw/scene";
import { questDebugReport } from "../model/quests.debug";
import { type WatchEntry, newWatchId, nextWatchColor, useLayerPrefs, useMarkerPrefs, useSeenQuests, useWatchPrefs } from "../watch/prefs";
import { carriedMarks, entryMatches, thingMarks, watchRules } from "../watch/rules";
import { type QuestEntry, questEntries } from "../watch/quests";
import { DetailsPanel } from "./DetailsPanel";
import { FollowButton } from "./FollowButton";
import type { MapStatus, RadarHandle } from "./Radar";
import { StyleSwitch } from "./StyleSwitch";
import { PlaybackBar } from "./PlaybackBar";
import { ActivityBar, type Badge, SidePanel, SidebarCard, type ViewId } from "./Sidebar";
import { LayersCard } from "./LayersCard";
import { MapNotices, type Notice } from "./MapNotices";
import { StateDialog, type StateDialogProps } from "./StateDialog";
import { WatchBar } from "./WatchBar";
import { WatchView } from "./WatchView";
import { QuestPicker } from "./QuestPicker";
import { PlayersView } from "./PlayersView";
import { LootView } from "./LootView";
import { ExfilsView } from "./ExfilsView";
import { RaidsPanel } from "./RaidsPanel";
import { TimelinePanel } from "./TimelinePanel";
import { SettingsPanel, type SettingsTab, type StatusLine } from "./SettingsPanel";
import { fetchRecordings } from "../stream/recordings";
import s from "./App.module.css";
import f from "./Floating.module.css";
import { useMapDebug } from "./useMapDebug";
import { useOwned } from "./useOwned";
import { useQuestState } from "./useQuestState";
import { useReplay } from "./useReplay";
import { useSelection } from "./useSelection";

// The radar brings the renderer (three.js) with it: loaded after the rest of the page.
const Radar = lazy(() => import("./Radar").then((m) => ({ default: m.Radar })));

/** Nothing is hidden by kind any more: the layers are rules (watch/rules.ts). */
const NO_KINDS: ReadonlySet<SubjectKind> = new Set();
/** What a list's filter marks on the map, at most. */
const MARKED_MAX = 300;

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

  // Quests: every started one counts (which are watched is the watchlist's: tracked quests); quest items
  // nobody needs are left out.
  const [questPrefs, setQuestPrefs] = useQuestPrefs();
  const counting = useMemo(() => ({ ...questPrefs, ignored: [] }), [questPrefs]);
  const ownedState = useOwned(unfiltered, conn.stash, questPrefs.ignoreOwned);
  const { state, deduped, needs, questLabels, questNeeds, questInfo } = useQuestState(unfiltered, true, counting, ownedState.owned);

  /** Out of a replay: the Raids view back to its list. */
  const backToLive = () => {
    replay.leave();
    playback.seek(null);
    setUi((u) => ({ ...u, raidsLevel: "list" }));
  };
  /** The live raid, in the Raids view's timeline (and the playback bar up). */
  const openCurrent = () => {
    if (review) backToLive();
    setPlaybackOpen(true);
    setUi((u) => ({ ...u, raidsLevel: "timeline" }));
  };

  const { catalog, status: catalogStatus, reload: reloadCatalog } = useCatalog();
  const mapIndex = useMapIndex();
  const locationId = state.status?.state === "inRaid" ? state.status.locationId : null;
  const mapName = (id: string | null) => (id ? (findMap(mapIndex, id)?.config.name ?? id) : "unknown map");
  // The location's map (maps/3d); without one, a grid of world coordinates.
  const [mapPrefs, setMapPrefs] = useMapPrefs();
  const map = (locationId ? findMap(mapIndex, locationId) : undefined) ?? null;
  const radar = useRef<RadarHandle>(null);
  const [mapStatus, setMapStatus] = useState<MapStatus>({ progress: null, error: null });
  /** How far the sidebar card reaches into the map (px): the map's controls start right of it. */
  const [cover, setCover] = useState(0);
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
  const focusFilter = useRef<() => void>(undefined);

  // ---- The watch model: tiers, layers and the watchlist, as display rules ----
  const [markers, setMarkers] = useMarkerPrefs();
  const [layers, setLayers] = useLayerPrefs();
  const [watch, setWatch] = useWatchPrefs();
  const entries = watch.entries;
  // The search's active suggestion, previewed on the map (on top, ringed in white).
  const [preview, setPreview] = useState<string | null>(null);
  const baseRules = useMemo(() => watchRules(markers, layers, entries), [markers, layers, entries]);
  const rules: Rule[] = useMemo(() => (preview ? [...baseRules, { id: PREVIEW_ID, label: "", query: preview, style: { show: 0, ring: "#ffffff" } }] : baseRules), [baseRules, preview]);
  const styled = useRules(list.all, rules, catalog, NO_KINDS);
  const carried = useMemo(() => carriedMarks(list.all.players, entries, catalog), [list.all.players, entries, catalog]);
  const watchHits = useMemo(() => new Map(entries.map((e) => [e.id, entryMatches(e, styled.matched, carried, list.all.players)])), [entries, styled.matched, carried, list.all.players]);
  const marks = useMemo(() => thingMarks(baseRules, styled.matched, entries), [baseRules, styled.matched, entries]);
  const watchCounts = useMemo(() => new Map([...watchHits].map(([id, rows]) => [id, rows.length])), [watchHits]);
  const everything = useMemo(() => allRows(list.all), [list.all]);

  const setEntries = (update: (es: WatchEntry[]) => WatchEntry[]) => setWatch((w) => ({ ...w, entries: update(w.entries) }));
  const addEntry = (label: string, query: string, questId?: string) =>
    setEntries((es) => {
      const same = es.find((e) => e.query === query);
      if (same) return es.map((e) => (e === same ? { ...e, on: true } : e));
      return [...es, { id: newWatchId(), label, query, color: nextWatchColor(es), level: "high", on: true, ...(questId ? { questId } : {}) }];
    });
  const addSuggestion = (sg: Suggestion) => addEntry(sg.label.replace(/^"|"$/g, ""), sg.query);
  const changeEntry = (id: string, patch: Partial<WatchEntry>) => setEntries((es) => es.map((e) => (e.id === id ? { ...e, ...patch } : e)));
  const removeEntry = (id: string) => setEntries((es) => es.filter((e) => e.id !== id));
  const steps = useRef(new Map<string, number>());

  // ---- Quests: tracked ones are watch entries; new ones (started since last seen) are nudged ----
  const quests = useMemo(() => questEntries(unfiltered.quests, questPrefs.imported, needs, catalog), [unfiltered.quests, questPrefs.imported, needs, catalog]);
  const questsById = useMemo(() => new Map(quests.map((q) => [q.id, q])), [quests]);
  const tracked = useMemo(() => new Set(entries.flatMap((e) => (e.questId ? [e.questId] : []))), [entries]);
  const [seen, setSeen] = useSeenQuests();
  // The first look: every quest there is counts as seen (the nudge is for what starts after).
  useEffect(() => {
    if (seen.ids === null && unfiltered.quests) setSeen({ ids: quests.map((q) => q.id) });
  }, [seen.ids, unfiltered.quests, quests]);
  const seenIds = useMemo(() => new Set(seen.ids ?? quests.map((q) => q.id)), [seen.ids, quests]);
  const newQuests = useMemo(() => quests.filter((q) => q.kind !== "imported" && !seenIds.has(q.id) && !tracked.has(q.id)), [quests, seenIds, tracked]);
  const markSeen = (ids: readonly string[]) => setSeen((st) => ({ ids: [...new Set([...(st.ids ?? []), ...ids])] }));
  const trackQuest = (q: Pick<QuestEntry, "id" | "name" | "query">) => {
    addEntry(q.name, q.query, q.id);
    markSeen([q.id]);
  };
  const untrackQuest = (id: string) => setEntries((es) => es.filter((e) => e.questId !== id));
  const [picker, setPicker] = useState<{ tab: string | null } | null>(null);

  // The overlay (radar-backend --overlay, deprecated): configured from here, from the live raid only (a
  // replay or an earlier moment leaves it as it was).
  const [overlayPrefs, setOverlayPrefs] = useOverlayPrefs();
  const overlayLive = conn.overlay && !review && playback.cursor === null;
  const marksForOverlay = useMemo(() => (overlayLive ? overlayMarks(list.all, styled.styles) : []), [overlayLive, list.all, styled.styles]);
  const overlayRaid = conn.status?.state === "inRaid" ? conn.raid : null;
  const overlayConfig = useMemo(
    () => (overlayLive ? overlayData(overlayPrefs, overlayRaid, marksForOverlay) : null),
    [overlayLive, overlayPrefs, overlayRaid, marksForOverlay],
  );
  useOverlaySync(connection, conn.overlay, conn.connected, overlayConfig);

  // Side panel: open or collapsed, and which view it shows. The Raids view has two levels: the list of
  // raids, and a raid's timeline.
  const [ui, setUi] = useSidebarPrefs();
  const view: ViewId = ui.section;
  const [settingsTab, setSettingsTab] = useState<SettingsTab>("markers");
  const togglePanel = () => setUi((u) => ({ ...u, open: !u.open }));
  const uiRef = useRef(ui);
  uiRef.current = ui;
  /** The views with a filter (Raids: its list of raids). */
  const hasFilter = (u: typeof ui) => u.section === "players" || u.section === "loot" || (u.section === "raids" && u.raidsLevel === "list");
  /** L: focuses the open view's filter (Players, Loot, Raids), opening Players if none is; closes it when focused. */
  const toggleList = () => {
    const u = uiRef.current;
    if (u.open && hasFilter(u) && document.activeElement?.tagName === "INPUT") return setUi((x) => ({ ...x, open: false }));
    wantFocus.current = true;
    setUi((x) => (hasFilter(x) ? { ...x, open: true } : { ...x, open: true, section: "players" }));
    focusFilter.current?.();
  };
  // In the commit that shows the view (its own layout effects ran first), so keys typed right after L
  // land in the filter rather than in the map's shortcuts.
  const wantFocus = useRef(false);
  const filterShown = ui.open && hasFilter(ui);
  useLayoutEffect(() => {
    if (!filterShown || !wantFocus.current) return;
    wantFocus.current = false;
    focusFilter.current?.();
  }, [filterShown, ui.section, ui.raidsLevel]);

  // The playback bar: up while replaying, behind live, or after the Raids view showed the live raid.
  const [playbackOpen, setPlaybackOpen] = useState(false);
  const inRaid = state.status?.state === "inRaid";
  const liveRaid = !review && conn.live && inRaid;
  const pickView = (v: ViewId) => {
    if (ui.open && v === view) return setUi((u) => ({ ...u, open: false }));
    // Raids opens what's on: the replay's events, or the live raid's.
    if (v === "raids" && (review || liveRaid)) {
      if (!review) setPlaybackOpen(true);
      return setUi((u) => ({ ...u, open: true, section: "raids", raidsLevel: "timeline" }));
    }
    setUi((u) => ({ ...u, open: true, section: v }));
  };

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
    hidden: NO_KINDS,
    timeline,
    playback,
    centerOn,
  });

  /** Steps through what an entry has on the map, nearest first. */
  const stepEntry = (e: WatchEntry) => {
    const hits = [...(watchHits.get(e.id) ?? [])].filter((r) => r.pos);
    if (!hits.length) return;
    const from = local?.pos;
    if (from) hits.sort((a, b) => Math.hypot(a.pos![0] - from[0], a.pos![2] - from[2]) - Math.hypot(b.pos![0] - from[0], b.pos![2] - from[2]));
    const i = ((steps.current.get(e.id) ?? -1) + 1) % hits.length;
    steps.current.set(e.id, i);
    showOnMap(hits[i]!.sel);
  };

  const debug = useMapDebug({ radar, map, shown: state, styles: styled.styles, coordinatePick: mapPrefs.coordinatePick, select });
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
      description: "Focus the list's filter (Players unless a list is open), or close it",
      handler: (e) => {
        e.preventDefault(); // the filter it focuses mustn't get the "l"
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

  // What the status bar used to say: problems that leave the map usable are notices over it; states
  // without a raid to show are a dialog over the plain grid.
  const notices: Notice[] = [];
  if (map && mapStatus.progress !== null) notices.push({ id: "map-loading", tone: "info", text: "Loading the map", progress: mapStatus.progress });
  if (map && mapStatus.error)
    notices.push({
      id: `map-error:${mapStatus.error}`,
      tone: "warn",
      text: `Couldn't load the map (${mapStatus.error}): markers on a plain grid`,
      action: { label: "Retry", run: () => radar.current?.reload() },
    });
  if (inRaid && locationId && !map)
    notices.push({ id: `no-map:${locationId}`, tone: "info", text: `No map for ${mapName(locationId)} yet: markers on a plain grid` });
  if (conn.connected && state.status?.offsetsMismatch)
    notices.push({ id: "offsets", tone: "warn", text: "The game's build differs from the offsets' build: some things may be missing or wrong" });
  if (catalogStatus.state === "unavailable")
    notices.push({ id: "no-items", tone: "warn", text: "No item data: names and prices are missing", action: { label: "Retry", run: reloadCatalog } });
  if (catalogStatus.state === "stale" && catalogStatus.fetchedAt !== null)
    notices.push({
      id: "stale-items",
      tone: "info",
      text: `Item data is ${ago(catalogStatus.fetchedAt)} old (couldn't update it)`,
      action: { label: "Update", run: reloadCatalog },
    });
  const pastRaids = () => setUi((u) => ({ ...u, open: true, section: "raids", raidsLevel: "list" }));
  const replayLast = () =>
    void fetchRecordings().then((list) => {
      const last = [...list].filter((r) => !r.active).sort((a, b) => (b.start ?? 0) - (a.start ?? 0))[0];
      if (last) openRecording(last);
      else pastRaids();
    });
  const dialog: StateDialogProps | null = review
    ? null
    : !conn.connected
      ? {
          tone: "error",
          icon: Unplug,
          title: "Can't reach the backend",
          text: "radar-backend isn't running, or the connection dropped. Trying again every few seconds.",
          meta: wsUrl(),
          actions: [{ label: "Retry now", icon: RefreshCw, primary: true, run: () => connection.retryNow() }],
        }
      : conn.protocolMismatch
        ? {
            tone: "error",
            icon: TriangleAlert,
            title: "This page is out of date",
            text: "The backend speaks a different protocol version. Rebuild the frontend, then reload.",
            meta: "cd web && npm run build",
            actions: [{ label: "Reload", icon: RefreshCw, primary: true, run: () => location.reload() }],
          }
        : !state.status
          ? conn.live
            ? null
            : {
                tone: "info",
                icon: History,
                title: "No game",
                text: "The backend runs offline: there's no live raid, only past ones.",
                actions: [
                  { label: "Replay the last raid", icon: Play, primary: true, run: replayLast },
                  { label: "Past raids", icon: History, run: pastRaids },
                ],
              }
          : !inRaid
            ? {
                tone: "info",
                icon: Loader,
                spin: true,
                title: state.status.raidPending ? "A raid is loading" : "Waiting for a raid",
                text: WAITING[state.status.state] ?? "The map opens as soon as a raid starts.",
                actions: [{ label: "Past raids", icon: History, run: pastRaids }],
              }
            : null;
  const playbackShown = !!(timeline && range) && (!!review || playbackOpen || playback.cursor !== null);

  // Settings → Status: everything the status bar knew, line by line.
  const status: StatusLine[] = [
    !conn.connected
      ? { label: "Backend", tone: "error", text: `Not reachable at ${wsUrl()}`, action: { label: "Retry", run: () => connection.retryNow() } }
      : conn.protocolMismatch
        ? { label: "Backend", tone: "error", text: "Different protocol version: rebuild the frontend" }
        : { label: "Backend", tone: conn.live ? "ok" : "info", text: conn.live ? "Connected · live" : "Connected · offline, past raids only" },
    !conn.connected || !conn.live
      ? { label: "Game", tone: "off", text: "—" }
      : { label: "Game", tone: conn.status ? "ok" : "info", text: conn.status ? (inRaid ? `In raid on ${mapName(locationId)}` : (WAITING[conn.status.state]?.split(".")[0] ?? conn.status.state)) : "Waiting for the game" },
    { label: "Offsets", tone: !conn.status ? "off" : conn.status.offsetsMismatch ? "warn" : "ok", text: !conn.status ? "—" : conn.status.offsetsMismatch ? "Built for another game build: some things may be missing or wrong" : "Match the game's build" },
    catalogStatus.state === "unavailable"
      ? { label: "Item data", tone: "warn", text: "Not loaded: couldn't reach tarkov.dev", action: { label: "Retry", run: reloadCatalog } }
      : catalogStatus.state === "loading"
        ? { label: "Item data", tone: "info", text: "Loading…" }
        : { label: "Item data", tone: catalogStatus.state === "stale" ? "info" : "ok", text: `${catalogStatus.fetchedAt ? `${ago(catalogStatus.fetchedAt)} old` : "Loaded"} · ${catalogStatus.count} items`, action: { label: "Update", run: reloadCatalog } },
    !map
      ? { label: "Map", tone: inRaid ? "info" : "off", text: inRaid ? `None for ${mapName(locationId)}: markers on a grid` : "—" }
      : mapStatus.error
        ? { label: "Map", tone: "warn", text: `Couldn't load: ${mapStatus.error}`, action: { label: "Retry", run: () => radar.current?.reload() } }
        : { label: "Map", tone: mapStatus.progress !== null ? "info" : "ok", text: mapStatus.progress !== null ? `${map.config.name} · loading, ${Math.round(mapStatus.progress * 100)} %` : map.config.name },
  ];

  // What the Loot view's filter lets through, marked on the map while it's set (and the view is open).
  const marked = ui.open && ui.section === "loot" && listPrefs.filters[listPrefs.tab].text.trim() ? list.rows[listPrefs.tab].slice(0, MARKED_MAX) : [];

  const scene = buildScene({
    state,
    shown: state,
    catalog,
    questLabels,
    styles: styled.styles,
    selection,
    hovered,
    listShown: ui.open,
    debugPoints: map && mapPrefs.coordinatePick ? debugPicks.map((p) => p.pos) : [],
    hoverMatches: marked,
    trails: trailScene({ timeline, at, prefs: trailPrefs, players: state.players, selection }),
    bodies: mapPrefs.bodies,
    carried,
  });

  const alive = list.all.players.filter((p) => !p.local && p.state === "alive").length;
  const badges: Partial<Record<ViewId, Badge>> = {
    players: alive,
    watch: newQuests.length ? { n: newQuests.length, tone: "new" } : entries.filter((e) => e.on).length,
    ...(review ? { raids: { dot: "warn" } } : liveRaid ? { raids: { dot: "live" } } : {}),
  };
  const statusWarn = status.some((l) => l.tone === "warn" || l.tone === "error");

  const viewpoint = local?.pos ? { pos: local.pos, yaw: local.yaw } : null;
  const panel = (() => {
    switch (view) {
      case "players":
        return (
          <PanelBody>
          <PlayersView
            players={list.all.players}
            local={viewpoint}
            markers={markers}
            setMarkers={setMarkers}
            carried={carried}
            selection={selection}
            onActivate={showOnMap}
            onHover={setHovered}
            focusRef={focusFilter}
          />
          </PanelBody>
        );
      case "loot":
        return (
          <LootView
            state={state}
            list={list}
            prefs={listPrefs}
            setPrefs={setListPrefs}
            local={viewpoint}
            marks={marks}
            markedMax={MARKED_MAX}
            selection={selection}
            onActivate={showOnMap}
            onHover={setHovered}
            onWatch={(text) => addEntry(text, text)}
            focusRef={focusFilter}
          />
        );
      case "exfils":
        return <ExfilsView exfils={list.all.exfils} local={viewpoint} selection={selection} onActivate={showOnMap} onHover={setHovered} />;
      case "watch":
        return (
          <PanelBody>
          <WatchView
            entries={entries}
            counts={watchCounts}
            quests={questsById}
            newQuests={newQuests}
            pickerOpen={!!picker}
            onStep={stepEntry}
            onChange={changeEntry}
            onRemove={removeEntry}
            onWatchSomething={() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "/" }))}
            onPicker={(tab) => setPicker((p) => (p && !tab ? null : { tab: tab === "new" ? "New" : null }))}
            onDismissNew={() => markSeen(newQuests.map((q) => q.id))}
          />
          </PanelBody>
        );
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
            onPick={(e) => {
              if (!review) setPlaybackOpen(true);
              pickEvent(e);
            }}
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
            focusRef={focusFilter}
          />
        );
      case "settings":
        return (
          <SettingsPanel
            tab={settingsTab}
            onTab={setSettingsTab}
            markers={markers}
            setMarkers={setMarkers}
            map={{ prefs: mapPrefs, onPrefs: setMapPrefs, trails: trailPrefs, onTrails: setTrailPrefs }}
            quests={{ quests: unfiltered.quests, catalog, prefs: questPrefs, onPrefs: setQuestPrefs, questInfo, needs, owned: ownedState }}
            overlay={{ available: conn.overlay, prefs: overlayPrefs, onPrefs: setOverlayPrefs, marks: overlayConfig?.marks.length ?? null }}
            status={status}
            debug={{
              prefs: mapPrefs,
              onPrefs: setMapPrefs,
              mapShown: !!map,
              stats: map ? mapStats : null,
              mapInfo: map && { folder: map.folder, name: map.config.name, locationId, up: map.config.up ?? 0 },
              view: map ? mapView : null,
              pickOutput: pickOutput(),
              onClearPicks: debug.clearPicks,
              quests: questDebugReport({ quests: unfiltered.quests, loot: deduped, filterOn: true, itemName: (tpl) => catalog.lookup(tpl)?.name }),
              duplicates: unfiltered.loot.length - deduped.length,
            }}
          />
        );
    }
  })();

  return (
    <div className={s.app}>
      <main className={cx(s.main, f.area)} data-style-switch={!!(map || inRaid || review)} data-details={!!selection} style={{ "--cover": `${cover}px` } as React.CSSProperties}>
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
            onStatus={setMapStatus}
          />
        </Suspense>
        {playbackShown && timeline && range && (
          <PlaybackBar range={range} playback={playback} replay={!!review} events={timeline.events} selection={selection} onExitReplay={backToLive} onHide={() => setPlaybackOpen(false)} />
        )}
        {(map || inRaid || review) && (
          <StyleSwitch style={mapPrefs.style} palette={mapPrefs.palette} custom={mapPrefs.customPalette} onChange={(style, palette) => setMapPrefs((p) => ({ ...p, style, palette }))}>
            <LayersCard layers={layers} setLayers={setLayers} />
          </StyleSwitch>
        )}
        <MapNotices notices={notices} above={playbackShown} />
        {dialog && <StateDialog {...dialog} />}
        {(inRaid || review) && (
          <FollowButton
            follow={follow}
            heading={heading}
            onClick={() => {
              if (!follow) setFollow(true);
              else setFollowHeading((h) => !h);
            }}
          />
        )}
        {conn.connected && !conn.protocolMismatch && (
          <WatchBar
            entries={entries}
            hits={watchHits}
            rows={everything}
            catalog={catalog}
            quests={quests.filter((q) => !tracked.has(q.id)).map((q) => ({ id: q.id, name: q.name, detail: q.tab, query: q.query }))}
            onAdd={addSuggestion}
            onTrack={(q) => trackQuest(q)}
            onChange={changeEntry}
            onRemove={removeEntry}
            onPreview={setPreview}
            onStep={stepEntry}
            onOpenView={() => setUi((u) => ({ ...u, open: true, section: "watch" }))}
          />
        )}
        {picker && (
          <QuestPicker
            quests={quests}
            newIds={new Set(newQuests.map((q) => q.id))}
            tracked={tracked}
            startTab={picker.tab}
            onTrack={trackQuest}
            onUntrack={(q) => untrackQuest(q.id)}
            onDismiss={(id) => markSeen([id])}
            onClose={() => setPicker(null)}
          />
        )}
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
      <SidebarCard onCover={setCover}>
        <ActivityBar active={ui.open ? view : null} onPick={pickView} badges={badges} notes={{ raids: liveRaid ? "a raid is live" : review ? "replaying" : "", settings: statusWarn ? "something needs attention (Status)" : "" }} />
        {ui.open && (
          <SidePanel view={view} onClose={togglePanel}>
            {panel}
          </SidePanel>
        )}
      </SidebarCard>
    </div>
  );
}

/** What the backend is doing before a raid, as the waiting dialog says it. */
const WAITING: Partial<Record<string, string>> = {
  waitingForProcess: "The game isn't running yet. The map opens as soon as a raid starts.",
  waitingForModules: "The game is starting. The map opens as soon as a raid starts.",
  waitingForRaid: "The game is in its menus. The map opens as soon as a raid starts.",
  cooldown: "The raid has ended. The map opens again with the next one.",
};

/** "3 days", "5 hours": how long ago a time (ms) was. */
function ago(t: number): string {
  const h = (Date.now() - t) / 3_600_000;
  const n = h >= 48 ? Math.floor(h / 24) : Math.max(1, Math.floor(h));
  return `${n} ${h >= 48 ? "day" : "hour"}${n === 1 ? "" : "s"}`;
}
