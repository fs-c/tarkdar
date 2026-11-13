// The 3D radar: the map (WebGL, map3d/Map3D) with a 2D canvas on top for everything that moves.
// The two are redrawn independently: the map only when its camera or settings change, the markers
// whenever the scene does. A camera that stands still costs the GPU nothing.

import { ChevronDown, ChevronUp } from "lucide-react";
import { type Ref, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState } from "react";
import { isTyping } from "../hooks";
import { Map3D, type MapStats } from "../map3d/Map3D";
import type { MapSettings } from "../map3d/settings";
import type { Projector } from "../projector";
import type { WorldPos } from "../protocol";
import { type Scene, renderMarkers } from "../render";
import { ui } from "../theme";
import s from "./Radar3D.module.css";

export interface Radar3DHandle {
  /** Flies there. */
  centerOn(pos: WorldPos): void;
  /** The current camera, for hit-testing markers. */
  projector(): Projector;
  /** The map surface under a canvas position: world position and what was hit. */
  pickSurface(x: number, y: number): { pos: WorldPos; mesh: string } | null;
  pose(): { position: WorldPos; target: WorldPos } | null;
}

interface Props {
  /** Dataset folder URL (/maps/3d/<folder>). */
  url: string;
  scene: Scene;
  settings: MapSettings;
  /** Keep the local player centred. Turning it on flies there. */
  follow: boolean;
  /** While following: also turn the map so that the local player's view direction points up. */
  heading: boolean;
  /** The user moved the map by hand: the caller turns follow off. */
  onPan: () => void;
  /** The user turned the map by hand: the caller turns heading off. */
  onTurn: () => void;
  /** Click without drag, in canvas CSS pixels. */
  onTap: (x: number, y: number) => void;
  /** Render statistics after each map frame (debugging); omit to skip the bookkeeping. */
  onStats?: (stats: MapStats) => void;
  ref?: Ref<Radar3DHandle>;
}

/** Metres of ground across the view when a map opens while following the local player. */
const FOLLOW_SPAN = 350;

/** Indoor maps: the floor shown follows the local player once they are this far (metres) above or below it. */
const FLOOR_FOLLOW = 0.4;
/** ... and the buttons move it by this much. */
const FLOOR_STEP = 1;

const MOVE_KEYS = new Set(["KeyW", "KeyA", "KeyS", "KeyD"]);

/** While following, the map is re-rendered at most this often (ms); markers update on every scene. */
const FOLLOW_INTERVAL = 33;
/** Flying to the local player from further out than this (metres across the view) also zooms in. */
const FLY_ZOOM_ABOVE = 600;


