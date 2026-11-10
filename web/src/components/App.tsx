import { Locate, LocateFixed } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { type ControlPoint, formatCalibration, worldToPixel } from "../calibration";
import type { RadarState } from "../connection";
import { isTyping, useAutoLayer, useCatalog, useConnection, useLayers, useMapIndex, usePersistentState, useRaidMap, useTrailPrefs } from "../hooks";
import { describeEvent } from "../events";
import { type LoadedMap, selectLayer } from "../maps";
import { isFiltered, rowKeys } from "../list/rows";
import { DEFAULT_PREFS, type ListPrefs, useListRows } from "../list/useListRows";
import { type Selection, pick, selectedPosition, selectionKey } from "../pick";
import { usePlayback } from "../playback";
import type { RecordingInfo } from "../protocol";
import { loadRecording } from "../recordings";
import type { Timeline, TimelineEvent } from "../timeline";
import { NO_MAP_TRANSFORM, type Scene } from "../render";
import { View } from "../view";
import { DetailsPanel } from "./DetailsPanel";
import { ListPanel } from "./ListPanel";
import { MapPanel } from "./MapPanel";
import { RaidsPanel } from "./RaidsPanel";
import { RadarCanvas } from "./RadarCanvas";
import { SettingsPanel } from "./SettingsPanel";
import { ActivityBar, SidePanel, type ViewId } from "./Sidebar";
import { StatusBar } from "./StatusBar";
import { TimelineIndicator, TimelinePanel } from "./TimelinePanel";

