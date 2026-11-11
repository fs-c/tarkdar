import { describe, expect, it } from "vitest";
import { LabelPlacer, candidatesAround } from "./labels";

describe("LabelPlacer", () => {
  it("places the first free candidate and rejects overlapping ones", () => {
    const placer = new LabelPlacer();
    const a = candidatesAround(100, 100, 40, 12, 6);
    expect(placer.place(a)).toEqual(a[0]);
    // A second marker right next to the first: its right-hand spot overlaps, so it falls back.
    const b = candidatesAround(104, 100, 40, 12, 6);
    expect(placer.place(b)).toEqual(b[1]);
  });

  it("returns null when every candidate collides", () => {
    const placer = new LabelPlacer();
    placer.reserve({ x: 0, y: 0, w: 300, h: 300 });
    expect(placer.place(candidatesAround(150, 150, 40, 12, 6))).toBeNull();
  });

  it("detects overlaps across grid cells, including negative coordinates", () => {
    const placer = new LabelPlacer();
    placer.reserve({ x: -50, y: -10, w: 100, h: 20 });
    expect(placer.free({ x: 40, y: 5, w: 10, h: 10 })).toBe(false);
    expect(placer.free({ x: -45, y: -5, w: 5, h: 5 })).toBe(false);
    expect(placer.free({ x: 50, y: 10, w: 10, h: 10 })).toBe(true);
  });
});
