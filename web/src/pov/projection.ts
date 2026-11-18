// Projecting world points into the local player's view (the POV page), from the backend's `camera`
// message. Pure functions, so they can be tested without a canvas.

import type { CameraData, CameraView, WorldPos } from "../protocol";

/** A projected point: normalised device coordinates (−1…1, y up; outside: off screen) and the
 *  distance along the view direction (clip w, metres for a perspective camera). */
export interface Projected {
  x: number;
  y: number;
  depth: number;
}

/** Points closer than this (m) in front of the camera aren't drawn (and behind it can't be). */
export const NEAR = 0.05;

/** World point → NDC through a column-major view-projection matrix; null if behind the camera. */
export function project(vp: ArrayLike<number>, p: WorldPos): Projected | null {
  const [x, y, z] = p;
  const cx = vp[0]! * x + vp[4]! * y + vp[8]! * z + vp[12]!;
  const cy = vp[1]! * x + vp[5]! * y + vp[9]! * z + vp[13]!;
  const w = vp[3]! * x + vp[7]! * y + vp[11]! * z + vp[15]!;
  if (!(w > NEAR) || !Number.isFinite(cx) || !Number.isFinite(cy)) return null;
  return { x: cx / w, y: cy / w, depth: w };
}

/** NDC → pixels in a w × h area. */
export const toPixels = (p: Projected, w: number, h: number): [number, number] => [(p.x + 1) * 0.5 * w, (1 - p.y) * 0.5 * h];

/** Inside the view (with a margin in NDC units). */
export const onScreen = (p: Projected, margin = 0): boolean => Math.abs(p.x) <= 1 + margin && Math.abs(p.y) <= 1 + margin;

/**
 * How the scope inset is drawn while scoped: through the optic camera's own matrix if the backend has
 * it ("optic"), otherwise the first-person view magnified by the sight's zoom ("zoomed").
 */
export type ScopeSource = "optic" | "zoomed";

/** A point in the inset: offset from the view's centre in units of the view's height (y up). */
export interface Offset {
  dx: number;
  dy: number;
  depth: number;
}

export interface ScopeView {
  source: ScopeSource;
  project: (p: WorldPos) => Offset | null;
}

/** Vertical field of view assumed when the backend doesn't know the camera's (degrees). */
const DEFAULT_FOV = 75;

/** The inset to draw while scoped; null when not scoped (or nothing to draw it with). */
export function scopeView(camera: CameraData | null): ScopeView | null {
  if (!camera?.scoped || !camera.fps) return null;
  const halfFov = Math.tan((((camera.fps.fov ?? DEFAULT_FOV) / 2) * Math.PI) / 180);
  if (camera.optic) {
    // The reference's mapping of the optic camera onto the screen (unverified here): its NDC scaled by
    // 2·tan(fpsFov / 2) in screen-height units, i.e. offset = ndc · tan(fpsFov / 2) · height, both axes.
    const vp = camera.optic.vp;
    return {
      source: "optic",
      project: (p) => {
        const q = project(vp, p);
        return q && { dx: q.x * halfFov, dy: q.y * halfFov, depth: q.depth };
      },
    };
  }
  if (!(camera.magnification > 1)) return null;
  // The first-person view's own screen offset (NDC · half the screen), magnified.
  const vp = camera.fps.vp;
  const zoom = camera.magnification;
  const aspect = camera.fps.aspect ?? 16 / 9;
  return {
    source: "zoomed",
    project: (p) => {
      const q = project(vp, p);
      return q && { dx: ((q.x * aspect) / 2) * zoom, dy: (q.y / 2) * zoom, depth: q.depth };
    },
  };
}

/** The camera's view to draw with: the first-person one (the scope only replaces the inset). */
export const mainView = (camera: CameraData | null): CameraView | null => camera?.fps ?? null;
