import { describe, expect, it } from "vitest";
import { type ControlPoint, directionToPixel, fitTransform, formatCalibration, pixelToWorld, pixelsPerMetre, worldToPixel } from "./calibration";

const close = (a: [number, number], b: [number, number]) => {
  expect(a[0]).toBeCloseTo(b[0], 6);
  expect(a[1]).toBeCloseTo(b[1], 6);
};

describe("fitTransform", () => {
  it("two points: north-up image (world z up = pixel v down)", () => {
    const t = fitTransform([
      { world: [0, 0], pixel: [500, 500] },
      { world: [200, 200], pixel: [900, 100] },
    ]);
    close(worldToPixel(t, 0, 0), [500, 500]);
    close(worldToPixel(t, 100, 0), [700, 500]); // east → right
    close(worldToPixel(t, 0, 100), [500, 300]); // north → up
    expect(pixelsPerMetre(t)).toBeCloseTo(2, 6);
  });

  it("two points: image rotated 90° (east up)", () => {
    // world +x maps to pixel up (−v), world +z maps to pixel left (−u).
    const t = fitTransform([
      { world: [0, 0], pixel: [100, 100] },
      { world: [10, 0], pixel: [100, 70] },
    ]);
    close(worldToPixel(t, 0, 10), [70, 100]);
    close(directionToPixel(t, 1, 0), [0, -3]);
  });

  it("three or more points: least squares recovers an exact affine map, and inverts", () => {
    const truth = (x: number, z: number): [number, number] => [1.5 * x + 0.2 * z + 30, 0.1 * x - 2 * z + 400];
    const pts: ControlPoint[] = [
      [0, 0],
      [100, 0],
      [0, 100],
      [50, 70],
    ].map(([x, z]) => ({ world: [x!, z!], pixel: truth(x!, z!) }));
    const t = fitTransform(pts);
    close(worldToPixel(t, 33, -12), truth(33, -12));
    close(pixelToWorld(t, ...truth(33, -12)), [33, -12]);
  });

  it("stays accurate with large world coordinates", () => {
    const truth = (x: number, z: number): [number, number] => [0.5 * x + 1200, -0.5 * z + 900];
    const pts: ControlPoint[] = [[2000, 3000], [2100, 3000], [2000, 3100], [2050, 3070]].map(([x, z]) => ({
      world: [x!, z!],
      pixel: truth(x!, z!),
    }));
    const t = fitTransform(pts);
    close(worldToPixel(t, 2033, 3044), truth(2033, 3044));
    // Nearly collinear points far from the origin are still rejected.
    expect(() =>
      fitTransform([
        { world: [5000, 5000], pixel: [0, 0] },
        { world: [5100, 5100], pixel: [1, 1] },
        { world: [5200, 5200], pixel: [2, 2] },
      ]),
    ).toThrow();
  });

  it("rejects degenerate input", () => {
    expect(() => fitTransform([{ world: [0, 0], pixel: [0, 0] }])).toThrow();
    expect(() =>
      fitTransform([
        { world: [1, 1], pixel: [0, 0] },
        { world: [1, 1], pixel: [5, 5] },
      ]),
    ).toThrow();
    expect(() =>
      fitTransform([
        { world: [0, 0], pixel: [0, 0] },
        { world: [1, 1], pixel: [1, 1] },
        { world: [2, 2], pixel: [2, 2] },
      ]),
    ).toThrow(); // collinear
  });
});

describe("formatCalibration", () => {
  it("hints when empty, asks for a second point, then gives the block", () => {
    expect(formatCalibration([])).toMatch(/^Click the map/);
    const one: ControlPoint = { world: [1, 2], pixel: [3, 4] };
    expect(formatCalibration([one])).toContain("add at least one more point");
    const two = formatCalibration([one, { world: [5, 6], pixel: [7, 8] }]);
    expect(two).not.toContain("add at least");
    expect(JSON.parse(`{${two}}`)).toEqual({ calibration: { points: [one, { world: [5, 6], pixel: [7, 8] }] } });
  });
});
