// Draws the radar: map layer (or a world grid when there's no map), players, calibration markers.

import { type Affine, pixelsPerMetre, worldToPixel } from "./calibration";
import { LabelPlacer, candidatesAround } from "./labels";
import { type LoadedMap, selectLayer } from "./maps";
import { type ItemCatalog, type ValueTier, containerName, exfilStatus, formatPrice, valueTier } from "./items";
import type { Exfil, ExplosivesData, LootEntry, Player } from "./protocol";
import { type PlayerType, type PlayerTypeInfo, MINOR_TYPES, SPECIAL_TYPES, bossGroups, playerType } from "./roles";
import { ui } from "./theme";
import type { Timeline } from "./timeline";
import { type Projector, flatProjector } from "./projector";
import type { View } from "./view";

/** Used when there's no map for the location: 2 px per metre, north up, world origin at (0, 0). */
export const NO_MAP_TRANSFORM: Affine = { a: 2, b: 0, c: 0, d: 0, e: -2, f: 0 };

export const COLORS = {
  background: ui.bg,
  grid: "#1f2a33",
  gridLabel: "#4d5d6b",
  local: ui.accent,
  dead: "#6b6b6b",
  label: "#e8eef2",
  labelHalo: "rgba(8, 12, 16, 0.85)",
  calibration: "#ff4fd8",
  lootQuest: ui.quest,
  lootContainer: "#b08a5a",
  lootAirdrop: "#4de1ff",
  lootCorpse: "#9a9a9a",
  exfilOpen: ui.accent,
  exfilClosed: ui.danger,
  exfilPending: ui.warn,
  exfilNeutral: "#e8eef2",
  exfilSecret: ui.secret,
  danger: "#ff3b30",
};

/** Player colours by type (roles.ts). */
export const TYPE_COLORS: Record<PlayerType, string> = {
  self: ui.accent,
  usec: ui.link,
  bear: ui.danger,
  "p-scav": ui.gold,
  "ai-scav": ui.gold,
  boss: "#ff4fd8",
  follower: ui.warn,
  raider: "#4de1ff",
  rogue: "#38e8c0",
  cultist: "#b26bff",
  bd: "#ff7a1a",
  zombie: "#9bd14b",
  other: "#c0c0c0",
};

/** Loose item markers by value tier: colour and side length (px). */
const ITEM_MARKERS: Record<ValueTier, { color: string; size: number }> = {
  low: { color: "#8b969f", size: 3 },
  mid: { color: "#e8eef2", size: 4 },
  high: { color: ui.gold, size: 5 },
};

/** Item labels show from this level of detail on (and then only where they fit). */
const ITEM_LABEL_ZOOM = 2.5;

export interface Layers {
  loot: boolean;
  containers: boolean;
  exfils: boolean;
  explosives: boolean;
}

export interface Scene {
  map: LoadedMap | null;
  layer: number;
  players: Player[];
  catalog: ItemCatalog;
  exfils: Exfil[];
  explosives: ExplosivesData;
  loot: LootEntry[];
  layers: Layers;
  /** Items worth less than this (₽) get no label. */
  minLabelPrice: number;
  selected: [number, number, number] | null;
  /** Hovered in the list view: drawn as a soft highlight. */
  hovered: [number, number, number] | null;
  calibrationPixels: [number, number][];
  /** World positions picked with the coordinate tool (3D map debugging), drawn numbered. */
  debugPoints: [number, number, number][];
  trails: TrailScene | null;
}

/** Where players have been: drawn from the timeline's tracks up to `at`. */
export interface TrailScene {
  timeline: Timeline;
  at: number;
  /** Players to draw a trail for, and from when (ms; -Infinity: the whole raid). */
  since: Map<number, number>;
  /** Drawn bolder. */
  selected: number | null;
}