const WS_URL = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`;

export function App() {
  const { state: conn, live, liveVersion } = useConnection(WS_URL);

  // What's shown: the live raid, or a recording opened from the Raids view; either at the cursor.
  const [review, setReview] = useState<{ info: RecordingInfo; timeline: Timeline } | null>(null);
  const [loadingRecording, setLoadingRecording] = useState<string | null>(null);
  const [recordingError, setRecordingError] = useState<string | null>(null);
  const timeline = review?.timeline ?? live.timeline;
  const range = timeline && !Number.isNaN(timeline.start) ? timeline.range() : null;
  const playback = usePlayback(range, !review, review ? `rec:${review.info.name}` : `live:${timeline?.raid ?? "-"}`);
  const state: RadarState = useMemo(() => {
    // Live and at "now": the stream's state as is.
    if (!timeline || !range || (!review && playback.cursor === null)) return conn;
    const at = timeline.stateAt(playback.cursor ?? range[1]);
    return review ? { ...conn, connected: true, protocolMismatch: false, ...at } : { ...conn, ...at };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the timeline changes in place (liveVersion)
  }, [conn, timeline, review, playback.cursor, liveVersion]);
  /** The shown moment (the newest when live). */
  const at = playback.cursor ?? range?.[1] ?? null;
  const [trailPrefs, setTrailPrefs] = useTrailPrefs();

  const openRecording = (info: RecordingInfo) => {
    setLoadingRecording(info.name);
    setRecordingError(null);
    loadRecording(info.name).then(
      (t) => {
        setReview({ info, timeline: t });
        setLoadingRecording(null);
      },
      (e: unknown) => {
        setRecordingError(`Couldn't load ${info.name}: ${String(e)}`);
        setLoadingRecording(null);
      },
    );
  };
  const backToLive = () => {
    setReview(null);
    playback.seek(null);
  };

  const { catalog, status: catalogStatus } = useCatalog();
  const mapIndex = useMapIndex();
  const locationId = state.status?.state === "inRaid" ? state.status.locationId : null;
  const map = useRaidMap(mapIndex, locationId);
  const [layers, toggleLayer] = useLayers();
  const [follow, setFollow] = useState(true);
  const [camera] = useState(() => Object.assign(new View(), { zoom: 0.75 }));
  const [hovered, setHovered] = useState<Selection | null>(null);
  const [listPrefs, setListPrefs] = usePersistentState<ListPrefs>("radar.list", DEFAULT_PREFS);
  const list = useListRows(state, catalog, listPrefs.filters);

  // Side panel: open or collapsed, and which section it shows (for "list", the list tab in listPrefs).
  type Section = "list" | "timeline" | "map" | "raids" | "settings";
  const [storedUi, setUi] = usePersistentState<{ open: boolean; section: Section }>("radar.sidebar", {
    open: false,
    section: "list",
  });
  // Sections stored by older versions fall back to the list.
  const ui = (["list", "timeline", "map", "raids", "settings"] as string[]).includes(storedUi.section) ? storedUi : { ...storedUi, section: "list" as const };
  const view: ViewId = ui.section === "list" ? listPrefs.tab : ui.section;
  const listShown = ui.open && ui.section === "list";
  const togglePanel = () => setUi((u) => ({ ...u, open: !u.open }));
  const pickView = (v: ViewId) => {
    if (ui.open && v === view) return setUi((u) => ({ ...u, open: false }));
    if (v === "timeline" || v === "map" || v === "raids" || v === "settings") return setUi({ open: true, section: v });
    setListPrefs((p) => ({ ...p, tab: v }));
    setUi({ open: true, section: "list" });
  };

  // While the list is filtered, the map shows only what the filters let through (and us), panel open or not.
  const filtered = isFiltered(listPrefs.filters);
  const shown = useMemo(() => {
    if (!filtered) return state;
    const keys = rowKeys(list.rows);
    const has = (kind: Selection["kind"], id: number) => keys.has(selectionKey({ kind, id }));
    return {
      players: state.players.filter((p) => p.local || has("player", p.id)),
      loot: state.loot.filter((l) => has("loot", l.id)),
      exfils: state.exfils.filter((e) => has("exfil", e.id)),
      explosives: {
        grenades: state.explosives.grenades.filter((g) => has("grenade", g.id)),
        tripwires: state.explosives.tripwires.filter((w) => has("tripwire", w.id)),
      },
    };
  }, [state, filtered, list.rows]);

  // Floor picked by hand, per map: a new map starts on auto.
  const [floorPick, setFloorPick] = useState<{ map: LoadedMap | null; layer: number | null }>({ map: null, layer: null });
  const manualLayer = floorPick.map === map ? floorPick.layer : null;
  const local = state.players.find((p) => p.local && p.pos);
  const autoLayer = useAutoLayer(map, local?.pos?.[1] ?? null);
  const layer = map ? (manualLayer ?? autoLayer ?? 0) : 0;

  // Ids restart every raid: a selection from another raid (or recording) would point at something else.
  const raid = `${review?.info.name ?? "live"}:${state.status?.state === "inRaid" ? state.raid : null}`;
  const [picked, setPicked] = useState<{ raid: string | null; sel: Selection | null }>({ raid: null, sel: null });
  const selection = picked.raid === raid ? picked.sel : null;
  const select = (sel: Selection | null) => setPicked({ raid, sel });

  /** Selects something and brings it into view: centred, on its floor (back to auto on ours). */
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
    setFollow(false);
    const [u, v] = worldToPixel(map?.transform ?? NO_MAP_TRANSFORM, pos[0], pos[2]);
    // Centre it in the part of the map the side panel doesn't cover (unless the panel covers nearly all).
    const panel = document.getElementById("sidebar")?.getBoundingClientRect().right ?? 0;
    const canvas = document.getElementById("radar")?.getBoundingClientRect().left ?? 0;
    const covered = Math.max(0, panel - canvas);
    const shift = covered < camera.width * 0.7 ? covered / 2 : 0;
    camera.centerU = u - shift / camera.zoom;
    camera.centerV = v;
    if (map && map.config.layers.length > 1) {
      const floor = selectLayer(map.config.layers, pos[1], null, map.config.layerHysteresis);
      setFloorPick({ map, layer: floor === autoLayer ? null : floor });
    }
  };

  // Calibration: stand somewhere recognisable in game, click that spot on the map image: the click's
  // image pixel is paired with the local player's current world position. Two points give a
  // similarity transform; three or more a least-squares affine fit. Paste the output into map.json.
  const [calibrating, setCalibrating] = useState(false);
  const [calibPoints, setCalibPoints] = useState<ControlPoint[]>([]);
  const [calibError, setCalibError] = useState<string | null>(null);

  const addCalibrationPoint = (x: number, y: number, view: View) => {
    if (!map) return setCalibError("No map loaded for this location. Create its map folder first (see docs/maps.md).");
    if (!local?.pos) return setCalibError("No local player position yet: be in a raid first.");
    const [u, v] = view.toMap(x, y);
    const point: ControlPoint = { world: [round(local.pos[0], 2), round(local.pos[2], 2)], pixel: [round(u, 1), round(v, 1)] };
    setCalibPoints((pts) => [...pts, point]);
    setCalibError(null);
  };

  const onTap = (x: number, y: number, view: View) => {
    if (calibrating) addCalibrationPoint(x, y, view);
    else select(pick(view, map?.transform ?? NO_MAP_TRANSFORM, shown, layers, x, y));
  };

  const playbackRef = useRef(playback);
  playbackRef.current = playback;
  const rangeRef = useRef(range);
  rangeRef.current = range;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTyping(e) || e.ctrlKey || e.metaKey || e.altKey) return;
      const pb = playbackRef.current, r = rangeRef.current;
      if (e.key === "Escape") setPicked((p) => ({ ...p, sel: null }));
      else if (e.key === "f") setFollow((f) => !f);
      else if (e.key === "l") togglePanel();
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
    map,
    layer,
    players: shown.players,
    catalog,
    exfils: shown.exfils,
    explosives: shown.explosives,
    loot: shown.loot,
    layers,
    selected: selectedPosition(selection, state),
    hovered: listShown ? selectedPosition(hovered, state) : null,
    calibrationPixels: calibPoints.map((p) => p.pixel),
    trails: trailScene(),
  };

  const toggleCalibrate = () => {
    if (!calibrating) setFollow(false);
    setCalibrating(!calibrating);
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
          />
        );
      case "timeline":
        return (
          <TimelinePanel
            timeline={timeline}
            range={range}
            live={!review}
            recording={review?.info ?? null}
            loading={!review && live.backfilling}
            playback={playback}
            catalog={catalog}
            selection={selection}
            onPick={pickEvent}
            onClose={backToLive}
          />
        );
      case "map":
        return (
          <MapPanel
            trails={trailPrefs}
            onTrails={setTrailPrefs}
            floors={map?.config.layers.length ?? 0}
            layer={layer}
            manualLayer={manualLayer}
            onPickFloor={(l) => setFloorPick({ map, layer: l })}
            layers={layers}
            onToggleLayer={toggleLayer}
          />
        );
      case "raids":
        return (
          <RaidsPanel
            mapIndex={mapIndex}
            open={review?.info.name ?? null}
            loading={loadingRecording}
            error={recordingError}
            onOpen={openRecording}
            onLive={backToLive}
          />
        );
      case "settings":
        return (
          <SettingsPanel
            calibrating={calibrating}
            onToggleCalibrate={toggleCalibrate}
            calibrationOutput={calibError ?? formatCalibration(calibPoints)}
            onClearCalibration={() => {
              setCalibPoints([]);
              setCalibError(null);
            }}
          />
        );
    }
  };

  return (
    <>
      <RadarCanvas view={camera} scene={scene} follow={follow} onPan={() => setFollow(false)} onTap={onTap} />
      <ActivityBar
        active={ui.open ? view : null}
        onPick={pickView}
        badges={{
          players: list.rows.players.length,
          items: list.rows.items.length,
          containers: list.rows.containers.length,
          exfils: list.rows.exfils.length,
          explosives: list.rows.explosives.length,
          settings: calibrating,
        }}
      />
      {ui.open && (
        <SidePanel view={view} onClose={togglePanel}>
          {panelBody()}
        </SidePanel>
      )}
      <button
        id="follow"
        className={follow ? "active" : undefined}
        aria-pressed={follow}
        title={follow ? "Following you (F)" : "Follow the local player (F)"}
        onClick={() => setFollow((f) => !f)}
      >
        {follow ? <LocateFixed size={20} /> : <Locate size={20} />}
      </button>
      {selection && (
        <DetailsPanel
          selection={selection}
          state={state}
          catalog={catalog}
          history={timeline && range && at !== null ? { timeline, at, start: range[0], onPick: pickEvent } : null}
        />
      )}
      <StatusBar
        state={state}
        map={map}
        layer={layer}
        manualLayer={manualLayer}
        catalog={catalogStatus}
        timeline={
          timeline &&
          range && (
            <TimelineIndicator
              range={range}
              playback={playback}
              live={!review}
              open={ui.open && ui.section === "timeline"}
              onClick={() => pickView("timeline")}
            />
          )
        }
      >
        {!conn.live && !review && (
          <button className="item filtered" title="Open a recorded raid" onClick={() => setUi({ open: true, section: "raids" })}>
            ● open a recording
          </button>
        )}
        {filtered && (
          <button className="item filtered" title="The map shows filter matches only: open the list" onClick={() => setUi({ open: true, section: "list" })}>
            ● map filtered
          </button>
        )}
        {calibrating && (
          <button className="item calibrating" title="Open calibration settings" onClick={() => setUi({ open: true, section: "settings" })}>
            ● calibrating · {calibPoints.length} {calibPoints.length === 1 ? "point" : "points"}
          </button>
        )}
      </StatusBar>
    </>
  );
}

function round(v: number, digits: number): number {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}
