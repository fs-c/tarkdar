// Experimental: the local player's view, drawn as points projected through the camera the backend
// reads (`camera` message): players as upright lines, loot as dots, exfils, and a grid on the ground
// around the player, next to a debug readout of the camera. For checking the camera offsets against the game: what's in the
// game's view should line up with what's drawn here.
// While scoped, the marks are drawn through the scope's view over the whole canvas (pov/projection.ts).

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Connection, type RadarState, wsUrl } from "../stream/connection";
import { type ScopeView, mainView, project, scopeView, toPixels } from "../pov/projection";
import type { CameraData, WorldPos } from "../model/protocol";
import { ui } from "../draw/theme";
import s from "./PovPage.module.css";

/** Player height drawn (m). */
const BODY = 1.8;
/** Loot and grid further than this (m) aren't drawn. */
const LOOT_RANGE = 150;
const GRID_RANGE = 60;
const GRID_STEP = 5;
/** Radius of the lens outline drawn while scoped, as a share of the view's height. */
const SCOPE_RADIUS = 0.36;

const SIDE_COLORS: Record<string, string> = { usec: ui.link, bear: ui.danger, savage: ui.gold };

interface Layers {
  grid: boolean;
  loot: boolean;
}

export function PovPage() {
  const [conn] = useState(() => new Connection(wsUrl()));
  useEffect(() => {
    conn.start();
    return () => conn.stop();
  }, [conn]);
  const state = useSyncExternalStore(conn.subscribe, conn.getState);
  const camera = useSyncExternalStore(conn.subscribeCamera, conn.getCamera);
  const [layers, setLayers] = useState<Layers>({ grid: true, loot: true });

  const canvas = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  useEffect(() => {
    const el = canvas.current?.parentElement;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const c = canvas.current;
    if (!c || !size.w || !size.h) return;
    const frame = requestAnimationFrame(() => draw(c, size, state, camera, layers));
    return () => cancelAnimationFrame(frame);
  }, [size, state, camera, layers]);

  return (
    <div className={s.page}>
      <div className={s.view}>
        <canvas ref={canvas} />
      </div>
      <aside className={s.panel}>
        <a href="#">← Radar</a>
        <h3>Player's view (experimental)</h3>
        <Readout state={state} camera={camera} />
        <label>
          <input type="checkbox" checked={layers.grid} onChange={() => setLayers((l) => ({ ...l, grid: !l.grid }))} /> Ground grid
        </label>
        <label>
          <input type="checkbox" checked={layers.loot} onChange={() => setLayers((l) => ({ ...l, loot: !l.loot }))} /> Loot
        </label>
      </aside>
    </div>
  );
}

function Readout({ state, camera }: { state: RadarState; camera: CameraData | null }) {
  const fmt = (v: number | undefined, digits = 1) => (v === undefined ? "?" : v.toFixed(digits));
  const pos = (p: WorldPos | undefined) => (p ? p.map((c) => c.toFixed(1)).join(", ") : "?");
  const lines: [string, string][] = [
    ["backend", state.connected ? (state.status?.state ?? "connected") : "disconnected"],
  ];
  if (!camera) lines.push(["camera", "no data (not in a raid, or a backend without camera support)"]);
  else {
    lines.push(["FPS camera", camera.fps ? `at ${pos(camera.fps.pos)}, fov ${fmt(camera.fps.fov)}°, aspect ${fmt(camera.fps.aspect, 3)}` : "not found"]);
    lines.push(["aiming", camera.aiming ? "yes" : "no"]);
    if (camera.aiming) {
      lines.push(["scoped", camera.scoped ? `yes, ${camera.magnification.toFixed(2)}×` : "no"]);
      camera.sights.forEach((sight, i) =>
        lines.push([
          `sight ${i}${i === camera.active ? " (active)" : ""}`,
          `${sight.zoom.toFixed(2)}×${sight.max ? ` (${sight.min}–${sight.max})` : ""}, scope ${sight.scope} mode ${sight.mode}${sight.current ? ", looked through" : ""}`,
        ]),
      );
    }
    if (camera.scoped)
      lines.push(["optic camera", camera.optic ? `fov ${fmt(camera.optic.fov)}°, aspect ${fmt(camera.optic.aspect, 3)}` : "not read: inset zooms the FPS view"]);
  }
  return (
    <dl className={s.readout}>
      {lines.map(([k, v]) => (
        <div key={k}>
          <dt>{k}</dt>
          <dd>{v}</dd>
        </div>
      ))}
    </dl>
  );
}

