// The radar: the map (WebGL, map3d/Map3D) with a 2D canvas on top for everything that moves.
// A location without a map gets a grid of world coordinates instead, with the same camera.
// The map is redrawn only when its camera or settings change, the markers whenever the scene does:
// a camera that stands still costs the GPU nothing. Both are drawn in the map's animation frame
// (Map3D.onFrame), where following also moves the camera: a frame on screen always shows the
// newest scene through the camera that belongs to it, and the markers are drawn once.

import { ChevronDown, ChevronUp } from "lucide-react";
import { type Ref, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState } from "react";
import { isTyping } from "../hooks";
import { Map3D, type MapStats } from "../map3d/Map3D";
import type { MapSettings } from "../map3d/settings";
import type { Projector } from "../projector";
import type { WorldPos } from "../protocol";
import { type Scene, renderMarkers } from "../render";
import { ui } from "../theme";
import s from "./Radar.module.css";

/** Turned less than this (radians) counts as north up. */
const NORTH_TOLERANCE = 0.01;

export interface RadarHandle {
  /** Flies there. */
  centerOn(pos: WorldPos): void;
  /** The current camera, for hit-testing markers. */
  projector(): Projector;
  /** The map surface under a canvas position: world position and what was hit. */
  pickSurface(x: number, y: number): { pos: WorldPos; mesh: string } | null;
  pose(): { position: WorldPos; target: WorldPos } | null;
}

interface Props {
  /** Dataset folder URL (/maps/3d/<folder>); null: no map for this location, a grid. */
  url: string | null;
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
  ref?: Ref<RadarHandle>;
}

/** Metres of ground across the view when a map opens while following the local player. */
const FOLLOW_SPAN = 350;

/** Indoor maps: the floor shown follows the local player once they are this far (metres) above or below it. */
const FLOOR_FOLLOW = 0.4;
/** ... and the buttons move it by this much. */
const FLOOR_STEP = 1;

const MOVE_KEYS = new Set(["KeyW", "KeyA", "KeyS", "KeyD"]);

/**
 * While following, a map whose frames are not cheap (the whole scene, not tiles) is moved at most
 * this often (ms). The markers wait with it: drawn through the camera of an older scene, the one
 * followed would leave the centre and jump back.
 */
const FOLLOW_INTERVAL = 33;
/** ... less this: display frames are not exactly evenly spaced. */
const FOLLOW_SLACK = 4;
/** Flying to the local player from further out than this (metres across the view) also zooms in. */
const FLY_ZOOM_ABOVE = 600;


export function Radar({ url, scene, settings, follow, heading, onPan, onTurn, onTap, onStats, ref }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const mapRef = useRef<Map3D | null>(null);
  const latest = useRef({ scene, follow, heading, onPan, onTurn, onTap, onStats, settings });
  const drawRequested = useRef(0);
  /** The scene changed since the markers were drawn. */
  const stale = useRef(false);
  const lastFollow = useRef(0);
  const [status, setStatus] = useState<{ progress: number | null; error: string | null }>({ progress: url ? 0 : null, error: null });
  // Indoor maps are cut open at one floor: the local player's, or one picked by hand (a height).
  const [interior, setInterior] = useState(false);
  const [pickedFloor, setPickedFloor] = useState<number | null>(null);
  const playerFloor = useRef<number | null>(null);
  // Turned away from north: a button turns it back (its needle points north on screen).
  const [rotated, setRotated] = useState(false);
  const needleRef = useRef<SVGSVGElement>(null);

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
    stale.current = false;
    if (!map.loaded) return;
    try {
      renderMarkers(ctx, map.projector(), latest.current.scene);
    } catch (e) {
      console.error("marker frame failed", e);
    }
  };
  /** Without a loaded map (which has no frames): the markers on a frame of their own. */
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
    // A new scene: following moves the camera to it first, then map and markers are drawn.
    map.onFrame = (now) => {
      if (!stale.current) return;
      const { scene, follow, heading } = latest.current;
      const player = follow ? scene.players.find((p) => p.local && p.pos) : undefined;
      if (player?.pos) {
        if (!map.cheapFrames && !map.renderDue && now - lastFollow.current < FOLLOW_INTERVAL - FOLLOW_SLACK) {
          map.requestFrame(); // too early for another costly frame: this scene, or a newer one, in a later one
          return;
        }
        lastFollow.current = now;
        // A flight ends on the player by itself.
        if (!map.flying) map.centerOn(player.pos);
        if (heading) map.turnTo(player.yaw);
      }
      // The camera stays where it is: only the markers.
      if (!map.renderDue) draw();
    };
    map.onRender = () => {
      draw(); // same frame as the map, so markers never lag behind the camera
      const heading = map.heading();
      const off = Math.abs(Math.atan2(Math.sin(heading), Math.cos(heading))) > NORTH_TOLERANCE;
      setRotated(off);
      if (needleRef.current) needleRef.current.style.transform = `rotate(${-heading}rad)`;
      latest.current.onStats?.(map.stats);
    };
    map.onUserPan = () => latest.current.onPan();
    map.onUserTurn = () => latest.current.onTurn();
    let live = true;
    setStatus({ progress: url ? 0 : null, error: null });
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

  // Every render: new scene, shown in the map's next frame (onFrame above).
  const wasFollowing = useRef(follow);
  useLayoutEffect(() => {
    latest.current = { scene, follow, heading, onPan, onTurn, onTap, onStats, settings };
    stale.current = true;
    const map = mapRef.current;
    // Follow turned on (not: the map opened while following): fly to the local player.
    const turnedOn = follow && !wasFollowing.current;
    wasFollowing.current = follow;
    if (turnedOn && map?.loaded && scene.players.some((p) => p.local && p.pos)) {
      const player = () => (latest.current.follow ? (latest.current.scene.players.find((p) => p.local && p.pos)?.pos ?? null) : null);
      map.flyTo(player, map.viewSpan() > FLY_ZOOM_ABOVE ? FOLLOW_SPAN : null);
    }
    if (map?.loaded && interior) {
      // Not every step of a staircase: only once they have left the floor shown.
      const y = scene.players.find((p) => p.local && p.pos)?.pos?.[1];
      if (y === undefined) playerFloor.current = null;
      else if (playerFloor.current === null || Math.abs(y - playerFloor.current) > FLOOR_FOLLOW) playerFloor.current = y;
      map.setFloor(pickedFloor ?? playerFloor.current);
    }
    if (map?.loaded) map.requestFrame();
    else requestDraw();
  });

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
      {rotated && (
        <button
          className={s.north}
          title="Turn the map north up (stops following your view direction)"
          onPointerDown={(e) => e.stopPropagation()}
          onPointerUp={(e) => e.stopPropagation()}
          onClick={() => {
            latest.current.onTurn();
            mapRef.current?.turnTo(0);
          }}
        >
          <svg
            ref={needleRef}
            style={{ transform: `rotate(${-(mapRef.current?.heading() ?? 0)}rad)` }}
            viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
            <path d="M12 2 L16 12 H8 Z" fill="var(--danger)" />
            <path d="M12 22 L8 12 H16 Z" fill="currentColor" />
          </svg>
        </button>
      )}
      {status.progress !== null && <p className={s.status}>Loading the map… {Math.round(status.progress * 100)} %</p>}
      {status.error && <p className={s.status} data-tone="error">Couldn't load the 3D map: {status.error}</p>}
    </div>
  );
}
