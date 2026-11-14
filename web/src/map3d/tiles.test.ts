import * as THREE from "three";
import { describe, expect, it } from "vitest";
import type { Bounds } from "./dataset";
import { type FlatView, snapShift, TILE_SIZE, TileCache } from "./tiles";

const EVERYWHERE: Bounds = { min: [-1e6, 0, -1e6], max: [1e6, 0, 1e6] };

/** North up, 4 pixels per metre, a 1920 x 1080 buffer: 480 m x 270 m of ground. */
function view(over: Partial<FlatView> = {}): FlatView {
  return { x: 0, y: 0, z: 0, right: [1, 0], up: [0, -1], pixel: 0.25, width: 1920, height: 1080, eye: 1000, near: 1, far: 3000, ...over };
}

function turned(degrees: number, over: Partial<FlatView> = {}): FlatView {
  const a = (degrees * Math.PI) / 180;
  return view({ right: [Math.cos(a), Math.sin(a)], up: [Math.sin(a), -Math.cos(a)], ...over });
}

interface Painted {
  x: number;
  z: number;
  /** Metres of ground along the tile's texture. */
  across: number;
  scale: number;
}

function cache(bounds = EVERYWHERE): { tiles: TileCache; painted: Painted[] } {
  const painted: Painted[] = [];
  const tiles = new TileCache(
    (camera, into, scale) => {
      expect(into.width).toBe(TILE_SIZE);
      painted.push({ x: camera.position.x, z: camera.position.z, across: camera.right - camera.left, scale });
    },
    new THREE.Color(0),
    bounds,
  );
  return { tiles, painted };
}

function paintAll(tiles: TileCache): void {
  while (tiles.pending) tiles.paint(8);
}

/** Whether some painted tile shows the ground at (x, z), leaving out the texels that belong to its neighbours. */
function covered(painted: Painted[], x: number, z: number): boolean {
  return painted.some((p) => {
    const half = (p.across / 2) * ((TILE_SIZE - 8) / TILE_SIZE);
    return Math.abs(x - p.x) <= half + 1e-6 && Math.abs(z - p.z) <= half + 1e-6;
  });
}

describe("TileCache", () => {
  it("needs the tiles under the view, the ones in view first", () => {
    const { tiles, painted } = cache();
    expect(tiles.look(view(), 0)).toBe(false); // nothing was kept: there was nothing
    expect(tiles.ready).toBe(false);
    const inView = tiles.missingInView;
    expect(inView).toBeGreaterThan(0);
    expect(tiles.pending).toBeGreaterThan(inView); // plus the ones just outside
    tiles.paint(inView);
    expect(tiles.ready).toBe(true);
    // The whole view is covered, by tiles painted at two texels per pixel.
    for (const [x, z] of [[-240, -135], [240, -135], [-240, 135], [240, 135], [0, 0]] as const) expect(covered(painted, x, z)).toBe(true);
    expect(painted.every((p) => p.scale === 2 && Math.abs(p.across - (TILE_SIZE * 0.25) / 2) < 1e-9)).toBe(true);
    paintAll(tiles);
    expect(tiles.pending).toBe(0);
  });

  it("keeps its tiles while the view moves and turns, and paints only what comes into view", () => {
    const { tiles, painted } = cache();
    tiles.look(view(), 0);
    paintAll(tiles);
    const before = painted.length;
    expect(tiles.look(view({ x: 3.1, z: -2.7 }), 0)).toBe(true);
    expect(tiles.ready).toBe(true);
    expect(tiles.pending).toBe(0);
    // Far enough for a new column of tiles.
    expect(tiles.look(view({ x: 150 }), 0)).toBe(true);
    expect(tiles.pending).toBeGreaterThan(0);
    paintAll(tiles);
    expect(painted.length).toBeGreaterThan(before);
    expect(painted.length).toBeLessThan(2 * before);
    // Turned: the corners of the view reach further.
    expect(tiles.look(turned(40, { x: 150 }), 0)).toBe(true);
    paintAll(tiles);
    const a = (40 * Math.PI) / 180;
    for (const [sx, sy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]] as const) {
      const x = 150 + sx * 240 * Math.cos(a) + sy * 135 * Math.sin(a);
      const z = sx * 240 * Math.sin(a) - sy * 135 * Math.cos(a);
      expect(covered(painted, x, z)).toBe(true);
    }
  });

  it("starts over at another zoom or when the map looks different", () => {
    const { tiles } = cache();
    tiles.look(view(), 0);
    paintAll(tiles);
    expect(tiles.look(view({ pixel: 0.26 }), 0)).toBe(false);
    expect(tiles.ready).toBe(false);
    paintAll(tiles);
    expect(tiles.look(view({ pixel: 0.26 }), 1)).toBe(false);
    expect(tiles.ready).toBe(false);
    paintAll(tiles);
    expect(tiles.look(view({ pixel: 0.26 }), 1)).toBe(true);
    expect(tiles.ready).toBe(true);
  });

  it("does not paint where there is no map", () => {
    const { tiles, painted } = cache({ min: [0, 0, 0], max: [50, 0, 50] });
    tiles.look(view(), 0);
    paintAll(tiles);
    expect(painted.length).toBeGreaterThan(0);
    for (const p of painted) {
      expect(p.x + p.across / 2).toBeGreaterThan(0);
      expect(p.x - p.across / 2).toBeLessThan(50);
    }
    // A view of nothing is ready as it is.
    tiles.look(view({ x: 5000 }), 0);
    expect(tiles.ready).toBe(true);
    expect(tiles.pending).toBe(0);
  });

  it("paints a large view at one texel per pixel", () => {
    const { tiles, painted } = cache();
    tiles.look(view({ width: 3840, height: 2160 }), 0);
    tiles.paint(1);
    expect(painted[0]!.scale).toBe(1);
  });

  it("does not hold on to tiles the view has left behind", () => {
    const { tiles, painted } = cache();
    for (let x = 0; x < 20000; x += 400) {
      tiles.look(view({ x }), 0);
      paintAll(tiles);
    }
    const held = (tiles as unknown as { group: THREE.Group }).group.children.length;
    tiles.look(view({ x: 20000 }), 0);
    expect(painted.length).toBeGreaterThan(200);
    expect(held).toBeLessThan(40);
  });
});

describe("snapShift", () => {
  /** Screen position (device pixels) of the world's origin after the shift. */
  function origin(v: FlatView, [dx, dz]: [number, number]): [number, number] {
    const x = dx - v.x, z = dz - v.z;
    return [v.width / 2 + (x * v.right[0] + z * v.right[1]) / v.pixel, v.height / 2 + (x * v.up[0] + z * v.up[1]) / v.pixel];
  }

  it("puts the tiles' grid on whole pixels, moving the picture by at most half of one", () => {
    for (const v of [
      view({ x: 150.37, z: 3.21, pixel: 0.2537 }),
      view({ x: -811.2, z: 407.9, pixel: 0.031, width: 1601, height: 1001 }),
      turned(90, { x: 150.37, z: 3.21, width: 1601, height: 1000 }),
      turned(180, { x: 12.345, z: -6.789, pixel: 0.9 }),
    ]) {
      const shift = snapShift(v);
      expect(Math.hypot(...shift)).toBeLessThanOrEqual(v.pixel * Math.SQRT1_2 + 1e-9);
      for (const s of origin(v, shift)) expect(Math.abs(s - Math.round(s))).toBeLessThan(1e-6);
    }
  });

  it("leaves a turned view alone", () => {
    expect(snapShift(turned(30, { x: 150.37, z: 3.21 }))).toEqual([0, 0]);
  });
});