/** Something to draw at a world point. */
interface Mark {
  pos: WorldPos;
  color: string;
  kind: "player" | "dot" | "exfil" | "grid";
  label?: string;
}

function marks(state: RadarState, camera: CameraData, layers: Layers): Mark[] {
  const eye = camera.fps?.pos;
  const near = (p: WorldPos, range: number) => !eye || Math.hypot(p[0] - eye[0], p[2] - eye[2]) <= range;
  const out: Mark[] = [];
  const local = state.players.find((p) => p.local);
  if (layers.grid && eye) {
    const y = local?.pos?.[1] ?? eye[1] - 1.6;
    const x0 = Math.round(eye[0] / GRID_STEP) * GRID_STEP, z0 = Math.round(eye[2] / GRID_STEP) * GRID_STEP;
    for (let dx = -GRID_RANGE; dx <= GRID_RANGE; dx += GRID_STEP)
      for (let dz = -GRID_RANGE; dz <= GRID_RANGE; dz += GRID_STEP) out.push({ pos: [x0 + dx, y, z0 + dz], color: ui.faint, kind: "grid" });
  }
  if (layers.loot)
    for (const l of state.loot) {
      if (!near(l.pos, LOOT_RANGE)) continue;
      const color = l.kind === "quest" ? ui.quest : l.kind === "item" ? ui.text : ui.muted;
      out.push({ pos: l.pos, color, kind: "dot", label: l.kind === "quest" ? "quest item" : undefined });
    }
  for (const e of state.exfils) if (e.pos) out.push({ pos: e.pos, color: ui.accent, kind: "exfil", label: e.name });
  for (const p of state.players) {
    if (p.local || !p.pos || p.absent) continue;
    out.push({ pos: p.pos, color: p.dead ? ui.faint : (SIDE_COLORS[p.side] ?? ui.text), kind: "player", label: p.dead ? "dead" : p.ai ? p.side : `${p.side} (human)` });
  }
  return out;
}

/** A world point on the canvas: pixels, and the distance along the view (m). */
interface ScreenPoint {
  x: number;
  y: number;
  depth: number;
}

/** How a view maps world points onto the canvas, and which canvas points it shows. */
interface Painter {
  toScreen: (p: WorldPos) => ScreenPoint | null;
  visible: (x: number, y: number) => boolean;
}

function drawMarks(ctx: CanvasRenderingContext2D, all: Mark[], painter: Painter) {
  const { toScreen, visible } = painter;
  for (const m of all) {
    const p = toScreen(m.pos);
    ctx.fillStyle = ctx.strokeStyle = m.color;
    if (m.kind === "player") {
      // Feet to head: drawn if either end shows (aiming at the chest through a scope, the feet don't).
      const head = toScreen([m.pos[0], m.pos[1] + BODY, m.pos[2]]);
      const shown = [p, head].filter((q): q is ScreenPoint => !!q && visible(q.x, q.y));
      if (!shown.length || !p || !head) continue;
      const size = Math.max(2, Math.min(10, 60 / head.depth));
      ctx.lineWidth = Math.max(2, size / 2);
      ctx.beginPath();
      ctx.moveTo(p.x, p.y);
      ctx.lineTo(head.x, head.y);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(head.x, head.y, size / 1.5, 0, Math.PI * 2);
      ctx.fill();
      label(ctx, m, shown[0]!, size);
      continue;
    }
    if (!p || !visible(p.x, p.y)) continue;
    const size = Math.max(2, Math.min(10, 60 / p.depth));
    if (m.kind === "grid") {
      ctx.globalAlpha = Math.max(0.15, 1 - p.depth / GRID_RANGE);
      ctx.fillRect(p.x - 1, p.y - 1, 2, 2);
      ctx.globalAlpha = 1;
      continue;
    }
    ctx.beginPath();
    if (m.kind === "exfil") {
      ctx.moveTo(p.x, p.y - size), ctx.lineTo(p.x + size, p.y), ctx.lineTo(p.x, p.y + size), ctx.lineTo(p.x - size, p.y), ctx.closePath();
    } else {
      ctx.arc(p.x, p.y, size / 3, 0, Math.PI * 2);
    }
    ctx.fill();
    label(ctx, m, p, size);
  }
}