/** The 2D radar: map image (or world grid), markers, calibration crosses. */
export function render(ctx: CanvasRenderingContext2D, view: View, scene: Scene): void {
  const transform = scene.map?.transform ?? NO_MAP_TRANSFORM;
  ctx.fillStyle = COLORS.background;
  ctx.fillRect(0, 0, view.width, view.height);

  const image = scene.map?.images[scene.layer] ?? null;
  if (image) {
    const [x, y] = view.toScreen(0, 0);
    ctx.imageSmoothingEnabled = view.zoom < 2;
    ctx.drawImage(image, x, y, image.naturalWidth * view.zoom, image.naturalHeight * view.zoom);
  } else {
    drawGrid(ctx, view, transform);
  }

  renderMarkers(ctx, flatProjector(view, transform), scene);

  for (const [u, v] of scene.calibrationPixels) {
    const [x, y] = view.toScreen(u, v);
    ctx.strokeStyle = COLORS.calibration;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(x - 8, y);
    ctx.lineTo(x + 8, y);
    ctx.moveTo(x, y - 8);
    ctx.lineTo(x, y + 8);
    ctx.stroke();
  }
}

/**
 * Everything that moves: loot, exfils, explosives, trails, players, selection. Drawn in screen
 * space through the projector, so it is the same code over the 2D image and over the 3D map.
 */
export function renderMarkers(ctx: CanvasRenderingContext2D, pr: Projector, scene: Scene): void {
  if (scene.layers.loot || scene.layers.containers) drawLoot(ctx, pr, scene);
  if (scene.layers.exfils) for (const e of scene.exfils) drawExfil(ctx, pr, e);
  if (scene.layers.explosives) drawExplosives(ctx, pr, scene.explosives);

  if (scene.trails) drawTrails(ctx, pr, scene);

  const local = scene.players.find((p) => p.local && p.pos);
  const groups = bossGroups(scene.players);
  const typed = scene.players.map((p) => ({ p, info: playerType(p, groups) }));
  // Drawn bottom to top: plain scavs, the dead, everyone else, special bots, us.
  const rank = ({ p, info }: { p: Player; info: PlayerTypeInfo }) =>
    p.local ? 4 : p.dead ? 1 : MINOR_TYPES.has(info.type) ? 0 : SPECIAL_TYPES.has(info.type) ? 3 : 2;
  typed.sort((a, b) => rank(a) - rank(b));
  for (const { p, info } of typed) drawPlayer(ctx, pr, p, info, local?.pos?.[1] ?? null);

  if (scene.hovered) {
    const [x, y] = pr.toScreen(scene.hovered);
    ctx.fillStyle = "rgba(255, 255, 255, 0.18)";
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(x, y, 18, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }

  if (scene.selected) {
    const [x, y] = pr.toScreen(scene.selected);
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = 1.5;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.arc(x, y, 13, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  scene.debugPoints.forEach((pos, i) => {
    const [x, y] = pr.toScreen(pos);
    ctx.strokeStyle = COLORS.calibration;
    ctx.fillStyle = COLORS.calibration;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(x - 7, y);
    ctx.lineTo(x + 7, y);
    ctx.moveTo(x, y - 7);
    ctx.lineTo(x, y + 7);
    ctx.stroke();
    ctx.font = "bold 11px sans-serif";
    ctx.fillText(String(i + 1), x + 6, y - 6);
  });
}

const TRAIL_BUCKETS = 6;

/** Trails fade with age (in TRAIL_BUCKETS steps); parts on other floors than the shown one are dimmed. */
function drawTrails(ctx: CanvasRenderingContext2D, pr: Projector, scene: Scene): void {
  const { timeline, at, since, selected } = scene.trails!;
  const groups = bossGroups(scene.players);
  const floors = scene.map && scene.map.config.layers.length > 1 ? scene.map.config.layers : null;
  const otherFloor = (y: number) => floors !== null && selectLayer(floors, y, null, 0) !== scene.layer;
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  for (const [id, from] of since) {
    const track = timeline.tracks.get(id);
    if (!track) continue;
    const kept = track.trailIndices();
    // First kept sample at or after `from`.
    let lo = 0, hi = kept.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (track.timeOf(kept[mid]!) < from) lo = mid + 1;
      else hi = mid;
    }
    const points: { t: number; x: number; y: number; wy: number }[] = [];
    for (let k = lo; k < kept.length; k++) {
      const i = kept[k]!;
      const ti = track.timeOf(i);
      if (ti > at) break;
      const [wx, wy, wz] = track.posOf(i);
      const [x, y] = pr.toScreen([wx, wy, wz]);
      points.push({ t: ti, x, y, wy });
    }
    const pose = track.poseAt(at);
    if (pose && points.length) {
      const [x, y] = pr.toScreen(pose.pos);
      points.push({ t: at, x, y, wy: pose.pos[1] });
    }
    if (points.length < 2) continue;

    const isSelected = id === selected;
    const start = points[0]!.t;
    const span = Math.max(1, at - start);
    const paths = Array.from({ length: TRAIL_BUCKETS * 2 }, () => new Path2D());
    for (let k = 1; k < points.length; k++) {
      const a = points[k - 1]!, b = points[k]!;
      const bucket = Math.min(TRAIL_BUCKETS - 1, Math.floor(((b.t - start) / span) * TRAIL_BUCKETS));
      const path = paths[bucket + (otherFloor(b.wy) ? TRAIL_BUCKETS : 0)]!;
      path.moveTo(a.x, a.y);
      path.lineTo(b.x, b.y);
    }
    const type = playerType(track.meta, groups).type;
    ctx.strokeStyle = TYPE_COLORS[type];
    ctx.lineWidth = isSelected ? 2.5 : 1.5;
    const maxAlpha = isSelected ? 0.95 : MINOR_TYPES.has(type) ? 0.35 : 0.6;
    paths.forEach((path, i) => {
      const bucket = i % TRAIL_BUCKETS;
      const age = 0.25 + (0.75 * (bucket + 1)) / TRAIL_BUCKETS;
      ctx.globalAlpha = maxAlpha * age * (i >= TRAIL_BUCKETS ? 0.3 : 1);
      ctx.stroke(path);
    });
    ctx.globalAlpha = 1;
  }
}

function drawGrid(ctx: CanvasRenderingContext2D, view: View, t: Affine): void {
  const stepMetres = 50;
  const stepPx = stepMetres * pixelsPerMetre(t) * view.zoom;
  if (stepPx < 8) return;
  ctx.strokeStyle = COLORS.grid;
  ctx.fillStyle = COLORS.gridLabel;
  ctx.lineWidth = 1;
  ctx.font = "11px sans-serif";
  // NO_MAP_TRANSFORM is axis-aligned, so lines of constant world x/z are vertical/horizontal.
  const [x0] = view.toScreen(...worldToPixel(t, 0, 0));
  const [, y0] = view.toScreen(...worldToPixel(t, 0, 0));
  const first = (origin: number) => origin - Math.ceil(origin / stepPx) * stepPx;
  for (let x = first(x0); x < view.width; x += stepPx) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, view.height);
    ctx.stroke();
    ctx.fillText(`x ${Math.round(((x - x0) / stepPx) * stepMetres)}`, x + 3, 12);
  }
  for (let y = first(y0); y < view.height; y += stepPx) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(view.width, y);
    ctx.stroke();
    ctx.fillText(`z ${Math.round((-(y - y0) / stepPx) * stepMetres)}`, 3, y - 3);
  }
}

