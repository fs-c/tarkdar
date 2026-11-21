import { type RefObject, useEffect, useRef, useState } from "react";
import type { MapStats, MapView } from "../map3d/Map3D";
import type { WorldPos } from "../model/protocol";
import type { MapEntry } from "../model/maps";
import { type Pickable, type Selection, pick } from "../draw/pick";
import type { Style } from "../rules/rules";
import { round } from "./format";
import type { RadarHandle } from "./Radar";

interface Options {
  radar: RefObject<RadarHandle | null>;
  map: MapEntry | null;
  /** What the map shows (for picking markers) and how it's styled. */
  shown: Pickable;
  styles: ReadonlyMap<string, Style>;
  /** The coordinate pick is on: a click that hits no marker records the map surface under it. */
  coordinatePick: boolean;
  select: (sel: Selection | null) => void;
}

/** Map debugging: picked world positions, and the render statistics readout (Settings view). */
export function useMapDebug({ radar, map, shown, styles, coordinatePick, select }: Options) {
  // Map debugging: with the coordinate pick on, a click that hits no marker records the world
  // position of the map surface under it, to describe where something on the map is wrong.
  const [debugPicks, setDebugPicks] = useState<{ pos: WorldPos; mesh: string }[]>([]);
  const onTap = (x: number, y: number) => {
    const r = radar.current;
    if (!r) return;
    const hit = pick(r.projector(), shown, styles, x, y);
    const surface = !hit && coordinatePick ? r.pickSurface(x, y) : null;
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

  return {
    debugPicks,
    clearPicks: () => setDebugPicks([]),
    onTap,
    pickOutput,
    mapStats,
    mapView,
    onMapStats,
  };
}