export function Radar3D({ url, scene, settings, follow, heading, onPan, onTurn, onTap, onStats, ref }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const mapRef = useRef<Map3D | null>(null);
  const latest = useRef({ scene, follow, heading, onPan, onTurn, onTap, onStats, settings });
  const drawRequested = useRef(0);
  const [status, setStatus] = useState<{ progress: number | null; error: string | null }>({ progress: 0, error: null });
  // Indoor maps are cut open at one floor: the local player's, or one picked by hand (a height).
  const [interior, setInterior] = useState(false);
  const [pickedFloor, setPickedFloor] = useState<number | null>(null);
  const playerFloor = useRef<number | null>(null);

  /** Markers onto the overlay, through the map's current camera. */
  const draw = () => {
    const canvas = overlayRef.current, map = mapRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx || !map) return;
    const dpr = window.devicePixelRatio || 1;
    const width = canvas.clientWidth, height = canvas.clientHeight;
    if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    if (!map.loaded) return;
    try {
      renderMarkers(ctx, map.projector(), latest.current.scene);
    } catch (e) {
      console.error("marker frame failed", e);
    }
  };
  const requestDraw = () => {
    if (drawRequested.current) return;
    drawRequested.current = requestAnimationFrame(() => {
      drawRequested.current = 0;
      draw();
    });
  };

  // The map: created once per dataset.
  useEffect(() => {
    const host = hostRef.current!;
    const map = new Map3D(host, Number.parseInt(ui.bg.slice(1), 16));
    mapRef.current = map;
    map.onRender = () => {
      draw(); // same frame as the map, so markers never lag behind the camera
      latest.current.onStats?.(map.stats);
    };
    map.onUserPan = () => latest.current.onPan();
    map.onUserTurn = () => latest.current.onTurn();
    let live = true;
    setStatus({ progress: 0, error: null });
    setInterior(false);
    setPickedFloor(null);
    playerFloor.current = null;
    map.load(url, (progress) => live && setStatus({ progress, error: null })).then(
      () => {
        if (!live) return;
        // Following someone: start close enough to read the surroundings, not on the whole map.
        if (latest.current.follow) map.setViewSpan(FOLLOW_SPAN);
        setInterior(map.interior);
        setStatus({ progress: null, error: null });
      },
      (e: unknown) => live && setStatus({ progress: null, error: e instanceof Error ? e.message : String(e) }),
    );
    return () => {
      live = false;
      cancelAnimationFrame(drawRequested.current);
      drawRequested.current = 0;
      map.dispose();
      mapRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- draw only reads refs
  }, [url]);

  useEffect(() => {
    if (status.progress === null) mapRef.current?.setSettings(settings);
  }, [settings, status.progress]);

  // Every render: new scene. Follow moves the map's camera (rate-limited, the map then redraws
  // the markers itself); otherwise only the markers are redrawn.
  const lastFollow = useRef(0);
  const wasFollowing = useRef(follow);
  const followTimer = useRef(0);
  useLayoutEffect(() => {
    latest.current = { scene, follow, heading, onPan, onTurn, onTap, onStats, settings };
    const map = mapRef.current;
    const local = follow ? scene.players.find((p) => p.local && p.pos)?.pos : null;
    // Follow turned on (not: the map opened while following): fly to the local player.
    const turnedOn = follow && !wasFollowing.current;
    wasFollowing.current = follow;
    if (turnedOn && map?.loaded && local) {
      const player = () => (latest.current.follow ? (latest.current.scene.players.find((p) => p.local && p.pos)?.pos ?? null) : null);
      map.flyTo(player, map.viewSpan() > FLY_ZOOM_ABOVE ? FOLLOW_SPAN : null);
    } else if (map?.loaded && local) {
      const recenter = () => {
        lastFollow.current = performance.now();
        const now = latest.current, map = mapRef.current;
        const player = now.follow ? now.scene.players.find((p) => p.local && p.pos) : null;
        if (!player?.pos || !map) return;
        // A flight ends on the player by itself.
        if (!map.flying) map.centerOn(player.pos);
        if (now.heading) map.turnTo(player.yaw);
      };
      window.clearTimeout(followTimer.current);
      const wait = FOLLOW_INTERVAL - (performance.now() - lastFollow.current);
      if (wait <= 0) recenter();
      else followTimer.current = window.setTimeout(recenter, wait);
    }
    if (map?.loaded && interior) {
      // Not every step of a staircase: only once they have left the floor shown.
      const y = scene.players.find((p) => p.local && p.pos)?.pos?.[1];
      if (y === undefined) playerFloor.current = null;
      else if (playerFloor.current === null || Math.abs(y - playerFloor.current) > FLOOR_FOLLOW) playerFloor.current = y;
      map.setFloor(pickedFloor ?? playerFloor.current);
    }
    requestDraw();
  });
  useEffect(() => () => window.clearTimeout(followTimer.current), []);

  /** One step up or down from the floor shown; from the whole map, down from its top. */
  const stepFloor = (direction: 1 | -1) => {
    const range = mapRef.current?.heights();
    if (!range) return;
    setPickedFloor((picked) => {
      const from = picked ?? playerFloor.current ?? range[1];
      return Math.min(range[1], Math.max(range[0], Math.round(from) + direction * FLOOR_STEP));
    });
  };
  useEffect(() => {
    if (!interior) return;
    const onKey = (e: KeyboardEvent) => {
      if (isTyping(e) || (e.key !== "PageUp" && e.key !== "PageDown")) return;
      e.preventDefault();
      stepFloor(e.key === "PageUp" ? 1 : -1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- stepFloor only reads refs
  }, [interior]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTyping(e)) return;
      if (e.key === "+" || e.key === "=") mapRef.current?.zoomBy(1.25);
      else if (e.key === "-") mapRef.current?.zoomBy(0.8);
      else if (e.key === "0") mapRef.current?.resetView();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // WASD scheme: held keys move the view. By key position (e.code), so it works on any layout.
  useEffect(() => {
    if (settings.controls !== "wasd") return;
    const held = new Set<string>();
    let fast = false;
    const apply = () => {
      const axis = (plus: string, minus: string) => (held.has(plus) ? 1 : 0) - (held.has(minus) ? 1 : 0);
      mapRef.current?.setMotion(axis("KeyD", "KeyA"), axis("KeyW", "KeyS"), fast);
    };
    const onKey = (e: KeyboardEvent) => {
      const down = e.type === "keydown";
      fast = e.shiftKey;
      if (MOVE_KEYS.has(e.code)) {
        if (down && (isTyping(e) || e.ctrlKey || e.metaKey || e.altKey)) return;
        if (down) held.add(e.code);
        else held.delete(e.code);
      }
      apply();
    };
    const release = () => {
      held.clear();
      apply();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("keyup", onKey);
    window.addEventListener("blur", release);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("keyup", onKey);
      window.removeEventListener("blur", release);
      release();
    };
  }, [settings.controls]);

  useImperativeHandle(ref, () => ({
    centerOn: (pos) => mapRef.current?.flyTo(() => pos),
    projector: () => mapRef.current?.projector() ?? { width: 0, height: 0, toScreen: () => [NaN, NaN], pxPerMetre: () => 0, detail: 0, depth: () => 0 },
    pickSurface: (x, y) => mapRef.current?.pick(x, y) ?? null,
    pose: () => mapRef.current?.pose() ?? null,
  }));

  // A click is a press and release in (nearly) the same place; anything else moves the map.
  const press = useRef<{ x: number; y: number } | null>(null);
  return (
    <div
      className={s.radar}
      ref={hostRef}
      onPointerDown={(e) => (press.current = e.button === 0 ? { x: e.clientX, y: e.clientY } : null)}
      onPointerUp={(e) => {
        const p = press.current;
        press.current = null;
        if (!p || Math.hypot(e.clientX - p.x, e.clientY - p.y) >= 4) return;
        const rect = e.currentTarget.getBoundingClientRect();
        latest.current.onTap(e.clientX - rect.left, e.clientY - rect.top);
      }}
      onContextMenu={(e) => e.preventDefault()}
    >
      <canvas className={s.markers} ref={overlayRef} />
      {interior && (
        <div className={s.floor} onPointerDown={(e) => e.stopPropagation()} onPointerUp={(e) => e.stopPropagation()}>
          <button title="Show a higher floor (Page Up)" onClick={() => stepFloor(1)}>
            <ChevronUp size={18} />
          </button>
          <button
            className={s.floorLevel}
            disabled={pickedFloor === null}
            title={pickedFloor === null ? "The map is cut open at your floor" : "Showing the floor at this height: click to follow your floor again"}
            onClick={() => setPickedFloor(null)}
          >
            {pickedFloor === null ? "Auto" : `${pickedFloor} m`}
          </button>
          <button title="Show a lower floor (Page Down)" onClick={() => stepFloor(-1)}>
            <ChevronDown size={18} />
          </button>
        </div>
      )}
      {status.progress !== null && <p className={s.status}>Loading the map… {Math.round(status.progress * 100)} %</p>}
      {status.error && <p className={s.status} data-tone="error">Couldn't load the 3D map: {status.error}</p>}
    </div>
  );
}