function drawPlayer(ctx: CanvasRenderingContext2D, pr: Projector, p: Player, info: PlayerTypeInfo, localY: number | null): void {
  if (!p.pos) return;
  const [x, y] = pr.toScreen(p.pos);
  if (!onScreen(pr, x, y)) return;

  // Plain AI scavs are many and rarely what matters: smaller and fainter, so PMCs and player scavs
  // stand out. Bosses, guards, raiders, rogues and cultists get a halo and their name.
  const scav = MINOR_TYPES.has(info.type);
  const special = SPECIAL_TYPES.has(info.type);
  const boss = info.type === "boss";
  const color = p.dead ? COLORS.dead : TYPE_COLORS[info.type];
  ctx.globalAlpha = (p.absent ? 0.35 : 1) * (scav ? 0.55 : 1);
  const r = p.local || boss ? 7 : scav ? 4 : 5.5;

  if (p.dead) {
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(x - r, y - r);
    ctx.lineTo(x + r, y + r);
    ctx.moveTo(x + r, y - r);
    ctx.lineTo(x - r, y + r);
    ctx.stroke();
  } else {
    // Facing: yaw 0 = world +z, 90 = world +x (assumed Unity convention; see the verification
    // playbook). A point one metre ahead goes through the projection, so rotated maps and a
    // rotated 3D camera work too.
    const yaw = (p.yaw * Math.PI) / 180;
    const [ax, ay] = pr.toScreen([p.pos[0] + Math.sin(yaw), p.pos[1], p.pos[2] + Math.cos(yaw)]);
    const du = Number.isFinite(ax) ? ax - x : 0, dv = Number.isFinite(ay) ? ay - y : 0;
    const len = Math.hypot(du, dv) || 1;
    const lineLen = p.local ? 28 : scav ? 11 : 18;
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + (du / len) * lineLen, y + (dv / len) * lineLen);
    ctx.stroke();

    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = "#000";
    ctx.lineWidth = 1;
    ctx.stroke();
    if (special) {
      // A halo, so they stand out even among a crowd.
      ctx.strokeStyle = color;
      ctx.lineWidth = boss ? 2 : 1.5;
      ctx.beginPath();
      ctx.arc(x, y, r + (boss ? 4 : 3), 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  if (!p.local) {
    let label = special ? `${info.label} ${p.id}` : `${p.id}`;
    if (localY !== null) {
      const dy = p.pos[1] - localY;
      if (Math.abs(dy) >= 2) label += dy > 0 ? ` ▲${Math.round(dy)}` : ` ▼${Math.round(-dy)}`;
    }
    ctx.fillStyle = special && !p.dead ? color : COLORS.label;
    ctx.font = scav ? "10px sans-serif" : boss ? "bold 12px sans-serif" : "11px sans-serif";
    haloText(ctx, label, x + r + (special ? 7 : 3), y + 4);
  }
  ctx.globalAlpha = 1;
}

/** Text with a dark outline, so it reads on the dark 2D background and on the light 3D map alike. */
function haloText(ctx: CanvasRenderingContext2D, text: string, x: number, y: number): void {
  ctx.lineJoin = "round";
  ctx.lineWidth = 3;
  ctx.strokeStyle = COLORS.labelHalo;
  ctx.strokeText(text, x, y);
  ctx.fillText(text, x, y);
  ctx.lineJoin = "miter";
}

/** False for positions off the canvas, and for NaN (not projectable, see Projector). */
function onScreen(pr: Projector, x: number, y: number, margin = 50): boolean {
  return x >= -margin && y >= -margin && x <= pr.width + margin && y <= pr.height + margin;
}

/** A loot label waiting for placement: `texts` from most to least detailed, tried in that order. */
interface LabelRequest {
  x: number;
  y: number;
  texts: string[];
  /** Always drawn (quest items, airdrops, containers), placed before everything else. */
  forced: boolean;
  /** Higher places first. */
  priority: number;
}

const LOOT_FONT = "10px sans-serif";
const LABEL_HEIGHT = 12;
const LABEL_GAP = 6;
const textWidths = new Map<string, number>();

function textWidth(ctx: CanvasRenderingContext2D, text: string): number {
  let w = textWidths.get(text);
  if (w === undefined) {
    w = ctx.measureText(text).width;
    textWidths.set(text, w);
  }
  return w;
}

function drawLoot(ctx: CanvasRenderingContext2D, pr: Projector, { loot, layers, catalog, minLabelPrice }: Scene): void {
  const containerLabels = pr.detail >= 1.5;
  const itemLabels = pr.detail >= ITEM_LABEL_ZOOM;
  const requests: LabelRequest[] = [];
  for (const l of loot) {
    const isContainer = l.kind === "container" || l.kind === "airdrop";
    if (isContainer ? !layers.containers : !layers.loot) continue;
    const [x, y] = pr.toScreen(l.pos);
    if (!onScreen(pr, x, y, 10)) continue;
    switch (l.kind) {
      case "item": {
        const info = catalog.lookup(l.tpl);
        const price = info?.price;
        const marker = ITEM_MARKERS[valueTier(price)];
        ctx.fillStyle = marker.color;
        ctx.fillRect(x - marker.size / 2, y - marker.size / 2, marker.size, marker.size);
        if (info && itemLabels && (price ?? 0) >= minLabelPrice) {
          const texts = info.price ? [`${info.shortName} ${formatPrice(info.price)}`, formatPrice(info.price)] : [info.shortName];
          requests.push({ x, y, texts, forced: false, priority: info.price ?? 0 });
        }
        break;
      }
      case "quest":
        ctx.fillStyle = COLORS.lootQuest;
        ctx.beginPath();
        ctx.moveTo(x, y - 5);
        ctx.lineTo(x + 5, y);
        ctx.lineTo(x, y + 5);
        ctx.lineTo(x - 5, y);
        ctx.fill();
        requests.push({ x, y, texts: ["quest item"], forced: true, priority: 2 });
        break;
      case "container": {
        ctx.strokeStyle = COLORS.lootContainer;
        ctx.lineWidth = 1.5;
        ctx.strokeRect(x - 3, y - 3, 6, 6);
        const name = containerName(l.tpl);
        if (name && containerLabels) requests.push({ x, y, texts: [name], forced: true, priority: 0 });
        break;
      }
      case "airdrop":
        ctx.fillStyle = COLORS.lootAirdrop;
        ctx.fillRect(x - 5, y - 5, 10, 10);
        requests.push({ x, y, texts: ["airdrop"], forced: true, priority: 1 });
        break;
      case "corpse":
        ctx.strokeStyle = COLORS.lootCorpse;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(x - 3, y - 3);
        ctx.lineTo(x + 3, y + 3);
        ctx.moveTo(x + 3, y - 3);
        ctx.lineTo(x - 3, y + 3);
        ctx.stroke();
        break;
    }
  }

  // Labels go on top of all markers, most important first; items whose label doesn't fit anywhere
  // keep just their marker.
  requests.sort((a, b) => Number(b.forced) - Number(a.forced) || b.priority - a.priority);
  ctx.font = LOOT_FONT;
  ctx.textBaseline = "middle";
  ctx.lineJoin = "round";
  ctx.lineWidth = 3;
  ctx.strokeStyle = COLORS.labelHalo;
  ctx.fillStyle = COLORS.label;
  const placer = new LabelPlacer();
  for (const req of requests) {
    for (const text of req.texts) {
      const candidates = candidatesAround(req.x, req.y, textWidth(ctx, text), LABEL_HEIGHT, LABEL_GAP);
      let rect = placer.place(candidates);
      if (!rect && req.forced) {
        rect = candidates[0];
        placer.reserve(rect);
      }
      if (rect) {
        ctx.strokeText(text, rect.x, rect.y + rect.h / 2);
        ctx.fillText(text, rect.x, rect.y + rect.h / 2);
        break;
      }
    }
  }
  ctx.textBaseline = "alphabetic";
  ctx.lineJoin = "miter";
}

function drawExfil(ctx: CanvasRenderingContext2D, pr: Projector, e: Exfil): void {
  if (!e.pos) return;
  const [x, y] = pr.toScreen(e.pos);
  if (!onScreen(pr, x, y, 150)) return;
  const status = exfilStatus(e.status);
  const tones = { open: COLORS.exfilOpen, closed: COLORS.exfilClosed, pending: COLORS.exfilPending, neutral: COLORS.exfilNeutral };
  const color = e.kind === "secret" ? COLORS.exfilSecret : tones[status.tone];
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(x, y, 7, 0, Math.PI * 2);
  ctx.stroke();
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(x, y, 2.5, 0, Math.PI * 2);
  ctx.fill();
  ctx.font = "11px sans-serif";
  ctx.fillStyle = color;
  haloText(ctx, `${e.name}${e.kind === "secret" ? " (secret)" : ` · ${status.label}`}`, x + 10, y + 4);
}

function drawExplosives(ctx: CanvasRenderingContext2D, pr: Projector, ex: ExplosivesData): void {
  ctx.strokeStyle = COLORS.danger;
  ctx.fillStyle = COLORS.danger;
  for (const w of ex.tripwires) {
    const [x1, y1] = pr.toScreen(w.from);
    const [x2, y2] = pr.toScreen(w.to);
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(x2, y2, 3, 0, Math.PI * 2);
    ctx.fill();
  }
  // Grenades: a dot plus a ring sized to roughly a frag's danger radius (~8 m) on the map.
  for (const g of ex.grenades) {
    const ring = Math.max(6, 8 * pr.pxPerMetre(g.pos));
    const [x, y] = pr.toScreen(g.pos);
    if (!onScreen(pr, x, y, ring)) continue;
    ctx.beginPath();
    ctx.arc(x, y, 3, 0, Math.PI * 2);
    ctx.fill();
    ctx.lineWidth = 1.5;
    ctx.globalAlpha = 0.6;
    ctx.beginPath();
    ctx.arc(x, y, ring, 0, Math.PI * 2);
    ctx.stroke();
    ctx.globalAlpha = 1;
  }
}
