// Draws the radar: map layer (or a world grid when there's no map), players, calibration markers.

import { type Affine, pixelsPerMetre, worldToPixel } from "./calibration";
import { LabelPlacer, type Rect, candidatesAround } from "./labels";
import { type LoadedMap, selectLayer } from "./maps";
import { type ItemCatalog, containerName, exfilStatus, formatPrice, valueTier } from "./items";
import { type Exfil, type ExplosivesData, Joint, type LootEntry, type Player, type Vehicle, type WorldPos } from "./protocol";
import { type PlayerTypeInfo, bossGroups, playerType } from "./roles";
import { COLORS, ITEM_LOOK, LOOT_LOOK, type PlayerLook, exfilColor, playerLook } from "./style";
import { EXFIL_STATUS_DETAIL, LABEL_DETAIL, LABEL_RANK, type LootDensity, itemMarkerShown } from "./declutter";
import { type Timeline, isJump } from "./timeline";
import { type Projector, flatProjector } from "./projector";
import { midpoint } from "./pick";
import type { View } from "./view";

/** Used when there's no map for the location: 2 px per metre, north up, world origin at (0, 0). */
export const NO_MAP_TRANSFORM: Affine = { a: 2, b: 0, c: 0, d: 0, e: -2, f: 0 };

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
  vehicles: Vehicle[];
  loot: LootEntry[];
  layers: Layers;
  /** Items worth less than this (₽) get no label. */
  minLabelPrice: number;
  /** Which loose item markers drop out as you zoom out (declutter.ts). */
  lootDensity: LootDensity;
  selected: [number, number, number] | null;
  /** Hovered in the list view: drawn as a soft highlight. */
  hovered: [number, number, number] | null;
  /** Highlighted things (selection key → colour): ringed, labelled, and drawn even when their layer is off. */
  highlights: ReadonlyMap<string, string>;
  calibrationPixels: [number, number][];
  /** World positions picked with the coordinate tool (3D map debugging), drawn numbered. */
  debugPoints: [number, number, number][];
  trails: TrailScene | null;
  /** Up close, draw players with a known skeleton as figures instead of dots (3D map). */
  bodies: boolean;
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
 * Everything that moves: loot, exfils, explosives, vehicles, trails, players, selection. Drawn in screen
 * space through the projector, so it is the same code over the 2D image and over the 3D map.
 */
