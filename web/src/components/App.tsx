import { useEffect, useState } from "react";
import { type ControlPoint, formatCalibration } from "../calibration";
import { useAutoLayer, useCatalog, useConnection, useLayers, useMapIndex, useRaidMap } from "../hooks";
import type { LoadedMap } from "../maps";
import { type Selection, pick, selectedPosition } from "../pick";
import { NO_MAP_TRANSFORM, type Scene } from "../render";
import type { View } from "../view";
import { CalibrationPanel } from "./CalibrationPanel";
import { Controls } from "./Controls";
import { DetailsPanel } from "./DetailsPanel";
import { RadarCanvas } from "./RadarCanvas";
import { StatusBar } from "./StatusBar";

const WS_URL = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`;

export function App() {
  const state = useConnection(WS_URL);
  const { catalog, status: catalogStatus } = useCatalog();
  const mapIndex = useMapIndex();
  const locationId = state.status?.state === "inRaid" ? state.status.locationId : null;
  const map = useRaidMap(mapIndex, locationId);
  const [layers, toggleLayer] = useLayers();
  const [follow, setFollow] = useState(true);

  // Floor picked by hand, per map: a new map starts on auto.
  const [floorPick, setFloorPick] = useState<{ map: LoadedMap | null; layer: number | null }>({ map: null, layer: null });
  const manualLayer = floorPick.map === map ? floorPick.layer : null;
  const local = state.players.find((p) => p.local && p.pos);
  const autoLayer = useAutoLayer(map, local?.pos?.[1] ?? null);
  const layer = map ? (manualLayer ?? autoLayer ?? 0) : 0;

  // Ids restart every raid: a selection from the previous raid would point at something else.
  const raid = state.status?.state === "inRaid" ? state.raid : null;
  const [picked, setPicked] = useState<{ raid: number | null; sel: Selection | null }>({ raid: null, sel: null });
  const selection = picked.raid === raid ? picked.sel : null;
  const select = (sel: Selection | null) => setPicked({ raid, sel });

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
    else select(pick(view, map?.transform ?? NO_MAP_TRANSFORM, state, layers, x, y));
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setPicked((p) => ({ ...p, sel: null }));
      else if (e.key === "f" && !(e.target instanceof HTMLTextAreaElement)) setFollow((f) => !f);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const scene: Scene = {
    map,
    layer,
    players: state.players,
    catalog,
    exfils: state.exfils,
    explosives: state.explosives,
    loot: state.loot,
    layers,
    selected: selectedPosition(selection, state),
    calibrationPixels: calibPoints.map((p) => p.pixel),
  };

  return (
    <>
      <RadarCanvas scene={scene} follow={follow} onPan={() => setFollow(false)} onTap={onTap} />
      <div id="hud">
        <StatusBar state={state} map={map} layer={layer} manualLayer={manualLayer} catalog={catalogStatus} />
        <Controls
          follow={follow}
          onToggleFollow={() => setFollow((f) => !f)}
          floors={map?.config.layers.length ?? 0}
          layer={layer}
          manualLayer={manualLayer}
          onPickFloor={(l) => setFloorPick({ map, layer: l })}
          layers={layers}
          onToggleLayer={toggleLayer}
          calibrating={calibrating}
          onToggleCalibrate={() => {
            if (!calibrating) setFollow(false);
            setCalibrating(!calibrating);
          }}
        />
      </div>
      {selection && <DetailsPanel selection={selection} state={state} catalog={catalog} />}
      {calibrating && (
        <CalibrationPanel
          output={calibError ?? formatCalibration(calibPoints)}
          onClear={() => {
            setCalibPoints([]);
            setCalibError(null);
          }}
        />
      )}
    </>
  );
}

function round(v: number, digits: number): number {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}
