import { describe, expect, it } from "vitest";
import type { CameraData, CameraView } from "../model/protocol";
import { onScreen, project, scopeView, toPixels } from "./projection";

/** Column-major 4×4 from a row-major list of rows. */
const mat = (rows: number[][]): number[] => {
  const m = new Array<number>(16).fill(0);
  for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) m[c * 4 + r] = rows[r]![c]!;
  return m;
};
const mul = (a: number[], b: number[]): number[] => {
  const m = new Array<number>(16).fill(0);
  for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) for (let k = 0; k < 4; k++) m[c * 4 + r]! += a[k * 4 + r]! * b[c * 4 + k]!;
  return m;
};
/** Unity's worldToCameraMatrix for a camera at p looking along world +z (OpenGL convention: z flipped). */
const viewAt = ([x, y, z]: [number, number, number]) => mat([[1, 0, 0, -x], [0, 1, 0, -y], [0, 0, -1, z], [0, 0, 0, 1]]);
const perspective = (fovDeg: number, aspect: number, n = 0.05, f = 1000) => {
  const t = 1 / Math.tan((fovDeg * Math.PI) / 360);
  return mat([[t / aspect, 0, 0, 0], [0, t, 0, 0], [0, 0, (f + n) / (n - f), (2 * f * n) / (n - f)], [0, 0, -1, 0]]);
};
const view = (pos: [number, number, number], fov: number, aspect: number): CameraView => ({ vp: mul(perspective(fov, aspect), viewAt(pos)), pos, fov, aspect });
const camera = (extra: Partial<CameraData> = {}): CameraData => ({
  fps: view([0, 1.6, 0], 90, 2),
  aiming: false, scoped: false, magnification: 1, sights: [], active: null, optic: null,
  ...extra,
});

describe("POV projection", () => {
  const vp = view([0, 1.6, 0], 90, 2).vp;

  it("puts what's straight ahead in the centre, and drops what's behind", () => {
    const ahead = project(vp, [0, 1.6, 10])!;
    expect(ahead.x).toBeCloseTo(0);
    expect(ahead.y).toBeCloseTo(0);
    expect(ahead.depth).toBeCloseTo(10);
    expect(project(vp, [0, 1.6, -10])).toBeNull();
  });

  it("maps the edges of the field of view to the edges of the screen", () => {
    // 90° vertical: 45° up is the top edge; aspect 2: 63.4° right is the right edge (tan = 2).
    const top = project(vp, [0, 11.6, 10])!;
    expect(top.y).toBeCloseTo(1);
    const right = project(vp, [20, 1.6, 10])!;
    expect(right.x).toBeCloseTo(1);
    expect(onScreen(project(vp, [19, 1.6, 10])!)).toBe(true);
    expect(onScreen(project(vp, [30, 1.6, 10])!)).toBe(false);
    expect(toPixels({ x: 1, y: 1, depth: 1 }, 200, 100)).toEqual([200, 0]);
    expect(toPixels({ x: 0, y: 0, depth: 1 }, 200, 100)).toEqual([100, 50]);
  });

  it("insets the scope through the optic camera, or by zooming the first-person view", () => {
    expect(scopeView(camera())).toBeNull();
    // fps: fov 90 (tan 45° = 1), aspect 2. A point 1 m right at 10 m: fps NDC x = 0.1 / 2 = 0.05,
    // half a screen width = aspect / 2 heights → 0.05 heights off centre unzoomed.
    const zoomed = scopeView(camera({ scoped: true, magnification: 4 }))!;
    expect(zoomed.source).toBe("zoomed");
    expect(zoomed.project([1, 1.6, 10])!.dx).toBeCloseTo(0.05 * 4);
    // With the optic camera (a 10° view): its NDC × tan(fpsFov / 2) heights.
    const optic = scopeView(camera({ scoped: true, magnification: 4, optic: view([0, 1.6, 0.2], 10, 1) }))!;
    expect(optic.source).toBe("optic");
    const ndc = 0.4 / (10 * Math.tan((5 * Math.PI) / 180));
    expect(optic.project([0.4, 1.6, 10.2])!.dx).toBeCloseTo(ndc * 1, 3);
    expect(scopeView(camera({ scoped: true, magnification: 4, fps: null }))).toBeNull();
  });
});