export function renderMarkers(ctx: CanvasRenderingContext2D, pr: Projector, scene: Scene): void {
  const hl = scene.highlights;
  // Markers draw as they go; their labels are collected and placed at the end, all together.
  const labels: LabelRequest[] = [];
  if (scene.layers.loot || scene.layers.containers || hl.size) drawLoot(ctx, pr, scene, labels);
  for (const e of scene.exfils) if (scene.layers.exfils || hl.has(`exfil:${e.id}`)) drawExfil(ctx, pr, e, labels);
  drawExplosives(ctx, pr, scene.layers.explosives ? scene.explosives : {
    grenades: scene.explosives.grenades.filter((g) => hl.has(`grenade:${g.id}`)),
    tripwires: scene.explosives.tripwires.filter((w) => hl.has(`tripwire:${w.id}`)),
  });

  for (const v of scene.vehicles) drawVehicle(ctx, pr, v, labels);

  if (scene.trails) drawTrails(ctx, pr, scene);

  const local = scene.players.find((p) => p.local && p.pos);
  const groups = bossGroups(scene.players);
  const typed = scene.players.map((p) => {
    const info = playerType(p, groups);
    return { p, info, order: playerLook(info.type, p).order };
  });
  // Drawn bottom to top (style.ts: minor, the dead, normal, special, us).
  typed.sort((a, b) => a.order - b.order);
  for (const { p, info } of typed) drawPlayer(ctx, pr, p, info, local?.pos?.[1] ?? null, scene.bodies, labels);

  if (hl.size) drawHighlights(ctx, pr, scene);
  drawLabels(ctx, labels);

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
    const points: { t: number; x: number; y: number; wx: number; wy: number; wz: number }[] = [];
    for (let k = lo; k < kept.length; k++) {
      const i = kept[k]!;
      const ti = track.timeOf(i);
      if (ti > at) break;
      const [wx, wy, wz] = track.posOf(i);
      const [x, y] = pr.toScreen([wx, wy, wz]);
      points.push({ t: ti, x, y, wx, wy, wz });
    }
    const pose = track.poseAt(at);
    if (pose && points.length) {
      const [x, y] = pr.toScreen(pose.pos);
      points.push({ t: at, x, y, wx: pose.pos[0], wy: pose.pos[1], wz: pose.pos[2] });
    }
    if (points.length < 2) continue;

    const isSelected = id === selected;
    const start = points[0]!.t;
    const span = Math.max(1, at - start);
    const paths = Array.from({ length: TRAIL_BUCKETS * 2 }, () => new Path2D());
    for (let k = 1; k < points.length; k++) {
      const a = points[k - 1]!, b = points[k]!;
      // Teleports and one-frame glitches: no line across them.
      if (isJump(Math.hypot(b.wx - a.wx, b.wy - a.wy, b.wz - a.wz), b.t - a.t)) continue;
      const bucket = Math.min(TRAIL_BUCKETS - 1, Math.floor(((b.t - start) / span) * TRAIL_BUCKETS));
      const path = paths[bucket + (otherFloor(b.wy) ? TRAIL_BUCKETS : 0)]!;
      path.moveTo(a.x, a.y);
      path.lineTo(b.x, b.y);
    }
    const look = playerLook(playerType(track.meta, groups).type);
    ctx.strokeStyle = look.color;
    ctx.lineWidth = isSelected ? 2.5 : 1.5;
    const maxAlpha = isSelected ? 0.95 : look.trailAlpha;
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

function drawPlayer(
  ctx: CanvasRenderingContext2D,
  pr: Projector,
  p: Player,
  info: PlayerTypeInfo,
  localY: number | null,
  bodies: boolean,
  labels: LabelRequest[],
): void {
  if (!p.pos) return;
  let [x, y] = pr.toScreen(p.pos);
  if (!onScreen(pr, x, y)) return;

  // Its look (style.ts): colour, size and emphasis by type, prominence and state.
  const look = playerLook(info.type, p);
  const { color } = look;
  ctx.globalAlpha = look.alpha;
  let r = look.radius;

  // Close enough, and the skeleton is known: the figure, with the facing line and label at its head.
  const head = bodies && !p.dead && p.joints && pr.pxPerMetre(p.pos) >= BODY_MIN_PX_PER_METRE ? drawBody(ctx, pr, p.pos, p.joints, color) : null;
  if (head) {
    [x, y] = head.at;
    r = head.radius;
    const yaw = (p.yaw * Math.PI) / 180;
    const [ax, ay] = pr.toScreen([head.pos[0] + Math.sin(yaw), head.pos[1], head.pos[2] + Math.cos(yaw)]);
    const du = Number.isFinite(ax) ? ax - x : 0, dv = Number.isFinite(ay) ? ay - y : 0;
    const len = Math.hypot(du, dv) || 1;
    const lineLen = r + look.facingFromHead;
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(x + (du / len) * r, y + (dv / len) * r);
    ctx.lineTo(x + (du / len) * lineLen, y + (dv / len) * lineLen);
    ctx.stroke();
    drawHalo(ctx, x, y, r, look);
  } else if (p.dead) {
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
    const lineLen = look.facing;
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
    drawHalo(ctx, x, y, r, look);
  }

  if (!p.local) {
    let label = look.namedLabel ? `${info.label} ${p.id}` : `${p.id}`;
    if (localY !== null) {
      const dy = p.pos[1] - localY;
      if (Math.abs(dy) >= 2) label += dy > 0 ? ` ▲${Math.round(dy)}` : ` ▼${Math.round(-dy)}`;
    }
    labels.push({
      x, y, texts: [label], font: look.labelFont, color: look.labelColor, alpha: look.alpha,
      gap: r + (look.halo ? 7 : 3), rank: LABEL_RANK.player, priority: look.order, forced: true, fixed: true,
    });
  }
  ctx.globalAlpha = 1;
}

/** A ring around special players' markers, so they stand out even among a crowd. */
function drawHalo(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, look: PlayerLook): void {
  if (!look.halo) return;
  ctx.strokeStyle = look.color;
  ctx.lineWidth = look.halo.width;
  ctx.beginPath();
  ctx.arc(x, y, r + look.halo.gap, 0, Math.PI * 2);
  ctx.stroke();
}

/** Players are drawn as figures from this many screen pixels per metre on (a 1.8 m figure: 14 px). */
const BODY_MIN_PX_PER_METRE = 8;

/** The figure's limbs: joints they connect and thickness (m). */
const BODY_SEGMENTS: readonly { from: number; to: number; width: number }[] = [
  { from: Joint.pelvis, to: Joint.chest, width: 0.3 },
  { from: Joint.chest, to: Joint.neck, width: 0.26 },
  { from: Joint.leftHip, to: Joint.rightHip, width: 0.2 },
  { from: Joint.leftShoulder, to: Joint.rightShoulder, width: 0.14 },
  { from: Joint.leftHip, to: Joint.leftKnee, width: 0.15 },
  { from: Joint.leftKnee, to: Joint.leftFoot, width: 0.11 },
  { from: Joint.rightHip, to: Joint.rightKnee, width: 0.15 },
  { from: Joint.rightKnee, to: Joint.rightFoot, width: 0.11 },
  { from: Joint.leftShoulder, to: Joint.leftElbow, width: 0.11 },
  { from: Joint.leftElbow, to: Joint.leftHand, width: 0.09 },
  { from: Joint.rightShoulder, to: Joint.rightElbow, width: 0.11 },
  { from: Joint.rightElbow, to: Joint.rightHand, width: 0.09 },
];
/** Head radius (m), and how far its centre sits beyond the head bone, along neck → head (m). */
const HEAD_RADIUS = 0.12;
const HEAD_LIFT = 0.09;
/** The far side of the figure is darkened by up to this much (0..1), so limbs read in depth. */
const BODY_FAR_SHADE = 0.35;

/**
 * A player as a figure: round-capped limbs between the joints, thicker the closer, drawn far to
 * near so limbs overlap the right way, with a dark outline around the whole. Returns the head (screen
 * position, radius in px, world position), where the facing line and label go; null if the
 * figure couldn't be projected (behind the camera).
 */
function drawBody(
  ctx: CanvasRenderingContext2D,
  pr: Projector,
  pos: WorldPos,
  joints: ArrayLike<number>,
  color: string,
): { at: [number, number]; radius: number; pos: WorldPos } | null {
  const world = (j: number): WorldPos => [pos[0] + joints[j * 3]!, pos[1] + joints[j * 3 + 1]!, pos[2] + joints[j * 3 + 2]!];
  const neck = world(Joint.neck), headBone = world(Joint.head);
  const up = [headBone[0] - neck[0], headBone[1] - neck[1], headBone[2] - neck[2]];
  const upLen = Math.hypot(up[0]!, up[1]!, up[2]!) || 1;
  const head: WorldPos = [
    headBone[0] + (up[0]! / upLen) * HEAD_LIFT,
    headBone[1] + (up[1]! / upLen) * HEAD_LIFT,
    headBone[2] + (up[2]! / upLen) * HEAD_LIFT,
  ];

  type Part = { depth: number; draw: (outline: boolean) => void };
  const parts: Part[] = [];
  for (const seg of BODY_SEGMENTS) {
    const a = world(seg.from), b = world(seg.to);
    const [ax, ay] = pr.toScreen(a), [bx, by] = pr.toScreen(b);
    if (!Number.isFinite(ax + ay + bx + by)) return null;
    const mid: WorldPos = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
    const width = Math.max(1.5, seg.width * pr.pxPerMetre(mid));
    parts.push({
      depth: pr.depth?.(mid) ?? 0,
      draw: (outline) => {
        ctx.lineWidth = outline ? width + 2 : width;
        ctx.beginPath();
        ctx.moveTo(ax, ay);
        ctx.lineTo(bx, by);
        ctx.stroke();
      },
    });
  }
  const [hx, hy] = pr.toScreen(head);
  if (!Number.isFinite(hx + hy)) return null;
  const radius = Math.max(2.5, HEAD_RADIUS * pr.pxPerMetre(head));
  parts.push({
    depth: pr.depth?.(head) ?? 0,
    draw: (outline) => {
      ctx.beginPath();
      ctx.arc(hx, hy, outline ? radius + 1 : radius, 0, Math.PI * 2);
      ctx.fill();
    },
  });

  parts.sort((a, b) => b.depth - a.depth);
  const near = parts.at(-1)!.depth, far = parts[0]!.depth;
  const alpha = ctx.globalAlpha;
  ctx.globalAlpha = Math.max(alpha, 0.9); // overlapping translucent limbs would show their seams
  ctx.lineCap = "round";
  // One outline around the whole figure (all outlines first: none cuts across a joint), then the
  // limbs far to near, the far ones darker.
  ctx.strokeStyle = ctx.fillStyle = "rgba(0, 0, 0, 0.85)";
  for (const part of parts) part.draw(true);
  for (const part of parts) {
    const shade = far > near ? ((part.depth - near) / (far - near)) * BODY_FAR_SHADE : 0;
    ctx.strokeStyle = ctx.fillStyle = darken(color, shade);
    part.draw(false);
  }
  ctx.lineCap = "butt";
  ctx.globalAlpha = alpha;
  return { at: [hx, hy], radius, pos: head };
}

/** "#rrggbb" mixed towards black by `amount` (0..1); other colour formats are returned as they are. */
export function darken(color: string, amount: number): string {
  if (amount <= 0 || !/^#[0-9a-f]{6}$/i.test(color)) return color;
  const k = 1 - Math.min(1, amount);
  const c = (i: number) => Math.round(Number.parseInt(color.slice(i, i + 2), 16) * k);
  return `rgb(${c(1)}, ${c(3)}, ${c(5)})`;
}

/** False for positions off the canvas, and for NaN (not projectable, see Projector). */
function onScreen(pr: Projector, x: number, y: number, margin = 50): boolean {
  return x >= -margin && y >= -margin && x <= pr.width + margin && y <= pr.height + margin;
}

/** A label waiting for placement: `texts` from most to least detailed, tried in that order. */
interface LabelRequest {
  /** The marker it belongs to. */
  x: number;
  y: number;
  texts: string[];
  font: string;
  color: string;
  alpha?: number;
  /** Distance from the marker's centre. */
  gap: number;
  /** Placement order (declutter.ts LABEL_RANK), then higher `priority` first. */
  rank: number;
  priority: number;
  /** Always drawn: when no spot is free, its shortest text goes to its first spot anyway. */
  forced: boolean;
  /** Only the spot right of the marker (players, exfils: a label that doesn't jump about). */
  fixed?: boolean;
}

const LOOT_FONT = "10px sans-serif";
const LABEL_GAP = 6;
const textWidths = new Map<string, number>();

function textWidth(ctx: CanvasRenderingContext2D, font: string, text: string): number {
  const key = `${font}|${text}`;
  let w = textWidths.get(key);
  if (w === undefined) {
    ctx.font = font;
    w = ctx.measureText(text).width;
    textWidths.set(key, w);
  }
  return w;
}

/** Box height for a font: its size in px, plus a little. */
const labelHeight = (font: string) => Number(/(\d+)px/.exec(font)?.[1] ?? 10) + 2;

function drawLoot(ctx: CanvasRenderingContext2D, pr: Projector, scene: Scene, labels: LabelRequest[]): void {
  const { loot, layers, catalog, minLabelPrice, highlights, lootDensity } = scene;
  const containerLabels = pr.detail >= LABEL_DETAIL.containers;
  const itemLabels = pr.detail >= LABEL_DETAIL.items;
  const label = (x: number, y: number, texts: string[], rank: number, priority: number, forced: boolean, color: string = COLORS.label) =>
    labels.push({ x, y, texts, font: LOOT_FONT, color, gap: LABEL_GAP, rank, priority, forced });
  for (const l of loot) {
    const isContainer = l.kind === "container" || l.kind === "airdrop" || l.kind === "corpse";
    const highlight = highlights.get(`loot:${l.id}`);
    if (!highlight && (isContainer ? !layers.containers : !layers.loot)) continue;
    const [x, y] = pr.toScreen(l.pos);
    if (!onScreen(pr, x, y, 10)) continue;
    // Highlighted: labelled at any zoom, before the rest of the loot (but only where there's room).
    if (highlight) label(x, y, highlightTexts(l, catalog), LABEL_RANK.highlighted, 0, false, highlight);
    switch (l.kind) {
      case "item": {
        const info = catalog.lookup(l.tpl);
        const price = info?.price;
        const tier = valueTier(price);
        // Zoomed out, cheap items drop out (the loot density setting).
        if (!highlight && !itemMarkerShown(tier, pr.detail, lootDensity)) break;
        const marker = ITEM_LOOK[tier];
        ctx.fillStyle = marker.color;
        ctx.fillRect(x - marker.size / 2, y - marker.size / 2, marker.size, marker.size);
        if (info && itemLabels && !highlight && (price ?? 0) >= minLabelPrice) {
          const texts = info.price ? [`${info.shortName} ${formatPrice(info.price)}`, formatPrice(info.price)] : [info.shortName];
          label(x, y, texts, LABEL_RANK.item, info.price ?? 0, false);
        }
        break;
      }
      case "quest": {
        const { color, size } = LOOT_LOOK.quest;
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.moveTo(x, y - size);
        ctx.lineTo(x + size, y);
        ctx.lineTo(x, y + size);
        ctx.lineTo(x - size, y);
        ctx.fill();
        if (!highlight) label(x, y, ["quest item"], LABEL_RANK.questOrAirdrop, 2, false);
        break;
      }
      case "container": {
        const { color, size } = LOOT_LOOK.container;
        ctx.strokeStyle = color;
        ctx.lineWidth = 1.5;
        ctx.strokeRect(x - size, y - size, size * 2, size * 2);
        const name = containerName(l.tpl);
        if (name && containerLabels && !highlight) label(x, y, [name], LABEL_RANK.container, 0, false);
        break;
      }
      case "airdrop": {
        const { color, size } = LOOT_LOOK.airdrop;
        ctx.fillStyle = color;
        ctx.fillRect(x - size, y - size, size * 2, size * 2);
        if (!highlight) label(x, y, ["airdrop"], LABEL_RANK.questOrAirdrop, 1, true);
        break;
      }
      case "corpse": {
        const { color, size } = LOOT_LOOK.corpse;
        ctx.strokeStyle = color;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(x - size, y - size);
        ctx.lineTo(x + size, y + size);
        ctx.moveTo(x + size, y - size);
        ctx.lineTo(x - size, y + size);
        ctx.stroke();
        break;
      }
    }
  }
}

/**
 * Places and draws all labels, on top of all markers: by rank and priority (declutter.ts), each in
 * the first free spot around its marker, dropped when there's none (unless forced).
 */
function drawLabels(ctx: CanvasRenderingContext2D, labels: LabelRequest[]): void {
  labels.sort((a, b) => a.rank - b.rank || b.priority - a.priority);
  ctx.textBaseline = "middle";
  ctx.lineJoin = "round";
  ctx.lineWidth = 3;
  ctx.strokeStyle = COLORS.labelHalo;
  const placer = new LabelPlacer();
  const draw = (req: LabelRequest, text: string, rect: Rect) => {
    ctx.font = req.font;
    ctx.globalAlpha = req.alpha ?? 1;
    ctx.fillStyle = req.color;
    ctx.strokeText(text, rect.x, rect.y + rect.h / 2);
    ctx.fillText(text, rect.x, rect.y + rect.h / 2);
  };
  const spots = (req: LabelRequest, text: string) => {
    const all = candidatesAround(req.x, req.y, textWidth(ctx, req.font, text), labelHeight(req.font), req.gap);
    return req.fixed ? [all[0]] : all;
  };
  for (const req of labels) {
    let placed = false;
    for (const text of req.texts) {
      const rect = placer.place(spots(req, text));
      if (rect) {
        draw(req, text, rect);
        placed = true;
        break;
      }
    }
    if (!placed && req.forced) {
      const text = req.texts.at(-1)!;
      const rect = spots(req, text)[0]!;
      placer.reserve(rect);
      draw(req, text, rect);
    }
  }
  ctx.globalAlpha = 1;
  ctx.textBaseline = "alphabetic";
  ctx.lineJoin = "miter";
}

/** A highlighted loot entry's label, most to least detailed. */
function highlightTexts(l: LootEntry, catalog: ItemCatalog): string[] {
  switch (l.kind) {
    case "item": {
      const info = catalog.lookup(l.tpl);
      if (!info) return ["item"];
      return info.price ? [`${info.shortName} ${formatPrice(info.price)}`, info.shortName] : [info.shortName];
    }
    case "quest": return [catalog.lookup(l.tpl)?.shortName ?? "quest item", "quest item"];
    case "container": return [containerName(l.tpl) ?? "container"];
    default: return [l.kind];
  }
}

/** Rings in their highlight's colour around highlighted things (players, loot, exfils, explosives). */
function drawHighlights(ctx: CanvasRenderingContext2D, pr: Projector, scene: Scene): void {
  const hl = scene.highlights;
  const ring = (pos: WorldPos | null | undefined, color: string | undefined, radius: number) => {
    if (!pos || !color) return;
    const [x, y] = pr.toScreen(pos);
    if (!onScreen(pr, x, y, radius + 4)) return;
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.globalAlpha = 0.16;
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.lineWidth = 2;
    ctx.stroke();
  };
  for (const l of scene.loot) ring(l.pos, hl.get(`loot:${l.id}`), 9);
  for (const e of scene.exfils) ring(e.pos, hl.get(`exfil:${e.id}`), 12);
  for (const g of scene.explosives.grenades) ring(g.pos, hl.get(`grenade:${g.id}`), 10);
  for (const w of scene.explosives.tripwires) ring(midpoint(w.from, w.to), hl.get(`tripwire:${w.id}`), 10);
  for (const p of scene.players) ring(p.pos, hl.get(`player:${p.id}`), 12);
}

function drawExfil(ctx: CanvasRenderingContext2D, pr: Projector, e: Exfil, labels: LabelRequest[]): void {
  if (!e.pos) return;
  const [x, y] = pr.toScreen(e.pos);
  if (!onScreen(pr, x, y, 150)) return;
  const status = exfilStatus(e.status);
  const color = exfilColor(e.kind, status.tone);
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(x, y, 7, 0, Math.PI * 2);
  ctx.stroke();
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(x, y, 2.5, 0, Math.PI * 2);
  ctx.fill();
  // Zoomed out: just the name (the colour still tells the status).
  const full = `${e.name}${e.kind === "secret" ? " (secret)" : ` · ${status.label}`}`;
  const texts = pr.detail >= EXFIL_STATUS_DETAIL ? [full, e.name] : [e.name];
  labels.push({ x, y, texts, font: "11px sans-serif", color, gap: 10, rank: LABEL_RANK.exfil, priority: 0, forced: true, fixed: true });
}

/** BTR hull footprint (m): half width, half length. */
const BTR_HALF_SIZE = [1.45, 3.8] as const;
/** Zoomed out, the hull is drawn at least this long (px). */
const VEHICLE_MIN_LENGTH_PX = 22;

/** The hull's footprint, turned to its heading, with a notch at the front; labelled with who's aboard. */
function drawVehicle(ctx: CanvasRenderingContext2D, pr: Projector, v: Vehicle, labels: LabelRequest[]): void {
  const [cx, cy] = pr.toScreen(v.pos);
  if (!onScreen(pr, cx, cy, 100)) return;
  const yaw = (v.yaw * Math.PI) / 180;
  const [hw, hl] = BTR_HALF_SIZE;
  // Corners in the world (x right, z forward, turned by yaw), then on screen.
  const world = (right: number, forward: number): [number, number] =>
    pr.toScreen([
      v.pos[0] + right * Math.cos(yaw) + forward * Math.sin(yaw),
      v.pos[1],
      v.pos[2] - right * Math.sin(yaw) + forward * Math.cos(yaw),
    ]);
  let points = [world(-hw, hl * 0.7), world(0, hl), world(hw, hl * 0.7), world(hw, -hl), world(-hw, -hl)];
  const [fx, fy] = world(0, hl);
  const [bx, by] = world(0, -hl);
  const length = Math.hypot(fx - bx, fy - by);
  if (length < VEHICLE_MIN_LENGTH_PX) {
    const k = VEHICLE_MIN_LENGTH_PX / Math.max(length, 1e-3);
    points = points.map(([x, y]) => [cx + (x - cx) * k, cy + (y - cy) * k]);
  }
  ctx.beginPath();
  points.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
  ctx.closePath();
  ctx.fillStyle = COLORS.vehicle;
  ctx.globalAlpha = 0.25;
  ctx.fill();
  ctx.globalAlpha = 1;
  ctx.strokeStyle = COLORS.vehicle;
  ctx.lineWidth = 2;
  ctx.stroke();

  const aboard = v.occupants.filter((o) => o.seat === "passenger").length;
  const name = v.state === 2 ? "BTR" : "BTR (stopped)";
  const texts = aboard ? [`${name} · ${aboard} aboard`, `BTR · ${aboard}`] : [name, "BTR"];
  labels.push({ x: cx, y: cy, texts, font: "bold 11px sans-serif", color: COLORS.vehicle, gap: 14, rank: LABEL_RANK.exfil, priority: 1, forced: true, fixed: true });
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