function label(ctx: CanvasRenderingContext2D, m: Mark, at: ScreenPoint, size: number) {
  if (!m.label) return;
  ctx.font = "12px system-ui, sans-serif";
  ctx.fillText(`${m.label} ${Math.round(at.depth)} m`, at.x + size + 3, at.y);
}

function draw(c: HTMLCanvasElement, size: { w: number; h: number }, state: RadarState, camera: CameraData | null, layers: Layers) {
  const dpr = window.devicePixelRatio || 1;
  // The game's aspect, letterboxed into the available space.
  const aspect = camera?.fps?.aspect ?? 16 / 9;
  const w = Math.min(size.w, size.h * aspect), h = w / aspect;
  const pw = Math.round(w * dpr), ph = Math.round(h * dpr);
  if (c.width !== pw || c.height !== ph) {
    c.style.width = `${w}px`;
    c.style.height = `${h}px`;
    c.width = pw;
    c.height = ph;
  }
  const ctx = c.getContext("2d");
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = ui.bg;
  ctx.fillRect(0, 0, w, h);
  const view = mainView(camera);
  if (!camera || !view) {
    ctx.fillStyle = ui.muted;
    ctx.font = "14px system-ui, sans-serif";
    ctx.fillText("No camera: waiting for the backend's camera message.", 16, 28);
    return;
  }
  const all = marks(state, camera, layers);
  const margin = 0.1; // NDC: a little past the edges, so labels of marks just outside still show
  drawMarks(ctx, all, {
    toScreen: (p) => {
      const q = project(view.vp, p);
      if (!q) return null;
      const [x, y] = toPixels(q, w, h);
      return { x, y, depth: q.depth };
    },
    visible: (x, y) => x >= -margin * w && x <= (1 + margin) * w && y >= -margin * h && y <= (1 + margin) * h,
  });

  // Crosshair.
  ctx.strokeStyle = ui.muted;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(w / 2 - 6, h / 2), ctx.lineTo(w / 2 + 6, h / 2), ctx.moveTo(w / 2, h / 2 - 6), ctx.lineTo(w / 2, h / 2 + 6);
  ctx.stroke();

  const scope = scopeView(camera);
  if (scope) drawScope(ctx, scope, all, camera, w, h);
}

function drawScope(ctx: CanvasRenderingContext2D, scope: ScopeView, all: Mark[], camera: CameraData, w: number, h: number) {
  // Like the game's scoped view: the scope's picture over the whole view (as the reference draws it;
  // the lens's real size depends on the scope model), the unscoped marks dimmed beneath.
  const r = h * SCOPE_RADIUS;
  ctx.fillStyle = ui.overlay;
  ctx.fillRect(0, 0, w, h);
  drawMarks(ctx, all, {
    toScreen: (p) => {
      const o = scope.project(p);
      return o && { x: w / 2 + o.dx * h, y: h / 2 - o.dy * h, depth: o.depth };
    },
    visible: (x, y) => x >= -0.1 * w && x <= 1.1 * w && y >= -0.1 * h && y <= 1.1 * h,
  });
  // A lens outline and reticle, for orientation only.
  ctx.strokeStyle = ui.muted;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(w / 2 - r, h / 2), ctx.lineTo(w / 2 + r, h / 2), ctx.moveTo(w / 2, h / 2 - r), ctx.lineTo(w / 2, h / 2 + r);
  ctx.stroke();
  ctx.strokeStyle = ui.borderStrong;
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.arc(w / 2, h / 2, r, 0, Math.PI * 2);
  ctx.stroke();
  ctx.fillStyle = ui.text;
  ctx.font = "12px system-ui, sans-serif";
  ctx.fillText(`${camera.magnification.toFixed(1)}× · ${scope.source === "optic" ? "optic camera" : "zoomed FPS view"}`, w / 2 - r, h / 2 + r + 16);
}
