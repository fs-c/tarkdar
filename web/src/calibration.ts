// World ↔ map-image transform from calibration control points.
//
// A control point pairs a world position (x, z in metres; y is ignored) with the pixel where that
// position appears in the map image. The transform is affine:
//   u = a·x + b·z + c
//   v = d·x + e·z + f
// - 2 points: a similarity transform (scale, rotation, translation) with the vertical axis flipped,
//   because images have y pointing down while world z points north. Works for any image rotation.
// - 3+ points: a least-squares affine fit, which also absorbs non-uniform scale or mirroring.

export interface ControlPoint {
  world: [number, number]; // [x, z]
  pixel: [number, number]; // [u, v]
}

export interface Affine {
  a: number; b: number; c: number;
  d: number; e: number; f: number;
}

export function fitTransform(points: ControlPoint[]): Affine {
  if (points.length < 2) throw new Error("calibration needs at least 2 control points");
  return points.length === 2 ? fitSimilarity(points[0]!, points[1]!) : fitAffine(points);
}

/**
 * Similarity with a y-flip, using complex numbers: with w = x − i·z (world, flipped) and
 * p = u + i·v (pixel), find s, t such that p = s·w + t.
 */
function fitSimilarity(p0: ControlPoint, p1: ControlPoint): Affine {
  const w0 = { re: p0.world[0], im: -p0.world[1] };
  const w1 = { re: p1.world[0], im: -p1.world[1] };
  const dw = { re: w1.re - w0.re, im: w1.im - w0.im };
  const dp = { re: p1.pixel[0] - p0.pixel[0], im: p1.pixel[1] - p0.pixel[1] };
  const denom = dw.re * dw.re + dw.im * dw.im;
  if (denom === 0) throw new Error("calibration points must be at different world positions");
  // s = dp / dw
  const s = { re: (dp.re * dw.re + dp.im * dw.im) / denom, im: (dp.im * dw.re - dp.re * dw.im) / denom };
  // t = p0 − s·w0
  const t = {
    re: p0.pixel[0] - (s.re * w0.re - s.im * w0.im),
    im: p0.pixel[1] - (s.re * w0.im + s.im * w0.re),
  };
  // p = s·(x − i·z) + t  →  u = s.re·x + s.im·z + t.re ;  v = s.im·x − s.re·z + t.im
  return { a: s.re, b: s.im, c: t.re, d: s.im, e: -s.re, f: t.im };
}

/**
 * Least squares for u and v independently: minimise Σ (a·x' + b·z' + c' − u)², with world
 * coordinates centred on their mean (x' = x − x̄) for numerical stability, then shifted back.
 */
function fitAffine(points: ControlPoint[]): Affine {
  const n = points.length;
  const mx = points.reduce((s, p) => s + p.world[0], 0) / n;
  const mz = points.reduce((s, p) => s + p.world[1], 0) / n;
  // Normal equations: (AᵀA) [a b c]ᵀ = Aᵀu, with rows [x' z' 1].
  let sxx = 0, sxz = 0, sx = 0, szz = 0, sz = 0;
  let sxu = 0, szu = 0, su = 0, sxv = 0, szv = 0, sv = 0;
  for (const { world: [wx, wz], pixel: [u, v] } of points) {
    const x = wx - mx, z = wz - mz;
    sxx += x * x; sxz += x * z; sx += x; szz += z * z; sz += z;
    sxu += x * u; szu += z * u; su += u;
    sxv += x * v; szv += z * v; sv += v;
  }
  const m: [number, number, number][] = [
    [sxx, sxz, sx],
    [sxz, szz, sz],
    [sx, sz, n],
  ];
  const [a, b, c0] = solve3(m, [sxu, szu, su]);
  const [d, e, f0] = solve3(m, [sxv, szv, sv]);
  // u = a·(x − mx) + b·(z − mz) + c0  →  c = c0 − a·mx − b·mz
  return { a, b, c: c0 - a * mx - b * mz, d, e, f: f0 - d * mx - e * mz };
}

function solve3(m: [number, number, number][], r: [number, number, number]): [number, number, number] {
  const det = (q: [number, number, number][]) =>
    q[0]![0] * (q[1]![1] * q[2]![2] - q[1]![2] * q[2]![1]) -
    q[0]![1] * (q[1]![0] * q[2]![2] - q[1]![2] * q[2]![0]) +
    q[0]![2] * (q[1]![0] * q[2]![1] - q[1]![1] * q[2]![0]);
  const d = det(m);
  // Relative test: the determinant scales with the cube of the coordinate spread.
  const scale = Math.max(...m.flat().map(Math.abs), 1);
  if (!Number.isFinite(d) || Math.abs(d) <= 1e-10 * scale ** 3) throw new Error("calibration points are collinear");
  const col = (i: number) => det(m.map((row, k) => row.map((v, j) => (j === i ? r[k]! : v))) as [number, number, number][]);
  return [col(0) / d, col(1) / d, col(2) / d];
}

export function worldToPixel(t: Affine, x: number, z: number): [number, number] {
  return [t.a * x + t.b * z + t.c, t.d * x + t.e * z + t.f];
}

export function pixelToWorld(t: Affine, u: number, v: number): [number, number] {
  const det = t.a * t.e - t.b * t.d;
  if (det === 0) return [NaN, NaN];
  const du = u - t.c, dv = v - t.f;
  return [(t.e * du - t.b * dv) / det, (t.a * dv - t.d * du) / det];
}

/** Pixel-space direction (not normalised) of a world-space direction (x, z). */
export function directionToPixel(t: Affine, dx: number, dz: number): [number, number] {
  return [t.a * dx + t.b * dz, t.d * dx + t.e * dz];
}

/** Pixels per metre (geometric mean of the axis scales). */
export function pixelsPerMetre(t: Affine): number {
  return Math.sqrt(Math.abs(t.a * t.e - t.b * t.d));
}

/** The `calibration` block for a map.json, or a hint when there are no points yet. */
export function formatCalibration(points: ControlPoint[]): string {
  if (points.length === 0) return "Click the map where your character stands.";
  const lines = points.map((p) => `      { "world": [${p.world.join(", ")}], "pixel": [${p.pixel.join(", ")}] }`);
  return (
    `"calibration": {\n  "points": [\n${lines.join(",\n")}\n  ]\n}` +
    (points.length < 2 ? "\n\n(add at least one more point, far from the first)" : "")
  );
}
